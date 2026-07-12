#!/usr/bin/env node
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JournalPort, RunEvent, VerifierPort } from "./kernel/contracts.js";
import {
  AgentKernel,
  CheckpointTool,
  CommandVerifier,
  FileJournal,
  HttpModelAdapter,
  ListFilesTool,
  ProcessTool,
  ReadFileTool,
  ReplaceTextTool,
  RunCheckpointLedger,
  SearchTextTool,
  WorkspaceBoundary,
  WorkspaceIntegrityVerifier,
  WorkspaceVersionLedger,
  WriteFileTool,
  createAnthropicModel,
  createCodingSession,
  createDeepSeekModel,
  createOpenAIModel,
  analyzeTrajectory,
  analyzePatch,
  scoreExecutionQuality,
  classifyOutcome,
} from "./index.js";

interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
}

interface CliOptions {
  readonly workspace: string;
  readonly task: string;
  readonly provider: "openai" | "anthropic" | "deepseek" | "http";
  readonly model: string;
  readonly endpoint?: string;
  readonly verification: CommandSpec;
  readonly allowedCommands: readonly string[];
  readonly maxSteps: number;
  readonly maxDurationMs: number;
  readonly maxFailedVerificationAttempts: number;
  readonly protectedPaths: readonly string[];
  readonly editableRoots: readonly string[];
  readonly restrictProcess: boolean;
  readonly verifierEvidence: "full" | "summary";
}

async function main(): Promise<void> {
  if (process.argv[2] !== "run") {
    printUsage();
    process.exitCode = 2;
    return;
  }
  const options = await parseOptions(process.argv.slice(3));
  const session = await createCodingSession(options.workspace);
  const workspace = new WorkspaceBoundary(session.workspaceRoot);
  const versions = new WorkspaceVersionLedger();
  const workingState = new RunCheckpointLedger();
  const agentAllowedCommands = options.restrictProcess
    ? [...new Set(["node", ...options.allowedCommands])]
    : [...new Set(["node", "npm", "npx", "git", options.verification.command, ...options.allowedCommands])];
  const processTool = new ProcessTool(workspace, {
    allowedCommands: agentAllowedCommands,
    commandAliases: commandAliases(session.workspaceRoot, options.restrictProcess),
    deniedArgumentPrefixes: options.restrictProcess ? ["--allow-", "--no-experimental-permission"] : [],
    deniedArgumentSubstrings: options.restrictProcess ? ["console.assert"] : [],
    timeoutMs: 600_000,
    maxOutputBytes: 2_000_000,
  });
  const verifierProcessTool = new ProcessTool(workspace, {
    allowedCommands: [options.verification.command],
    commandAliases: commandAliases(session.workspaceRoot, false),
    timeoutMs: 600_000,
    maxOutputBytes: 2_000_000,
  });
  const container = path.dirname(session.workspaceRoot);
  const journalFile = path.join(container, "run.jsonl");
  const scorecardFile = path.join(container, "scorecard.json");
  const fileJournal = await FileJournal.open(journalFile);
  const journal = progressJournal(fileJournal);
  const model = createModel(options);
  const verifiers: VerifierPort[] = [
    new CommandVerifier("required command", verifierProcessTool, options.verification, options.verifierEvidence),
  ];
  if (options.protectedPaths.length > 0 || options.editableRoots.length > 0) {
    verifiers.push(new WorkspaceIntegrityVerifier({
      sourceRoot: session.sourceRoot,
      workspaceRoot: session.workspaceRoot,
      protectedPaths: options.protectedPaths,
      editableRoots: options.editableRoots,
    }));
  }
  const kernel = new AgentKernel({
    model,
    tools: [
      new ListFilesTool(workspace),
      new SearchTextTool(workspace),
      new ReadFileTool(workspace, 1_000_000, versions),
      new WriteFileTool(workspace, versions),
      new ReplaceTextTool(workspace, versions),
      new CheckpointTool(workingState),
      processTool,
    ],
    verifiers,
    journal,
    workingState,
    options: {
      maxSteps: options.maxSteps,
      maxContextBytes: 2_000_000,
      maxRepeatedAction: 3,
      maxFailedVerificationAttempts: options.maxFailedVerificationAttempts,
    },
  });

  const startedAt = Date.now();
  const controller = new AbortController();
  const durationTimer = setTimeout(() => controller.abort(), options.maxDurationMs);
  const outcome = await kernel.run(options.task, controller.signal).finally(() => clearTimeout(durationTimer));
  const trajectory = analyzeTrajectory(await fileJournal.readValidated());
  const patch = await analyzePatch(session.sourceRoot, session.workspaceRoot);
  const verified = outcome.status === "completed";
  const classification = classifyOutcome(outcome);
  const executionQuality = scoreExecutionQuality(verified, trajectory, patch);
  const scorecard = {
    version: 1,
    sessionId: session.id,
    sourceRoot: session.sourceRoot,
    workspaceRoot: session.workspaceRoot,
    provider: options.provider,
    model: options.model,
    task: options.task,
    verification: options.verification,
    outcome,
    trajectory,
    patch,
    grade: {
      verified,
      classification,
      score: classification === "infrastructure_error" ? null : verified ? 1 : 0,
      executionQuality,
      steps: outcome.steps,
    },
    durationMs: Date.now() - startedAt,
    journalFile,
    completedAt: new Date().toISOString(),
  };
  await writeFile(scorecardFile, JSON.stringify(scorecard, null, 2));
  process.stdout.write(`${JSON.stringify({ ...scorecard, scorecardFile }, null, 2)}\n`);
  if (outcome.status !== "completed") process.exitCode = 1;
}

