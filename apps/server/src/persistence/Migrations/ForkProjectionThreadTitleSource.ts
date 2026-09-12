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

  if (hasLegacyTitleSource) {
    yield* sql`
      WITH latest_title_events AS (
        SELECT
          stream_id AS thread_id,
          sequence,
          json_extract(payload_json, '$.title') AS title,
          CASE
            WHEN json_extract(payload_json, '$.titleState.source') IN ('manual', 'generated')
              THEN json_extract(payload_json, '$.titleState.source')
            WHEN json_extract(payload_json, '$.titleSource') = 'automatic'
              THEN 'generated'
            WHEN json_extract(payload_json, '$.titleSource') = 'user'
              THEN 'manual'
            WHEN event_type = 'thread.meta-updated'
              AND actor_kind = 'server'
              AND (
                command_id GLOB 'server:thread-title-rename:*'
                OR command_id GLOB 'server:thread-title-regeneration-complete:*'
              )
              THEN 'generated'
            ELSE NULL
          END AS event_title_source,
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
        WHERE aggregate_kind = 'thread'
          AND event_type IN ('thread.created', 'thread.meta-updated')
          AND json_valid(payload_json)
          AND json_type(payload_json, '$.title') = 'text'
      )
      UPDATE projection_threads AS thread
      SET title_state_json = json_object(
            'source', COALESCE(latest.event_title_source, 'manual'),
            'version', latest.title_version,
            'needsRefinement', json(latest.needs_refinement_json)
          )
      FROM latest_title_events AS latest
      WHERE latest.recency = 1
        AND latest.thread_id = thread.thread_id
        AND latest.title = thread.title
        AND latest.title_version IS NOT NULL
        AND (
          thread.title_state_json IS NULL
          OR latest.sequence > COALESCE((
            SELECT MAX(state_event.sequence)
            FROM orchestration_events AS state_event
            WHERE state_event.aggregate_kind = 'thread'
              AND state_event.stream_id = thread.thread_id
              AND state_event.command_id = json_extract(thread.title_state_json, '$.version')
          ), -1)
        )
    `;

    yield* sql`
      WITH latest_badge_events AS (
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
        WHERE aggregate_kind = 'thread'
          AND event_type IN ('thread.created', 'thread.meta-updated')
          AND json_valid(payload_json)
          AND (
            json_type(payload_json, '$.title') = 'text'
            OR json_type(payload_json, '$.titleAutoRenamedAt') IS NOT NULL
          )
      )
      UPDATE projection_threads AS thread
      SET title_auto_renamed_at = latest.title_auto_renamed_at
      FROM latest_badge_events AS latest
      WHERE latest.recency = 1
        AND latest.thread_id = thread.thread_id
        AND (latest.title IS NULL OR latest.title = thread.title)
        AND thread.title_auto_renamed_at IS NOT latest.title_auto_renamed_at
    `;
  }
});
