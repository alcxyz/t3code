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
  it.effect("counts only durable successful agent renames inside the rolling window", () =>
    Effect.gen(function* () {
      const now = "2026-09-12T12:00:00.000Z";
      yield* TestClock.setTime(Date.parse(now));
      const threadId = ThreadId.make("rate-count-thread");
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
      expect(yield* rateLimit.isAvailable(threadId, { maxCount: 1, windowHours: 12 })).toBe(false);
      expect(yield* rateLimit.isAvailable(threadId, { maxCount: 2, windowHours: 12 })).toBe(true);

      const availableAfterLimiterRestart = yield* Effect.gen(function* () {
        return yield* (yield* AutomaticThreadTitleRateLimit).isAvailable(threadId, {
          maxCount: 1,
          windowHours: 12,
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
          rateLimit.withPermit(threadId, { maxCount: 1, windowHours: 12 }, update),
          rateLimit.withPermit(threadId, { maxCount: 1, windowHours: 12 }, update),
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
          { maxCount: 1, windowHours: 12 },
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
          { maxCount: 1, windowHours: 12 },
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
