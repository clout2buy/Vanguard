import type {
  JsonValue,
  ToolContext,
  ToolDefinition,
  ToolPort,
  ToolResult,
  WorkingStatePort,
} from "./contracts.js";

interface CheckpointState {
  readonly revision: number;
  readonly summary: string;
  readonly completed: readonly string[];
  readonly next: readonly string[];
  readonly evidence: readonly string[];
  readonly risks: readonly string[];
}

export class RunCheckpointLedger implements WorkingStatePort {
  #state: CheckpointState | undefined;

  update(state: Omit<CheckpointState, "revision">): CheckpointState {
    this.#state = { ...state, revision: (this.#state?.revision ?? 0) + 1 };
    return this.#state;
  }

  snapshot(): JsonValue {
    return this.#state === undefined ? null : this.#state as unknown as JsonValue;
  }
}

export class CheckpointTool implements ToolPort {
  readonly name = "run.checkpoint";
  readonly definition: ToolDefinition = {
    name: this.name,
    description: "Persist concise working state that survives context compaction and provider retries.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Current understanding and approach." },
        completed: { type: "array", items: { type: "string" }, description: "Work proven complete." },
        next: { type: "array", items: { type: "string" }, description: "Ordered next actions." },
        evidence: { type: "array", items: { type: "string" }, description: "Tests, hashes, or observations supporting state." },
        risks: { type: "array", items: { type: "string" }, description: "Open uncertainties or regression risks." },
      },
      required: ["summary", "completed", "next", "evidence", "risks"],
      additionalProperties: false,
    },
  };

  constructor(private readonly ledger: RunCheckpointLedger) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    if (input === null || Array.isArray(input) || typeof input !== "object") {
      throw new Error("Checkpoint input must be an object.");
    }
    const summary = input.summary;
    if (typeof summary !== "string" || summary.length === 0 || summary.length > 4_000) {
      throw new Error("Checkpoint summary must contain 1 to 4,000 characters.");
    }
    const state = this.ledger.update({
      summary,
      completed: stringList(input.completed, "completed"),
      next: stringList(input.next, "next"),
      evidence: stringList(input.evidence, "evidence"),
      risks: stringList(input.risks, "risks"),
    });
    return { ok: true, output: state as unknown as JsonValue };
  }
}

function stringList(value: JsonValue | undefined, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 50 || !value.every((item) => typeof item === "string" && item.length <= 1_000)) {
    throw new Error(`Checkpoint '${name}' must be an array of at most 50 strings, each at most 1,000 characters.`);
  }
  return value as string[];
}
