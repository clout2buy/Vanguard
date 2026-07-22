// The provider/model catalog the launch selector renders.
//
// This is presentation data: a starting menu, not an allowlist. Any model id may
// still be passed with --model or VANGUARD_MODEL, so a model released after this
// build is never blocked by a stale list. For a signed-in ChatGPT account the
// live Codex model list supersedes the static entries here.

import type { ProviderIdentity } from "./providerProfiles.js";
import { type OAuthProvider } from "./oauth/index.js";

export type SelectableProvider = Extract<ProviderIdentity, "deepseek" | "openai" | "anthropic" | "kimi" | "ollama">;

export type AuthKind = "api-key" | "oauth";

export interface ModelChoice {
  readonly id: string;
  readonly note?: string;
}

export interface ProviderChoice {
  readonly id: SelectableProvider;
  readonly label: string;
  /** Auth methods this provider accepts, best first. */
  readonly auth: readonly AuthKind[];
  readonly credentialVariable: string;
  readonly models: readonly ModelChoice[];
  /**
   * Model ids a subscription sign-in accepts, when they differ from the API
   * ids. The Codex backend rejects bare API aliases (gpt-5.6 is API-only), so
   * offering the API list to a ChatGPT account produces instant HTTP 400s.
   */
  readonly oauthModels?: readonly ModelChoice[];
}

export const PROVIDER_CHOICES: readonly ProviderChoice[] = [
  {
    id: "kimi",
    label: "Kimi Code",
    auth: ["oauth"],
    credentialVariable: "KIMI_API_KEY",
    models: [
      { id: "kimi-for-coding", note: "subscription default" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    auth: ["oauth", "api-key"],
    credentialVariable: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-opus-4-8", note: "most capable" },
      { id: "claude-sonnet-5", note: "balanced" },
      { id: "claude-fable-5" },
      { id: "claude-haiku-4-5-20251001", note: "fastest" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    auth: ["oauth", "api-key"],
    credentialVariable: "OPENAI_API_KEY",
    models: [
      { id: "gpt-5.6", note: "most capable" },
      { id: "gpt-5.6-codex", note: "coding" },
      { id: "gpt-5-mini", note: "fastest" },
    ],
    oauthModels: [
      { id: "gpt-5.6-sol", note: "flagship — deepest reasoning" },
      { id: "gpt-5.6-terra", note: "balanced — 2× cheaper" },
      { id: "gpt-5.5", note: "previous flagship" },
      { id: "gpt-5.3-codex-spark", note: "agentic coding tuned" },
      { id: "gpt-5.4-mini", note: "fast + cheap" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    auth: ["api-key"],
    credentialVariable: "DEEPSEEK_API_KEY",
    models: [
      { id: "deepseek-v4-pro", note: "most capable" },
      { id: "deepseek-chat" },
      { id: "deepseek-reasoner", note: "reasoning" },
    ],
  },
  {
    id: "ollama",
    label: "Ollama",
    auth: ["api-key"],
    credentialVariable: "OLLAMA_API_KEY",
    models: [
      { id: "glm-5.2:cloud", note: "cloud · long-horizon flagship" },
      { id: "kimi-k2.7-code:cloud", note: "cloud · agentic coding" },
      { id: "deepseek-v4-pro:cloud", note: "cloud · coding + reasoning" },
      { id: "qwen3-coder:30b", note: "local · coding" },
      { id: "gpt-oss:120b", note: "local" },
      { id: "llama3.3", note: "local" },
    ],
  },
];

export function providerChoice(provider: SelectableProvider): ProviderChoice {
  const choice = PROVIDER_CHOICES.find((candidate) => candidate.id === provider);
  if (choice === undefined) throw new Error(`Unknown provider: ${provider}`);
  return choice;
}

/** The static menu for a provider under a given auth method. */
export function catalogModels(provider: SelectableProvider, auth: AuthKind): readonly ModelChoice[] {
  const choice = providerChoice(provider);
  return auth === "oauth" && choice.oauthModels !== undefined ? choice.oauthModels : choice.models;
}

export function supportsOAuth(provider: SelectableProvider): provider is SelectableProvider & OAuthProvider {
  return providerChoice(provider).auth.includes("oauth");
}

export function defaultModel(provider: SelectableProvider): string {
  const first = providerChoice(provider).models[0];
  if (first === undefined) throw new Error(`Provider ${provider} has no catalog models.`);
  return first.id;
}

export function credentialVariable(provider: SelectableProvider): string {
  return providerChoice(provider).credentialVariable;
}

export function parseSelectableProvider(value: string): SelectableProvider | undefined {
  const normalized = value.trim().toLowerCase();
  return PROVIDER_CHOICES.find((choice) => choice.id === normalized)?.id;
}

/**
 * Conservative published context windows by model-id prefix, in tokens.
 * Deliberately understated where a family's exact window is uncertain: a low
 * value only makes compaction start earlier, while an overstated one re-opens
 * the failure this table exists to close — the kernel believing it can send
 * more context than the provider will accept. Families not listed fall back
 * to the engine's broad ceiling plus reactive window adaptation.
 */
const CONTEXT_WINDOW_TOKENS: readonly (readonly [prefix: string, tokens: number])[] = [
  ["claude-", 200_000],
  ["gpt-5", 256_000],
  ["deepseek-", 128_000],
  ["kimi-", 256_000],
];

/** Bytes-per-token mirror of tokenEstimate's 2.5 ratio, at a 60% duty factor. */
const BYTES_PER_TOKEN = 2.5;
const WINDOW_DUTY_FACTOR = 0.6;
const FALLBACK_CONTEXT_BYTES = 2_000_000;

/**
 * The context-byte budget a session should start from for one exact model.
 * With a known window, the sticky-context epoch machinery compacts
 * proactively instead of only after a provider rejection; without one, the
 * broad ceiling plus learned adaptation applies.
 */
export function defaultContextBytes(model: string): number {
  const normalized = model.trim().toLowerCase();
  const entry = CONTEXT_WINDOW_TOKENS.find(([prefix]) => normalized.startsWith(prefix));
  if (entry === undefined) return FALLBACK_CONTEXT_BYTES;
  return Math.min(FALLBACK_CONTEXT_BYTES, Math.floor(entry[1] * BYTES_PER_TOKEN * WINDOW_DUTY_FACTOR));
}

/** The published context window in tokens, when the model family is known. */
export function contextWindowTokens(model: string): number | undefined {
  const normalized = model.trim().toLowerCase();
  return CONTEXT_WINDOW_TOKENS.find(([prefix]) => normalized.startsWith(prefix))?.[1];
}
