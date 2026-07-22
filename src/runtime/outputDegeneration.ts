/**
 * Detection of degenerate model output in workspace mutations.
 *
 * A degenerating decoder repeats itself. The observed failure signatures are
 * a single non-trivial line emitted over and over ("// I'm a front-end
 * developer" ×N), a short cycle of lines alternated indefinitely (A/B/A/B…),
 * and a dominant line re-emitted with token-level jitter breaking up the
 * runs. The kernel's circuit breaker catches identical *tool calls*, and the
 * stagnation guard catches unchanged *observations* — neither inspects the
 * bytes a mutation is about to write. This rung does: it rejects a write
 * whose content shows a repetition signature before the mutation lands on
 * disk, turning a silent spiral into structured feedback the model must act
 * on.
 *
 * Repetition that already exists in the file being rewritten is never blamed
 * on the new mutation, and a genuinely repetitive deliverable can be written
 * deliberately via the tools' `allowRepetition` flag — the point is that
 * unintentional degeneration never sets a flag.
 */

export interface DegenerateRepetition {
  /** The trimmed line that repeats (for cycles, the block's first significant line). */
  readonly line: string;
  /** Repetitions: run length, cycle repetitions, or scattered occurrences. */
  readonly count: number;
  /** 1-based line number where the repetition starts in the new content. */
  readonly startLine: number;
  readonly kind: "run" | "cycle" | "scattered";
}

/** Consecutive identical significant lines at or beyond this count are degenerate. */
export const DEGENERATE_RUN_THRESHOLD = 5;

/** A 2-4 line block repeated consecutively at least this many times is a spiral. */
export const DEGENERATE_CYCLE_THRESHOLD = 8;

/** Shorter trimmed lines (closing braces, separators) are structural, not signal. */
const MIN_SIGNIFICANT_LINE_LENGTH = 8;

const MAX_CYCLE_PERIOD = 4;
/** Scattered dominance: this many occurrences of one line at high local density. */
const SCATTERED_OCCURRENCE_THRESHOLD = 2 * DEGENERATE_RUN_THRESHOLD;
/**
 * Fraction of its own span one line must fill to count as scattered
 * degeneration. Legitimate recurring lines (`return null;` across a switch)
 * sit near 0.5 because real code separates them; a jittered spiral sits far
 * above it.
 */
const SCATTERED_DENSITY_THRESHOLD = 0.7;

/**
 * Returns the worst degenerate repetition in `content`, or undefined when the
 * content is clean. Three signatures are checked: consecutive identical
 * lines, short repeated line cycles, and one line dominating its span with
 * small interruptions. A line only counts when it is long enough to be
 * meaningful and contains letters or digits, so structural repetition (blank
 * lines, braces, `# ----` rules) never trips the guard. Lines whose
 * repetition already trips the same detectors in `prior` are treated as
 * pre-existing and ignored.
 */
export function detectDegenerateRepetition(
  content: string,
  prior?: string,
): DegenerateRepetition | undefined {
  const preExisting = prior === undefined
    ? new Set<string>()
    : new Set(degenerateFindings(trimmedLines(prior)).map((finding) => finding.line));
  let worst: DegenerateRepetition | undefined;
  for (const finding of degenerateFindings(trimmedLines(content))) {
    if (preExisting.has(finding.line)) continue;
    if (worst === undefined || finding.count > worst.count) worst = finding;
  }
  return worst;
}

/** Renders the guard's rejection as actionable model feedback. */
export function degenerateRepetitionError(found: DegenerateRepetition): string {
  const shape = found.kind === "run"
    ? `repeats ${found.count} times consecutively`
    : found.kind === "cycle"
      ? `repeats in a short cycle ${found.count} times`
      : `occurs ${found.count} times in close succession`;
  return `Mutation rejected: the line '${truncateLine(found.line)}' ${shape} starting at line `
    + `${found.startLine}. Runaway repetition is the signature of degenerated output, not `
    + "intentional code. Re-emit the change without the repetition (or express it as a loop or "
    + "constant). If the repetition is genuinely part of the deliverable, retry with "
    + "allowRepetition set to true.";
}

function trimmedLines(content: string): readonly string[] {
  return content.split(/\r?\n/u).map((line) => line.trim());
}

function degenerateFindings(lines: readonly string[]): DegenerateRepetition[] {
  return [...identicalRuns(lines), ...blockCycles(lines), ...scatteredDominance(lines)];
}

/** Period-1: the same significant line, back to back. */
function* identicalRuns(lines: readonly string[]): Generator<DegenerateRepetition> {
  let runLine: string | undefined;
  let runCount = 0;
  let runStart = 0;
  for (let index = 0; index <= lines.length; index += 1) {
    const line = index < lines.length ? lines[index] : undefined;
    if (line !== undefined && line === runLine) {
      runCount += 1;
      continue;
    }
    if (runLine !== undefined && runCount >= DEGENERATE_RUN_THRESHOLD) {
      yield { line: runLine, count: runCount, startLine: runStart + 1, kind: "run" };
    }
    if (line !== undefined && isSignificantLine(line)) {
      runLine = line;
      runCount = 1;
      runStart = index;
    } else {
      runLine = undefined;
      runCount = 0;
    }
  }
}

/**
 * Periods 2-4: a small block of lines repeated back to back (the A/B/A/B
 * spiral). Detected as a maximal stretch where each line equals the line one
 * period earlier; the stretch plus its seed block gives the repetition count.
 */
function* blockCycles(lines: readonly string[]): Generator<DegenerateRepetition> {
  for (let period = 2; period <= MAX_CYCLE_PERIOD; period += 1) {
    let stretch = 0;
    for (let index = period; index <= lines.length; index += 1) {
      if (index < lines.length && lines[index] === lines[index - period]) {
        stretch += 1;
        continue;
      }
      if (stretch > 0) {
        const repetitions = Math.floor((stretch + period) / period);
        if (repetitions >= DEGENERATE_CYCLE_THRESHOLD) {
          const blockStart = index - stretch - period;
          const block = lines.slice(blockStart, blockStart + period);
          const significant = block.find(isSignificantLine);
          if (significant !== undefined) {
            yield { line: significant, count: repetitions, startLine: blockStart + 1, kind: "cycle" };
          }
        }
        stretch = 0;
      }
    }
  }
}

/**
 * One significant line re-emitted many times with small interruptions (the
 * near-miss ramp that keeps every consecutive run just under the threshold).
 * The density floor keeps legitimately recurring lines out: real code puts
 * real code between the repeats.
 */
function* scatteredDominance(lines: readonly string[]): Generator<DegenerateRepetition> {
  const positions = new Map<string, number[]>();
  for (const [index, line] of lines.entries()) {
    if (!isSignificantLine(line)) continue;
    const existing = positions.get(line);
    if (existing === undefined) positions.set(line, [index]);
    else existing.push(index);
  }
  for (const [line, occurrences] of positions) {
    if (occurrences.length < SCATTERED_OCCURRENCE_THRESHOLD) continue;
    const span = occurrences.at(-1)! - occurrences[0]! + 1;
    if (occurrences.length / span >= SCATTERED_DENSITY_THRESHOLD) {
      yield { line, count: occurrences.length, startLine: occurrences[0]! + 1, kind: "scattered" };
    }
  }
}

function isSignificantLine(trimmed: string): boolean {
  return trimmed.length >= MIN_SIGNIFICANT_LINE_LENGTH && /[\p{L}\p{N}]/u.test(trimmed);
}

function truncateLine(line: string, max = 120): string {
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
