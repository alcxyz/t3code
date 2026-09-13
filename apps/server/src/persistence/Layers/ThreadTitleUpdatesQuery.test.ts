import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ThreadTitleUpdatesQueryLive } from "./ThreadTitleUpdatesQuery.ts";
import { ThreadTitleUpdatesQuery } from "../Services/ThreadTitleUpdatesQuery.ts";

const encodePayload = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const tests = it.layer(
  ThreadTitleUpdatesQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const insertThread = Effect.fn("insertTitleUpdatesThread")(function* (input: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly createdAt?: string;
  readonly titleState?: unknown;
}) {
  const createdAt = input.createdAt ?? "2026-09-01T00:00:00.000Z";
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id,
      project_id,
      title,
      title_state_json,
      model_selection_json,
      created_at,
      updated_at
    ) VALUES (
      ${input.threadId},
      'title-updates-project',
      ${input.title},
      ${input.titleState === undefined ? null : encodePayload(input.titleState)},
      '{"provider":"codex","model":"gpt-5.4"}',
      ${createdAt},
      ${createdAt}
    )
  `;
});

const insertEvent = Effect.fn("insertTitleUpdatesEvent")(function* (input: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly at: string;
  readonly commandId: string | null;
  readonly actorKind: "client" | "server" | "provider";
  readonly type?: "thread.created" | "thread.meta-updated";
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
      ${input.id},
      'thread',
      ${input.threadId},
      COALESCE((
        SELECT MAX(stream_version) + 1
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
      ), 0),
      ${input.type ?? "thread.meta-updated"},
      ${input.at},
      ${input.commandId},
      NULL,
      ${input.commandId},
      ${input.actorKind},
      ${encodePayload(input.payload)},
      '{}'
    )
  `;
});

tests("ThreadTitleUpdatesQuery", (it) => {
  it.effect("classifies native, refinement, explicit, automatic, and ambiguous title changes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("history-sources");
      yield* insertThread({
        threadId,
        title: "Restored title",
        titleState: {
          source: "manual",
          version: "restore-title",
          needsRefinement: false,
        },
      });
      yield* insertEvent({
        id: "created",
        threadId,
        at: "2026-09-01T00:00:00.000Z",
        commandId: "create",
        actorKind: "client",
        type: "thread.created",
        payload: { threadId, title: "New thread" },
      });
      yield* insertEvent({
        id: "initial",
        threadId,
        at: "2026-09-01T00:01:00.000Z",
        commandId: "server:thread-title-rename:initial",
        actorKind: "server",
        payload: { threadId, title: "Initial title" },
      });
      yield* insertEvent({
        id: "refine-request",
        threadId,
        at: "2026-09-01T00:02:00.000Z",
        commandId: "server:thread-title-refine:request",
        actorKind: "server",
        payload: {
          threadId,
          regenerateTitle: true,
          titleRegeneration: { requestId: "server:thread-title-refine:request" },
        },
      });
      yield* insertEvent({
        id: "superseded-request-shape",
        threadId,
        at: "2026-09-01T00:03:00.000Z",
        commandId: "server:thread-title-refine:not-the-parent",
        actorKind: "server",
        payload: {
          threadId,
          regenerateTitle: true,
          titleRegeneration: { requestId: "different-request" },
        },
      });
      yield* insertEvent({
        id: "refinement",
        threadId,
        at: "2026-09-01T00:04:00.000Z",
        commandId: "server:thread-title-regeneration-complete:refinement",
        actorKind: "server",
        payload: { threadId, title: "Refined title", titleRegeneration: null },
      });
      yield* insertEvent({
        id: "regeneration-request",
        threadId,
        at: "2026-09-01T00:05:00.000Z",
        commandId: "client-regenerate",
        actorKind: "client",
        payload: {
          threadId,
          regenerateTitle: true,
          titleRegeneration: { requestId: "client-regenerate" },
        },
      });
      yield* insertEvent({
        id: "regeneration",
        threadId,
        at: "2026-09-01T00:06:00.000Z",
        commandId: "server:thread-title-regeneration-complete:manual",
        actorKind: "server",
        payload: { threadId, title: "Regenerated title", titleRegeneration: null },
      });
      yield* insertEvent({
        id: "ambiguous",
        threadId,
        at: "2026-09-01T00:07:00.000Z",
        commandId: "server:thread-title-regeneration-complete:orphan",
        actorKind: "server",
        payload: { threadId, title: "Ambiguous title", titleRegeneration: null },
      });
      yield* insertEvent({
        id: "automatic",
        threadId,
        at: "2026-09-01T00:08:00.000Z",
        commandId: "agent-thread-title:auto",
        actorKind: "server",
        payload: {
          threadId,
          title: "Automatic title",
          titleState: { source: "generated", version: "agent-thread-title:auto" },
        },
      });
      yield* insertEvent({
        id: "manual-same-title",
        threadId,
        at: "2026-09-01T00:09:00.000Z",
        commandId: "manual-same-title",
        actorKind: "client",
        payload: {
          threadId,
          title: "Automatic title",
          titleState: { source: "manual", version: "manual-same-title" },
        },
      });
      yield* insertEvent({
        id: "restoration",
        threadId,
        at: "2026-09-01T00:10:00.000Z",
        commandId: "restore-title",
        actorKind: "client",
        payload: {
          threadId,
          title: "Restored title",
          titleRestoration: true,
          titleState: { source: "manual", version: "restore-title" },
        },
      });

      const result = yield* (yield* ThreadTitleUpdatesQuery).get(threadId);
      expect(Option.getOrThrow(result).titleVersion).toBe("restore-title");
      expect(Option.getOrThrow(result).history).toEqual([
        expect.objectContaining({
          id: "restoration",
          version: "restore-title",
          source: "manual",
          isRestoration: true,
        }),
        expect.objectContaining({ id: "automatic", source: "automatic" }),
        expect.objectContaining({ id: "ambiguous", source: "unknown" }),
        expect.objectContaining({ id: "regeneration", source: "regeneration" }),
        expect.objectContaining({ id: "refinement", source: "refinement" }),
        expect.objectContaining({ id: "initial", source: "initial" }),
      ]);
      expect(Option.getOrThrow(result).history).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "manual-same-title" })]),
      );
    }),
  );

  it.effect("returns only the newest 50 true title changes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("history-bound");
      yield* insertThread({ threadId, title: "Title 51" });
      yield* insertEvent({
        id: "bounded-created",
        threadId,
        at: "2026-09-01T00:00:00.000Z",
        commandId: "bounded-create",
        actorKind: "client",
        type: "thread.created",
        payload: { threadId, title: "New thread" },
      });
      yield* Effect.forEach(
        Array.from({ length: 51 }, (_, index) => index + 1),
        (index) =>
          insertEvent({
            id: `bounded-${index}`,
            threadId,
            at: `2026-09-01T00:${String(index).padStart(2, "0")}:00.000Z`,
            commandId: `manual-${index}`,
            actorKind: "client",
            payload: {
              threadId,
              title: `Title ${index}`,
              titleState: { source: "manual", version: `manual-${index}` },
            },
          }),
        { discard: true },
      );

      const result = Option.getOrThrow(yield* (yield* ThreadTitleUpdatesQuery).get(threadId));
      expect(result.history).toHaveLength(50);
      expect(result.hasMore).toBe(true);
      expect(result.history[0]?.id).toBe("bounded-51");
      expect(result.history.at(-1)?.id).toBe("bounded-2");
    }),
  );
});
