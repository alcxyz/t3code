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
    readonly eventType?: "thread.created" | "thread.meta-updated" | "thread.message-sent";
    readonly actorKind?: "client" | "provider" | "server";
  },
) =>
  sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, command_id, actor_kind, payload_json, metadata_json
    ) VALUES (
      ${input.id}, 'thread', ${input.threadId}, ${input.sequence},
      ${input.eventType ?? "thread.meta-updated"},
      '2026-01-01T00:00:00.000Z', ${input.commandId}, ${input.actorKind ?? "server"},
      ${input.payload}, '{}'
    )
  `;

it.layer(NodeSqliteClient.layerMemory())("fork title-state compatibility", (it) => {
  it.effect("keeps the shared migration ledger at 49 and upgrades legacy ownership", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (50, 'ProjectionThreadTitleState')
      `;
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

it.layer(NodeSqliteClient.layerMemory())("fork migration ledger compatibility", (it) => {
  it.effect("leaves migration 50 alone when its provenance does not match", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (50, 'UnrelatedUpstreamMigration')
      `;

      yield* runMigrations();

      const migrations = yield* sql<{ readonly id: number; readonly name: string }>`
        SELECT migration_id AS id, name
        FROM effect_sql_migrations
        ORDER BY migration_id DESC
        LIMIT 1
      `;
      assert.deepEqual(migrations, [{ id: 50, name: "UnrelatedUpstreamMigration" }]);
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

it.layer(NodeSqliteClient.layerMemory())("native database title-state compatibility", (it) => {
  it.effect("folds upstream edits without a legacy source column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at, title_state_json, title_auto_renamed_at
        ) VALUES (
          'native-roundtrip', 'project-1', 'Generated title',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          '{"source":"generated","version":"generated-command","needsRefinement":false}',
          '2026-01-02T00:00:00.000Z'
        )
      `;
      yield* insertEvent(sql, {
        id: "generated-event",
        threadId: "native-roundtrip",
        sequence: 1,
        commandId: "generated-command",
        payload:
          '{"title":"Generated title","titleState":{"source":"generated","version":"generated-command","needsRefinement":false},"titleAutoRenamedAt":"2026-01-02T00:00:00.000Z"}',
      });
      yield* reconcileTitleState;

      // An older upstream build changes the title without the fork's ownership
      // state, then clears the automatic-rename badge in a later event.
      yield* sql`
        UPDATE projection_threads
        SET title = 'Upstream manual title'
        WHERE thread_id = 'native-roundtrip'
      `;
      yield* insertEvent(sql, {
        id: "manual-event",
        threadId: "native-roundtrip",
        sequence: 2,
        commandId: "manual-command",
        actorKind: "client",
        payload: '{"title":"Upstream manual title"}',
      });
      yield* insertEvent(sql, {
        id: "badge-clear-event",
        threadId: "native-roundtrip",
        sequence: 3,
        commandId: "badge-clear-command",
        payload: '{"titleAutoRenamedAt":null}',
      });

      for (const _ of [1, 2]) {
        yield* runMigrations();
      }

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(!columns.some((column) => column.name === "title_source"));
      const rows = yield* sql<{
        readonly state: string;
        readonly renamedAt: string | null;
      }>`
        SELECT title_state_json AS state,
          title_auto_renamed_at AS "renamedAt"
        FROM projection_threads
        WHERE thread_id = 'native-roundtrip'
      `;
      assert.deepEqual(
        rows.map((row) => ({ ...row, state: JSON.parse(row.state) })),
        [
          {
            state: {
              source: "manual",
              version: "manual-command",
              needsRefinement: false,
            },
            renamedAt: null,
          },
        ],
      );
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("native title-state compatibility", (it) => {
  it.effect(
    "keeps native default ownership and only repairs the exact creation-derived state",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 49 });
        yield* sql`ALTER TABLE projection_threads ADD COLUMN title_source TEXT`;
        yield* sql`ALTER TABLE projection_threads ADD COLUMN title_auto_renamed_at TEXT`;
        yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;

        for (const id of ["corrupted", "manual"] as const) {
          yield* insertThread(sql, id, "New thread", "user");
          yield* insertEvent(sql, {
            id: `${id}-created-event`,
            threadId: id,
            sequence: 1,
            commandId: `${id}-creation-command`,
            eventType: "thread.created",
            actorKind: "client",
            payload: '{"title":"New thread"}',
          });
        }

        yield* sql`
        UPDATE projection_threads
        SET title_state_json = json_object(
          'source', 'manual',
          'version', thread_id || '-creation-command',
          'needsRefinement', json('false')
        )
        WHERE thread_id IN ('corrupted', 'manual')
      `;
        yield* insertEvent(sql, {
          id: "manual-title-event",
          threadId: "manual",
          sequence: 2,
          commandId: "manual-title-command",
          actorKind: "client",
          payload:
            '{"title":"New thread","titleState":{"source":"manual","version":"manual-title-command","needsRefinement":false}}',
        });
        yield* sql`
        UPDATE projection_threads
        SET title_state_json =
          '{"source":"manual","version":"manual-title-command","needsRefinement":false}'
        WHERE thread_id = 'manual'
      `;

        yield* reconcileTitleState;
        yield* insertThread(sql, "native", "New thread", "user");
        yield* insertEvent(sql, {
          id: "native-created-event",
          threadId: "native",
          sequence: 1,
          commandId: "native-creation-command",
          eventType: "thread.created",
          actorKind: "client",
          payload: '{"title":"New thread"}',
        });
        yield* reconcileTitleState;

        const checkpointBeforeRollback = yield* sql<{
          readonly lastEventSequence: number;
        }>`
          SELECT last_event_sequence AS "lastEventSequence"
          FROM fork_projection_thread_title_source_state
        `;
        // Simulate returning from the prior broken fork after it rewrote an
        // already-watermarked native creation without appending an event.
        yield* sql`
          UPDATE projection_threads
          SET title_state_json =
            '{"source":"manual","version":"native-creation-command","needsRefinement":false}'
          WHERE thread_id = 'native'
        `;
        yield* reconcileTitleState;
        const checkpointAfterRollback = yield* sql<{
          readonly lastEventSequence: number;
        }>`
          SELECT last_event_sequence AS "lastEventSequence"
          FROM fork_projection_thread_title_source_state
        `;
        assert.deepEqual(checkpointAfterRollback, checkpointBeforeRollback);

        const rows = yield* sql<{ readonly id: string; readonly state: string | null }>`
        SELECT thread_id AS id, title_state_json AS state
        FROM projection_threads
        ORDER BY thread_id
      `;
        assert.deepEqual(rows, [
          { id: "corrupted", state: null },
          {
            id: "manual",
            state: '{"source":"manual","version":"manual-title-command","needsRefinement":false}',
          },
          { id: "native", state: null },
        ]);
      }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("incremental title-state reconciliation", (it) => {
  it.effect("returns at the watermark and reconciles only threads changed upstream", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_source TEXT`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_auto_renamed_at TEXT`;

      yield* insertThread(sql, "changed", "Generated title", "automatic");
      yield* insertThread(sql, "legacy-changed", "Legacy generated title", "automatic");
      yield* insertThread(sql, "native-clear", "Native generated title", "automatic");
      yield* insertThread(sql, "provider-changed", "New thread", "automatic");
      yield* insertThread(sql, "unchanged", "Other generated title", "automatic");
      yield* insertEvent(sql, {
        id: "changed-generated-event",
        threadId: "changed",
        sequence: 1,
        commandId: "changed-generated-command",
        payload:
          '{"title":"Generated title","titleSource":"automatic","titleAutoRenamedAt":"2026-01-02T00:00:00.000Z"}',
      });
      yield* insertEvent(sql, {
        id: "legacy-changed-generated-event",
        threadId: "legacy-changed",
        sequence: 1,
        commandId: "legacy-changed-generated-command",
        payload:
          '{"title":"Legacy generated title","titleSource":"automatic","titleAutoRenamedAt":"2026-01-02T00:00:00.000Z"}',
      });
      yield* insertEvent(sql, {
        id: "native-clear-generated-event",
        threadId: "native-clear",
        sequence: 1,
        commandId: "native-clear-generated-command",
        payload:
          '{"title":"Native generated title","titleState":{"source":"generated","version":"native-clear-generated-command","needsRefinement":false},"titleAutoRenamedAt":"2026-01-02T00:00:00.000Z"}',
      });
      yield* insertEvent(sql, {
        id: "provider-created-event",
        threadId: "provider-changed",
        sequence: 1,
        commandId: "provider-creation-command",
        eventType: "thread.created",
        actorKind: "client",
        payload: '{"title":"New thread"}',
      });
      yield* insertEvent(sql, {
        id: "unchanged-generated-event",
        threadId: "unchanged",
        sequence: 1,
        commandId: "unchanged-generated-command",
        payload:
          '{"title":"Other generated title","titleSource":"automatic","titleAutoRenamedAt":"2026-01-02T00:00:00.000Z"}',
      });

      yield* reconcileTitleState;
      yield* sql`
        CREATE TABLE reconciliation_writes (
          thread_id TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE TRIGGER count_title_reconciliation_writes
        AFTER UPDATE OF title_state_json, title_auto_renamed_at ON projection_threads
        BEGIN
          INSERT INTO reconciliation_writes (thread_id) VALUES (NEW.thread_id);
        END
      `;

      yield* reconcileTitleState;
      assert.deepEqual(yield* sql`SELECT * FROM reconciliation_writes`, []);

      // Simulate an upstream build applying a title but not this fork's legacy
      // ownership fields, followed by a native state-only refinement event.
      yield* sql`
        UPDATE projection_threads
        SET title = 'Upstream manual title',
          title_state_json =
            '{"source":"generated","version":"native-refinement","needsRefinement":false}'
        WHERE thread_id = 'changed'
      `;
      yield* sql`
        UPDATE projection_threads
        SET title = 'Older fork manual title'
        WHERE thread_id = 'legacy-changed'
      `;
      yield* sql`
        UPDATE projection_threads
        SET title = 'Provider supplied title'
        WHERE thread_id = 'provider-changed'
      `;
      yield* sql`DELETE FROM reconciliation_writes`;
      yield* insertEvent(sql, {
        id: "upstream-title-event",
        threadId: "changed",
        sequence: 2,
        commandId: "upstream-title-command",
        actorKind: "client",
        payload: '{"title":"Upstream manual title"}',
      });
      yield* insertEvent(sql, {
        id: "older-fork-title-event",
        threadId: "legacy-changed",
        sequence: 2,
        commandId: "older-fork-title-command",
        actorKind: "client",
        payload: '{"title":"Older fork manual title"}',
      });
      yield* insertEvent(sql, {
        id: "provider-title-event",
        threadId: "provider-changed",
        sequence: 2,
        commandId: "provider:native-event:thread-meta-update:uuid",
        actorKind: "provider",
        payload: '{"title":"Provider supplied title"}',
      });
      yield* insertEvent(sql, {
        id: "native-refinement-event",
        threadId: "changed",
        sequence: 3,
        commandId: "native-refinement",
        payload:
          '{"titleState":{"source":"generated","version":"native-refinement","needsRefinement":false},"titleAutoRenamedAt":null}',
      });
      yield* insertEvent(sql, {
        id: "native-clear-event",
        threadId: "native-clear",
        sequence: 2,
        commandId: "native-clear-command",
        payload: '{"titleState":null,"titleAutoRenamedAt":null}',
      });

      yield* reconcileTitleState;

      const rows = yield* sql<{
        readonly id: string;
        readonly state: string | null;
        readonly renamedAt: string | null;
      }>`
        SELECT thread_id AS id, title_state_json AS state,
          title_auto_renamed_at AS "renamedAt"
        FROM projection_threads
        ORDER BY thread_id
      `;
      assert.deepEqual(
        rows.map((row) => ({
          ...row,
          state: row.state === null ? null : JSON.parse(row.state),
        })),
        [
          {
            id: "changed",
            state: {
              source: "generated",
              version: "native-refinement",
              needsRefinement: false,
            },
            renamedAt: null,
          },
          {
            id: "legacy-changed",
            state: {
              source: "manual",
              version: "older-fork-title-command",
              needsRefinement: false,
            },
            renamedAt: null,
          },
          {
            id: "native-clear",
            state: null,
            renamedAt: null,
          },
          {
            id: "provider-changed",
            state: {
              source: "generated",
              version: "provider:native-event:thread-meta-update:uuid",
              needsRefinement: false,
            },
            renamedAt: null,
          },
          {
            id: "unchanged",
            state: {
              source: "generated",
              version: "unchanged-generated-command",
              needsRefinement: false,
            },
            renamedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      );
      const writes = yield* sql<{ readonly threadId: string }>`
        SELECT DISTINCT thread_id AS "threadId" FROM reconciliation_writes ORDER BY thread_id
      `;
      assert.deepEqual(writes, [
        { threadId: "changed" },
        { threadId: "legacy-changed" },
        { threadId: "native-clear" },
        { threadId: "provider-changed" },
      ]);

      const checkpoints = yield* sql<{ readonly lastEventSequence: number }>`
        SELECT last_event_sequence AS "lastEventSequence"
        FROM fork_projection_thread_title_source_state
      `;
      const maxima = yield* sql<{ readonly lastEventSequence: number }>`
        SELECT MAX(sequence) AS "lastEventSequence" FROM orchestration_events
      `;
      assert.deepEqual(checkpoints, maxima);
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("transactional title-state reconciliation", (it) => {
  it.effect("retries events when a reconciliation transaction fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_source TEXT`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_auto_renamed_at TEXT`;
      yield* insertThread(sql, "retry", "Generated title", "automatic");
      yield* insertEvent(sql, {
        id: "retry-generated-event",
        threadId: "retry",
        sequence: 1,
        commandId: "retry-generated-command",
        payload: '{"title":"Generated title","titleSource":"automatic"}',
      });
      yield* reconcileTitleState;

      const before = yield* sql<{ readonly lastEventSequence: number }>`
        SELECT last_event_sequence AS "lastEventSequence"
        FROM fork_projection_thread_title_source_state
      `;
      yield* sql`UPDATE projection_threads SET title = 'Upstream title' WHERE thread_id = 'retry'`;
      yield* insertEvent(sql, {
        id: "retry-upstream-event",
        threadId: "retry",
        sequence: 2,
        commandId: "retry-upstream-command",
        actorKind: "client",
        payload: '{"title":"Upstream title"}',
      });
      yield* sql`
        CREATE TRIGGER fail_title_state_reconciliation
        BEFORE UPDATE OF title_state_json ON projection_threads
        WHEN NEW.thread_id = 'retry'
        BEGIN
          SELECT RAISE(ABORT, 'intentional reconciliation failure');
        END
      `;

      yield* reconcileTitleState.pipe(Effect.flip);
      const afterFailure = yield* sql<{ readonly lastEventSequence: number }>`
        SELECT last_event_sequence AS "lastEventSequence"
        FROM fork_projection_thread_title_source_state
      `;
      assert.deepEqual(afterFailure, before);

      yield* sql`DROP TRIGGER fail_title_state_reconciliation`;
      yield* reconcileTitleState;

      const rows = yield* sql<{ readonly state: string }>`
        SELECT title_state_json AS state FROM projection_threads WHERE thread_id = 'retry'
      `;
      assert.deepEqual(
        rows.map((row) => JSON.parse(row.state)),
        [
          {
            source: "manual",
            version: "retry-upstream-command",
            needsRefinement: false,
          },
        ],
      );
      const checkpoint = yield* sql<{ readonly lastEventSequence: number }>`
        SELECT last_event_sequence AS "lastEventSequence"
        FROM fork_projection_thread_title_source_state
      `;
      const maximum = yield* sql<{ readonly lastEventSequence: number }>`
        SELECT MAX(sequence) AS "lastEventSequence" FROM orchestration_events
      `;
      assert.deepEqual(checkpoint, maximum);
    }),
  );
});
