import { readFile } from "node:fs/promises";
import { CODEX_RESPONSES_URL } from "./oauth/openaiOAuth.js";
import { KIMI_CHAT_COMPLETIONS_URL } from "./oauth/kimiOAuth.js";
import type { OAuthProvider } from "./oauth/index.js";

export const VANGUARD_PROVIDER_CONFIG_VERSION = 1 as const;

export type ProviderIdentity = "openai" | "anthropic" | "deepseek" | "kimi" | "ollama" | "openai-compatible";
export type ProviderWireProtocol = "openai-responses" | "openai-chat-completions" | "anthropic-messages";

export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly parallelToolCalls: boolean;
  readonly streamUsage: boolean;
  /** Preserve opaque reasoning/thinking items for the provider's next turn. */
  readonly continuationReplay: boolean;
}

export interface ProviderCapabilityOverrides {
  readonly streaming?: boolean;
  readonly parallelToolCalls?: boolean;
  readonly streamUsage?: boolean;
  readonly continuationReplay?: boolean;
}

export interface EnvironmentCredentialConfig {
  readonly source: "environment";
  readonly variable: string;
}

/**
 * A subscription credential minted by Vanguard's own OAuth flow and held in
 * ~/.vanguard. Unlike an API key it is short-lived and refreshed per request,
 * so the profile records only which provider issued it — never a token value,
 * and never a token this process did not mint.
 */
export interface OAuthCredentialConfig {
  readonly source: "oauth";
  readonly provider: OAuthProvider;
}

export type ProviderCredentialConfig = EnvironmentCredentialConfig | OAuthCredentialConfig;

/**
 * Optional reasoning configuration. Each field is honored only by the wire
 * contract that can express it and rejected everywhere else, so a config
 * cannot silently claim reasoning that the provider never performs.
 */
export interface ProviderReasoningConfig {
  /** Anthropic Messages extended thinking budget in tokens (min 1024). */
  readonly thinkingBudgetTokens?: number;
  /** OpenAI Responses reasoning effort. */
  readonly effort?: "low" | "medium" | "high" | "max";
  /** Kimi Chat Completions thinking mode. */
  readonly thinking?: "enabled" | "disabled";
}

/**
 * Portable, versioned provider connection configuration. It contains only
 * credential provenance, never credential values.
 */
export interface ProviderConnectionConfigV1 {
  readonly version: typeof VANGUARD_PROVIDER_CONFIG_VERSION;
  readonly provider: ProviderIdentity;
  readonly model: string;
  readonly endpoint?: string;
  readonly wire?: ProviderWireProtocol;
  readonly credential?: ProviderCredentialConfig;
  readonly capabilities?: ProviderCapabilityOverrides;
  /** Required header version for Anthropic Messages; ignored nowhere else. */
  readonly apiVersion?: string;
  /** Maximum output tokens per response; defaults to 16384. */
  readonly maxOutputTokens?: number;
  readonly reasoning?: ProviderReasoningConfig;
}

export interface EnvironmentCredentialProvenance {
  readonly source: "environment";
  readonly variable: string;
  readonly present: boolean;
}

export interface OAuthCredentialProvenance {
  readonly source: "oauth";
  readonly provider: OAuthProvider;
  /**
   * An OAuth token is read (and refreshed) from disk when a request is built,
   * not when the profile resolves, so presence is deliberately not asserted
   * here. Profile resolution stays synchronous and side-effect free.
   */
  readonly resolvedAtRequestTime: true;
}

export type CredentialProvenance = EnvironmentCredentialProvenance | OAuthCredentialProvenance;

export interface ResolvedProviderProfile {
  readonly version: typeof VANGUARD_PROVIDER_CONFIG_VERSION;
  readonly provider: ProviderIdentity;
  readonly model: string;
  readonly endpoint: string;
  readonly wire: ProviderWireProtocol;
  readonly credential: ProviderCredentialConfig;
  readonly credentialProvenance: CredentialProvenance;
  readonly capabilities: ProviderCapabilities;
  readonly apiVersion?: string;
  readonly maxOutputTokens: number;
  readonly reasoning?: ProviderReasoningConfig;
  /**
   * Local inference servers such as Ollama accept unauthenticated loopback
   * requests; when true, a missing credential variable sends no Authorization
   * header instead of failing the request.
   */
  readonly credentialOptional: boolean;
}

