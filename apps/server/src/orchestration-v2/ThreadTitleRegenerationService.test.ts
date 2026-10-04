import { assert, describe, it, vi } from "@effect/vitest";
import {
  type ChatAttachment,
  CommandId,
  EventId,
  RunId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TextGenerationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:title-regeneration");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in title regeneration tests"),
} as ProviderAdapterV2Shape;

function makeHarness(
  options: {
    readonly automaticThreadTitleUpdates?: boolean;
    readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  } = {},
) {
  const database = SqlitePersistenceMemory;
  const registry = ProviderAdapterRegistry.makeLayer([adapter]);
  const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "thread-title-regeneration" },
    registry,
    {
      databaseLayer: database,
      runEffectWorker: false,
      automaticThreadTitleUpdates: options.automaticThreadTitleUpdates ?? false,
    },
  );
  const threadManagement = ThreadManagement.layer.pipe(Layer.provide(orchestrator));
  const outbox = EffectOutbox.layer.pipe(Layer.provide(database));
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const projectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: "Project",
              workspaceRoot: "/repo",
              defaultModelSelection: modelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-06-20T00:00:00.000Z",
              updatedAt: "2026-06-20T00:00:00.000Z",
              deletedAt: null,
            })
          : Option.none(),
      ),
  });
  const titleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        threadManagement,
        projectedProjects,
        Layer.mock(TextGeneration.TextGeneration)({ generateThreadTitle }),
        ServerSettings.layerTest({}),
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(orchestrator, threadManagement, titleRegeneration, outbox, database),
    generateThreadTitle,
  };
}

function createThread(input: { readonly command: string; readonly thread: string }) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(input.thread);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(input.command),
      threadId,
      projectId,
      title: "Seed title",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });
}

function dispatchUserMessage(input: {
  readonly command: string;
  readonly threadId: ThreadId;
  readonly text: string;
}) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(input.command),
      threadId: input.threadId,
      messageId: MessageId.make(`${input.command}:message`),
      text: input.text,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
  });
}

function armRegeneration(input: { readonly command: string; readonly threadId: ThreadId }) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const requestId = CommandId.make(input.command);
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: requestId,
      threadId: input.threadId,
      regenerateTitle: true,
    });
    return requestId;
  });
}

function seedCompletedRuns(
  threadId: ThreadId,
  count: number,
  failedOrdinals: ReadonlyArray<number> = [],
) {
  return Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    for (let ordinal = 1; ordinal <= count; ordinal++) {
      yield* sink.write({
        events: [
          {
            id: EventId.make(`event:${threadId}:run:${ordinal}`),
            type: "run.created",
            threadId,
            occurredAt: now,
            payload: {
              id: RunId.make(`run:${threadId}:${ordinal}`),
              threadId,
              ordinal,
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make(`message:${threadId}:${ordinal}`),
              rootNodeId: null,
              activeAttemptId: null,
              status: failedOrdinals.includes(ordinal) ? "failed" : "completed",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });
    }
  });
}

function automaticUpdate(threadId: ThreadId, ordinal: number) {
  return Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const runId = RunId.make(`run:${threadId}:${ordinal}`);
    return yield* engine.dispatch({
      type: "thread.title.auto-update",
      commandId: CommandId.make(`command:auto-title:${runId}`),
      threadId,
      runId,
    });
  });
}

