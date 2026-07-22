// Anthropic OAuth — Claude Pro / Max subscription sign-in.
//
// PKCE authorization-code flow against claude.ai with a fixed loopback callback.
// Two non-obvious contract details, both load-bearing:
//
//   1. The PKCE verifier is reused verbatim as the OAuth `state`. Anthropic's
//      public client rejects the token exchange when state is independently
//      random.
//   2. A subscription token calling Messages must send the Claude Code beta
//      headers AND carry the identity string as system block 0 (see
//      ANTHROPIC_OAUTH_IDENTITY and its use in the Anthropic codec).
//
// Tokens live in ~/.vanguard/anthropic-oauth.json; Vanguard never reads another
// tool's credential store.

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { base64url, oauthFilePath, readJsonFile, removeFile, shortDetail, writeJsonFile } from "./store.js";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_PORT = 53692;
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const REFRESH_SKEW_MS = 60_000;
const SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
].join(" ");

/** Beta flags a Claude subscription token must present to the Messages API. */
export const ANTHROPIC_OAUTH_BETA = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
].join(",");
export const ANTHROPIC_OAUTH_USER_AGENT = "claude-cli/2.1.160";
export const ANTHROPIC_OAUTH_X_APP = "cli";
/**
 * Required byte-for-byte as system block 0 when authenticating with a
 * subscription token; the request is rejected without it. It names the
 * transport, not this agent — Vanguard's own system prompt follows it.
 */
export const ANTHROPIC_OAUTH_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export interface AnthropicOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch ms when the access token expires. */
  readonly expiresAt: number;
  readonly scopes?: readonly string[];
}

export interface AnthropicAuthChallenge {
  readonly authorizeUrl: string;
  readonly pkceVerifier: string;
  readonly state: string;
  readonly port: number;
  readonly redirectUri: string;
}

function authFile(): string {
  return oauthFilePath("anthropic-oauth.json");
}

export function startAnthropicLogin(): AnthropicAuthChallenge {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  // The public client expects the verifier itself as state; a separate random
  // state makes the token exchange fail.
  const state = verifier;
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return {
    authorizeUrl: url.toString(),
    pkceVerifier: verifier,
    state,
    port: CALLBACK_PORT,
    redirectUri: REDIRECT_URI,
  };
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body style="font-family:system-ui;background:#0a0a0a;color:#e6e6e6;display:flex;`
    + `align-items:center;justify-content:center;height:100vh;margin:0">`
    + `<h2 style="font-weight:500">${body}</h2></body></html>`;
}

/**
 * Full loopback sign-in. A still-valid stored login is returned as-is and an
 * expiring one is refreshed silently; only a genuinely absent or rejected
 * credential opens the browser. Pass `force` to always re-authorize, which is
 * what an explicit `vanguard login` needs in order to switch accounts.
 */
