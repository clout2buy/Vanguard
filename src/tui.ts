import { spawnSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import type { CommandSpec } from "./runtime/projectVerification.js";
import { detectProjectVerification } from "./runtime/projectVerification.js";
import type { PublicRunEvent } from "./runtime/publicRunEvents.js";
import { VanguardEngine } from "./engine/vanguardEngine.js";
import type { VanguardEngineEvent, VanguardSessionStatus } from "./engine/types.js";

type Provider = "deepseek" | "openai" | "anthropic" | "ollama";
type Phase = "starting" | "running" | "verifying" | "completed" | "failed" | "cancelling" | "cancelled";

interface TuiConfig {
  readonly workspace: string;
  readonly provider: Provider;
  readonly model: string;
  readonly verification: CommandSpec;
  readonly adaptiveVerification: boolean;
  readonly maxSteps: number;
  readonly inPlace: boolean;
}

interface ActivityItem {
  readonly status: "pending" | "passed" | "failed" | "info";
  readonly title: string;
  readonly detail?: string;
  readonly turn?: number;
}

interface ChatItem {
  readonly agentId: string;
  readonly message: string;
  readonly turn?: number;
}

interface AgentState {
  readonly id: string;
  turn: number;
  action: string;
  status: "active" | "idle" | "done" | "failed";
}

interface SessionState {
  readonly sessionId: string;
  readonly sessionRoot: string;
  readonly workspaceRoot: string;
  readonly journalFile: string;
  readonly scorecardFile: string;
}

interface UiState {
  phase: Phase;
  startedAt: number;
  frame: number;
  quietDetail: string;
  task: string;
  agents: Map<string, AgentState>;
  activity: ActivityItem[];
  chat: ChatItem[];
  verifiers: Map<string, boolean>;
  session?: SessionState;
  finalResult?: Record<string, unknown>;
  error?: string;
  /** True once a task contract exists; execution renders in the animated screen. */
  contracted: boolean;
  screenActive: boolean;
  conversationMessages: string[];
  /** The live steering composer shown while execution runs. */
  composer: string;
  /** Caret index into the composer. */
  composerCursor: number;
  /** Previously sent steering messages for up/down recall. */
  composerHistory: string[];
  composerHistoryIndex: number;
  /** Model text streaming in before the decision lands. */
  liveDelta: string;
  /** Engine-derived turn outcome; never inferred from child stdout. */
  outcome?: TurnOutcome;
}

interface TurnOutcome {
  readonly status: string;
  readonly message?: string;
  readonly question?: string;
}

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  inverse: "\x1b[7m",
  cyan: "\x1b[38;5;51m",
  violet: "\x1b[38;5;141m",
  green: "\x1b[38;5;84m",
  red: "\x1b[38;5;203m",
  amber: "\x1b[38;5;221m",
  slate: "\x1b[38;5;245m",
  blue: "\x1b[38;5;75m",
  pink: "\x1b[38;5;212m",
  faint: "\x1b[38;5;238m",
};

const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PULSE = ["◇", "◈", "◆", "◈"];

/** Violet→cyan ramp used for the wordmark and running-state shimmer. */
const GRADIENT = [141, 140, 104, 62, 63, 69, 75, 81, 51];

function gradientText(text: string, offset = 0): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const color = GRADIENT[(index + offset) % GRADIENT.length]!;
    out += `\x1b[38;5;${color}m${text[index]}`;
  }
  return `${ansi.bold}${out}${ansi.reset}`;
}

/**
 * Minimal markdown for terminal chat: **bold**, `code`, and list bullets.
 * Everything else passes through verbatim; no HTML, no links, no surprises.
 */
