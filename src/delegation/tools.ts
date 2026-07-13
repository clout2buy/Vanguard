import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { DelegationCoordinator, type DelegateRecord } from "./coordinator.js";

export function createDelegationTools(coordinator: DelegationCoordinator): readonly ToolPort[] {
  return [
    new DelegateStartTool(coordinator),
    new DelegateStatusTool(coordinator),
    new DelegateWaitTool(coordinator),
    new DelegateCancelTool(coordinator),
    new DelegateMergeTool(coordinator),
  ];
}

export class DelegateStartTool implements ToolPort {
  readonly name = "delegate.start";
  readonly definition: ToolDefinition = {
    name: this.name,
    description: "Start a real isolated Vanguard child for a scoped coding subtask. Returns immediately; use delegate.status or delegate.wait to observe it.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Self-contained child objective and acceptance criteria." },
        scopes: {
          type: "array",
          items: { type: "string" },
          description: "One or more workspace-relative roots the child may edit.",
        },
        maxSteps: { type: "integer", minimum: 1, description: "Reserved child step budget." },
      },
      required: ["task", "scopes", "maxSteps"],
      additionalProperties: false,
    },
    effect: "state",
  };

  constructor(private readonly coordinator: DelegationCoordinator) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    const task = stringField(fields, "task");
    const maxSteps = integerField(fields, "maxSteps");
    const scopes = stringArray(fields.scopes, "scopes");
    return ok(await this.coordinator.start({ task, scopes, maxSteps }));
  }
}

export class DelegateStatusTool implements ToolPort {
  readonly name = "delegate.status";
  readonly definition: ToolDefinition = {
    name: this.name,
    description: "Read one isolated child's durable status, answer, step count, and reviewed patch summary.",
    inputSchema: idSchema(),
    effect: "observe",
  };

  constructor(private readonly coordinator: DelegationCoordinator) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    return ok(this.coordinator.get(stringField(objectInput(input), "id")));
  }
}

export class DelegateWaitTool implements ToolPort {
  readonly name = "delegate.wait";
  readonly definition: ToolDefinition = {
    name: this.name,
    description: "Wait for one child to settle, bounded by timeoutMs. A timed-out wait returns the still-running status and does not cancel it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Child id returned by delegate.start." },
        timeoutMs: { type: "integer", minimum: 1, maximum: 120_000, description: "Bounded wait; defaults to 30000." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    effect: "observe",
  };

  constructor(private readonly coordinator: DelegationCoordinator) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    const timeoutMs = fields.timeoutMs === undefined ? 30_000 : integerField(fields, "timeoutMs");
    if (timeoutMs > 120_000) throw new Error("delegate.wait timeoutMs may not exceed 120000.");
    return ok(await this.coordinator.wait(stringField(fields, "id"), timeoutMs));
  }
}

export class DelegateCancelTool implements ToolPort {
  readonly name = "delegate.cancel";
  readonly definition: ToolDefinition = {
    name: this.name,
    description: "Cancel a queued or running child. Cancellation never applies its candidate patch.",
    inputSchema: idSchema(),
    effect: "state",
  };

  constructor(private readonly coordinator: DelegationCoordinator) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    return ok(await this.coordinator.cancel(stringField(objectInput(input), "id")));
  }
}

export class DelegateMergeTool implements ToolPort {
  readonly name = "delegate.merge";
  readonly definition: ToolDefinition = {
    name: this.name,
    description: "Transactionally apply a completed child's reviewed patch to the disposable parent workspace. manifestHash must exactly match delegate.status; drift or conflicts are refused.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Completed child id." },
        manifestHash: { type: "string", description: "Exact 64-character review manifest hash." },
      },
      required: ["id", "manifestHash"],
      additionalProperties: false,
    },
    effect: "mutate",
  };

  constructor(private readonly coordinator: DelegationCoordinator) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    return ok(await this.coordinator.merge(stringField(fields, "id"), stringField(fields, "manifestHash")));
  }
}

function idSchema(): JsonValue {
  return {
    type: "object",
    properties: { id: { type: "string", description: "Child id returned by delegate.start." } },
    required: ["id"],
    additionalProperties: false,
  };
}

function objectInput(value: JsonValue): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error("Tool input must be an object.");
  return value;
}

function stringField(fields: Record<string, JsonValue>, name: string): string {
  const value = fields[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Field '${name}' must be a non-empty string.`);
  return value;
}

function integerField(fields: Record<string, JsonValue>, name: string): number {
  const value = fields[name];
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1) {
    throw new Error(`Field '${name}' must be a positive integer.`);
  }
  return value;
}

function stringArray(value: JsonValue | undefined, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    throw new Error(`Field '${name}' must be a non-empty string array.`);
  }
  return value as string[];
}

function ok(record: DelegateRecord): ToolResult {
  return { ok: true, output: JSON.parse(JSON.stringify(record)) as JsonValue };
}
