import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Manual title",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: null,
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: UPDATED_AT,
};

it.layer(NodeServices.layer)("title regeneration decider", (it) => {
  it.effect("preserves updatedAt for a stale completion", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.title.regeneration.complete",
          commandId: CommandId.make("cmd-regeneration-complete"),
          threadId: ThreadId.make("thread-1"),
          requestId: CommandId.make("cmd-old-regeneration-request"),
          title: "Generated title",
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload).toEqual({
          threadId: ThreadId.make("thread-1"),
          updatedAt: UPDATED_AT,
        });
      }
    }),
  );

  it.effect("rejects an initial result after a manual rename to the same text", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.title.generate.complete",
          commandId: CommandId.make("generated"),
          threadId: ThreadId.make("thread-1"),
          expectedTitle: "Manual title",
          expectedVersion: null,
          title: "Automatic title",
          needsRefinement: true,
        },
        readModel: {
          ...readModel,
          threads: readModel.threads.map((thread) => ({
            ...thread,
            titleState: {
              source: "manual" as const,
              version: CommandId.make("manual"),
              needsRefinement: false,
            },
          })),
        },
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.payload).toEqual({ threadId: ThreadId.make("thread-1"), updatedAt: UPDATED_AT });
    }),
  );

  it.effect("records manual ownership even when the title text does not change", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("manual-rename"),
          threadId: ThreadId.make("thread-1"),
          title: "Manual title",
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.payload).toMatchObject({
        titleState: { source: "manual", version: "manual-rename", needsRefinement: false },
      });
    }),
  );
  const withTitleState = (
    titleState: NonNullable<OrchestrationReadModel["threads"][number]["titleState"]>,
    extra: Partial<OrchestrationReadModel["threads"][number]> = {},
  ): OrchestrationReadModel => ({
    ...readModel,
    threads: readModel.threads.map((thread) => ({ ...thread, titleState, ...extra })),
  });
  const decidePayload = (
    command: Parameters<typeof decideOrchestrationCommand>[0]["command"],
    model: OrchestrationReadModel,
  ) =>
    decideOrchestrationCommand({ command, readModel: model }).pipe(
      Effect.map((result) => (Array.isArray(result) ? result[0] : result).payload),
    );

  it.effect("records the replaced title when regeneration renames a thread", () =>
    Effect.gen(function* () {
      const generated = {
        source: "generated" as const,
        version: CommandId.make("refine"),
        needsRefinement: false,
        previousTitle: "Older title",
      };
      const regenerating = withTitleState(generated, {
        title: "Fix QR pairing expiry",
        titleRegeneration: { requestId: CommandId.make("refine"), startedAt: UPDATED_AT },
      });
      const complete = (title: string) => ({
        type: "thread.title.regeneration.complete" as const,
        commandId: CommandId.make(`complete-${title}`),
        threadId: ThreadId.make("thread-1"),
        requestId: CommandId.make("refine"),
        title,
      });

      expect(yield* decidePayload(complete("Ship QR pairing"), regenerating)).toMatchObject({
        title: "Ship QR pairing",
        titleState: { ...generated, previousTitle: "Fix QR pairing expiry" },
      });
      expect(
        yield* decidePayload(complete("Fix QR pairing expiry"), regenerating),
      ).not.toHaveProperty("titleState");
    }),
  );

  it.effect("keeps the previous title through manual renames and new regenerations", () =>
    Effect.gen(function* () {
      const model = withTitleState(
        {
          source: "generated",
          version: CommandId.make("generated"),
          needsRefinement: true,
          previousTitle: "Older title",
        },
        {
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: UPDATED_AT,
            startedAt: UPDATED_AT,
            completedAt: UPDATED_AT,
            assistantMessageId: null,
          },
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: UPDATED_AT,
          },
        },
      );
      const rename = (title: string) => ({
        type: "thread.meta.update" as const,
        commandId: CommandId.make(`rename-${title}`),
        threadId: ThreadId.make("thread-1"),
        title,
      });

      expect(yield* decidePayload(rename("My own title"), model)).toMatchObject({
        titleState: { source: "manual", previousTitle: "Manual title" },
      });
      expect(yield* decidePayload(rename("Manual title"), model)).toMatchObject({
        titleState: { source: "manual", previousTitle: "Older title" },
      });
      expect(
        yield* decidePayload(
          {
            type: "thread.title.refine",
            commandId: CommandId.make("refresh"),
            threadId: ThreadId.make("thread-1"),
            expectedVersion: CommandId.make("generated"),
          },
          model,
        ),
      ).toMatchObject({ titleState: { source: "generated", previousTitle: "Older title" } });
    }),
  );
});
