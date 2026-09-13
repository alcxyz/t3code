import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OrchestrationGetTitleUpdatesResult,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { SparklesIcon, Undo2Icon } from "lucide-react";
import { useState } from "react";

import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { environmentServerConfigsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  closeThreadTitleUpdates,
  useThreadTitleUpdatesPanelStore,
} from "~/threadTitleUpdatesPanel";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { RefreshIcon } from "./ui/refresh-icon";
import { Spinner } from "./ui/spinner";

const PROFILE_LABELS = {
  rare: "Rare",
  balanced: "Balanced",
  often: "Often",
  custom: "Custom",
} as const;

const STATUS_LABELS = {
  disabled: "Disabled",
  protected: "Protected",
  archived: "Archived",
  deleted: "Deleted",
  snoozed: "Snoozed",
  settled: "Settled",
  regenerating: "Regenerating",
  waiting: "Waiting",
  eligible: "Eligible",
} as const;

const SOURCE_LABELS = {
  initial: "Initial title",
  refinement: "Refinement",
  manual: "Manual rename",
  regeneration: "Regenerated",
  automatic: "Automatic update",
  unknown: "Unknown source",
} as const;

type TitleUpdatesResult = OrchestrationGetTitleUpdatesResult;

function formatDate(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function statusReason(status: keyof typeof STATUS_LABELS): string {
  switch (status) {
    case "disabled":
      return "Automatic title updates are disabled for this environment.";
    case "protected":
      return "This thread is protected from automatic title changes.";
    case "archived":
      return "Archived threads do not receive automatic title updates.";
    case "deleted":
      return "This thread is no longer available.";
    case "snoozed":
      return "Snoozed threads wait until they are active again.";
    case "settled":
      return "Settled threads wait until they are reopened.";
    case "regenerating":
      return "A title regeneration request is already running.";
    case "waiting":
      return "Waiting for the time and activity requirements below.";
    case "eligible":
      return "Eligible—updates only when the thread objective meaningfully changes.";
  }
}

function SourceBadge({ entry }: { readonly entry: TitleUpdatesResult["history"][number] }) {
  return (
    <span className="rounded-sm border border-border/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {entry.isRestoration === true ? "Restored" : SOURCE_LABELS[entry.source]}
    </span>
  );
}

function TitleUpdatesContent({
  environmentId,
  restorationSupported,
  threadRef,
}: {
  readonly environmentId: EnvironmentId;
  readonly restorationSupported: boolean;
  readonly threadRef: ScopedThreadRef;
}) {
  const query = useEnvironmentQuery(
    orchestrationEnvironment.titleUpdates({
      environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const restoreThreadTitle = useAtomCommand(threadEnvironment.restoreTitle, {
    reportFailure: false,
  });
  const [restoringTarget, setRestoringTarget] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const data = query.data;
  const canRestore =
    restorationSupported &&
    data !== null &&
    data.currentVersion !== undefined &&
    data.status !== "deleted" &&
    data.status !== "regenerating";
  const hasRestorableHistoryTitle =
    canRestore && data.history.some((entry) => entry.title !== data.currentTitle);
  const restoreTitle = async (target: string, title: string) => {
    if (!canRestore || data === null || data.currentVersion === undefined) return;
    setRestoringTarget(target);
    setRestoreError(null);
    const result = await restoreThreadTitle({
      environmentId,
      input: { threadId: threadRef.threadId, title, expectedVersion: data.currentVersion },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setRestoreError(
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The title could not be restored.",
      );
    }
    setRestoringTarget(null);
    query.refresh();
  };
  const rollingLimit = (() => {
    if (data?.rollingMaximum === null || data?.rollingMaximum === undefined) return null;
    const windowLabel =
      data.rollingWindowHours === null || data.rollingWindowHours === undefined
        ? ""
        : ` / ${data.rollingWindowHours}h window`;
    return `${data.rollingCount ?? 0} of ${data.rollingMaximum}${windowLabel}`;
  })();

  return (
    <>
      {query.error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-foreground"
        >
          {query.error}
        </p>
      ) : query.isPending && data === null ? (
        <p className="text-sm text-muted-foreground">Loading title updates…</p>
      ) : data === null ? (
        <p className="text-sm text-muted-foreground">No title update details are available.</p>
      ) : (
        <div className="space-y-4">
          {restoreError !== null ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-foreground"
            >
              {restoreError}
            </p>
          ) : null}
          <section className="rounded-lg border border-border/60 bg-card/30 p-3">
            <div className="flex items-center gap-2">
              <SparklesIcon aria-hidden className="size-4 text-amber-500" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {data.currentTitle}
              </span>
              <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {PROFILE_LABELS[data.profile]}
              </span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{statusReason(data.status)}</p>
            {canRestore && data.undoTitle != null ? (
              <div className="mt-3 rounded-md border border-border/60 bg-background/60 p-2.5">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 flex-1 break-words pt-1 text-xs text-muted-foreground">
                    Restore “<span className="font-medium text-foreground">{data.undoTitle}</span>”
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={restoringTarget !== null || query.isPending}
                    onClick={() => void restoreTitle("undo", data.undoTitle!)}
                  >
                    {restoringTarget === "undo" ? (
                      <Spinner aria-hidden className="size-3.5" />
                    ) : (
                      <Undo2Icon aria-hidden className="size-3.5" />
                    )}
                    Undo rename
                  </Button>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Restoring makes the title manual, protecting it from automatic changes. Use
                  Regenerate title in the thread menu to resume automatic updates.
                </p>
              </div>
            ) : null}
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div>
                <span className="block text-muted-foreground">Status</span>
                <span className="font-medium">{STATUS_LABELS[data.status]}</span>
              </div>
              <div>
                <span className="block text-muted-foreground">Phase</span>
                <span className="font-medium">
                  {data.phase === "initial" ? "First automatic update" : "Recurring"}
                </span>
              </div>
              <div>
                <span className="block text-muted-foreground">
                  {data.phase === "initial" ? "Completed exchanges" : "Fresh exchanges"}
                </span>
                <span className="font-mono tabular-nums">
                  {data.completedTurns} of {data.requiredTurns}
                </span>
              </div>
              {rollingLimit !== null ? (
                <div>
                  <span className="block text-muted-foreground">Rolling limit</span>
                  <span className="font-mono tabular-nums">{rollingLimit}</span>
                </div>
              ) : null}
              <div>
                <span className="block text-muted-foreground">Time requirement</span>
                <span>
                  {data.eligibleAt === null
                    ? "After policy requirements"
                    : formatDate(data.eligibleAt)}
                </span>
              </div>
              <div>
                <span className="block text-muted-foreground">Checked</span>
                <span>{formatRelativeTimeLabel(data.checkedAt)}</span>
              </div>
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                History
              </h3>
              <span className="text-[10px] text-muted-foreground">
                {data.hasMore ? "Recent 50 changes" : "Recorded changes"}
              </span>
            </div>
            {hasRestorableHistoryTitle ? (
              <p className="mb-2 text-xs text-muted-foreground">
                Restoring makes a title manual, protecting it from automatic changes. Use Regenerate
                title in the thread menu to resume automatic updates.
              </p>
            ) : null}
            {data.history.length === 0 ? (
              <p className="text-xs text-muted-foreground">No title changes recorded yet.</p>
            ) : (
              <div className="space-y-2">
                {data.history.map((entry) => (
                  <div key={entry.id} className="rounded-md border border-border/50 px-2.5 py-2">
                    <div className="flex items-start gap-2 text-xs">
                      <span className="min-w-0 flex-1 break-words">
                        {entry.previousTitle === null ? "New title" : entry.previousTitle}
                        <span className="mx-1.5 text-muted-foreground">→</span>
                        <span className="font-medium">{entry.title}</span>
                      </span>
                      <SourceBadge entry={entry} />
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <time dateTime={entry.at} className="text-[10px] text-muted-foreground">
                        {formatDate(entry.at)}
                      </time>
                      {canRestore && entry.title !== data.currentTitle ? (
                        <Button
                          size="micro"
                          variant="ghost-muted"
                          disabled={restoringTarget !== null || query.isPending}
                          onClick={() => void restoreTitle(entry.id, entry.title)}
                        >
                          {restoringTarget === entry.id ? (
                            <Spinner aria-hidden className="size-3" />
                          ) : null}
                          Restore this title
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}

export function ThreadTitleUpdatesPanel() {
  const threadRef = useThreadTitleUpdatesPanelStore((state) => state.threadRef);
  const open = threadRef !== null;
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const supported =
    open &&
    serverConfigs.get(threadRef.environmentId)?.environment.capabilities.threadTitleUpdates ===
      true;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeThreadTitleUpdates();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon aria-hidden className="size-4 text-amber-500" />
            Title updates
          </DialogTitle>
          <DialogDescription>
            The policy and history for this thread, checked when this panel opened or refreshed.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3" scrollFade={false}>
          {!supported ? (
            <p className="rounded-md border border-border/60 bg-muted/30 p-3 text-sm text-muted-foreground">
              Title update details require a newer server for this environment.
            </p>
          ) : (
            <TitleUpdatesContent
              key={`${threadRef.environmentId}:${threadRef.threadId}`}
              environmentId={threadRef.environmentId}
              restorationSupported={
                serverConfigs.get(threadRef.environmentId)?.environment.capabilities
                  .threadTitleRestore === true
              }
              threadRef={threadRef}
            />
          )}
        </DialogPanel>
        <DialogFooter variant="bare" className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            Eligibility does not schedule a rename.
          </span>
          {supported ? <TitleUpdatesRefreshButton /> : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function TitleUpdatesRefreshButton() {
  const threadRef = useThreadTitleUpdatesPanelStore((state) => state.threadRef);
  const query = useEnvironmentQuery(
    threadRef === null
      ? null
      : orchestrationEnvironment.titleUpdates({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  );
  return (
    <Button size="sm" variant="outline" disabled={query.isPending} onClick={query.refresh}>
      <RefreshIcon className="size-3.5" refreshing={query.isPending} />
      Refresh
    </Button>
  );
}
