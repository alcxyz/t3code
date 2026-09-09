import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Add and reconcile fork-owned projection state without consuming an upstream
 * migration id. Extra SQLite columns are tolerated by upstream releases.
 *
 * Reconciliation matters after a round trip through an older upstream build:
 * that build can project a title event but cannot update `title_source`. The
 * latest title-bearing event remains canonical, and an event without ownership
 * is deliberately treated as user-owned.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "title_source")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_source TEXT
    `;
  }

  yield* sql`
    WITH latest_title_events AS (
      SELECT
        stream_id AS thread_id,
        json_extract(payload_json, '$.title') AS title,
        CASE
          WHEN json_extract(payload_json, '$.titleSource') = 'automatic'
            THEN 'automatic'
          ELSE 'user'
        END AS title_source,
        ROW_NUMBER() OVER (PARTITION BY stream_id ORDER BY sequence DESC) AS recency
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND event_type IN ('thread.created', 'thread.meta-updated')
        AND json_valid(payload_json)
        AND json_type(payload_json, '$.title') = 'text'
    )
    UPDATE projection_threads AS thread
    SET title_source = latest.title_source
    FROM latest_title_events AS latest
    WHERE latest.recency = 1
      AND latest.thread_id = thread.thread_id
      AND latest.title = thread.title
      AND thread.title_source IS NOT latest.title_source
  `;
});
