import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import type { CommandSpec } from "./runtime/projectVerification.js";
import { detectProjectVerification } from "./runtime/projectVerification.js";
import { PUBLIC_EVENT_PREFIX, type PublicRunEvent } from "./runtime/publicRunEvents.js";

type Provider = "deepseek" | "openai" | "anthropic";
type Phase = "starting" | "running" | "verifying" | "completed" | "failed" | "cancelling" | "cancelled";

interface TuiConfig {
  readonly workspace: string;
  readonly provider: Provider;
  readonly model: string;
  readonly verification: CommandSpec;
  readonly adaptiveVerification: boolean;
  readonly maxSteps: number;
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
  cyan: "\x1b[38;5;51m",
  violet: "\x1b[38;5;141m",
  green: "\x1b[38;5;84m",
  red: "\x1b[38;5;203m",
  amber: "\x1b[38;5;221m",
  slate: "\x1b[38;5;245m",
};

const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export async function runTui(startDirectory: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The Vanguard TUI requires an interactive terminal.");
  const config = await resolveConfiguration(startDirectory);
  const credential = loadCredential(config.provider);
  const credentialName = credentialVariable(config.provider);

  process.stdout.write(`\x1b[2J\x1b[H${renderWelcome(config.workspace, config.model)}`);
  let sessionRoot: string | undefined;
  let contracted = false;

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const input = (await prompt.question(`${ansi.violet}❯${ansi.reset} `)).trim();
      if (isExitRequest(input)) {
        process.stdout.write(`${ansi.dim}See you next time.${ansi.reset}\n`);
        return;
      }
      if (input.length === 0) {
        process.stdout.write(`${ansi.amber}Tell Vanguard what you need.${ansi.reset}\n`);
        continue;
      }
      prompt.pause();
      const turn = await runTurn(input, config, credentialName, credential, sessionRoot, contracted);
      prompt.resume();
      sessionRoot = turn.sessionRoot ?? sessionRoot;
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
        sessionRoot = undefined;
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
  }
}

interface TurnResult {
  readonly outcome: TurnOutcome | undefined;
  readonly sessionRoot: string | undefined;
  readonly contracted: boolean;
}

async function runTurn(
  message: string,
  config: TuiConfig,
  credentialName: string,
  credential: string,
  sessionRoot: string | undefined,
  alreadyContracted: boolean,
): Promise<TurnResult> {
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
    contracted: alreadyContracted,
    screenActive: false,
    conversationMessages: [],
  };

  const child = startAgent(message, config, credentialName, credential, sessionRoot);
  let cancelled = false;
  const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }): void => {
    if (key.ctrl === true && key.name === "c") {
      if (state.phase === "completed" || state.phase === "failed" || state.phase === "cancelled") return;
      cancelled = true;
      state.phase = "cancelling";
      state.quietDetail = "Stopping after the current process boundary";
      child.kill("SIGTERM");
    }
  };
  const onSigint = (): void => {
    cancelled = true;
    child.kill("SIGTERM");
  };
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
  else process.stdout.write(`${ansi.dim}…${ansi.reset}\n`);

  const animation = setInterval(() => {
    state.frame += 1;
    if (state.screenActive) render(state, config);
    if (!state.contracted && state.phase === "starting") state.phase = "running";
  }, 120);
  animation.unref();

  let exitCode: number | null = null;
  try {
    exitCode = await consumeChild(child, state, enterExecutionScreen);
    if (state.screenActive) {
      if (cancelled) {
        state.phase = "cancelled";
        state.quietDetail = "Run interrupted; send another message to resume this session";
      } else if (exitCode === 0 && resultCompleted(state.finalResult)) {
        state.phase = "completed";
        state.quietDetail = "Independent verification accepted the result";
        const main = state.agents.get("main");
        if (main !== undefined) main.status = "done";
      } else if (outcomeStatus(state.finalResult) === "waiting_for_user") {
        state.phase = "running";
        state.quietDetail = "Vanguard is waiting for your answer";
      } else {
        state.phase = "failed";
        state.quietDetail = state.error ?? "Run stopped before verified completion";
        const main = state.agents.get("main");
        if (main !== undefined) main.status = "failed";
      }
      render(state, config);
      await delay(400);
    }
  } finally {
    clearInterval(animation);
    process.removeListener("SIGINT", onSigint);
    leaveExecutionScreen();
  }

  const outcome = extractOutcome(state.finalResult);
  if (state.contracted || outcomeStatus(state.finalResult) === "completed") {
    await printHandoff(state, config, cancelled);
  } else if (outcome?.status === "responded" && outcome.message !== undefined
    && !state.conversationMessages.includes(outcome.message)) {
    process.stdout.write(`\n${ansi.violet}${ansi.bold}Vanguard${ansi.reset} ${outcome.message}\n\n`);
  } else if (outcome === undefined && !cancelled) {
    process.stdout.write(`${ansi.red}${state.error ?? "Vanguard stopped unexpectedly. The session journal has the details."}${ansi.reset}\n`);
  }

  return {
    outcome: cancelled ? { status: "failed" } : outcome,
    sessionRoot: state.session?.sessionRoot,
    contracted: state.contracted,
  };
}

