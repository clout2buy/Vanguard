#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FileJournal,
  OAUTH_PROVIDER_LABELS,
  applyReviewedManifest,
  createCodingSession,
  createSessionCheckpoint,
  createSessionShell,
  forkSessionCheckpoint,
  isOAuthProvider,
  listSessionCheckpoints,
  materializeSessionWorkspace,
  oauthLogin,
  oauthLogout,
  oauthStatus,
  openCodingSession,
  renderDoctorReport,
  restoreSessionCheckpoint,
  reviewSessionChanges,
  runDoctor,
  undoAppliedTransaction,
  vanguardHome,
  withSessionLease,
  type CodingSession,
  type OAuthProvider,
} from "./index.js";
import {
  parseArgumentMap,
  parseOptions,
  parseResumeSession,
  printUsage,
  readRunConfiguration,
  required,
  requiredArgument,
  sessionModeFor,
  single,
  type CliOptions,
} from "./cli/options.js";
import { StdinUserChannel } from "./cli/userChannel.js";
import { buildConversationRuntime, buildExecutionRuntime, runWithBudgets } from "./cli/runtimeAssembly.js";
import { printAdvanceOutcome, streamPublicEvent, writeScorecard } from "./cli/scorecard.js";

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
  if (command === "login" || command === "logout" || command === "auth") {
    await authCommand(command, process.argv.slice(3));
    return;
  }
  if (command === "doctor") {
    const report = await runDoctor({
      workspaceRoot: process.cwd(),
      oauthConnected: async () => {
        const status = await oauthStatus("anthropic");
        return status.connected === true && status.expired !== true;
      },
    });
    process.stdout.write(`${renderDoctorReport(report)}\n`);
    process.exitCode = report.ready ? 0 : 1;
    return;
  }
  if (command === "advance") {
    await advanceCommand(process.argv.slice(3));
    return;
  }
  if (command === "serve") {
    if (process.argv[3] !== "--stdio") {
      throw new Error("Serve usage: vanguard serve --stdio [--create-store ABS_PATH]");
    }
    const values = parseArgumentMap(process.argv.slice(4));
    for (const key of values.keys()) {
      if (key !== "--create-store") throw new Error(`Unsupported serve option '${key}'.`);
    }
    const environmentStore = process.env.VANGUARD_CREATE_OPERATION_STORE;
    const createOperationStore = single(values, "--create-store")
      ?? (environmentStore === undefined || environmentStore.length === 0 ? undefined : environmentStore);
    if (createOperationStore !== undefined && (createOperationStore.length === 0 || !path.isAbsolute(createOperationStore))) {
      throw new Error("--create-store/VANGUARD_CREATE_OPERATION_STORE must be an absolute path.");
    }
    const { runStdioServer } = await import("./engine/stdioServer.js");
    await runStdioServer(createOperationStore === undefined ? {} : { createOperationStore });
    return;
  }
  if (command === "review" || command === "apply" || command === "undo") {
    await changeCommand(command, process.argv.slice(3));
    return;
  }
  if (command === "session") {
    await sessionCommand(process.argv.slice(3));
    return;
  }
  if (command !== "run" && command !== "resume") {
    printUsage();
    process.exitCode = 2;
    return;
  }
  await runCommand(command === "resume", process.argv.slice(3));
}

async function changeCommand(command: "review" | "apply" | "undo", args: readonly string[]): Promise<void> {
  const values = parseArgumentMap(args);
  const session = await openCodingSession(required(values, "--session"));
  if (session.direct === true) {
    throw new Error("This is a direct session: edits landed straight in the project with no baseline, so there is nothing to review, apply, or undo. Use version control (git diff, git checkout).");
  }
  if (session.inPlace === true && command !== "review") {
    throw new Error("This is an in-place session: changes are already live in the project, so apply/undo transactions do not exist. Use 'vanguard session restore' to roll back to a checkpoint.");
  }
  const container = path.dirname(session.metadataFile);
  const journal = await openSessionJournal(session, path.join(container, "run.jsonl"));
  if (command === "review") {
    process.stdout.write(`${JSON.stringify(await reviewSessionChanges(session, journal), null, 2)}\n`);
    return;
  }
  if (command === "apply") {
    const manifest = required(values, "--manifest");
    const confirmation = required(values, "--confirm");
    process.stdout.write(`${JSON.stringify(
      await applyReviewedManifest(session, journal, manifest, confirmation), null, 2,
    )}\n`);
    return;
  }
  const transaction = required(values, "--apply");
  const confirmation = required(values, "--confirm");
  process.stdout.write(`${JSON.stringify(
    await undoAppliedTransaction(session, journal, transaction, confirmation), null, 2,
  )}\n`);
}