/**
 * Per-response output ceiling. This is not the context window: a model may read
 * a million tokens and still refuse to write more than a few thousand in one
 * response. Anthropic requires the number up front as `max_tokens`, and a
 * response that reaches it is truncated mid-structure and thrown away — so a
 * ceiling set below what the model can actually emit silently caps how large a
 * file the agent can write, which is exactly what one shared 16k default did.
 * Current Anthropic models accept 64k; a profile may still override this.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const ANTHROPIC_MAX_OUTPUT_TOKENS = 64_000;

const PROVIDER_DEFAULTS: Readonly<Record<Exclude<ProviderIdentity, "openai-compatible">, {
  endpoint: string;
  wire: ProviderWireProtocol;
  credentialVariable: string;
  apiVersion?: string;
  maxOutputTokens?: number;
}>> = {
  openai: {
    endpoint: "https://api.openai.com/v1/responses",
    wire: "openai-responses",
    credentialVariable: "OPENAI_API_KEY",
  },
  anthropic: {
    endpoint: "https://api.anthropic.com/v1/messages",
    wire: "anthropic-messages",
    credentialVariable: "ANTHROPIC_API_KEY",
    apiVersion: "2023-06-01",
    maxOutputTokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
  },
  deepseek: {
    endpoint: "https://api.deepseek.com/chat/completions",
    wire: "openai-chat-completions",
    credentialVariable: "DEEPSEEK_API_KEY",
  },
  kimi: {
    endpoint: KIMI_CHAT_COMPLETIONS_URL,
    wire: "openai-chat-completions",
    credentialVariable: "KIMI_API_KEY",
  },
  ollama: {
    endpoint: "http://127.0.0.1:11434/v1/chat/completions",
    wire: "openai-chat-completions",
    credentialVariable: "OLLAMA_API_KEY",
  },
};

const WIRE_CAPABILITIES: Readonly<Record<ProviderWireProtocol, ProviderCapabilities>> = {
  "openai-responses": {
    streaming: true,
    parallelToolCalls: true,
    streamUsage: true,
    continuationReplay: true,
  },
  "openai-chat-completions": {
    streaming: true,
    parallelToolCalls: true,
    streamUsage: true,
    continuationReplay: true,
  },
  "anthropic-messages": {
    streaming: true,
    parallelToolCalls: true,
    streamUsage: true,
    continuationReplay: true,
  },
};

/**
 * Resolves capabilities for one exact provider/model profile. Vanguard never
 * guesses from model-name substrings: explicit per-profile declarations win,
 * otherwise only public wire-contract capabilities are used.
 */
