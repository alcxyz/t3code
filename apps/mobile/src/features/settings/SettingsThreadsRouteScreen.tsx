import { AutoSettleDaysField } from "./components/AutoSettleDaysField";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  DEFAULT_SERVER_SETTINGS,
  MAX_AUTOMATIC_TITLE_RENAME_AGE_MINUTES,
  MAX_AUTOMATIC_TITLE_RENAME_COMPLETED_TURNS,
  MAX_AUTOMATIC_TITLE_RENAME_COUNT,
  MAX_AUTOMATIC_TITLE_RENAME_WINDOW_HOURS,
  MIN_AUTOMATIC_TITLE_RENAME_AGE_MINUTES,
  MIN_AUTOMATIC_TITLE_RENAME_COMPLETED_TURNS,
  MIN_AUTOMATIC_TITLE_RENAME_COUNT,
  MIN_AUTOMATIC_TITLE_RENAME_WINDOW_HOURS,
} from "@t3tools/contracts";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { resolveAutomaticThreadTitleRenameLimit } from "@t3tools/shared/serverSettings";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsProjectOverridesSection } from "./components/SettingsProjectOverridesSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { formatAutomaticTitleRenameLimitDescription } from "./SettingsRouteScreen.logic";
import {
  planAutomaticTitleSettingsSync,
  planAutoSettleSettingsSync,
  type AutomaticTitleSettings,
  type AutoSettleSettings,
} from "./autoSettleSettingsSync";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";

