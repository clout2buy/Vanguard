import { readFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "../kernel/contracts.js";
import { nodePermissionFlag, resolveNodePackageManagerAlias } from "../runtime/nodePackageManager.js";
import { detectProjectVerification, type CommandSpec } from "../runtime/projectVerification.js";
import { isCleanGitRepository } from "../runtime/gitTree.js";
import {
  extensionRuntimeState,
  resolveExtensions,
  resolveSecurityPolicy,
  type SecurityProfile,
} from "../index.js";

export interface CliOptions {
  readonly workspace: string;
  readonly task: string;
  readonly provider: "openai" | "anthropic" | "deepseek" | "kimi" | "ollama" | "openai-compatible" | "http";
  /** Environment variable naming the API key for an openai-compatible endpoint. */
  readonly credentialVariable?: string;
  readonly model: string;
  /** Credential source. Defaults to the provider's API-key environment variable. */
  readonly auth?: "api-key" | "oauth";
  /** Runtime-enforced capability profile for delegated children. */
  readonly agentProfile: "coder" | "explore" | "plan";
  /** What the pre-claim gate accepts after a mutation. Defaults to independent execution. */
  readonly executionEvidence?: "independent" | "syntax";
  readonly endpoint?: string;
  readonly verification: CommandSpec;
  readonly adaptiveVerification?: boolean;
  readonly allowedCommands: readonly string[];
  readonly maxSteps: number;
  readonly maxDurationMs: number;
  readonly commandTimeoutMs: number;
  readonly commandIdleTimeoutMs?: number;
  /** Reasoning depth for OpenAI and Kimi; defaults to medium (env: VANGUARD_REASONING_EFFORT). "max" is Kimi's unbounded ceiling; OpenAI clamps it to high. */
  readonly reasoningEffort?: "low" | "medium" | "high" | "max";
  readonly maxContextBytes: number;
  readonly maxFailedVerificationAttempts: number;
  readonly protectedPaths: readonly string[];
  readonly editableRoots: readonly string[];
  readonly securityProfile?: SecurityProfile;
  readonly restrictProcess: boolean;
  readonly verifierEvidence: "full" | "summary";
  readonly publicCheck?: CommandSpec;
  readonly exposeRawProcess: boolean;
  readonly disableExtensions: boolean;
  readonly extensions?: JsonValue;
  readonly extensionInstructions?: string;
}

export function parseArgumentMap(args: readonly string[]): Map<string, string[]> {
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

export async function parseOptions(
  args: readonly string[],
  behavior: { requireTask?: boolean } = {},
): Promise<CliOptions> {
  const requireTask = behavior.requireTask !== false;
  const values = parseArgumentMap(args);
  const workspace = required(values, "--workspace");
  const disableExtensionsRaw = single(values, "--disable-extensions");
  const disableExtensions = disableExtensionsRaw === undefined
    ? false
    : parseBoolean(disableExtensionsRaw, "--disable-extensions");
  const resolvedExtensions = await resolveExtensions({
    workspaceRoot: workspace,
    disableExtensions,
  });
  const task = await resolveTaskInput(values, requireTask);
  const provider = required(values, "--provider");
  if (provider !== "openai" && provider !== "anthropic" && provider !== "deepseek" && provider !== "kimi" && provider !== "ollama"
    && provider !== "openai-compatible" && provider !== "http") {
    throw new Error("--provider must be openai, anthropic, deepseek, kimi, ollama, openai-compatible, or http.");
  }
  const credentialVariable = single(values, "--credential-variable");
  if (provider === "openai-compatible" && credentialVariable === undefined) {
    throw new Error("--provider openai-compatible requires --credential-variable, an environment-variable name like OPENROUTER_API_KEY.");
  }
  if (credentialVariable !== undefined) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(credentialVariable)) {
      throw new Error("--credential-variable must be an environment-variable name like OPENROUTER_API_KEY.");
    }
    if (provider === "http") throw new Error("--credential-variable is not supported for --provider http.");
  }
  const authRaw = single(values, "--auth");
  if (authRaw !== undefined && authRaw !== "api-key" && authRaw !== "oauth") {
    throw new Error("--auth must be api-key or oauth.");
  }
  const evidenceRaw = single(values, "--execution-evidence");
  if (evidenceRaw !== undefined && evidenceRaw !== "independent" && evidenceRaw !== "syntax") {
    throw new Error("--execution-evidence must be independent or syntax.");
  }
  if (authRaw === "oauth" && provider !== "openai" && provider !== "anthropic" && provider !== "kimi") {
    throw new Error("--auth oauth is available only for the openai, anthropic, and kimi providers.");
  }
  const agentProfileRaw = single(values, "--agent-profile") ?? "coder";
  if (agentProfileRaw !== "coder" && agentProfileRaw !== "explore" && agentProfileRaw !== "plan") {
    throw new Error("--agent-profile must be coder, explore, or plan.");
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
  const commandIdleTimeoutRaw = single(values, "--command-idle-timeout-ms");
  const commandIdleTimeoutMs = commandIdleTimeoutRaw === undefined ? undefined : Number(commandIdleTimeoutRaw);
  if (commandIdleTimeoutMs !== undefined && (!Number.isSafeInteger(commandIdleTimeoutMs) || commandIdleTimeoutMs < 1)) {
    throw new Error("--command-idle-timeout-ms must be a positive integer.");
  }
  const reasoningEffort = single(values, "--reasoning-effort");
  if (reasoningEffort !== undefined && reasoningEffort !== "low" && reasoningEffort !== "medium"
    && reasoningEffort !== "high" && reasoningEffort !== "max") {
    throw new Error("--reasoning-effort must be low, medium, high, or max.");
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
  const security = resolveSecurityPolicy({
    profile: parseSecurityProfile(single(values, "--security-profile") ?? "workspace"),
    ...(single(values, "--restrict-process") === undefined
      ? {}
      : { restrictProcess: parseBoolean(single(values, "--restrict-process")!, "--restrict-process") }),
    ...(single(values, "--expose-raw-process") === undefined
      ? {}
      : { exposeRawProcess: parseBoolean(single(values, "--expose-raw-process")!, "--expose-raw-process") }),
    ...(single(values, "--verifier-evidence") === undefined
      ? {}
      : { verifierEvidence: parseEvidenceMode(single(values, "--verifier-evidence")!) }),
  });
  return {
    workspace,
    task,
    provider,
    model,
    agentProfile: agentProfileRaw,
    ...(authRaw === undefined ? {} : { auth: authRaw }),
    ...(evidenceRaw === undefined ? {} : { executionEvidence: evidenceRaw }),
    verification,
    ...(adaptiveVerification === undefined ? {} : { adaptiveVerification: parseBoolean(adaptiveVerification, "--adaptive-verification") }),
    allowedCommands: values.get("--allow-command") ?? [],
    protectedPaths: values.get("--protect") ?? [],
    editableRoots: values.get("--editable-root") ?? [],
    securityProfile: security.profile,
    restrictProcess: security.restrictProcess,
    exposeRawProcess: security.exposeRawProcess,
    disableExtensions,
    verifierEvidence: security.verifierEvidence,
    ...(publicCheck === undefined ? {} : { publicCheck }),
    maxSteps,
    maxDurationMs,
    commandTimeoutMs,
    ...(commandIdleTimeoutMs === undefined ? {} : { commandIdleTimeoutMs }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    maxContextBytes,
    maxFailedVerificationAttempts,
    ...(single(values, "--endpoint") === undefined ? {} : { endpoint: single(values, "--endpoint")! }),
    ...(credentialVariable === undefined ? {} : { credentialVariable }),
    extensions: extensionRuntimeState(resolvedExtensions),
    ...(resolvedExtensions.instructions.length === 0 ? {} : { extensionInstructions: resolvedExtensions.instructions }),
  };
}

export async function resolveTaskInput(
  values: ReadonlyMap<string, string[]>,
  requiredTask: boolean,
): Promise<string> {
  const inline = single(values, "--task");
  const file = single(values, "--task-file");
  if (inline !== undefined && file !== undefined) {
    throw new Error("--task and --task-file are mutually exclusive.");
  }
  if (file !== undefined) {
    if (file.length === 0) throw new Error("--task-file requires a path.");
    let bytes: Buffer;
    try {
      bytes = await readFile(path.resolve(file));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read --task-file '${file}': ${detail}`);
    }
    let task: string;
    try {
      task = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`--task-file is not valid UTF-8: ${file}`);
    }
    if (requiredTask && task.length === 0) throw new Error("--task-file must not be empty.");
    return task;
  }
  if (inline !== undefined) {
    if (requiredTask && inline.length === 0) throw new Error("--task is required.");
    return inline;
  }
  if (requiredTask) throw new Error("Supply exactly one of --task or --task-file.");
  return "";
}

export async function readRunConfiguration(file: string): Promise<CliOptions> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as { version?: number; options?: CliOptions };
  if (parsed.version !== 1 || parsed.options === undefined) {
    throw new Error("Session run configuration is missing or unsupported.");
  }
  return {
    ...parsed.options,
    securityProfile: parsed.options.securityProfile ?? "workspace",
    commandTimeoutMs: parsed.options.commandTimeoutMs ?? 1_800_000,
    disableExtensions: parsed.options.disableExtensions ?? false,
    agentProfile: parsed.options.agentProfile ?? "coder",
  };
}

export function parseResumeSession(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--session" || args[1] === undefined || args[1].length === 0) {
    throw new Error("Resume usage: vanguard resume --session SESSION_PATH");
  }
  return args[1];
}

/**
 * In-place mode is an explicit opt-in: the agent edits the real project tree
 * directly and the session copy becomes the pristine review/undo baseline.
 */
export function inPlaceRequested(args: readonly string[]): boolean {
  if (args.includes("--in-place")) return true;
  const environment = process.env.VANGUARD_IN_PLACE?.trim().toLowerCase() ?? "";
  return environment === "1" || environment === "true" || environment === "yes";
}

/**
 * Direct mode edits the launch directory with no fingerprint, no session copy,
 * and no baseline — the zero-ceremony mode. Implies in-place.
 */
export function directRequested(args: readonly string[]): boolean {
  if (args.includes("--direct")) return true;
  const environment = process.env.VANGUARD_IN_PLACE?.trim().toLowerCase() ?? "";
  return environment === "direct";
}

/**
 * Isolated mode (disposable copy) is the fallback, and can be forced when a
 * clean git repository would otherwise default to direct.
 */
export function isolatedRequested(args: readonly string[]): boolean {
  if (args.includes("--isolated")) return true;
  const environment = process.env.VANGUARD_IN_PLACE?.trim().toLowerCase() ?? "";
  return environment === "isolated" || environment === "off" || environment === "0" || environment === "no" || environment === "false";
}

/**
 * Workspace mode resolution: explicit flags/env win first. With no explicit
 * choice, a clean git repository already provides review (git diff), undo
 * (git checkout), and a drift baseline, so Vanguard skips the copy and
 * fingerprint tax and works direct. Anything else keeps the isolated copy.
 */
export async function sessionModeFor(args: readonly string[], workspace: string): Promise<{ inPlace?: boolean; direct?: boolean }> {
  if (directRequested(args)) return { inPlace: true, direct: true };
  if (inPlaceRequested(args)) return { inPlace: true };
  if (isolatedRequested(args)) return {};
  if (await isCleanGitRepository(workspace)) {
    process.stderr.write("vanguard: clean git repository — working directly in it (no copy, no baseline; git is your undo). --isolated overrides.\n");
    return { inPlace: true, direct: true };
  }
  return {};
}

export function requiredArgument(args: readonly string[], name: string): string {
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === name && args[index + 1] !== undefined) return args[index + 1]!;
  }
  throw new Error(`${name} is required.`);
}

export function commandAliases(
  workspaceRoot: string,
  restricted: boolean,
  writableRoots: readonly string[],
): Record<string, { executable: string; argsPrefix: string[] }> {
  const nodePrefix = restricted
    ? [
        nodePermissionFlag(),
        `--allow-fs-read=${workspaceRoot}`,
        ...writableRoots.map((root) => `--allow-fs-write=${root}`),
      ]
    : [];
  const npm = resolveNodePackageManagerAlias("npm");
  const npx = resolveNodePackageManagerAlias("npx");
  return {
    node: { executable: process.execPath, argsPrefix: nodePrefix },
    ...(npm === undefined ? {} : { npm: { executable: npm.executable, argsPrefix: [...npm.argsPrefix] } }),
    ...(npx === undefined ? {} : { npx: { executable: npx.executable, argsPrefix: [...npx.argsPrefix] } }),
  };
}

export function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

export function parseSecurityProfile(value: string): SecurityProfile {
  if (value === "workspace" || value === "guarded") return value;
  throw new Error("--security-profile must be workspace or guarded.");
}

export function parseEvidenceMode(value: string): "full" | "summary" {
  if (value === "full" || value === "summary") return value;
  throw new Error("--verifier-evidence must be full or summary.");
}

export function boundedEnvironmentInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function required(values: ReadonlyMap<string, string[]>, name: string): string {
  const value = single(values, name);
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

export function single(values: ReadonlyMap<string, string[]>, name: string): string | undefined {
  const all = values.get(name);
  if (all !== undefined && all.length > 1) throw new Error(`${name} may only be supplied once.`);
  return all?.[0];
}

export function printUsage(): void {
  process.stdout.write("Kimi Code: vanguard login kimi; use --provider kimi --model kimi-for-coding --auth oauth.\n\n");
  process.stdout.write(`Safe review/apply commands:\n  vanguard review --session SESSION_PATH\n  vanguard apply --session SESSION_PATH --manifest SHA256 --confirm SHA256\n  vanguard undo --session SESSION_PATH --apply TRANSACTION_ID --confirm TRANSACTION_ID\n  vanguard session checkpoint|list|restore|fork --session SESSION_PATH [options]\n\n`);
  process.stdout.write("Security profiles: --security-profile workspace (default) or guarded (no raw process, restricted mode, summary verifier evidence)\n\n");
  process.stdout.write("Hermetic evaluation: --disable-extensions true ignores every user/workspace extension layer.\n\n");
  process.stdout.write(`Vanguard expert coding agent\n\nUsage:\n  vanguard                         Start the conversational agent in the current directory\n  vanguard tui                     Start the conversational agent in the current directory\n  vanguard serve --stdio [--create-store ABS_PATH]\n                                   Start the versioned NDJSON engine protocol\n  vanguard advance --workspace PATH --provider P --model M [options] [--message TEXT]\n                                   Create a conversational session and advance it one turn\n  vanguard advance --session SESSION_PATH [--message TEXT]\n                                   Continue an existing conversational session\n  vanguard run --workspace PATH (--task TEXT | --task-file PATH) --provider openai|anthropic|deepseek --model MODEL [options]\n  vanguard resume --session SESSION_PATH\n  vanguard login anthropic|openai  Sign in with a Claude or ChatGPT subscription\n  vanguard logout [anthropic|openai]\n                                   Discard stored subscription tokens\n  vanguard auth [anthropic|openai] Show subscription sign-in status\n  vanguard doctor                  Check credentials, browser, and parser rungs; report degraded evidence capabilities\n\nDefault TUI overrides (each skips its launch selector):\n  VANGUARD_PROVIDER                deepseek, openai, anthropic, or ollama\n  VANGUARD_MODEL                   Provider model ID\n  VANGUARD_AUTH                    api-key or oauth (default: oauth when signed in)\n  VANGUARD_MAX_STEPS               Expert turn budget (default: 240)\n  VANGUARD_HOME                    Token directory (default: ~/.vanguard)\n  VANGUARD_CREATE_OPERATION_STORE  Absolute persistent store for idempotent stdio create\n\nAdvanced run options:\n  --task-file PATH        Read the task as strict UTF-8 instead of native-shell argument text\n  --verify-command CMD     Required sealed verifier executable when auto-detection is unavailable\n  --verify-arg ARG         Repeat for each sealed verifier argument\n  --check-command CMD      Trusted public compile/test executable exposed as check_project\n  --check-arg ARG          Repeat for each fixed public-check argument\n  --allow-command CMD      Repeat to expose another executable to the agent\n  --expose-raw-process BOOL Expose arbitrary allowlisted run_command calls (default: true)\n  --protect PATH           Repeat for files that must remain byte-identical\n  --editable-root PATH     Repeat to restrict all changes to these roots\n  --restrict-process BOOL  Confine Node subprocess filesystem access to the workspace\n  --verifier-evidence MODE Use full or summary verifier feedback\n  --adaptive-verification BOOL  Blank-project mode requiring the agent to establish a build/test contract\n  --auth MODE              api-key (default) or oauth for a Claude/ChatGPT subscription\n  --endpoint URL           Override provider endpoint, or required for provider=http\n  --max-steps N            Total agent step budget across resumes (default: 60)\n  --max-duration-ms N      Wall-clock budget per invocation (default: 7200000 / two hours)\n  --command-timeout-ms N   Per-build/test budget (default: 1800000 / thirty minutes)\n  --command-idle-timeout-ms N  Kill a command after N ms with no output (default: disabled; TUI: 90000)\n  --reasoning-effort LEVEL Reasoning depth for OpenAI and Kimi models: low, medium, high, or max (Kimi only; default: medium)\n  --max-context-bytes N    Provider context budget before evidence compaction (default: 2000000)\n  --max-verification-attempts N  Failed completion-claim budget (default: 3)\n`);
}
