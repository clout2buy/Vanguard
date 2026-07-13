import type { JsonValue, RunEvent } from "../kernel/contracts.js";

export const PUBLIC_EVENT_PREFIX = "@@VANGUARD_EVENT@@";

export interface PublicRunEvent {
  readonly type: string;
  readonly agentId: string;
  readonly sequence?: number;
  readonly turn?: number;
  readonly status?: "pending" | "passed" | "failed" | "info";
  readonly title: string;
  readonly detail?: string;
  readonly message?: string;
  readonly tool?: string;
  readonly sessionId?: string;
  readonly sessionRoot?: string;
  readonly workspaceRoot?: string;
  readonly journalFile?: string;
  readonly scorecardFile?: string;
}

export class PublicRunEventPresenter {
  #modelTurns = 0;
  #pendingTool: { name: string; detail?: string } | undefined;
  #lastMessage = "";

  present(event: RunEvent): PublicRunEvent[] {
    const agentId = agentIdFrom(event.data);
    if (event.type === "model.decided") {
      this.#modelTurns += 1;
      const data = objectValue(event.data);
      const kind = typeof data.kind === "string" ? data.kind : "unknown";
      const message = assistantMessage(data);
      const presented: PublicRunEvent[] = [];
      if (message !== undefined && message !== this.#lastMessage) {
        this.#lastMessage = message;
        presented.push({
          type: "agent.message",
          agentId,
          sequence: event.sequence,
          turn: this.#modelTurns,
          status: "info",
          title: "Agent",
          message,
        });
      }
      if (kind === "tool") {
        const call = objectValue(data.call);
        const name = typeof call.name === "string" ? call.name : "unknown tool";
        const detail = toolDetail(name, call.input);
        this.#pendingTool = { name, ...(detail === undefined ? {} : { detail }) };
        presented.push({
          type: "tool.started",
          agentId,
          sequence: event.sequence,
          turn: this.#modelTurns,
          status: "pending",
          title: name,
          tool: name,
          ...(detail === undefined ? {} : { detail }),
        });
      } else {
        this.#pendingTool = undefined;
        presented.push({
          type: "completion.claimed",
          agentId,
          sequence: event.sequence,
          turn: this.#modelTurns,
          status: "pending",
          title: "Completion claimed",
          detail: "Independent verification is running",
        });
      }
      return presented;
    }

    if (event.type === "tool.completed" || event.type === "tool.failed") {
      const data = objectValue(event.data);
      const ok = event.type === "tool.completed" && data.ok !== false;
      const tool = this.#pendingTool?.name ?? "tool";
      const detail = resultDetail(data, this.#pendingTool?.detail);
      this.#pendingTool = undefined;
      return [{
        type: event.type === "tool.completed" ? "tool.completed" : "tool.failed",
        agentId,
        sequence: event.sequence,
        status: ok ? "passed" : "failed",
        title: tool,
        tool,
        ...(detail === undefined ? {} : { detail }),
      }];
    }

    if (event.type === "verification.completed") {
      const data = objectValue(event.data);
      const passed = data.passed === true;
      const verifier = typeof data.verifier === "string" ? data.verifier : "verifier";
      return [{
        type: "verification.completed",
        agentId,
        sequence: event.sequence,
        status: passed ? "passed" : "failed",
        title: verifier,
        detail: passed ? "passed" : "failed",
      }];
    }

    if (event.type === "context.compacted") {
      const data = objectValue(event.data);
      const full = typeof data.fullBytes === "number" ? data.fullBytes : undefined;
      const selected = typeof data.selectedBytes === "number" ? data.selectedBytes : undefined;
      return [{
        type: "context.compacted",
        agentId,
        sequence: event.sequence,
        status: "info",
        title: "Context compacted",
        ...(full === undefined || selected === undefined ? {} : { detail: `${formatBytes(full)} → ${formatBytes(selected)}` }),
      }];
    }

    if (event.type === "run.failed") {
      const data = objectValue(event.data);
      return [{
        type: "run.failed",
        agentId,
        sequence: event.sequence,
        status: "failed",
        title: "Run stopped",
        detail: stringValue(data.reason) ?? stringValue(data.error) ?? "Run failed",
      }];
    }

    if (event.type === "run.completed") {
      return [{
        type: "run.completed",
        agentId,
        sequence: event.sequence,
        status: "passed",
        title: "Run completed",
      }];
    }

    return [];
  }
}

export function encodePublicRunEvent(event: PublicRunEvent): string {
  return `${PUBLIC_EVENT_PREFIX}${JSON.stringify(event)}\n`;
}

function assistantMessage(data: Record<string, JsonValue>): string | undefined {
  if (data.kind === "complete") return boundedText(stringValue(data.answer));
  const continuation = objectValue(data.continuation);
  return boundedText(contentText(continuation.content));
}

function contentText(content: JsonValue | undefined): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((item) => {
    const block = objectValue(item);
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
  return text.length === 0 ? undefined : text;
}

function toolDetail(name: string, input: JsonValue | undefined): string | undefined {
  const fields = objectValue(input);
  const path = stringValue(fields.path);
  if (path !== undefined) return path;
  if (name === "process.run") {
    const command = stringValue(fields.command) ?? "process";
    const args = Array.isArray(fields.args) ? fields.args.filter((item): item is string => typeof item === "string") : [];
    return boundedText([command, ...args].join(" "), 180);
  }
  if (name === "project.check") return "trusted project verification";
  if (name === "run.checkpoint") return "durable working state";
  return undefined;
}

function resultDetail(data: Record<string, JsonValue>, priorDetail: string | undefined): string | undefined {
  const output = objectValue(data.output);
  const error = stringValue(data.error) ?? stringValue(output.error);
  if (error !== undefined) return boundedText(error, 220);
  const exitCode = typeof output.exitCode === "number" ? output.exitCode : undefined;
  if (exitCode !== undefined) return `exit ${exitCode}`;
  const path = stringValue(output.path);
  if (path !== undefined) {
    const replacements = typeof output.replacements === "number" ? ` · ${output.replacements} replacement(s)` : "";
    return `${path}${replacements}`;
  }
  if (typeof output.changedFiles === "number") return `${output.changedFiles} changed file(s)`;
  return priorDetail;
}

function agentIdFrom(data: JsonValue): string {
  const value = objectValue(data).agentId;
  return typeof value === "string" && value.length > 0 ? value : "main";
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedText(value: string | undefined, max = 900): string | undefined {
  if (value === undefined) return undefined;
  const compact = value.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (compact.length === 0) return undefined;
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
