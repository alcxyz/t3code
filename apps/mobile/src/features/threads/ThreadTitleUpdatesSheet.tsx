import type { OrchestrationGetTitleUpdatesResult } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SymbolView } from "../../components/AppSymbol";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { environmentServerConfigsAtom } from "../../state/server";

type ThreadTitleUpdatesSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

const STATUS_LABELS: Record<OrchestrationGetTitleUpdatesResult["status"], string> = {
  archived: "Archived",
  deleted: "Deleted",
  disabled: "Disabled",
  eligible: "Eligible",
  protected: "Protected",
  regenerating: "Regenerating",
  settled: "Settled",
  snoozed: "Snoozed",
  waiting: "Waiting",
};

const SOURCE_LABELS: Record<
  OrchestrationGetTitleUpdatesResult["history"][number]["source"],
  string
> = {
  automatic: "Automatic update",
  initial: "Initial title",
  manual: "Manual rename",
  refinement: "Automatic refinement",
  regeneration: "Regenerated",
  unknown: "Unknown",
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function eligibilityMessage(result: OrchestrationGetTitleUpdatesResult): string {
  switch (result.status) {
    case "eligible":
      return "Eligible now. The thread objective must change before an automatic title update can run.";
    case "waiting":
      return "Waiting for the time and activity requirements below.";
    case "disabled":
      return "Automatic title updates are disabled for this server.";
    case "protected":
      return "This title is protected from automatic updates.";
    case "archived":
      return "Archived threads are not eligible for automatic title updates.";
    case "deleted":
      return "Deleted threads are not eligible for automatic title updates.";
    case "snoozed":
      return "Snoozed threads are not eligible for automatic title updates.";
    case "settled":
      return "Settled threads are not eligible for automatic title updates.";
    case "regenerating":
      return "A title regeneration is currently in progress.";
  }
}

function DetailRow(props: {
  readonly label: string;
  readonly value: string;
  readonly last?: boolean;
}) {
  return (
    <View
      className={`min-h-11 flex-row items-center gap-4 px-4 py-2 ${
        props.last ? "" : "border-b border-border-subtle"
      }`}
    >
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <Text className="flex-1 text-right text-sm font-t3-medium text-foreground">
        {props.value}
      </Text>
    </View>
  );
}

export function ThreadTitleUpdatesSheet(props: ThreadTitleUpdatesSheetProps) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const supported =
    serverConfigs.get(environmentId)?.environment.capabilities.threadTitleUpdates === true;
  const query = useEnvironmentQuery(
    supported
      ? orchestrationEnvironment.titleUpdates({ environmentId, input: { threadId } })
      : null,
  );
  const result = query.data;

  return (
    <View className="flex-1 bg-sheet-solid">
      {Platform.OS === "android" ? (
        <AndroidSheetHeader
          title="Title updates"
          onBack={() => navigation.goBack()}
          actions={[
            {
              accessibilityLabel: "Refresh title updates",
              disabled: query.isPending,
              icon: "arrow.clockwise",
              onPress: query.refresh,
            },
          ]}
        />
      ) : null}

      <ScrollView
        contentContainerClassName="gap-5 px-4 pb-10 pt-4"
        refreshControl={
          <RefreshControl
            refreshing={query.isPending && result !== null}
            onRefresh={query.refresh}
          />
        }
      >
        {query.error ? <ErrorBanner message={query.error} /> : null}

        {result === null ? (
          <View className="items-center gap-3 rounded-2xl bg-card px-5 py-10">
            <SymbolView
              name="arrow.clockwise"
              size={22}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
            <Text className="text-center text-sm text-foreground-muted">
              {query.isPending
                ? "Checking title update status…"
                : supported
                  ? "Title update status unavailable."
                  : "Title update history is unavailable on this server."}
            </Text>
            {!query.isPending && supported ? (
              <Pressable
                accessibilityRole="button"
                className="min-h-11 justify-center rounded-xl bg-subtle px-4 active:opacity-60"
                onPress={query.refresh}
              >
                <Text className="font-t3-medium text-foreground">Try again</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <>
            <View className="gap-3 rounded-2xl bg-card px-4 py-4">
              <View className="flex-row items-start gap-3">
                <View className="min-w-0 flex-1 gap-1">
                  <Text className="text-xs font-t3-bold uppercase tracking-[1px] text-foreground-muted">
                    Current title
                  </Text>
                  <Text className="text-xl font-t3-bold text-foreground" selectable>
                    {result.currentTitle}
                  </Text>
                </View>
                <View className="rounded-full bg-subtle px-2.5 py-1">
                  <Text className="text-xs font-t3-bold text-foreground">
                    {STATUS_LABELS[result.status]}
                  </Text>
                </View>
              </View>
              <Text className="text-sm leading-5 text-foreground-secondary">
                {eligibilityMessage(result)}
              </Text>
              <Text className="text-xs text-foreground-muted">
                Checked by the server {formatDate(result.checkedAt)}
              </Text>
            </View>

            <View className="overflow-hidden rounded-2xl bg-card">
              <DetailRow
                label="Profile"
                value={result.profile[0]!.toUpperCase() + result.profile.slice(1)}
              />
              <DetailRow
                label="Phase"
                value={result.phase === "initial" ? "First automatic update" : "Recurring updates"}
              />
              <DetailRow
                label="Completed exchanges"
                value={`${result.completedTurns} of ${result.requiredTurns}`}
              />
              {result.rollingCount !== null && result.rollingMaximum !== null ? (
                <DetailRow
                  label="Rolling limit"
                  value={`${result.rollingCount} of ${result.rollingMaximum}${
                    result.rollingWindowHours === null ? "" : ` in ${result.rollingWindowHours}h`
                  }`}
                />
              ) : null}
              <DetailRow
                label="Time requirement"
                value={result.eligibleAt === null ? "—" : formatDate(result.eligibleAt)}
                last
              />
            </View>

            <View className="gap-2">
              <Text className="px-1 text-xs font-t3-bold uppercase tracking-[1px] text-foreground-muted">
                History
              </Text>
              {result.history.length === 0 ? (
                <View className="rounded-2xl bg-card px-4 py-5">
                  <Text className="text-sm text-foreground-muted">No title updates recorded.</Text>
                </View>
              ) : (
                <View className="overflow-hidden rounded-2xl bg-card">
                  {result.history.map((entry, index) => (
                    <View
                      key={entry.id}
                      className={`gap-1 px-4 py-3 ${
                        index === result.history.length - 1 ? "" : "border-b border-border-subtle"
                      }`}
                    >
                      <View className="flex-row items-center gap-3">
                        <Text className="flex-1 text-sm font-t3-medium text-foreground" selectable>
                          {entry.title}
                        </Text>
                        <Text className="text-xs text-foreground-muted">
                          {SOURCE_LABELS[entry.source]}
                        </Text>
                      </View>
                      {entry.previousTitle !== null ? (
                        <Text className="text-xs text-foreground-muted" selectable>
                          From {entry.previousTitle}
                        </Text>
                      ) : null}
                      <Text className="text-xs text-foreground-tertiary">
                        {formatDate(entry.at)}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
              {result.hasMore ? (
                <Text className="px-1 text-xs text-foreground-muted">
                  Older title changes are not included in this snapshot.
                </Text>
              ) : null}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
