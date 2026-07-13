import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { analyzePatch } from "../gauntlet/diffMetrics.js";

export class ReviewChangesTool implements ToolPort {
  readonly name = "workspace.changes";
  readonly definition: ToolDefinition = {
    name: this.name,
    description: "Review final changed-file scope and aggregate code growth before completion.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "review",
  };

  constructor(
    private readonly sourceRoot: string,
    private readonly workspaceRoot: string,
  ) {}

  async execute(_input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const patch = await analyzePatch(this.sourceRoot, this.workspaceRoot);
    const expansionRatio = patch.beforeLines === 0 ? null : round(patch.afterLines / patch.beforeLines);
    const reviewFlags: string[] = [];
    if (patch.beforeLines >= 10 && expansionRatio !== null && expansionRatio > 4) {
      reviewFlags.push("large-patch-expansion: re-read changed files and simplify duplication where possible");
    }
    if (patch.beforeLines === 0 && patch.afterLines > 300) {
      reviewFlags.push("large-new-code-surface: inspect added files for temporary harnesses and unnecessary code");
    }
    if (patch.changedFiles.length === 0) reviewFlags.push("no-workspace-changes");
    return {
      ok: true,
      output: {
        changedFiles: [...patch.changedFiles],
        filesAdded: patch.filesAdded,
        filesDeleted: patch.filesDeleted,
        filesModified: patch.filesModified,
        beforeBytes: patch.beforeBytes,
        afterBytes: patch.afterBytes,
        beforeLines: patch.beforeLines,
        afterLines: patch.afterLines,
        expansionRatio,
        reviewFlags,
      },
    };
  }
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
