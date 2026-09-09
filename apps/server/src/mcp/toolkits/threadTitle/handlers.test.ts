import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  OrchestrationThreadShell,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { ThreadTitleToolkitRegistrationLive } from "../../McpHttpServer.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";

const decodeThreadShell = Schema.decodeUnknownSync(OrchestrationThreadShell);

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-title-test"),
  threadId: ThreadId.make("current-thread"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "title-test-session",
  capabilities: new Set(["thread-title"]),
  issuedAt: 1,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "title-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "title-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

function makeHarness(
  options: {
    enabled?: boolean;
    source?: "automatic" | "user" | "legacy";
    missing?: boolean;
    rejectDispatch?: boolean;
  } = {},
) {
  let thread = decodeThreadShell({
    id: scope.threadId,
    projectId: "project-title-test",
    title: "Investigate login",
    ...(options.source === "legacy" ? {} : { titleSource: options.source ?? "automatic" }),
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });
  const commands: OrchestrationCommand[] = [];
  const reads: ThreadId[] = [];
  const unused = () => Effect.die("unexpected query");
  const queries = ProjectionSnapshotQuery.of({
    getUserInputActivity: unused,
    getCommandReadModel: unused,
    getSnapshot: unused,
    getShellSnapshot: unused,
    getArchivedShellSnapshot: unused,
    searchThreads: unused,
    getSnapshotSequence: unused,
    getCounts: unused,
    getEventReplayStats: unused,
    getActiveProjectByWorkspaceRoot: unused,
    getProjectShellById: unused,
    getFirstActiveThreadIdByProjectId: unused,
    getImportedAgentSessionSources: unused,
    getThreadCheckpointContext: unused,
    getFullThreadDiffContext: unused,
    getThreadRuntimeContext: unused,
    getTurnStartMessage: unused,
    getThreadDetailById: unused,
    getThreadDetailSnapshot: unused,
    getThreadShellById: (id) =>
      Effect.sync(() => {
        reads.push(id);
        return options.missing ? Option.none() : Option.some(thread);
      }),
  });
  const engine = OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    readThreadEvents: () => Stream.empty,
    getThreadReplayStats: unused,
    streamDomainEvents: Stream.empty,
    subscribeDomainEvents: Effect.succeed(Stream.empty),
    latestSequence: Effect.succeed(0),
    dispatch: (command) =>
      Effect.gen(function* () {
        commands.push(command);
        if (options.rejectDispatch) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "A user rename won the race.",
          });
        }
        if (command.type === "thread.meta.update" && command.title !== undefined) {
          thread = { ...thread, title: command.title };
        }
        return { sequence: commands.length };
      }),
  });
  const layer = ThreadTitleToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      ServerSettings.layerTest({ automaticThreadTitles: options.enabled ?? true }),
    ),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, queries)),
    Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provide(NodeServices.layer),
  );
  return { layer, commands, reads };
}

const call = (args: Record<string, unknown>, invocation = scope) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "rename_current_thread", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("uses authenticated thread identity and avoids duplicate title writes", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const result = yield* call({ title: "Fix expired login sessions", threadId: "another-thread" });
    expect(result.structuredContent).toEqual({
      status: "updated",
      title: "Fix expired login sessions",
    });
    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]).toMatchObject({
      threadId: scope.threadId,
      title: "Fix expired login sessions",
      titleSource: "automatic",
    });
    expect(harness.reads).toEqual([scope.threadId]);
    expect((yield* call({ title: "Fix expired login sessions" })).structuredContent).toMatchObject({
      status: "unchanged",
    });
    expect(harness.commands).toHaveLength(1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("honors setting changes without restarting the MCP session", () => {
  const harness = makeHarness({ enabled: false });
  return Effect.gen(function* () {
    expect((yield* call({ title: "Fix login" })).structuredContent).toEqual({ status: "disabled" });
    expect(harness.reads).toHaveLength(0);
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ automaticThreadTitles: true });
    expect((yield* call({ title: "Fix login" })).structuredContent).toMatchObject({
      status: "updated",
    });
    yield* settings.updateSettings({ automaticThreadTitles: false });
    expect((yield* call({ title: "Fix login again" })).structuredContent).toEqual({
      status: "disabled",
    });
    expect(harness.commands).toHaveLength(1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["user", "legacy"] as const)("protects %s titles without dispatching", (source) => {
  const harness = makeHarness({ source });
  return Effect.gen(function* () {
    expect((yield* call({ title: "New title" })).structuredContent).toMatchObject({
      status: "protected",
    });
    expect(harness.commands).toHaveLength(0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects credentials without the title capability before reading the thread", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    expect(
      (yield* call({ title: "New title" }, { ...scope, capabilities: new Set(["preview"]) }))
        .structuredContent,
    ).toEqual({ status: "unavailable" });
    expect(harness.reads).toHaveLength(0);
    expect(harness.commands).toHaveLength(0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("does not report success when the decider rejects a racing rename", () => {
  const harness = makeHarness({ rejectDispatch: true });
  return Effect.gen(function* () {
    expect((yield* call({ title: "New title" })).structuredContent).toEqual({
      status: "unavailable",
    });
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["", "  ", "first\nsecond", "x".repeat(121)])(
  "rejects invalid titles %#",
  (title) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const result = yield* call({ title }).pipe(Effect.result);
      expect(result._tag === "Failure" || result.success.isError === true).toBe(true);
      expect(harness.commands).toHaveLength(0);
    }).pipe(Effect.provide(harness.layer));
  },
);
