import type { JsonValue, ToolContext, VerificationResult, VerifierPort } from "../kernel/contracts.js";
import { ProcessTool } from "./processTool.js";

export interface VerificationCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

export type VerificationEvidenceMode = "full" | "summary";

export class CommandVerifier implements VerifierPort {
  constructor(
    readonly name: string,
    private readonly processTool: ProcessTool,
    private readonly check: VerificationCommand,
    private readonly evidenceMode: VerificationEvidenceMode = "full",
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
    const evidence = this.evidenceMode === "full"
      ? result.output
      : summarizeEvidence(result.output, result.ok);
    return { verifier: this.name, passed: result.ok, evidence };
  }
}

function summarizeEvidence(output: JsonValue, passed: boolean): JsonValue {
  const exitCode = output !== null && !Array.isArray(output) && typeof output === "object"
    && typeof output.exitCode === "number"
    ? output.exitCode
    : null;
  return {
    passed,
    exitCode,
    message: passed
      ? "Behavioral grader passed."
      : "Behavioral grader failed. Re-read the task contract and test the implementation without inspecting grader internals.",
  };
}