describe("formatThreadTitleContext", () => {
  const attachment = (id: string): ChatAttachment => ({
    type: "image",
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 1,
  });

  it("builds a newest-first digest, skipping system messages and empty sections", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: "First question" },
      { role: "system", text: "Hidden instructions" },
      { role: "assistant", text: "" },
      { role: "assistant", text: "Second answer", attachments: [attachment("shot")] },
    ]);
    assert.equal(
      context.message,
      "USER:\nFirst question\n\nASSISTANT:\nSecond answer\n[Attachments: shot.png]",
    );
    assert.deepEqual(
      context.attachments.map((entry) => entry.name),
      ["shot.png"],
    );
  });

  it("pins the first user message ahead of the retained tail once content stops fitting", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: `Ancient context that anchors the topic ${"x".repeat(600)}` },
      { role: "assistant", text: "y".repeat(6_000) },
      { role: "user", text: "z".repeat(1_500) },
    ]);
    assert.isTrue(context.message.includes("USER:\nAncient context that anchors the topic"));
    assert.isTrue(context.message.includes("[Earlier content truncated]\n\n"));
    assert.isTrue(context.message.includes("y".repeat(100)));
  });

  it("truncates an oversized pinned first user message", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: `Topic anchor ${"a".repeat(4_000)}` },
      { role: "assistant", text: "y".repeat(9_000) },
      { role: "user", text: "z".repeat(1_500) },
    ]);
    assert.isTrue(context.message.includes("USER:\nTopic anchor"));
    assert.isTrue(context.message.includes("[Content truncated]"));
    assert.isTrue(context.message.includes("[Earlier content truncated]\n\n"));
  });

  it("retains at most four attachments from the newest messages", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: "older", attachments: [attachment("a"), attachment("b")] },
      {
        role: "user",
        text: "newer",
        attachments: [attachment("c"), attachment("d"), attachment("e")],
      },
    ]);
    assert.deepEqual(
      context.attachments.map((entry) => entry.name),
      ["a.png", "c.png", "d.png", "e.png"],
    );
  });
});

