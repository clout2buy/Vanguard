import { spawnSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import type { CommandSpec } from "./runtime/projectVerification.js";
import { detectProjectVerification } from "./runtime/projectVerification.js";
import { isCleanGitRepository } from "./runtime/gitTree.js";
import type { VerificationMode } from "./runtime/automaticVerification.js";
import type { PublicRunEvent } from "./runtime/publicRunEvents.js";
import { VanguardEngine } from "./engine/vanguardEngine.js";
import type { VanguardEngineEvent, VanguardSessionStatus } from "./engine/types.js";
import {
  PROVIDER_CHOICES,
  catalogModels,
  contextWindowTokens,
  defaultContextBytes,
  credentialVariable,
  defaultModel,
  parseSelectableProvider,
  providerChoice,
  supportsOAuth,
  type SelectableProvider,
} from "./inference/modelCatalog.js";
import { fetchClaudeModels, fetchCodexModels, fetchKimiModels, oauthLogin, oauthLogout, oauthStatus, type OAuthProvider } from "./inference/oauth/index.js";
import { discoverOllamaModels, prepareOllamaModel, type OllamaModelChoice } from "./inference/ollamaModels.js";
import { playIntroAnimation } from "./tuiIntro.js";
import { SelectCancelled, select, type SelectItem } from "./tuiSelect.js";
import {
  InlineRenderer,
  ansi,
  bounded,
  elapsed,
  formatApprovalBlock,
  formatChatMessage,
  formatNote,
  formatToolCard,
  formatToolDuration,
  formatVerifiedSeal,
  hardTruncate,
  justifyAnsi,
  padAnsi,
  renderMarkdownLite,
  splitStreamableMarkdown,
  streamPrefix,
  stripAnsi,
  trimTo,
  wrap,
} from "./tuiInline.js";

// Re-exported: tests and the streamed-reply path share one markdown splitter.
export { renderMarkdownLite, splitStreamableMarkdown } from "./tuiInline.js";

type Provider = SelectableProvider;
type AuthMode = "api-key" | "oauth";
type Phase = "idle" | "thinking" | "tooling" | "waiting" | "verifying" | "completed" | "failed" | "cancelling" | "cancelled";

interface TuiConfig {
  readonly workspace: string;
  readonly provider: Provider;
  readonly auth: AuthMode;
  readonly model: string;
  /** Explicit provider endpoint when discovery selected a non-default route. */
  readonly endpoint?: string;
  readonly verification: CommandSpec;
  readonly adaptiveVerification: boolean;
  /** What completion must prove when the project has no contract of its own. */
  readonly verifyMode: VerificationMode;
  /** True when the project supplies its own verifier, which always gates completion. */
  readonly detectedVerification: boolean;
  readonly maxSteps: number;
  readonly inPlace: boolean;
  /** Zero-ceremony mode: edit the launch directory with no fingerprint, copy, or baseline. */
  readonly direct: boolean;
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
  readonly inPlace: boolean;
  agents: Map<string, AgentState>;
  /** Recent chat, kept for continuation summaries and question dedup. The
   * terminal's own scrollback is the real history; this is a bounded index. */
  chat: ChatItem[];
  verifiers: Map<string, boolean>;
  session?: SessionState;
  finalResult?: Record<string, unknown>;
  error?: string;
  /** True once a task contract exists; completion semantics differ from chat. */
  contracted: boolean;
  /** The live steering composer shown while execution runs. */
  composer: string;
  /** Caret index into the composer. */
  composerCursor: number;
  /** Previously sent steering messages for up/down recall. */
  composerHistory: string[];
  composerHistoryIndex: number;
  /** Accumulated streamed text for the reply currently on screen. */
  conversationStreamed: string;
  /** Streamed tail withheld until its markdown span closes. */
  streamHeld: string;
  /** True while the streamed reply line is still open (no newline). */
  streamLineOpen: boolean;
  /** Start timestamps for in-flight tools, queued per tool name. */
  toolStartedAt: Map<string, number[]>;
  /** Engine-derived turn outcome; never inferred from child stdout. */
  outcome?: TurnOutcome;
  /** True while an engine turn is in flight; routes composer submits to steering. */
  turnActive: boolean;
  /** The active turn's cancel hook; Ctrl+C calls it instead of exiting. */
  onCancel?: (() => void) | undefined;
  /** Command execution is frozen until one explicit owner decision arrives. */
  pendingApproval?: PendingApproval;
  /** Tool calls settled this turn. */
  toolsRun: number;
  /** Files mutated by workspace tools, oldest first, unique. */
  filesTouched: string[];
  /** Latest context compaction detail, e.g. "1.2 MB to 300 KB". */
  lastCompaction?: string;
  /** Replies collected this turn; the last one becomes a `responded` outcome. */
  conversationMessages: string[];
  /** Rolling tail of the model's live reasoning stream, newline-flattened. */
  thinkingTail: string;
  /** Total reasoning characters streamed this decision, for the footer gauge. */
  thinkingChars: number;
  /** Latest provider-reported prompt size in tokens; drives the context gauge. */
  contextTokens: number;
}

interface TurnOutcome {
  readonly status: string;
  readonly message?: string;
  readonly question?: string;
}

const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const COMMAND_LIST = [
  { command: "/help", summary: "Show every command and interaction" },
  { command: "/status", summary: "Provider, model, workspace, and session" },
  { command: "/verify", summary: "Switch between build and test proof" },
  { command: "/login", summary: "Connect a Claude, ChatGPT, or Kimi subscription" },
  { command: "/logout", summary: "Remove stored subscription credentials" },
  { command: "/exit", summary: "Close Vanguard cleanly" },
] as const;

/** Semantic print operations consumeEvent uses; the renderer stays generic. */
interface TranscriptFx {
  print(lines: string | readonly string[]): void;
  note(text: string): void;
  beginStream(agentId: string): void;
  writeStream(chunk: string): void;
  endStream(): void;
  /** Dedup-aware: an identical message printed twice in a row prints once. */
  message(agentId: string, text: string): void;
}

export async function runTui(startDirectory: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The Vanguard TUI requires an interactive terminal.");
  if (process.env.VANGUARD_NO_INTRO === undefined) await playIntroAnimation();
  let config = await resolveConfiguration(startDirectory);
  let credential = installCredential(config);
  const engine = new VanguardEngine({ logger: () => {} });
  let sessionId: string | undefined;
  let contracted = false;
  let continuation: ContinuationContext | undefined;

  // ── The inline war room ─────────────────────────────────────────────────
  // One owner from the first prompt to exit: an append-only transcript in the
  // terminal's native scrollback (every message survives; wheel-scroll works)
  // plus a two-row footer — status over composer — repainted in place.
  const ui = freshUiState(config);
  const terminalWidth = (): number => Math.max(40, process.stdout.columns ?? 100);
  const renderer = new InlineRenderer(process.stdout, terminalWidth);
  const fx = createTranscriptFx(renderer, terminalWidth);
  let frameActive = false;
  /** True while a selector owns the screen; the footer tick must stay out. */
  let suspended = false;
  let currentSessionId: string | undefined;
  let idleResolve: ((text: string) => void) | undefined;

  const submitComposer = (text: string): void => {
    if (ui.turnActive && currentSessionId !== undefined) {
      try {
        const approval = ui.pendingApproval;
        engine.steer(currentSessionId, text);
        if (approval !== undefined) {
          const choice = text === "1" ? "Approved once" : text === "2" ? "Approved for this session" : "Command denied";
          fx.note(`${choice} — ${bounded(approval.command, 120)}; execution is resuming`);
          delete ui.pendingApproval;
        } else {
          ui.chat.push({ agentId: "you", message: text });
          trimTo(ui.chat, 200);
          fx.print(formatChatMessage("you", text, terminalWidth()));
          fx.note("Steering delivered; it lands at the next decision boundary");
        }
      } catch (error) {
        fx.note(bounded(error instanceof Error ? error.message : String(error), 180));
      }
      return;
    }
    const resolve = idleResolve;
    idleResolve = undefined;
    resolve?.(text);
  };
  const onKeypress = composerKeypressHandler(ui, submitComposer, () => {
    if (ui.turnActive) ui.onCancel?.();
    else submitComposer("exit");
  }, () => printCommandList(fx));
  const onSigint = (): void => {
    if (ui.turnActive) ui.onCancel?.();
    else submitComposer("exit");
  };
  const animation = setInterval(() => {
    ui.frame += 1;
    if (frameActive && !suspended) renderer.setFooter(buildFooterLines(ui, config, terminalWidth()));
  }, 120);
  animation.unref();

  const enterFrame = (): void => {
    if (frameActive) return;
    frameActive = true;
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
    process.on("SIGINT", onSigint);
    fx.message("main", `Ready in ${config.workspace}. Ask about this repository, or tell me what you want to build.`);
    fx.note("/help lists commands · messages stay in your scrollback · type exit to leave");
    renderer.setFooter(buildFooterLines(ui, config, terminalWidth()));
  };
  const suspendFrame = async <T>(action: () => Promise<T>): Promise<T> => {
    if (!frameActive) return action();
    suspended = true;
    process.stdin.off("keypress", onKeypress);
    process.stdin.setRawMode(false);
    renderer.clearFooter();
    try {
      return await action();
    } finally {
      suspended = false;
      emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("keypress", onKeypress);
      renderer.setFooter(buildFooterLines(ui, config, terminalWidth()));
    }
  };
  const disposeFrame = (): void => {
    clearInterval(animation);
    process.removeListener("SIGINT", onSigint);
    if (!frameActive) return;
    frameActive = false;
    process.stdin.off("keypress", onKeypress);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    renderer.clearFooter();
  };
  /** The bottom-pinned composer owns input for the entire application. */
  const readInput = async (): Promise<string> => {
    ui.quietDetail = "Ready for your next message";
    return (await new Promise<string>((resolve) => { idleResolve = resolve; })).trim();
  };
  /** Command output and quiet notices land in the transcript like everything else. */
  const say = (text: string): void => {
    fx.print(text.split("\n").filter((line) => stripAnsi(line).trim().length > 0));
  };

  enterFrame();

  try {
    while (true) {
      const input = await readInput();
      if (isExitRequest(input)) break;
      if (input === "/help") {
        say(
          ` ${ansi.bold}Commands${ansi.reset}\n`
          + ` ${ansi.violet}/login claude${ansi.reset}  ${ansi.dim}sign in with your Claude subscription (opens a browser)${ansi.reset}\n`
          + ` ${ansi.violet}/login codex${ansi.reset}   ${ansi.dim}sign in with your ChatGPT subscription (opens a browser)${ansi.reset}\n`
          + ` ${ansi.violet}/logout${ansi.reset}        ${ansi.dim}discard stored subscription tokens${ansi.reset}\n`
          + ` ${ansi.violet}/verify${ansi.reset}        ${ansi.dim}what completion must prove: build or tests${ansi.reset}\n`
          + ` ${ansi.violet}/status${ansi.reset}        ${ansi.dim}session, provider, and mode details${ansi.reset}\n`
          + ` ${ansi.violet}/exit${ansi.reset}          ${ansi.dim}leave Vanguard (also: exit, quit)${ansi.reset}\n`
          + ` ${ansi.dim}Anything else is a message: chat, ask about the repo, or request work.${ansi.reset}\n`
          + ` ${ansi.dim}While a task runs: type to steer, Enter sends, ↑↓ history, Ctrl+K commands, Ctrl+C interrupts.${ansi.reset}\n`
          + ` ${ansi.dim}Composer editing: Ctrl+A/E line ends, Ctrl+←→ word jumps, Ctrl+W deletes a word, Ctrl+U clears to start.${ansi.reset}\n`
          + ` ${ansi.dim}Everything prints into your normal scrollback — scroll up any time; nothing is ever deleted.${ansi.reset}\n`,
        );
        continue;
      }
      if (input === "/login" || input.startsWith("/login ")) {
        try {
          const switched = await suspendFrame(() => loginCommand(input.slice("/login".length).trim(), config, sessionId !== undefined));
          if (switched !== undefined) {
            credential.restore();
            config = switched;
            credential = installCredential(config);
          }
        } catch (error) {
          say(`${ansi.red}${bounded(error instanceof Error ? error.message : String(error), 300)}${ansi.reset}`);
        }
        continue;
      }
      if (input === "/logout" || input.startsWith("/logout ")) {
        await suspendFrame(() => logoutCommand(input.slice("/logout".length).trim()));
        continue;
      }
      if (input === "/verify" || input.startsWith("/verify ")) {
        const switched = await suspendFrame(() => verifyCommand(input.slice("/verify".length).trim(), config, sessionId !== undefined));
        if (switched !== undefined) config = switched;
        continue;
      }
      if (input === "/status") {
        const mode = config.direct
          ? `${ansi.amber}direct — no baselines${ansi.reset}`
          : config.inPlace ? `${ansi.amber}in-place${ansi.reset}` : "isolated copy";
        say(
          ` ${ansi.dim}provider${ansi.reset}  ${config.provider} · ${config.model} ${ansi.dim}(${config.provider === "ollama" ? "local daemon / Ollama Cloud" : config.auth === "oauth" ? "subscription sign-in" : "API key"})${ansi.reset}\n`
          + ` ${ansi.dim}project${ansi.reset}   ${config.workspace}\n`
          + ` ${ansi.dim}mode${ansi.reset}      ${mode} · max ${config.maxSteps} steps\n`
          + ` ${ansi.dim}verify${ansi.reset}    ${verificationSummary(config)}\n`
          + ` ${ansi.dim}session${ansi.reset}   ${sessionId ?? "starts with your first message"}\n`,
        );
        continue;
      }
      if (input.length === 0) {
        continue;
      }
      try {
      if (sessionId === undefined) {
        const created = await engine.create({
          workspace: config.workspace,
          inPlace: config.inPlace,
          direct: config.direct,
          provider: config.provider,
          auth: config.auth,
          ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
          // With no build/test contract there is no independent check to run,
          // so syntax is the strongest pre-claim evidence that exists.
          ...(config.detectedVerification || config.verifyMode === "tests"
            ? {}
            : { executionEvidence: "syntax" as const }),
          model: config.model,
          verification: config.verification,
          adaptiveVerification: config.adaptiveVerification,
          maxSteps: config.maxSteps,
          maxDurationMs: 7_200_000,
          // Interactive sessions are conversations, not CI runs. Five minutes
          // bounds the longest legitimate interactive build; the idle watchdog
          // reclaims hung servers and wedged fixtures after 90s of silence
          // instead of letting one dead child own a half-hour turn.
          commandTimeoutMs: 300_000,
          commandIdleTimeoutMs: 90_000,
          // Start from the model family's published window when it is known,
          // so context compaction runs proactively instead of only after a
          // provider rejection; unknown families keep the broad ceiling and
          // the kernel learns the real window from context-length rejections.
          maxContextBytes: defaultContextBytes(config.model),
          maxFailedVerificationAttempts: 3,
          verifierEvidence: "summary",
        });
        sessionId = created.sessionId;
      }
      const modelMessage = continuation === undefined
        ? input
        : buildContinuationMessage(continuation, input);
      // The continuation is now durable in the new session's user message.
      continuation = undefined;
      currentSessionId = sessionId;
      const turn = await runEngineTurn(engine, sessionId, modelMessage, config, ui, fx, terminalWidth, contracted, input);
      contracted = turn.contracted;

      if (turn.outcome?.status === "waiting_for_user") {
        // The question normally printed via the run.waiting_for_user event;
        // this is the fallback for an engine path that parked without one.
        const question = turn.outcome.question ?? "Vanguard needs your answer to continue.";
        ui.chat.push({ agentId: "main", message: question });
        trimTo(ui.chat, 200);
        fx.message("main", question);
      }
      if (turn.outcome?.status === "completed") {
        // The engine refuses to advance a completed session, so the next
        // message opens a new one. In-place mode makes that harmless: the new
        // session reads this project, which now holds the finished work, so
        // "now add X" builds on it. An isolated run leaves the result in its
        // own workspace, and saying nothing here is what made finished work
        // look like lost work.
        if (config.inPlace) continuation = turn.continuation;
        fx.note(config.inPlace
          ? `The work is live in ${path.basename(config.workspace)} — your next message keeps this task's context and builds on it.`
          : `Verified in the isolated workspace — it is not in ${path.basename(config.workspace)} yet. See /status for the session path.`);
        sessionId = undefined;
        currentSessionId = undefined;
        contracted = false;
      }
      if (turn.outcome?.status === "failed") {
        // run.failed already printed the reason; what helps now is the way out.
        fx.note("Keep talking to steer this session, or type exit.");
      }
      } catch (error) {
        // One broken turn (network, locked file, provider hiccup) must never
        // end the conversation; report it and keep the composer alive.
        const message = error instanceof Error ? error.message : String(error);
        say(`${ansi.red}×${ansi.reset} ${ansi.dim}${bounded(message, 240)} — session kept alive; try again, rephrase, or type exit.${ansi.reset}`);
        continue;
      }
    }
  } finally {
    disposeFrame();
    if (ui.session !== undefined) {
      process.stdout.write(
        `\n ${ansi.dim}session${ansi.reset}  ${ui.session.sessionRoot}\n`
        + ` ${ansi.dim}journal${ansi.reset}  ${ui.session.journalFile}\n`
        + ` ${ansi.dim}resume${ansi.reset}   vanguard advance --session "${ui.session.sessionRoot}"\n`,
      );
    }
    process.stdout.write(`${ansi.dim}See you next time.${ansi.reset}\n`);
    await engine.shutdown();
    credential.restore();
  }
}

interface TurnResult {
  readonly outcome: TurnOutcome | undefined;
  readonly contracted: boolean;
  readonly continuation?: ContinuationContext;
  /** True when a pending question already streamed to the transcript, so reprinting it would duplicate. */
  readonly questionShown?: boolean;
}

interface ContinuationContext {
  readonly previousTask: string;
  readonly verifiedSummary: string;
}

/**
 * The composer's keyboard handler, shared by every phase of the persistent
 * frame: caret editing, history recall, paste, submit, and interrupt.
 */
function composerKeypressHandler(
  state: UiState,
  submit: (text: string) => void,
  interrupt: () => void,
  showCommands: () => void,
): (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => void {
  const takeComposer = (): void => {
    const text = state.composer.trim();
    state.composer = "";
    state.composerCursor = 0;
    state.composerHistoryIndex = -1;
    if (text.length === 0) return;
    state.composerHistory.push(text);
    trimTo(state.composerHistory, 50);
    submit(text);
  };
  return (text, key) => {
    if (key.ctrl === true && key.name === "c") { interrupt(); return; }
    if (state.pendingApproval !== undefined) {
      const approval = state.pendingApproval;
      if (key.name === "left" || key.name === "up") {
        approval.selected = (approval.selected + 2) % 3;
        return;
      }
      if (key.name === "right" || key.name === "down") {
        approval.selected = (approval.selected + 1) % 3;
        return;
      }
      if (key.name === "return" || key.name === "enter") { submit(String(approval.selected + 1)); return; }
      if (text === "1" || text === "2" || text === "3") { submit(text); return; }
      return;
    }
    if (key.ctrl === true && key.name === "k") { showCommands(); return; }
    if (key.ctrl === true && key.name === "a") { state.composerCursor = 0; return; }
    if (key.ctrl === true && key.name === "e") { state.composerCursor = state.composer.length; return; }
    if (key.ctrl === true && key.name === "u") {
      // Kill to line start, the readline way.
      state.composer = state.composer.slice(state.composerCursor);
      state.composerCursor = 0;
      return;
    }
    if (key.ctrl === true && (key.name === "w" || key.name === "backspace")) {
      // Delete the word before the caret.
      const before = state.composer.slice(0, state.composerCursor);
      const trimmed = before.replace(/\S+\s*$/u, "");
      state.composer = trimmed + state.composer.slice(state.composerCursor);
      state.composerCursor = trimmed.length;
      return;
    }
    if (key.ctrl === true && key.name === "left") {
      const before = state.composer.slice(0, state.composerCursor);
      state.composerCursor = before.replace(/\S+\s*$/u, "").length;
      return;
    }
    if (key.ctrl === true && key.name === "right") {
      const after = state.composer.slice(state.composerCursor);
      const jump = after.match(/^\s*\S+/u);
      state.composerCursor = Math.min(state.composer.length, state.composerCursor + (jump?.[0].length ?? after.length));
      return;
    }
    if (key.ctrl === true || key.meta === true) return;
    if (key.name === "return" || key.name === "enter") { takeComposer(); return; }
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
}

/** One persistent UI state for the whole session; turns reset only their own fields. */
function freshUiState(config: TuiConfig): UiState {
  return {
    phase: "idle",
    startedAt: Date.now(),
    frame: 0,
    quietDetail: "Ready for your first message",
    task: "What should we work on?",
    inPlace: config.inPlace,
    agents: new Map(),
    chat: [],
    verifiers: new Map(),
    contracted: false,
    composer: "",
    composerCursor: 0,
    composerHistory: [],
    composerHistoryIndex: -1,
    conversationStreamed: "",
    streamHeld: "",
    streamLineOpen: false,
    toolStartedAt: new Map(),
    turnActive: false,
    toolsRun: 0,
    filesTouched: [],
    conversationMessages: [],
    thinkingTail: "",
    thinkingChars: 0,
    contextTokens: 0,
  };
}

interface PendingApproval {
  readonly command: string;
  selected: number;
}

async function runEngineTurn(
  engine: VanguardEngine,
  sessionId: string,
  message: string,
  config: TuiConfig,
  state: UiState,
  fx: TranscriptFx,
  terminalWidth: () => number,
  alreadyContracted: boolean,
  displayMessage = message,
): Promise<TurnResult> {
  const status = engine.status(sessionId);
  state.phase = "thinking";
  state.startedAt = Date.now();
  state.quietDetail = alreadyContracted ? "Continuing contracted execution" : "Understanding your request";
  state.task = displayMessage;
  state.agents = new Map([["main", { id: "main", turn: 0, action: alreadyContracted ? "resuming" : "listening", status: "active" }]]);
  state.chat.push({ agentId: "you", message: displayMessage });
  trimTo(state.chat, 200);
  fx.print(formatChatMessage("you", displayMessage, terminalWidth()));
  state.session = sessionState(status);
  state.contracted = alreadyContracted;
  state.conversationMessages = [];
  state.conversationStreamed = "";
  state.streamHeld = "";
  state.streamLineOpen = false;
  state.thinkingTail = "";
  state.thinkingChars = 0;
  state.toolStartedAt.clear();
  delete state.outcome;
  delete state.finalResult;
  delete state.error;
  state.turnActive = true;

  let cancelled = false;
  const cancel = (): void => {
    if (cancelled || state.phase === "completed" || state.phase === "failed" || state.phase === "cancelled") return;
    cancelled = true;
    state.phase = "cancelling";
    state.quietDetail = "Stopping after the current process boundary";
    try { engine.cancel(sessionId); } catch { /* already stopped */ }
  };
  state.onCancel = cancel;

  // Engine cursors are monotonic per session: an event must print exactly once
  // no matter how often subscription plumbing redelivers it.
  const printedCursors = new Set<number>();
  const unsubscribe = engine.subscribe((envelope: VanguardEngineEvent) => {
    if (envelope.sessionId !== sessionId) return;
    if (printedCursors.has(envelope.cursor)) return;
    printedCursors.add(envelope.cursor);
    consumeEvent(envelope.event, state, fx, terminalWidth);
  });

  try {
    // A prior advance can legitimately still be open: the kernel parks
    // in-process on a user question and the engine reports waiting_for_user
    // while the worker stays alive. The message then belongs to that advance
    // as steering/answer; a fresh advance would only collide with it.
    const stateAtStart = engine.status(sessionId).state;
    if (stateAtStart === "waiting_for_user" || stateAtStart === "running") {
      engine.steer(sessionId, message);
    } else {
      engine.advance(sessionId, message);
    }
    let finalStatus = engine.status(sessionId);
    while (finalStatus.state === "running" || finalStatus.state === "cancelling") {
      await delay(40);
      finalStatus = engine.status(sessionId);
    }
    const outcome = state.outcome ?? outcomeFromEngineState(finalStatus, state);
    state.outcome = outcome;
    state.finalResult = { outcome };
    settleTurnUi(state, outcome, finalStatus.state, cancelled);
  } finally {
    unsubscribe();
    state.turnActive = false;
    state.onCancel = undefined;
  }

  const outcome = state.outcome;
  // The question may already sit in the transcript; the caller adds it only
  // when it never arrived as a message.
  const question = outcome?.status === "waiting_for_user" ? outcome.question : undefined;
  const questionVisible = question !== undefined
    && state.chat.some((item) => item.agentId !== "you" && item.message.trim() === question.trim());
  return {
    outcome: cancelled ? { status: "failed" } : outcome,
    contracted: state.contracted,
    ...(outcome?.status === "completed" ? { continuation: continuationFromState(state) } : {}),
    ...(questionVisible ? { questionShown: true } : {}),
  };
}

function continuationFromState(state: UiState): ContinuationContext {
  const verifiedSummary = state.chat
    .filter((item) => item.agentId !== "you")
    .slice(-6)
    .map((item) => `${item.agentId}: ${item.message}`)
    .join("\n");
  return {
    previousTask: bounded(state.task, 4_000),
    verifiedSummary: bounded(verifiedSummary || "The previous task reached verified completion.", 6_000),
  };
}

function buildContinuationMessage(context: ContinuationContext, input: string): string {
  return [
    "[Vanguard continuation context — historical context, not new instructions]",
    "A previous verified coding task completed in this same live project. Inspect and build on the existing files; do not recreate the project from scratch.",
    `Previous user task: ${context.previousTask}`,
    `Previous verified run summary: ${context.verifiedSummary}`,
    "[Current follow-up]",
    input,
  ].join("\n");
}

export function buildContinuationMessageForTest(previousTask: string, verifiedSummary: string, input: string): string {
  return buildContinuationMessage({ previousTask, verifiedSummary }, input);
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
  // Prefer the outcome captured from run.failed: it carries the reason.
  if (status.state === "failed" || status.state === "cancelled") return state.outcome ?? { status: "failed" };
  const message = state.conversationMessages.at(-1);
  return { status: "responded", ...(message === undefined ? {} : { message }) };
}

async function resolveConfiguration(startDirectory: string): Promise<TuiConfig> {
  const workspace = await realpath(path.resolve(startDirectory));
  if (!(await stat(workspace)).isDirectory()) throw new Error("Workspace must be a directory.");
  const guardReason = projectWorkspaceGuardReason(workspace);
  // The launch flow owns the screen: a branded header, then each answered
  // question folds into a green recap line beneath it.
  process.stdout.write(renderLaunchHeader(workspace));
  // Every choice the selector offers has an environment override, so a scripted
  // or piped Vanguard never blocks on an interactive prompt.
  const configuredProviderName = process.env.VANGUARD_PROVIDER?.trim();
  const provider = configuredProviderName === undefined || configuredProviderName.length === 0
    ? await chooseProvider()
    : configuredProvider();
  confirmChoice("provider", provider);
  const auth = await resolveAuth(provider);
  confirmChoice("auth", provider === "ollama" ? "local daemon / Ollama Cloud" : auth === "oauth" ? "subscription sign-in" : "API key");
  const configuredModel = process.env.VANGUARD_MODEL?.trim();
  const configuredEndpoint = process.env.VANGUARD_ENDPOINT?.trim();
  const selectedModel: ModelSelection = configuredModel !== undefined && configuredModel.length > 0
    ? {
        id: configuredModel,
        ...(configuredEndpoint === undefined || configuredEndpoint.length === 0 ? {} : { endpoint: configuredEndpoint }),
      }
    : await chooseModel(provider, auth);
  confirmChoice("model", selectedModel.id);
  const maxSteps = configuredMaxSteps();
  const detectedVerification = await detectProjectVerification(workspace);
  const mode = await chooseWorkspaceMode(workspace, guardReason);
  confirmChoice("workspace", mode === "direct"
    ? "direct — edits land here, git is your undo"
    : mode === "in-place" ? "in-place, with an undo baseline" : "isolated copy");
  // Only a project with no contract of its own has a choice to make; when one is
  // detected it always runs, and completion always waits on it.
  const verifyMode = detectedVerification === undefined ? await chooseVerificationMode(workspace) : "tests";
  confirmChoice("verify", detectedVerification !== undefined
    ? `${detectedVerification.command} ${detectedVerification.args.join(" ")} (detected)`
    : verifyMode === "tests" ? "require a build/test contract" : "build only — tool evidence completes");
  return {
    workspace,
    provider,
    auth,
    model: selectedModel.id,
    ...(selectedModel.endpoint === undefined ? {} : { endpoint: selectedModel.endpoint }),
    verification: detectedVerification ?? automaticVerificationCommand(verifyMode),
    adaptiveVerification: detectedVerification === undefined && verifyMode === "tests",
    verifyMode,
    detectedVerification: detectedVerification !== undefined,
    maxSteps,
    inPlace: mode !== "isolated",
    direct: mode === "direct",
  };
}

/**
 * Decide what completion must prove in a project with no build or test contract.
 *
 * Strict mode cannot be satisfied here by anything the agent produces: the
 * sealed verifier fails on the missing contract before it ever looks at the
 * work, so a mockup, script, or document burns its whole completion budget
 * against a wall. That is right for a codebase and wrong for everything else,
 * and only the person asking knows which this is.
 */
async function chooseVerificationMode(workspace: string): Promise<VerificationMode> {
  const configured = process.env.VANGUARD_VERIFY_MODE?.trim().toLowerCase();
  if (configured === "build" || configured === "tests") return configured;
  return selectOrExit<VerificationMode>({
    title: `No build or test contract in ${path.basename(workspace)}`,
    items: [
      { value: "build", label: "Just build it", note: "completion rests on tool evidence — mockups, scripts, docs" },
      { value: "tests", label: "Require tests", note: "Vanguard must establish a deterministic build/test contract" },
    ],
    hint: "Change any time with /verify · ↑↓ move · Enter select · Esc cancel",
  });
}

type WorkspaceMode = "direct" | "in-place" | "isolated";

/**
 * Ask where the work should land.
 *
 * Direct is the zero-ceremony mode: edits land in the launch directory with
 * no fingerprint, no copy, and no baseline — version control is the safety
 * net. In-place keeps a pristine copy for review and rollback; isolated keeps
 * the folder untouched entirely. Guarded directories (home, drive roots) are
 * unfingerprintable by design, so they run direct or not at all — a launch
 * there simply says so instead of dying.
 */
async function chooseWorkspaceMode(workspace: string, guardReason: string | undefined): Promise<WorkspaceMode> {
  const configured = process.env.VANGUARD_IN_PLACE?.trim().toLowerCase() ?? "";
  const configuredMode: WorkspaceMode | undefined = configured.length === 0
    ? undefined
    : configured === "direct"
      ? "direct"
      : configured === "1" || configured === "true" || configured === "yes" ? "in-place" : "isolated";
  if (guardReason !== undefined) {
    if (configuredMode !== undefined && configuredMode !== "direct") throw new Error(guardReason);
    process.stdout.write(
      ` ${ansi.dim}${path.basename(workspace)} is ${workspaceGuardLabel(workspace) ?? "not a project directory"}, so Vanguard is working directly in it — `
      + `no fingerprints, no copies, no baselines. Version control is your undo.${ansi.reset}\n`,
    );
    return "direct";
  }
  if (configuredMode !== undefined) return configuredMode;
  // A clean git work tree already provides review (git diff), undo (git
  // checkout), and a drift baseline — take the zero-ceremony path instead of
  // asking, and say so. Dirty trees and non-git directories keep the picker.
  if (await isCleanGitRepository(workspace)) {
    process.stdout.write(
      ` ${ansi.dim}clean git repository — working directly in ${path.basename(workspace)} (no copies, no baselines; git is your undo). VANGUARD_IN_PLACE=isolated overrides.${ansi.reset}\n`,
    );
    return "direct";
  }
  return selectOrExit<WorkspaceMode>({
    title: `Work in ${path.basename(workspace)}?`,
    items: [
      { value: "direct", label: "Work right here", note: "edits land in this folder as you go — no copies, no baselines; git is your undo" },
      { value: "in-place", label: "Work here with an undo baseline", note: "edits land here; a pristine session copy enables review and rollback" },
      { value: "isolated", label: "Isolated copy", note: "this folder stays untouched; changes go to a temp workspace" },
    ],
    hint: `${workspace}  ·  ↑↓ move · Enter select · Esc cancel`,
  });
}

/**
 * Resolving a credential can shell out to the Windows vault, and the launch
 * selector asks about every provider before the chosen one is used again.
 * Cache per provider so that costs at most one lookup each.
 */
const credentialCache = new Map<Provider, string | null>();

function resolveCredential(provider: Provider): string | null {
  const cached = credentialCache.get(provider);
  if (cached !== undefined) return cached;
  let value: string | null;
  try {
    value = loadCredential(provider);
  } catch {
    value = null;
  }
  credentialCache.set(provider, value);
  return value;
}

/**
 * Refuse the directories that are never a project.
 *
 * Starting a session fingerprints the whole source tree (session.ts hashes every
 * file to bind the workspace to a known baseline), and later materializes a copy
 * of it. That is cheap for a repository and pathological for a home directory or
 * a drive root: Vanguard would sit there hashing AppData for many minutes with
 * nothing on screen, which reads as a hang rather than as work. Refusing early,
 * by name, is cheaper and clearer than any progress bar over the same mistake.
 */
export function assertProjectWorkspace(workspace: string): void {
  const reason = projectWorkspaceGuardReason(workspace);
  if (reason !== undefined) throw new Error(reason);
}

/** "your home directory" / "a drive root" when the workspace is one; undefined otherwise. */
function workspaceGuardLabel(workspace: string): string | undefined {
  const resolved = path.resolve(workspace);
  if (resolved === path.parse(resolved).root) return "a drive root";
  if (resolved === path.resolve(os.homedir())) return "your home directory";
  return undefined;
}

/** The full refusal for fingerprinting modes in a guarded directory; direct mode is exempt. */
export function projectWorkspaceGuardReason(workspace: string): string | undefined {
  const label = workspaceGuardLabel(workspace);
  if (label === undefined) return undefined;
  const resolved = path.resolve(workspace);
  return `${resolved} is ${label}, not a project. Fingerprinting and copying it${label === "your home directory" ? " — AppData, Downloads, and everything else —" : ""} `
    + "would mean minutes of hashing before Vanguard could answer, so isolated and baseline modes are refused here. "
    + "Direct mode works: it edits this directory with no fingerprints, copies, or baselines.";
}

/** True when an API key is reachable, either in the environment or the vault. */
function apiKeyAvailable(provider: Provider): boolean {
  if (provider === "ollama") return true;
  const credential = resolveCredential(provider);
  return credential !== null && credential.length > 0;
}

/** The credential for a provider the user actually chose; its absence is fatal. */
function requireCredential(provider: Provider): string {
  const credential = resolveCredential(provider);
  // Reproduce loadCredential's own diagnostic rather than a generic one.
  if (credential === null) return loadCredential(provider);
  return credential;
}

interface InstalledCredential {
  /** Put the caller's environment back exactly as it was. */
  restore(): void;
}

/**
 * The Windows credential helper returns a value without mutating this process.
 * Install it for the lifetime of the embedded engine so its worker inherits it,
 * and hand back the undo so a provider switch or shutdown restores the caller's
 * environment. A subscription login installs nothing: its token is read from
 * ~/.vanguard when a request is built, so no secret enters the environment.
 */
function installCredential(config: TuiConfig): InstalledCredential {
  if (config.auth !== "api-key") return { restore: () => {} };
  const credentialName = credentialVariable(config.provider);
  const previousCredential = process.env[credentialName];
  process.env[credentialName] = requireCredential(config.provider);
  return {
    restore: () => {
      if (previousCredential === undefined) delete process.env[credentialName];
      else process.env[credentialName] = previousCredential;
    },
  };
}

interface Readiness {
  /** Whether this provider can run right now without further setup. */
  readonly ready: boolean;
  readonly detail: string;
}

async function providerReadiness(provider: Provider): Promise<Readiness> {
  if (provider === "ollama") {
    return { ready: true, detail: "live local + Cloud discovery" };
  }
  if (supportsOAuth(provider)) {
    const status = await oauthStatus(provider);
    if (status.connected) {
      const who = status.account === undefined ? "signed in" : `signed in as ${status.account}`;
      return { ready: true, detail: status.expired === true ? "signed in · token expired, will refresh" : who };
    }
  }
  if (apiKeyAvailable(provider)) return { ready: true, detail: `${credentialVariable(provider)} set` };
  return supportsOAuth(provider)
    ? { ready: false, detail: "sign-in required" }
    : { ready: false, detail: `${credentialVariable(provider)} not set` };
}

async function chooseProvider(): Promise<Provider> {
  const readiness = await Promise.all(PROVIDER_CHOICES.map(async (choice) => ({
    choice,
    readiness: await providerReadiness(choice.id),
  })));
  const items: SelectItem<Provider>[] = readiness.map(({ choice, readiness: state }) => ({
    value: choice.id,
    label: choice.label,
    note: state.detail,
  }));
  // Start on the first provider that can actually run, so the common case is a
  // single Enter press.
  const ready = readiness.findIndex((entry) => entry.readiness.ready);
  return selectOrExit({
    title: "Provider",
    items,
    ...(ready === -1 ? {} : { initialIndex: ready }),
  });
}

/**
 * Decide how to authenticate. A stored sign-in or a present API key is used
 * without asking; only a provider with neither prompts, and only when it has a
 * subscription flow to offer.
 */
async function resolveAuth(provider: Provider): Promise<AuthMode> {
  const configured = process.env.VANGUARD_AUTH?.trim().toLowerCase();
  if (configured === "oauth" || configured === "api-key") {
    if (configured === "oauth" && !supportsOAuth(provider)) {
      throw new Error(`VANGUARD_AUTH=oauth is not available for ${provider}.`);
    }
    return configured;
  }
  if (!supportsOAuth(provider)) return "api-key";
  if ((await oauthStatus(provider)).connected) return "oauth";
  if (apiKeyAvailable(provider)) return "api-key";

  const label = providerChoice(provider).label;
  const method = await selectOrExit<AuthMode>({
    title: `Sign in to ${label}`,
    items: [
      { value: "oauth", label: "Subscription sign-in", note: "opens your browser" },
      { value: "api-key", label: "API key", note: credentialVariable(provider) },
    ],
  });
  if (method === "api-key") return "api-key";
  await signIn(provider);
  return "oauth";
}

/**
 * Open the browser and wait for consent. `force` re-authorizes even when a
 * valid token is stored, which is what an explicit /login needs in order to
 * switch accounts; the launch path leaves it off so a stored login is reused.
 */
async function signIn(provider: OAuthProvider, force = false): Promise<void> {
  process.stdout.write(`\n${ansi.dim}Opening your browser to sign in…${ansi.reset}\n`);
  const status = await oauthLogin(provider, {
    force,
    onAuthorizeUrl: (url) => {
      process.stdout.write(`${ansi.dim}If it does not open, visit:${ansi.reset}\n${url}\n\n`);
    },
  });
  const who = status.account === undefined ? "" : ` as ${ansi.bold}${status.account}${ansi.reset}`;
  process.stdout.write(`${ansi.green}✓${ansi.reset} Signed in to ${providerChoice(provider).label}${who}\n\n`);
}

interface ModelSelection {
  readonly id: string;
  readonly endpoint?: string;
}

async function chooseModel(provider: Provider, auth: AuthMode): Promise<ModelSelection> {
  if (provider === "ollama") return chooseOllamaModel();
  const items: SelectItem<string>[] = [];
  // A signed-in ChatGPT account reports the exact model slugs its backend
  // accepts, which beats guessing from a list baked in at build time. It is a
  // network call, so say so rather than looking hung.
  if (provider === "openai" && auth === "oauth") {
    process.stdout.write(`${ansi.dim}Loading models from your ChatGPT account…${ansi.reset}\n`);
    const live = await fetchCodexModels();
    // The account listing is advisory, never a verdict. It has mis-reported
    // real plans before (Pro Lite answered an empty list while its Codex
    // access worked), so an empty answer degrades to the static catalog with
    // a warning — the actual API request is the only authority on access. A
    // genuinely unentitled plan then fails one visible request instead of
    // being locked out by a stale plan guess here.
    if (live !== null && live.length === 0) {
      const plan = (await oauthStatus("openai")).plan;
      process.stdout.write(
        `${ansi.amber}Your ChatGPT account${plan === undefined ? "" : ` (plan: ${plan})`} reported no Codex models; `
        + `showing the standard ids anyway — if requests are refused, use /login claude or an API-key provider.${ansi.reset}\n`,
      );
    }
    for (const model of live ?? []) {
      items.push({ value: model.id, label: model.id, ...(model.label === undefined ? {} : { note: model.label }) });
    }
    if (items.length === 0 && live === null) {
      process.stdout.write(`${ansi.dim}Could not reach the model list; showing known ids.${ansi.reset}\n`);
    }
  }
  // A signed-in Claude subscription can be asked the same question, with the
  // same advisory semantics: the live list beats the baked-in one when it
  // answers, and never blocks the launch when it does not.
  if (provider === "anthropic" && auth === "oauth") {
    process.stdout.write(`${ansi.dim}Loading models from your Claude subscription…${ansi.reset}\n`);
    const live = await fetchClaudeModels();
    if (live !== null && live.length === 0) {
      process.stdout.write(
        `${ansi.amber}Your Claude subscription reported no models; showing the standard ids anyway — `
        + `the actual request decides access.${ansi.reset}\n`,
      );
    }
    const catalogNotes = new Map(providerChoice("anthropic").models.map((model) => [model.id, model.note]));
    for (const model of live ?? []) {
      const note = catalogNotes.get(model.id) ?? model.label;
      items.push({ value: model.id, label: model.id, ...(note === undefined ? {} : { note }) });
    }
    if (items.length === 0 && live === null) {
      process.stdout.write(`${ansi.dim}Could not reach the model list; showing the known default.${ansi.reset}\n`);
    }
  }
  if (provider === "kimi" && auth === "oauth") {
    process.stdout.write(`${ansi.dim}Loading models from your Kimi subscription...${ansi.reset}\n`);
    const live = await fetchKimiModels();
    for (const model of live ?? []) {
      const note = [
        model.supportsReasoning === true ? "reasoning" : undefined,
        model.contextLength === undefined ? undefined : `${Math.round(model.contextLength / 1_000)}k context`,
      ].filter((value): value is string => value !== undefined).join(" / ");
      items.push({ value: model.id, label: model.id, ...(note.length === 0 ? {} : { note }) });
    }
    if (live === null) process.stdout.write(`${ansi.dim}Could not reach the model list; showing the known default.${ansi.reset}\n`);
  }
  if (items.length === 0) {
    // The static fallback is auth-aware: a ChatGPT account rejects the bare
    // API model aliases, so it gets the Codex slug list instead.
    for (const model of catalogModels(provider, auth)) {
      items.push({ value: model.id, label: model.id, ...(model.note === undefined ? {} : { note: model.note }) });
    }
  }
  return { id: await selectOrExit({ title: `${providerChoice(provider).label} model`, items }) };
}

async function chooseOllamaModel(): Promise<ModelSelection> {
  process.stdout.write(`${ansi.dim}Discovering local and Ollama Cloud models…${ansi.reset}\n`);
  const discovery = await discoverOllamaModels();
  if (discovery.models.length === 0) {
    process.stdout.write(
      `${ansi.amber}Ollama did not answer locally and no Cloud API inventory was available; showing known ids.${ansi.reset}\n`,
    );
    const fallback = await selectOrExit({
      title: `Ollama model · discovery unavailable`,
      items: catalogModels("ollama", "api-key").map((model) => ({
        value: model.id,
        label: model.id,
        ...(model.note === undefined ? {} : { note: model.note }),
      })),
    });
    return { id: fallback };
  }

  const selected = await selectOrExit<OllamaModelChoice>({
    title: `Ollama models · ${discovery.models.length} discovered`,
    items: discovery.models.map((model) => ({ value: model, label: model.id, note: model.note })),
    hint: "Type to filter · ↑↓ move · Enter select · Esc cancel",
  });
  if (!selected.ready) {
    process.stdout.write(`${ansi.dim}Pulling ${selected.id} through your signed-in Ollama daemon…${ansi.reset}\n`);
    await prepareOllamaModel(selected, { localBaseUrl: discovery.localBaseUrl, timeoutMs: 120_000 });
  }
  return { id: selected.id, endpoint: selected.endpoint };
}

/**
 * What a user calls each subscription, mapped to the provider that serves it.
 * "claude" and "codex" are the names on the products; anthropic/openai are the
 * API vendors. Both are accepted so nobody has to guess which one this is.
 */
const LOGIN_ALIASES: Readonly<Record<string, OAuthProvider>> = {
  claude: "anthropic",
  anthropic: "anthropic",
  codex: "openai",
  chatgpt: "openai",
  openai: "openai",
  kimi: "kimi",
  moonshot: "kimi",
};

export function parseLoginTarget(argument: string): OAuthProvider | undefined {
  return LOGIN_ALIASES[argument.trim().toLowerCase()];
}

/**
 * `/login claude` | `/login codex`. Returns the configuration to switch to when
 * the sign-in should take effect immediately, or undefined to keep the current
 * one. A session already bound to a provider is never re-pointed underneath
 * itself; the token is stored and applies to the next Vanguard run.
 */
async function loginCommand(
  argument: string,
  config: TuiConfig,
  sessionStarted: boolean,
): Promise<TuiConfig | undefined> {
  if (argument.length === 0) {
    process.stdout.write(
      ` ${ansi.dim}Which subscription?${ansi.reset}\n`
      + ` ${ansi.violet}/login claude${ansi.reset}  ${ansi.dim}Claude Pro or Max${ansi.reset}\n`
      + ` ${ansi.violet}/login codex${ansi.reset}   ${ansi.dim}ChatGPT Plus or Pro${ansi.reset}\n`
      + ` ${ansi.violet}/login kimi${ansi.reset}    ${ansi.dim}Kimi Code subscription${ansi.reset}\n`,
    );
    return undefined;
  }
  const provider = parseLoginTarget(argument);
  if (provider === undefined) {
    process.stdout.write(`${ansi.amber}Unknown sign-in '${bounded(argument, 40)}'. Try /login claude, /login codex, or /login kimi.${ansi.reset}\n`);
    return undefined;
  }

  await signIn(provider, true);
  credentialCache.delete(provider);

  if (sessionStarted) {
    process.stdout.write(
      `${ansi.dim}This session keeps using ${config.provider} · ${config.model}. `
      + `The sign-in applies the next time you start Vanguard.${ansi.reset}\n\n`,
    );
    return undefined;
  }
  const model = provider === "kimi" ? (await chooseModel(provider, "oauth")).id : defaultModel(provider);
  process.stdout.write(`${ansi.dim}Now using${ansi.reset} ${providerChoice(provider).label} ${ansi.dim}·${ansi.reset} ${model}\n\n`);
  const { endpoint: _previousEndpoint, ...providerNeutralConfig } = config;
  return { ...providerNeutralConfig, provider, auth: "oauth", model };
}

/**
 * `/verify [build|tests]` — what completion must prove. Returns the config to
 * switch to, or undefined to keep the current one.
 */
async function verifyCommand(
  argument: string,
  config: TuiConfig,
  sessionStarted: boolean,
): Promise<TuiConfig | undefined> {
  if (config.detectedVerification) {
    process.stdout.write(
      ` ${ansi.dim}${path.basename(config.workspace)} supplies its own verifier `
      + `(${config.verification.command} ${config.verification.args.join(" ")}), which always gates completion.${ansi.reset}\n`,
    );
    return undefined;
  }
  const chosen = argument.length === 0
    ? await chooseVerificationMode(config.workspace)
    : argument.toLowerCase() === "build" || argument.toLowerCase() === "tests"
      ? argument.toLowerCase() as VerificationMode
      : undefined;
  if (chosen === undefined) {
    process.stdout.write(`${ansi.amber}Unknown mode '${bounded(argument, 40)}'. Use /verify build or /verify tests.${ansi.reset}\n`);
    return undefined;
  }
  if (chosen === config.verifyMode) {
    process.stdout.write(`${ansi.dim}Already ${chosen === "build" ? "building without a test gate" : "requiring tests"}.${ansi.reset}\n`);
    return undefined;
  }
  if (sessionStarted) {
    // The sealed verifier is frozen onto the session at creation; changing it
    // underneath a running task would invalidate the evidence already gathered.
    process.stdout.write(
      ` ${ansi.dim}This task keeps its current verifier. The change applies to the next task.${ansi.reset}\n`,
    );
  }
  process.stdout.write(
    ` ${ansi.dim}Completion now ${chosen === "build" ? "rests on tool evidence" : "requires a build/test contract"}.${ansi.reset}\n`,
  );
  return {
    ...config,
    verifyMode: chosen,
    verification: automaticVerificationCommand(chosen),
    adaptiveVerification: chosen === "tests",
  };
}

/** `/logout [claude|codex]` — with no argument, sign out of everything. */
async function logoutCommand(argument: string): Promise<void> {
  const targets: readonly OAuthProvider[] = argument.length === 0
    ? ["anthropic", "openai", "kimi"]
    : (() => {
      const provider = parseLoginTarget(argument);
      return provider === undefined ? [] : [provider];
    })();
  if (targets.length === 0) {
    process.stdout.write(`${ansi.amber}Unknown sign-in '${bounded(argument, 40)}'. Try /logout claude or /logout codex.${ansi.reset}\n`);
    return;
  }
  for (const provider of targets) {
    await oauthLogout(provider);
    credentialCache.delete(provider);
    process.stdout.write(`${ansi.dim}Signed out of ${providerChoice(provider).label}.${ansi.reset}\n`);
  }
}

/** The branded frame the launch selectors run inside; owns the whole screen. */
const LAUNCH_LOGO: readonly string[] = [
  "█   █  ███  █   █  ████  █   █  ███  ████   ████ ",
  "█   █ █   █ ██  █ █      █   █ █   █ █   █  █   █",
  "█   █ █████ █ █ █ █  ██  █   █ █████ ████   █   █",
  " █ █  █   █ █  ██ █   █  █   █ █   █ █  █   █   █",
  "  █   █   █ █   █  ████   ███  █   █ █   █  ████ ",
];

function renderLaunchHeader(workspace: string, columns = process.stdout.columns ?? 100): string {
  // Paint the FULL terminal width: a band that stops mid-screen reads as a
  // rendering bug, not a design.
  const width = Math.max(52, columns);
  const centered = (content: string): string => " ".repeat(Math.max(0, Math.floor((width - content.length) / 2))) + content;
  const logo = width >= 62
    ? LAUNCH_LOGO.map((row) => fillRow(`${ansi.bold}${centered(gradientText(row, [158, 118, 255], [112, 216, 255]))}${ansi.reset}`, width))
    : [fillRow(`${ansi.bold}${centered(gradientText("V A N G U A R D", [158, 118, 255], [112, 216, 255]))}${ansi.reset}`, width)];
  // The clear is the one moment scrollback resets are safe: launch. \x1b[2J
  // wipes the viewport; the terminal's scrollback survives it.
  return `\x1b[2J\x1b[H\n${logo.join("\n")}\n`
    + `${fillRow(`${ansi.slate}${centered("VANGUARD  ·  VERIFICATION-FIRST AGENTIC ENGINE")}${ansi.reset}`, width)}\n`
    + `${fillRow("", width)}\n`
    + `${fillRow(justifyAnsi(
      ` ${ansi.warmWhite}${bounded(workspace, width - 18)}${ansi.reset}`,
      `${ansi.cyan}LAUNCH${ansi.reset} `,
      width,
    ), width)}\n`
    + `${fillRow(`${ansi.ash}${"─".repeat(width)}${ansi.reset}`, width)}\n\n`;
}

export function renderLaunchHeaderForTest(workspace = "D:\\preview"): string {
  return renderLaunchHeader(workspace);
}

/** One answered launch question, folded into the growing recap. */
function confirmChoice(label: string, value: string): void {
  process.stdout.write(` ${ansi.green}✓${ansi.reset} ${ansi.dim}${label.padEnd(10)}${ansi.reset}${value}\n`);
}

async function selectOrExit<T>(options: Parameters<typeof select<T>>[0]): Promise<T> {
  try {
    return await select({ collapseOnClose: true, ...options });
  } catch (error) {
    if (error instanceof SelectCancelled) {
      process.stdout.write(`${ansi.dim}See you next time.${ansi.reset}\n`);
      process.exit(0);
    }
    throw error;
  }
}

function printCommandList(fx: TranscriptFx): void {
  fx.print(
    ` ${ansi.bold}Commands${ansi.reset}  ${ansi.dim}(insert with /, run with Enter)${ansi.reset}\n`
    + COMMAND_LIST.map((entry) => ` ${ansi.violet}${entry.command.padEnd(8)}${ansi.reset} ${ansi.dim}${entry.summary}${ansi.reset}`).join("\n"),
  );
}

/**
 * The two footer rows pinned under the transcript. Row one is the live
 * status — what is running, for how long, against which budget; row two is
 * the composer. This is the anti-freeze contract: even when the model thinks
 * for a full minute, row one keeps moving and says exactly what is happening.
 */
function buildFooterLines(state: UiState, config: TuiConfig, width: number): string[] {
  const mode = config.direct
    ? `${ansi.amber}● DIRECT${ansi.reset}`
    : config.inPlace
      ? `${ansi.amber}● LIVE${ansi.reset}`
      : `${ansi.slate}ISOLATED${ansi.reset}`;
  const right = `${contextGauge(state, config)}${ansi.cyan}${config.model}${ansi.reset}  ${mode} `;
  const left = statusLeft(state, config);
  const status = justifyAnsi(hardTruncate(left, Math.max(10, width - stripAnsi(right).length - 1)), right, width - 1);
  return [status, composerLine(state, width)];
}

function statusLeft(state: UiState, config: TuiConfig): string {
  if (state.pendingApproval !== undefined) {
    return ` ${ansi.amber}◇${ansi.reset} ${ansi.amber}${ansi.bold}awaiting approval${ansi.reset} ${ansi.dim}— 1/2/3 or ←→ · Enter confirms${ansi.reset}`;
  }
  const pending = oldestPendingTool(state);
  if (pending !== undefined) {
    const more = activeToolCount(state) - 1;
    // quietDetail already reads "title · detail" for the freshest tool start;
    // show it verbatim so the footer says what is running, not just that.
    const label = state.quietDetail.length > 0 ? state.quietDetail : pending.title;
    const others = more > 0 ? ` ${ansi.faint}+${more} more${ansi.reset}` : "";
    return ` ${ansi.cyan}${spinner[state.frame % spinner.length]!}${ansi.reset} ${ansi.warmWhite}${ansi.bold}${bounded(label, 64)}${ansi.reset} ${ansi.faint}${elapsed(pending.startedAt)}${others}${ansi.reset}`;
  }
  const thought = state.thinkingChars === 0
    ? ""
    : ` · ${state.thinkingChars < 1_000 ? state.thinkingChars : `${(state.thinkingChars / 1_000).toFixed(1)}k`} thought`;
  const stats = state.turnActive
    ? ` ${ansi.dim}${elapsed(state.startedAt)} · turn ${latestTurn(state)}/${config.maxSteps} · ${state.toolsRun} tools${thought}${state.lastCompaction === undefined ? "" : ` · ctx ${state.lastCompaction}`}${ansi.reset}`
    : "";
  switch (state.phase) {
    case "thinking": {
      // The live reasoning tail keeps a deep think readable as progress —
      // show the newest end of it, the way the thought is actually growing.
      const thought = state.thinkingTail.length === 0
        ? ""
        : ` ${ansi.violet}✦${ansi.reset} ${ansi.dim}${ansi.italic}…${state.thinkingTail.slice(-90).trimStart()}${ansi.reset}`;
      return ` ${ansi.cyan}${spinner[state.frame % spinner.length]!}${ansi.reset} ${ansi.bold}thinking…${ansi.reset}${stats}${thought}`;
    }
    case "tooling":
      return ` ${ansi.cyan}${spinner[state.frame % spinner.length]!}${ansi.reset} ${ansi.bold}settling tools…${ansi.reset}${stats}`;
    case "verifying":
      return ` ${ansi.violet}${spinner[state.frame % spinner.length]!}${ansi.reset} ${ansi.violet}${ansi.bold}verifying${ansi.reset} ${ansi.dim}completion is provisional until every verifier passes${stats}${ansi.reset}`;
    case "waiting":
      return ` ${ansi.amber}◇${ansi.reset} ${ansi.amber}${ansi.bold}waiting for you${ansi.reset} ${ansi.dim}— type your answer, Enter sends${ansi.reset}`;
    case "completed":
      return ` ${ansi.gold}◈${ansi.reset} ${ansi.gold}${ansi.bold}verified${ansi.reset} ${ansi.dim}${state.toolsRun} tools · ${state.filesTouched.length} files · ${elapsed(state.startedAt)}${ansi.reset}`;
    case "failed":
      return ` ${ansi.red}×${ansi.reset} ${ansi.red}${ansi.bold}stopped${ansi.reset} ${ansi.dim}${bounded(state.quietDetail, 80)}${ansi.reset}`;
    case "cancelling":
      return ` ${ansi.amber}${spinner[state.frame % spinner.length]!}${ansi.reset} ${ansi.amber}${ansi.bold}stopping…${ansi.reset} ${ansi.dim}${bounded(state.quietDetail, 60)}${ansi.reset}`;
    case "cancelled":
      return ` ${ansi.amber}■${ansi.reset} ${ansi.amber}${ansi.bold}interrupted${ansi.reset} ${ansi.dim}— send another message to resume${ansi.reset}`;
    default:
      return ` ${ansi.green}●${ansi.reset} ${ansi.green}${ansi.bold}ready${ansi.reset} ${ansi.dim}— /help for commands${ansi.reset}`;
  }
}

/**
 * The live context gauge: latest provider-reported prompt size against the
 * model family's published window. Unknown families show plain usage — an
 * invented percentage would be a lie with a progress bar's confidence.
 */
function contextGauge(state: UiState, config: TuiConfig): string {
  if (state.contextTokens <= 0) return "";
  const window = contextWindowTokens(config.model);
  const used = compactTokens(state.contextTokens);
  if (window === undefined) return `${ansi.faint}ctx ${used}${ansi.reset}  `;
  const percent = Math.min(999, Math.round((state.contextTokens / window) * 100));
  const color = percent >= 80 ? ansi.amber : ansi.faint;
  return `${color}ctx ${percent}% (${used}/${compactTokens(window)})${ansi.reset}  `;
}

function compactTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function composerLine(state: UiState, width: number): string {
  if (state.pendingApproval !== undefined) {
    const options = ["1 RUN ONCE", "2 ALLOW SESSION", "3 DENY"];
    const rendered = options.map((option, index) => index === state.pendingApproval!.selected
      ? `${ansi.cyan}❯${ansi.reset} ${ansi.amber}${ansi.bold}[${option}]${ansi.reset}`
      : `  ${ansi.slate}[${option}]${ansi.reset}`).join("  ");
    return ` ${rendered}`;
  }
  const prompt = ` ${ansi.cyan}▌${ansi.reset} `;
  return `${prompt}${renderComposer(state, Math.max(16, width - 5))}`;
}

/** Caret-aware composer: a sliding window keeps the caret visible. */
function renderComposer(state: UiState, visible: number): string {
  if (state.composer.length === 0) {
    return state.turnActive
      ? `${ansi.dim}steer or answer, then press Enter${ansi.reset}`
      : `${ansi.dim}message Vanguard · /help · exit to leave${ansi.reset}`;
  }
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

function latestTurn(state: UiState): number {
  return Math.max(0, ...[...state.agents.values()].map((agent) => agent.turn));
}

function oldestPendingTool(state: UiState): { title: string; detail?: string | undefined; startedAt: number } | undefined {
  let oldest: { title: string; detail?: string | undefined; startedAt: number } | undefined;
  for (const [title, starts] of state.toolStartedAt.entries()) {
    for (const startedAt of starts) {
      if (oldest === undefined || startedAt < oldest.startedAt) oldest = { title, startedAt };
    }
  }
  return oldest;
}

/**
 * Print-side effects for public run events: the transcript adapter. Message
 * dedup lives here — the same text arriving twice in a row (an ask_user
 * decision message and its run.waiting_for_user echo) prints exactly once.
 */
function createTranscriptFx(renderer: InlineRenderer, terminalWidth: () => number): TranscriptFx {
  let lastMessageKey = "";
  return {
    print: (lines) => renderer.print(lines),
    note: (text) => renderer.print(formatNote(text)),
    beginStream: (agentId) => renderer.beginStream(streamPrefix(agentId)),
    writeStream: (chunk) => renderer.writeStream(chunk),
    endStream: () => renderer.endStream(),
    message(agentId, text) {
      const key = `${agentId}\n${text.trim()}`;
      if (key === lastMessageKey) return;
      lastMessageKey = key;
      renderer.print(formatChatMessage(agentId, text, terminalWidth()));
    },
  };
}

function consumeEvent(event: PublicRunEvent, state: UiState, fx: TranscriptFx, terminalWidth: () => number): void {
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
    state.quietDetail = event.materialized === true && state.inPlace
      ? "Live project ready; edits now write to the selected folder"
      : "Session ready; preparing safely before execution";
    fx.note(event.materialized === true && state.inPlace
      ? `session ${event.sessionId ?? ""} ready — edits land in the live project`
      : `session ${event.sessionId ?? ""} ready`);
    return;
  }
  if (event.type === "run.contracted") {
    state.contracted = true;
    if (event.detail !== undefined) state.task = event.detail;
    state.quietDetail = state.inPlace
      ? "Task contract accepted; capturing rollback baseline for the live project"
      : "Task contract accepted; isolated workspace prepared";
    fx.print(`  ${ansi.gold}▸${ansi.reset} ${ansi.gold}${ansi.bold}task contract accepted${ansi.reset}${event.detail === undefined ? "" : ` ${ansi.dim}— ${bounded(event.detail, 180)}${ansi.reset}`}`);
    return;
  }
  if (event.type === "agent.usage") {
    const tokens = Number(event.detail);
    if (Number.isFinite(tokens) && tokens > 0) state.contextTokens = tokens;
    return;
  }
  if (event.type === "agent.thinking" && event.message !== undefined) {
    // Live reasoning progress: never printed to the transcript, only the
    // footer's rolling tail — the anti-freeze contract for deep thinkers.
    if (activeToolCount(state) === 0 && state.phase !== "verifying") state.phase = "thinking";
    state.thinkingChars += event.message.length;
    state.thinkingTail = `${state.thinkingTail} ${event.message}`.replace(/\s+/gu, " ").slice(-200);
    return;
  }
  if (event.type === "agent.delta" && event.message !== undefined) {
    if (activeToolCount(state) === 0 && state.phase !== "verifying") state.phase = "thinking";
    state.thinkingTail = "";
    // Stream the reply into the transcript as it is generated, formatting each
    // markdown span once it closes rather than printing its markers raw.
    if (state.conversationStreamed.length === 0) fx.beginStream(event.agentId);
    state.conversationStreamed += event.message;
    const { ready, held } = splitStreamableMarkdown(state.streamHeld + event.message);
    if (ready.length > 0) fx.writeStream(renderMarkdownLite(ready));
    state.streamHeld = held;
    state.streamLineOpen = true;
    return;
  }
  if (event.type === "agent.stream_started" || event.type === "agent.stream_reset") {
    if (activeToolCount(state) === 0 && state.phase !== "verifying") state.phase = "thinking";
    if (event.type === "agent.stream_reset") {
      state.thinkingTail = "";
      state.thinkingChars = 0;
    }
    // A fresh or replayed attempt owns the provisional line from here on.
    if (state.streamLineOpen) fx.endStream();
    if (state.conversationStreamed.length > 0) {
      fx.note("(stream reset — retrying)");
      state.conversationStreamed = "";
      state.streamHeld = "";
      state.streamLineOpen = false;
    }
    return;
  }
  if (event.type === "agent.stream_committed") return;
  if (event.type === "context.compacted") {
    if (event.detail !== undefined) state.lastCompaction = event.detail;
    fx.note(`${event.title}${event.detail === undefined ? "" : ` — ${event.detail}`}`);
    return;
  }
  if (event.type === "agent.stream_failed") {
    if (event.detail !== undefined) state.quietDetail = `Model stream failed: ${event.detail}`;
    if (state.streamLineOpen) {
      // A failed stream still owns text on screen; close the line cleanly.
      if (state.streamHeld.length > 0) fx.writeStream(renderMarkdownLite(state.streamHeld));
      fx.endStream();
      state.conversationStreamed = "";
      state.streamHeld = "";
      state.streamLineOpen = false;
    }
    fx.note(`model stream failed${event.detail === undefined ? "" : ` — ${bounded(event.detail, 140)}`}`);
    return;
  }
  if (event.type === "agent.message" && event.message !== undefined) {
    state.chat.push({ agentId: event.agentId, message: event.message, ...(event.turn === undefined ? {} : { turn: event.turn }) });
    trimTo(state.chat, 200);
    state.conversationMessages.push(event.message);
    trimTo(state.conversationMessages, 20);
    if (state.conversationStreamed.length > 0 && state.conversationStreamed.trim() === event.message.trim()) {
      // The reply already streamed live; print whatever span was still being
      // held, then settle the line. Nothing prints twice.
      if (state.streamHeld.length > 0) fx.writeStream(renderMarkdownLite(state.streamHeld));
      fx.endStream();
    } else {
      if (state.streamLineOpen) fx.endStream();
      fx.message(event.agentId, event.message);
    }
    state.conversationStreamed = "";
    state.streamHeld = "";
    state.streamLineOpen = false;
    if (!state.contracted) state.outcome = { status: "responded", message: event.message };
    return;
  }
  if (event.type === "tool.started") {
    state.phase = "tooling";
    state.thinkingTail = "";
    agent.action = event.title;
    agent.status = "active";
    state.quietDetail = event.detail === undefined ? `Running ${event.title}` : `${event.title} · ${event.detail}`;
    const startQueue = state.toolStartedAt.get(event.title) ?? [];
    startQueue.push(Date.now());
    state.toolStartedAt.set(event.title, startQueue);
    return;
  }
  if (event.type === "tool.completed" || event.type === "tool.failed") {
    const startQueue = state.toolStartedAt.get(event.title);
    const startedAt = startQueue?.shift();
    if (startQueue?.length === 0) state.toolStartedAt.delete(event.title);
    // The runtime measures the exact call when it can; the local bracket is a
    // fallback that spans fingerprinting and journaling and shares one start
    // timestamp across a whole batch — a superset, not a per-tool truth.
    const durationMs = event.durationMs
      ?? (startedAt === undefined ? undefined : Date.now() - startedAt);
    const status = event.status === "failed" ? "failed" : "passed";
    fx.print(formatToolCard({
      status,
      title: event.title,
      ...(event.detail === undefined ? {} : { detail: event.detail }),
      ...(durationMs === undefined ? {} : { durationMs }),
      agentId: event.agentId,
      width: terminalWidth(),
    }));
    state.toolsRun += 1;
    if (status === "passed" && /replace|write|delete|apply/u.test(event.title)) {
      const touched = event.detail?.split(" · ")[0];
      if (touched !== undefined && touched.length > 1 && !state.filesTouched.includes(touched)) {
        state.filesTouched.push(touched);
        trimTo(state.filesTouched, 40);
      }
    }
    const remainingTools = activeToolCount(state);
    if (remainingTools === 0) {
      state.phase = "thinking";
      state.quietDetail = event.status === "failed"
        ? `${event.title} failed; choosing a recovery path`
        : `Reviewing ${event.title} result`;
      agent.action = event.status === "failed" ? "recovering" : "reviewing result";
    } else {
      state.phase = "tooling";
      state.quietDetail = `${remainingTools} tool ${remainingTools === 1 ? "call" : "calls"} still in progress`;
      agent.action = `waiting on ${remainingTools} tool ${remainingTools === 1 ? "call" : "calls"}`;
    }
    return;
  }
  if (event.type === "completion.claimed") {
    agent.action = "verification";
    state.phase = "verifying";
    state.quietDetail = "Completion is provisional until every verifier passes";
    fx.print(`  ${ansi.violet}◈${ansi.reset} ${ansi.dim}completion claimed — independent verification is running${ansi.reset}`);
    return;
  }
  if (event.type === "verification.completed") {
    const passed = event.status === "passed";
    state.verifiers.set(event.title, passed);
    state.phase = passed ? "verifying" : "thinking";
    fx.print(`  ${ansi.gold}◈${ansi.reset} ${ansi.warmWhite}${event.title}${ansi.reset} — ${passed ? `${ansi.green}passed${ansi.reset}` : `${ansi.red}failed${ansi.reset}`}`);
    return;
  }
  if (event.type === "run.completed") {
    agent.status = "done";
    state.outcome = { status: "completed" };
    fx.print(formatVerifiedSeal(`${state.toolsRun} tools · ${state.filesTouched.length} files · ${elapsed(state.startedAt)}`));
    return;
  }
  if (event.type === "run.failed") {
    agent.status = "failed";
    // The event carries why it stopped; print the reason once, here.
    state.outcome = { status: "failed", ...(event.detail === undefined ? {} : { message: event.detail }) };
    if (event.detail !== undefined) state.quietDetail = event.detail;
    fx.print(`  ${ansi.red}×${ansi.reset} ${ansi.red}${bounded(event.detail ?? "Run failed", 220)}${ansi.reset}`);
    return;
  }
  if (event.type === "approval.requested") {
    agent.status = "idle";
    state.phase = "waiting";
    state.quietDetail = "Waiting for you to approve a command";
    state.pendingApproval = { command: event.detail ?? "(unknown command)", selected: 0 };
    fx.print(formatApprovalBlock(state.pendingApproval.command, terminalWidth()));
    return;
  }
  if (event.type === "run.waiting_for_user") {
    agent.status = "idle";
    state.phase = "waiting";
    state.quietDetail = "Vanguard asked you a question — type your answer and press Enter";
    if (event.message !== undefined) {
      state.chat.push({ agentId: event.agentId, message: event.message });
      trimTo(state.chat, 200);
      fx.message(event.agentId, event.message);
    }
    state.outcome = {
      status: "waiting_for_user",
      ...(event.message === undefined ? {} : { question: event.message }),
    };
    return;
  }
  // Everything else (recovery.scheduled, recovery.exhausted, replan notes…)
  // still earns one honest line instead of silence.
  if (event.title.length > 0) {
    const line = event.status === "failed"
      ? `  ${ansi.red}×${ansi.reset} ${ansi.red}${event.title}${event.detail === undefined ? "" : ` — ${bounded(event.detail, 160)}`}${ansi.reset}`
      : formatNote(`${event.title}${event.detail === undefined ? "" : ` — ${event.detail}`}`);
    fx.print(line);
  }
}

function settleTurnUi(
  state: UiState,
  outcome: TurnOutcome,
  engineState: VanguardSessionStatus["state"],
  cancelled: boolean,
): void {
  if (cancelled || engineState === "cancelled") {
    state.phase = "cancelled";
    state.quietDetail = "Run interrupted; send another message to resume this session";
  } else if (outcome.status === "completed") {
    state.phase = "completed";
    state.quietDetail = "Independent verification accepted the result";
    const main = state.agents.get("main");
    if (main !== undefined) main.status = "done";
  } else if (outcome.status === "waiting_for_user") {
    state.phase = "waiting";
    state.quietDetail = "Vanguard is waiting for your answer";
  } else if (outcome.status === "failed") {
    state.phase = "failed";
    state.quietDetail = state.error ?? "Run stopped before verified completion";
  } else {
    // Conversation turns end in `responded`, not `completed`. Leaving this
    // branch implicit kept the footer spinning as THINKING forever even
    // though the engine and composer were already idle.
    state.phase = "idle";
    state.quietDetail = "Ready for your next message";
    const main = state.agents.get("main");
    if (main !== undefined) {
      main.status = "idle";
      main.action = "ready";
    }
  }
}

function activeToolCount(state: UiState): number {
  let count = 0;
  for (const starts of state.toolStartedAt.values()) count += starts.length;
  return count;
}

const silentFx: TranscriptFx = {
  print: () => {},
  note: () => {},
  beginStream: () => {},
  writeStream: () => {},
  endStream: () => {},
  message: () => {},
};

export function inspectTuiLifecycleForTest(
  events: readonly PublicRunEvent[],
  terminalOutcome?: TurnOutcome,
): { phase: Phase; activeTools: number; action: string; detail: string; contextTokens: number } {
  const state: UiState = {
    phase: "thinking",
    startedAt: Date.now(),
    frame: 0,
    quietDetail: "Understanding your request",
    task: "test",
    inPlace: false,
    agents: new Map([["main", { id: "main", turn: 0, action: "listening", status: "active" }]]),
    chat: [],
    verifiers: new Map(),
    contracted: true,
    composer: "",
    composerCursor: 0,
    composerHistory: [],
    composerHistoryIndex: -1,
    conversationStreamed: "",
    streamHeld: "",
    streamLineOpen: false,
    toolStartedAt: new Map(),
    turnActive: true,
    toolsRun: 0,
    filesTouched: [],
    conversationMessages: [],
    thinkingTail: "",
    thinkingChars: 0,
    contextTokens: 0,
  };
  for (const event of events) consumeEvent(event, state, silentFx, () => 100);
  if (terminalOutcome !== undefined) settleTurnUi(state, terminalOutcome, "idle", false);
  return {
    phase: state.phase,
    activeTools: activeToolCount(state),
    action: state.agents.get("main")?.action ?? "",
    detail: state.quietDetail,
    contextTokens: state.contextTokens,
  };
}

/** Feed events through consumeEvent and capture exactly what the user would see. */
export function renderTranscriptForTest(events: readonly PublicRunEvent[], width = 100): string {
  let output = "";
  const renderer = new InlineRenderer({ write: (text) => { output += text; return true; } }, () => width);
  const fx = createTranscriptFx(renderer, () => width);
  const state: UiState = {
    phase: "thinking",
    startedAt: Date.now() - 65_000,
    frame: 3,
    quietDetail: "Understanding your request",
    task: "Repair the project and prove it works.",
    inPlace: false,
    agents: new Map([["main", { id: "main", turn: 0, action: "listening", status: "active" }]]),
    chat: [{ agentId: "you", message: "Repair the project and prove it works." }],
    verifiers: new Map(),
    contracted: true,
    composer: "",
    composerCursor: 0,
    composerHistory: [],
    composerHistoryIndex: -1,
    conversationStreamed: "",
    streamHeld: "",
    streamLineOpen: false,
    toolStartedAt: new Map(),
    turnActive: true,
    toolsRun: 0,
    filesTouched: [],
    conversationMessages: [],
    thinkingTail: "",
    thinkingChars: 0,
    contextTokens: 0,
  };
  for (const event of events) consumeEvent(event, state, fx, () => width);
  return flattenInlineProtocol(output);
}

/**
 * Replay the inline renderer's erase-append-repaint protocol into the final
 * screen content (scrollback plus live region). The renderer re-paints the
 * open stream row and footer on every frame; asserting on raw concatenated
 * writes would count those repaints as duplicate text when a real terminal
 * erased them.
 */
export function flattenInlineProtocol(output: string): string {
  const rows: string[] = [""];
  let at = 0;
  while (at < output.length) {
    const erase = output.slice(at).match(/^(?:\x1b\[(\d+)A)?\r\x1b\[J/);
    if (erase !== null) {
      const up = erase[1] === undefined ? 0 : Number(erase[1]);
      rows.splice(Math.max(0, rows.length - 1 - up));
      rows.push("");
      at += erase[0].length;
      continue;
    }
    if (output[at] === "\n") {
      rows.push("");
      at += 1;
      continue;
    }
    rows[rows.length - 1] = `${rows[rows.length - 1] ?? ""}${output[at] ?? ""}`;
    at += 1;
  }
  return rows.join("\n");
}

/** The footer a representative running state would pin under the transcript. */
export function renderFooterForTest(phase: Phase = "thinking", width = 100): string[] {
  const config: TuiConfig = {
    workspace: "C:\\projects\\preview",
    provider: "deepseek",
    auth: "api-key",
    verifyMode: "tests",
    detectedVerification: true,
    model: "deepseek-v4-pro",
    verification: { command: "npm", args: ["test"] },
    adaptiveVerification: false,
    maxSteps: 240,
    inPlace: false,
    direct: false,
  };
  const state: UiState = {
    phase,
    startedAt: Date.now() - 65_000,
    frame: 3,
    quietDetail: "check_project · trusted project verification",
    task: "Repair the project and prove it works.",
    inPlace: false,
    agents: new Map([["main", { id: "main", turn: 7, action: "check_project", status: "active" }]]),
    chat: [],
    verifiers: new Map([["workspace integrity", true]]),
    contracted: true,
    composer: "",
    composerCursor: 0,
    composerHistory: [],
    composerHistoryIndex: -1,
    conversationStreamed: "",
    streamHeld: "",
    streamLineOpen: false,
    toolStartedAt: phase === "tooling" ? new Map([["check_project", [Date.now() - 12_000]]]) : new Map(),
    turnActive: true,
    toolsRun: 12,
    filesTouched: ["src/main.ts"],
    conversationMessages: [],
    thinkingTail: "",
    thinkingChars: 0,
    contextTokens: 0,
  };
  return buildFooterLines(state, config, width);
}

/** One line describing what completion has to prove. */
function verificationSummary(config: TuiConfig): string {
  if (config.detectedVerification) {
    return `${config.verification.command} ${config.verification.args.join(" ")} ${ansi.dim}(this project's own)${ansi.reset}`;
  }
  return config.verifyMode === "build"
    ? `${ansi.amber}build${ansi.reset} ${ansi.dim}· tool evidence only, no test gate · /verify tests to change${ansi.reset}`
    : `${ansi.dim}tests · Vanguard must establish a build/test contract · /verify build to change${ansi.reset}`;
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

function repositoryRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

function configuredProvider(): Provider {
  const configured = process.env.VANGUARD_PROVIDER?.trim() ?? "";
  const provider = parseSelectableProvider(configured);
  if (provider === undefined) throw new Error("VANGUARD_PROVIDER must be deepseek, openai, anthropic, kimi, or ollama.");
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

function automaticVerificationCommand(mode: VerificationMode): CommandSpec {
  return { command: "node", args: [path.join(import.meta.dirname, "autoVerify.js"), "--mode", mode] };
}

/** Per-character RGB gradient for brand text. */
function gradientText(text: string, from: readonly [number, number, number], to: readonly [number, number, number]): string {
  const steps = Math.max(1, text.length - 1);
  return [...text].map((character, index) => {
    const t = index / steps;
    const r = Math.round(from[0] + (to[0] - from[0]) * t);
    const g = Math.round(from[1] + (to[1] - from[1]) * t);
    const b = Math.round(from[2] + (to[2] - from[2]) * t);
    return `\x1b[38;2;${r};${g};${b}m${character}`;
  }).join("");
}

/** Paint an entire terminal row, including padding after nested ANSI resets. */
function fillRow(value: string, width: number): string {
  return padAnsi(value, width);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
