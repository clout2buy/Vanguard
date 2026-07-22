// The one surface the CLI and TUI use to sign in, sign out, and inspect status.
// Provider-specific wire detail stays in the modules below it.

import { spawn } from "node:child_process";
import {
  clearAnthropicTokens,
  loadAnthropicTokens,
  runAnthropicLoginFlow,
} from "./anthropicOAuth.js";
import {
  clearOpenAITokens,
  loadOpenAITokens,
  openAIPlanType,
  runOpenAILoginFlow,
} from "./openaiOAuth.js";
import {
  clearKimiTokens,
  loadKimiTokens,
  runKimiLoginFlow,
} from "./kimiOAuth.js";
import { vanguardHome } from "./store.js";

export type OAuthProvider = "anthropic" | "openai" | "kimi";

export const OAUTH_PROVIDER_LABELS: Readonly<Record<OAuthProvider, string>> = {
  anthropic: "Claude (Pro / Max subscription)",
  openai: "ChatGPT (Plus / Pro subscription)",
  kimi: "Kimi Code subscription",
};

export function isOAuthProvider(value: string): value is OAuthProvider {
  return value === "anthropic" || value === "openai" || value === "kimi";
}

export interface OAuthStatus {
  readonly provider: OAuthProvider;
  readonly connected: boolean;
  /** Epoch ms; absent when not connected. */
  readonly expiresAt?: number;
  readonly expired?: boolean;
  readonly account?: string;
  /** Subscription tier as the provider reports it, e.g. "plus", "pro", "prolite". */
  readonly plan?: string;
  readonly home: string;
}

/**
 * Open the system browser. Detached and fully redirected so a browser that logs
 * to stdout can never corrupt the TUI's frame, and so Vanguard's exit does not
 * wait on it.
 */
export function openBrowser(url: string): void {
  const [command, args] = process.platform === "win32"
    ? ["cmd.exe", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The caller always prints the URL too; a missing browser is not fatal.
  }
}

export async function oauthStatus(provider: OAuthProvider): Promise<OAuthStatus> {
  const home = vanguardHome();
  if (provider === "anthropic") {
    const tokens = await loadAnthropicTokens();
    if (tokens === null) return { provider, connected: false, home };
    return {
      provider,
      connected: true,
      expiresAt: tokens.expiresAt,
      expired: Date.now() >= tokens.expiresAt,
      home,
    };
  }
  if (provider === "kimi") {
    const tokens = await loadKimiTokens();
    if (tokens === null) return { provider, connected: false, home };
    return {
      provider,
      connected: true,
      expiresAt: tokens.expiresAt,
      expired: Date.now() >= tokens.expiresAt,
      home,
    };
  }
  const tokens = await loadOpenAITokens();
  if (tokens === null) return { provider, connected: false, home };
  const account = tokens.profile.email ?? tokens.accountId;
  return {
    provider,
    connected: true,
    expiresAt: tokens.expiresAt,
    expired: Date.now() >= tokens.expiresAt,
    ...(account === undefined ? {} : { account }),
    ...(openAIPlanType(tokens) === undefined ? {} : { plan: openAIPlanType(tokens)! }),
    home,
  };
}

export interface LoginOptions {
  /** Receives the authorize URL so a caller can print it before the browser opens. */
  readonly onAuthorizeUrl?: (url: string) => void;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * Re-authorize even when a valid token is stored. An explicit `vanguard login`
   * sets this: without it, signing in while already connected would report
   * success while silently keeping the previous account.
   */
  readonly force?: boolean;
}

/** Run the interactive sign-in for one provider. Resolves once tokens are stored. */
export async function oauthLogin(provider: OAuthProvider, options: LoginOptions = {}): Promise<OAuthStatus> {
  const open = (url: string): void => {
    options.onAuthorizeUrl?.(url);
    openBrowser(url);
  };
  if (provider === "anthropic") {
    await runAnthropicLoginFlow(open, options.fetchImpl ?? fetch, options.timeoutMs ?? 300_000, options.force === true);
  } else if (provider === "openai") {
    await runOpenAILoginFlow(open, {
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.force === undefined ? {} : { force: options.force }),
    });
  } else await runKimiLoginFlow({
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.force === undefined ? {} : { force: options.force }),
    onDeviceAuthorization: (authorization) => open(authorization.verificationUriComplete),
  });
  return oauthStatus(provider);
}

export async function oauthLogout(provider: OAuthProvider): Promise<void> {
  if (provider === "anthropic") await clearAnthropicTokens();
  else if (provider === "openai") await clearOpenAITokens();
  else await clearKimiTokens();
}

export {
  ANTHROPIC_OAUTH_BETA,
  ANTHROPIC_OAUTH_IDENTITY,
  ANTHROPIC_OAUTH_USER_AGENT,
  ANTHROPIC_OAUTH_X_APP,
  clearAnthropicTokens,
  fetchClaudeModels,
  finishAnthropicLogin,
  loadAnthropicTokens,
  refreshAnthropicTokens,
  resolveAnthropicAccessToken,
  runAnthropicLoginFlow,
  startAnthropicLogin,
} from "./anthropicOAuth.js";
export type { AnthropicAuthChallenge, AnthropicOAuthTokens, ClaudeModel } from "./anthropicOAuth.js";
export {
  CODEX_RESPONSES_URL,
  clearOpenAITokens,
  fetchCodexModels,
  loadOpenAITokens,
  openAIPlanType,
  refreshOpenAITokens,
  resolveOpenAIAccessToken,
  runOpenAILoginFlow,
} from "./openaiOAuth.js";
export type { CodexModel, OpenAIAccessToken, OpenAIOAuthTokens } from "./openaiOAuth.js";
export {
  KIMI_CHAT_COMPLETIONS_URL,
  KIMI_CODING_BASE_URL,
  KIMI_OAUTH_CLIENT_ID,
  KIMI_OAUTH_HOST,
  clearKimiTokens,
  fetchKimiModels,
  loadKimiTokens,
  kimiRequestHeaders,
  refreshKimiTokens,
  requestKimiDeviceAuthorization,
  resolveKimiAccessToken,
  runKimiLoginFlow,
} from "./kimiOAuth.js";
export type { KimiDeviceAuthorization, KimiModel, KimiOAuthTokens } from "./kimiOAuth.js";
export { vanguardHome } from "./store.js";
