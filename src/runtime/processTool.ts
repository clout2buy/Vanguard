import { spawn } from "node:child_process";
import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { objectInput, optionalStringField, stringArrayField, stringField } from "./input.js";
import { WorkspaceBoundary } from "./workspace.js";
import { sanitizedChildEnvironment } from "../engine/security.js";
import { asciiLowercase } from "../deterministicText.js";

export interface ProcessToolOptions {
  readonly allowedCommands: readonly string[];
  readonly commandAliases?: Readonly<Record<string, { readonly executable: string; readonly argsPrefix: readonly string[] }>>;
  readonly deniedArgumentPrefixes?: readonly string[];
  readonly deniedArgumentSubstrings?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Explicit child environment. Defaults to a credential/preload-sanitized copy. */
  readonly environment?: NodeJS.ProcessEnv;
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
    effect: "execute",
    // The runtime, not the model or an extension, captures the process exit
    // state. The kernel still suppresses this authority whenever the process
    // mutates the monitored workspace, so only a successful, non-mutating run
    // can satisfy the post-change execution-evidence freshness gate.
    evidenceAuthority: "independent-execution",
  };
  readonly #allowedCommands: ReadonlySet<string>;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #commandAliases: ReadonlyMap<string, { readonly executable: string; readonly argsPrefix: readonly string[] }>;
  readonly #deniedArgumentPrefixes: readonly string[];
  readonly #deniedArgumentSubstrings: readonly string[];
  readonly #environment: NodeJS.ProcessEnv;

  constructor(
    private readonly workspace: WorkspaceBoundary,
    options: ProcessToolOptions,
  ) {
    this.#allowedCommands = new Set(options.allowedCommands.map(normalizeCommand));
    this.#commandAliases = new Map(
      Object.entries(options.commandAliases ?? {}).map(([name, alias]) => [normalizeCommand(name), alias]),
    );
    this.#deniedArgumentPrefixes = options.deniedArgumentPrefixes ?? [];
    this.#deniedArgumentSubstrings = options.deniedArgumentSubstrings ?? [];
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    this.#environment = options.environment ?? sanitizedChildEnvironment();
  }

  async execute(input: JsonValue, context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    const command = stringField(fields, "command");
    const args = stringArrayField(fields, "args");
    const relativeCwd = optionalStringField(fields, "cwd") ?? ".";
    if (!this.#allowedCommands.has(normalizeCommand(command))) {
      return { ok: false, output: { error: "Command is not allowed.", command } };
    }
    const deniedArgument = args.find((argument) =>
      this.#deniedArgumentPrefixes.some((prefix) => asciiLowercase(argument).startsWith(asciiLowercase(prefix))),
    );
    if (deniedArgument !== undefined) {
      return { ok: false, output: { error: "Argument is blocked by process policy.", argument: deniedArgument } };
    }
    const deniedSubstring = this.#deniedArgumentSubstrings.find((substring) =>
      args.some((argument) => asciiLowercase(argument).includes(asciiLowercase(substring))),
    );
    if (deniedSubstring !== undefined) {
      return {
        ok: false,
        output: {
          error: "Argument contains a construct blocked by process evidence policy.",
          construct: deniedSubstring,
          guidance: "Use an assertion library that throws and produces a non-zero exit code on failure.",
        },
      };
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
      this.#environment,
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
  environment: NodeJS.ProcessEnv,
): Promise<ToolResult> {
  if (signal.aborted) return { ok: false, output: { error: "Process aborted before launch." } };
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, env: environment });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    let termination: "aborted" | "timed_out" | undefined;
    let terminationEscalation: NodeJS.Timeout | undefined;
    let containmentDeadline: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      if (current.length >= maxOutputBytes) return current;
      const remaining = maxOutputBytes - current.length;
      return Buffer.concat([current, chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)]);
    };
    const onStdout = (chunk: Buffer): void => { stdout = append(stdout, chunk); };
    const onStderr = (chunk: Buffer): void => { stderr = append(stderr, chunk); };
    const stopCapture = (): void => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (terminationEscalation !== undefined) clearTimeout(terminationEscalation);
      if (containmentDeadline !== undefined) clearTimeout(containmentDeadline);
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const terminate = (reason: "aborted" | "timed_out"): void => {
      if (settled || termination !== undefined) return;
      termination = reason;
      if (timer !== undefined) clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch { /* The exact close/deadline below remains authoritative. */ }
      terminationEscalation = setTimeout(() => {
        if (settled) return;
        try { child.kill("SIGKILL"); } catch { /* Report uncertainty if close still cannot be proven. */ }
        containmentDeadline = setTimeout(() => {
          stopCapture();
          finish({
            ok: false,
            output: {
              error: reason === "aborted"
                ? "Process abort could not prove direct-child closure."
                : "Process timeout could not prove direct-child closure.",
              containmentUncertain: true,
              ...(reason === "timed_out" ? { timeoutMs } : {}),
            },
          });
        }, 1_000);
      }, 1_000);
    };
    const abort = (): void => terminate("aborted");

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("error", (error) => {
      // A pre-dispatch spawn error has no live child. Once termination has
      // begun, however, only `close` (or the explicit uncertainty deadline)
      // may settle the operation.
      if (termination === undefined) finish({ ok: false, output: { error: error.message } });
    });
    child.on("close", (code, closeSignal) => finish(termination === undefined
      ? {
          ok: code === 0,
          output: { exitCode: code ?? -1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") },
        }
      : {
          ok: false,
          output: {
            error: termination === "aborted" ? "Process aborted." : "Process timed out.",
            ...(termination === "timed_out" ? { timeoutMs } : {}),
            exitCode: code ?? -1,
            signal: closeSignal ?? "",
            stdout: stdout.toString("utf8"),
            stderr: stderr.toString("utf8"),
            directChildClosed: true,
          },
        }));
    timer = setTimeout(() => terminate("timed_out"), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    // Cover an abort that raced the synchronous spawn/listener setup.
    if (signal.aborted) abort();
  });
}

function normalizeCommand(command: string): string {
  return asciiLowercase(command.trim());
}
