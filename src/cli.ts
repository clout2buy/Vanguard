#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { JournalPort, RunEvent, UserChannelPort, VerifierPort } from "./kernel/contracts.js";
import type { AgentKernel as AgentKernelType, RunOutcome } from "./kernel/run.js";
import { detectProjectVerification, type CommandSpec } from "./runtime/projectVerification.js";
import {
  AgentKernel,
  CheckpointTool,
  CommandVerifier,
  DeleteFileTool,
  FileJournal,
  HttpModelAdapter,
  ImageInspectionTool,
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
  createSessionShell,
  materializeSessionWorkspace,
  analyzeTrajectory,
  analyzePatch,
  scoreExecutionQuality,
  classifyOutcome,
  openCodingSession,
  FixedCommandTool,
  PlanLedger,
  PlanTool,
  PostEditSyntaxChecker,
  PublicRunEventPresenter,
  RepositoryMapTool,
  StickyContextPolicy,
  SyntaxCheckTool,
  SyntaxCommandRunner,
  UsageLedger,
  createStreamLifecyclePresenter,
  encodePublicRunEvent,
  type CodingSession,
  type StreamObserver,
} from "./index.js";

interface CliOptions {
  readonly workspace: string;
  readonly task: string;
  readonly provider: "openai" | "anthropic" | "deepseek" | "http";
  readonly model: string;
  readonly endpoint?: string;
  readonly verification: CommandSpec;
  readonly adaptiveVerification?: boolean;
  readonly allowedCommands: readonly string[];
  readonly maxSteps: number;
  readonly maxDurationMs: number;
  readonly commandTimeoutMs: number;
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
  if ((command === undefined || command === "tui") && process.stdin.isTTY && process.stdout.isTTY) {
    const { runTui } = await import("./tui.js");
    await runTui(process.cwd());
    return;
  }
  if (command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (command === "advance") {
    await advanceCommand(process.argv.slice(3));
    return;
  }
  if (command !== "run" && command !== "resume") {
    printUsage();
    process.exitCode = 2;
    return;
  }
  await runCommand(command === "resume", process.argv.slice(3));
}

async function runCommand(resuming: boolean, args: readonly string[]): Promise<void> {
  const session = resuming
    ? await openCodingSession(parseResumeSession(args))
    : await createCodingSession(requiredArgument(args, "--workspace"));
  const container = path.dirname(session.workspaceRoot);
  const configurationFile = path.join(container, "run-config.json");
  const options = resuming
    ? await readRunConfiguration(configurationFile)
    : await parseOptions(args);
  if (resuming && options.task.length === 0) {
    // Sessions created by `advance` carry their task in the journal contract.
    await advanceSession(session, options, undefined);
    return;
  }
  if (!resuming) {
    await writeFile(configurationFile, JSON.stringify({ version: 1, options }, null, 2));
  }
  const journalFile = path.join(container, "run.jsonl");
  const scorecardFile = path.join(container, "scorecard.json");
  const fileJournal = await FileJournal.open(journalFile);
  emitSessionReady(session, container, journalFile, scorecardFile, resuming);
  const priorEvents = resuming ? await fileJournal.readValidated() : [];
  const runtime = await buildExecutionRuntime(session, options, fileJournal, false);
  const startedAt = Date.now();
  const runtimeTask = `${options.task}\n\nVanguard runtime mutation policy: ${runtime.mutationPolicyDescription}`;
  const outcome = await runWithBudgets(options, runtime.journalActivity, new AbortController(), (signal) =>
    runtime.kernel.run(runtimeTask, signal, priorEvents));
  await writeScorecard({
    session, options, outcome, fileJournal, scorecardFile, journalFile, configurationFile,
    startedAt, resumed: resuming, usage: runtime.usage,
  });
  if (outcome.status !== "completed") process.exitCode = 1;
}

async function advanceCommand(args: readonly string[]): Promise<void> {
  const values = parseArgumentMap(args);
  const sessionPath = single(values, "--session");
  const message = single(values, "--message");
  let session: CodingSession;
  let options: CliOptions;
  if (sessionPath === undefined) {
    session = await createSessionShell(required(values, "--workspace"));
    options = await parseOptions(args, { requireTask: false });
    const configurationFile = path.join(path.dirname(session.workspaceRoot), "run-config.json");
    await writeFile(configurationFile, JSON.stringify({ version: 1, options }, null, 2));
  } else {
    session = await openCodingSession(sessionPath);
    options = await readRunConfiguration(path.join(path.dirname(session.workspaceRoot), "run-config.json"));
  }
  await advanceSession(session, options, message);
}

/**
 * Advances a conversational session: conversation turns run against the
 * read-only original project; when the model contracts execution, the
 * disposable workspace is materialized and execution continues in it.
 */
async function advanceSession(
  session: CodingSession,
  options: CliOptions,
  message: string | undefined,
): Promise<void> {
  const container = path.dirname(session.workspaceRoot);
  const journalFile = path.join(container, "run.jsonl");
  const scorecardFile = path.join(container, "scorecard.json");
  const configurationFile = path.join(container, "run-config.json");
  const fileJournal = await FileJournal.open(journalFile);
  emitSessionReady(session, container, journalFile, scorecardFile, session.materialized);
  let priorEvents = await fileJournal.readValidated();
  const startedAt = Date.now();
  let contracted = priorEvents.some((event) => event.type === "run.contracted" || event.type === "run.started");
  let pendingMessage = message;
  const controller = new AbortController();
  const userChannel = process.env.VANGUARD_CONTROL_STREAM === "1"
    ? new StdinUserChannel(() => controller.abort())
    : undefined;

  try {
    if (!contracted) {
      const conversation = buildConversationRuntime(session, options, fileJournal, userChannel);
      const outcome = await runWithBudgets(options, conversation.journalActivity, controller, (signal) =>
        conversation.kernel.advance(pendingMessage === undefined ? {} : { userMessage: pendingMessage }, signal, priorEvents));
      pendingMessage = undefined;
      if (outcome.status !== "contracted") {
        printAdvanceOutcome(outcome, session, container, journalFile);
        if (outcome.status === "failed") process.exitCode = 1;
        return;
      }
      priorEvents = await fileJournal.readValidated();
      contracted = true;
    }

    // Materialize unconditionally whenever a contract exists but the copy does
    // not: an interruption between journaling run.contracted and copying the
    // workspace must not strand the session on resume.
    if (!session.materialized) {
      session = await materializeSessionWorkspace(session);
      emitSessionReady(session, container, journalFile, scorecardFile, true);
      if (session.sourceChangedDuringConversation === true) {
        process.stderr.write("[Vanguard] The original project changed during the conversation; the workspace copy uses the current state. Stale-content preconditions will force fresh reads before any edit.\n");
        streamPublicEvent({
          type: "source.changed",
          agentId: "main",
          status: "info",
          title: "Original project changed during conversation",
          detail: "The workspace copy uses the current state",
        });
      }
    }

    const runtime = await buildExecutionRuntime(session, options, fileJournal, true, userChannel);
    const outcome = await runWithBudgets(options, runtime.journalActivity, controller, (signal) =>
      runtime.kernel.advance(pendingMessage === undefined ? {} : { userMessage: pendingMessage }, signal, priorEvents));
    if (outcome.status === "completed" || outcome.status === "failed") {
      await writeScorecard({
        session, options, outcome, fileJournal, scorecardFile, journalFile, configurationFile,
        startedAt, resumed: true, usage: runtime.usage,
      });
    } else {
      printAdvanceOutcome(outcome, session, container, journalFile);
    }
    if (outcome.status === "failed") process.exitCode = 1;
  } finally {
    // Release stdin so the process exits; a referenced reader would keep the
    // event loop alive after the advance finishes.
    userChannel?.close();
  }
}

interface ExecutionRuntime {
  readonly kernel: AgentKernelType;
  readonly mutationPolicyDescription: string;
  readonly journalActivity: () => number;
  readonly usage?: UsageLedger;
}

/** Merges the public-event stream presenter with usage accounting. */
function combinedObserver(presenter: StreamObserver, usage: UsageLedger): StreamObserver {
  const ledger = usage.observer();
  return {
    started: (attempt) => presenter.started?.(attempt),
    delta: (text) => presenter.delta(text),
    reset: () => presenter.reset?.(),
    committed: () => presenter.committed?.(),
    failed: (reason) => presenter.failed?.(reason),
    usage: (value) => {
      ledger.usage?.(value);
      presenter.usage?.(value);
    },
  };
}

function buildConversationRuntime(
  session: CodingSession,
  options: CliOptions,
  fileJournal: FileJournal,
  userChannel: UserChannelPort | undefined,
): ExecutionRuntime {
  const source = new WorkspaceBoundary(session.sourceRoot);
  const versions = new WorkspaceVersionLedger();
  const mutationPolicy = new WorkspaceMutationPolicy(options.editableRoots, options.protectedPaths);
  const { journal, journalActivity, markActivity } = instrumentJournal(fileJournal);
  const kernel = new AgentKernel({
    model: createModel(options, createStreamPresenter(markActivity)),
    tools: [
      new ListFilesTool(source),
      new SearchTextTool(source),
      new ReadFileTool(source, 1_000_000, versions),
      new RepositoryMapTool(source),
      new ImageInspectionTool(source),
    ],
    verifiers: [],
    journal,
    taskAddendum: taskAddendum(options, mutationPolicy),
    ...(userChannel === undefined ? {} : { userChannel }),
    options: {
      maxSteps: options.maxSteps,
      maxContextBytes: options.maxContextBytes,
      maxRepeatedAction: 3,
      interactive: true,
    },
  });
  return { kernel, mutationPolicyDescription: mutationPolicy.describe(), journalActivity };
}

async function buildExecutionRuntime(
  session: CodingSession,
  options: CliOptions,
  fileJournal: FileJournal,
  interactive: boolean,
  userChannel?: UserChannelPort,
): Promise<ExecutionRuntime> {
  const container = path.dirname(session.workspaceRoot);
  const workspace = new WorkspaceBoundary(session.workspaceRoot);
  const versions = new WorkspaceVersionLedger();
  const mutationPolicy = new WorkspaceMutationPolicy(options.editableRoots, options.protectedPaths);
  const commandTimeoutMs = Math.min(options.commandTimeoutMs, options.maxDurationMs);
  const agentAllowedCommands = options.restrictProcess
    ? [...new Set(["node", ...options.allowedCommands])]
    : [...new Set(["node", "npm", "npx", "git", options.verification.command, ...options.allowedCommands])];
  const processTool = new ProcessTool(workspace, {
    allowedCommands: agentAllowedCommands,
    commandAliases: commandAliases(session.workspaceRoot, options.restrictProcess, mutationPolicy.writableAbsoluteRoots(session.workspaceRoot)),
    deniedArgumentPrefixes: options.restrictProcess ? ["--allow-", "--no-experimental-permission"] : [],
    deniedArgumentSubstrings: options.restrictProcess ? ["console.assert"] : [],
    timeoutMs: commandTimeoutMs,
    maxOutputBytes: 2_000_000,
  });
  const verifierProcessTool = new ProcessTool(workspace, {
    allowedCommands: [options.verification.command],
    commandAliases: commandAliases(session.workspaceRoot, false, []),
    timeoutMs: commandTimeoutMs,
    maxOutputBytes: 2_000_000,
  });
  const publicCheckTool = options.publicCheck === undefined ? undefined : new FixedCommandTool(
    "project.check",
    "Run the project's trusted public compile and test command with its fixed arguments.",
    new ProcessTool(workspace, {
      allowedCommands: [options.publicCheck.command],
      commandAliases: commandAliases(session.workspaceRoot, false, []),
      timeoutMs: commandTimeoutMs,
      maxOutputBytes: 2_000_000,
    }),
    options.publicCheck,
  );
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
  const { journal, journalActivity, markActivity } = instrumentJournal(fileJournal);
  const checkpoint = await RunCheckpointLedger.open(path.join(container, "checkpoint.json"));
  const plan = await PlanLedger.open(path.join(container, "plan.json"));
  const usage = new UsageLedger(options.model);
  // Both durable states ride into every request as runtime-owned context.
  const workingState = {
    snapshot: () => ({ checkpoint: checkpoint.snapshot(), plan: plan.snapshot() }),
  };
  const observer: StreamObserver = interactive
    ? combinedObserver(createStreamPresenter(markActivity), usage)
    : { delta: () => {}, usage: (value) => usage.record(value) };
  const kernel = new AgentKernel({
    model: createModel(options, observer),
    contextPolicy: new StickyContextPolicy(),
    tools: [
      new ListFilesTool(workspace),
      new SearchTextTool(workspace),
      new ReadFileTool(workspace, 1_000_000, versions),
      new WriteFileTool(workspace, versions, mutationPolicy),
      new ReplaceTextTool(workspace, versions, mutationPolicy),
      new DeleteFileTool(workspace, versions, mutationPolicy),
      new ReviewChangesTool(session.sourceRoot, session.workspaceRoot),
      new ImageInspectionTool(workspace),
      new RepositoryMapTool(workspace),
      new SyntaxCheckTool(new PostEditSyntaxChecker(new SyntaxCommandRunner(), session.workspaceRoot)),
      new CheckpointTool(checkpoint),
      new PlanTool(plan),
      ...(publicCheckTool === undefined ? [] : [publicCheckTool]),
      ...(options.exposeRawProcess ? [processTool] : []),
    ],
    verifiers,
    journal,
    workingState,
    plan,
    taskAddendum: taskAddendum(options, mutationPolicy),
    ...(userChannel === undefined ? {} : { userChannel }),
    options: {
      maxSteps: options.maxSteps,
      maxContextBytes: options.maxContextBytes,
      maxRepeatedAction: 3,
      maxFailedVerificationAttempts: options.maxFailedVerificationAttempts,
      interactive,
    },
  });
  return { kernel, mutationPolicyDescription: mutationPolicy.describe(), journalActivity, usage };
}

function taskAddendum(options: CliOptions, mutationPolicy: WorkspaceMutationPolicy): string {
  const adaptive = options.adaptiveVerification === true
    ? "\nVanguard expert-mode contract: own the implementation end to end. This project did not have a recognized verification contract at launch. Establish an appropriate deterministic build/test contract as part of the work, use project.check throughout, and finish only when the automatic trusted verifier passes."
    : "";
  return `Vanguard runtime mutation policy: ${mutationPolicy.describe()}${adaptive}`;
}

async function runWithBudgets(
  options: CliOptions,
  journalActivity: () => number,
  controller: AbortController,
  run: (signal: AbortSignal) => Promise<RunOutcome>,
): Promise<RunOutcome> {
  const durationTimer = setTimeout(() => controller.abort(), options.maxDurationMs);
  const heartbeatTimer = setInterval(() => {
    const quietMs = Date.now() - journalActivity();
    if (quietMs >= 45_000) {
      process.stderr.write(`[Vanguard] working: provider or tool response pending (${formatDuration(quietMs)} since last event)\n`);
    }
  }, 45_000);
  heartbeatTimer.unref();
  return run(controller.signal).finally(() => {
    clearTimeout(durationTimer);
    clearInterval(heartbeatTimer);
  });
}

interface ScorecardContext {
  readonly session: CodingSession;
  readonly options: CliOptions;
  readonly outcome: RunOutcome;
  readonly fileJournal: FileJournal;
  readonly scorecardFile: string;
  readonly journalFile: string;
  readonly configurationFile: string;
  readonly startedAt: number;
  readonly resumed: boolean;
  readonly usage?: UsageLedger | undefined;
}

async function writeScorecard(context: ScorecardContext): Promise<void> {
  const { session, options, outcome } = context;
  const events = await context.fileJournal.readValidated();
  const trajectory = analyzeTrajectory(events);
  // Sessions contracted through conversation carry their task in the journal.
  const contracted = events.find((event) => event.type === "run.contracted")?.data;
  const contractedTask = contracted !== null && typeof contracted === "object" && !Array.isArray(contracted)
    && typeof contracted.task === "string" ? contracted.task : undefined;
  const task = options.task.length > 0 ? options.task : contractedTask ?? "";
  const patch = session.materialized
    ? await analyzePatch(session.sourceRoot, session.workspaceRoot)
    : emptyPatchMetrics();
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
    task,
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
    usage: context.usage?.usage() ?? null,
    estimatedCost: context.usage?.estimatedCost() ?? null,
    latency: context.usage?.latencyMs() ?? null,
    durationMs: Date.now() - context.startedAt,
    journalFile: context.journalFile,
    completedAt: new Date().toISOString(),
    resumed: context.resumed,
    sessionFile: session.metadataFile,
    configurationFile: context.configurationFile,
  };
  await writeFile(context.scorecardFile, JSON.stringify(scorecard, null, 2));
  process.stdout.write(`${JSON.stringify({ ...scorecard, scorecardFile: context.scorecardFile }, null, 2)}\n`);
}

