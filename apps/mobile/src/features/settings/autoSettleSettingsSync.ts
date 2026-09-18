import type { EnvironmentId, ProjectId, ServerSettings } from "@t3tools/contracts";

export type AutoSettleSettings = Pick<
  ServerSettings,
  "sidebarAutoSettleAfterDays" | "sidebarAutoSettleOnMerge"
>;

const AUTOMATIC_TITLE_SETTING_KEYS = [
  "automaticThreadTitles",
  "automaticThreadTitleRenamePolicy",
  "automaticThreadTitleRenameMaxCount",
  "automaticThreadTitleRenameWindowHours",
  "automaticThreadTitleRenameMinAgeMinutes",
  "automaticThreadTitleRenameMinCompletedTurns",
  "automaticThreadTitleRenameCooldownMinutes",
  "automaticThreadTitleRenameMinFreshTurns",
  "automaticThreadTitleRenameRollingLimitEnabled",
] as const satisfies ReadonlyArray<keyof ServerSettings>;

export type AutomaticTitleSettings = Pick<
  ServerSettings,
  (typeof AUTOMATIC_TITLE_SETTING_KEYS)[number]
>;

interface AutoSettleSyncTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId | null;
  readonly label: string;
  readonly settings: AutoSettleSettings | null;
}

/** Receives connected, capable targets. Applying these defaults must preserve other settings. */
export function planAutoSettleSettingsSync(
  reference: {
    readonly environmentId: EnvironmentId;
    readonly projectId?: ProjectId | null;
    readonly settings: AutoSettleSettings;
  },
  targets: readonly AutoSettleSyncTarget[],
) {
  const patch: AutoSettleSettings = {
    sidebarAutoSettleAfterDays: reference.settings.sidebarAutoSettleAfterDays,
    sidebarAutoSettleOnMerge: reference.settings.sidebarAutoSettleOnMerge,
  };
  const mismatches = targets.filter(
    (target) =>
      (target.environmentId !== reference.environmentId ||
        target.projectId !== reference.projectId) &&
      target.settings !== null &&
      (target.settings.sidebarAutoSettleAfterDays !== patch.sidebarAutoSettleAfterDays ||
        target.settings.sidebarAutoSettleOnMerge !== patch.sidebarAutoSettleOnMerge),
  );
  return { patch, mismatches };
}

/** Keep automatic-title preferences aligned without touching unrelated environment settings. */
export function planAutomaticTitleSettingsSync(
  reference: { readonly environmentId: EnvironmentId; readonly settings: AutomaticTitleSettings },
  targets: readonly (AutoSettleSyncTarget & { readonly settings: ServerSettings | null })[],
) {
  const patch = Object.fromEntries(
    AUTOMATIC_TITLE_SETTING_KEYS.map((key) => [key, reference.settings[key]]),
  ) as AutomaticTitleSettings;
  const mismatches = targets.filter(
    (target) =>
      target.environmentId !== reference.environmentId &&
      target.settings !== null &&
      AUTOMATIC_TITLE_SETTING_KEYS.some((key) => target.settings?.[key] !== patch[key]),
  );
  return { patch, mismatches };
}
