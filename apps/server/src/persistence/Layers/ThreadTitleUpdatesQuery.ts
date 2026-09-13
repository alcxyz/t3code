import { IsoDateTime, OrchestrationGetTitleUpdatesResult, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ThreadTitleUpdatesQuery,
  type ThreadTitleUpdatesQueryShape,
} from "../Services/ThreadTitleUpdatesQuery.ts";

const HISTORY_LIMIT = 50;

const ThreadTitleUpdatesRow = Schema.Struct({
  title: Schema.String,
  titleSource: Schema.NullOr(Schema.Literals(["generated", "manual"])),
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  titleRegenerationRequestId: Schema.NullOr(Schema.String),
});

const HistoryRow = OrchestrationGetTitleUpdatesResult.fields.history.value;

const makeThreadTitleUpdatesQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getThreadRow = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: ThreadTitleUpdatesRow,
    execute: (threadId) => sql`
      SELECT
        title,
        json_extract(title_state_json, '$.source') AS "titleSource",
        archived_at AS "archivedAt",
        deleted_at AS "deletedAt",
        settled_override AS "settledOverride",
        snoozed_until AS "snoozedUntil",
        title_regeneration_request_id AS "titleRegenerationRequestId"
      FROM projection_threads
      WHERE thread_id = ${threadId}
      LIMIT 1
    `,
  });

  const listHistoryRows = SqlSchema.findAll({
    Request: ThreadId,
    Result: HistoryRow,
    execute: (threadId) => sql`
      WITH thread_events AS (
        SELECT
          sequence,
          event_id,
          event_type,
          occurred_at,
          command_id,
          actor_kind,
          payload_json
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      ),
      title_events AS (
        SELECT
          sequence,
          event_id,
          occurred_at,
          command_id,
          actor_kind,
          payload_json,
          event_type = 'thread.meta-updated' AS is_update,
          json_extract(payload_json, '$.title') AS title
        FROM thread_events
        WHERE (
          event_type = 'thread.created'
          OR event_type = 'thread.meta-updated'
        )
          AND json_type(payload_json, '$.title') = 'text'
      ),
      title_events_with_previous AS (
        SELECT
          *,
          LAG(title) OVER (ORDER BY sequence) AS previous_title
        FROM title_events
      ),
      changed_titles AS (
        SELECT *
        FROM title_events_with_previous
        WHERE is_update
          AND previous_title IS NOT title
      )
      SELECT
        changed.event_id AS id,
        changed.occurred_at AS at,
        changed.previous_title AS "previousTitle",
        changed.title,
        CASE
          WHEN changed.command_id LIKE 'agent-thread-title:%'
            AND (
              json_extract(changed.payload_json, '$.titleState.source') = 'generated'
              OR json_extract(changed.payload_json, '$.titleSource') = 'automatic'
            )
            THEN 'automatic'
          WHEN (
            json_extract(changed.payload_json, '$.titleState.source') = 'manual'
            OR json_extract(changed.payload_json, '$.titleSource') = 'user'
          )
            THEN 'manual'
          WHEN (
            (
              changed.actor_kind = 'server'
              AND changed.command_id LIKE 'server:thread-title-rename:%'
            )
            OR (
              changed.actor_kind = 'provider'
              AND changed.command_id LIKE 'provider:%:thread-meta-update:%'
              AND json_extract(changed.payload_json, '$.titleState.source') = 'generated'
            )
          )
            THEN 'initial'
          WHEN changed.command_id LIKE 'server:thread-title-regeneration-complete:%'
            THEN COALESCE((
              SELECT CASE
                WHEN request.command_id LIKE 'server:thread-title-refine:%'
                  THEN 'refinement'
                ELSE 'regeneration'
              END
              FROM thread_events AS request
              WHERE request.sequence < changed.sequence
                AND request.event_type = 'thread.meta-updated'
                AND json_extract(request.payload_json, '$.regenerateTitle') = 1
                AND json_extract(request.payload_json, '$.titleRegeneration.requestId') = request.command_id
                AND request.sequence > COALESCE((
                  SELECT MAX(previous_completion.sequence)
                  FROM thread_events AS previous_completion
                  WHERE previous_completion.sequence < changed.sequence
                    AND previous_completion.command_id LIKE 'server:thread-title-regeneration-complete:%'
                ), -1)
              ORDER BY request.sequence DESC
              LIMIT 1
            ), 'unknown')
          ELSE 'unknown'
        END AS source
      FROM changed_titles AS changed
      ORDER BY changed.sequence DESC
      LIMIT ${HISTORY_LIMIT + 1}
    `,
  });

  const get: ThreadTitleUpdatesQueryShape["get"] = Effect.fn("ThreadTitleUpdatesQuery.get")(
    function* (threadId) {
      const thread = yield* getThreadRow(threadId).pipe(
        Effect.mapError(toPersistenceSqlError("ThreadTitleUpdatesQuery.get:thread")),
      );
      if (Option.isNone(thread)) return Option.none();

      const rows = yield* listHistoryRows(threadId).pipe(
        Effect.mapError(toPersistenceSqlError("ThreadTitleUpdatesQuery.get:history")),
      );
      return Option.some({
        ...thread.value,
        history: rows.slice(0, HISTORY_LIMIT),
        hasMore: rows.length > HISTORY_LIMIT,
      });
    },
  );

  return ThreadTitleUpdatesQuery.of({ get });
});

export const ThreadTitleUpdatesQueryLive = Layer.effect(
  ThreadTitleUpdatesQuery,
  makeThreadTitleUpdatesQuery,
);