function renderMarkdownLite(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/gu, `${ansi.bold}$1${ansi.reset}`)
    .replace(/`([^`]+)`/gu, `${ansi.cyan}$1${ansi.reset}`)
    .replace(/^(\s*)[-*] /gmu, `$1${ansi.violet}•${ansi.reset} `);
}

function toolGlyph(title: string, status: ActivityItem["status"], frame: number): string {
  if (status === "passed") return `${ansi.green}✓${ansi.reset}`;
  if (status === "failed") return `${ansi.red}×${ansi.reset}`;
  if (status === "pending") return `${ansi.cyan}${spinner[frame % spinner.length]!}${ansi.reset}`;
  if (/replace|write|delete|apply/u.test(title)) return `${ansi.amber}✎${ansi.reset}`;
  if (/check|verify|test/u.test(title)) return `${ansi.blue}▸${ansi.reset}`;
  if (/read|search|list|glob|map|inspect/u.test(title)) return `${ansi.slate}·${ansi.reset}`;
  return `${ansi.slate}·${ansi.reset}`;
}

export async function runTui(startDirectory: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The Vanguard TUI requires an interactive terminal.");
  const config = await resolveConfiguration(startDirectory);
  // The Windows credential helper returns a value without mutating this
  // process. Install it for the lifetime of the embedded engine so its worker
  // can inherit it, then restore the caller's environment on shutdown.
  const credentialName = credentialVariable(config.provider);
  const previousCredential = process.env[credentialName];
  process.env[credentialName] = loadCredential(config.provider);
  const engine = new VanguardEngine({ logger: () => {} });

  process.stdout.write(`\x1b[2J\x1b[H${renderWelcome(config.workspace, config.model, config.inPlace)}`);
  let sessionId: string | undefined;
  let contracted = false;

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const input = (await prompt.question(`${ansi.violet}❯${ansi.reset} `)).trim();
      if (isExitRequest(input)) {
        process.stdout.write(`${ansi.dim}See you next time.${ansi.reset}\n`);
        return;
      }
      if (input === "/help") {
        process.stdout.write(
          ` ${ansi.bold}Commands${ansi.reset}\n`
          + ` ${ansi.violet}/status${ansi.reset}   ${ansi.dim}session, provider, and mode details${ansi.reset}\n`
          + ` ${ansi.violet}/exit${ansi.reset}     ${ansi.dim}leave Vanguard (also: exit, quit)${ansi.reset}\n`
          + ` ${ansi.dim}Anything else is a message: chat, ask about the repo, or request work.${ansi.reset}\n`
          + ` ${ansi.dim}While a task runs: type to steer, Enter sends, ↑↓ history, Ctrl+C interrupts.${ansi.reset}\n`,
        );
        continue;
      }
      if (input === "/status") {
        const mode = config.inPlace ? `${ansi.amber}in-place${ansi.reset}` : "isolated copy";
        process.stdout.write(
          ` ${ansi.dim}provider${ansi.reset}  ${config.provider} · ${config.model}\n`
          + ` ${ansi.dim}project${ansi.reset}   ${config.workspace}\n`
          + ` ${ansi.dim}mode${ansi.reset}      ${mode} · max ${config.maxSteps} steps\n`
          + ` ${ansi.dim}session${ansi.reset}   ${sessionId ?? "starts with your first message"}\n`,
        );
        continue;
      }
      if (input.length === 0) {
        process.stdout.write(`${ansi.amber}Tell Vanguard what you need.${ansi.reset}\n`);
        continue;
      }
      prompt.pause();
      if (sessionId === undefined) {
        const created = await engine.create({
          workspace: config.workspace,
          provider: config.provider,
          model: config.model,
          verification: config.verification,
          adaptiveVerification: config.adaptiveVerification,
          maxSteps: config.maxSteps,
          maxDurationMs: 7_200_000,
          commandTimeoutMs: 1_800_000,
          maxContextBytes: 300_000,
          maxFailedVerificationAttempts: 3,
          verifierEvidence: "summary",
        });
        sessionId = created.sessionId;
      }
      const turn = await runEngineTurn(engine, sessionId, input, config, contracted);
      prompt.resume();
      contracted = turn.contracted;

      if (turn.outcome?.status === "responded") {
        continue;
      }
      if (turn.outcome?.status === "waiting_for_user") {
        const question = turn.outcome.question ?? "Vanguard needs your answer to continue.";
        process.stdout.write(`\n${ansi.violet}${ansi.bold}Vanguard${ansi.reset} ${question}\n\n`);
        continue;
      }
      if (turn.outcome?.status === "completed") {
        // A finished contract closes the session; the next message starts fresh.
        sessionId = undefined;
        contracted = false;
        continue;
      }
      if (turn.outcome?.status === "failed") {
        process.stdout.write(`${ansi.dim}You can keep talking to steer this session, or type exit to leave.${ansi.reset}\n`);
        continue;
      }
    }
  } finally {
    prompt.close();
    await engine.shutdown();
    if (previousCredential === undefined) delete process.env[credentialName];
    else process.env[credentialName] = previousCredential;
  }
}

interface TurnResult {
  readonly outcome: TurnOutcome | undefined;
  readonly contracted: boolean;
}

/**
 * Product TUI adapter over the public engine contract. Session ownership,
 * steering, cancellation, replay ordering, and event sanitization therefore
 * have one implementation for the TUI, stdio clients, and embedders.
 */
async function runEngineTurn(
  engine: VanguardEngine,
  sessionId: string,
  message: string,
  config: TuiConfig,
  alreadyContracted: boolean,
): Promise<TurnResult> {
  const status = engine.status(sessionId);
  const state: UiState = {
    phase: alreadyContracted ? "running" : "starting",
    startedAt: Date.now(),
    frame: 0,
    quietDetail: alreadyContracted ? "Continuing contracted execution" : "Understanding your request",
    task: message,
    agents: new Map([["main", { id: "main", turn: 0, action: alreadyContracted ? "resuming" : "listening", status: "active" }]]),
    activity: [],
    chat: [{ agentId: "you", message }],
    verifiers: new Map(),
    session: sessionState(status),
    contracted: alreadyContracted,
    screenActive: false,
    conversationMessages: [],
    composer: "",
    composerCursor: 0,
    composerHistory: [],
    composerHistoryIndex: -1,
    liveDelta: "",
  };

  let cancelled = false;
  const sendSteering = (): void => {
    const text = state.composer.trim();
    state.composer = "";
    state.composerCursor = 0;
    state.composerHistoryIndex = -1;
    if (text.length === 0) return;
    state.composerHistory.push(text);
    trimTo(state.composerHistory, 50);
    try {
      engine.steer(sessionId, text);
      state.chat.push({ agentId: "you", message: text });
      trimTo(state.chat, 30);
      state.quietDetail = "Steering delivered; it lands at the next decision boundary";
    } catch (error) {
      state.quietDetail = bounded(error instanceof Error ? error.message : String(error), 180);
    }
  };
  const cancel = (): void => {
    if (cancelled || state.phase === "completed" || state.phase === "failed" || state.phase === "cancelled") return;
    cancelled = true;
    state.phase = "cancelling";
    state.quietDetail = "Stopping after the current process boundary";
    try { engine.cancel(sessionId); } catch { /* already stopped */ }
  };
  const onKeypress = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }): void => {
    if (key.ctrl === true && key.name === "c") { cancel(); return; }
    if (key.ctrl === true && key.name === "a") { state.composerCursor = 0; return; }
    if (key.ctrl === true && key.name === "e") { state.composerCursor = state.composer.length; return; }
    if (key.ctrl === true && key.name === "u") { state.composer = ""; state.composerCursor = 0; return; }
    if (key.ctrl === true || key.meta === true) return;
    if (key.name === "return" || key.name === "enter") { sendSteering(); return; }
    if (key.name === "backspace") {
      if (state.composerCursor > 0) {
        state.composer = state.composer.slice(0, state.composerCursor - 1) + state.composer.slice(state.composerCursor);
        state.composerCursor -= 1;
      }
      return;
    }
    if (key.name === "delete") {
      state.composer = state.composer.slice(0, state.composerCursor)
        + state.composer.slice(state.composerCursor + 1);
      return;
    }
    if (key.name === "left") { state.composerCursor = Math.max(0, state.composerCursor - 1); return; }
    if (key.name === "right") { state.composerCursor = Math.min(state.composer.length, state.composerCursor + 1); return; }
    if (key.name === "home") { state.composerCursor = 0; return; }
    if (key.name === "end") { state.composerCursor = state.composer.length; return; }
    if (key.name === "up") {
      if (state.composerHistory.length === 0) return;
      state.composerHistoryIndex = state.composerHistoryIndex === -1
        ? state.composerHistory.length - 1
        : Math.max(0, state.composerHistoryIndex - 1);
      state.composer = state.composerHistory[state.composerHistoryIndex] ?? "";
      state.composerCursor = state.composer.length;
      return;
    }
    if (key.name === "down") {
      if (state.composerHistoryIndex === -1) return;
      state.composerHistoryIndex += 1;
      if (state.composerHistoryIndex >= state.composerHistory.length) {
        state.composerHistoryIndex = -1;
        state.composer = "";
      } else {
        state.composer = state.composerHistory[state.composerHistoryIndex] ?? "";
      }
      state.composerCursor = state.composer.length;
      return;
    }
    if (key.name === "escape") { state.composer = ""; state.composerCursor = 0; state.composerHistoryIndex = -1; return; }
    if (typeof text === "string" && text.length >= 1 && !text.includes("\x1b") && state.composer.length < 2_000) {
      // Pasted text arrives as a multi-character chunk; insert at the caret.
      const printable = text.replace(/[\r\n\t]+/gu, " ").replace(/[\x00-\x1f\x7f]/gu, "");
      if (printable.length === 0) return;
      state.composer = state.composer.slice(0, state.composerCursor) + printable + state.composer.slice(state.composerCursor);
      state.composerCursor += printable.length;
    }
  };
  const onSigint = (): void => cancel();
  process.on("SIGINT", onSigint);

  const enterExecutionScreen = (): void => {
    if (state.screenActive) return;
    state.screenActive = true;
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
    enterScreen();
  };
  const leaveExecutionScreen = (): void => {
    if (!state.screenActive) return;
    state.screenActive = false;
    process.stdin.off("keypress", onKeypress);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    leaveScreen();
  };
  if (alreadyContracted) enterExecutionScreen();

  const unsubscribe = engine.subscribe((envelope: VanguardEngineEvent) => {
    if (envelope.sessionId !== sessionId) return;
    consumeEvent(envelope.event, state, enterExecutionScreen);
  });
  const animation = setInterval(() => {
    state.frame += 1;
    if (state.screenActive) render(state, config);
    else if (!state.contracted && state.outcome === undefined) {
      // One-line thinking indicator while the conversational turn runs.
      process.stdout.write(`\r\x1b[2K${ansi.cyan}${spinner[state.frame % spinner.length]!}${ansi.reset} ${ansi.dim}${bounded(state.quietDetail, 100)}${ansi.reset}`);
    }
    if (!state.contracted && state.phase === "starting") state.phase = "running";
  }, 120);
  animation.unref();

  try {
    engine.advance(sessionId, message);
    let finalStatus = engine.status(sessionId);
    while (finalStatus.state === "running" || finalStatus.state === "cancelling") {
      await delay(40);
      finalStatus = engine.status(sessionId);
    }
    const outcome = state.outcome ?? outcomeFromEngineState(finalStatus, state);
    state.outcome = outcome;
    state.finalResult = { outcome };
    if (state.screenActive) {
      if (cancelled || finalStatus.state === "cancelled") {
        state.phase = "cancelled";
        state.quietDetail = "Run interrupted; send another message to resume this session";
      } else if (outcome.status === "completed") {
        state.phase = "completed";
        state.quietDetail = "Independent verification accepted the result";
        const main = state.agents.get("main");
        if (main !== undefined) main.status = "done";
      } else if (outcome.status === "waiting_for_user") {
        state.phase = "running";
        state.quietDetail = "Vanguard is waiting for your answer";
      } else if (outcome.status === "failed") {
        state.phase = "failed";
        state.quietDetail = state.error ?? "Run stopped before verified completion";
      }
      render(state, config);
      await delay(250);
    }
  } finally {
    clearInterval(animation);
    unsubscribe();
    process.removeListener("SIGINT", onSigint);
    if (!state.screenActive) process.stdout.write("\r\x1b[2K");
    leaveExecutionScreen();
  }

  const outcome = state.outcome;
  if (state.contracted || outcome?.status === "completed") await printHandoff(state, config, cancelled);
  else if (outcome?.status === "responded" && outcome.message !== undefined
    && !state.conversationMessages.includes(outcome.message)) {
    process.stdout.write(`\n${ansi.violet}${ansi.bold}Vanguard${ansi.reset} ${outcome.message}\n\n`);
  }
  return {
    outcome: cancelled ? { status: "failed" } : outcome,
    contracted: state.contracted,
  };
}

function sessionState(status: VanguardSessionStatus): SessionState {
  return {
    sessionId: status.sessionId,
    sessionRoot: status.sessionRoot,
    workspaceRoot: status.workspaceRoot,
    journalFile: path.join(status.sessionRoot, "run.jsonl"),
    scorecardFile: path.join(status.sessionRoot, "scorecard.json"),
  };
}

function outcomeFromEngineState(status: VanguardSessionStatus, state: UiState): TurnOutcome {
  if (status.state === "completed") return { status: "completed" };
  if (status.state === "waiting_for_user") return state.outcome ?? { status: "waiting_for_user" };
  if (status.state === "failed" || status.state === "cancelled") return { status: "failed" };
  const message = state.conversationMessages.at(-1);
  return { status: "responded", ...(message === undefined ? {} : { message }) };
}

async function resolveConfiguration(startDirectory: string): Promise<TuiConfig> {
  const workspace = await realpath(path.resolve(startDirectory));
  if (!(await stat(workspace)).isDirectory()) throw new Error("Workspace must be a directory.");
  const provider = configuredProvider();
  const model = process.env.VANGUARD_MODEL?.trim() || defaultModel(provider);
  const maxSteps = configuredMaxSteps();
  const detectedVerification = await detectProjectVerification(workspace);
  const verification = detectedVerification ?? automaticVerificationCommand();
  const inPlaceEnvironment = process.env.VANGUARD_IN_PLACE?.trim().toLowerCase() ?? "";
  return {
    workspace,
    provider,
    model,
    verification,
    adaptiveVerification: detectedVerification === undefined,
    maxSteps,
    inPlace: inPlaceEnvironment === "1" || inPlaceEnvironment === "true" || inPlaceEnvironment === "yes",
  };
}

function consumeEvent(event: PublicRunEvent, state: UiState, enterExecutionScreen: () => void): void {
  const agent = state.agents.get(event.agentId) ?? {
    id: event.agentId,
    turn: 0,
    action: "joining",
    status: "active" as const,
  };
  state.agents.set(event.agentId, agent);
  if (event.turn !== undefined) agent.turn = event.turn;
  if (event.type === "session.ready") {
    if (event.sessionId !== undefined && event.sessionRoot !== undefined && event.workspaceRoot !== undefined
      && event.journalFile !== undefined && event.scorecardFile !== undefined) {
      state.session = {
        sessionId: event.sessionId,
        sessionRoot: event.sessionRoot,
        workspaceRoot: event.workspaceRoot,
        journalFile: event.journalFile,
        scorecardFile: event.scorecardFile,
      };
    }
    state.quietDetail = "Session ready; source project remains untouched";
    return;
  }
  if (event.type === "run.contracted") {
    state.contracted = true;
    if (event.detail !== undefined) state.task = event.detail;
    enterExecutionScreen();
    state.quietDetail = "Task contract accepted; isolated workspace prepared";
  }
  if (event.type === "agent.delta" && event.message !== undefined) {
    state.liveDelta = `${state.liveDelta}${event.message}`.slice(-600);
    return;
  }
  if (event.type === "agent.stream_started" || event.type === "agent.stream_reset") {
    // A fresh or replayed attempt owns the provisional line from here on.
    state.liveDelta = "";
    return;
  }
  if (event.type === "agent.stream_committed") return;
  if (event.type === "agent.stream_failed") {
    state.liveDelta = "";
    if (event.detail !== undefined) state.quietDetail = `Model stream failed: ${event.detail}`;
    return;
  }
  if (event.type === "agent.message" && event.message !== undefined) {
    state.liveDelta = "";
    state.chat.push({ agentId: event.agentId, message: event.message, ...(event.turn === undefined ? {} : { turn: event.turn }) });
    trimTo(state.chat, 30);
    if (!state.screenActive && !state.contracted) {
      // During conversation observation, surface narration inline as it streams.
      state.conversationMessages.push(event.message);
      process.stdout.write(`\r\x1b[2K\n${ansi.violet}${ansi.bold}Vanguard${ansi.reset} ${renderMarkdownLite(event.message)}\n\n`);
      state.outcome = { status: "responded", message: event.message };
    }
  }
  if (event.type === "tool.started") {
    state.liveDelta = "";
    agent.action = event.title;
    agent.status = "active";
    state.quietDetail = event.detail === undefined ? `Running ${event.title}` : `${event.title} · ${event.detail}`;
    if (!state.screenActive && !state.contracted) {
      process.stdout.write(`\r\x1b[2K${ansi.dim}  · ${event.title}${event.detail === undefined ? "" : ` ${bounded(event.detail, 60)}`}${ansi.reset}\n`);
    }
  } else if (event.type === "completion.claimed") {
    agent.action = "verification";
    state.phase = "verifying";
    state.quietDetail = "Completion is provisional until every verifier passes";
  } else if (event.type === "verification.completed") {
    state.verifiers.set(event.title, event.status === "passed");
    state.phase = event.status === "failed" ? "running" : "verifying";
  } else if (event.type === "run.completed") {
    agent.status = "done";
    state.outcome = { status: "completed" };
  } else if (event.type === "run.failed") {
    agent.status = "failed";
    state.outcome = { status: "failed" };
  } else if (event.type === "run.waiting_for_user") {
    agent.status = "idle";
    state.quietDetail = "Vanguard asked you a question — type your answer and press Enter";
    if (event.message !== undefined) {
      state.chat.push({ agentId: event.agentId, message: event.message });
      trimTo(state.chat, 30);
    }
    state.outcome = {
      status: "waiting_for_user",
      ...(event.message === undefined ? {} : { question: event.message }),
    };
  }
  if (event.type !== "agent.message" && event.type !== "session.ready" && event.type !== "context.compacted"
    && event.type !== "run.contracted" && event.type !== "run.waiting_for_user") {
    state.activity.push({
      status: event.status ?? "info",
      title: event.title,
      ...(event.detail === undefined ? {} : { detail: event.detail }),
      ...(event.turn === undefined ? {} : { turn: event.turn }),
    });
    trimTo(state.activity, 60);
  }
}

function extractOutcome(finalResult: Record<string, unknown> | undefined): TurnOutcome | undefined {
  if (finalResult === undefined) return undefined;
  const outcome = finalResult.outcome;
  if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) return undefined;
  const record = outcome as Record<string, unknown>;
  if (typeof record.status !== "string") return undefined;
  return {
    status: record.status,
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.question === "string" ? { question: record.question } : {}),
  };
}

function outcomeStatus(finalResult: Record<string, unknown> | undefined): string | undefined {
  return extractOutcome(finalResult)?.status;
}

function render(state: UiState, config: TuiConfig): void {
  const width = Math.max(58, process.stdout.columns ?? 100);
  const height = Math.max(24, process.stdout.rows ?? 36);
  process.stdout.write(`\x1b[H${renderFrame(state, config, width, height)}`);
}

function renderFrame(state: UiState, config: TuiConfig, width: number, height: number): string {
  const inner = width - 4;
  const running = state.phase === "running" || state.phase === "starting" || state.phase === "verifying";
  const lines: string[] = [];
  const phase = phaseAppearance(state.phase, state.frame);

  // Header: shimmer wordmark while running, steady when settled.
  const mark = running ? gradientText("◆ VANGUARD", state.frame) : `${ansi.violet}${ansi.bold}◆ VANGUARD${ansi.reset}`;
  lines.push(padAnsi(` ${mark}  ${ansi.dim}${path.basename(config.workspace)} · ${config.model}${ansi.reset}`, width));
  lines.push(padAnsi(
    ` ${phase.icon} ${phase.color}${ansi.bold}${phase.label}${ansi.reset}`
    + `  ${ansi.dim}${elapsed(state.startedAt)} · ${bounded(state.task, Math.max(16, inner - 30))}${ansi.reset}`,
    width,
  ));

  const agents = [...state.agents.values()];
  for (const agent of agents.slice(0, 3)) {
    const light = agent.status === "failed" ? ansi.red : agent.status === "done" ? ansi.green : ansi.cyan;
    const dot = agent.status === "active" ? spinner[state.frame % spinner.length]! : agent.status === "done" ? "✓" : agent.status === "failed" ? "×" : "○";
    lines.push(padAnsi(` ${light}${dot}${ansi.reset} ${ansi.bold}${agent.id}${ansi.reset}  ${ansi.dim}#${agent.turn}${ansi.reset}  ${bounded(agent.action, inner - 14)}`, width));
  }

  const fixedLines = 8 + Math.min(3, agents.length);
  const available = Math.max(8, height - fixedLines);
  const chatRows = Math.max(3, Math.floor(available * 0.5) - 1);
  const activityRows = Math.max(3, available - chatRows - 2);

  // Conversation panel.
  lines.push(padAnsi(` ${ansi.faint}╭─${ansi.reset}${ansi.slate} conversation ${ansi.reset}${ansi.faint}${"─".repeat(Math.max(0, inner - 16))}╮${ansi.reset}`, width));
  const chatItems = state.liveDelta.length === 0
    ? state.chat
    : [...state.chat, { agentId: "main", message: `${state.liveDelta} ▍` }];
  const chatLines = recentChatLines(chatItems, inner - 2, chatRows);
  if (chatLines.length === 0) {
    lines.push(padAnsi(` ${ansi.faint}│${ansi.reset} ${ansi.dim}${PULSE[state.frame % PULSE.length]!} Vanguard is reading the project…${ansi.reset}`, width));
  } else {
    for (const line of chatLines) lines.push(padAnsi(` ${ansi.faint}│${ansi.reset} ${line}`, width));
  }
  while (lines.length < 3 + Math.min(3, agents.length) + chatRows) {
    lines.push(padAnsi(` ${ansi.faint}│${ansi.reset}`, width));
  }
  lines.push(padAnsi(` ${ansi.faint}╰${"─".repeat(Math.max(0, inner - 1))}╯${ansi.reset}`, width));

  // Activity panel.
  const recent = state.activity.slice(-activityRows);
  if (recent.length === 0) lines.push(padAnsi(` ${ansi.dim}${state.quietDetail}${ansi.reset}`, width));
  for (const [index, item] of recent.entries()) {
    const icon = toolGlyph(item.title, item.status, state.frame);
    const branch = index === recent.length - 1 ? "└" : "├";
    const detail = item.detail === undefined ? "" : `  ${ansi.dim}${bounded(item.detail, Math.max(10, inner - item.title.length - 12))}${ansi.reset}`;
    lines.push(padAnsi(` ${ansi.faint}${branch}${ansi.reset} ${icon} ${item.title}${detail}`, width));
  }

  while (lines.length < height - 4) lines.push(" ".repeat(width));
  lines.push(`${ansi.faint}${"─".repeat(width)}${ansi.reset}`);
  const verifierSummary = state.verifiers.size === 0
    ? `${ansi.dim}verification waiting${ansi.reset}`
    : [...state.verifiers.entries()]
      .map(([name, pass]) => pass ? `${ansi.green}✓ ${name}${ansi.reset}` : `${ansi.red}× ${name}${ansi.reset}`)
      .join(`${ansi.dim} · ${ansi.reset}`);
  const verifierPlain = stripAnsi(verifierSummary);
  lines.push(padAnsi(` ${ansi.dim}${bounded(state.quietDetail, Math.max(16, inner - verifierPlain.length - 3))}${ansi.reset}  ${verifierSummary}`, width));
  lines.push(padAnsi(` ${ansi.violet}❯${ansi.reset} ${renderComposer(state, Math.max(16, inner - 4))}`, width));
  lines.push(padAnsi(
    ` ${ansi.dim}Enter steer · ←→ edit · ↑↓ history · Ctrl+C to stop · ${config.inPlace ? `${ansi.amber}in-place${ansi.reset}${ansi.dim}` : "isolated copy"} · durable recovery${ansi.reset}`,
    width,
  ));
  return lines.slice(0, height).join("\n");
}

/** Caret-aware composer: a sliding window keeps the caret visible. */
function renderComposer(state: UiState, visible: number): string {
  if (state.composer.length === 0) return `${ansi.dim}steer or answer, then press Enter${ansi.reset}`;
  const cursor = Math.min(state.composerCursor, state.composer.length);
  let start = 0;
  if (state.composer.length > visible) {
    start = Math.max(0, Math.min(cursor - Math.floor(visible * 0.75), state.composer.length - visible));
  }
  const window = state.composer.slice(start, start + visible);
  const caret = cursor - start;
  const before = window.slice(0, caret);
  const at = window.slice(caret, caret + 1);
  const after = window.slice(caret + 1);
  const caretCell = at.length === 0 ? `${ansi.inverse} ${ansi.reset}` : `${ansi.inverse}${at}${ansi.reset}`;
  return `${before}${caretCell}${after}`;
}

export function renderTuiPreviewForTest(width = 100, height = 34): string {
  const state: UiState = {
    phase: "running",
    startedAt: Date.now() - 65_000,
    frame: 3,
    quietDetail: "project.check · trusted project verification",
    task: "Repair the project and prove it works.",
    agents: new Map([
      ["main", { id: "main", turn: 7, action: "project.check", status: "active" }],
      ["scout", { id: "scout", turn: 3, action: "workspace.search", status: "active" }],
    ]),
    chat: [
      { agentId: "you", message: "Repair the project and prove it works." },
      { agentId: "main", turn: 7, message: "The implementation is ready for a full trusted build." },
    ],
    activity: [
      { status: "passed", title: "workspace.replace", detail: "src/main.ts · 1 replacement(s)", turn: 6 },
      { status: "pending", title: "project.check", detail: "trusted project verification", turn: 7 },
    ],
    verifiers: new Map([["workspace integrity", true]]),
    contracted: true,
    screenActive: true,
    conversationMessages: [],
    composer: "",
    composerCursor: 0,
    composerHistory: [],
    composerHistoryIndex: -1,
    liveDelta: "",
  };
  const config: TuiConfig = {
    workspace: "C:\\projects\\preview",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    verification: { command: "npm", args: ["test"] },
    adaptiveVerification: false,
    maxSteps: 240,
    inPlace: false,
  };
  return renderFrame(state, config, Math.max(58, width), Math.max(24, height));
}

export function renderWelcomeForTest(workspace = "C:\\projects\\preview", model = "deepseek-v4-pro"): string {
  return renderWelcome(workspace, model);
}

function renderWelcome(workspace: string, model: string, inPlace = false): string {
  const modeBadge = inPlace
    ? `${ansi.amber}▲ in-place${ansi.reset}${ansi.dim} — edits write directly to this project${ansi.reset}`
    : `${ansi.dim}Coding starts only when you ask for it; your original project stays untouched.${ansi.reset}`;
  return `\n ${gradientText("◆ V A N G U A R D")}\n`
    + ` ${ansi.faint}${"─".repeat(Math.min(56, 22 + path.basename(workspace).length + model.length))}${ansi.reset}\n`
    + ` ${ansi.dim}Expert coding  ·  ${ansi.reset}${ansi.bold}${path.basename(workspace)}${ansi.reset}${ansi.dim}  ·  ${model}${ansi.reset}\n`
    + ` ${modeBadge}\n`
    + ` ${ansi.faint}/help commands · Ctrl+C interrupts a run${ansi.reset}\n\n`
    + ` ${ansi.bold}What should we work on?${ansi.reset}\n`;
}

async function printHandoff(state: UiState, config: TuiConfig, cancelled: boolean): Promise<void> {
  const passed = state.phase === "completed";
  const waiting = outcomeStatus(state.finalResult) === "waiting_for_user";
  if (waiting) return;
  const headline = passed
    ? `${ansi.green}${ansi.bold}✓ Vanguard verified the result.${ansi.reset}`
    : cancelled
      ? `${ansi.amber}${ansi.bold}■ Vanguard was interrupted.${ansi.reset}`
      : `${ansi.amber}${ansi.bold}× Vanguard stopped before verified completion.${ansi.reset}`;
  process.stdout.write(`\n${headline}\n`);
  const row = (label: string, value: string): void => {
    process.stdout.write(` ${ansi.dim}${label.padEnd(10)}${ansi.reset}${value}\n`);
  };
  if (config.inPlace && passed) {
    process.stdout.write(` ${ansi.amber}Changes are live in your project${ansi.reset} ${ansi.dim}— nothing to apply.${ansi.reset}\n`);
  }
  row("project", config.workspace);
  if (state.session !== undefined) {
    if (!config.inPlace) row("workspace", state.session.workspaceRoot);
    row("journal", state.session.journalFile);
    row("scorecard", state.session.scorecardFile);
    if (!passed) row("resume", `vanguard advance --session "${state.session.sessionRoot}"`);
    if (!config.inPlace && passed) row("open", `explorer "${state.session.workspaceRoot}"`);
    row("rollback", `vanguard session list --session "${state.session.sessionRoot}"`);
  } else if (state.error !== undefined) {
    process.stdout.write(` ${ansi.red}${state.error}${ansi.reset}\n`);
  }
  process.stdout.write("\n");
}

function loadCredential(provider: Provider): string {
  const variable = credentialVariable(provider);
  const existing = process.env[variable]?.trim();
  if (existing !== undefined && existing.length > 0) return existing;
  // A local Ollama server accepts unauthenticated loopback requests.
  if (provider === "ollama") return "";
  if (process.platform !== "win32") throw new Error(`${variable} is not set.`);
  const script = path.join(repositoryRoot(), "scripts", "export-credential.ps1");
  const result = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", script,
    "-Provider", provider,
    "-Root", repositoryRoot(),
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 1_000_000 });
  const credential = result.status === 0 ? result.stdout.trim() : "";
  if (credential.length === 0) {
    const detail = result.stderr.trim();
    throw new Error(`${variable} is not available.${detail.length === 0 ? "" : ` ${bounded(detail, 180)}`}`);
  }
  return credential;
}

function credentialVariable(provider: Provider): string {
  if (provider === "deepseek") return "DEEPSEEK_API_KEY";
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "ollama") return "OLLAMA_API_KEY";
  return "ANTHROPIC_API_KEY";
}

function repositoryRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

function configuredProvider(): Provider {
  const configured = process.env.VANGUARD_PROVIDER?.trim().toLowerCase() ?? "deepseek";
  const provider = parseProvider(configured);
  if (provider === undefined) throw new Error("VANGUARD_PROVIDER must be deepseek, openai, anthropic, or ollama.");
  return provider;
}

function isExitRequest(input: string): boolean {
  return /^(exit|quit|\/exit|\/quit)$/i.test(input.trim());
}

function configuredMaxSteps(): number {
  const configured = process.env.VANGUARD_MAX_STEPS?.trim();
  const maxSteps = configured === undefined || configured.length === 0 ? 240 : Number(configured);
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 2_000) {
    throw new Error("VANGUARD_MAX_STEPS must be a whole number from 1 to 2000.");
  }
  return maxSteps;
}