export async function runAnthropicLoginFlow(
  openUrl: (url: string) => void,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 300_000,
  force = false,
): Promise<AnthropicOAuthTokens> {
  const existing = force ? null : await loadAnthropicTokens();
  if (existing !== null && Date.now() < existing.expiresAt - REFRESH_SKEW_MS) return existing;
  if (existing !== null && existing.refreshToken.length > 0) {
    try {
      return await refreshAnthropicTokens(existing, fetchImpl);
    } catch {
      // A rejected refresh token falls through to an interactive login.
    }
  }

  const auth = startAnthropicLogin();
  return new Promise<AnthropicOAuthTokens>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, tokens?: AnthropicOAuthTokens): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      server.close();
      if (error !== undefined) reject(error);
      else if (tokens !== undefined) resolve(tokens);
    };

    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", REDIRECT_URI);
      if (requestUrl.pathname !== CALLBACK_PATH) {
        response.writeHead(404);
        response.end();
        return;
      }
      const providerError = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code") ?? "";
      const returnedState = requestUrl.searchParams.get("state") ?? "";
      const html = { "Content-Type": "text/html; charset=utf-8" };
      if (providerError !== null) {
        const description = requestUrl.searchParams.get("error_description");
        response.writeHead(400, html);
        response.end(page("Sign-in failed", "Claude sign-in was not completed. You can close this tab."));
        finish(new Error(`Claude authorization failed (${providerError})${description === null ? "" : `: ${description}`}`));
        return;
      }
      if (code.length === 0 || returnedState !== auth.state) {
        response.writeHead(400, html);
        response.end(page("Sign-in failed", "Claude sign-in failed. Close this tab and try again."));
        finish(new Error("Claude OAuth callback had a missing code or invalid state."));
        return;
      }
      void exchangeCode(code, auth.pkceVerifier, fetchImpl)
        .then((tokens) => {
          response.writeHead(200, html);
          response.end(page("Connected", "Signed in to Vanguard. You can close this tab."));
          finish(undefined, tokens);
        })
        .catch((error: unknown) => {
          response.writeHead(502, html);
          response.end(page("Sign-in failed", "Claude approved access, but the token exchange failed."));
          finish(error instanceof Error ? error : new Error(String(error)));
        });
    });

    const deadline = setTimeout(() => finish(new Error("Claude sign-in timed out after 5 minutes. Try again.")), timeoutMs);

    server.once("error", (error: NodeJS.ErrnoException) => {
      finish(new Error(error.code === "EADDRINUSE"
        ? `Port ${CALLBACK_PORT} is already in use. Close another Claude sign-in and try again.`
        : `Could not start the Claude auth callback on ${REDIRECT_URI}: ${error.message}`));
    });

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      try {
        openUrl(auth.authorizeUrl);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

interface TokenResponse {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
}

async function exchangeCode(code: string, verifier: string, fetchImpl: typeof fetch): Promise<AnthropicOAuthTokens> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": ANTHROPIC_OAUTH_USER_AGENT,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state: verifier,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!response.ok) {
    const detail = shortDetail(await response.text().catch(() => ""));
    throw new Error(`Claude token exchange failed (${response.status})${detail.length === 0 ? "" : `: ${detail}`}`);
  }
  const body = (await response.json()) as TokenResponse;
  if (body.access_token === undefined || body.refresh_token === undefined) {
    throw new Error("Claude token exchange returned an incomplete token response.");
  }
  const scopes = body.scope?.split(/\s+/u).filter((scope) => scope.length > 0);
  const tokens: AnthropicOAuthTokens = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    ...(scopes === undefined || scopes.length === 0 ? {} : { scopes }),
  };
  await saveAnthropicTokens(tokens);
  return tokens;
}

/** Complete a manually pasted callback URL or authorization code. */
export async function finishAnthropicLogin(
  rawCode: string,
  pkceVerifier: string,
  expectedState: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AnthropicOAuthTokens> {
  const raw = rawCode.trim();
  let code = raw;
  let state = "";
  try {
    const url = new URL(raw);
    code = url.searchParams.get("code") ?? "";
    state = url.searchParams.get("state") ?? "";
  } catch {
    const [first, second] = raw.split("#", 2);
    code = first ?? "";
    state = second ?? "";
  }
  if (code.length === 0) throw new Error("Claude authorization code is missing.");
  if (state.length > 0 && state !== expectedState) throw new Error("Claude OAuth state mismatch.");
  return exchangeCode(code, pkceVerifier, fetchImpl);
}

function validTokens(value: unknown): AnthropicOAuthTokens | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<AnthropicOAuthTokens>;
  if (typeof row.accessToken !== "string" || row.accessToken.length === 0) return null;
  const scopes = Array.isArray(row.scopes)
    ? row.scopes.filter((scope): scope is string => typeof scope === "string")
    : undefined;
  return {
    accessToken: row.accessToken,
    refreshToken: typeof row.refreshToken === "string" ? row.refreshToken : "",
    expiresAt: typeof row.expiresAt === "number" ? row.expiresAt : 0,
    ...(scopes === undefined ? {} : { scopes }),
  };
}

