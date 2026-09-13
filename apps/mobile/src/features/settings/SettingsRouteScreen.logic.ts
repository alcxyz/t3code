export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios" || platform === "android"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: "Unavailable on this platform" };
}

export function formatAutomaticTitleRenameLimitDescription(limit: {
  readonly minAgeMinutes: number;
  readonly minCompletedTurns: number;
  readonly cooldownMinutes: number;
  readonly minFreshTurns: number;
  readonly rollingLimit: { readonly maxCount: number; readonly windowHours: number } | null;
}): string {
  const firstTurnLabel = limit.minCompletedTurns === 1 ? "turn" : "turns";
  const freshTurnLabel = limit.minFreshTurns === 1 ? "turn" : "turns";
  const rollingDescription =
    limit.rollingLimit === null
      ? "No rolling limit."
      : `At most ${limit.rollingLimit.maxCount} updates per rolling ${limit.rollingLimit.windowHours}-hour window.`;
  return `First update: ${limit.minAgeMinutes} minutes old and ${limit.minCompletedTurns} completed ${firstTurnLabel}. Later updates: ${limit.cooldownMinutes} minutes and ${limit.minFreshTurns} new completed ${freshTurnLabel}. ${rollingDescription}`;
}