function emptyPatchMetrics(): Awaited<ReturnType<typeof analyzePatch>> {
  return {
    changedFiles: [],
    filesAdded: 0,
    filesDeleted: 0,
    filesModified: 0,
    beforeBytes: 0,
    afterBytes: 0,
    beforeLines: 0,
    afterLines: 0,
  };
}

function printAdvanceOutcome(
  outcome: RunOutcome,
  session: CodingSession,
  container: string,
  journalFile: string,
): void {
  process.stdout.write(`${JSON.stringify({
    outcome,
    sessionId: session.id,
    sessionRoot: container,
    workspaceRoot: session.workspaceRoot,
    journalFile,
  }, null, 2)}\n`);
}

function emitSessionReady(
  session: CodingSession,
  container: string,
  journalFile: string,
  scorecardFile: string,
  resumed: boolean,
): void {
  streamPublicEvent({
    type: "session.ready",
    agentId: "main",
    status: "info",
    title: resumed ? "Session resumed" : "Session created",
    sessionId: session.id,
    sessionRoot: container,
    workspaceRoot: session.workspaceRoot,
    journalFile,
    scorecardFile,
  });
}

function createModel(options: CliOptions, streamObserver?: StreamObserver) {
  const common = {
    model: options.model,
    timeoutMs: 600_000,
    maxAttempts: 4,
    ...(streamObserver === undefined ? {} : { streamObserver }),
  };
  if (options.provider === "openai") return createOpenAIModel({ ...common, ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
  if (options.provider === "anthropic") return createAnthropicModel({ ...common, ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
  if (options.provider === "deepseek") return createDeepSeekModel({ ...common, ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
  if (options.endpoint === undefined) throw new Error("--endpoint is required for the http provider.");
  return new HttpModelAdapter({ endpoint: options.endpoint, timeoutMs: common.timeoutMs, maxAttempts: common.maxAttempts });
}

/**
 * A live NDJSON control channel over stdin: {"type":"user_message","text":…}
 * queues steering (or answers a pending question); {"type":"cancel"} aborts.
 */
class StdinUserChannel implements UserChannelPort {
  readonly #queue: string[] = [];
  readonly #waiters: ((message: string | undefined) => void)[] = [];
  readonly #reader: ReturnType<typeof createInterface>;
  #closed = false;

  constructor(onCancel: () => void) {
    const reader = createInterface({ input: process.stdin });
    this.#reader = reader;
    reader.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      try {
        const parsed = JSON.parse(trimmed) as { type?: string; text?: string };
        if (parsed.type === "user_message" && typeof parsed.text === "string" && parsed.text.length > 0) {
          const waiter = this.#waiters.shift();
          if (waiter !== undefined) waiter(parsed.text);
          else this.#queue.push(parsed.text);
        } else if (parsed.type === "cancel") {
          onCancel();
        }
      } catch {
        // Malformed control lines are ignored; the journal is unaffected.
      }
    });
    reader.on("close", () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) waiter(undefined);
    });
  }

  /** Releases stdin so the process can exit once the advance finishes. */
  close(): void {
    this.#closed = true;
    this.#reader.close();
    process.stdin.pause();
    process.stdin.unref?.();
    for (const waiter of this.#waiters.splice(0)) waiter(undefined);
  }

  drain(): readonly string[] {
    return this.#queue.splice(0);
  }

  wait(signal: AbortSignal): Promise<string | undefined> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed || signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter = (message: string | undefined): void => {
        signal.removeEventListener("abort", onAbort);
        resolve(message);
      };
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        resolve(undefined);
      };
      this.#waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function createStreamPresenter(markActivity: () => void): StreamObserver {
  return createStreamLifecyclePresenter(streamPublicEvent, markActivity);
}

function parseArgumentMap(args: readonly string[]): Map<string, string[]> {
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
  return values;
}

async function parseOptions(
  args: readonly string[],
  behavior: { requireTask?: boolean } = {},
): Promise<CliOptions> {
  const requireTask = behavior.requireTask !== false;
  const values = parseArgumentMap(args);
  const workspace = required(values, "--workspace");
  const task = requireTask ? required(values, "--task") : single(values, "--task") ?? "";
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
  const commandTimeoutMs = Number(single(values, "--command-timeout-ms") ?? "1800000");
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 1) {
    throw new Error("--command-timeout-ms must be a positive integer.");
  }
  const explicitCommand = single(values, "--verify-command");
  const detected = explicitCommand === undefined ? await detectProjectVerification(workspace) : undefined;
  const verification = explicitCommand === undefined
    ? detected
    : { command: explicitCommand, args: values.get("--verify-arg") ?? [] };
  if (verification === undefined) {
    throw new Error("Could not detect project verification. Supply --verify-command and repeat --verify-arg for its arguments.");
  }
  const publicCheckCommand = single(values, "--check-command");
  if (publicCheckCommand === undefined && values.has("--check-arg")) {
    throw new Error("--check-arg requires --check-command.");
  }
  const publicCheck = publicCheckCommand === undefined
    ? explicitCommand === undefined ? verification : undefined
    : { command: publicCheckCommand, args: values.get("--check-arg") ?? [] };
  const adaptiveVerification = single(values, "--adaptive-verification");
  return {
    workspace,
    task,
    provider,
    model,
    verification,
    ...(adaptiveVerification === undefined ? {} : { adaptiveVerification: parseBoolean(adaptiveVerification, "--adaptive-verification") }),
    allowedCommands: values.get("--allow-command") ?? [],
    protectedPaths: values.get("--protect") ?? [],
    editableRoots: values.get("--editable-root") ?? [],
    restrictProcess: parseBoolean(single(values, "--restrict-process") ?? "false", "--restrict-process"),
    exposeRawProcess: parseBoolean(single(values, "--expose-raw-process") ?? "true", "--expose-raw-process"),
    verifierEvidence: parseEvidenceMode(single(values, "--verifier-evidence") ?? "full"),
    ...(publicCheck === undefined ? {} : { publicCheck }),
    maxSteps,
    maxDurationMs,
    commandTimeoutMs,
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
  return {
    ...parsed.options,
    commandTimeoutMs: parsed.options.commandTimeoutMs ?? 1_800_000,
  };
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

function instrumentJournal(fileJournal: FileJournal): {
  journal: JournalPort;
  journalActivity: () => number;
  markActivity: () => void;
} {
  let lastProgressAt = Date.now();
  let modelTurns = 0;
  const presenter = new PublicRunEventPresenter();
  const markActivity = (): void => { lastProgressAt = Date.now(); };
  const journal: JournalPort = {
    async append(event: RunEvent): Promise<void> {
      await fileJournal.append(event);
      markActivity();
      for (const publicEvent of presenter.present(event)) streamPublicEvent(publicEvent);
      if (event.type === "model.decided") {
        modelTurns += 1;
        const decision = event.data as { kind?: string; calls?: { name?: string }[]; call?: { name?: string } };
        const action = decision.kind === "tools"
          ? (decision.calls ?? []).map((call) => call.name ?? "unknown tool").join(", ")
          : decision.kind === "tool" ? decision.call?.name ?? "unknown tool"
            : decision.kind === "complete" ? "completion claim"
              : decision.kind ?? "decision";
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
  return { journal, journalActivity: () => lastProgressAt, markActivity };
}

function streamPublicEvent(event: Parameters<typeof encodePublicRunEvent>[0]): void {
  if (process.env.VANGUARD_EVENT_STREAM !== "1") return;
  process.stderr.write(encodePublicRunEvent(event));
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes === 0 ? `${remainder}s` : `${minutes}m ${remainder}s`;
}

function printUsage(): void {
  process.stdout.write(`Vanguard expert coding agent\n\nUsage:\n  vanguard                         Start the conversational agent in the current directory\n  vanguard tui                     Start the conversational agent in the current directory\n  vanguard advance --workspace PATH --provider P --model M [options] [--message TEXT]\n                                   Create a conversational session and advance it one turn\n  vanguard advance --session SESSION_PATH [--message TEXT]\n                                   Continue an existing conversational session\n  vanguard run --workspace PATH --task TEXT --provider openai|anthropic|deepseek --model MODEL [options]\n  vanguard resume --session SESSION_PATH\n\nDefault TUI overrides:\n  VANGUARD_PROVIDER                deepseek, openai, or anthropic\n  VANGUARD_MODEL                   Provider model ID\n  VANGUARD_MAX_STEPS               Expert turn budget (default: 240)\n\nAdvanced run options:\n  --verify-command CMD     Required sealed verifier executable when auto-detection is unavailable\n  --verify-arg ARG         Repeat for each sealed verifier argument\n  --check-command CMD      Trusted public compile/test executable exposed as project.check\n  --check-arg ARG          Repeat for each fixed public-check argument\n  --allow-command CMD      Repeat to expose another executable to the agent\n  --expose-raw-process BOOL Expose arbitrary allowlisted process.run calls (default: true)\n  --protect PATH           Repeat for files that must remain byte-identical\n  --editable-root PATH     Repeat to restrict all changes to these roots\n  --restrict-process BOOL  Confine Node subprocess filesystem access to the workspace\n  --verifier-evidence MODE Use full or summary verifier feedback\n  --adaptive-verification BOOL  Blank-project mode requiring the agent to establish a build/test contract\n  --endpoint URL           Override provider endpoint, or required for provider=http\n  --max-steps N            Total agent step budget across resumes (default: 60)\n  --max-duration-ms N      Wall-clock budget per invocation (default: 7200000 / two hours)\n  --command-timeout-ms N   Per-build/test budget (default: 1800000 / thirty minutes)\n  --max-context-bytes N    Provider context budget before evidence compaction (default: 2000000)\n  --max-verification-attempts N  Failed completion-claim budget (default: 3)\n`);
}

main().catch((error: unknown) => {
  const detail = error instanceof Error
    ? process.env.VANGUARD_DEBUG === "1" ? error.stack ?? error.message : error.message
    : String(error);
  process.stderr.write(`Vanguard failed: ${detail}\n`);
  process.exitCode = 1;
});
