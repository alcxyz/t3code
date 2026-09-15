const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly currentThreadTitle?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${model}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const titleInstructions = buildThreadTitleInstructions(runtime.currentThreadTitle);
  const threadTitleInstructions = titleInstructions ? `\n${titleInstructions}` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>${threadTitleInstructions}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`;
}

export function buildThreadTitleInstructions(currentThreadTitle?: string): string {
  return currentThreadTitle
    ? `<thread_title_updates>Automatic thread-title updates are enabled. The current title is ${toSafeJsonStringLiteral(currentThreadTitle)}. At natural stopping points, consider whether it still describes the main objective. Call the t3-code \`rename_current_thread\` tool only when the main objective has materially changed or a vague task has become concrete and this title is misleading. Choose a concise, stable title for the main objective. Do not rename for routine progress, debugging, or minor subtopics. Decide from the conversation itself; do not make a separate generation call. If the tool reports disabled, protected, unavailable, or rate limited, do not retry during this turn.</thread_title_updates>`
    : "";
}

function toSafeJsonStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
