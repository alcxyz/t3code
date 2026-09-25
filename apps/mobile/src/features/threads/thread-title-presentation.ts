import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

/** Automatic title updates stay visible until the user sends another message. */
export function isThreadTitleRenameActive(
  thread: Pick<EnvironmentThreadShell, "titleAutoRenamedAt" | "latestUserMessageAt">,
): boolean {
  const renamedAt = Date.parse(thread.titleAutoRenamedAt ?? "");
  const latestUserMessageAt = Date.parse(thread.latestUserMessageAt ?? "");
  return (
    Number.isFinite(renamedAt) &&
    (thread.latestUserMessageAt === null ||
      (Number.isFinite(latestUserMessageAt) && renamedAt > latestUserMessageAt))
  );
}
