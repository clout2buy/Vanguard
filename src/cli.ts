#!/usr/bin/env node
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JournalPort, RunEvent, VerifierPort } from "./kernel/contracts.js";
import {
  AgentKernel,
  CheckpointTool,
  CommandVerifier,
  DeleteFileTool,
  FileJournal,
  HttpModelAdapter,
  ListFilesTool,
  ProcessTool,
  ReadFileTool,
  ReplaceTextTool,
  ReviewChangesTool,
  RunCheckpointLedger,
  SearchTextTool,
  WorkspaceBoundary,
  WorkspaceIntegrityVerifier,
  WorkspaceMutationPolicy,
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
  openCodingSession,
  FixedCommandTool,
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
  readonly maxContextBytes: number;
  readonly maxFailedVerificationAttempts: number;
  readonly protectedPaths: readonly string[];
  readonly editableRoots: readonly string[];
  readonly restrictProcess: boolean;
  readonly verifierEvidence: "full" | "summary";
  readonly publicCheck?: CommandSpec;
  readonly exposeRawProcess: boolean;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "run" && command !== "resume") {
    printUsage();
    process.exitCode = 2;
    return;
  }
  const resuming = command === "resume";
  const session = resuming
    ? await openCodingSession(parseResumeSession(process.argv.slice(3)))
    : await createCodingSession(requiredArgument(process.argv.slice(3), "--workspace"));
  const container = path.dirname(session.workspaceRoot);
  const configurationFile = path.join(container, "run-config.json");
  const options = resuming
    ? await readRunConfiguration(configurationFile)
    : await parseOptions(process.argv.slice(3));
  if (!resuming) {
    await writeFile(configurationFile, JSON.stringify({ version: 1, options }, null, 2));
  }
  const workspace = new WorkspaceBoundary(session.workspaceRoot);
  const versions = new WorkspaceVersionLedger();
  const workingState = await RunCheckpointLedger.open(path.join(container, "checkpoint.json"));
  const mutationPolicy = new WorkspaceMutationPolicy(options.editableRoots, options.protectedPaths);
  const agentAllowedCommands = options.restrictProcess
    ? [...new Set(["node", ...options.allowedCommands])]
    : [...new Set(["node", "npm", "npx", "git", options.verification.command, ...options.allowedCommands])];
  const processTool = new ProcessTool(workspace, {
    allowedCommands: agentAllowedCommands,
    commandAliases: commandAliases(session.workspaceRoot, options.restrictProcess, mutationPolicy.writableAbsoluteRoots(session.workspaceRoot)),
    deniedArgumentPrefixes: options.restrictProcess ? ["--allow-", "--no-experimental-permission"] : [],
    deniedArgumentSubstrings: options.restrictProcess ? ["console.assert"] : [],
    timeoutMs: 600_000,
    maxOutputBytes: 2_000_000,
  });
  const verifierProcessTool = new ProcessTool(workspace, {
    allowedCommands: [options.verification.command],
    commandAliases: commandAliases(session.workspaceRoot, false, []),
    timeoutMs: 600_000,
    maxOutputBytes: 2_000_000,
  });
  const publicCheckTool = options.publicCheck === undefined ? undefined : new FixedCommandTool(
    "project.check",
    "Run the project's trusted public compile and test command with its fixed arguments.",
    new ProcessTool(workspace, {
      allowedCommands: [options.publicCheck.command],
      commandAliases: commandAliases(session.workspaceRoot, false, []),
      timeoutMs: 600_000,
      maxOutputBytes: 2_000_000,
    }),
    options.publicCheck,
  );
  const journalFile = path.join(container, "run.jsonl");
  const scorecardFile = path.join(container, "scorecard.json");
  const fileJournal = await FileJournal.open(journalFile);
  const priorEvents = resuming ? await fileJournal.readValidated() : [];
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
      new WriteFileTool(workspace, versions, mutationPolicy),
      new ReplaceTextTool(workspace, versions, mutationPolicy),
      new DeleteFileTool(workspace, versions, mutationPolicy),
      new ReviewChangesTool(session.sourceRoot, session.workspaceRoot),
      new CheckpointTool(workingState),
      ...(publicCheckTool === undefined ? [] : [publicCheckTool]),
      ...(options.exposeRawProcess ? [processTool] : []),
    ],
    verifiers,
    journal,
    workingState,
    options: {
      maxSteps: options.maxSteps,
      maxContextBytes: options.maxContextBytes,
      maxRepeatedAction: 3,
      maxFailedVerificationAttempts: options.maxFailedVerificationAttempts,
    },
  });

  const startedAt = Date.now();
  const controller = new AbortController();
  const durationTimer = setTimeout(() => controller.abort(), options.maxDurationMs);
  const runtimeTask = `${options.task}\n\nVanguard runtime mutation policy: ${mutationPolicy.describe()}`;
  const outcome = await kernel.run(runtimeTask, controller.signal, priorEvents).finally(() => clearTimeout(durationTimer));
  const trajectory = analyzeTrajectory(await fileJournal.readValidated());
  const patch = await analyzePatch(session.sourceRoot, session.workspaceRoot);
  const verified = outcome.status === "completed";
  const classification = classifyOutcome(outcome);
  const executionQuality = scoreExecutionQuality(verified, trajectory, patch);
  const scorecard = {
    version: 2,
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
    resumed: resuming,
    sessionFile: session.metadataFile,
    configurationFile,
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
  const maxDurationMs = Number(single(values, "--max-duration-ms") ?? "7200000");
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1) {
    throw new Error("--max-duration-ms must be a positive integer.");
  }
  const maxContextBytes = Number(single(values, "--max-context-bytes") ?? "2000000");
  if (!Number.isSafeInteger(maxContextBytes) || maxContextBytes < 1) {
    throw new Error("--max-context-bytes must be a positive integer.");
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
  const publicCheckCommand = single(values, "--check-command");
  if (publicCheckCommand === undefined && values.has("--check-arg")) {
    throw new Error("--check-arg requires --check-command.");
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
    exposeRawProcess: parseBoolean(single(values, "--expose-raw-process") ?? "true", "--expose-raw-process"),
    verifierEvidence: parseEvidenceMode(single(values, "--verifier-evidence") ?? "full"),
    ...(publicCheckCommand === undefined ? {} : {
      publicCheck: { command: publicCheckCommand, args: values.get("--check-arg") ?? [] },
    }),
    maxSteps,
    maxDurationMs,
    maxContextBytes,
    maxFailedVerificationAttempts,
    ...(single(values, "--endpoint") === undefined ? {} : { endpoint: single(values, "--endpoint")! }),
  };
}