export function SettingsThreadsRouteScreen() {
  const insets = useSafeAreaInsets();

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Thread behavior" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <AutomaticTitleSettingsRows />
          <AutoSettleSettingsRows />
          <LegacySettingsSection />
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays ?? 3;
const AUTOMATIC_TITLE_POLICY_OPTIONS = [
  { value: "rare", label: "Rare", detail: "First 360m + 10 turns; then 120m + 3" },
  { value: "balanced", label: "Balanced", detail: "First 120m + 5 turns; then 45m + 2" },
  { value: "often", label: "Often", detail: "First 30m + 3 turns; then 15m + 1" },
  { value: "custom", label: "Custom", detail: "Set thresholds" },
] as const;

function AutomaticTitleNumberField(props: {
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly maximum: number;
  readonly minimum: number;
  readonly onValueChange: (value: number) => void;
  readonly value: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const nextDraft = (draft ?? "").trim();
    setDraft(null);
    const parsed = /^\d+$/.test(nextDraft) ? Number(nextDraft) : Number.NaN;
    if (
      Number.isInteger(parsed) &&
      parsed >= props.minimum &&
      parsed <= props.maximum &&
      parsed !== props.value
    ) {
      props.onValueChange(parsed);
    }
  };

  return (
    <TextInput
      accessibilityLabel={props.accessibilityLabel}
      className="min-h-10 w-20 rounded-xl bg-input px-3 py-2 text-center text-base text-foreground"
      editable={!props.disabled}
      keyboardType="number-pad"
      returnKeyType="done"
      value={draft ?? String(props.value)}
      onBlur={commit}
      onChangeText={setDraft}
      onSubmitEditing={commit}
    />
  );
}

/** Automatic-title preferences are shared by capable environments and are not project-scoped. */
function AutomaticTitleSettingsRows() {
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  const titleTargets = selectedTargets
    .filter(supportsSharedSettingsSync)
    .filter(
      (target) => target.serverConfig.environment.capabilities.automaticThreadTitles === true,
    );
  const reference = titleTargets[0] ?? null;
  const settings = reference?.serverConfig.settings ?? null;
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "server settings update",
    reportFailure: true,
  });

  if (reference === null || settings === null) return null;

  const projectSelected = selectedProjectKey !== null;
  const disabled = projectSelected || pendingWrites > 0;
  const writeToAll = (patch: Partial<AutomaticTitleSettings>) => {
    if (disabled || writeInFlight.current) return;
    writeInFlight.current = true;
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      titleTargets.map((target) =>
        updateSettings({ environmentId: target.environmentId, input: { patch } }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingWrites((count) => count - 1);
    });
  };

  const { patch, mismatches } = planAutomaticTitleSettingsSync(
    { environmentId: reference.environmentId, settings },
    titleTargets.map((target) => ({
      environmentId: target.environmentId,
      label: target.label,
      settings: target.serverConfig.settings,
    })),
  );
  const limit = resolveAutomaticThreadTitleRenameLimit(settings);

  return (
    <View className="gap-6">
      {projectSelected ? (
        <Text className="px-2 text-sm text-foreground-muted">
          Automatic titles are configured per environment. Choose All projects to edit them.
        </Text>
      ) : null}
      <SettingsSection title="Automatic titles">
        <SettingsSwitchRow
          icon="textformat.size"
          label="Keep thread titles up to date"
          subtitle="Agents update titles for meaningful objective changes. Snoozed, archived, and settled threads are skipped; manual titles stay protected."
          value={settings.automaticThreadTitles}
          disabled={disabled}
          onValueChange={(value) => writeToAll({ automaticThreadTitles: value })}
        />
        {settings.automaticThreadTitles ? (
          <View className="gap-3 border-t border-border-subtle p-4">
            <View className="gap-1">
              <Text className="text-base text-foreground">Automatic title update frequency</Text>
              <Text className="text-sm leading-normal text-foreground-muted">
                {formatAutomaticTitleRenameLimitDescription(limit)}
              </Text>
            </View>
            <View className="flex-row flex-wrap gap-2">
              {AUTOMATIC_TITLE_POLICY_OPTIONS.map((option) => {
                const selected = settings.automaticThreadTitleRenamePolicy === option.value;
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected, disabled }}
                    disabled={disabled}
                    onPress={() => writeToAll({ automaticThreadTitleRenamePolicy: option.value })}
                    className={cn(
                      "min-w-[46%] flex-1 rounded-xl px-3 py-2",
                      selected
                        ? "border-2 border-primary bg-subtle"
                        : "border border-border bg-card",
                      disabled && "opacity-50",
                    )}
                  >
                    <Text className="text-base text-foreground">{option.label}</Text>
                    <Text className="text-sm text-foreground-muted">{option.detail}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}
        {settings.automaticThreadTitles &&
        settings.automaticThreadTitleRenamePolicy === "custom" ? (
          <>
            <View className="gap-3 border-t border-border-subtle p-4">
              <View className="gap-1">
                <Text className="text-base text-foreground">First title eligibility</Text>
                <Text className="text-sm leading-normal text-foreground-muted">
                  Both the thread age and completed-turn thresholds must be met.
                </Text>
              </View>
              <View className="flex-row flex-wrap items-center gap-3">
                <AutomaticTitleNumberField
                  accessibilityLabel="Minimum thread age in minutes"
                  disabled={disabled}
                  value={settings.automaticThreadTitleRenameMinAgeMinutes}
                  minimum={MIN_AUTOMATIC_TITLE_RENAME_AGE_MINUTES}
                  maximum={MAX_AUTOMATIC_TITLE_RENAME_AGE_MINUTES}
                  onValueChange={(value) =>
                    writeToAll({ automaticThreadTitleRenameMinAgeMinutes: value })
                  }
                />
                <Text className="text-base text-foreground-muted">minutes old and</Text>
                <AutomaticTitleNumberField
                  accessibilityLabel="Minimum completed turns"
                  disabled={disabled}
                  value={settings.automaticThreadTitleRenameMinCompletedTurns}
                  minimum={MIN_AUTOMATIC_TITLE_RENAME_COMPLETED_TURNS}
                  maximum={MAX_AUTOMATIC_TITLE_RENAME_COMPLETED_TURNS}
                  onValueChange={(value) =>
                    writeToAll({ automaticThreadTitleRenameMinCompletedTurns: value })
                  }
                />
                <Text className="text-base text-foreground-muted">completed turns</Text>
              </View>
            </View>
            <View className="gap-3 border-t border-border-subtle p-4">
              <View className="gap-1">
                <Text className="text-base text-foreground">Recurring title eligibility</Text>
                <Text className="text-sm leading-normal text-foreground-muted">
                  Both requirements apply after each automatic update. New turns must start after
                  that update.
                </Text>
              </View>
              <View className="flex-row flex-wrap items-center gap-3">
                <AutomaticTitleNumberField
                  accessibilityLabel="Title update cooldown in minutes"
                  disabled={disabled}
                  value={settings.automaticThreadTitleRenameCooldownMinutes}
                  minimum={MIN_AUTOMATIC_TITLE_RENAME_AGE_MINUTES}
                  maximum={MAX_AUTOMATIC_TITLE_RENAME_AGE_MINUTES}
                  onValueChange={(value) =>
                    writeToAll({ automaticThreadTitleRenameCooldownMinutes: value })
                  }
                />
                <Text className="text-base text-foreground-muted">minutes and</Text>
                <AutomaticTitleNumberField
                  accessibilityLabel="Fresh completed turns"
                  disabled={disabled}
                  value={settings.automaticThreadTitleRenameMinFreshTurns}
                  minimum={MIN_AUTOMATIC_TITLE_RENAME_COMPLETED_TURNS}
                  maximum={MAX_AUTOMATIC_TITLE_RENAME_COMPLETED_TURNS}
                  onValueChange={(value) =>
                    writeToAll({ automaticThreadTitleRenameMinFreshTurns: value })
                  }
                />
                <Text className="text-base text-foreground-muted">new completed turns</Text>
              </View>
            </View>
            <SettingsSwitchRow
              icon="clock"
              label="Rolling title update limit"
              subtitle="Cap automatic updates within a rolling time window"
              value={settings.automaticThreadTitleRenameRollingLimitEnabled}
              disabled={disabled}
              onValueChange={(value) =>
                writeToAll({ automaticThreadTitleRenameRollingLimitEnabled: value })
              }
            />
            {settings.automaticThreadTitleRenameRollingLimitEnabled ? (
              <View className="gap-3 border-t border-border-subtle p-4">
                <Text className="text-base text-foreground">Rolling limit</Text>
                <View className="flex-row flex-wrap items-center gap-3">
                  <AutomaticTitleNumberField
                    accessibilityLabel="Automatic title update count"
                    disabled={disabled}
                    value={settings.automaticThreadTitleRenameMaxCount}
                    minimum={MIN_AUTOMATIC_TITLE_RENAME_COUNT}
                    maximum={MAX_AUTOMATIC_TITLE_RENAME_COUNT}
                    onValueChange={(value) =>
                      writeToAll({ automaticThreadTitleRenameMaxCount: value })
                    }
                  />
                  <Text className="text-base text-foreground-muted">updates per</Text>
                  <AutomaticTitleNumberField
                    accessibilityLabel="Automatic title update window in hours"
                    disabled={disabled}
                    value={settings.automaticThreadTitleRenameWindowHours}
                    minimum={MIN_AUTOMATIC_TITLE_RENAME_WINDOW_HOURS}
                    maximum={MAX_AUTOMATIC_TITLE_RENAME_WINDOW_HOURS}
                    onValueChange={(value) =>
                      writeToAll({ automaticThreadTitleRenameWindowHours: value })
                    }
                  />
                  <Text className="text-base text-foreground-muted">hours</Text>
                </View>
              </View>
            ) : null}
          </>
        ) : null}
      </SettingsSection>
      {!projectSelected && pendingWrites === 0 && mismatches.length > 0 ? (
        <SettingsSection title="Across environments">
          <View className="gap-3 p-4">
            <Text className="text-base text-foreground">Automatic title settings differ</Text>
            <Text className="text-sm text-foreground-muted">
              {mismatches.map((mismatch) => mismatch.label).join(", ")}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => writeToAll(patch)}
              className="self-start rounded-full bg-subtle px-4 py-2 active:opacity-70"
            >
              <Text className="text-sm font-t3-medium text-foreground">Apply to all</Text>
            </Pressable>
          </View>
        </SettingsSection>
      ) : null}
    </View>
  );
}

