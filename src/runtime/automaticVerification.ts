import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { detectProjectVerification, type CommandSpec } from "./projectVerification.js";

export interface AutomaticVerificationResult {
  readonly status: "passed" | "failed" | "missing";
  readonly commands: readonly CommandSpec[];
  readonly exitCode: number;
}

export async function runAutomaticVerification(workspace: string): Promise<AutomaticVerificationResult> {
  const detected = await detectProjectVerification(workspace);
  const commands = detected === undefined ? await fallbackCommands(workspace) : [detected];
  if (commands.length === 0) {
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
  if (specification.command.toLocaleLowerCase() !== "npm") return specification;
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return { command: process.execPath, args: [npmCli, ...specification.args] };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
