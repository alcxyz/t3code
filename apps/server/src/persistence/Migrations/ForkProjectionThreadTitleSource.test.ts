import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("ForkProjectionThreadTitleSource", (it) => {
  it.effect("round trips title ownership through an upstream v0.0.38-style write", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Automatic title',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES (
          'created', 'thread', 'thread-1', 1, 'thread.created',
          '2026-01-01T00:00:00.000Z', 'system',
          '{"threadId":"thread-1","title":"Automatic title"}', '{}'
        )
      `;

      // Upgrade the v0.0.38 schema through current upstream migrations, then
      // apply the unnumbered fork extension.
      yield* runMigrations();
      let rows = yield* sql<{ readonly titleSource: string | null }>`
        SELECT title_source AS "titleSource" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [{ titleSource: "user" }]);

      // A title written by the fork records ownership in both the event and
      // projection before switching back to upstream.
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES (
          'fork-automatic-title', 'thread', 'thread-1', 2, 'thread.meta-updated',
          '2026-01-01T12:00:00.000Z', 'system',
          '{"threadId":"thread-1","title":"Fork automatic title","titleSource":"automatic"}', '{}'
        )
      `;
      yield* sql`
        UPDATE projection_threads
        SET title = 'Fork automatic title', title_source = 'automatic',
          updated_at = '2026-01-01T12:00:00.000Z'
        WHERE thread_id = 'thread-1'
      `;

      // v0.0.38 ignores the extra projection column and emits no ownership
      // field when it projects a manual rename.
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES (
          'old-manual-rename', 'thread', 'thread-1', 3, 'thread.meta-updated',
          '2026-01-02T00:00:00.000Z', 'user',
          '{"threadId":"thread-1","title":"Renamed upstream"}', '{}'
        )
      `;
      yield* sql`
        UPDATE projection_threads
        SET title = 'Renamed upstream', updated_at = '2026-01-02T00:00:00.000Z'
        WHERE thread_id = 'thread-1'
      `;

      yield* runMigrations();
      rows = yield* sql<{ readonly titleSource: string | null }>`
        SELECT title_source AS "titleSource" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [{ titleSource: "user" }]);

      const forkMigrationRows = yield* sql<{ readonly migrationId: number }>`
        SELECT migration_id AS "migrationId"
        FROM effect_sql_migrations
        WHERE name = 'ProjectionThreadTitleSource'
      `;
      assert.deepEqual(forkMigrationRows, []);
      assert.isFalse(migrationManifest.map(([id]): number => id).includes(50));

      const latestMigration = yield* sql<{ readonly migrationId: number }>`
        SELECT MAX(migration_id) AS "migrationId" FROM effect_sql_migrations
      `;
      assert.deepEqual(latestMigration, [{ migrationId: 49 }]);

      // A future upstream migration can still claim 50 because the extension
      // left the shared high-water mark at 49.
      const runUpstreamMigration = Migrator.make({});
      const upstreamMigrations = yield* runUpstreamMigration({
        loader: Migrator.fromRecord({
          "50_FutureUpstreamMigration": Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TABLE future_upstream_table (id INTEGER PRIMARY KEY)`;
          }),
        }),
      });
      assert.deepEqual(upstreamMigrations, [[50, "FutureUpstreamMigration"]]);

      // Returning to the fork after upstream 50 keeps the extension idempotent
      // and does not disturb either the new upstream ledger row or ownership.
      yield* runMigrations();
      rows = yield* sql<{ readonly titleSource: string | null }>`
        SELECT title_source AS "titleSource" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [{ titleSource: "user" }]);
      const upstreamTable = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'future_upstream_table'
      `;
      assert.deepEqual(upstreamTable, [{ name: "future_upstream_table" }]);
    }),
  );
});
