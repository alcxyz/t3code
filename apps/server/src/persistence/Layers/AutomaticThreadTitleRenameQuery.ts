import { IsoDateTime, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  AutomaticThreadTitleRenameQuery,
  type AutomaticThreadTitleRenameQueryShape,
} from "../Services/AutomaticThreadTitleRenameQuery.ts";

const InspectInput = Schema.Struct({
  threadId: ThreadId,
  rollingSince: Schema.NullOr(IsoDateTime),
  rollingMaximum: Schema.NullOr(NonNegativeInt),
});
const InspectionRow = Schema.Struct({
  createdAt: IsoDateTime,
  title: Schema.String,
  latestSuccessfulRenameAt: Schema.NullOr(IsoDateTime),
  completedTurns: NonNegativeInt,
  rollingCount: NonNegativeInt,
  rollingBoundaryRenameAt: Schema.NullOr(IsoDateTime),
});

const makeAutomaticThreadTitleRenameQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const inspectRow = SqlSchema.findOneOption({
    Request: InspectInput,
    Result: InspectionRow,
    execute: (input) => sql`
      WITH latest_rename AS (
        SELECT occurred_at
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${input.threadId}
          AND event_type = 'thread.meta-updated'
          AND command_id LIKE 'agent-thread-title:%'
          AND json_type(payload_json, '$.title') = 'text'
          AND (
            json_extract(payload_json, '$.titleState.source') = 'generated'
            OR json_extract(payload_json, '$.titleSource') = 'automatic'
          )
        ORDER BY sequence DESC
        LIMIT 1
      )
      SELECT
        thread.created_at AS "createdAt",
        thread.title,
        latest_rename.occurred_at AS "latestSuccessfulRenameAt",
        (
          SELECT COUNT(*)
          FROM projection_turns AS turn
          WHERE turn.thread_id = thread.thread_id
            AND turn.turn_id IS NOT NULL
            AND turn.state = 'completed'
            AND turn.completed_at IS NOT NULL
            AND (
              latest_rename.occurred_at IS NULL
              OR turn.started_at > latest_rename.occurred_at
            )
        ) AS "completedTurns",
        (
          SELECT COUNT(*)
          FROM orchestration_events AS rename
          WHERE rename.aggregate_kind = 'thread'
            AND rename.stream_id = thread.thread_id
            AND rename.event_type = 'thread.meta-updated'
            AND rename.command_id LIKE 'agent-thread-title:%'
            AND ${input.rollingSince} IS NOT NULL
            AND rename.occurred_at > ${input.rollingSince}
            AND json_type(rename.payload_json, '$.title') = 'text'
            AND (
              json_extract(rename.payload_json, '$.titleState.source') = 'generated'
              OR json_extract(rename.payload_json, '$.titleSource') = 'automatic'
            )
        ) AS "rollingCount",
        CASE
          WHEN ${input.rollingMaximum} IS NULL THEN NULL
          ELSE (
            SELECT rename.occurred_at
            FROM orchestration_events AS rename
            WHERE rename.aggregate_kind = 'thread'
              AND rename.stream_id = thread.thread_id
              AND rename.event_type = 'thread.meta-updated'
              AND rename.command_id LIKE 'agent-thread-title:%'
              AND ${input.rollingSince} IS NOT NULL
              AND rename.occurred_at > ${input.rollingSince}
              AND json_type(rename.payload_json, '$.title') = 'text'
              AND (
                json_extract(rename.payload_json, '$.titleState.source') = 'generated'
                OR json_extract(rename.payload_json, '$.titleSource') = 'automatic'
              )
            ORDER BY rename.occurred_at DESC, rename.sequence DESC
            LIMIT 1 OFFSET ${input.rollingMaximum === null ? 0 : input.rollingMaximum - 1}
          )
        END AS "rollingBoundaryRenameAt"
      FROM projection_threads AS thread
      LEFT JOIN latest_rename ON TRUE
      WHERE thread.thread_id = ${input.threadId}
      LIMIT 1
    `,
  });

  const inspect: AutomaticThreadTitleRenameQueryShape["inspect"] = (input) =>
    inspectRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomaticThreadTitleRenameQuery.inspect")),
    );

  return AutomaticThreadTitleRenameQuery.of({
    inspect,
  });
});

export const AutomaticThreadTitleRenameQueryLive = Layer.effect(
  AutomaticThreadTitleRenameQuery,
  makeAutomaticThreadTitleRenameQuery,
);