function createModel(options: CliOptions) {
  const common = { model: options.model, timeoutMs: 600_000, maxAttempts: 4 };
  if (options.provider === "openai") return createOpenAIModel({ ...common, ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
  if (options.provider === "anthropic") return createAnthropicModel({ ...common, ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
  if (options.provider === "deepseek") return createDeepSeekModel({ ...common, ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
  if (options.endpoint === undefined) throw new Error("--endpoint is required for the http provider.");
  return new HttpModelAdapter({ endpoint: options.endpoint, timeoutMs: common.timeoutMs, maxAttempts: common.maxAttempts });
}

async function parseOptions(args: readonly string[]): Promise<CliOptions> {
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near '${key ?? "end of command"}'. Options require --name value pairs.`);
    }
    const existing = values.get(key) ?? [];
    existing.push(value);
    values.set(key, existing);
  }
  const workspace = required(values, "--workspace");
  const task = required(values, "--task");
  const provider = required(values, "--provider");
  if (provider !== "openai" && provider !== "anthropic" && provider !== "deepseek" && provider !== "http") {
    throw new Error("--provider must be openai, anthropic, deepseek, or http.");
  }
  const model = required(values, "--model");
  const maxSteps = Number(single(values, "--max-steps") ?? "60");
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error("--max-steps must be a positive integer.");
  const maxDurationMs = Number(single(values, "--max-duration-ms") ?? "900000");
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1) {
    throw new Error("--max-duration-ms must be a positive integer.");
  }
  const maxFailedVerificationAttempts = Number(single(values, "--max-verification-attempts") ?? "3");
  if (!Number.isSafeInteger(maxFailedVerificationAttempts) || maxFailedVerificationAttempts < 1) {
    throw new Error("--max-verification-attempts must be a positive integer.");
  }
  const explicitCommand = single(values, "--verify-command");
  const verification = explicitCommand === undefined
    ? await detectVerification(workspace)
    : { command: explicitCommand, args: values.get("--verify-arg") ?? [] };
  if (verification === undefined) {
    throw new Error("Could not detect project verification. Supply --verify-command and repeat --verify-arg for its arguments.");
  }
  return {
    workspace,
    task,
    provider,
    model,
    verification,
    allowedCommands: values.get("--allow-command") ?? [],
    protectedPaths: values.get("--protect") ?? [],
    editableRoots: values.get("--editable-root") ?? [],
    restrictProcess: parseBoolean(single(values, "--restrict-process") ?? "false", "--restrict-process"),
    verifierEvidence: parseEvidenceMode(single(values, "--verifier-evidence") ?? "full"),
    maxSteps,
    maxDurationMs,
    maxFailedVerificationAttempts,
    ...(single(values, "--endpoint") === undefined ? {} : { endpoint: single(values, "--endpoint")! }),
  };
}

async function detectVerification(workspace: string): Promise<CommandSpec | undefined> {
  const root = path.resolve(workspace);
  try {
    const parsed = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    if (typeof parsed.scripts?.test === "string") return { command: "npm", args: ["test"] };
  } catch {}
  if (await exists(path.join(root, "pyproject.toml")) || await exists(path.join(root, "pytest.ini"))) {
    return { command: "python", args: ["-m", "pytest"] };
  }
  if (await exists(path.join(root, "Cargo.toml"))) return { command: "cargo", args: ["test"] };
  return undefined;
}

function commandAliases(
  workspaceRoot: string,
  restricted: boolean,
): Record<string, { executable: string; argsPrefix: string[] }> {
  const npmBin = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin");
  const nodePrefix = restricted
    ? ["--experimental-permission", `--allow-fs-read=${workspaceRoot}`, `--allow-fs-write=${workspaceRoot}`]
    : [];
  return {
    node: { executable: process.execPath, argsPrefix: nodePrefix },
    npm: { executable: process.execPath, argsPrefix: [path.join(npmBin, "npm-cli.js")] },
    npx: { executable: process.execPath, argsPrefix: [path.join(npmBin, "npx-cli.js")] },
  };
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function parseEvidenceMode(value: string): "full" | "summary" {
  if (value === "full" || value === "summary") return value;
  throw new Error("--verifier-evidence must be full or summary.");
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function required(values: ReadonlyMap<string, string[]>, name: string): string {
  const value = single(values, name);
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function single(values: ReadonlyMap<string, string[]>, name: string): string | undefined {
  const all = values.get(name);
  if (all !== undefined && all.length > 1) throw new Error(`${name} may only be supplied once.`);
  return all?.[0];
}

function progressJournal(fileJournal: FileJournal): JournalPort {
  let modelTurns = 0;
  return {
    async append(event: RunEvent): Promise<void> {
      await fileJournal.append(event);
      if (event.type === "model.decided") {
        modelTurns += 1;
        const decision = event.data as { kind?: string; call?: { name?: string } };
        const action = decision.kind === "tool" ? decision.call?.name ?? "unknown tool" : "completion claim";
        process.stderr.write(`[Vanguard] turn ${modelTurns}: ${action}\n`);
      } else if (event.type === "verification.completed") {
        const verification = event.data as { verifier?: string; passed?: boolean };
        process.stderr.write(
          `[Vanguard] verifier ${verification.verifier ?? "unknown"}: ${verification.passed ? "passed" : "failed"}\n`,
        );
      } else if (event.type === "run.failed") {
        const failure = event.data as { reason?: string };
        process.stderr.write(`[Vanguard] stopped: ${failure.reason ?? "run failed"}\n`);
      }
    },
  };
}

function printUsage(): void {
  process.stdout.write(`Vanguard coding-agent preview\n\nUsage:\n  vanguard run --workspace PATH --task TEXT --provider openai|anthropic|deepseek --model MODEL [options]\n\nOptions:\n  --verify-command CMD     Required verifier executable when auto-detection is unavailable\n  --verify-arg ARG         Repeat for each verifier argument\n  --allow-command CMD      Repeat to expose another executable to the agent\n  --protect PATH           Repeat for files that must remain byte-identical\n  --editable-root PATH     Repeat to restrict all changes to these roots\n  --restrict-process BOOL  Confine Node subprocess filesystem access to the workspace\n  --verifier-evidence MODE Use full or summary verifier feedback\n  --endpoint URL           Override provider endpoint, or required for provider=http\n  --max-steps N            Agent step budget (default: 60)\n  --max-duration-ms N      Wall-clock run budget (default: 900000)\n  --max-verification-attempts N  Failed completion-claim budget (default: 3)\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Vanguard failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
