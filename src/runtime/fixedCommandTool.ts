import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { objectInput } from "./input.js";
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
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      effect: "execute",
    };
  }

  async execute(input: JsonValue, context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    if (Object.keys(fields).length > 0) throw new Error(`${this.name} does not accept arguments.`);
    return this.processTool.execute({
      command: this.command.command,
      args: [...this.command.args],
      ...(this.command.cwd === undefined ? {} : { cwd: this.command.cwd }),
    }, context);
  }
}