describe("ThreadTitleRegenerationService", () => {
  it.effect("regenerates on every fifth completed run through the terminal-run listener", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ automaticThreadTitleUpdates: true });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const engine = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const threadId = yield* createThread({
          command: "command:cadence:create",
          thread: "thread:cadence",
        });
        yield* seedCompletedRuns(threadId, 10);
        for (const ordinal of [1, 2, 3, 4, 6, 7, 8, 9]) {
          assert.equal((yield* automaticUpdate(threadId, ordinal)).storedEvents.length, 0);
        }
        for (const ordinal of [5, 10]) {
          const runId = RunId.make(`run:${threadId}:${ordinal}`);
          const requestId = CommandId.make(`command:auto-title:${runId}`);
          const landed = yield* engine.streamStoredEvents.pipe(
            Stream.filter((stored) => stored.commandId === requestId),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          const run = (yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] }))
            .runs[0]!;
          yield* sink.write({
            events: [
              {
                id: EventId.make(`event:complete:${ordinal}`),
                type: "run.updated",
                threadId,
                occurredAt: yield* DateTime.now,
                payload: run,
              },
            ],
          });
          yield* Fiber.join(landed);
          assert.equal(
            (yield* threads.getThreadProjection(threadId)).thread.titleRegeneration?.automatic,
            true,
          );
          assert.deepEqual(
            (yield* outbox.listByCommandId(requestId)).map((effect) => effect.request),
            [{ type: "thread-title.generate", kind: { type: "regenerate" } }],
          );
          yield* threads.dispatch({
            type: "thread.title.regeneration.complete",
            commandId: CommandId.make(`command:land:${ordinal}`),
            threadId,
            requestId,
            title: `Title ${ordinal}`,
          });
          assert.isOk((yield* threads.getThreadProjection(threadId)).thread.renamedAt);
          assert.isOk((yield* engine.getThreadShell(threadId))?.renamedAt);
          yield* automaticUpdate(threadId, ordinal);
          assert.equal((yield* outbox.listByCommandId(requestId)).length, 1);
        }
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("counts completed runs rather than attempted turn ordinals", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ automaticThreadTitleUpdates: true });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const threadId = yield* createThread({
          command: "command:failures:create",
          thread: "thread:failures",
        });
        yield* seedCompletedRuns(threadId, 7, [1, 3]);
        assert.equal((yield* automaticUpdate(threadId, 6)).storedEvents.length, 0);
        yield* automaticUpdate(threadId, 7);
        assert.isTrue(
          (yield* threads.getThreadProjection(threadId)).thread.titleRegeneration?.automatic,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect.each([
    "disabled",
    "manual",
    "in-flight",
    "archived",
    "deleted",
    "native-subagent",
  ] as const)("skips automatic titles when %s", (skip) =>
    Effect.gen(function* () {
      const harness = makeHarness({ automaticThreadTitleUpdates: skip !== "disabled" });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const threadId = yield* createThread({
          command: `command:skip:${skip}`,
          thread: `thread:skip:${skip}`,
        });
        yield* seedCompletedRuns(threadId, 5);
        if (skip === "manual")
          yield* threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("command:manual"),
            threadId,
            title: "My title",
          });
        if (skip === "in-flight")
          yield* armRegeneration({ command: "command:in-flight", threadId });
        if (skip === "archived")
          yield* threads.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("command:archive"),
            threadId,
          });
        if (skip === "deleted" || skip === "native-subagent") {
          const sink = yield* EventSink.EventSinkV2;
          const thread = (yield* threads.getThreadProjection(threadId)).thread;
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make(`event:${skip}`),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...thread,
                  ...(skip === "deleted"
                    ? { deletedAt: now }
                    : {
                        creationSource: "provider" as const,
                        lineage: {
                          ...thread.lineage,
                          relationshipToParent: "subagent" as const,
                          parentThreadId: ThreadId.make("parent"),
                        },
                      }),
                },
              },
            ],
          });
        }
        assert.equal((yield* automaticUpdate(threadId, 5)).storedEvents.length, 0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("manual regeneration returns ownership without setting a rename timestamp", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ automaticThreadTitleUpdates: true });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const threadId = yield* createThread({
          command: "command:ownership:create",
          thread: "thread:ownership",
        });
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:ownership:rename"),
          threadId,
          title: "Manual",
        });
        assert.isTrue((yield* threads.getThreadProjection(threadId)).thread.titleManuallyOwned);
        const requestId = yield* armRegeneration({
          command: "command:ownership:regenerate",
          threadId,
        });
        assert.isFalse((yield* threads.getThreadProjection(threadId)).thread.titleManuallyOwned);
        yield* threads.dispatch({
          type: "thread.title.regeneration.complete",
          commandId: CommandId.make("command:ownership:complete"),
          threadId,
          requestId,
          title: "Generated",
        });
        assert.isNotOk((yield* threads.getThreadProjection(threadId)).thread.renamedAt);
        yield* seedCompletedRuns(threadId, 5);
        yield* automaticUpdate(threadId, 5);
        assert.isTrue(
          (yield* threads.getThreadProjection(threadId)).thread.titleRegeneration?.automatic,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("initial title generation does not set a rename timestamp", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const threadId = yield* createThread({
          command: "command:initial:create",
          thread: "thread:initial",
        });
        const requestId = CommandId.make("command:initial:message");
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: requestId,
          threadId,
          messageId: MessageId.make("message:initial"),
          text: "First question",
          titleSeed: "First question",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        assert.equal(
          (yield* threads.getThreadProjection(threadId)).thread.titleRegeneration?.requestId,
          requestId,
        );
        yield* threads.dispatch({
          type: "thread.title.regeneration.complete",
          commandId: CommandId.make("command:initial:complete"),
          threadId,
          requestId,
          title: "Generated",
        });
        assert.isNotOk((yield* threads.getThreadProjection(threadId)).thread.renamedAt);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("arms and clears the regeneration marker through metadata commands", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const threadId = yield* createThread({
          command: "command:title:arm:create",
          thread: "thread:title:arm",
        });

        const firstRequest = yield* armRegeneration({ command: "command:title:arm:1", threadId });
        const armed = yield* threads.getThreadProjection(threadId);
        assert.equal(armed.thread.titleRegeneration?.requestId, firstRequest);
        assert.deepEqual(
          (yield* outbox.listByCommandId(firstRequest)).map((effect) => effect.request),
          [{ type: "thread-title.generate", kind: { type: "regenerate" } }],
        );

        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:title:arm:abandon"),
          threadId,
          regenerateTitle: false,
        });
        const abandoned = yield* threads.getThreadProjection(threadId);
        assert.isNotOk(abandoned.thread.titleRegeneration);

        yield* armRegeneration({ command: "command:title:arm:2", threadId });
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:title:arm:rename"),
          threadId,
          title: "Manual title",
        });
        const renamed = yield* threads.getThreadProjection(threadId);
        assert.equal(renamed.thread.title, "Manual title");
        assert.isNotOk(renamed.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("skips execution when the marker was superseded by a newer request", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:stale:create",
          thread: "thread:title:stale",
        });
        const staleRequest = yield* armRegeneration({ command: "command:title:stale:1", threadId });
        const currentRequest = yield* armRegeneration({
          command: "command:title:stale:2",
          threadId,
        });

        yield* titleRegeneration.execute({
          threadId,
          requestId: staleRequest,
          kind: { type: "regenerate" },
        });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.equal(projection.thread.titleRegeneration?.requestId, currentRequest);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("lands the regenerated title from the conversation digest", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "Fresh title" }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:landing:create",
          thread: "thread:title:landing",
        });
        yield* dispatchUserMessage({
          command: "command:title:landing:message",
          threadId,
          text: "Investigate the flaky login test",
        });
        const requestId = yield* armRegeneration({ command: "command:title:landing:1", threadId });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        const call = harness.generateThreadTitle.mock.calls[0]?.[0];
        assert.equal(call?.previousTitle, "Seed title");
        assert.equal(call?.cwd, "/repo");
        assert.include(call?.message, "USER:\nInvestigate the flaky login test");
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Fresh title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps the current title when generation returns the fallback", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "New thread" }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:fallback:create",
          thread: "thread:title:fallback",
        });
        yield* dispatchUserMessage({
          command: "command:title:fallback:message",
          threadId,
          text: "Some conversation",
        });
        const requestId = yield* armRegeneration({ command: "command:title:fallback:1", threadId });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps the current title when regeneration reproduces it", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "Seed title" }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:unchanged:create",
          thread: "thread:title:unchanged",
        });
        yield* dispatchUserMessage({
          command: "command:title:unchanged:message",
          threadId,
          text: "Some conversation",
        });
        const requestId = yield* armRegeneration({
          command: "command:title:unchanged:1",
          threadId,
        });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("clears the marker and keeps the title when generation fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.die(new Error("model unavailable")),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:failure:create",
          thread: "thread:title:failure",
        });
        yield* dispatchUserMessage({
          command: "command:title:failure:message",
          threadId,
          text: "Some conversation",
        });
        const requestId = yield* armRegeneration({ command: "command:title:failure:1", threadId });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 1);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("completes without generating when the initial message is unavailable", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:missing:create",
          thread: "thread:title:missing",
        });
        const requestId = yield* armRegeneration({ command: "command:title:missing:1", threadId });

        yield* titleRegeneration.execute({
          threadId,
          requestId,
          kind: { type: "initial", messageId: MessageId.make("message:title:missing") },
        });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

