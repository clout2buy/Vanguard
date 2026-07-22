import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { detectProjectVerification, type CommandSpec } from "./projectVerification.js";
import { resolveNodePackageManagerAlias } from "./nodePackageManager.js";
import { asciiLowercase } from "../deterministicText.js";

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
): Promise<AutomaticVerificationResult> {
  const detected = await detectProjectVerification(workspace);
  const commands = detected === undefined ? await fallbackCommands(workspace) : [detected];
  if (commands.length === 0) {
    if (mode === "build") {
      // Say plainly what was and was not checked; this must never read as a
      // passing test suite.
      process.stdout.write(
        "[verify] no build or test contract in this project; completion rests on tool evidence "
        + "(files written and syntax-checked), not on an independent test run.\n",
      );
      return { status: "not_required", commands: [], exitCode: 0 };
    }
    process.stderr.write(
      "Vanguard could not find a project verification contract. "
      + "Create a package.json test/check/build script, Gradle wrapper, pyproject.toml, Cargo.toml, pom.xml, or CMakeLists.txt.\n",
    );
    return { status: "missing", commands: [], exitCode: 2 };
  }

  for (const command of commands) {
    process.stdout.write(`[verify] ${command.command} ${command.args.join(" ")}\n`);
    const exitCode = await runCommand(command, workspace);
    if (exitCode !== 0) return { status: "failed", commands, exitCode };
  }
  return { status: "passed", commands, exitCode: 0 };
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

async function runCommand(specification: CommandSpec, workspace: string): Promise<number> {
  const resolved = resolveCommand(specification);
  return await new Promise<number>((resolve) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd: workspace,
      shell: false,
      windowsHide: true,
      stdio: "inherit",
    });
    child.once("error", (error) => {
      process.stderr.write(`${error.message}\n`);
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
