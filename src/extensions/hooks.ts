import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "../kernel/contracts.js";
import { createSecretRedactor } from "../engine/security.js";
import { WorkspaceBoundary } from "../runtime/workspace.js";
import type { HookDeclaration, HookWhen } from "./config.js";
import { ExtensionPermissionPolicy } from "./customTools.js";

export interface ExtensionAuditEvent {
  readonly type: "hook.outcome" | "mcp.lifecycle";
  readonly name: string;
  readonly status: "passed" | "failed" | "timed-out" | "started" | "stopped";
  readonly detail: JsonValue;
}

export interface ExtensionAuditPort {
  record(event: ExtensionAuditEvent): Promise<void>;
}

interface AuditEnvelope {
  readonly previousHash: string;
  readonly hash: string;
  readonly event: ExtensionAuditEvent;
}

const AUDIT_GENESIS = "0".repeat(64);

/** Durable hash-chained audit for hook outcomes and MCP lifecycle events. */
export class FileExtensionAuditJournal implements ExtensionAuditPort {
  #lastHash: string;
  #tail: Promise<void> = Promise.resolve();

  private constructor(readonly file: string, lastHash: string) {
    this.#lastHash = lastHash;
  }

  static async open(file: string): Promise<FileExtensionAuditJournal> {
    const absolute = path.resolve(file);
    await mkdir(path.dirname(absolute), { recursive: true });
    try { await writeFile(absolute, "", { flag: "wx" }); } catch (error) { if (!isExisting(error)) throw error; }
    const envelopes = await readAudit(absolute);
    return new FileExtensionAuditJournal(absolute, envelopes.at(-1)?.hash ?? AUDIT_GENESIS);
  }

  record(event: ExtensionAuditEvent): Promise<void> {
    const operation = this.#tail.then(async () => {
      const previousHash = this.#lastHash;
      const hash = auditHash(previousHash, event);
      await appendFile(this.file, `${JSON.stringify({ previousHash, hash, event } satisfies AuditEnvelope)}\n`, "utf8");
      this.#lastHash = hash;
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  async readValidated(): Promise<readonly ExtensionAuditEvent[]> {
    await this.#tail;
    return (await readAudit(this.file)).map((entry) => entry.event);
  }
}

export interface HookOutcome {
  readonly hook: string;
  readonly when: HookWhen;
  readonly passed: boolean;
  readonly blocked: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export class HookRunner {
  readonly #redact: (text: string) => string;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(
    private readonly workspace: WorkspaceBoundary,
    private readonly policy: ExtensionPermissionPolicy,
    private readonly hooks: readonly HookDeclaration[],
    private readonly audit: ExtensionAuditPort,
    environment: NodeJS.ProcessEnv = process.env,
    private readonly maxOutputBytes = 64 * 1024,
  ) {
    this.#redact = createSecretRedactor(environment);
    this.#environment = { ...environment };
  }

  async run(when: HookWhen, signal: AbortSignal): Promise<readonly HookOutcome[]> {
    const outcomes: HookOutcome[] = [];
    for (const hook of this.hooks.filter((candidate) => candidate.when === when).sort((a, b) => a.name.localeCompare(b.name))) {
      this.policy.authorizeHook(hook.name);
      this.policy.authorizeCommand(hook.command);
      const outcome = await this.#execute(hook, signal);
      outcomes.push(outcome);
      await this.audit.record({
        type: "hook.outcome",
        name: hook.name,
        status: outcome.timedOut ? "timed-out" : outcome.passed ? "passed" : "failed",
        detail: outcome as unknown as JsonValue,
      });
      if (!outcome.passed && hook.failure === "fail-closed") {
        throw new Error(`Hook '${hook.name}' failed under fail-closed policy.`);
      }
    }
    return outcomes;
  }

  async #execute(hook: HookDeclaration, signal: AbortSignal): Promise<HookOutcome> {
    const cwd = await this.workspace.existing(hook.cwd ?? ".");
    return new Promise((resolve) => {
      const child = spawn(hook.command, [...hook.args], {
        cwd,
        shell: false,
        windowsHide: true,
        env: safeEnvironment(this.#environment),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let settled = false;
      let timedOut = false;
      const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> =>
        Buffer.concat([current, chunk]).subarray(0, this.maxOutputBytes);
      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        const passed = !timedOut && !signal.aborted && exitCode === 0;
        resolve({
          hook: hook.name,
          when: hook.when,
          passed,
          blocked: !passed && hook.failure === "fail-closed",
          exitCode,
          stdout: this.#redact(stdout.toString("utf8")),
          stderr: this.#redact(stderr.toString("utf8")),
          timedOut,
        });
      };
      const abort = (): void => { child.kill(); finish(null); };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.on("error", (error) => {
        stderr = append(stderr, Buffer.from(error.message));
        finish(null);
      });
      child.on("close", (code) => finish(code));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        finish(null);
      }, hook.timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}

function safeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = process.platform === "win32"
    ? ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "PATHEXT", "COMSPEC"]
    : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
  const safe: NodeJS.ProcessEnv = {};
  for (const name of names) if (environment[name] !== undefined) safe[name] = environment[name];
  safe.VANGUARD_HOOK = "1";
  return safe;
}

async function readAudit(file: string): Promise<readonly AuditEnvelope[]> {
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  const output: AuditEnvelope[] = [];
  let previousHash = AUDIT_GENESIS;
  for (const [index, line] of lines.entries()) {
    const envelope = JSON.parse(line) as AuditEnvelope;
    if (envelope.previousHash !== previousHash || envelope.hash !== auditHash(previousHash, envelope.event)) {
      throw new Error(`Extension audit integrity failure at line ${index + 1}.`);
    }
    output.push(envelope);
    previousHash = envelope.hash;
  }
  return output;
}

function auditHash(previousHash: string, event: ExtensionAuditEvent): string {
  return createHash("sha256").update(previousHash).update("\n").update(JSON.stringify(event)).digest("hex");
}

function isExisting(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
