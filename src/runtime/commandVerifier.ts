import type { JsonValue, ToolContext, VerificationResult, VerifierPort } from "../kernel/contracts.js";
import { ProcessTool } from "./processTool.js";

export interface VerificationCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

export class CommandVerifier implements VerifierPort {
  constructor(
    readonly name: string,
    private readonly processTool: ProcessTool,
    private readonly check: VerificationCommand,
  ) {}

  async verify(_candidate: string, task: string): Promise<VerificationResult> {
    const controller = new AbortController();
    const context: ToolContext = { task, step: 0, signal: controller.signal };
    const input: Record<string, JsonValue> = {
      command: this.check.command,
      args: [...this.check.args],
    };
    if (this.check.cwd !== undefined) input.cwd = this.check.cwd;
    const result = await this.processTool.execute(input, context);
    return { verifier: this.name, passed: result.ok, evidence: result.output };
  }
}

