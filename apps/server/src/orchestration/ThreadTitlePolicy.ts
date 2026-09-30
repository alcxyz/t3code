import type { OrchestrationThread } from "@t3tools/contracts";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";

type AutomaticTitleLifecycle = Pick<
  OrchestrationThread,
  "archivedAt" | "deletedAt" | "settledOverride" | "snoozedUntil"
>;

/** Whether the thread lifecycle permits an automatic title write at `now`. */
export function allowsAutomaticThreadTitleUpdate(
  thread: Omit<AutomaticTitleLifecycle, "deletedAt"> &
    Partial<Pick<AutomaticTitleLifecycle, "deletedAt">>,
  now: string,
): boolean {
  return (
    thread.archivedAt === null &&
    (thread.deletedAt === null || thread.deletedAt === undefined) &&
    thread.settledOverride !== "settled" &&
    (thread.snoozedUntil == null || compareDateTimeStrings(thread.snoozedUntil, now) <= 0)
  );
}