export async function loadAnthropicTokens(): Promise<AnthropicOAuthTokens | null> {
  return validTokens(await readJsonFile(authFile()));
}

export async function saveAnthropicTokens(tokens: AnthropicOAuthTokens): Promise<void> {
  await writeJsonFile(authFile(), tokens);
}

export async function clearAnthropicTokens(): Promise<void> {
  await removeFile(authFile());
}

/** Trade the refresh token for a fresh access token, persisting the result. */
export async function refreshAnthropicTokens(
  tokens: AnthropicOAuthTokens,
  fetchImpl: typeof fetch = fetch,
): Promise<AnthropicOAuthTokens> {
  if (tokens.refreshToken.length === 0) throw new Error("Claude OAuth refresh token is missing.");
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": ANTHROPIC_OAUTH_USER_AGENT,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: tokens.refreshToken,
    }),
  });
  if (!response.ok) {
    const detail = shortDetail(await response.text().catch(() => ""));
    throw new Error(`Claude token refresh failed (${response.status})${detail.length === 0 ? "" : `: ${detail}`}`);
  }
  const body = (await response.json()) as TokenResponse;
  if (body.access_token === undefined) throw new Error("Claude token refresh returned no access token.");
  const scopes = body.scope === undefined
    ? tokens.scopes
    : body.scope.split(/\s+/u).filter((scope) => scope.length > 0);
  const next: AnthropicOAuthTokens = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    ...(scopes === undefined ? {} : { scopes }),
  };
  await saveAnthropicTokens(next);
  return next;
}

/**
 * Return a usable access token, refreshing transparently. Null means the owner
 * has not signed in — callers turn that into an actionable message rather than
 * an opaque 401 from the provider.
 */
export async function resolveAnthropicAccessToken(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const environmentToken = process.env.VANGUARD_ANTHROPIC_OAUTH_TOKEN?.trim();
  if (environmentToken !== undefined && environmentToken.length > 0) return environmentToken;
  const tokens = await loadAnthropicTokens();
  if (tokens === null) return null;
  if (Date.now() < tokens.expiresAt - REFRESH_SKEW_MS) return tokens.accessToken;
  try {
    return (await refreshAnthropicTokens(tokens, fetchImpl)).accessToken;
  } catch {
    return null;
  }
}

export interface ClaudeModel {
  readonly id: string;
  readonly label?: string;
}

/**
 * Ask the signed-in Claude subscription which models it actually serves.
 *
 * Advisory, exactly like the Codex listing: `null` means the question could
 * not be asked (offline, timeout, no token) and `[]` is a live "none" answer.
 * Either way the static catalog remains the fallback and the real completion
 * request stays the only authority — a listing must never veto a launch.
 */
export async function fetchClaudeModels(fetchImpl: typeof fetch = fetch): Promise<ClaudeModel[] | null> {
  const token = await resolveAnthropicAccessToken(fetchImpl);
  if (token === null) return null;
  try {
    const response = await fetchImpl("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": ANTHROPIC_OAUTH_BETA,
        "User-Agent": ANTHROPIC_OAUTH_USER_AGENT,
        "x-app": ANTHROPIC_OAUTH_X_APP,
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: unknown };
    // Only a well-formed list is an answer; an unrecognized shape is a
    // failure to ask, not a claim that the account has nothing.
    if (!Array.isArray(body.data)) return null;
    const models: ClaudeModel[] = [];
    for (const row of body.data) {
      if (row === null || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const id = record.id;
      if (typeof id !== "string" || id.length === 0) continue;
      models.push({ id, ...(typeof record.display_name === "string" ? { label: record.display_name } : {}) });
    }
    return models;
  } catch {
    return null;
  }
}