async function resolveConfiguration(startDirectory: string): Promise<TuiConfig> {
  const workspace = await realpath(path.resolve(startDirectory));
  if (!(await stat(workspace)).isDirectory()) throw new Error("Workspace must be a directory.");
  const provider = configuredProvider();
  const model = process.env.VANGUARD_MODEL?.trim() || defaultModel(provider);
  const maxSteps = configuredMaxSteps();
  const detectedVerification = await detectProjectVerification(workspace);
  const verification = detectedVerification ?? automaticVerificationCommand();
  return {
    workspace,
    provider,
    model,
    verification,
    adaptiveVerification: detectedVerification === undefined,
    maxSteps,
  };
}

function startAgent(
  message: string,
  config: TuiConfig,
  credentialName: string,
  credential: string,
  sessionRoot: string | undefined,
): ChildProcessWithoutNullStreams {
  const entry = path.join(import.meta.dirname, "cli.js");
  const args = sessionRoot !== undefined
    ? [entry, "advance", "--session", sessionRoot, "--message", message]
    : [
      entry,
      "advance",
      "--workspace", config.workspace,
      "--message", message,
      "--provider", config.provider,
      "--model", config.model,
      "--verify-command", config.verification.command,
      ...config.verification.args.flatMap((argument) => ["--verify-arg", argument]),
      "--check-command", config.verification.command,
      ...config.verification.args.flatMap((argument) => ["--check-arg", argument]),
      "--verifier-evidence", "summary",
      "--adaptive-verification", String(config.adaptiveVerification),
      "--max-steps", String(config.maxSteps),
      "--max-duration-ms", "7200000",
      "--command-timeout-ms", "1800000",
      "--max-context-bytes", "300000",
      "--max-verification-attempts", "3",
    ];
  return spawn(process.execPath, args, {
    cwd: repositoryRoot(),
    windowsHide: true,
    env: { ...process.env, [credentialName]: credential, VANGUARD_EVENT_STREAM: "1", FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function consumeChild(
  child: ChildProcessWithoutNullStreams,
  state: UiState,
  enterExecutionScreen: () => void,
): Promise<number | null> {
  let stdout = "";
  let stderrBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line, state, enterExecutionScreen);
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (stderrBuffer.length > 0) consumeLine(stderrBuffer, state, enterExecutionScreen);
  try {
    state.finalResult = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    if (stdout.trim().length > 0) state.error = lastLine(stdout);
  }
  return exitCode;
}

function consumeLine(line: string, state: UiState, enterExecutionScreen: () => void): void {
  if (line.startsWith(PUBLIC_EVENT_PREFIX)) {
    try {
      consumeEvent(JSON.parse(line.slice(PUBLIC_EVENT_PREFIX.length)) as PublicRunEvent, state, enterExecutionScreen);
    } catch {
      state.quietDetail = "Received an unreadable UI event; full evidence remains in the journal";
    }
    return;
  }
  if (line.includes("working: provider or tool response pending")) {
    state.quietDetail = line.replace(/^\[Vanguard\]\s*/, "");
  } else if (line.includes("Vanguard failed:")) {
    state.error = bounded(line.replace(/^Vanguard failed:\s*/, ""), 220);
  }
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
  if (event.type === "agent.message" && event.message !== undefined) {
    state.chat.push({ agentId: event.agentId, message: event.message, ...(event.turn === undefined ? {} : { turn: event.turn }) });
    trimTo(state.chat, 30);
    if (!state.screenActive && !state.contracted) {
      // During conversation observation, surface narration inline as it streams.
      state.conversationMessages.push(event.message);
      process.stdout.write(`\n${ansi.violet}${ansi.bold}Vanguard${ansi.reset} ${event.message}\n\n`);
    }
  }
  if (event.type === "tool.started") {
    agent.action = event.title;
    agent.status = "active";
    state.quietDetail = event.detail === undefined ? `Running ${event.title}` : `${event.title} · ${event.detail}`;
    if (!state.screenActive && !state.contracted) {
      process.stdout.write(`${ansi.dim}  · ${event.title}${event.detail === undefined ? "" : ` ${bounded(event.detail, 60)}`}${ansi.reset}\n`);
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
  } else if (event.type === "run.failed") {
    agent.status = "failed";
  } else if (event.type === "run.waiting_for_user") {
    agent.status = "idle";
    state.quietDetail = "Vanguard asked you a question";
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
  const lines: string[] = [];
  const phase = phaseAppearance(state.phase, state.frame);
  lines.push(padAnsi(` ${ansi.violet}${ansi.bold}◆ VANGUARD${ansi.reset}  ${ansi.dim}${path.basename(config.workspace)}  ·  ${config.model}${ansi.reset}`, width));
  lines.push(padAnsi(` ${phase.icon} ${phase.label.toLowerCase()}  ${ansi.dim}${elapsed(state.startedAt)}  ·  ${bounded(state.task, Math.max(16, inner - 24))}${ansi.reset}`, width));
  lines.push(" ".repeat(width));

  const agents = [...state.agents.values()];
  for (const agent of agents.slice(0, 3)) {
    const light = agent.status === "failed" ? ansi.red : agent.status === "done" ? ansi.green : ansi.cyan;
    const dot = agent.status === "active" ? spinner[state.frame % spinner.length]! : agent.status === "done" ? "✓" : agent.status === "failed" ? "×" : "○";
    lines.push(padAnsi(` ${light}${dot}${ansi.reset} ${ansi.bold}${agent.id}${ansi.reset}  ${ansi.dim}#${agent.turn}${ansi.reset}  ${bounded(agent.action, inner - 14)}`, width));
  }
  lines.push(" ".repeat(width));

  const fixedLines = 7 + Math.min(3, agents.length);
  const available = Math.max(8, height - fixedLines);
  const chatRows = Math.max(3, Math.floor(available * 0.5));
  const activityRows = Math.max(3, available - chatRows);
  const chatLines = recentChatLines(state.chat, inner, chatRows);
  if (chatLines.length === 0) lines.push(padAnsi(` ${ansi.dim}Vanguard is reading the project…${ansi.reset}`, width));
  else for (const line of chatLines) lines.push(padAnsi(` ${line}`, width));
  while (lines.length < 4 + agents.length + chatRows) lines.push(" ".repeat(width));

  const recent = state.activity.slice(-activityRows);
  if (recent.length === 0) lines.push(padAnsi(` ${ansi.dim}${state.quietDetail}${ansi.reset}`, width));
  for (const [index, item] of recent.entries()) {
    const icon = item.status === "passed" ? `${ansi.green}✓${ansi.reset}`
      : item.status === "failed" ? `${ansi.red}×${ansi.reset}`
        : item.status === "pending" ? `${ansi.cyan}${spinner[state.frame % spinner.length]!}${ansi.reset}` : `${ansi.slate}·${ansi.reset}`;
    const branch = index === recent.length - 1 ? "└" : "├";
    const detail = item.detail === undefined ? "" : `  ${ansi.dim}${bounded(item.detail, Math.max(10, inner - item.title.length - 12))}${ansi.reset}`;
    lines.push(padAnsi(` ${ansi.slate}${branch}${ansi.reset} ${icon} ${item.title}${detail}`, width));
  }

  while (lines.length < height - 3) lines.push(" ".repeat(width));
  lines.push(`${ansi.slate}${"─".repeat(width)}${ansi.reset}`);
  const verifierSummary = state.verifiers.size === 0 ? "verification waiting" : [...state.verifiers.entries()].map(([name, pass]) => `${pass ? "✓" : "×"} ${name}`).join(" · ");
  lines.push(padAnsi(` ${ansi.dim}${bounded(state.quietDetail, Math.max(16, inner - verifierSummary.length - 3))}${ansi.reset}  ${verifierSummary}`, width));
  lines.push(padAnsi(` ${ansi.dim}Ctrl+C to stop  ·  isolated copy  ·  durable recovery${ansi.reset}`, width));
  return lines.slice(0, height).join("\n");
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
  };
  const config: TuiConfig = {
    workspace: "C:\\projects\\preview",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    verification: { command: "npm", args: ["test"] },
    adaptiveVerification: false,
    maxSteps: 240,
  };
  return renderFrame(state, config, Math.max(58, width), Math.max(24, height));
}

export function renderWelcomeForTest(workspace = "C:\\projects\\preview", model = "deepseek-v4-pro"): string {
  return renderWelcome(workspace, model);
}

function renderWelcome(workspace: string, model: string): string {
  return `${ansi.violet}${ansi.bold}◆ VANGUARD${ansi.reset}\n`
    + `${ansi.dim}Expert coding  ·  ${path.basename(workspace)}  ·  ${model}${ansi.reset}\n`
    + `${ansi.dim}Talk to Vanguard. Coding starts only when you ask for it; your original project stays untouched.${ansi.reset}\n\n`
    + `${ansi.bold}What should we work on?${ansi.reset}\n`;
}

async function printHandoff(state: UiState, config: TuiConfig, cancelled: boolean): Promise<void> {
  const passed = state.phase === "completed";
  const waiting = outcomeStatus(state.finalResult) === "waiting_for_user";
  if (waiting) return;
  process.stdout.write(`\n${passed ? ansi.green : ansi.amber}${ansi.bold}${passed ? "Vanguard verified the result." : cancelled ? "Vanguard was interrupted." : "Vanguard stopped before verified completion."}${ansi.reset}\n`);
  process.stdout.write(`Original:  ${config.workspace}\n`);
  if (state.session !== undefined) {
    process.stdout.write(`Workspace: ${state.session.workspaceRoot}\n`);
    process.stdout.write(`Journal:   ${state.session.journalFile}\n`);
    process.stdout.write(`Scorecard: ${state.session.scorecardFile}\n`);
    if (!passed) process.stdout.write(`Resume:    vanguard advance --session "${state.session.sessionRoot}"\n`);
    process.stdout.write(`Open:      explorer "${state.session.workspaceRoot}"\n`);
  } else if (state.error !== undefined) {
    process.stdout.write(`${ansi.red}${state.error}${ansi.reset}\n`);
  }
}

function loadCredential(provider: Provider): string {
  const variable = credentialVariable(provider);
  const existing = process.env[variable]?.trim();
  if (existing !== undefined && existing.length > 0) return existing;
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
  return provider === "deepseek" ? "DEEPSEEK_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}

function repositoryRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

function configuredProvider(): Provider {
  const configured = process.env.VANGUARD_PROVIDER?.trim().toLowerCase() ?? "deepseek";
  const provider = parseProvider(configured);
  if (provider === undefined) throw new Error("VANGUARD_PROVIDER must be deepseek, openai, or anthropic.");
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
  return "claude-opus-4-8";
}

function automaticVerificationCommand(): CommandSpec {
  return { command: "node", args: [path.join(import.meta.dirname, "autoVerify.js")] };
}

function parseProvider(value: string): Provider | undefined {
  if (value.length === 0 || value === "1" || value === "deepseek") return "deepseek";
  if (value === "2" || value === "openai") return "openai";
  if (value === "3" || value === "anthropic") return "anthropic";
  return undefined;
}

function phaseAppearance(phase: Phase, frame: number): { icon: string; label: string } {
  if (phase === "completed") return { icon: `${ansi.green}✓${ansi.reset}`, label: "VERIFIED" };
  if (phase === "failed") return { icon: `${ansi.red}×${ansi.reset}`, label: "STOPPED" };
  if (phase === "cancelled") return { icon: `${ansi.amber}■${ansi.reset}`, label: "INTERRUPTED" };
  if (phase === "cancelling") return { icon: `${ansi.amber}${spinner[frame % spinner.length]!}${ansi.reset}`, label: "STOPPING" };
  if (phase === "verifying") return { icon: `${ansi.violet}${spinner[frame % spinner.length]!}${ansi.reset}`, label: "VERIFYING" };
  return { icon: `${ansi.cyan}${spinner[frame % spinner.length]!}${ansi.reset}`, label: phase === "starting" ? "STARTING" : "RUNNING" };
}

function recentChatLines(chat: readonly ChatItem[], width: number, limit: number): string[] {
  const lines: string[] = [];
  for (const item of chat.slice().reverse()) {
    const label = item.agentId === "you" ? "You" : item.agentId;
    const color = item.agentId === "you" ? ansi.amber : ansi.violet;
    const prefix = `${color}${ansi.bold}${label}${ansi.reset}${item.turn === undefined ? "" : ` ${ansi.dim}#${item.turn}${ansi.reset}`} `;
    const wrapped = wrap(item.message, Math.max(20, width - label.length - 6));
    const rendered = wrapped.map((line, index) => index === 0 ? `${prefix}${line}` : `${" ".repeat(label.length + 1)}${ansi.dim}${line}${ansi.reset}`);
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

function resultCompleted(result: Record<string, unknown> | undefined): boolean {
  return outcomeStatus(result) === "completed";
}

function lastLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "Unknown child-process error";
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
