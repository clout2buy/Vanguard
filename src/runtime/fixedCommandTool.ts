import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { ProcessTool } from "./processTool.js";

export interface FixedCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

export class FixedCommandTool implements ToolPort {
  readonly definition: ToolDefinition;

  constructor(
    readonly name: string,
    description: string,
    private readonly processTool: ProcessTool,
    private readonly command: FixedCommand,
  ) {
    this.definition = {
      name,
      description,
      // The provider may add harmless narration fields. They are intentionally
      // ignored because the immutable command and argv remain runtime-owned.
      inputSchema: { type: "object", additionalProperties: true },
      effect: "execute",
      evidenceAuthority: "independent-execution",
    };
  }

  async execute(_input: JsonValue, context: ToolContext): Promise<ToolResult> {
    return this.processTool.execute({
      command: this.command.command,
      args: [...this.command.args],
      ...(this.command.cwd === undefined ? {} : { cwd: this.command.cwd }),
    }, context);
  }
}
