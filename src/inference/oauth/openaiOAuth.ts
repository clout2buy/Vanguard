// OpenAI OAuth — ChatGPT (Plus / Pro / Business) subscription sign-in.
//
// PKCE authorization-code flow against auth.openai.com with a loopback callback
// on the Codex CLI's registered port. The device-code endpoint sits behind a bot
// challenge that a server-side fetch cannot clear, so the browser performs the
// authorize step and we catch the redirect.
//
// A ChatGPT token is NOT an api.openai.com key: it authenticates only against
// the Codex backend, which is why the OAuth profile rewrites the endpoint to
// CODEX_RESPONSES_URL rather than the platform API.
//
// Tokens live in ~/.vanguard/openai-oauth.json.

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { base64url, decodeJwtClaims, oauthFilePath, readJsonFile, removeFile, shortDetail, writeJsonFile } from "./store.js";

const OAUTH_ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CALLBACK_PORT = 1455;
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPE = "openid profile email offline_access";
const REFRESH_SKEW_MS = 60_000;

/** The only endpoint a ChatGPT subscription token can call. */
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

export interface OpenAIOAuthProfile {
  readonly email?: string;
  readonly planType?: string;
  readonly userId?: string;
}

export interface OpenAIOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
  /** Epoch ms when the access token expires. */
  readonly expiresAt: number;
  /** Sent as ChatGPT-Account-ID; required for org-scoped accounts. */
  readonly accountId?: string;
  readonly profile: OpenAIOAuthProfile;
}

function authFile(): string {
  return oauthFilePath("openai-oauth.json");
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body style="font-family:system-ui;background:#0a0a0a;color:#e6e6e6;display:flex;`
    + `align-items:center;justify-content:center;height:100vh;margin:0">`
    + `<h2 style="font-weight:500">${body}</h2></body></html>`;
}

export interface OpenAILoginOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Always re-authorize instead of reusing a stored login, so accounts can be switched. */
  readonly force?: boolean;
}

