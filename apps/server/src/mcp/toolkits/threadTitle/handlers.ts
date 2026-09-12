import { CommandId } from "@t3tools/contracts";
import { resolveAutomaticThreadTitleRenameLimit } from "@t3tools/shared/serverSettings";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { AutomaticThreadTitleRateLimit } from "../../../orchestration/AutomaticThreadTitleRateLimit.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { allowsAutomaticThreadTitleUpdate } from "../../../orchestration/ThreadTitlePolicy.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import {
  type RenameCurrentThreadInput,
  type RenameCurrentThreadResult,
  ThreadTitleToolkit,
} from "./tools.ts";

export const renameCurrentThread = Effect.fn("ThreadTitleToolkit.renameCurrentThread")(function* (
  input: typeof RenameCurrentThreadInput.Type,
): Effect.fn.Return<
  typeof RenameCurrentThreadResult.Type,
  string,
  | McpInvocationContext
  | ServerSettingsService
  | ProjectionSnapshotQuery
  | AutomaticThreadTitleRateLimit
  | OrchestrationEngineService
  | Crypto.Crypto
> {
  const scope = yield* McpInvocationContext;
  if (!scope.capabilities.has("thread-title")) return { status: "unavailable" };

  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(
    Effect.mapError(() => "Could not read the automatic thread title setting."),
  );
  if (!settings.automaticThreadTitles) return { status: "disabled" };

  const queries = yield* ProjectionSnapshotQuery;
  const result = yield* queries
    .getThreadShellById(scope.threadId)
    .pipe(Effect.mapError(() => "Could not read the current thread."));
  if (
    Option.isNone(result) ||
    !allowsAutomaticThreadTitleUpdate(result.value, DateTime.formatIso(yield* DateTime.now))
  ) {
    return { status: "unavailable" };
  }
  const thread = result.value;
  if (thread.titleSource !== "automatic") return { status: "protected", title: thread.title };
  if (thread.title === input.title) return { status: "unchanged", title: thread.title };

  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const rateLimit = yield* AutomaticThreadTitleRateLimit;
  const update = Effect.gen(function* () {
    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    return yield* engine
      .dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(`agent-thread-title:${uuid}`),
        threadId: scope.threadId,
        title: input.title,
        titleSource: "automatic",
      })
      .pipe(
        Effect.as({ status: "updated", title: input.title } as const),
        // The decider checks ownership again inside the serialized command queue.
        // A user rename that overtakes our read must win.
        Effect.catchTag("OrchestrationCommandInvariantError", () =>
          Effect.succeed({ status: "unavailable" } as const),
        ),
      );
  });
  const outcome = yield* rateLimit
    .withPermit(scope.threadId, resolveAutomaticThreadTitleRenameLimit(settings), update)
    .pipe(Effect.mapError(() => "Could not update the thread title."));
  return Option.getOrElse(outcome, () => ({ status: "rate_limited" as const }));
});

export const ThreadTitleToolkitHandlersLive = ThreadTitleToolkit.toLayer({
  rename_current_thread: renameCurrentThread,
});
