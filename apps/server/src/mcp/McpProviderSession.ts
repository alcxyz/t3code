import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

// Null records a provider session started without the optional MCP endpoint.
const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig | null>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId) ?? undefined;
}

export function markMcpProviderSessionUnavailable(threadId: ThreadId): void {
  sessionsByThread.set(threadId, null);
}

export function requiresNewMcpProviderSession(threadId: ThreadId): boolean {
  return sessionsByThread.get(threadId) === null;
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