/**
 * Mobile edits auto-settle defaults across selected capable targets.
 */
function AutoSettleSettingsRows() {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const projectSelected = selectedProjectKey !== null;
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  const [pendingTargets, setPendingTargets] = useState<
    readonly ScopedMobileSettingsTarget[] | null
  >(null);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "server settings update",
    reportFailure: true,
  });

  const syncEnvironments = selectedTargets.filter(supportsSharedSettingsSync);
  const syncTargets = resolveMobileSettingsTargets(
    syncEnvironments,
    projectSelected ? (selectedProject?.members.map((member) => member.project) ?? []) : null,
  );
  const displayTargets =
    pendingWrites > 0 && pendingTargets !== null ? pendingTargets : syncTargets;
  const reference = displayTargets[0] ?? null;
  const referenceSettings = reference?.settings ?? null;

  if (reference === null || referenceSettings === null) {
    return null;
  }

  const writeToAll = (patch: Partial<AutoSettleSettings>) => {
    if (writeInFlight.current) return;
    const writes = planMobileScopedSettingsPatch(syncTargets, projectSelected, patch);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(syncTargets);
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({ environmentId: entry.environmentId, input: { patch: entry.patch } }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };

  const { patch: autoSettlePatch, mismatches } = planAutoSettleSettingsSync(
    {
      environmentId: reference.environment.environmentId,
      projectId: reference.projectId,
      settings: referenceSettings,
    },
    displayTargets.map((target) => ({
      environmentId: target.environment.environmentId,
      projectId: target.projectId,
      label: target.environment.label,
      settings: target.settings,
    })),
  );

  const supportsProjectOverrides = syncTargets.every(
    (target) =>
      target.environment.serverConfig.environment.capabilities.projectSettingsOverrides === true,
  );
  const disabled = pendingWrites > 0 || (projectSelected && !supportsProjectOverrides);
  const hasProjectOverrides =
    projectSelected &&
    syncTargets.some(
      (target) =>
        target.sources.sidebarAutoSettleOnMerge === "project" ||
        target.sources.sidebarAutoSettleAfterDays === "project",
    );
  const clearProjectOverrides = () => {
    if (writeInFlight.current) return;
    const writes = planMobileScopedSettingsClear(syncTargets, [
      "sidebarAutoSettleOnMerge",
      "sidebarAutoSettleAfterDays",
    ]);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(syncTargets);
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({ environmentId: entry.environmentId, input: { patch: entry.patch } }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };

  const afterDays = referenceSettings.sidebarAutoSettleAfterDays;

  return (
    <View className="gap-6">
      {projectSelected ? (
        <SettingsProjectOverridesSection
          projectLabel={selectedProject?.label ?? "Unavailable project"}
          hasOverrides={hasProjectOverrides}
          supportsOverrides={supportsProjectOverrides}
          pending={pendingWrites > 0}
          onClear={clearProjectOverrides}
        />
      ) : null}
      <SettingsSection title="Auto-settle">
        <SettingsSwitchRow
          icon="arrow.triangle.branch"
          label="Auto-settle merged threads"
          value={referenceSettings.sidebarAutoSettleOnMerge}
          disabled={disabled}
          onValueChange={(value) => writeToAll({ sidebarAutoSettleOnMerge: value })}
        />
        <SettingsSwitchRow
          icon="clock"
          label="Auto-settle inactive threads"
          value={afterDays !== null}
          disabled={disabled}
          onValueChange={(value) =>
            writeToAll({ sidebarAutoSettleAfterDays: value ? AUTO_SETTLE_DEFAULT_DAYS : null })
          }
        />
        {afterDays !== null ? (
          <View className="flex-row items-center gap-4 px-4 py-4 android:min-h-14 android:py-3">
            <View className="w-[22px] android:w-6" />
            <Text className="flex-1 text-foreground text-lg android:text-base">Inactive days</Text>
            <AutoSettleDaysField
              value={afterDays}
              disabled={disabled}
              onValueChange={(value) => writeToAll({ sidebarAutoSettleAfterDays: value })}
            />
          </View>
        ) : null}
      </SettingsSection>
      {pendingWrites === 0 && mismatches.length > 0 ? (
        <SettingsSection title="Across environments">
          <View className="gap-3 p-4">
            <Text className="text-base text-foreground">Auto-settle defaults differ</Text>
            <Text className="text-sm text-foreground-muted">
              {mismatches.map((mismatch) => mismatch.label).join(", ")}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => writeToAll(autoSettlePatch)}
              className="self-start rounded-full bg-subtle px-4 py-2 active:opacity-70"
            >
              <Text className="text-sm font-t3-medium text-foreground">
                Apply auto-settle defaults
              </Text>
            </Pressable>
          </View>
        </SettingsSection>
      ) : null}
    </View>
  );
}

/**
 * Device-local legacy toggles. Mobile has no client-settings sync, so this is
 * the counterpart of web's Settings → General → Legacy features backed by
 * mobile preferences.
 */
function LegacySettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const planModeEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.planModeEnabled === true;

  return (
    <View className="gap-3">
      <SettingsSection title="Legacy">
        <SettingsSwitchRow
          icon="hammer"
          label="Plan Mode"
          value={planModeEnabled}
          onValueChange={(value) => savePreferences({ planModeEnabled: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Opt into retired interfaces kept for compatibility. Plan Mode restores the Build/Plan
        control; otherwise every task runs in Build mode.
      </Text>
    </View>
  );
}
