import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-title-ownership");

function makeReadModel(overrides: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Current title",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        ...overrides,
      },
    ],
    updatedAt: NOW,
  };
}

const generated = {
  source: "generated" as const,
  version: CommandId.make("initial-title"),
  needsRefinement: false,
};
const rename = {
  type: "thread.title.automatic.update" as const,
  commandId: CommandId.make("agent-thread-title:test"),
  threadId: THREAD_ID,
  expectedVersion: generated.version,
  title: "Updated objective",
};

it.layer(NodeServices.layer)("recurring title ownership", (it) => {
  it.effect("rejects manual, unknown, pending and stale title ownership", () =>
    Effect.gen(function* () {
      for (const overrides of [
        {},
        { titleState: { ...generated, source: "manual" } },
        { titleState: { ...generated, version: CommandId.make("newer-title") } },
        {
          titleState: generated,
          titleRegeneration: { requestId: CommandId.make("pending"), startedAt: NOW },
        },
      ] satisfies ReadonlyArray<Partial<OrchestrationThread>>) {
        const error = yield* decideOrchestrationCommand({
          command: rename,
          readModel: makeReadModel(overrides),
        }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      }
    }),
  );
  it.effect("rejects lifecycle races but allows an expired snooze", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      for (const lifecycle of [
        { archivedAt: NOW },
        { deletedAt: NOW },
        { settledOverride: "settled" },
        { snoozedUntil: "2026-01-01T00:00:01.000Z" },
      ] satisfies ReadonlyArray<Partial<OrchestrationThread>>) {
        const error = yield* decideOrchestrationCommand({
          command: rename,
          readModel: makeReadModel({ titleState: generated, ...lifecycle }),
        }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      }
      const event = yield* decideOrchestrationCommand({
        command: rename,
        readModel: makeReadModel({
          titleState: generated,
          snoozedUntil: "2025-12-31T23:59:59.000Z",
        }),
      });
      expect(event).toMatchObject({
        payload: {
          title: rename.title,
          titleState: { ...generated, version: rename.commandId },
        },
      });
    }),
  );
  it.effect("same-text manual rename protects ownership and invalidates a captured version", () =>
    Effect.gen(function* () {
      const model = makeReadModel({ titleState: generated });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("manual-same-text"),
          threadId: THREAD_ID,
          title: "Current title",
        },
        readModel: model,
      });
      const event = Array.isArray(decided) ? decided[0]! : decided;
      expect(event).toMatchObject({
        payload: {
          titleState: { source: "manual", version: "manual-same-text" },
        },
      });
      const projected = yield* projectEvent(model, { ...event, sequence: 1 });
      const error = yield* decideOrchestrationCommand({
        command: rename,
        readModel: projected,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
    }),
  );
  it.effect("same-title automatic requests do not advance ownership", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: { ...rename, title: "Current title" },
        readModel: makeReadModel({ titleState: generated }),
      });
      expect(event).toMatchObject({ payload: { threadId: THREAD_ID, updatedAt: NOW } });
      const value = Array.isArray(event) ? event[0]! : event;
      expect(value.payload).not.toHaveProperty("title");
      expect(value.payload).not.toHaveProperty("titleState");
    }),
  );
  it.effect("native initial generation never sets the recurring rename badge", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.title.generate.complete",
          commandId: CommandId.make("native-title"),
          threadId: THREAD_ID,
          expectedTitle: "Current title",
          expectedVersion: null,
          title: "Initial objective",
          needsRefinement: true,
        },
        readModel: makeReadModel(),
      });
      expect(event).toMatchObject({
        payload: { titleState: { source: "generated", needsRefinement: true } },
      });
      const value = Array.isArray(event) ? event[0]! : event;
    }),
  );
  it.effect("native refinement completes without a recurring rename badge", () =>
    Effect.gen(function* () {
      const requestId = CommandId.make("server:thread-title-refine:test");
      let model = makeReadModel({
        titleState: { ...generated, needsRefinement: true },
        latestTurn: {
          turnId: TurnId.make("first"),
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        },
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.title.refine",
          commandId: requestId,
          threadId: THREAD_ID,
          expectedVersion: generated.version,
        },
        readModel: model,
      });
      const event = Array.isArray(decided) ? decided[0]! : decided;
      expect(event.payload).toMatchObject({
        regenerateTitle: true,
        titleState: { needsRefinement: false },
      });
      model = yield* projectEvent(model, { ...event, sequence: 1 });
      const completed = yield* decideOrchestrationCommand({
        command: {
          type: "thread.title.regeneration.complete",
          commandId: CommandId.make("server:thread-title-regeneration-complete:test"),
          threadId: THREAD_ID,
          requestId,
          title: "Concrete objective",
        },
        readModel: model,
      });
      const completion = Array.isArray(completed) ? completed[0]! : completed;
      expect(completion.payload).toMatchObject({
        title: "Concrete objective",
        titleRegeneration: null,
      });
      model = yield* projectEvent(model, { ...completion, sequence: 2 });
      expect(model.threads[0]?.titleState).toMatchObject({
        source: "generated",
        needsRefinement: false,
      });
    }),
  );
});
