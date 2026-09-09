import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export const RenameCurrentThreadInput = Schema.Struct({
  title: TrimmedNonEmptyString.check(
    Schema.isMaxLength(120),
    Schema.isPattern(/^[^\r\n]+$/),
  ).annotate({
    description: "A concise, single-line title describing the thread's main objective.",
  }),
});

export const RenameCurrentThreadResult = Schema.Struct({
  status: Schema.Literals(["updated", "unchanged", "disabled", "protected", "unavailable"]),
  title: Schema.optional(Schema.String),
});

export const ThreadTitleToolkit = Toolkit.make(
  Tool.make("rename_current_thread", {
    description:
      "Rename only the current thread using the title you supply. Use only when T3's automatic-title instructions are enabled and the existing title no longer describes the main objective. Manually chosen titles are protected. If disabled, protected, or unavailable, do not retry during this turn.",
    parameters: RenameCurrentThreadInput,
    success: RenameCurrentThreadResult,
    failure: Schema.String,
    dependencies: [
      McpInvocationContext,
      ServerSettingsService,
      ProjectionSnapshotQuery,
      OrchestrationEngineService,
      Crypto.Crypto,
    ],
  })
    .annotate(Tool.Title, "Update thread title")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
);