async function sessionCommand(args: readonly string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === undefined) throw new Error("Session command requires checkpoint, list, restore, or fork.");
  const values = parseArgumentMap(args.slice(1));
  const session = await openCodingSession(required(values, "--session"));
  if (session.direct === true) {
    throw new Error("This is a direct session: it keeps no workspace baselines or checkpoints, so time travel does not exist. Use version control.");
  }
  const container = path.dirname(session.metadataFile);
  const journal = await openSessionJournal(session, path.join(container, "run.jsonl"));
  if (subcommand === "checkpoint") {
    const result = await createSessionCheckpoint(session, journal, single(values, "--label"));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (subcommand === "list") {
    process.stdout.write(`${JSON.stringify({ sessionId: session.id, checkpoints: await listSessionCheckpoints(session) }, null, 2)}\n`);
    return;
  }
  if (subcommand === "restore") {
    const checkpoint = required(values, "--checkpoint");
    const result = await restoreSessionCheckpoint(session, journal, checkpoint, required(values, "--confirm"));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (subcommand === "fork") {
    const result = await forkSessionCheckpoint(session, journal, required(values, "--checkpoint"));
    process.stdout.write(`${JSON.stringify({
      checkpointId: result.checkpointId,
      parentSessionId: result.parentSessionId,
      parentJournalHash: result.parentJournalHash,
      sessionId: result.session.id,
      sessionRoot: path.dirname(result.session.metadataFile),
      workspaceRoot: result.session.workspaceRoot,
      journalFile: result.journalFile,
    }, null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown session command '${subcommand}'.`);
}

function openSessionJournal(session: CodingSession, file: string): Promise<FileJournal> {
  return FileJournal.open(file, {
    ...(session.journalGenesisHash === undefined ? {} : { genesisHash: session.journalGenesisHash }),
  });
}

async function runCommand(resuming: boolean, args: readonly string[]): Promise<void> {
  const opened = resuming
    ? await openCodingSession(parseResumeSession(args))
    : await createCodingSession(requiredArgument(args, "--workspace"), await sessionModeFor(args, requiredArgument(args, "--workspace")));
  const container = path.dirname(opened.metadataFile);
  await withSessionLease(container, resuming ? "run.resume" : "run.start", async () => {
    const session = resuming ? await openCodingSession(container) : opened;
    const configurationFile = path.join(container, "run-config.json");
    const options = resuming
      ? await readRunConfiguration(configurationFile)
      : await parseOptions(args);
    if (resuming && options.task.length === 0) {
      // Sessions created by `advance` carry their task in the journal contract.
      await advanceSessionUnlocked(session, options, undefined);
      return;
    }
    if (!resuming) {
      await writeFile(configurationFile, JSON.stringify({ version: 1, options }, null, 2));
    }
    const journalFile = path.join(container, "run.jsonl");
    const scorecardFile = path.join(container, "scorecard.json");
    const fileJournal = await openSessionJournal(session, journalFile);
    emitSessionReady(session, container, journalFile, scorecardFile, resuming);
    const priorEvents = resuming ? await fileJournal.readValidated() : [];
    const runtime = await buildExecutionRuntime(session, options, fileJournal, false);
    const startedAt = Date.now();
    const runtimeTask = `${options.task}\n\nVanguard runtime mutation policy: ${runtime.mutationPolicyDescription}${runtime.taskAugmentation ?? ""}`;
    try {
      const outcome = await runWithBudgets(options, runtime.journalActivity, new AbortController(), (signal) =>
        runtime.kernel.run(runtimeTask, signal, priorEvents));
      await writeScorecard({
        session, options, outcome, fileJournal, scorecardFile, journalFile, configurationFile,
        startedAt, resumed: resuming, usage: runtime.usage,
        delegation: runtime.delegationSnapshot?.(),
      });
      if (outcome.status !== "completed") process.exitCode = 1;
    } finally {
      await runtime.dispose?.();
    }
  });
}

async function advanceCommand(args: readonly string[]): Promise<void> {
  const values = parseArgumentMap(args);
  const sessionPath = single(values, "--session");
  const message = single(values, "--message");
  if (sessionPath === undefined) {
    const workspace = required(values, "--workspace");
    const session = await createSessionShell(workspace, await sessionModeFor(args, workspace));
    const container = path.dirname(session.metadataFile);
    await withSessionLease(container, "advance", async () => {
      const options = await parseOptions(args, { requireTask: false });
      await writeFile(path.join(container, "run-config.json"), JSON.stringify({ version: 1, options }, null, 2));
      await advanceSessionUnlocked(session, options, message);
    });
    return;
  }
  const opened = await openCodingSession(sessionPath);
  const container = path.dirname(opened.metadataFile);
  await withSessionLease(container, "advance", async () => {
    const session = await openCodingSession(container);
    const options = await readRunConfiguration(path.join(container, "run-config.json"));
    await advanceSessionUnlocked(session, options, message);
  });
}

/**
 * Advances a conversational session: conversation turns run against the
 * read-only original project; when the model contracts execution, the
 * disposable workspace is materialized and execution continues in it.
 */
async function advanceSessionUnlocked(
  session: CodingSession,
  options: CliOptions,
  message: string | undefined,
): Promise<void> {
  const container = path.dirname(session.metadataFile);
  const journalFile = path.join(container, "run.jsonl");
  const scorecardFile = path.join(container, "scorecard.json");
  const configurationFile = path.join(container, "run-config.json");
  const fileJournal = await openSessionJournal(session, journalFile);
  emitSessionReady(session, container, journalFile, scorecardFile, session.materialized);
  let priorEvents = await fileJournal.readValidated();
  const startedAt = Date.now();
  let contracted = priorEvents.some((event) => event.type === "run.contracted" || event.type === "run.started");
  let pendingMessage = message;
  const controller = new AbortController();
  const userChannel = process.env.VANGUARD_CONTROL_STREAM === "1"
    ? new StdinUserChannel(() => controller.abort())
    : undefined;
  let disposeRuntime: (() => Promise<void>) | undefined;

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
      // Ten silent minutes in a big cloud-synced folder reads as a hang;
      // say what is happening and what would skip it.
      streamPublicEvent({
        type: "session.mode",
        agentId: "main",
        status: "info",
        title: "Preparing workspace",
        detail: session.direct === true
          ? "Direct session — nothing to copy"
          : "Fingerprinting and copying the project (large or cloud-synced folders take longer; direct mode skips this)",
      });
      session = await materializeSessionWorkspace(session);
      if (session.inPlace === true) {
        process.stderr.write(session.direct === true
          ? `[Vanguard] DIRECT MODE: edits write straight to ${session.workspaceRoot}. No baseline is kept; use version control.\n`
          : `[Vanguard] IN-PLACE MODE: edits write directly to ${session.workspaceRoot}. A pristine baseline was captured for review and checkpoint rollback.\n`);
        streamPublicEvent({
          type: "session.mode",
          agentId: "main",
          status: "info",
          title: session.direct === true ? "Direct mode" : "In-place mode",
          detail: `Edits write directly to ${session.workspaceRoot}`,
        });
      }
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
    disposeRuntime = runtime.dispose;
    const outcome = await runWithBudgets(options, runtime.journalActivity, controller, (signal) =>
      runtime.kernel.advance(pendingMessage === undefined ? {} : { userMessage: pendingMessage }, signal, priorEvents));
    if (outcome.status === "completed" || outcome.status === "failed") {
      await writeScorecard({
        session, options, outcome, fileJournal, scorecardFile, journalFile, configurationFile,
        startedAt, resumed: true, usage: runtime.usage,
        delegation: runtime.delegationSnapshot?.(),
      });
    } else {
      printAdvanceOutcome(outcome, session, container, journalFile);
    }
    if (outcome.status === "failed") process.exitCode = 1;
  } finally {
    await disposeRuntime?.();
    // Release stdin so the process exits; a referenced reader would keep the
    // event loop alive after the advance finishes.
    userChannel?.close();
  }
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
    materialized: session.materialized,
  });
}

