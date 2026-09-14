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
}): string {
  const firstTurnLabel = limit.minCompletedTurns === 1 ? "turn" : "turns";
  const freshTurnLabel = limit.minFreshTurns === 1 ? "turn" : "turns";
  return `First update: ${limit.minAgeMinutes} minutes old and ${limit.minCompletedTurns} completed ${firstTurnLabel}. Later updates: ${limit.cooldownMinutes} minutes and ${limit.minFreshTurns} new completed ${freshTurnLabel}.`;
}
