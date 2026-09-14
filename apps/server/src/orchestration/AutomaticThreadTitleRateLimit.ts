import { type ServerSettings, type ThreadId } from "@t3tools/contracts";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import { resolveAutomaticThreadTitleRenameLimit } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RcMap from "effect/RcMap";
import * as Semaphore from "effect/Semaphore";

import type { PersistenceSqlError } from "../persistence/Errors.ts";
import { AutomaticThreadTitleRenameQuery } from "../persistence/Services/AutomaticThreadTitleRenameQuery.ts";
import { DEFAULT_THREAD_TITLE } from "./threadTitles.ts";

export interface AutomaticThreadTitleRenameLimit {
  readonly minAgeMinutes: number;
  readonly minCompletedTurns: number;
  readonly cooldownMinutes: number;
  readonly minFreshTurns: number;
}

export interface AutomaticThreadTitleRateLimitShape {
  readonly inspect: (
    threadId: ThreadId,
    limit: AutomaticThreadTitleRenameLimit,
  ) => Effect.Effect<Option.Option<AutomaticThreadTitleRateLimitInspection>, PersistenceSqlError>;

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

export interface AutomaticThreadTitleRateLimitInspection {
  readonly checkedAt: string;
  readonly phase: "initial" | "recurring";
  readonly eligibleAt: string | null;
  readonly completedTurns: number;
  readonly requiredTurns: number;
  readonly available: boolean;
}

export class AutomaticThreadTitleRateLimit extends Context.Service<
  AutomaticThreadTitleRateLimit,
  AutomaticThreadTitleRateLimitShape
>()("t3/orchestration/AutomaticThreadTitleRateLimit") {}

const makeAutomaticThreadTitleRateLimit = Effect.gen(function* () {
  const query = yield* AutomaticThreadTitleRenameQuery;
  const threadLocks = yield* RcMap.make({
    lookup: (_threadId: ThreadId) => Semaphore.make(1),
  });

  const withThreadLock = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.scoped(
      RcMap.get(threadLocks, threadId).pipe(
        Effect.flatMap((semaphore) => semaphore.withPermits(1)(effect)),
      ),
    );

  const inspectUnlocked = Effect.fn("AutomaticThreadTitleRateLimit.inspectUnlocked")(function* (
    threadId: ThreadId,
    limit: AutomaticThreadTitleRenameLimit,
  ) {
    const now = yield* DateTime.now;
    const checkedAt = DateTime.formatIso(now);
    const facts = yield* query.inspect({ threadId });
    if (Option.isNone(facts)) return Option.none<AutomaticThreadTitleRateLimitInspection>();

    const phase: AutomaticThreadTitleRateLimitInspection["phase"] =
      facts.value.latestSuccessfulRenameAt === null ? "initial" : "recurring";
    const requiredTurns = phase === "initial" ? limit.minCompletedTurns : limit.minFreshTurns;
    const baseAt =
      phase === "initial" ? facts.value.createdAt : facts.value.latestSuccessfulRenameAt!;
    const timeEligibleAt = DateTime.formatIso(
      DateTime.add(Option.getOrThrow(DateTime.make(baseAt)), {
        minutes: phase === "initial" ? limit.minAgeMinutes : limit.cooldownMinutes,
      }),
    );
    const enoughTurns = facts.value.completedTurns >= requiredTurns;
    const available =
      enoughTurns &&
      facts.value.title !== DEFAULT_THREAD_TITLE &&
      compareDateTimeStrings(timeEligibleAt, checkedAt) <= 0;

    return Option.some({
      checkedAt,
      phase,
      eligibleAt: timeEligibleAt,
      completedTurns: facts.value.completedTurns,
      requiredTurns,
      available,
    });
  });

  const inspect: AutomaticThreadTitleRateLimitShape["inspect"] = inspectUnlocked;

  const isAvailable: AutomaticThreadTitleRateLimitShape["isAvailable"] = (threadId, limit) =>
    inspect(threadId, limit).pipe(Effect.map(Option.exists((inspection) => inspection.available)));

  const withPermit: AutomaticThreadTitleRateLimitShape["withPermit"] = (threadId, limit, effect) =>
    withThreadLock(
      threadId,
      Effect.uninterruptible(
        Effect.gen(function* () {
          const inspection = yield* inspectUnlocked(threadId, limit);
          if (!Option.exists(inspection, (value) => value.available)) return Option.none();
          return Option.some(yield* effect);
        }),
      ),
    );

  return AutomaticThreadTitleRateLimit.of({ inspect, isAvailable, withPermit });
});

export const AutomaticThreadTitleRateLimitLive = Layer.effect(
  AutomaticThreadTitleRateLimit,
  makeAutomaticThreadTitleRateLimit,
);

/** Server-authoritative gate used before exposing automatic rename instructions. */
export const hasAutomaticThreadTitleRenameQuota = Effect.fn("hasAutomaticThreadTitleRenameQuota")(
  function* (
    threadId: ThreadId,
    settings: Pick<ServerSettings, "automaticThreadTitles" | "automaticThreadTitleRenamePolicy">,
  ): Effect.fn.Return<boolean, PersistenceSqlError, AutomaticThreadTitleRateLimit> {
    if (!settings.automaticThreadTitles) return false;
    return yield* (yield* AutomaticThreadTitleRateLimit).isAvailable(
      threadId,
      resolveAutomaticThreadTitleRenameLimit(settings),
    );
  },
);
