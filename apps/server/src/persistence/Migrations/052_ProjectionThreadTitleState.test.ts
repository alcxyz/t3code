import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import bootstrapForkTitles from "./ForkProjectionThreadTitleSource.ts";

for (const bootstrapped of [false, true]) {
  it.layer(NodeSqliteClient.layerMemory())(`upstream title state, fork=${bootstrapped}`, (it) => {
    it.effect("advances the ledger and preserves existing title state on repeat startup", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 49 });
        if (bootstrapped) {
          yield* bootstrapForkTitles;
        }
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            created_at, updated_at
          ) VALUES (
            'thread-1', 'project-1', 'Chosen title',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
          )
        `;
        const state = '{"source":"manual","version":"rename-1","needsRefinement":false}';
        if (bootstrapped) {
          yield* sql`UPDATE projection_threads SET title_state_json = ${state}`;
        }
        yield* runMigrations();
        yield* runMigrations();
        const rows = yield* sql<{ readonly state: string | null }>`
          SELECT title_state_json AS state FROM projection_threads WHERE thread_id = 'thread-1'
        `;
        assert.deepEqual(rows, [{ state: bootstrapped ? state : null }]);
        const ledger = yield* sql<{ readonly id: number; readonly name: string }>`
          SELECT migration_id AS id, name
          FROM effect_sql_migrations
          WHERE migration_id BETWEEN 50 AND 52
            OR name IN (
              'ProjectionThreadPullRequests',
              'ProjectionThreadMessageContext',
              'ProjectionThreadTitleState'
            )
          ORDER BY migration_id
        `;
        assert.deepEqual(ledger, [
          { id: 50, name: "ProjectionThreadPullRequests" },
          { id: 51, name: "ProjectionThreadMessageContext" },
          { id: 52, name: "ProjectionThreadTitleState" },
        ]);
      }),
    );
  });
}