/** Full loopback ChatGPT sign-in; reuses or refreshes a stored login first. */
export async function runOpenAILoginFlow(
  openUrl: (url: string) => void,
  options: OpenAILoginOptions = {},
): Promise<OpenAIOAuthTokens> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 300_000;

  const existing = options.force === true ? null : await loadOpenAITokens();
  if (existing !== null && Date.now() < existing.expiresAt - REFRESH_SKEW_MS) return existing;
  if (existing !== null && existing.refreshToken.length > 0) {
    try {
      return await refreshOpenAITokens(existing, fetchImpl);
    } catch {
      // A rejected refresh token falls through to an interactive login.
    }
  }

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(24));
  const authorizeUrl = new URL(`${OAUTH_ISSUER}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", SCOPE);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("id_token_add_organizations", "true");
  authorizeUrl.searchParams.set("codex_cli_simplified_flow", "true");

  return new Promise<OpenAIOAuthTokens>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, tokens?: OpenAIOAuthTokens): void => {
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
        response.writeHead(400, html);
        response.end(page("Sign-in failed", "ChatGPT sign-in was not completed. You can close this tab."));
        finish(new Error(`ChatGPT authorization failed (${providerError})`));
        return;
      }
      if (code.length === 0 || returnedState !== state) {
        response.writeHead(400, html);
        response.end(page("Sign-in failed", "ChatGPT sign-in failed. Close this tab and try again."));
        finish(new Error("ChatGPT OAuth callback had a missing code or invalid state."));
        return;
      }
      void exchangeCode(code, verifier, fetchImpl)
        .then((tokens) => {
          response.writeHead(200, html);
          response.end(page("Connected", "Signed in to Vanguard with ChatGPT. You can close this tab."));
          finish(undefined, tokens);
        })
        .catch((error: unknown) => {
          response.writeHead(502, html);
          response.end(page("Sign-in failed", "ChatGPT approved access, but the token exchange failed."));
          finish(error instanceof Error ? error : new Error(String(error)));
        });
    });

    const deadline = setTimeout(() => finish(new Error("ChatGPT sign-in timed out after 5 minutes. Try again.")), timeoutMs);

    server.once("error", (error: NodeJS.ErrnoException) => {
      finish(new Error(error.code === "EADDRINUSE"
        ? `Port ${CALLBACK_PORT} is already in use. Close any other ChatGPT or Codex sign-in and try again.`
        : `Could not start the ChatGPT auth callback on ${REDIRECT_URI}: ${error.message}`));
    });

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      try {
        openUrl(authorizeUrl.toString());
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

interface TokenResponse {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly expires_in?: number;
  readonly account_id?: string;
}

/** The org-scoped claims ChatGPT nests under its own namespace. */
function authClaims(idToken: string): Record<string, unknown> {
  const auth = decodeJwtClaims(idToken)["https://api.openai.com/auth"];
  if (auth === null || typeof auth !== "object" || Array.isArray(auth)) return {};
  return auth as Record<string, unknown>;
}

function readProfile(idToken: string): OpenAIOAuthProfile {
  const claims = decodeJwtClaims(idToken);
  const email = typeof claims.email === "string" ? claims.email : undefined;
  // The plan lives in the namespaced auth claims as chatgpt_plan_type, not as a
  // top-level plan_type; reading the wrong one silently recorded no plan at all.
  const nested = authClaims(idToken).chatgpt_plan_type;
  const planType = typeof nested === "string"
    ? nested
    : typeof claims.plan_type === "string" ? claims.plan_type : undefined;
  const userId = typeof claims.sub === "string" ? claims.sub : undefined;
  return {
    ...(email === undefined ? {} : { email }),
    ...(planType === undefined ? {} : { planType }),
    ...(userId === undefined ? {} : { userId }),
  };
}

function readAccountId(idToken: string): string | undefined {
  const accountId = authClaims(idToken).chatgpt_account_id;
  return typeof accountId === "string" ? accountId : undefined;
}

async function postToken(body: Record<string, string>, fetchImpl: typeof fetch, action: string): Promise<TokenResponse> {
  const response = await fetchImpl(`${OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  if (!response.ok) {
    const detail = shortDetail(await response.text().catch(() => ""));
    throw new Error(`ChatGPT ${action} failed (${response.status})${detail.length === 0 ? "" : `: ${detail}`}`);
  }
  return (await response.json()) as TokenResponse;
}

async function exchangeCode(code: string, verifier: string, fetchImpl: typeof fetch): Promise<OpenAIOAuthTokens> {
  const body = await postToken({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  }, fetchImpl, "token exchange");
  if (body.access_token === undefined || body.refresh_token === undefined) {
    throw new Error("ChatGPT token exchange returned an incomplete token response.");
  }
  const idToken = body.id_token ?? "";
  const accountId = body.account_id ?? readAccountId(idToken);
  const tokens: OpenAIOAuthTokens = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    idToken,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    ...(accountId === undefined ? {} : { accountId }),
    profile: readProfile(idToken),
  };
  await saveOpenAITokens(tokens);
  return tokens;
}

function validTokens(value: unknown): OpenAIOAuthTokens | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<OpenAIOAuthTokens>;
  if (typeof row.accessToken !== "string" || row.accessToken.length === 0) return null;
  const profile = row.profile !== undefined && typeof row.profile === "object" && !Array.isArray(row.profile)
    ? row.profile
    : {};
  return {
    accessToken: row.accessToken,
    refreshToken: typeof row.refreshToken === "string" ? row.refreshToken : "",
    idToken: typeof row.idToken === "string" ? row.idToken : "",
    expiresAt: typeof row.expiresAt === "number" ? row.expiresAt : 0,
    ...(typeof row.accountId === "string" ? { accountId: row.accountId } : {}),
    profile,
  };
}

export async function loadOpenAITokens(): Promise<OpenAIOAuthTokens | null> {
  return validTokens(await readJsonFile(authFile()));
}

/**
 * The account's subscription tier. Prefers the stored profile but falls back to
 * the id_token, so a login written before the plan claim was parsed correctly
 * still reports its plan without forcing a re-login.
 */
export function openAIPlanType(tokens: OpenAIOAuthTokens): string | undefined {
  if (tokens.profile.planType !== undefined) return tokens.profile.planType;
  const claim = authClaims(tokens.idToken).chatgpt_plan_type;
  return typeof claim === "string" ? claim : undefined;
}

