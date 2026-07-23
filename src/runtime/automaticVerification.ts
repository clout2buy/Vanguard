import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type { VerificationResult, VerifierPort } from "../kernel/contracts.js";
import { detectProjectVerification, type CommandSpec } from "./projectVerification.js";
import { resolveNodePackageManagerAlias } from "./nodePackageManager.js";
import { asciiLowercase } from "../deterministicText.js";

/**
 * Reserved verification-command name that the runtime executes in-process via
 * {@link AdaptiveCommandVerifier} instead of spawning an executable. It makes
 * adaptive verification available to every embedder — including hosts that
 * bundle Vanguard into a single file, where no packaged script path exists on
 * disk. Spelled with a colon so no real executable can collide with it.
 */
export const ADAPTIVE_VERIFY_COMMAND = "vanguard:adaptive-verify";

export function isAdaptiveVerifyCommand(specification: { readonly command: string }): boolean {
  return specification.command === ADAPTIVE_VERIFY_COMMAND;
}

/** The mode carried in a builtin adaptive verification command's args. */
export function adaptiveVerifyMode(specification: { readonly args: readonly string[] }): VerificationMode {
  const flag = specification.args.indexOf("--mode");
  return parseVerificationMode(flag === -1 ? undefined : specification.args[flag + 1]);
}

export interface AutomaticVerificationResult {
  readonly status: "passed" | "failed" | "missing" | "not_required";
  readonly commands: readonly CommandSpec[];
  readonly exitCode: number;
}

/**
 * How hard a missing verification contract is.
 *
 * `tests` — the default and the strict reading: no contract is a failure, so the
 * agent must establish a deterministic build/test contract before it can claim
 * completion. Right for a codebase.
 *
 * `build` — verify what exists, do not demand what does not. A detected contract
 * still runs and still gates completion; only its *absence* stops being fatal.
 * Without this, a deliverable with no natural test — a static page, a script, a
 * document — can never be completed no matter what the agent produces, because
 * the sealed verifier fails before it is even asked about the work.
 */
export type VerificationMode = "tests" | "build";

export function parseVerificationMode(value: string | undefined): VerificationMode {
  return value?.trim().toLowerCase() === "build" ? "build" : "tests";
}

export async function runAutomaticVerification(
  workspace: string,
  mode: VerificationMode = "tests",
  sink?: (line: string) => void,
): Promise<AutomaticVerificationResult> {
  // Without a sink, diagnostics go to this process's own streams (the packaged
  // autoVerify shim). In-process embedders MUST pass a sink: a daemon's stdout
  // is often a wire protocol that stray build output would corrupt.
  const out = sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const detected = await detectProjectVerification(workspace);
  const commands = detected === undefined ? await fallbackCommands(workspace) : [detected];
  if (commands.length === 0) {
    if (mode === "build") {
      // Say plainly what was and was not checked; this must never read as a
      // passing test suite.
      out(
        "[verify] no build or test contract in this project; completion rests on tool evidence "
        + "(files written and syntax-checked), not on an independent test run.",
      );
      return { status: "not_required", commands: [], exitCode: 0 };
    }
    err(
      "Vanguard could not find a project verification contract. "
      + "Create a package.json test/check/build script, Gradle wrapper, pyproject.toml, Cargo.toml, pom.xml, or CMakeLists.txt.",
    );
    return { status: "missing", commands: [], exitCode: 2 };
  }

  for (const command of commands) {
    out(`[verify] ${command.command} ${command.args.join(" ")}`);
    const exitCode = await runCommand(command, workspace, sink);
    if (exitCode !== 0) return { status: "failed", commands, exitCode };
  }
  return { status: "passed", commands, exitCode: 0 };
}

/**
 * The builtin adaptive verifier: same behavior as the packaged autoVerify
 * shim, executed in-process with captured output, so it works in any host —
 * bundled or not — and in any workspace, project or blank.
 */
export class AdaptiveCommandVerifier implements VerifierPort {
  constructor(
    readonly name: string,
    private readonly workspaceRoot: string,
    private readonly mode: VerificationMode,
  ) {}

  async verify(_candidate: string, _task: string): Promise<VerificationResult> {
    const lines: string[] = [];
    let bytes = 0;
    const collect = (line: string): void => {
      if (bytes >= 262_144) return;
      bytes += line.length + 1;
      lines.push(line.slice(0, 8_192));
    };
    const result = await runAutomaticVerification(this.workspaceRoot, this.mode, collect);
    return {
      verifier: this.name,
      passed: result.exitCode === 0,
      evidence: {
        status: result.status,
        exitCode: result.exitCode,
        commands: result.commands.map((command) => `${command.command} ${command.args.join(" ")}`),
        output: lines.join("\n"),
      },
    };
  }
}

async function fallbackCommands(workspace: string): Promise<CommandSpec[]> {
  if (await exists(path.join(workspace, "CMakeLists.txt"))) {
    return [
      { command: "cmake", args: ["-S", ".", "-B", ".vanguard-build"] },
      { command: "cmake", args: ["--build", ".vanguard-build", "--config", "Release"] },
    ];
  }
  return [];
}

async function runCommand(specification: CommandSpec, workspace: string, sink?: (line: string) => void): Promise<number> {
  const resolved = resolveCommand(specification);
  return await new Promise<number>((resolve) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd: workspace,
      shell: false,
      windowsHide: true,
      // Captured when a sink is provided (in-process hosts whose stdout is a
      // protocol stream); inherited for the standalone shim, as before.
      stdio: sink === undefined ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    if (sink !== undefined) {
      const forward = (chunk: unknown): void => {
        for (const line of String(chunk).split(/\r?\n/u)) if (line.length > 0) sink(line);
      };
      child.stdout?.on("data", forward);
      child.stderr?.on("data", forward);
    }
    child.once("error", (error) => {
      if (sink === undefined) process.stderr.write(`${error.message}\n`);
      else sink(error.message);
      resolve(1);
    });
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function resolveCommand(specification: CommandSpec): CommandSpec {
  if (asciiLowercase(specification.command) !== "npm") return specification;
  const npm = resolveNodePackageManagerAlias("npm");
  if (npm === undefined) {
    throw new Error("Could not locate npm-cli.js. Install npm with Node or launch Vanguard from an npm-managed environment.");
  }
  return { command: npm.executable, args: [...npm.argsPrefix, ...specification.args] };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