function defaultModel(provider: Provider): string {
  if (provider === "deepseek") return "deepseek-v4-pro";
  if (provider === "openai") return "gpt-5.6";
  if (provider === "ollama") return "qwen3-coder";
  return "claude-opus-4-8";
}

function automaticVerificationCommand(): CommandSpec {
  return { command: "node", args: [path.join(import.meta.dirname, "autoVerify.js")] };
}

function parseProvider(value: string): Provider | undefined {
  if (value.length === 0 || value === "1" || value === "deepseek") return "deepseek";
  if (value === "2" || value === "openai") return "openai";
  if (value === "3" || value === "anthropic") return "anthropic";
  if (value === "4" || value === "ollama") return "ollama";
  return undefined;
}

function phaseAppearance(phase: Phase, frame: number): { icon: string; label: string; color: string } {
  if (phase === "completed") return { icon: `${ansi.green}✓${ansi.reset}`, label: "VERIFIED", color: ansi.green };
  if (phase === "failed") return { icon: `${ansi.red}×${ansi.reset}`, label: "STOPPED", color: ansi.red };
  if (phase === "cancelled") return { icon: `${ansi.amber}■${ansi.reset}`, label: "INTERRUPTED", color: ansi.amber };
  if (phase === "cancelling") return { icon: `${ansi.amber}${spinner[frame % spinner.length]!}${ansi.reset}`, label: "STOPPING", color: ansi.amber };
  if (phase === "verifying") return { icon: `${ansi.violet}${spinner[frame % spinner.length]!}${ansi.reset}`, label: "VERIFYING", color: ansi.violet };
  return {
    icon: `${ansi.cyan}${spinner[frame % spinner.length]!}${ansi.reset}`,
    label: phase === "starting" ? "STARTING" : "RUNNING",
    color: ansi.cyan,
  };
}

