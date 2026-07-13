import type { JsonValue } from "../kernel/contracts.js";
import type { StreamObserver } from "./httpModel.js";

export interface NormalizedUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly calls: number;
}

export interface EstimatedCost {
  readonly model: string;
  readonly inputCostUsd: number;
  readonly cachedInputCostUsd: number;
  readonly outputCostUsd: number;
  readonly totalCostUsd: number;
}

export interface ModelPrice {
  /** USD per million input (uncached) tokens. */
  readonly inputPerMillion: number;
  /** USD per million cached input tokens. */
  readonly cachedInputPerMillion: number;
  /** USD per million output tokens. */
  readonly outputPerMillion: number;
}

/**
 * Published list prices as of the frozen evaluation window. Overridable via
 * configuration; unknown models produce a null cost estimate rather than a
 * fabricated one, so cost is never silently invented.
 */
export const DEFAULT_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "deepseek-v4-pro": { inputPerMillion: 0.28, cachedInputPerMillion: 0.028, outputPerMillion: 0.42 },
  "gpt-5.6": { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  "claude-opus-4-8": { inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 25 },
};

const EMPTY: NormalizedUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  calls: 0,
};

/**
 * Accumulates provider usage across a session, normalizing the three wire
 * shapes (Chat Completions, Anthropic Messages, OpenAI Responses) into one
 * schema. Feeds the scorecard's usage and estimated-cost fields.
 */
export class UsageLedger {
  #total: NormalizedUsage = EMPTY;
  readonly #prices: Readonly<Record<string, ModelPrice>>;
  readonly #latenciesMs: number[] = [];

  constructor(
    private readonly model: string,
    prices: Readonly<Record<string, ModelPrice>> = DEFAULT_MODEL_PRICES,
  ) {
    this.#prices = prices;
  }

  observer(): Pick<StreamObserver, "delta" | "usage"> {
    return {
      delta: () => {},
      usage: (usage) => this.record(usage),
    };
  }

  record(usage: JsonValue): void {
    const normalized = normalizeUsage(usage);
    if (normalized === undefined) return;
    this.#total = {
      inputTokens: this.#total.inputTokens + normalized.inputTokens,
      cachedInputTokens: this.#total.cachedInputTokens + normalized.cachedInputTokens,
      outputTokens: this.#total.outputTokens + normalized.outputTokens,
      reasoningTokens: this.#total.reasoningTokens + normalized.reasoningTokens,
      calls: this.#total.calls + 1,
    };
  }

  recordLatency(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.#latenciesMs.push(ms);
  }

  usage(): NormalizedUsage {
    return this.#total;
  }

  latencyMs(): { calls: number; totalMs: number; meanMs: number } {
    const totalMs = this.#latenciesMs.reduce((sum, value) => sum + value, 0);
    const calls = this.#latenciesMs.length;
    return { calls, totalMs, meanMs: calls === 0 ? 0 : totalMs / calls };
  }

  estimatedCost(): EstimatedCost | null {
    const price = this.#prices[this.model];
    if (price === undefined) return null;
    const uncachedInput = Math.max(0, this.#total.inputTokens - this.#total.cachedInputTokens);
    const inputCostUsd = (uncachedInput / 1_000_000) * price.inputPerMillion;
    const cachedInputCostUsd = (this.#total.cachedInputTokens / 1_000_000) * price.cachedInputPerMillion;
    const outputCostUsd = (this.#total.outputTokens / 1_000_000) * price.outputPerMillion;
    return {
      model: this.model,
      inputCostUsd: round6(inputCostUsd),
      cachedInputCostUsd: round6(cachedInputCostUsd),
      outputCostUsd: round6(outputCostUsd),
      totalCostUsd: round6(inputCostUsd + cachedInputCostUsd + outputCostUsd),
    };
  }
}

/**
 * Normalizes one provider usage object. Returns undefined when the payload
 * carries no recognizable token counts.
 */
export function normalizeUsage(usage: JsonValue): NormalizedUsage | undefined {
  const record = asRecord(usage);
  if (record === undefined) return undefined;

  // Chat Completions / DeepSeek use prompt_tokens/completion_tokens.
  const promptTokens = numeric(record.prompt_tokens);
  if (promptTokens !== undefined) {
    const promptDetails = asRecord(record.prompt_tokens_details);
    const completionDetails = asRecord(record.completion_tokens_details);
    return {
      inputTokens: promptTokens,
      cachedInputTokens: numeric(promptDetails?.cached_tokens) ?? numeric(record.prompt_cache_hit_tokens) ?? 0,
      outputTokens: numeric(record.completion_tokens) ?? 0,
      reasoningTokens: numeric(completionDetails?.reasoning_tokens) ?? 0,
      calls: 1,
    };
  }

  // OpenAI Responses uses input_tokens/output_tokens with nested *_details;
  // that nested-details shape disambiguates it from Anthropic, which shares
  // the input_tokens/output_tokens field names.
  const inputDetails = asRecord(record.input_tokens_details);
  const outputDetails = asRecord(record.output_tokens_details);
  if (inputDetails !== undefined || outputDetails !== undefined) {
    return {
      inputTokens: numeric(record.input_tokens) ?? 0,
      cachedInputTokens: numeric(inputDetails?.cached_tokens) ?? 0,
      outputTokens: numeric(record.output_tokens) ?? 0,
      reasoningTokens: numeric(outputDetails?.reasoning_tokens) ?? 0,
      calls: 1,
    };
  }

  // Anthropic Messages uses input_tokens/output_tokens plus cache fields.
  const anthropicInput = numeric(record.input_tokens ?? record.inputTokens);
  const cacheRead = numeric(record.cache_read_input_tokens);
  const cacheWrite = numeric(record.cache_creation_input_tokens);
  if (anthropicInput !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
    const base = anthropicInput ?? 0;
    return {
      inputTokens: base + (cacheRead ?? 0) + (cacheWrite ?? 0),
      cachedInputTokens: cacheRead ?? 0,
      outputTokens: numeric(record.output_tokens ?? record.outputTokens) ?? 0,
      reasoningTokens: 0,
      calls: 1,
    };
  }

  return undefined;
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && value !== undefined && !Array.isArray(value) && typeof value === "object"
    ? value
    : undefined;
}

function numeric(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
