import { spawn } from "node:child_process";
import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { objectInput, optionalStringField, stringArrayField, stringField } from "./input.js";
import { WorkspaceBoundary } from "./workspace.js";

export interface ProcessToolOptions {
  readonly allowedCommands: readonly string[];
  readonly commandAliases?: Readonly<Record<string, { readonly executable: string; readonly argsPrefix: readonly string[] }>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export class ProcessTool implements ToolPort {
  readonly name = "process.run";
  readonly definition: ToolDefinition = {
    name: this.name,
    description: "Run one allowlisted executable without a command shell and capture its exit state.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Allowlisted executable name or path." },
        args: { type: "array", items: { type: "string" }, description: "Argument vector; no shell parsing occurs." },
        cwd: { type: "string", description: "Optional workspace-relative working directory." },
      },
      required: ["command", "args"],
      additionalProperties: false,
    },
  };
  readonly #allowedCommands: ReadonlySet<string>;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #commandAliases: ReadonlyMap<string, { readonly executable: string; readonly argsPrefix: readonly string[] }>;

  constructor(
    private readonly workspace: WorkspaceBoundary,
    options: ProcessToolOptions,
  ) {
    this.#allowedCommands = new Set(options.allowedCommands.map(normalizeCommand));
    this.#commandAliases = new Map(
      Object.entries(options.commandAliases ?? {}).map(([name, alias]) => [normalizeCommand(name), alias]),
    );
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
  }

  async execute(input: JsonValue, context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    const command = stringField(fields, "command");
    const args = stringArrayField(fields, "args");
    const relativeCwd = optionalStringField(fields, "cwd") ?? ".";
    if (!this.#allowedCommands.has(normalizeCommand(command))) {
      return { ok: false, output: { error: "Command is not allowed.", command } };
    }
    const cwd = await this.workspace.existing(relativeCwd);
    const alias = this.#commandAliases.get(normalizeCommand(command));
    return runProcess(
      alias?.executable ?? command,
      [...(alias?.argsPrefix ?? []), ...args],
      cwd,
      this.#timeoutMs,
      this.#maxOutputBytes,
      context.signal,
    );
  }
}

async function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = (): void => {
      child.kill();
      finish({ ok: false, output: { error: "Process aborted." } });
    };
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> =>
      Buffer.concat([current, chunk]).subarray(0, maxOutputBytes);

    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => finish({ ok: false, output: { error: error.message } }));
    child.on("close", (code) => finish({
      ok: code === 0,
      output: { exitCode: code ?? -1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") },
    }));
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, output: { error: "Process timed out.", timeoutMs } });
    }, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function normalizeCommand(command: string): string {
  return command.trim().toLocaleLowerCase();
}
