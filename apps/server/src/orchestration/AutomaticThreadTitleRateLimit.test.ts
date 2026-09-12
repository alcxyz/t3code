import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { AutomaticThreadTitleRenameQueryLive } from "../persistence/Layers/AutomaticThreadTitleRenameQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AutomaticThreadTitleRenameQuery } from "../persistence/Services/AutomaticThreadTitleRenameQuery.ts";
import {
  AutomaticThreadTitleRateLimit,
  AutomaticThreadTitleRateLimitLive,
  type AutomaticThreadTitleRenameLimit,
} from "./AutomaticThreadTitleRateLimit.ts";

const encodePayload = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const TestLayer = AutomaticThreadTitleRateLimitLive.pipe(
  Layer.provideMerge(AutomaticThreadTitleRenameQueryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(TestClock.layer()),
);

const tests = it.layer(TestLayer);

const balancedLimit = {
  minAgeMinutes: 120,
  minCompletedTurns: 5,
  cooldownMinutes: 45,
  minFreshTurns: 2,
  rollingLimit: null,
} as const satisfies AutomaticThreadTitleRenameLimit;

const oftenLimit = {
  minAgeMinutes: 30,
  minCompletedTurns: 3,
  cooldownMinutes: 15,
  minFreshTurns: 1,
  rollingLimit: null,
} as const satisfies AutomaticThreadTitleRenameLimit;

const insertThread = Effect.fn("insertAutomaticTitleThread")(function* (input: {
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly title?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id,
      project_id,
      title,
      model_selection_json,
      created_at,
      updated_at
    ) VALUES (
      ${input.threadId},
      'rate-limit-project',
      ${input.title ?? "Existing title"},
      '{"provider":"codex","model":"gpt-5.4"}',
      ${input.createdAt},
      ${input.createdAt}
    )
  `;
});

const insertTurn = Effect.fn("insertAutomaticTitleTurn")(function* (input: {
  readonly threadId: ThreadId;
  readonly turnId: string | null;
  readonly state: "pending" | "running" | "interrupted" | "completed" | "error";
  readonly startedAt: string | null;
  readonly completedAt?: string | null;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_turns (
      thread_id,
      turn_id,
      state,
      requested_at,
      started_at,
      completed_at,
      checkpoint_files_json
    ) VALUES (
      ${input.threadId},
      ${input.turnId},
      ${input.state},
      ${input.startedAt ?? input.completedAt ?? "2026-09-01T00:00:00.000Z"},
      ${input.startedAt},
      ${input.completedAt ?? (input.state === "completed" ? input.startedAt : null)},
      '[]'
    )
  `;
});

const insertCompletedTurns = Effect.fn("insertAutomaticTitleCompletedTurns")(function* (input: {
  readonly threadId: ThreadId;
  readonly prefix: string;
  readonly startedAt: ReadonlyArray<string>;
}) {
  yield* Effect.forEach(
    input.startedAt,
    (startedAt, index) =>
      insertTurn({
        threadId: input.threadId,
        turnId: `${input.prefix}-${index + 1}`,
        state: "completed",
        startedAt,
      }),
    { discard: true },
  );
});

const insertEvent = Effect.fn("insertAutomaticTitleEvent")(function* (input: {
  readonly eventId: string;
  readonly threadId: ThreadId;
  readonly occurredAt: string;
  readonly commandId: string | null;
  readonly payload: unknown;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_events (
      event_id,
      aggregate_kind,
      stream_id,
      stream_version,
      event_type,
      occurred_at,
      command_id,
      causation_event_id,
      correlation_id,
      actor_kind,
      payload_json,
      metadata_json
    ) VALUES (
      ${input.eventId},
      'thread',
      ${input.threadId},
      COALESCE((
        SELECT MAX(stream_version) + 1
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
      ), 0),
      'thread.meta-updated',
      ${input.occurredAt},
      ${input.commandId},
      NULL,
      NULL,
      'server',
      ${encodePayload(input.payload)},
      '{}'
    )
  `;
});

const insertSuccessfulRename = (input: {
  readonly eventId: string;
  readonly threadId: ThreadId;
  readonly occurredAt: string;
  readonly title?: string;
}) =>
  insertEvent({
    ...input,
    commandId: `agent-thread-title:${input.eventId}`,
    payload: {
      threadId: input.threadId,
      title: input.title ?? `Title ${input.eventId}`,
      titleSource: "automatic",
      updatedAt: input.occurredAt,
    },
  });

const insertInitiallyEligibleThread = Effect.fn("insertInitiallyEligibleAutomaticTitleThread")(
  function* (threadId: ThreadId, completedTurns = 5) {
    yield* insertThread({ threadId, createdAt: "2026-09-12T08:00:00.000Z" });
    yield* insertCompletedTurns({
      threadId,
      prefix: "initial",
      startedAt: Array.from(
        { length: completedTurns },
        (_, index) => `2026-09-12T08:${String(index + 1).padStart(2, "0")}:00.000Z`,
      ),
    });
  },
);

tests("AutomaticThreadTitleRateLimit", (it) => {
  it.effect("uses age and completed turns only for the first feature rename", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-12T12:00:00.000Z"));
      const eligible = ThreadId.make("first-eligible");
      const tooYoung = ThreadId.make("first-too-young");
      const oneTurnShort = ThreadId.make("first-one-turn-short");
      const placeholder = ThreadId.make("first-placeholder");

      yield* insertInitiallyEligibleThread(eligible);
      yield* insertThread({
        threadId: tooYoung,
        createdAt: "2026-09-12T10:00:00.001Z",
      });
      yield* insertCompletedTurns({
        threadId: tooYoung,
        prefix: "young",
        startedAt: [
          "2026-09-12T10:01:00.000Z",
          "2026-09-12T10:02:00.000Z",
          "2026-09-12T10:03:00.000Z",
          "2026-09-12T10:04:00.000Z",
          "2026-09-12T10:05:00.000Z",
        ],
      });
      yield* insertInitiallyEligibleThread(oneTurnShort, 4);
      yield* insertThread({
        threadId: placeholder,
        createdAt: "2026-09-12T08:00:00.000Z",
        title: "New thread",
      });
      yield* insertCompletedTurns({
        threadId: placeholder,
        prefix: "placeholder",
        startedAt: [
          "2026-09-12T08:01:00.000Z",
          "2026-09-12T08:02:00.000Z",
          "2026-09-12T08:03:00.000Z",
          "2026-09-12T08:04:00.000Z",
          "2026-09-12T08:05:00.000Z",
        ],
      });
      yield* insertTurn({
        threadId: oneTurnShort,
        turnId: "failed-turn",
        state: "error",
        startedAt: "2026-09-12T08:10:00.000Z",
        completedAt: "2026-09-12T08:11:00.000Z",
      });

      const limiter = yield* AutomaticThreadTitleRateLimit;
      expect(yield* limiter.isAvailable(eligible, balancedLimit)).toBe(true);
      expect(yield* limiter.isAvailable(tooYoung, balancedLimit)).toBe(false);
      expect(yield* limiter.isAvailable(oneTurnShort, balancedLimit)).toBe(false);
      expect(yield* limiter.isAvailable(placeholder, balancedLimit)).toBe(false);
    }),
  );

  it.effect("allows a rapid conversation rename at the exact recurring boundary", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("rapid-conversation");
      yield* insertInitiallyEligibleThread(threadId, 3);
      yield* insertSuccessfulRename({
        eventId: "rapid-first",
        threadId,
        occurredAt: "2026-09-12T12:00:00.000Z",
      });
      yield* insertCompletedTurns({
        threadId,
        prefix: "rapid-fresh",
        startedAt: ["2026-09-12T12:01:00.000Z"],
      });

      const limiter = yield* AutomaticThreadTitleRateLimit;
      yield* TestClock.setTime(Date.parse("2026-09-12T12:14:59.999Z"));
      expect(yield* limiter.isAvailable(threadId, oftenLimit)).toBe(false);
      yield* TestClock.setTime(Date.parse("2026-09-12T12:15:00.000Z"));
      expect(yield* limiter.isAvailable(threadId, oftenLimit)).toBe(true);
    }),
  );

  it.effect("does not count a long coding turn that started before its rename", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("long-coding-turn");
      yield* insertInitiallyEligibleThread(threadId);
      yield* insertSuccessfulRename({
        eventId: "long-task-rename",
        threadId,
        occurredAt: "2026-09-12T10:00:00.000Z",
      });
      yield* insertTurn({
        threadId,
        turnId: "rename-containing-turn",
        state: "completed",
        startedAt: "2026-09-12T09:00:00.000Z",
        completedAt: "2026-09-12T11:30:00.000Z",
      });
      yield* insertCompletedTurns({
        threadId,
        prefix: "long-task-fresh",
        startedAt: ["2026-09-12T11:31:00.000Z"],
      });
      yield* TestClock.setTime(Date.parse("2026-09-12T12:00:00.000Z"));

      const limiter = yield* AutomaticThreadTitleRateLimit;
      expect(yield* limiter.isAvailable(threadId, balancedLimit)).toBe(false);
      yield* insertCompletedTurns({
        threadId,
        prefix: "long-task-second-fresh",
        startedAt: ["2026-09-12T11:40:00.000Z"],
      });
      expect(yield* limiter.isAvailable(threadId, balancedLimit)).toBe(true);
    }),
  );

  it.effect("keeps an overnight return gated until enough fresh work completes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("sparse-return");
      yield* insertThread({
        threadId,
        createdAt: "2026-09-11T12:00:00.000Z",
      });
      yield* insertCompletedTurns({
        threadId,
        prefix: "before-idle",
        startedAt: [
          "2026-09-11T12:30:00.000Z",
          "2026-09-11T13:00:00.000Z",
          "2026-09-11T13:30:00.000Z",
          "2026-09-11T14:00:00.000Z",
          "2026-09-11T14:30:00.000Z",
        ],
      });
      yield* insertSuccessfulRename({
        eventId: "before-idle",
        threadId,
        occurredAt: "2026-09-11T17:00:00.000Z",
      });
      yield* TestClock.setTime(Date.parse("2026-09-12T09:00:00.000Z"));

      const limiter = yield* AutomaticThreadTitleRateLimit;
      expect(yield* limiter.isAvailable(threadId, balancedLimit)).toBe(false);
      yield* insertCompletedTurns({
        threadId,
        prefix: "morning",
        startedAt: ["2026-09-12T08:30:00.000Z"],
      });
      expect(yield* limiter.isAvailable(threadId, balancedLimit)).toBe(false);
      yield* insertCompletedTurns({
        threadId,
        prefix: "morning-second",
        startedAt: ["2026-09-12T08:45:00.000Z"],
      });
      expect(yield* limiter.isAvailable(threadId, balancedLimit)).toBe(true);
    }),
  );

  it.effect("uses recurring settings after a profile change without reapplying initial age", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("profile-change");
      yield* insertThread({
        threadId,
        createdAt: "2026-09-12T09:30:00.000Z",
      });
      yield* insertCompletedTurns({
        threadId,
        prefix: "often-initial",
        startedAt: [
          "2026-09-12T09:31:00.000Z",
          "2026-09-12T09:40:00.000Z",
          "2026-09-12T09:50:00.000Z",
        ],
      });
      yield* insertSuccessfulRename({
        eventId: "often-profile-rename",
        threadId,
        occurredAt: "2026-09-12T10:00:00.000Z",
      });
      yield* insertCompletedTurns({
        threadId,
        prefix: "rare-fresh",
        startedAt: [
          "2026-09-12T10:30:00.000Z",
          "2026-09-12T11:00:00.000Z",
          "2026-09-12T11:30:00.000Z",
        ],
      });
      yield* TestClock.setTime(Date.parse("2026-09-12T12:00:00.000Z"));

      const rareLimit = {
        minAgeMinutes: 360,
        minCompletedTurns: 10,
        cooldownMinutes: 120,
        minFreshTurns: 3,
        rollingLimit: null,
      } as const satisfies AutomaticThreadTitleRenameLimit;
      expect(yield* (yield* AutomaticThreadTitleRateLimit).isAvailable(threadId, rareLimit)).toBe(
        true,
      );
    }),
  );

  it.effect("ignores repeated idempotent agent requests for cooldown and rolling quota", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("idempotent-requests");
      yield* insertThread({
        threadId,
        createdAt: "2026-09-11T18:00:00.000Z",
      });
      yield* insertCompletedTurns({
        threadId,
        prefix: "rolling-initial",
        startedAt: [
          "2026-09-11T18:30:00.000Z",
          "2026-09-11T19:00:00.000Z",
          "2026-09-11T19:30:00.000Z",
          "2026-09-11T20:00:00.000Z",
          "2026-09-11T20:30:00.000Z",
        ],
      });
      yield* insertSuccessfulRename({
        eventId: "idempotent-success",
        threadId,
        occurredAt: "2026-09-12T10:00:00.000Z",
      });
      yield* Effect.forEach(
        ["11:00:00.000", "11:15:00.000", "11:30:00.000"],
        (time, index) =>
          insertEvent({
            eventId: `idempotent-no-write-${index}`,
            threadId,
            occurredAt: `2026-09-12T${time}Z`,
            commandId: `agent-thread-title:idempotent-${index}`,
            payload: { threadId, updatedAt: `2026-09-12T${time}Z` },
          }),
        { discard: true },
      );
      yield* insertCompletedTurns({
        threadId,
        prefix: "idempotent-fresh",
        startedAt: ["2026-09-12T10:15:00.000Z", "2026-09-12T10:30:00.000Z"],
      });
      yield* TestClock.setTime(Date.parse("2026-09-12T12:00:00.000Z"));

      const customLimit = {
        ...balancedLimit,
        rollingLimit: { maxCount: 2, windowHours: 12 },
      };
      const query = yield* AutomaticThreadTitleRenameQuery;
      expect(yield* query.latestSuccessfulRenameAt(threadId)).toEqual(
        Option.some("2026-09-12T10:00:00.000Z"),
      );
      expect(
        yield* query.countSince({
          threadId,
          since: "2026-09-12T00:00:00.000Z",
        }),
      ).toBe(1);
      const limiter = yield* AutomaticThreadTitleRateLimit;
      expect(yield* limiter.isAvailable(threadId, customLimit)).toBe(true);
      expect(yield* limiter.isAvailable(threadId, customLimit)).toBe(true);
    }),
  );

  it.effect("applies an optional rolling maximum with an exclusive window boundary", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("rolling-boundary");
      yield* insertThread({
        threadId,
        createdAt: "2026-09-11T18:00:00.000Z",
      });
      yield* insertCompletedTurns({
        threadId,
        prefix: "rolling-initial",
        startedAt: [
          "2026-09-11T18:30:00.000Z",
          "2026-09-11T19:00:00.000Z",
          "2026-09-11T19:30:00.000Z",
          "2026-09-11T20:00:00.000Z",
          "2026-09-11T20:30:00.000Z",
        ],
      });
      yield* insertSuccessfulRename({
        eventId: "at-window-boundary",
        threadId,
        occurredAt: "2026-09-12T00:00:00.000Z",
      });
      yield* insertSuccessfulRename({
        eventId: "inside-window",
        threadId,
        occurredAt: "2026-09-12T01:00:00.000Z",
      });
      yield* insertCompletedTurns({
        threadId,
        prefix: "rolling-fresh",
        startedAt: ["2026-09-12T02:00:00.000Z", "2026-09-12T03:00:00.000Z"],
      });
      yield* TestClock.setTime(Date.parse("2026-09-12T12:00:00.000Z"));

      const cappedLimit = {
        ...balancedLimit,
        rollingLimit: { maxCount: 2, windowHours: 12 },
      };
      const limiter = yield* AutomaticThreadTitleRateLimit;
      expect(yield* limiter.isAvailable(threadId, cappedLimit)).toBe(true);

      yield* insertSuccessfulRename({
        eventId: "second-inside-window",
        threadId,
        occurredAt: "2026-09-12T04:00:00.000Z",
      });
      yield* insertCompletedTurns({
        threadId,
        prefix: "rolling-second-fresh",
        startedAt: ["2026-09-12T05:00:00.000Z", "2026-09-12T06:00:00.000Z"],
      });
      expect(yield* limiter.isAvailable(threadId, cappedLimit)).toBe(false);
      expect(
        yield* limiter.isAvailable(threadId, {
          ...cappedLimit,
          rollingLimit: null,
        }),
      ).toBe(true);

      const query = yield* AutomaticThreadTitleRenameQuery;
      const availableAfterRestart = yield* Effect.gen(function* () {
        return yield* (yield* AutomaticThreadTitleRateLimit).isAvailable(threadId, cappedLimit);
      }).pipe(
        Effect.provide(
          AutomaticThreadTitleRateLimitLive.pipe(
            Layer.provide(Layer.succeed(AutomaticThreadTitleRenameQuery, query)),
          ),
        ),
      );
      expect(availableAfterRestart).toBe(false);
    }),
  );

  it.effect("serializes concurrent admissions through the persisted write", () =>
    Effect.gen(function* () {
      const now = "2026-09-12T12:00:00.000Z";
      yield* TestClock.setTime(Date.parse(now));
      const threadId = ThreadId.make("concurrent-admission");
      yield* insertInitiallyEligibleThread(threadId);
      const nextId = yield* Ref.make(0);
      const limiter = yield* AutomaticThreadTitleRateLimit;
      const cappedLimit = {
        ...balancedLimit,
        rollingLimit: { maxCount: 1, windowHours: 12 },
      };
      const update = Effect.gen(function* () {
        const id = yield* Ref.updateAndGet(nextId, (value) => value + 1);
        yield* insertSuccessfulRename({
          eventId: `concurrent-${id}`,
          threadId,
          occurredAt: now,
        });
        return id;
      });

      const outcomes = yield* Effect.all(
        [
          limiter.withPermit(threadId, cappedLimit, update),
          limiter.withPermit(threadId, cappedLimit, update),
        ],
        { concurrency: "unbounded" },
      );
      expect(outcomes.filter(Option.isSome)).toHaveLength(1);
      expect(yield* Ref.get(nextId)).toBe(1);
    }),
  );

  it.effect("keeps the quota lock until an admitted write persists after cancellation", () =>
    Effect.gen(function* () {
      const now = "2026-09-12T12:00:00.000Z";
      yield* TestClock.setTime(Date.parse(now));
      const threadId = ThreadId.make("cancelled-admission");
      yield* insertInitiallyEligibleThread(threadId);
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      const limiter = yield* AutomaticThreadTitleRateLimit;
      const cappedLimit = {
        ...balancedLimit,
        rollingLimit: { maxCount: 1, windowHours: 12 },
      };

      const first = yield* Effect.forkChild(
        limiter.withPermit(
          threadId,
          cappedLimit,
          Effect.gen(function* () {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
            yield* insertSuccessfulRename({
              eventId: "cancelled-first",
              threadId,
              occurredAt: now,
            });
          }),
        ),
      );
      yield* Deferred.await(firstStarted);
      const interruption = yield* Effect.forkChild(Fiber.interrupt(first));
      const second = yield* Effect.forkChild(
        limiter.withPermit(
          threadId,
          cappedLimit,
          Deferred.succeed(secondEntered, undefined).pipe(
            Effect.andThen(
              insertSuccessfulRename({
                eventId: "cancelled-second",
                threadId,
                occurredAt: now,
              }),
            ),
          ),
        ),
      );
      yield* Effect.yieldNow;
      expect(Option.isNone(yield* Deferred.poll(secondEntered))).toBe(true);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.await(interruption);
      expect(Option.isNone(yield* Fiber.join(second))).toBe(true);
      expect(Option.isNone(yield* Deferred.poll(secondEntered))).toBe(true);
    }),
  );
});
