import type { CommandRunner, TypeScriptLoader } from "./progressiveVerification.js";
import { SyntaxCommandRunner, loadWorkspaceTypeScript } from "./progressiveVerification.js";
import type { BrowserLocator } from "./headlessRenderTool.js";
import { SystemChromiumLocator } from "./headlessRenderTool.js";

/**
 * `vanguard doctor`: one-shot, offline environment diagnostics.
 *
 * Vanguard's capability rungs degrade honestly at runtime — no browser means
 * no visual evidence, no resolvable `typescript` module means the delimiter
 * fallback, no python means no Python parse rung. Honest degradation is
 * correct mid-run and invisible at setup: nothing tells the operator a rung
 * is dead until a task needed it. The doctor surfaces every degraded rung
 * before a run, with a remedy per finding.
 *
 * Every check is local and fast: environment variables, the OAuth token
 * store, executable discovery, and module resolution. The doctor never calls
 * a provider, so a clean bill of health means "correctly configured", not
 * "the provider is up".
 */

export type DoctorStatus = "ok" | "degraded" | "missing";

export interface DoctorResult {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  readonly remedy?: string;
}

export interface DoctorReport {
  readonly results: readonly DoctorResult[];
  /** True when nothing run-blocking is missing; degraded rungs stay ready. */
  readonly ready: boolean;
}

export interface DoctorOptions {
  readonly workspaceRoot: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly browserLocator?: BrowserLocator;
  readonly typescriptLoader?: TypeScriptLoader;
  readonly syntaxRunner?: CommandRunner;
  /** Local OAuth token-store probe; never a network call. */
  readonly oauthConnected?: () => Promise<boolean>;
}

const PROVIDER_CREDENTIAL_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OLLAMA_API_KEY",
] as const;

const SUPPORTED_NODE = { minimumMajor: 20, minimumMinor: 19, maximumMajorExclusive: 25 } as const;

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const environment = options.environment ?? process.env;
  const results: DoctorResult[] = [
    nodeRuntime(),
    await providerCredentials(environment, options.oauthConnected),
    await visualRung(options.browserLocator ?? new SystemChromiumLocator()),
    await typescriptRung(options.workspaceRoot, options.typescriptLoader ?? loadWorkspaceTypeScript),
    await parserCli(
      options.syntaxRunner ?? new SyntaxCommandRunner(),
      options.workspaceRoot,
      "Python syntax rung",
      "python",
      ["-c", "print(1)"],
      "install Python 3 so Python edits get a real parse rung",
    ),
    await parserCli(
      options.syntaxRunner ?? new SyntaxCommandRunner(),
      options.workspaceRoot,
      "Go syntax rung",
      "gofmt",
      [],
      "install Go so Go edits get a real parse rung",
      "",
    ),
  ];
  return { results, ready: results.every((result) => result.status !== "missing") };
}

export function renderDoctorReport(report: DoctorReport): string {
  const marker: Record<DoctorStatus, string> = { ok: " OK ", degraded: "WARN", missing: "MISS" };
  const lines = report.results.flatMap((result) => [
    `[${marker[result.status]}] ${result.name} — ${result.detail}`,
    ...(result.remedy === undefined ? [] : [`       remedy: ${result.remedy}`]),
  ]);
  const verdict = report.ready
    ? "Ready to run. Degraded rungs above (if any) reduce evidence quality, not correctness."
    : "Not ready: fix the MISS findings above before running.";
  return `Vanguard doctor\n${lines.join("\n")}\n${verdict}`;
}

function nodeRuntime(): DoctorResult {
  const version = process.versions.node;
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  const supported = (major > SUPPORTED_NODE.minimumMajor
    || (major === SUPPORTED_NODE.minimumMajor && minor >= SUPPORTED_NODE.minimumMinor))
    && major < SUPPORTED_NODE.maximumMajorExclusive;
  return {
    name: "node runtime",
    status: supported ? "ok" : "degraded",
    detail: supported ? `v${version} — supported` : `v${version} — outside the supported range >=20.19 <25`,
    ...(supported ? {} : { remedy: "run Vanguard on a supported Node.js release" }),
  };
}

async function providerCredentials(
  environment: NodeJS.ProcessEnv,
  oauthConnected: (() => Promise<boolean>) | undefined,
): Promise<DoctorResult> {
  const present = PROVIDER_CREDENTIAL_VARIABLES.filter((variable) => {
    const value = environment[variable];
    return typeof value === "string" && value.trim().length > 0;
  });
  let oauth = false;
  if (oauthConnected !== undefined) {
    try {
      oauth = await oauthConnected();
    } catch {
      oauth = false;
    }
  }
  if (present.length === 0 && !oauth) {
    return {
      name: "provider credentials",
      status: "missing",
      detail: "no provider API key in the environment and no connected OAuth session",
      remedy: "set ANTHROPIC_API_KEY (or another provider key), or run `vanguard login`; a local Ollama endpoint needs no key",
    };
  }
  const sources = [...present, ...(oauth ? ["OAuth session"] : [])];
  return { name: "provider credentials", status: "ok", detail: sources.join(", ") };
}

async function visualRung(locator: BrowserLocator): Promise<DoctorResult> {
  let browser: string | undefined;
  try {
    browser = await locator.locate();
  } catch {
    browser = undefined;
  }
  if (browser === undefined) {
    return {
      name: "visual rung (render_artifact)",
      status: "degraded",
      detail: "no system Chromium-family browser found; HTML deliverables cannot be rendered or screenshotted",
      remedy: "install Edge/Chrome/Chromium or set VANGUARD_BROWSER to a browser executable",
    };
  }
  return { name: "visual rung (render_artifact)", status: "ok", detail: browser };
}

async function typescriptRung(workspaceRoot: string, loader: TypeScriptLoader): Promise<DoctorResult> {
  let module;
  try {
    module = await loader(workspaceRoot);
  } catch {
    module = undefined;
  }
  if (module === undefined) {
    return {
      name: "TypeScript syntax rung",
      status: "degraded",
      detail: "no resolvable `typescript` module; TypeScript edits fall back to the delimiter scan",
      remedy: "install typescript in the project (or globally) for a real parse rung",
    };
  }
  const version = (module as { version?: unknown }).version;
  return {
    name: "TypeScript syntax rung",
    status: "ok",
    detail: typeof version === "string" ? `typescript ${version}` : "typescript module resolvable",
  };
}

async function parserCli(
  runner: CommandRunner,
  workspaceRoot: string,
  name: string,
  command: string,
  args: readonly string[],
  remedy: string,
  input?: string,
): Promise<DoctorResult> {
  try {
    const result = await runner.run(command, args, workspaceRoot, input);
    if (result.exitCode === 0) return { name, status: "ok", detail: `${command} available` };
    return { name, status: "degraded", detail: `${command} exited ${result.exitCode}`, remedy };
  } catch {
    return { name, status: "degraded", detail: `${command} not available`, remedy };
  }
}