function recentChatLines(chat: readonly ChatItem[], width: number, limit: number): string[] {
  const lines: string[] = [];
  for (const item of chat.slice().reverse()) {
    const label = item.agentId === "you" ? "You" : item.agentId;
    const color = item.agentId === "you" ? ansi.amber : ansi.violet;
    const prefix = `${color}${ansi.bold}${label}${ansi.reset}${item.turn === undefined ? "" : ` ${ansi.dim}#${item.turn}${ansi.reset}`} `;
    const wrapped = wrap(item.message, Math.max(20, width - label.length - 6));
    const rendered = wrapped.map((line, index) => index === 0
      ? `${prefix}${renderMarkdownLite(line)}`
      : `${" ".repeat(label.length + 1)}${renderMarkdownLite(line)}`);
    lines.unshift(...rendered);
    if (lines.length >= limit) return lines.slice(-limit);
  }
  return lines.slice(-limit);
}

function wrap(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      if (line.length > 0 && line.length + word.length + 1 > width) {
        lines.push(line);
        line = "";
      }
      line = line.length === 0 ? bounded(word, width) : `${line} ${word}`;
    }
    if (line.length > 0) lines.push(line);
  }
  return lines;
}

function padAnsi(value: string, width: number): string {
  const visible = stripAnsi(value);
  if (visible.length > width) return `${visible.slice(0, Math.max(0, width - 1))}…`;
  return `${value}${" ".repeat(width - visible.length)}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function bounded(value: string, max: number): string {
  if (max <= 1) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function elapsed(startedAt: number): string {
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function trimTo<T>(items: T[], limit: number): void {
  if (items.length > limit) items.splice(0, items.length - limit);
}

function enterScreen(): void {
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l");
}

function leaveScreen(): void {
  process.stdout.write("\x1b[?25h\x1b[?1049l");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
