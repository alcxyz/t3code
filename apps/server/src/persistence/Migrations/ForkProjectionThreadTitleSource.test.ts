import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import reconcileTitleState from "./ForkProjectionThreadTitleSource.ts";

const insertThread = (sql: SqlClient.SqlClient, id: string, title: string, source: string) =>
  sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      created_at, updated_at, title_source, title_auto_renamed_at
    ) VALUES (
      ${id}, 'project-1', ${title},
      '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${source},
      '2026-01-01T00:00:00.000Z'
    )
  `;

const insertEvent = (
  sql: SqlClient.SqlClient,
  input: {
    readonly id: string;
    readonly threadId: string;
    readonly sequence: number;
    readonly commandId: string;
    readonly payload: string;
  },
) =>
  sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, command_id, actor_kind, payload_json, metadata_json
    ) VALUES (
      ${input.id}, 'thread', ${input.threadId}, ${input.sequence}, 'thread.meta-updated',
      '2026-01-01T00:00:00.000Z', ${input.commandId}, 'server', ${input.payload}, '{}'
    )
  `;

it.layer(NodeSqliteClient.layerMemory())("fork title-state compatibility", (it) => {
  it.effect("keeps the shared migration ledger at 49 and upgrades legacy ownership", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_source TEXT`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_auto_renamed_at TEXT`;

      yield* insertThread(sql, "generated", "Generated title", "automatic");
      yield* insertEvent(sql, {
        id: "generated-event",
        threadId: "generated",
        sequence: 1,
        commandId: "agent-thread-title:legacy",
        payload:
          '{"title":"Generated title","titleSource":"automatic","titleAutoRenamedAt":"2026-01-02T00:00:00.000Z"}',
      });
      // Upstream cannot update the fork-owned source column. Its newer,
      // unannotated title event must still transfer ownership to the user.
      yield* insertThread(sql, "manual", "Manual title", "automatic");
      yield* insertEvent(sql, {
        id: "manual-event",
        threadId: "manual",
        sequence: 1,
        commandId: "manual-rename",
        payload: '{"title":"Manual title"}',
      });

      yield* runMigrations();

      const migrations = yield* sql<{ readonly id: number; readonly name: string }>`
        SELECT migration_id AS id, name FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 1
      `;
      assert.deepEqual(migrations, [{ id: 49, name: "ProjectionThreadsActiveOrderKey" }]);
      assert.deepEqual(migrationManifest.at(-1), [49, "ProjectionThreadsActiveOrderKey"]);

      const rows = yield* sql<{
        readonly id: string;
        readonly state: string;
        readonly renamedAt: string | null;
      }>`
        SELECT thread_id AS id, title_state_json AS state,
          title_auto_renamed_at AS "renamedAt"
        FROM projection_threads
        ORDER BY thread_id
      `;
      assert.deepEqual(
        rows.map((row) => ({ ...row, state: JSON.parse(row.state) })),
        [
          {
            id: "generated",
            state: {
              source: "generated",
              version: "agent-thread-title:legacy",
              needsRefinement: false,
            },
            renamedAt: "2026-01-02T00:00:00.000Z",
          },
          {
            id: "manual",
            state: { source: "manual", version: "manual-rename", needsRefinement: false },
            renamedAt: null,
          },
        ],
      );
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("title-state reconciliation", (it) => {
  it.effect("preserves newer state-only events and JSON boolean types on repeated runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_source TEXT`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_auto_renamed_at TEXT`;
      yield* insertThread(sql, "refined", "Generated title", "automatic");
      yield* insertEvent(sql, {
        id: "title-event",
        threadId: "refined",
        sequence: 1,
        commandId: "initial-title",
        payload:
          '{"title":"Generated title","titleState":{"source":"generated","version":"initial-title","needsRefinement":true}}',
      });
      yield* insertEvent(sql, {
        id: "refine-event",
        threadId: "refined",
        sequence: 2,
        commandId: "refine-title",
        payload:
          '{"titleState":{"source":"generated","version":"refine-title","needsRefinement":false},"titleAutoRenamedAt":null}',
      });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
      yield* sql`
        UPDATE projection_threads
        SET title_state_json = '{"source":"generated","version":"refine-title","needsRefinement":false}'
        WHERE thread_id = 'refined'
      `;

      for (const _ of [1, 2]) {
        yield* reconcileTitleState;
      }

      const rows = yield* sql<{ readonly state: string; readonly booleanType: string }>`
        SELECT title_state_json AS state,
          json_type(title_state_json, '$.needsRefinement') AS "booleanType"
        FROM projection_threads WHERE thread_id = 'refined'
      `;
      assert.deepEqual(rows, [
        {
          state: '{"source":"generated","version":"refine-title","needsRefinement":false}',
          booleanType: "false",
        },
      ]);
    }),
  );
});
