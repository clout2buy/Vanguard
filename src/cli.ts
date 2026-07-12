#!/usr/bin/env node
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AgentKernel,
  CommandVerifier,
  FileJournal,
  HttpModelAdapter,
  ListFilesTool,
  ProcessTool,
  ReadFileTool,
  ReplaceTextTool,
  SearchTextTool,
  WorkspaceBoundary,
  WriteFileTool,
  createAnthropicModel,
  createCodingSession,
  createDeepSeekModel,
  createOpenAIModel,
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
  const aliases = commandAliases();
  const allowedCommands = [...new Set([
    "node",
    "npm",
    "npx",
    "git",
    options.verification.command,
    ...options.allowedCommands,
  ])];
  const processTool = new ProcessTool(workspace, {
    allowedCommands,
    commandAliases: aliases,
    timeoutMs: 600_000,
    maxOutputBytes: 2_000_000,
  });
  const container = path.dirname(session.workspaceRoot);
  const journalFile = path.join(container, "run.jsonl");
  const scorecardFile = path.join(container, "scorecard.json");
  const journal = await FileJournal.open(journalFile);
  const model = createModel(options);
  const kernel = new AgentKernel({
    model,
    tools: [
      new ListFilesTool(workspace),
      new SearchTextTool(workspace),
      new ReadFileTool(workspace),
      new WriteFileTool(workspace),
      new ReplaceTextTool(workspace),
      processTool,
    ],
    verifiers: [new CommandVerifier("required command", processTool, options.verification)],
    journal,
    options: { maxSteps: options.maxSteps, maxContextBytes: 2_000_000, maxRepeatedAction: 3 },
  });

  const startedAt = Date.now();
  const outcome = await kernel.run(options.task);
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
    grade: {
      verified: outcome.status === "completed",
      score: outcome.status === "completed" ? 1 : 0,
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
    maxSteps,
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

function commandAliases(): Record<string, { executable: string; argsPrefix: string[] }> {
  const npmBin = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin");
  return {
    node: { executable: process.execPath, argsPrefix: [] },
    npm: { executable: process.execPath, argsPrefix: [path.join(npmBin, "npm-cli.js")] },
    npx: { executable: process.execPath, argsPrefix: [path.join(npmBin, "npx-cli.js")] },
  };
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

function printUsage(): void {
  process.stdout.write(`Vanguard coding-agent preview\n\nUsage:\n  vanguard run --workspace PATH --task TEXT --provider openai|anthropic|deepseek --model MODEL [options]\n\nOptions:\n  --verify-command CMD     Required verifier executable when auto-detection is unavailable\n  --verify-arg ARG         Repeat for each verifier argument\n  --allow-command CMD      Repeat to expose another executable to the agent\n  --endpoint URL           Override provider endpoint, or required for provider=http\n  --max-steps N            Agent step budget (default: 60)\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Vanguard failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
