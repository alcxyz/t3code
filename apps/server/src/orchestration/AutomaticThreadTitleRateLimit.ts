import { type ServerSettings, type ThreadId } from "@t3tools/contracts";
import { resolveAutomaticThreadTitleRenameLimit } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import type { PersistenceSqlError } from "../persistence/Errors.ts";
import { AutomaticThreadTitleRenameQuery } from "../persistence/Services/AutomaticThreadTitleRenameQuery.ts";
import { DEFAULT_THREAD_TITLE } from "./threadTitles.ts";

export interface AutomaticThreadTitleRenameLimit {
  readonly maxCount: number;
  readonly windowHours: number;
  readonly minAgeMinutes: number;
  readonly minCompletedTurns: number;
}

export interface AutomaticThreadTitleRateLimitShape {
  readonly isAvailable: (
    threadId: ThreadId,
    limit: AutomaticThreadTitleRenameLimit,
  ) => Effect.Effect<boolean, PersistenceSqlError>;

  /** Hold the quota lock through a successful, durably persisted title write. */
  readonly withPermit: <A, E, R>(
    threadId: ThreadId,
    limit: AutomaticThreadTitleRenameLimit,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E | PersistenceSqlError, R>;
}

export class AutomaticThreadTitleRateLimit extends Context.Service<
  AutomaticThreadTitleRateLimit,
  AutomaticThreadTitleRateLimitShape
>()("t3/orchestration/AutomaticThreadTitleRateLimit") {}

const makeAutomaticThreadTitleRateLimit = Effect.gen(function* () {
  const query = yield* AutomaticThreadTitleRenameQuery;
  const lock = yield* Semaphore.make(1);

  const availableUnlocked = Effect.fn("AutomaticThreadTitleRateLimit.availableUnlocked")(function* (
    threadId: ThreadId,
    limit: AutomaticThreadTitleRenameLimit,
  ) {
    const now = yield* DateTime.now;
    const createdBefore = DateTime.formatIso(
      DateTime.subtract(now, { minutes: limit.minAgeMinutes }),
    );
    const meetsInitialEligibility = yield* query.meetsInitialEligibility({
      threadId,
      createdBefore,
      minCompletedTurns: limit.minCompletedTurns,
      excludedTitle: DEFAULT_THREAD_TITLE,
    });
    if (!meetsInitialEligibility) return false;

    const since = DateTime.formatIso(DateTime.subtract(now, { hours: limit.windowHours }));
    const count = yield* query.countSince({ threadId, since });
    return count < limit.maxCount;
  });

  const isAvailable: AutomaticThreadTitleRateLimitShape["isAvailable"] = (threadId, limit) =>
    lock.withPermits(1)(availableUnlocked(threadId, limit));

  const withPermit: AutomaticThreadTitleRateLimitShape["withPermit"] = (threadId, limit, effect) =>
    lock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (!(yield* availableUnlocked(threadId, limit))) return Option.none();
          return Option.some(yield* effect);
        }),
      ),
    );

  return AutomaticThreadTitleRateLimit.of({ isAvailable, withPermit });
});

export const AutomaticThreadTitleRateLimitLive = Layer.effect(
  AutomaticThreadTitleRateLimit,
  makeAutomaticThreadTitleRateLimit,
);

/** Server-authoritative gate used before exposing automatic rename instructions. */
export const hasAutomaticThreadTitleRenameQuota = Effect.fn("hasAutomaticThreadTitleRenameQuota")(
  function* (
    threadId: ThreadId,
    settings: Pick<
      ServerSettings,
      | "automaticThreadTitles"
      | "automaticThreadTitleRenamePolicy"
      | "automaticThreadTitleRenameMaxCount"
      | "automaticThreadTitleRenameWindowHours"
      | "automaticThreadTitleRenameMinAgeMinutes"
      | "automaticThreadTitleRenameMinCompletedTurns"
    >,
  ): Effect.fn.Return<boolean, PersistenceSqlError, AutomaticThreadTitleRateLimit> {
    if (!settings.automaticThreadTitles) return false;
    return yield* (yield* AutomaticThreadTitleRateLimit).isAvailable(
      threadId,
      resolveAutomaticThreadTitleRenameLimit(settings),
    );
  },
);
