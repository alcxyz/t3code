import { IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { PersistenceSqlError } from "../Errors.ts";

export interface AutomaticThreadTitleRenameQueryShape {
  /** Facts used by the authoritative quota inspection for one thread. */
  readonly inspect: (input: { readonly threadId: ThreadId }) => Effect.Effect<
    Option.Option<{
      readonly createdAt: IsoDateTime;
      readonly title: string;
      readonly latestSuccessfulRenameAt: IsoDateTime | null;
      readonly completedTurns: number;
    }>,
    PersistenceSqlError
  >;
}

export class AutomaticThreadTitleRenameQuery extends Context.Service<
  AutomaticThreadTitleRenameQuery,
  AutomaticThreadTitleRenameQueryShape
>()("t3/persistence/Services/AutomaticThreadTitleRenameQuery") {}
