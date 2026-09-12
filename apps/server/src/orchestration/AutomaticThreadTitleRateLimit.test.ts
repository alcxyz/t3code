import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { AutomaticThreadTitleRenameQueryLive } from "../persistence/Layers/AutomaticThreadTitleRenameQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AutomaticThreadTitleRenameQuery } from "../persistence/Services/AutomaticThreadTitleRenameQuery.ts";
import {
  AutomaticThreadTitleRateLimit,
  AutomaticThreadTitleRateLimitLive,
} from "./AutomaticThreadTitleRateLimit.ts";

const TestLayer = AutomaticThreadTitleRateLimitLive.pipe(
  Layer.provideMerge(AutomaticThreadTitleRenameQueryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(TestClock.layer()),
);

const tests = it.layer(TestLayer);

const limit = {
  maxCount: 1,
  windowHours: 12,
  minAgeMinutes: 120,
  minCompletedTurns: 2,
} as const;

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
  readonly occurredAt: string;
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
      ${input.occurredAt},
      ${input.state === "pending" ? null : input.occurredAt},
      ${input.state === "completed" || input.state === "interrupted" || input.state === "error" ? input.occurredAt : null},
      '[]'
    )
  `;
});

const insertEligibleThread = Effect.fn("insertEligibleAutomaticTitleThread")(function* (
  threadId: ThreadId,
) {
  yield* insertThread({ threadId, createdAt: "2026-09-12T09:00:00.000Z" });
  yield* insertTurn({
    threadId,
    turnId: "completed-turn-1",
    state: "completed",
    occurredAt: "2026-09-12T09:10:00.000Z",
  });
  yield* insertTurn({
    threadId,
    turnId: "completed-turn-2",
    state: "completed",
    occurredAt: "2026-09-12T09:20:00.000Z",
  });
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
      ${JSON.stringify(input.payload)},
      '{}'
    )
  `;
});