export function resolveProviderProfile(
  input: ProviderConnectionConfigV1,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedProviderProfile {
  validateConfigShape(input);
  const defaults = input.provider === "openai-compatible" ? undefined : PROVIDER_DEFAULTS[input.provider];
  const wire = input.wire ?? defaults?.wire ?? "openai-chat-completions";
  if (defaults !== undefined && wire !== defaults.wire) {
    throw new Error(`${input.provider} profiles must use the ${defaults.wire} public wire contract.`);
  }
  if (input.provider === "openai-compatible" && wire !== "openai-chat-completions") {
    throw new Error("openai-compatible profiles currently support only the public Chat Completions wire contract.");
  }
  const credential = input.credential ?? (defaults === undefined
    ? undefined
    : { source: "environment" as const, variable: defaults.credentialVariable });
  if (credential === undefined) {
    throw new Error("openai-compatible profiles require an explicit environment credential variable.");
  }
  validateCredential(credential, input.provider);
  // A ChatGPT subscription token authenticates only against the Codex backend —
  // it is rejected by the platform API — so an OAuth OpenAI profile defaults to
  // that endpoint instead of the API-key default.
  const endpointDefault = credential.source === "oauth" && input.provider === "openai"
    ? CODEX_RESPONSES_URL
    : defaults?.endpoint;
  const endpoint = validateEndpoint(input.endpoint ?? endpointDefault, input.provider);
  const apiVersion = input.apiVersion ?? defaults?.apiVersion;
  if (wire === "anthropic-messages") {
    if (apiVersion === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(apiVersion)) {
      throw new Error("Anthropic Messages profiles require an apiVersion in YYYY-MM-DD form.");
    }
  } else if (apiVersion !== undefined) {
    throw new Error("apiVersion is valid only for the Anthropic Messages wire contract.");
  }
  // Official profiles inherit only their documented wire contract. A custom
  // compatible endpoint starts conservative so Vanguard never assumes that a
  // similarly shaped model supports streaming, parallel calls, stream usage,
  // or opaque continuation replay.
  const baseline = input.provider === "openai-compatible"
    ? { streaming: false, parallelToolCalls: false, streamUsage: false, continuationReplay: false }
    : input.provider === "ollama"
      // Ollama streams reliably, but parallel calls, stream usage accounting,
      // and opaque continuation replay vary by hosted model; stay conservative.
      ? { streaming: true, parallelToolCalls: false, streamUsage: false, continuationReplay: false }
      : WIRE_CAPABILITIES[wire];
  const streaming = input.capabilities?.streaming ?? baseline.streaming;
  const capabilities: ProviderCapabilities = {
    streaming,
    parallelToolCalls: input.capabilities?.parallelToolCalls ?? baseline.parallelToolCalls,
    streamUsage: streaming && (input.capabilities?.streamUsage ?? baseline.streamUsage),
    continuationReplay: input.capabilities?.continuationReplay ?? baseline.continuationReplay,
  };
  const maxOutputTokens = input.maxOutputTokens ?? defaults?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const reasoning = validateReasoning(input.reasoning, wire, maxOutputTokens, input.provider);
  return {
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: input.provider,
    model: input.model.trim(),
    endpoint,
    wire,
    credential,
    credentialProvenance: credential.source === "oauth"
      ? { source: "oauth", provider: credential.provider, resolvedAtRequestTime: true }
      : {
        source: "environment",
        variable: credential.variable,
        present: typeof environment[credential.variable] === "string" && environment[credential.variable]!.length > 0,
      },
    capabilities,
    ...(apiVersion === undefined ? {} : { apiVersion }),
    maxOutputTokens,
    ...(reasoning === undefined ? {} : { reasoning }),
    credentialOptional: input.provider === "ollama",
  };
}

function validateReasoning(
  reasoning: ProviderReasoningConfig | undefined,
  wire: ProviderWireProtocol,
  maxOutputTokens: number,
  provider: ProviderIdentity,
): ProviderReasoningConfig | undefined {
  if (reasoning === undefined) return undefined;
  if (reasoning === null || typeof reasoning !== "object" || Array.isArray(reasoning)) {
    throw new Error("Provider reasoning config must be an object.");
  }
  for (const name of Object.keys(reasoning)) {
    if (name !== "thinkingBudgetTokens" && name !== "effort" && name !== "thinking") {
      throw new Error(`Unknown provider reasoning field: ${name}.`);
    }
  }
  const budget = reasoning.thinkingBudgetTokens;
  const effort = reasoning.effort;
  const thinking = reasoning.thinking;
  if (budget !== undefined) {
    if (wire !== "anthropic-messages") {
      throw new Error("thinkingBudgetTokens is valid only for the Anthropic Messages wire contract.");
    }
    if (!Number.isSafeInteger(budget) || budget < 1_024) {
      throw new Error("thinkingBudgetTokens must be an integer of at least 1024.");
    }
    if (budget >= maxOutputTokens) {
      throw new Error("thinkingBudgetTokens must be smaller than maxOutputTokens.");
    }
  }
  if (effort !== undefined) {
    if (wire !== "openai-responses" && provider !== "kimi") {
      throw new Error("reasoning effort is valid only for the OpenAI Responses wire contract or the Kimi provider.");
    }
    if (effort !== "low" && effort !== "medium" && effort !== "high" && effort !== "max") {
      throw new Error("reasoning effort must be low, medium, high, or max.");
    }
    if (effort === "max" && provider !== "kimi") throw new Error("max reasoning effort is valid only for Kimi.");
  }
  if (thinking !== undefined && provider !== "kimi") throw new Error("thinking mode is valid only for Kimi.");
  if (thinking !== undefined && thinking !== "enabled" && thinking !== "disabled") {
    throw new Error("Kimi thinking mode must be enabled or disabled.");
  }
  if (thinking === "disabled" && effort !== undefined) throw new Error("Kimi reasoning effort requires thinking to be enabled.");
  if (budget === undefined && effort === undefined && thinking === undefined) return undefined;
  return reasoning;
}

export async function readProviderProfile(
  file: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedProviderProfile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read provider config: ${detail}`);
  }
  return resolveProviderProfile(parsed as ProviderConnectionConfigV1, environment);
}

/** A diagnostic-safe projection; credential values are impossible to include. */
export function describeProviderProfile(profile: ResolvedProviderProfile): Record<string, unknown> {
  return {
    version: profile.version,
    provider: profile.provider,
    model: profile.model,
    endpoint: profile.endpoint,
    wire: profile.wire,
    credential: profile.credentialProvenance,
    capabilities: profile.capabilities,
    ...(profile.apiVersion === undefined ? {} : { apiVersion: profile.apiVersion }),
    maxOutputTokens: profile.maxOutputTokens,
    ...(profile.reasoning === undefined ? {} : { reasoning: profile.reasoning }),
  };
}

function validateConfigShape(input: ProviderConnectionConfigV1): void {
  if (input === null || typeof input !== "object") throw new Error("Provider config must be an object.");
  if (input.version !== VANGUARD_PROVIDER_CONFIG_VERSION) {
    throw new Error(`Unsupported provider config version: ${String(input.version)}.`);
  }
  if (!(input.provider === "openai" || input.provider === "anthropic" || input.provider === "deepseek"
    || input.provider === "kimi" || input.provider === "ollama" || input.provider === "openai-compatible")) {
    throw new Error(`Unsupported provider: ${String(input.provider)}.`);
  }
  if (typeof input.model !== "string" || input.model.trim().length === 0 || input.model.length > 256) {
    throw new Error("Provider model must be a non-empty string no longer than 256 characters.");
  }
  if (input.wire !== undefined && !Object.hasOwn(WIRE_CAPABILITIES, input.wire)) {
    throw new Error(`Unsupported provider wire contract: ${String(input.wire)}.`);
  }
  if (input.endpoint !== undefined && typeof input.endpoint !== "string") {
    throw new Error("Provider endpoint must be a string.");
  }
  if (input.apiVersion !== undefined && typeof input.apiVersion !== "string") {
    throw new Error("Provider apiVersion must be a string.");
  }
  if (input.maxOutputTokens !== undefined
    && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 256 || input.maxOutputTokens > 1_000_000)) {
    throw new Error("maxOutputTokens must be an integer from 256 through 1000000.");
  }
  if (input.capabilities !== undefined) {
    if (input.capabilities === null || typeof input.capabilities !== "object") {
      throw new Error("Provider capabilities must be an object.");
    }
    for (const [name, value] of Object.entries(input.capabilities)) {
      if (!(name === "streaming" || name === "parallelToolCalls" || name === "streamUsage" || name === "continuationReplay")) {
        throw new Error(`Unknown provider capability: ${name}.`);
      }
      if (typeof value !== "boolean") throw new Error(`Provider capability ${name} must be boolean.`);
    }
  }
}

function validateCredential(credential: ProviderCredentialConfig, provider: ProviderIdentity): void {
  if (credential === null || typeof credential !== "object") {
    throw new Error("Provider credential must be an object.");
  }
  if (credential.source === "oauth") {
    // Subscription sign-in exists only for the two first-party providers whose
    // OAuth contract Vanguard implements end to end. A custom endpoint must not
    // be able to name itself "oauth" and inherit a first-party token.
    if (credential.provider !== "anthropic" && credential.provider !== "openai" && credential.provider !== "kimi") {
      throw new Error("OAuth credentials are available only for the anthropic and openai providers, plus kimi.");
    }
    if (credential.provider !== provider) {
      throw new Error(`An oauth credential for ${credential.provider} cannot authenticate the ${provider} provider.`);
    }
    return;
  }
  if (credential.source !== "environment") {
    throw new Error("Provider credentials must use the environment or oauth source.");
  }
  if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(credential.variable)) {
    throw new Error("Credential variable must be an uppercase environment variable name.");
  }
  // An OAuth access token must arrive through the oauth source, which refreshes
  // it; smuggling a short-lived token through an API-key variable produces a
  // profile that silently stops working an hour later.
  if (/(?:OAUTH|REFRESH|SESSION|COOKIE)/u.test(credential.variable)) {
    throw new Error("OAuth, refresh-token, browser-session, and cookie credentials are not accepted as environment API keys; use credential source \"oauth\".");
  }
}

function validateEndpoint(raw: string | undefined, provider: ProviderIdentity): string {
  if (raw === undefined || raw.length === 0) {
    throw new Error(`${provider} provider config requires an endpoint.`);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("Provider endpoint must be an absolute HTTP(S) URL.");
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw new Error("Provider endpoints must not contain embedded credentials.");
  }
  if (endpoint.search.length > 0 || endpoint.hash.length > 0) {
    throw new Error("Provider endpoints must not contain query parameters or fragments.");
  }
  const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "::1";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && local)) {
    throw new Error("Provider endpoints require HTTPS; plain HTTP is allowed only for loopback development endpoints.");
  }
  return endpoint.toString();
}
