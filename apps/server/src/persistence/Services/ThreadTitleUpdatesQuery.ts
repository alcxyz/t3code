import type { CommandId, OrchestrationGetTitleUpdatesResult, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { PersistenceSqlError } from "../Errors.ts";

export interface ThreadTitleUpdatesRecord {
  readonly title: string;
  readonly titleSource: "generated" | "manual" | null;
  readonly titleVersion: CommandId | null;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly snoozedUntil: string | null;
  readonly titleRegenerationRequestId: string | null;
  readonly history: OrchestrationGetTitleUpdatesResult["history"];
  readonly hasMore: boolean;
}

export interface ThreadTitleUpdatesQueryShape {
  /** Load one thread's lifecycle facts and at most 50 real title changes. */
  readonly get: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ThreadTitleUpdatesRecord>, PersistenceSqlError>;
}

export class ThreadTitleUpdatesQuery extends Context.Service<
  ThreadTitleUpdatesQuery,
  ThreadTitleUpdatesQueryShape
>()("t3/persistence/Services/ThreadTitleUpdatesQuery") {}