/** `vanguard login|logout|auth [anthropic|openai|kimi]` — subscription sign-in. */
async function authCommand(command: "login" | "logout" | "auth", argv: readonly string[]): Promise<void> {
  const target = argv[0];
  if (target !== undefined && !isOAuthProvider(target)) {
    throw new Error(`Unknown OAuth provider '${target}'. Use anthropic, openai, or kimi.`);
  }
  const providers: readonly OAuthProvider[] = target === undefined ? ["anthropic", "openai", "kimi"] : [target];

  if (command === "auth") {
    for (const provider of providers) {
      const status = await oauthStatus(provider);
      const detail = !status.connected
        ? "not signed in"
        : `${status.account ?? "signed in"}${status.plan === undefined ? "" : ` · plan: ${status.plan}`}`
          + `${status.expired === true ? " (token expired; refreshes on next request)" : ""}`;
      process.stdout.write(`${provider.padEnd(10)} ${detail}\n`);
    }
    process.stdout.write(`\nTokens: ${vanguardHome()}\n`);
    return;
  }

  if (command === "logout") {
    for (const provider of providers) {
      await oauthLogout(provider);
      process.stdout.write(`Signed out of ${OAUTH_PROVIDER_LABELS[provider]}.\n`);
    }
    return;
  }

  if (target === undefined) throw new Error("Login usage: vanguard login anthropic|openai|kimi");
  const provider = providers[0]!;
  process.stderr.write(`Opening your browser to sign in to ${OAUTH_PROVIDER_LABELS[provider]}…\n`);
  // Always re-authorize: an explicit login is how a user switches accounts.
  const status = await oauthLogin(provider, {
    force: true,
    onAuthorizeUrl: (url) => process.stderr.write(`If it does not open, visit:\n${url}\n\n`),
  });
  process.stdout.write(`Signed in to ${OAUTH_PROVIDER_LABELS[provider]}${status.account === undefined ? "" : ` as ${status.account}`}.\n`);
}

main().catch((error: unknown) => {
  const detail = error instanceof Error
    ? process.env.VANGUARD_DEBUG === "1" ? error.stack ?? error.message : error.message
    : String(error);
  process.stderr.write(`Vanguard failed: ${detail}\n`);
  process.exitCode = 1;
});
