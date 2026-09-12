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

const CountSinceInput = Schema.Struct({
  threadId: ThreadId,
  since: IsoDateTime,
});

const CountRow = Schema.Struct({ count: NonNegativeInt });

const makeAutomaticThreadTitleRenameQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const countSinceRow = SqlSchema.findOne({
    Request: CountSinceInput,
    Result: CountRow,
    execute: (input) => sql`
      SELECT COUNT(*) AS "count"
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${input.threadId}
        AND event_type = 'thread.meta-updated'
        AND command_id LIKE 'agent-thread-title:%'
        AND occurred_at > ${input.since}
        AND json_type(payload_json, '$.title') = 'text'
        AND json_extract(payload_json, '$.titleSource') = 'automatic'
    `,
  });

  const countSince: AutomaticThreadTitleRenameQueryShape["countSince"] = (input) =>
    countSinceRow(input).pipe(
      Effect.map((row) => row.count),
      Effect.mapError(toPersistenceSqlError("AutomaticThreadTitleRenameQuery.countSince")),
    );

  return AutomaticThreadTitleRenameQuery.of({ countSince });
});

export const AutomaticThreadTitleRenameQueryLive = Layer.effect(
  AutomaticThreadTitleRenameQuery,
  makeAutomaticThreadTitleRenameQuery,
);
