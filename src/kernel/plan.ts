import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  JsonValue,
  PlanStatusPort,
  ToolContext,
  ToolDefinition,
  ToolPort,
  ToolResult,
} from "./contracts.js";
import { PLAN_TOOL_NAME } from "./contracts.js";

export type MilestoneStatus = "pending" | "active" | "blocked" | "proven" | "invalidated";

export interface PlanMilestone {
  readonly id: string;
  readonly title: string;
  readonly acceptanceCriteria: readonly string[];
  readonly dependsOn: readonly string[];
  readonly status: MilestoneStatus;
  /** References to observable evidence: tool observations, test runs, files. */
  readonly evidence: readonly string[];
  /** Files or subsystems this milestone is allowed to touch. */
  readonly scope: readonly string[];
  readonly note?: string;
}

export interface PlanRevision {
  readonly revision: number;
  readonly summary: string;
  readonly at: string;
}

export interface PlanState {
  readonly revision: number;
  readonly milestones: readonly PlanMilestone[];
  readonly history: readonly PlanRevision[];
}

const MILESTONE_STATUSES: readonly MilestoneStatus[] = ["pending", "active", "blocked", "proven", "invalidated"];

/**
 * The runtime-owned engineering plan. The model proposes revisions through
 * the plan tool; the ledger validates them, persists them atomically, and
 * gives the kernel its completion and mutation gates.
 */
export class PlanLedger implements PlanStatusPort {
  #state: PlanState | undefined;
  readonly #file: string | undefined;

  constructor(initial?: PlanState, file?: string) {
    this.#state = initial;
    this.#file = file;
  }

  static async open(file: string): Promise<PlanLedger> {
    const absolute = path.resolve(file);
    try {
      const state = JSON.parse(await readFile(absolute, "utf8")) as PlanState;
      validatePlanState(state);
      return new PlanLedger(state, absolute);
    } catch (error) {
      if (!isMissing(error)) throw error;
      return new PlanLedger(undefined, absolute);
    }
  }

  isEmpty(): boolean {
    return this.#state === undefined || this.#state.milestones.length === 0;
  }

  unproven(): readonly string[] {
    if (this.#state === undefined) return [];
    return this.#state.milestones
      .filter((milestone) => milestone.status !== "proven" && milestone.status !== "invalidated")
      .map((milestone) => `${milestone.id} — ${milestone.title}`);
  }

  state(): PlanState | undefined {
    return this.#state;
  }

  snapshot(): JsonValue {
    if (this.#state === undefined) return null;
    return {
      revision: this.#state.revision,
      milestones: this.#state.milestones.map((milestone) => ({
        id: milestone.id,
        title: milestone.title,
        status: milestone.status,
        acceptanceCriteria: [...milestone.acceptanceCriteria],
        dependsOn: [...milestone.dependsOn],
        evidence: [...milestone.evidence],
        scope: [...milestone.scope],
        ...(milestone.note === undefined ? {} : { note: milestone.note }),
      })),
    };
  }

  async update(summary: string, milestones: readonly PlanMilestone[]): Promise<PlanState> {
    const revision = (this.#state?.revision ?? 0) + 1;
    const history = [
      ...(this.#state?.history ?? []),
      { revision, summary, at: new Date().toISOString() },
    ].slice(-100);
    const next: PlanState = { revision, milestones, history };
    validatePlanState(next);
    if (this.#file !== undefined) await atomicJsonWrite(this.#file, next);
    this.#state = next;
    return next;
  }
}

export class PlanTool implements ToolPort {
  readonly name = PLAN_TOOL_NAME;
  readonly definition: ToolDefinition = {
    name: this.name,
    description: "Establish or revise the durable engineering plan: the complete milestone list with statuses. Marking a milestone proven requires at least one evidence reference (a test run, tool observation, or verified file state). Submit the full plan each time; revisions are journaled.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "What changed in this revision and why." },
        milestones: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable short identifier, e.g. m1." },
              title: { type: "string" },
              acceptanceCriteria: { type: "array", items: { type: "string" } },
              dependsOn: { type: "array", items: { type: "string" } },
              status: { type: "string", enum: [...MILESTONE_STATUSES] },
              evidence: { type: "array", items: { type: "string" }, description: "Required non-empty when status is proven." },
              scope: { type: "array", items: { type: "string" }, description: "Files or subsystems this milestone touches." },
              note: { type: "string" },
            },
            required: ["id", "title", "acceptanceCriteria", "dependsOn", "status", "evidence", "scope"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "milestones"],
      additionalProperties: false,
    },
    effect: "state",
  };

  constructor(private readonly ledger: PlanLedger) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    if (input === null || Array.isArray(input) || typeof input !== "object") {
      throw new Error("Plan input must be an object.");
    }
    const summary = input.summary;
    if (typeof summary !== "string" || summary.length === 0 || summary.length > 2_000) {
      throw new Error("Plan summary must contain 1 to 2,000 characters.");
    }
    if (!Array.isArray(input.milestones)) throw new Error("Plan milestones must be an array.");
    const milestones = input.milestones.map(parseMilestone);
    const state = await this.ledger.update(summary, milestones);
    return {
      ok: true,
      output: {
        revision: state.revision,
        milestones: state.milestones.length,
        unproven: [...this.ledger.unproven()],
      },
    };
  }
}

function parseMilestone(value: JsonValue): PlanMilestone {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Each milestone must be an object.");
  }
  const id = expectBoundedString(value.id, "id", 64);
  const title = expectBoundedString(value.title, "title", 300);
  const status = value.status;
  if (!MILESTONE_STATUSES.includes(status as MilestoneStatus)) {
    throw new Error(`Milestone '${id}' has an invalid status.`);
  }
  const milestone: PlanMilestone = {
    id,
    title,
    acceptanceCriteria: stringList(value.acceptanceCriteria, `${id}.acceptanceCriteria`),
    dependsOn: stringList(value.dependsOn, `${id}.dependsOn`),
    status: status as MilestoneStatus,
    evidence: stringList(value.evidence, `${id}.evidence`),
    scope: stringList(value.scope, `${id}.scope`),
    ...(typeof value.note === "string" && value.note.length > 0
      ? { note: value.note.slice(0, 1_000) }
      : {}),
  };
  return milestone;
}

function validatePlanState(state: PlanState): void {
  if (!Number.isSafeInteger(state.revision) || state.revision < 1) {
    throw new Error("Persisted plan is malformed.");
  }
  if (!Array.isArray(state.milestones) || state.milestones.length > 24) {
    throw new Error("A plan holds between 0 and 24 milestones.");
  }
  const ids = new Set<string>();
  for (const milestone of state.milestones) {
    if (ids.has(milestone.id)) throw new Error(`Milestone id '${milestone.id}' is duplicated.`);
    ids.add(milestone.id);
    if (milestone.status === "proven" && milestone.evidence.length === 0) {
      throw new Error(`Milestone '${milestone.id}' cannot be proven without evidence references.`);
    }
  }
  for (const milestone of state.milestones) {
    for (const dependency of milestone.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Milestone '${milestone.id}' depends on unknown milestone '${dependency}'.`);
      }
    }
  }
}

function expectBoundedString(value: JsonValue | undefined, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`Milestone ${name} must contain 1 to ${max} characters.`);
  }
  return value;
}

function stringList(value: JsonValue | undefined, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 50
    || !value.every((item) => typeof item === "string" && item.length <= 1_000)) {
    throw new Error(`Plan '${name}' must be an array of at most 50 strings, each at most 1,000 characters.`);
  }
  return value as string[];
}

async function atomicJsonWrite(file: string, state: PlanState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
