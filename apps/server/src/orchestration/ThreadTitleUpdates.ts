import {
  OrchestrationGetSnapshotError,
  type OrchestrationGetTitleUpdatesResult,
  type ThreadId,
} from "@t3tools/contracts";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import { resolveAutomaticThreadTitleRenameLimit } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ThreadTitleUpdatesQuery } from "../persistence/Services/ThreadTitleUpdatesQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AutomaticThreadTitleRateLimit } from "./AutomaticThreadTitleRateLimit.ts";
import { allowsAutomaticThreadTitleUpdate } from "./ThreadTitlePolicy.ts";
import { DEFAULT_THREAD_TITLE } from "./threadTitles.ts";

export const getThreadTitleUpdates = Effect.fn("getThreadTitleUpdates")(function* (
  threadId: ThreadId,
) {
  const titleUpdatesQuery = yield* ThreadTitleUpdatesQuery;
  const thread = yield* titleUpdatesQuery.get(threadId);
  if (Option.isNone(thread)) {
    return yield* new OrchestrationGetSnapshotError({
      message: `Thread ${threadId} was not found.`,
    });
  }

  const settings = yield* (yield* ServerSettingsService).getSettings;
  const inspection = yield* (yield* AutomaticThreadTitleRateLimit).inspect(
    threadId,
    resolveAutomaticThreadTitleRenameLimit(settings),
  );
  if (Option.isNone(inspection)) {
    return yield* new OrchestrationGetSnapshotError({
      message: `Thread ${threadId} was not found.`,
    });
  }

  const value = thread.value;
  const quota = inspection.value;
  const awaitingInitialTitle = value.titleSource === null && value.title === DEFAULT_THREAD_TITLE;
  const latestHistory = value.history[0];
  const undoTitle =
    value.titleSource === "generated" &&
    value.titleRegenerationRequestId === null &&
    latestHistory?.source === "automatic" &&
    latestHistory.version === value.titleVersion
      ? latestHistory.previousTitle
      : null;
  const lifecycleAllowsUpdates = allowsAutomaticThreadTitleUpdate(
    {
      archivedAt: value.archivedAt,
      deletedAt: value.deletedAt,
      settledOverride: value.settledOverride,
      snoozedUntil: value.snoozedUntil,
    },
    quota.checkedAt,
  );
  const status: OrchestrationGetTitleUpdatesResult["status"] = !settings.automaticThreadTitles
    ? "disabled"
    : value.deletedAt !== null
      ? "deleted"
      : value.archivedAt !== null
        ? "archived"
        : value.snoozedUntil !== null &&
            compareDateTimeStrings(value.snoozedUntil, quota.checkedAt) > 0
          ? "snoozed"
          : value.settledOverride === "settled"
            ? "settled"
            : value.titleRegenerationRequestId !== null
              ? "regenerating"
              : awaitingInitialTitle
                ? "waiting"
                : !lifecycleAllowsUpdates ||
                    value.titleSource !== "generated" ||
                    value.title === DEFAULT_THREAD_TITLE
                  ? "protected"
                  : quota.available
                    ? "eligible"
                    : "waiting";

  return {
    threadId,
    checkedAt: quota.checkedAt,
    currentTitle: value.title,
    currentVersion: value.titleVersion,
    undoTitle,
    profile: settings.automaticThreadTitleRenamePolicy,
    status,
    awaitingInitialTitle: status === "waiting" && awaitingInitialTitle,
    phase: quota.phase,
    eligibleAt: quota.eligibleAt,
    completedTurns: quota.completedTurns,
    requiredTurns: quota.requiredTurns,
    rollingCount: quota.rollingCount,
    rollingMaximum: quota.rollingMaximum,
    rollingWindowHours: quota.rollingWindowHours,
    history: value.history,
    hasMore: value.hasMore,
  } satisfies OrchestrationGetTitleUpdatesResult;
});
