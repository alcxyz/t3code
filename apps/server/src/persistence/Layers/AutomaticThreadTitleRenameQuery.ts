import { IsoDateTime, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

const InitialEligibilityInput = Schema.Struct({
  threadId: ThreadId,
  createdBefore: IsoDateTime,
  minCompletedTurns: NonNegativeInt,
  excludedTitle: Schema.String,
});

const RecurringEligibilityInput = Schema.Struct({
  threadId: ThreadId,
  renamedAt: IsoDateTime,
  renamedBefore: IsoDateTime,
  minFreshTurns: NonNegativeInt,
  excludedTitle: Schema.String,
});

const EligibleThreadRow = Schema.Struct({ threadId: ThreadId });
const CountRow = Schema.Struct({ count: NonNegativeInt });
const RenameRow = Schema.Struct({ occurredAt: IsoDateTime });

const makeAutomaticThreadTitleRenameQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findInitiallyEligibleThread = SqlSchema.findOneOption({
    Request: InitialEligibilityInput,
    Result: EligibleThreadRow,
    execute: (input) => sql`
      SELECT thread.thread_id AS "threadId"
      FROM projection_threads AS thread
      WHERE thread.thread_id = ${input.threadId}
        AND thread.title <> ${input.excludedTitle}
        AND thread.created_at <= ${input.createdBefore}
        AND (
          SELECT COUNT(*)
          FROM projection_turns AS turn
          WHERE turn.thread_id = thread.thread_id
            AND turn.turn_id IS NOT NULL
            AND turn.state = 'completed'
            AND turn.completed_at IS NOT NULL
        ) >= ${input.minCompletedTurns}
      LIMIT 1
    `,
  });

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

  const findLatestSuccessfulRename = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: RenameRow,
    execute: (threadId) => sql`
      SELECT occurred_at AS "occurredAt"
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${threadId}
        AND event_type = 'thread.meta-updated'
        AND command_id LIKE 'agent-thread-title:%'
        AND json_type(payload_json, '$.title') = 'text'
        AND json_extract(payload_json, '$.titleSource') = 'automatic'
      ORDER BY sequence DESC
      LIMIT 1
    `,
  });

  const findRecurringEligibleThread = SqlSchema.findOneOption({
    Request: RecurringEligibilityInput,
    Result: EligibleThreadRow,
    execute: (input) => sql`
      SELECT thread.thread_id AS "threadId"
      FROM projection_threads AS thread
      WHERE thread.thread_id = ${input.threadId}
        AND thread.title <> ${input.excludedTitle}
        AND ${input.renamedAt} <= ${input.renamedBefore}
        AND (
          SELECT COUNT(*)
          FROM projection_turns AS turn
          WHERE turn.thread_id = thread.thread_id
            AND turn.turn_id IS NOT NULL
            AND turn.state = 'completed'
            AND turn.started_at > ${input.renamedAt}
            AND turn.completed_at IS NOT NULL
        ) >= ${input.minFreshTurns}
      LIMIT 1
    `,
  });

  const countSince: AutomaticThreadTitleRenameQueryShape["countSince"] = (input) =>
    countSinceRow(input).pipe(
      Effect.map((row) => row.count),
      Effect.mapError(toPersistenceSqlError("AutomaticThreadTitleRenameQuery.countSince")),
    );

  const meetsInitialEligibility: AutomaticThreadTitleRenameQueryShape["meetsInitialEligibility"] = (
    input,
  ) =>
    findInitiallyEligibleThread(input).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(
        toPersistenceSqlError("AutomaticThreadTitleRenameQuery.meetsInitialEligibility"),
      ),
    );

  const latestSuccessfulRenameAt: AutomaticThreadTitleRenameQueryShape["latestSuccessfulRenameAt"] =
    (threadId) =>
      findLatestSuccessfulRename(threadId).pipe(
        Effect.map(Option.map((row) => row.occurredAt)),
        Effect.mapError(
          toPersistenceSqlError("AutomaticThreadTitleRenameQuery.latestSuccessfulRenameAt"),
        ),
      );

  const meetsRecurringEligibility: AutomaticThreadTitleRenameQueryShape["meetsRecurringEligibility"] =
    (input) =>
      findRecurringEligibleThread(input).pipe(
        Effect.map(Option.isSome),
        Effect.mapError(
          toPersistenceSqlError("AutomaticThreadTitleRenameQuery.meetsRecurringEligibility"),
        ),
      );

  return AutomaticThreadTitleRenameQuery.of({
    meetsInitialEligibility,
    latestSuccessfulRenameAt,
    meetsRecurringEligibility,
    countSince,
  });
});

export const AutomaticThreadTitleRenameQueryLive = Layer.effect(
  AutomaticThreadTitleRenameQuery,
  makeAutomaticThreadTitleRenameQuery,
);
