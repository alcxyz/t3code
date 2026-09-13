import type { OrchestrationGetTitleUpdatesResult } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SymbolView } from "../../components/AppSymbol";
import { useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

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
      return "Updates only when the objective changes.";
    case "waiting":
      return "";
    case "disabled":
      return "Automatic title updates are disabled for this server.";
    case "protected":
      return "Protected title. Regenerate to resume automatic updates.";
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
  const thread = useThreadShell({ environmentId, threadId });
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const supported =
    serverConfigs.get(environmentId)?.environment.capabilities.threadTitleUpdates === true;
  const restorationSupported =
    serverConfigs.get(environmentId)?.environment.capabilities.threadTitleRestore === true;
  const query = useEnvironmentQuery(
    supported
      ? orchestrationEnvironment.titleUpdates({ environmentId, input: { threadId } })
      : null,
  );
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [titleAction, setTitleAction] = useState<"rename" | "regenerate" | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const regenerationSupported =
    serverConfigs.get(environmentId)?.environment.capabilities.threadTitleRegeneration === true;
  const regenerating = thread?.titleRegeneration != null || titleAction === "regenerate";
  const titleStamp = JSON.stringify([
    environmentId,
    threadId,
    thread?.title,
    thread?.titleState?.version,
    thread?.titleRegeneration?.requestId,
  ]);
  const lastTitleStamp = useRef(titleStamp);
  const refreshQuery = query.refresh;
  useEffect(() => {
    if (lastTitleStamp.current === titleStamp) return;
    lastTitleStamp.current = titleStamp;
    if (supported) refreshQuery();
  }, [titleStamp, supported, refreshQuery]);
  const restoreThreadTitle = useAtomCommand(threadEnvironment.restoreTitle, {
    reportFailure: false,
  });
  const [restoringTarget, setRestoringTarget] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const result = query.data;
  const titleBusy = titleAction !== null || restoringTarget !== null || regenerating;
  const currentTitle = thread?.title ?? result?.currentTitle ?? "";
  const canManageTitle = supported && thread !== null && result?.status !== "deleted";
  const changeTitle = async (action: "rename" | "regenerate") => {
    const title = draftTitle.trim();
    if (
      !canManageTitle ||
      titleBusy ||
      (action === "rename" && !title) ||
      (action === "regenerate" && !regenerationSupported)
    )
      return;
    if (action === "rename" && title === currentTitle) {
      setEditingTitle(false);
      return;
    }
    setTitleAction(action);
    setTitleError(null);
    const response = await updateMetadata({
      environmentId,
      input: { threadId, ...(action === "rename" ? { title } : { regenerateTitle: true }) },
    });
    if (response._tag === "Failure") {
      if (!isAtomCommandInterrupted(response)) {
        const error = squashAtomCommandFailure(response);
        setTitleError(error instanceof Error ? error.message : "The title could not be updated.");
      }
    } else {
      setEditingTitle(false);
    }
    setTitleAction(null);
    refreshQuery();
  };
  const canRestore =
    !regenerating &&
    titleAction === null &&
    !editingTitle &&
    restorationSupported &&
    result !== null &&
    result.currentVersion !== undefined &&
    result.status !== "deleted" &&
    result.status !== "regenerating";
  const hasRestorableHistoryTitle =
    canRestore && result.history.some((entry) => entry.title !== result.currentTitle);
  const restoreTitle = async (target: string, title: string) => {
    if (!canRestore || result === null || result.currentVersion === undefined) return;
    setRestoringTarget(target);
    setRestoreError(null);
    const response = await restoreThreadTitle({
      environmentId,
      input: { threadId, title, expectedVersion: result.currentVersion },
    });
    if (response._tag === "Failure" && !isAtomCommandInterrupted(response)) {
      const error = squashAtomCommandFailure(response);
      setRestoreError(
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The title could not be restored.",
      );
    }
    setRestoringTarget(null);
    query.refresh();
  };
  const refresh = () => {
    setRestoreError(null);
    query.refresh();
  };

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
              onPress: refresh,
            },
          ]}
        />
      ) : null}

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-5 px-4 pb-10 pt-4"
        refreshControl={
          <RefreshControl refreshing={query.isPending && result !== null} onRefresh={refresh} />
        }
      >
        {query.error ? <ErrorBanner message={query.error} /> : null}
        {restoreError !== null ? <ErrorBanner message={restoreError} /> : null}

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
                onPress={refresh}
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
                  <Text className="text-xl font-t3-bold text-foreground" selectable>
                    {currentTitle}
                  </Text>
                </View>
                <View className="rounded-full bg-subtle px-2.5 py-1">
                  <Text className="text-xs font-t3-bold text-foreground">
                    {STATUS_LABELS[result.status]}
                  </Text>
                </View>
              </View>
              {titleError ? <ErrorBanner message={titleError} /> : null}
              {canManageTitle ? (
                editingTitle ? (
                  <View className="gap-2">
                    <TextInput
                      accessibilityLabel="Thread title"
                      autoFocus
                      value={draftTitle}
                      onChangeText={setDraftTitle}
                      editable={!titleBusy}
                      onSubmitEditing={() => void changeTitle("rename")}
                      returnKeyType="done"
                      className="min-h-11 rounded-xl border border-border-subtle bg-subtle px-3 text-foreground"
                    />
                    <View className="flex-row gap-2">
                      <Pressable
                        accessibilityRole="button"
                        disabled={titleBusy || !draftTitle.trim()}
                        onPress={() => void changeTitle("rename")}
                        className="min-h-11 justify-center rounded-xl bg-subtle px-4 disabled:opacity-40"
                      >
                        <Text className="font-t3-medium text-foreground">
                          {titleAction === "rename" ? "Saving…" : "Save"}
                        </Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        disabled={titleBusy}
                        onPress={() => setEditingTitle(false)}
                        className="min-h-11 justify-center rounded-xl px-4 disabled:opacity-40"
                      >
                        <Text className="text-foreground">Cancel</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <View className="flex-row flex-wrap gap-2">
                    <Pressable
                      accessibilityRole="button"
                      disabled={titleBusy}
                      onPress={() => {
                        setDraftTitle(currentTitle);
                        setTitleError(null);
                        setEditingTitle(true);
                      }}
                      className="min-h-11 flex-row items-center gap-2 rounded-xl bg-subtle px-3 disabled:opacity-40"
                    >
                      <SymbolView
                        name="pencil"
                        size={16}
                        tintColorClassName="accent-icon-muted"
                        type="monochrome"
                      />
                      <Text className="font-t3-medium text-foreground">Rename thread</Text>
                    </Pressable>
                    {regenerationSupported ? (
                      <Pressable
                        accessibilityRole="button"
                        disabled={titleBusy}
                        onPress={() => void changeTitle("regenerate")}
                        className="min-h-11 flex-row items-center gap-2 rounded-xl bg-subtle px-3 disabled:opacity-40"
                      >
                        {regenerating ? (
                          <ActivityIndicator colorClassName="accent-icon-muted" size="small" />
                        ) : (
                          <SymbolView
                            name="arrow.clockwise"
                            size={16}
                            tintColorClassName="accent-icon-muted"
                            type="monochrome"
                          />
                        )}
                        <Text className="font-t3-medium text-foreground">
                          {regenerating ? "Regenerating…" : "Regenerate title"}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                )
              ) : null}
              {eligibilityMessage(result) ? (
                <Text className="text-sm leading-5 text-foreground-secondary">
                  {eligibilityMessage(result)}
                </Text>
              ) : null}
              {canRestore && result.undoTitle != null ? (
                <View className="mt-1 gap-2 rounded-xl bg-subtle px-3 py-3">
                  <Text className="text-sm text-foreground-secondary">
                    Restore “<Text className="font-t3-medium">{result.undoTitle}</Text>”
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    className="min-h-11 flex-row items-center justify-center gap-2 rounded-xl bg-card px-4 active:opacity-60 disabled:opacity-40"
                    disabled={restoringTarget !== null || query.isPending}
                    onPress={() => void restoreTitle("undo", result.undoTitle!)}
                  >
                    {restoringTarget === "undo" ? (
                      <ActivityIndicator colorClassName="accent-icon-muted" size="small" />
                    ) : (
                      <SymbolView
                        name="arrow.uturn.backward"
                        size={17}
                        tintColorClassName="accent-icon-muted"
                        type="monochrome"
                      />
                    )}
                    <Text className="font-t3-medium text-foreground">Undo rename</Text>
                  </Pressable>
                  <Text className="text-xs leading-4 text-foreground-muted">
                    Restoring protects this title from automatic changes.
                  </Text>
                </View>
              ) : null}
            </View>

            <View className="overflow-hidden rounded-2xl bg-card">
              <DetailRow
                label="Profile"
                value={result.profile[0]!.toUpperCase() + result.profile.slice(1)}
              />
              <DetailRow
                label={result.phase === "initial" ? "Completed exchanges" : "Fresh exchanges"}
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
              {hasRestorableHistoryTitle && result.undoTitle == null ? (
                <Text className="px-1 text-xs leading-4 text-foreground-muted">
                  Restoring protects the chosen title from automatic changes.
                </Text>
              ) : null}
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
                          {entry.isRestoration === true ? "Restored" : SOURCE_LABELS[entry.source]}
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
                      {canRestore && entry.title !== result.currentTitle ? (
                        <Pressable
                          accessibilityRole="button"
                          className="mt-1 min-h-11 flex-row items-center justify-center gap-2 self-start rounded-xl bg-subtle px-3 active:opacity-60 disabled:opacity-40"
                          disabled={restoringTarget !== null || query.isPending}
                          onPress={() => void restoreTitle(entry.id, entry.title)}
                        >
                          {restoringTarget === entry.id ? (
                            <ActivityIndicator colorClassName="accent-icon-muted" size="small" />
                          ) : null}
                          <Text className="text-sm font-t3-medium text-foreground">
                            Restore this title
                          </Text>
                        </Pressable>
                      ) : null}
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
