import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

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

it.layer(NodeServices.layer)("thread title ownership", (it) => {
  it.effect("rejects automatic writes to user-owned and legacy titles", () =>
    Effect.gen(function* () {
      for (const titleSource of ["user", undefined] as const) {
        const error = yield* decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make(`automatic-${titleSource ?? "legacy"}`),
            threadId: THREAD_ID,
            title: "Automatic title",
            titleSource: "automatic",
          },
          readModel: makeReadModel(titleSource === undefined ? {} : { titleSource }),
        }).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "OrchestrationCommandInvariantError",
          commandType: "thread.meta.update",
        });
      }
    }),
  );

  it.effect("rejects automatic writes after archival or deletion races", () =>
    Effect.gen(function* () {
      for (const lifecycle of [{ archivedAt: NOW }, { deletedAt: NOW }] satisfies ReadonlyArray<
        Partial<OrchestrationThread>
      >) {
        const error = yield* decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make(`automatic-inactive-${Object.keys(lifecycle)[0]}`),
            threadId: THREAD_ID,
            title: "Automatic title",
            titleSource: "automatic",
          },
          readModel: makeReadModel({ titleSource: "automatic", ...lifecycle }),
        }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      }
    }),
  );

  it.effect("marks ordinary title writes as user-owned", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({ titleSource: "automatic" });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("manual-title"),
          threadId: THREAD_ID,
          title: "Manual title",
        },
        readModel,
      });
      const event = Array.isArray(decided) ? decided[0]! : decided;
      expect(event).toMatchObject({
        type: "thread.meta-updated",
        payload: { title: "Manual title", titleSource: "user" },
      });
      const projected = yield* projectEvent(readModel, { ...event, sequence: 1 });
      expect(projected.threads[0]).toMatchObject({
        title: "Manual title",
        titleSource: "user",
      });
    }),
  );

  it.effect("treats replayed legacy title events as user-owned", () =>
    Effect.gen(function* () {
      const projected = yield* projectEvent(makeReadModel({ titleSource: "automatic" }), {
        sequence: 1,
        eventId: EventId.make("legacy-title-event"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: NOW,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.meta-updated",
        payload: { threadId: THREAD_ID, title: "Legacy update", updatedAt: NOW },
      });
      expect(projected.threads[0]).toMatchObject({
        title: "Legacy update",
        titleSource: "user",
      });
    }),
  );

  it.effect("lets explicit regeneration return a title to automatic ownership", () =>
    Effect.gen(function* () {
      const requestId = CommandId.make("regenerate-title");
      const readModel = makeReadModel({
        titleSource: "user",
        titleRegeneration: { requestId, startedAt: NOW },
      });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.title.regeneration.complete",
          commandId: CommandId.make("complete-regeneration"),
          threadId: THREAD_ID,
          requestId,
          title: "Current title",
        },
        readModel,
      });
      const event = Array.isArray(decided) ? decided[0]! : decided;
      expect(event).toMatchObject({
        type: "thread.meta-updated",
        payload: {
          title: "Current title",
          titleSource: "automatic",
          titleRegeneration: null,
        },
      });
    }),
  );
});