export async function saveOpenAITokens(tokens: OpenAIOAuthTokens): Promise<void> {
  await writeJsonFile(authFile(), tokens);
}

export async function clearOpenAITokens(): Promise<void> {
  await removeFile(authFile());
}

// Concurrent turns must trigger exactly one refresh round-trip; a second
// refresh with an already-rotated token would be rejected and log the user out.
let refreshInFlight: Promise<OpenAIOAuthTokens> | null = null;

export async function refreshOpenAITokens(
  tokens: OpenAIOAuthTokens,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenAIOAuthTokens> {
  if (refreshInFlight !== null) return refreshInFlight;
  if (tokens.refreshToken.length === 0) throw new Error("ChatGPT OAuth refresh token is missing.");
  refreshInFlight = (async () => {
    try {
      const body = await postToken({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: tokens.refreshToken,
      }, fetchImpl, "token refresh");
      if (body.access_token === undefined) throw new Error("ChatGPT token refresh returned no access token.");
      const idToken = body.id_token ?? tokens.idToken;
      const accountId = tokens.accountId ?? readAccountId(idToken);
      const next: OpenAIOAuthTokens = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? tokens.refreshToken,
        idToken,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
        ...(accountId === undefined ? {} : { accountId }),
        profile: idToken.length > 0 ? readProfile(idToken) : tokens.profile,
      };
      await saveOpenAITokens(next);
      return next;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export interface OpenAIAccessToken {
  readonly token: string;
  readonly accountId?: string;
}

/** Return a usable ChatGPT access token, refreshing transparently. */
export async function resolveOpenAIAccessToken(fetchImpl: typeof fetch = fetch): Promise<OpenAIAccessToken | null> {
  const environmentToken = process.env.VANGUARD_OPENAI_OAUTH_TOKEN?.trim();
  if (environmentToken !== undefined && environmentToken.length > 0) return { token: environmentToken };
  let tokens = await loadOpenAITokens();
  if (tokens === null) return null;
  if (Date.now() >= tokens.expiresAt - REFRESH_SKEW_MS) {
    try {
      tokens = await refreshOpenAITokens(tokens, fetchImpl);
    } catch {
      return null;
    }
  }
  return {
    token: tokens.accessToken,
    ...(tokens.accountId === undefined ? {} : { accountId: tokens.accountId }),
  };
}

export interface CodexModel {
  readonly id: string;
  readonly label?: string;
}

/**
 * Ask the signed-in account which Codex models it actually offers.
 *
 * The empty/failed distinction still matters — `null` means the question could
 * not be asked (offline, timeout, no token); `[]` is a live endpoint answering
 * "none" — but the answer is advisory either way. The listing has mis-reported
 * real plans (Pro Lite answered `[]` while its Codex access worked), so
 * callers must degrade an empty answer to the static catalog with a warning
 * rather than refusing to run; the actual completion request is the only
 * authority on access.
 */
export async function fetchCodexModels(fetchImpl: typeof fetch = fetch): Promise<CodexModel[] | null> {
  const auth = await resolveOpenAIAccessToken(fetchImpl);
  if (auth === null) return null;
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${auth.token}`,
    originator: "vanguard",
    "User-Agent": "vanguard",
  };
  if (auth.accountId !== undefined) headers["ChatGPT-Account-ID"] = auth.accountId;
  try {
    // The endpoint 400s without a client_version; the value is advisory.
    const response = await fetchImpl("https://chatgpt.com/backend-api/codex/models?client_version=0.50.0", {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { models?: unknown; data?: unknown };
    // Only a well-formed list is an answer; an unrecognized shape is a failure
    // to ask, not a claim that the account has nothing.
    const rows = Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : null;
    if (rows === null) return null;
    const models: CodexModel[] = [];
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const id = record.slug ?? record.id ?? record.model ?? record.name;
      if (typeof id !== "string" || id.length === 0) continue;
      const label = record.title ?? record.display_name ?? record.name;
      models.push({ id, ...(typeof label === "string" ? { label } : {}) });
    }
    return models;
  } catch {
    return null;
  }
}