it.effect.each(["success", "exhausted", "stale", "interrupted"] as const)(
  "initial title retry: %s",
  (outcome) =>
    Effect.gen(function* () {
      const attempted = yield* Deferred.make<void>();
      let attempts = 0;
      const harness = makeHarness({
        generateTitle: () =>
          Effect.gen(function* () {
            attempts += 1;
            yield* Deferred.succeed(attempted, undefined);
            if (outcome === "success" && attempts === 3) return { title: "Recovered title" };
            return yield* new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "Temporary failure",
            });
          }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: `create:${outcome}`,
          thread: `thread:${outcome}`,
        });
        const messageCommand = `message:${outcome}`;
        yield* dispatchUserMessage({ command: messageCommand, threadId, text: "Fix the title" });
        const requestId = yield* armRegeneration({ command: `title:${outcome}`, threadId });
        const fiber = yield* service
          .execute({
            threadId,
            requestId,
            kind: { type: "initial", messageId: MessageId.make(`${messageCommand}:message`) },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(attempted);
        if (outcome === "interrupted") {
          yield* Fiber.interrupt(fiber);
        } else {
          if (outcome === "stale")
            yield* threads.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make("manual-title"),
              threadId,
              title: "Manual title",
            });
          yield* TestClock.adjust("2 seconds");
          if (outcome !== "stale") yield* TestClock.adjust("4 seconds");
          yield* Fiber.join(fiber);
        }
        assert.equal(attempts, outcome === "success" || outcome === "exhausted" ? 3 : 1);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(
          projection.thread.title,
          outcome === "success"
            ? "Recovered title"
            : outcome === "stale"
              ? "Manual title"
              : "Seed title",
        );
        if (outcome === "interrupted")
          assert.equal(projection.thread.titleRegeneration?.requestId, requestId);
        else assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
);
