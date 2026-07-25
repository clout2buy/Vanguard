import {
  HttpModelAdapter,
  VANGUARD_PROVIDER_CONFIG_VERSION,
  createAnthropicModel,
  createConfiguredProviderModel,
  createDeepSeekModel,
  createOllamaModel,
  type StreamObserver,
} from "../index.js";
import type { CliOptions } from "./options.js";

/**
 * Reasoning effort for deep-reasoning wires. Left unset, a reasoning model
 * runs at the backend's own default depth on every turn — including trivial
 * ones — which reads as a hung agent in interactive sessions. "medium" keeps
 * the flagship models responsive; VANGUARD_REASONING_EFFORT overrides.
 */
function configuredReasoningEffort(options: CliOptions): "low" | "medium" | "high" | "max" {
  const value = options.reasoningEffort ?? process.env.VANGUARD_REASONING_EFFORT ?? "medium";
  if (value !== "low" && value !== "medium" && value !== "high" && value !== "max") {
    throw new Error("Reasoning effort must be low, medium, high, or max.");
  }
  return value;
}

/** The OpenAI Responses wire has no "max"; Kimi's ceiling clamps to high there. */
function openaiReasoningEffort(options: CliOptions): "low" | "medium" | "high" {
  const value = configuredReasoningEffort(options);
  return value === "max" ? "high" : value;
}

/**
 * Kimi K-series models think for minutes at their unbounded default depth,
 * which dominated interactive turn latency. Thinking stays enabled — the
 * models earn their keep with it — but the effort is bounded like OpenAI's,
 * and "max" restores the unbounded ceiling for whoever asks for it.
 */
function kimiReasoning(options: CliOptions): { thinking: "enabled"; effort: "low" | "medium" | "high" | "max" } {
  return { thinking: "enabled", effort: configuredReasoningEffort(options) };
}

export function createModel(options: CliOptions, streamObserver?: StreamObserver) {
  const common = {
    model: options.model,
    timeoutMs: 600_000,
    maxAttempts: 4,
    ...(streamObserver === undefined ? {} : { streamObserver }),
  };
  if (options.auth === "oauth") {
    if (options.provider !== "openai" && options.provider !== "anthropic" && options.provider !== "kimi") {
      throw new Error("--auth oauth is available only for the openai, anthropic, and kimi providers.");
    }
    // The profile supplies the OAuth-appropriate endpoint (Codex for ChatGPT),
    // so an explicit --endpoint stays an override rather than a requirement.
    return createConfiguredProviderModel({
      version: VANGUARD_PROVIDER_CONFIG_VERSION,
      provider: options.provider,
      model: options.model,
      credential: { source: "oauth", provider: options.provider },
      ...(options.provider === "anthropic" ? { apiVersion: "2023-06-01" } : {}),
      ...(options.provider === "kimi" ? { reasoning: kimiReasoning(options) } : {}),
      ...(options.provider === "openai" ? { reasoning: { effort: openaiReasoningEffort(options) } } : {}),
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    }, common);
  }
  if (options.credentialVariable !== undefined && options.provider !== "http") {
    // A named credential variable routes any provider through the configured
    // profile: the key env var is overridden (a gateway token instead of a
    // first-party key) without touching the provider's default variable.
    return createConfiguredProviderModel({
      version: VANGUARD_PROVIDER_CONFIG_VERSION,
      provider: options.provider,
      model: options.model,
      credential: { source: "environment", variable: options.credentialVariable },
      ...(options.provider === "openai-compatible" ? { wire: "openai-chat-completions" as const } : {}),
      ...(options.provider === "anthropic" ? { apiVersion: "2023-06-01" } : {}),
      ...(options.provider === "kimi" ? { reasoning: kimiReasoning(options) } : {}),
      ...(options.provider === "openai" ? { reasoning: { effort: openaiReasoningEffort(options) } } : {}),
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    }, common);
  }
  if (options.provider === "openai") return createConfiguredProviderModel({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "openai",
    model: options.model,
    reasoning: { effort: openaiReasoningEffort(options) },
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
  }, common);
  if (options.provider === "anthropic") return createAnthropicModel({ ...common, ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
  if (options.provider === "deepseek") return createDeepSeekModel({ ...common, ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
  if (options.provider === "kimi") return createConfiguredProviderModel({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "kimi",
    model: options.model,
    reasoning: kimiReasoning(options),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
  }, common);
  if (options.provider === "ollama") return createOllamaModel({ ...common, ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
  if (options.provider === "openai-compatible") {
    throw new Error("--credential-variable is required for the openai-compatible provider.");
  }
  if (options.endpoint === undefined) throw new Error("--endpoint is required for the http provider.");
  return new HttpModelAdapter({ endpoint: options.endpoint, timeoutMs: common.timeoutMs, maxAttempts: common.maxAttempts });
}
