/**
 * Cheap, deterministic token estimation for context budgeting.
 *
 * Providers bill and truncate by tokens while the kernel budgets bytes, and
 * bytes-per-token swings roughly 2.5-5x between dense code and prose. This
 * estimator does not try to match any one tokenizer; it tracks the *shape*
 * of tokenization — identifiers cost about a token per few characters,
 * punctuation costs about a token each — so token-dense content is seen as
 * expensive before the provider window overflows on it.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let tokens = 0;
  // Identifier/number runs: ~3.5 characters per token on average.
  // Everything else that is not whitespace: ~1 token per character run.
  const matcher = /[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/gu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const piece = match[0]!;
    tokens += /^[A-Za-z0-9_]/u.test(piece) ? Math.max(1, Math.ceil(piece.length / 3.5)) : 1;
  }
  return tokens;
}

/**
 * The token ceiling a byte budget implies. 2.5 bytes/token is the dense end
 * of real content: ordinary prose and JSON structure sit comfortably under
 * this ceiling, while pathologically token-dense content (minified code,
 * symbol soup) trims earlier instead of overflowing the provider window.
 */
export function tokenCeilingForBytes(maxBytes: number): number {
  return Math.floor(maxBytes / 2.5);
}

const SAMPLE_LENGTH = 65_536;

/**
 * Budget-check variant with bounded cost: exact under 64KB, deterministic
 * head-sample extrapolation above. Context selection calls this several
 * times per step over multi-megabyte transcripts; an exact walk there turned
 * a second of budgeting into minutes. Density is what matters for the
 * ceiling, and density is well estimated from a 64KB prefix.
 */
export function estimateTokensFast(text: string): number {
  if (text.length <= SAMPLE_LENGTH) return estimateTokens(text);
  return Math.ceil(estimateTokens(text.slice(0, SAMPLE_LENGTH)) * (text.length / SAMPLE_LENGTH));
}
