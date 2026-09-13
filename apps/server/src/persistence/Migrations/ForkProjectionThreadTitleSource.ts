import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Keep databases from the pre-titleState fork and upstream round trips compatible. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const hasLegacyTitleSource = columns.some((column) => column.name === "title_source");
  if (!columns.some((column) => column.name === "title_state_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
  }
  if (!columns.some((column) => column.name === "title_auto_renamed_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN title_auto_renamed_at TEXT`;
  }

  if (!hasLegacyTitleSource) {
    return;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_projection_thread_title_source_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      last_event_sequence INTEGER NOT NULL
    )
  `;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      const checkpoints = yield* sql<{ readonly lastEventSequence: number }>`
        SELECT last_event_sequence AS "lastEventSequence"
        FROM fork_projection_thread_title_source_state
        WHERE singleton = 1
      `;
      const maxima = yield* sql<{ readonly lastEventSequence: number }>`
        SELECT COALESCE(MAX(sequence), 0) AS "lastEventSequence"
        FROM orchestration_events
      `;
      const previousSequence = checkpoints[0]?.lastEventSequence ?? 0;
      const lastEventSequence = maxima[0]?.lastEventSequence ?? 0;
      if (checkpoints.length > 0 && lastEventSequence <= previousSequence) {
        return;
      }

      // An earlier version of this bootstrap inferred manual ownership from an
      // unannotated creation event. The exact creation-derived state is safe to
      // clear; a real manual rename has its own command version.
      yield* sql`
        WITH default_creations AS (
          SELECT
            stream_id AS thread_id,
            COALESCE(command_id, event_id) AS title_version
          FROM orchestration_events
          WHERE sequence > ${previousSequence}
            AND sequence <= ${lastEventSequence}
            AND aggregate_kind = 'thread'
            AND event_type = 'thread.created'
            AND json_valid(payload_json)
            AND json_extract(payload_json, '$.title') = 'New thread'
            AND json_type(payload_json, '$.titleState') IS NULL
            AND json_type(payload_json, '$.titleSource') IS NULL
        )
        UPDATE projection_threads AS thread
        SET title_state_json = NULL
        FROM default_creations AS created
        WHERE created.thread_id = thread.thread_id
          AND thread.title = 'New thread'
          AND json_valid(thread.title_state_json)
          AND json_extract(thread.title_state_json, '$.source') = 'manual'
          AND json_extract(thread.title_state_json, '$.needsRefinement') = 0
          AND json_extract(thread.title_state_json, '$.version') = created.title_version
      `;

      yield* sql`
        WITH title_state_events AS (
          SELECT
            stream_id AS thread_id,
            sequence,
            CASE
              WHEN json_type(payload_json, '$.title') = 'text'
                THEN json_extract(payload_json, '$.title')
              ELSE NULL
            END AS title,
            CASE
              WHEN json_type(payload_json, '$.titleState') = 'null' THEN 'clear'
              ELSE 'set'
            END AS state_operation,
            CASE
              WHEN json_extract(payload_json, '$.titleState.source') IN ('manual', 'generated')
                THEN json_extract(payload_json, '$.titleState.source')
              WHEN json_extract(payload_json, '$.titleSource') = 'automatic'
                THEN 'generated'
              WHEN json_extract(payload_json, '$.titleSource') = 'user'
                THEN 'manual'
              WHEN actor_kind = 'server'
                AND (
                  command_id GLOB 'server:thread-title-rename:*'
                  OR command_id GLOB 'server:thread-title-regeneration-complete:*'
                )
                THEN 'generated'
              ELSE 'manual'
            END AS title_source,
            CASE
              WHEN json_type(payload_json, '$.titleState.version') = 'text'
                THEN json_extract(payload_json, '$.titleState.version')
              ELSE COALESCE(command_id, event_id)
            END AS title_version,
            CASE
              WHEN json_extract(payload_json, '$.titleState.needsRefinement') = 1 THEN 'true'
              ELSE 'false'
            END AS needs_refinement_json,
            ROW_NUMBER() OVER (PARTITION BY stream_id ORDER BY sequence DESC) AS recency
          FROM orchestration_events
          WHERE sequence > ${previousSequence}
            AND sequence <= ${lastEventSequence}
            AND aggregate_kind = 'thread'
            AND event_type IN ('thread.created', 'thread.meta-updated')
            AND json_valid(payload_json)
            AND (
              json_type(payload_json, '$.titleState') = 'null'
              OR json_extract(payload_json, '$.titleState.source') IN ('manual', 'generated')
              OR json_extract(payload_json, '$.titleSource') IN ('automatic', 'user')
              OR (
                event_type = 'thread.meta-updated'
                AND json_type(payload_json, '$.title') = 'text'
              )
            )
        )
        UPDATE projection_threads AS thread
        SET title_state_json = CASE
          WHEN latest.state_operation = 'clear' THEN NULL
          ELSE json_object(
            'source', latest.title_source,
            'version', latest.title_version,
            'needsRefinement', json(latest.needs_refinement_json)
          )
        END
        FROM title_state_events AS latest
        WHERE latest.recency = 1
          AND latest.thread_id = thread.thread_id
          AND (latest.title IS NULL OR latest.title = thread.title)
          AND latest.title_version IS NOT NULL
          AND (
            thread.title_state_json IS NULL
            OR latest.sequence > COALESCE((
              SELECT MAX(state_event.sequence)
              FROM orchestration_events AS state_event
              WHERE state_event.aggregate_kind = 'thread'
                AND state_event.stream_id = thread.thread_id
                AND (
                  state_event.command_id = json_extract(thread.title_state_json, '$.version')
                  OR state_event.event_id = json_extract(thread.title_state_json, '$.version')
                )
            ), -1)
          )
      `;

      yield* sql`
        WITH badge_events AS (
          SELECT
            stream_id AS thread_id,
            CASE
              WHEN json_type(payload_json, '$.title') = 'text'
                THEN json_extract(payload_json, '$.title')
              ELSE NULL
            END AS title,
            json_extract(payload_json, '$.titleAutoRenamedAt') AS title_auto_renamed_at,
            ROW_NUMBER() OVER (PARTITION BY stream_id ORDER BY sequence DESC) AS recency
          FROM orchestration_events
          WHERE sequence > ${previousSequence}
            AND sequence <= ${lastEventSequence}
            AND aggregate_kind = 'thread'
            AND event_type IN ('thread.created', 'thread.meta-updated')
            AND json_valid(payload_json)
            AND (
              json_type(payload_json, '$.title') = 'text'
              OR json_type(payload_json, '$.titleAutoRenamedAt') IS NOT NULL
            )
        )
        UPDATE projection_threads AS thread
        SET title_auto_renamed_at = latest.title_auto_renamed_at
        FROM badge_events AS latest
        WHERE latest.recency = 1
          AND latest.thread_id = thread.thread_id
          AND (latest.title IS NULL OR latest.title = thread.title)
          AND thread.title_auto_renamed_at IS NOT latest.title_auto_renamed_at
      `;

      yield* sql`
        INSERT INTO fork_projection_thread_title_source_state (
          singleton,
          last_event_sequence
        ) VALUES (1, ${lastEventSequence})
        ON CONFLICT (singleton) DO UPDATE SET
          last_event_sequence = excluded.last_event_sequence
      `;
    }),
  );
});
