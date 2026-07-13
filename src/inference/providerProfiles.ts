import { readFile } from "node:fs/promises";

export const VANGUARD_PROVIDER_CONFIG_VERSION = 1 as const;

export type ProviderIdentity = "openai" | "anthropic" | "deepseek" | "openai-compatible";
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
 * Portable, versioned provider connection configuration. It contains only
 * credential provenance, never credential values.
 */
export interface ProviderConnectionConfigV1 {
  readonly version: typeof VANGUARD_PROVIDER_CONFIG_VERSION;
  readonly provider: ProviderIdentity;
  readonly model: string;
  readonly endpoint?: string;
  readonly wire?: ProviderWireProtocol;
  readonly credential?: EnvironmentCredentialConfig;
  readonly capabilities?: ProviderCapabilityOverrides;
  /** Required header version for Anthropic Messages; ignored nowhere else. */
  readonly apiVersion?: string;
}

export interface CredentialProvenance {
  readonly source: "environment";
  readonly variable: string;
  readonly present: boolean;
}

export interface ResolvedProviderProfile {
  readonly version: typeof VANGUARD_PROVIDER_CONFIG_VERSION;
  readonly provider: ProviderIdentity;
  readonly model: string;
  readonly endpoint: string;
  readonly wire: ProviderWireProtocol;
  readonly credential: EnvironmentCredentialConfig;
  readonly credentialProvenance: CredentialProvenance;
  readonly capabilities: ProviderCapabilities;
  readonly apiVersion?: string;
}

const PROVIDER_DEFAULTS: Readonly<Record<Exclude<ProviderIdentity, "openai-compatible">, {
  endpoint: string;
  wire: ProviderWireProtocol;
  credentialVariable: string;
  apiVersion?: string;
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
  },
  deepseek: {
    endpoint: "https://api.deepseek.com/chat/completions",
    wire: "openai-chat-completions",
    credentialVariable: "DEEPSEEK_API_KEY",
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
  const endpoint = validateEndpoint(input.endpoint ?? defaults?.endpoint, input.provider);
  const credential = input.credential ?? (defaults === undefined
    ? undefined
    : { source: "environment" as const, variable: defaults.credentialVariable });
  if (credential === undefined) {
    throw new Error("openai-compatible profiles require an explicit environment credential variable.");
  }
  validateCredential(credential);
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
    : WIRE_CAPABILITIES[wire];
  const streaming = input.capabilities?.streaming ?? baseline.streaming;
  const capabilities: ProviderCapabilities = {
    streaming,
    parallelToolCalls: input.capabilities?.parallelToolCalls ?? baseline.parallelToolCalls,
    streamUsage: streaming && (input.capabilities?.streamUsage ?? baseline.streamUsage),
    continuationReplay: input.capabilities?.continuationReplay ?? baseline.continuationReplay,
  };
  return {
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: input.provider,
    model: input.model.trim(),
    endpoint,
    wire,
    credential,
    credentialProvenance: {
      source: "environment",
      variable: credential.variable,
      present: typeof environment[credential.variable] === "string" && environment[credential.variable]!.length > 0,
    },
    capabilities,
    ...(apiVersion === undefined ? {} : { apiVersion }),
  };
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
  };
}

function validateConfigShape(input: ProviderConnectionConfigV1): void {
  if (input === null || typeof input !== "object") throw new Error("Provider config must be an object.");
  if (input.version !== VANGUARD_PROVIDER_CONFIG_VERSION) {
    throw new Error(`Unsupported provider config version: ${String(input.version)}.`);
  }
  if (!(input.provider === "openai" || input.provider === "anthropic" || input.provider === "deepseek"
    || input.provider === "openai-compatible")) {
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

function validateCredential(credential: EnvironmentCredentialConfig): void {
  if (credential === null || typeof credential !== "object") {
    throw new Error("Provider credential must be an object.");
  }
  if (credential.source !== "environment") {
    throw new Error("Only environment API-key credentials are supported by the native provider engine.");
  }
  if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(credential.variable)) {
    throw new Error("Credential variable must be an uppercase environment variable name.");
  }
  if (/(?:OAUTH|REFRESH|SESSION|COOKIE)/u.test(credential.variable)) {
    throw new Error("OAuth, refresh-token, browser-session, and cookie credentials are not accepted by native provider profiles.");
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
