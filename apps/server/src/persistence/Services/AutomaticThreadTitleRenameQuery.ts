import { IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface AutomaticThreadTitleRenameQueryShape {
  /** Count durable, successful agent title changes in the rolling window. */
  readonly countSince: (input: {
    readonly threadId: ThreadId;
    readonly since: IsoDateTime;
  }) => Effect.Effect<number, PersistenceSqlError>;
}

export class AutomaticThreadTitleRenameQuery extends Context.Service<
  AutomaticThreadTitleRenameQuery,
  AutomaticThreadTitleRenameQueryShape
>()("t3/persistence/Services/AutomaticThreadTitleRenameQuery") {}