tests("AutomaticThreadTitleRateLimit", (it) => {
  it.effect("requires the age and successfully completed turn thresholds", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-12T12:00:00.000Z"));
      const exactBoundaryThread = ThreadId.make("rate-eligibility-boundary-thread");
      const tooYoungThread = ThreadId.make("rate-eligibility-young-thread");
      const oneCompletionShortThread = ThreadId.make("rate-eligibility-turns-thread");

      yield* insertThread({
        threadId: exactBoundaryThread,
        createdAt: "2026-09-12T10:00:00.000Z",
      });
      yield* insertThread({
        threadId: tooYoungThread,
        createdAt: "2026-09-12T10:00:00.001Z",
      });
      yield* insertThread({
        threadId: oneCompletionShortThread,
        createdAt: "2026-09-12T09:00:00.000Z",
      });

      for (const threadId of [exactBoundaryThread, tooYoungThread]) {
        yield* insertTurn({
          threadId,
          turnId: `${threadId}-completed-1`,
          state: "completed",
          occurredAt: "2026-09-12T10:10:00.000Z",
        });
        yield* insertTurn({
          threadId,
          turnId: `${threadId}-completed-2`,
          state: "completed",
          occurredAt: "2026-09-12T10:20:00.000Z",
        });
      }

      yield* insertTurn({
        threadId: oneCompletionShortThread,
        turnId: "completed-1",
        state: "completed",
        occurredAt: "2026-09-12T09:10:00.000Z",
      });
      yield* Effect.forEach(
        [
          { turnId: null, state: "pending" as const },
          { turnId: "running-turn", state: "running" as const },
          { turnId: "failed-turn", state: "error" as const },
          { turnId: "interrupted-turn", state: "interrupted" as const },
        ],
        ({ turnId, state }) =>
          insertTurn({
            threadId: oneCompletionShortThread,
            turnId,
            state,
            occurredAt: "2026-09-12T09:20:00.000Z",
          }),
        { discard: true },
      );

      const rateLimit = yield* AutomaticThreadTitleRateLimit;
      expect(yield* rateLimit.isAvailable(exactBoundaryThread, limit)).toBe(true);
      expect(yield* rateLimit.isAvailable(tooYoungThread, limit)).toBe(false);
      expect(yield* rateLimit.isAvailable(oneCompletionShortThread, limit)).toBe(false);

      yield* insertTurn({
        threadId: oneCompletionShortThread,
        turnId: "completed-2",
        state: "completed",
        occurredAt: "2026-09-12T09:30:00.000Z",
      });
      expect(yield* rateLimit.isAvailable(oneCompletionShortThread, limit)).toBe(true);
    }),
  );

  it.effect("withholds permits while the initial placeholder title remains", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-12T12:00:00.000Z"));
      const threadId = ThreadId.make("rate-initial-title-thread");
      yield* insertThread({
        threadId,
        createdAt: "2026-09-12T09:00:00.000Z",
        title: "New thread",
      });
      yield* insertTurn({
        threadId,
        turnId: "completed-1",
        state: "completed",
        occurredAt: "2026-09-12T09:10:00.000Z",
      });
      yield* insertTurn({
        threadId,
        turnId: "completed-2",
        state: "completed",
        occurredAt: "2026-09-12T09:20:00.000Z",
      });

      const entered = yield* Ref.make(false);
      const outcome = yield* (yield* AutomaticThreadTitleRateLimit).withPermit(
        threadId,
        limit,
        Ref.set(entered, true),
      );

      expect(Option.isNone(outcome)).toBe(true);
      expect(yield* Ref.get(entered)).toBe(false);
    }),
  );

  it.effect("counts only durable successful agent renames inside the rolling window", () =>
    Effect.gen(function* () {
      const now = "2026-09-12T12:00:00.000Z";
      yield* TestClock.setTime(Date.parse(now));
      const threadId = ThreadId.make("rate-count-thread");
      yield* insertEligibleThread(threadId);
      const automaticPayload = {
        threadId,
        title: "Changed title",
        titleSource: "automatic",
        updatedAt: now,
      };

      yield* Effect.forEach(
        [
          {
            eventId: "successful-agent-rename",
            threadId,
            occurredAt: "2026-09-12T11:00:00.000Z",
            commandId: "agent-thread-title:successful",
            payload: automaticPayload,
          },
          {
            eventId: "unchanged-agent-request",
            threadId,
            occurredAt: "2026-09-12T11:10:00.000Z",
            commandId: "agent-thread-title:unchanged",
            payload: { threadId, updatedAt: now },
          },
          {
            eventId: "manual-rename",
            threadId,
            occurredAt: "2026-09-12T11:20:00.000Z",
            commandId: "client:manual",
            payload: { ...automaticPayload, titleSource: "user" },
          },
          {
            eventId: "initial-automatic-title",
            threadId,
            occurredAt: "2026-09-12T11:30:00.000Z",
            commandId: "server:thread-title-rename:initial",
            payload: automaticPayload,
          },
          {
            eventId: "rename-at-window-boundary",
            threadId,
            occurredAt: "2026-09-12T00:00:00.000Z",
            commandId: "agent-thread-title:expired",
            payload: automaticPayload,
          },
          {
            eventId: "other-thread-rename",
            threadId: ThreadId.make("rate-count-other-thread"),
            occurredAt: "2026-09-12T11:40:00.000Z",
            commandId: "agent-thread-title:other",
            payload: automaticPayload,
          },
        ],
        insertEvent,
        { discard: true },
      );

      const query = yield* AutomaticThreadTitleRenameQuery;
      expect(yield* query.countSince({ threadId, since: "2026-09-12T00:00:00.000Z" })).toBe(1);

      const rateLimit = yield* AutomaticThreadTitleRateLimit;
      expect(yield* rateLimit.isAvailable(threadId, limit)).toBe(false);
      expect(yield* rateLimit.isAvailable(threadId, { ...limit, maxCount: 2 })).toBe(true);

      const availableAfterLimiterRestart = yield* Effect.gen(function* () {
        return yield* (yield* AutomaticThreadTitleRateLimit).isAvailable(threadId, {
          ...limit,
        });
      }).pipe(
        Effect.provide(
          AutomaticThreadTitleRateLimitLive.pipe(
            Layer.provide(Layer.succeed(AutomaticThreadTitleRenameQuery, query)),
          ),
        ),
      );
      expect(availableAfterLimiterRestart).toBe(false);
    }),
  );

  it.effect("serializes concurrent admissions through the persisted write", () =>
    Effect.gen(function* () {
      const now = "2026-09-12T12:00:00.000Z";
      yield* TestClock.setTime(Date.parse(now));
      const threadId = ThreadId.make("rate-concurrent-thread");
      yield* insertEligibleThread(threadId);
      const nextId = yield* Ref.make(0);
      const rateLimit = yield* AutomaticThreadTitleRateLimit;
      const update = Effect.gen(function* () {
        const id = yield* Ref.updateAndGet(nextId, (value) => value + 1);
        yield* insertEvent({
          eventId: `concurrent-agent-rename-${id}`,
          threadId,
          occurredAt: DateTime.formatIso(yield* DateTime.now),
          commandId: `agent-thread-title:concurrent-${id}`,
          payload: {
            threadId,
            title: `Changed title ${id}`,
            titleSource: "automatic",
            updatedAt: now,
          },
        });
        return id;
      });

      const outcomes = yield* Effect.all(
        [
          rateLimit.withPermit(threadId, limit, update),
          rateLimit.withPermit(threadId, limit, update),
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
      const threadId = ThreadId.make("rate-cancelled-thread");
      yield* insertEligibleThread(threadId);
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      const rateLimit = yield* AutomaticThreadTitleRateLimit;
      const write = (id: string) =>
        insertEvent({
          eventId: `cancelled-agent-rename-${id}`,
          threadId,
          occurredAt: now,
          commandId: `agent-thread-title:cancelled-${id}`,
          payload: {
            threadId,
            title: `Changed title ${id}`,
            titleSource: "automatic",
            updatedAt: now,
          },
        });

      const first = yield* Effect.forkChild(
        rateLimit.withPermit(
          threadId,
          limit,
          Effect.gen(function* () {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
            yield* write("first");
          }),
        ),
      );
      yield* Deferred.await(firstStarted);
      const interruption = yield* Effect.forkChild(Fiber.interrupt(first));
      const second = yield* Effect.forkChild(
        rateLimit.withPermit(
          threadId,
          limit,
          Deferred.succeed(secondEntered, undefined).pipe(Effect.andThen(write("second"))),
        ),
      );
      yield* Effect.yieldNow;
      expect(Option.isNone(yield* Deferred.poll(secondEntered))).toBe(true);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.await(interruption);
      expect(Option.isNone(yield* Fiber.join(second))).toBe(true);
      expect(Option.isNone(yield* Deferred.poll(secondEntered))).toBe(true);

      const query = yield* AutomaticThreadTitleRenameQuery;
      expect(yield* query.countSince({ threadId, since: "2026-09-12T00:00:00.000Z" })).toBe(1);
    }),
  );
});
