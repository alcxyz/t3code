import { CommandId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  ThreadTitleUpdatesQuery,
  type ThreadTitleUpdatesRecord,
} from "../persistence/Services/ThreadTitleUpdatesQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  AutomaticThreadTitleRateLimit,
  type AutomaticThreadTitleRateLimitInspection,
} from "./AutomaticThreadTitleRateLimit.ts";
import { getThreadTitleUpdates } from "./ThreadTitleUpdates.ts";

const threadId = ThreadId.make("title-updates-status");
const checkedAt = "2026-09-12T12:00:00.000Z";
const baseThread: ThreadTitleUpdatesRecord = {
  title: "Generated title",
  titleSource: "generated",
  titleVersion: null,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  snoozedUntil: null,
  titleRegenerationRequestId: null,
  history: [],
  hasMore: false,
};
const baseInspection: AutomaticThreadTitleRateLimitInspection = {
  checkedAt,
  phase: "recurring",
  eligibleAt: "2026-09-12T11:45:00.000Z",
  completedTurns: 2,
  requiredTurns: 2,
  rollingCount: 0,
  rollingMaximum: 1,
  rollingWindowHours: 12,
  available: true,
};

function readTitleUpdates(input: {
  readonly thread?: Partial<ThreadTitleUpdatesRecord>;
  readonly inspection?: Partial<AutomaticThreadTitleRateLimitInspection>;
  readonly enabled?: boolean;
}) {
  const thread = { ...baseThread, ...input.thread };
  const inspection = { ...baseInspection, ...input.inspection };
  return getThreadTitleUpdates(threadId).pipe(
    Effect.provideService(
      ThreadTitleUpdatesQuery,
      ThreadTitleUpdatesQuery.of({ get: () => Effect.succeed(Option.some(thread)) }),
    ),
    Effect.provideService(
      AutomaticThreadTitleRateLimit,
      AutomaticThreadTitleRateLimit.of({
        inspect: () => Effect.succeed(Option.some(inspection)),
        isAvailable: () => Effect.succeed(inspection.available),
        withPermit: (_threadId, _limit, effect) => Effect.map(effect, Option.some),
      }),
    ),
    Effect.provide(
      ServerSettings.layerTest({
        automaticThreadTitles: input.enabled ?? true,
        automaticThreadTitleRenamePolicy: "custom",
      }),
    ),
  );
}

it.effect("reports every runtime gate before quota eligibility", () =>
  Effect.gen(function* () {
    const cases = [
      { expected: "disabled", input: { enabled: false } },
      { expected: "deleted", input: { thread: { deletedAt: checkedAt } } },
      { expected: "archived", input: { thread: { archivedAt: checkedAt } } },
      {
        expected: "snoozed",
        input: { thread: { snoozedUntil: "2026-09-12T12:00:01.000Z" } },
      },
      { expected: "settled", input: { thread: { settledOverride: "settled" as const } } },
      { expected: "protected", input: { thread: { titleSource: "manual" as const } } },
      {
        expected: "regenerating",
        input: { thread: { titleRegenerationRequestId: "regenerating" } },
      },
      { expected: "waiting", input: { inspection: { available: false } } },
      { expected: "eligible", input: {} },
    ] as const;

    for (const testCase of cases) {
      const result = yield* readTitleUpdates(testCase.input);
      expect(result.status).toBe(testCase.expected);
      expect(result.status === "eligible").toBe(testCase.expected === "eligible");
    }
  }),
);

it.effect("offers undo only while the latest automatic rename still owns the title", () =>
  Effect.gen(function* () {
    const automaticVersion = CommandId.make("agent-thread-title:latest");
    const history = [
      {
        id: "event-latest",
        at: checkedAt,
        previousTitle: "Previous title",
        title: "Generated title",
        version: automaticVersion,
        isRestoration: false,
        source: "automatic" as const,
      },
    ];
    const current = yield* readTitleUpdates({
      thread: { titleVersion: automaticVersion, history },
    });
    expect(current.currentVersion).toBe(automaticVersion);
    expect(current.undoTitle).toBe("Previous title");

    for (const thread of [
      { titleVersion: CommandId.make("manual-same-title"), history },
      { titleVersion: automaticVersion, titleSource: "manual" as const, history },
      { titleVersion: automaticVersion, titleRegenerationRequestId: "pending", history },
    ]) {
      expect((yield* readTitleUpdates({ thread })).undoTitle).toBeNull();
    }
  }),
);

it.effect("fails a missing thread without querying quota", () =>
  getThreadTitleUpdates(ThreadId.make("missing-title-updates")).pipe(
    Effect.provideService(
      ThreadTitleUpdatesQuery,
      ThreadTitleUpdatesQuery.of({ get: () => Effect.succeed(Option.none()) }),
    ),
    Effect.provideService(
      AutomaticThreadTitleRateLimit,
      AutomaticThreadTitleRateLimit.of({
        inspect: () => Effect.die("quota should not be queried"),
        isAvailable: () => Effect.die("quota should not be queried"),
        withPermit: () => Effect.die("quota should not be queried"),
      }),
    ),
    Effect.provide(ServerSettings.layerTest()),
    Effect.flip,
    Effect.map((error) => expect(error).toMatchObject({ _tag: "OrchestrationGetSnapshotError" })),
  ),
);