async function readRunConfiguration(file: string): Promise<CliOptions> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as { version?: number; options?: CliOptions };
  if (parsed.version !== 1 || parsed.options === undefined) {
    throw new Error("Session run configuration is missing or unsupported.");
  }
  return parsed.options;
}

function parseResumeSession(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--session" || args[1] === undefined || args[1].length === 0) {
    throw new Error("Resume usage: vanguard resume --session SESSION_PATH");
  }
  return args[1];
}

function requiredArgument(args: readonly string[], name: string): string {
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === name && args[index + 1] !== undefined) return args[index + 1]!;
  }
  throw new Error(`${name} is required.`);
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
  writableRoots: readonly string[],
): Record<string, { executable: string; argsPrefix: string[] }> {
  const npmBin = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin");
  const nodePrefix = restricted
    ? [
        "--experimental-permission",
        `--allow-fs-read=${workspaceRoot}`,
        ...writableRoots.map((root) => `--allow-fs-write=${root}`),
      ]
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
  process.stdout.write(`Vanguard coding-agent preview\n\nUsage:\n  vanguard run --workspace PATH --task TEXT --provider openai|anthropic|deepseek --model MODEL [options]\n  vanguard resume --session SESSION_PATH\n\nOptions:\n  --verify-command CMD     Required sealed verifier executable when auto-detection is unavailable\n  --verify-arg ARG         Repeat for each sealed verifier argument\n  --check-command CMD      Trusted public compile/test executable exposed as project.check\n  --check-arg ARG          Repeat for each fixed public-check argument\n  --allow-command CMD      Repeat to expose another executable to the agent\n  --expose-raw-process BOOL Expose arbitrary allowlisted process.run calls (default: true)\n  --protect PATH           Repeat for files that must remain byte-identical\n  --editable-root PATH     Repeat to restrict all changes to these roots\n  --restrict-process BOOL  Confine Node subprocess filesystem access to the workspace\n  --verifier-evidence MODE Use full or summary verifier feedback\n  --endpoint URL           Override provider endpoint, or required for provider=http\n  --max-steps N            Total agent step budget across resumes (default: 60)\n  --max-duration-ms N      Wall-clock budget per invocation (default: 7200000 / two hours)\n  --max-context-bytes N    Provider context budget before evidence compaction (default: 2000000)\n  --max-verification-attempts N  Failed completion-claim budget (default: 3)\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Vanguard failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
