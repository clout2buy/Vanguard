import { createHash, createHmac } from "node:crypto";
import type { JsonValue } from "../kernel/contracts.js";

export type EvaluationLayer = "canary" | "shadow" | "holdout";

export interface EvaluationEngine {
  readonly id: string;
  readonly version: string;
  readonly command: string;
  readonly model: string;
  readonly authMode: "api-key" | "oauth" | "local";
}

export interface EvaluationTask {
  readonly id: string;
  readonly layer: EvaluationLayer;
  readonly category: string;
  readonly language: string;
  readonly sourceSha256: string;
  readonly graderSha256: string;
  readonly maxDurationMs: number;
  /** Must be zero for every never-run holdout at freeze time. */
  readonly priorRunCount: number;
}

export interface CertificateThresholds {
  readonly parityOverallLowerBound: number;
  readonly parityCategoryLowerBound: number;
  readonly superiorityOverallLowerBound: number;
  readonly maintainabilityLowerBound: number;
  readonly maxCostRatio: number;
  readonly maxInterventionDelta: number;
  readonly confidence: number;
}

export interface CertificationManifest {
  readonly schemaVersion: 1;
  readonly program: string;
  readonly frozenAt: string;
  readonly vanguardCommit: string;
  readonly evaluatorId: string;
  readonly externalEvaluator: boolean;
  readonly repetitions: number;
  readonly minPairedTasks: number;
  readonly bootstrapSamples: number;
  readonly seed: string;
  readonly engines: readonly EvaluationEngine[];
  readonly tasks: readonly EvaluationTask[];
  readonly thresholds: CertificateThresholds;
}

export interface PublicAssignment {
  readonly runId: string;
  readonly taskId: string;
  readonly repetition: number;
  readonly alias: string;
  readonly ordinal: number;
}

export interface PrivateAssignment extends PublicAssignment {
  readonly engineId: string;
}

export interface AssignmentBundle {
  readonly manifestSha256: string;
  readonly publicAssignments: readonly PublicAssignment[];
  readonly privateAssignments: readonly PrivateAssignment[];
}

export interface BlindRunResult {
  readonly runId: string;
  readonly taskId: string;
  readonly repetition: number;
  readonly alias: string;
  readonly success: boolean;
  readonly maintainability: number;
  readonly interventions: number;
  readonly costUsd: number | null;
  readonly durationMs: number;
  readonly criticalIncident: boolean;
  readonly evaluatorId: string;
}

export interface CertificationLedgerEntry {
  readonly index: number;
  readonly previousHash: string;
  readonly hash: string;
  readonly result: BlindRunResult;
}

export interface ConfidenceInterval {
  readonly estimate: number;
  readonly lower: number;
  readonly upper: number;
  readonly samples: number;
}

export interface CompetitorComparison {
  readonly competitor: string;
  readonly pairedTasks: number;
  readonly successDifference: ConfidenceInterval;
  readonly maintainabilityDifference: ConfidenceInterval;
  readonly categorySuccess: Readonly<Record<string, ConfidenceInterval>>;
  readonly interventionDelta: number;
  readonly costRatio: number | null;
  readonly parity: boolean;
  readonly superiority: boolean;
  readonly reasons: readonly string[];
}

export interface CertificateReport {
  readonly manifestSha256: string;
  readonly outcome: "not-certifiable" | "none" | "overall-parity" | "parity-with-scoped-superiority" | "overall-superiority";
  readonly certifiable: boolean;
  readonly comparisons: readonly CompetitorComparison[];
  readonly blockers: readonly string[];
}

const GENESIS = "0".repeat(64);
const SHA256 = /^[a-f0-9]{64}$/u;

export function validateCertificationManifest(manifest: CertificationManifest): void {
  if (manifest.schemaVersion !== 1 || manifest.program.trim().length === 0) throw new Error("Unsupported certification manifest.");
  if (!Number.isSafeInteger(manifest.repetitions) || manifest.repetitions < 1 || manifest.repetitions > 20) {
    throw new Error("Certification repetitions must be between 1 and 20.");
  }
  if (!Number.isSafeInteger(manifest.minPairedTasks) || manifest.minPairedTasks < 30) {
    throw new Error("Certification requires at least 30 paired tasks.");
  }
  if (!Number.isSafeInteger(manifest.bootstrapSamples) || manifest.bootstrapSamples < 1_000) {
    throw new Error("Certification requires at least 1,000 bootstrap samples.");
  }
  if (!manifest.externalEvaluator || manifest.evaluatorId.trim().length === 0) {
    throw new Error("Certification must be frozen and scored by an identified external evaluator.");
  }
  const engines = unique(manifest.engines.map((engine) => engine.id), "engine id");
  if (!engines.includes("vanguard") || engines.length < 3) {
    throw new Error("Certification requires Vanguard and at least two competitor engines.");
  }
  for (const engine of manifest.engines) {
    if ([engine.version, engine.command, engine.model].some((value) => value.trim().length === 0)) {
      throw new Error(`Engine '${engine.id}' is not fully pinned.`);
    }
  }
  unique(manifest.tasks.map((task) => task.id), "task id");
  const holdout = manifest.tasks.filter((task) => task.layer === "holdout");
  if (holdout.length < manifest.minPairedTasks) {
    throw new Error(`Holdout has ${holdout.length} tasks; ${manifest.minPairedTasks} are required.`);
  }
  for (const task of manifest.tasks) {
    if (!SHA256.test(task.sourceSha256) || !SHA256.test(task.graderSha256)) {
      throw new Error(`Task '${task.id}' lacks frozen source/grader digests.`);
    }
    if (!Number.isSafeInteger(task.maxDurationMs) || task.maxDurationMs < 1_000) {
      throw new Error(`Task '${task.id}' has an invalid duration budget.`);
    }
    if (task.layer === "holdout" && task.priorRunCount !== 0) {
      throw new Error(`Holdout task '${task.id}' was already run and is contaminated.`);
    }
  }
  const t = manifest.thresholds;
  for (const [name, value] of Object.entries(t)) {
    if (!Number.isFinite(value)) throw new Error(`Threshold '${name}' is not finite.`);
  }
  if (t.confidence < 0.9 || t.confidence >= 1) throw new Error("Confidence must be in [0.9, 1).");
}

export function manifestSha256(manifest: CertificationManifest): string {
  return createHash("sha256").update(canonicalJson(manifest as unknown as JsonValue)).digest("hex");
}

export function createBlindedAssignments(
  manifest: CertificationManifest,
  blindingSecret: string,
): AssignmentBundle {
  validateCertificationManifest(manifest);
  if (Buffer.byteLength(blindingSecret) < 32) throw new Error("Blinding secret must contain at least 32 bytes.");
  const digest = manifestSha256(manifest);
  const rng = seededRandom(`${manifest.seed}:${digest}`);
  const publicAssignments: PublicAssignment[] = [];
  const privateAssignments: PrivateAssignment[] = [];
  for (const task of manifest.tasks.filter((candidate) => candidate.layer === "holdout")) {
    for (let repetition = 1; repetition <= manifest.repetitions; repetition += 1) {
      const engines = shuffled([...manifest.engines], rng);
      for (const [ordinal, engine] of engines.entries()) {
        const alias = `E${ordinal + 1}`;
        const runId = createHmac("sha256", blindingSecret)
          .update(`${digest}\0${task.id}\0${repetition}\0${engine.id}`)
          .digest("hex");
        const publicAssignment: PublicAssignment = { runId, taskId: task.id, repetition, alias, ordinal };
        publicAssignments.push(publicAssignment);
        privateAssignments.push({ ...publicAssignment, engineId: engine.id });
      }
    }
  }
  // Randomize execution order separately from within-task engine aliasing.
  return {
    manifestSha256: digest,
    publicAssignments: shuffled(publicAssignments, rng),
    privateAssignments,
  };
}

export function appendCertificationResult(
  ledger: readonly CertificationLedgerEntry[],
  result: BlindRunResult,
): readonly CertificationLedgerEntry[] {
  if (!SHA256.test(result.runId)) throw new Error("Certification run id is malformed.");
  if (result.maintainability < 0 || result.maintainability > 1) throw new Error("Maintainability must be in [0,1].");
  if (!Number.isSafeInteger(result.interventions) || result.interventions < 0) throw new Error("Interventions must be non-negative.");
  if (ledger.some((entry) => entry.result.runId === result.runId)) throw new Error(`Duplicate result for run '${result.runId}'.`);
  validateCertificationLedger(ledger);
  const previousHash = ledger.at(-1)?.hash ?? GENESIS;
  const index = ledger.length + 1;
  const hash = ledgerHash(previousHash, index, result);
  return [...ledger, { index, previousHash, hash, result }];
}

export function validateCertificationLedger(ledger: readonly CertificationLedgerEntry[]): void {
  let previousHash = GENESIS;
  for (const [offset, entry] of ledger.entries()) {
    if (entry.index !== offset + 1 || entry.previousHash !== previousHash
      || entry.hash !== ledgerHash(previousHash, entry.index, entry.result)) {
      throw new Error(`Certification ledger integrity failure at entry ${offset + 1}.`);
    }
    previousHash = entry.hash;
  }
}

export function evaluateCertificate(
  manifest: CertificationManifest,
  assignments: AssignmentBundle,
  ledger: readonly CertificationLedgerEntry[],
): CertificateReport {
  const blockers: string[] = [];
  try { validateCertificationManifest(manifest); } catch (error) { blockers.push(message(error)); }
  const digest = manifestSha256(manifest);
  if (assignments.manifestSha256 !== digest) blockers.push("Assignment bundle does not match the frozen manifest.");
  try { validateCertificationLedger(ledger); } catch (error) { blockers.push(message(error)); }
  const byRun = new Map(ledger.map((entry) => [entry.result.runId, entry.result]));
  const privateByRun = new Map(assignments.privateAssignments.map((assignment) => [assignment.runId, assignment]));
  for (const assignment of assignments.publicAssignments) {
    const result = byRun.get(assignment.runId);
    if (result === undefined) { blockers.push(`Missing result for ${assignment.runId}.`); continue; }
    if (result.taskId !== assignment.taskId || result.repetition !== assignment.repetition || result.alias !== assignment.alias) {
      blockers.push(`Blinded result metadata mismatch for ${assignment.runId}.`);
    }
    if (result.evaluatorId !== manifest.evaluatorId) blockers.push(`Result ${assignment.runId} came from a different evaluator.`);
  }
  for (const result of byRun.values()) {
    if (result.criticalIncident) blockers.push(`Critical incident in run ${result.runId}.`);
    if (!privateByRun.has(result.runId)) blockers.push(`Unassigned result ${result.runId}.`);
  }
  if (byRun.size !== assignments.publicAssignments.length) blockers.push("Result count does not equal the blinded assignment count.");
  if (blockers.length > 0) {
    return { manifestSha256: digest, outcome: "not-certifiable", certifiable: false, comparisons: [], blockers: [...new Set(blockers)] };
  }

  const unblinded = assignments.privateAssignments.map((assignment) => ({
    ...assignment,
    result: byRun.get(assignment.runId)!,
    category: manifest.tasks.find((task) => task.id === assignment.taskId)!.category,
  }));
  const competitors = manifest.engines.map((engine) => engine.id).filter((id) => id !== "vanguard");
  const comparisons = competitors.map((competitor) => compareEngine(manifest, unblinded, competitor));
  const allParity = comparisons.every((comparison) => comparison.parity);
  const allSuperiority = comparisons.every((comparison) => comparison.superiority);
  const anySuperiority = comparisons.some((comparison) => comparison.superiority);
  const outcome: CertificateReport["outcome"] = allSuperiority
    ? "overall-superiority"
    : allParity && anySuperiority
      ? "parity-with-scoped-superiority"
      : allParity ? "overall-parity" : "none";
  return { manifestSha256: digest, outcome, certifiable: true, comparisons, blockers: [] };
}

interface UnblindedRun extends PrivateAssignment {
  readonly result: BlindRunResult;
  readonly category: string;
}

function compareEngine(
  manifest: CertificationManifest,
  runs: readonly UnblindedRun[],
  competitor: string,
): CompetitorComparison {
  const vanguard = new Map(runs.filter((run) => run.engineId === "vanguard")
    .map((run) => [`${run.taskId}:${run.repetition}`, run]));
  const pairs = runs.filter((run) => run.engineId === competitor)
    .map((other) => ({ vanguard: vanguard.get(`${other.taskId}:${other.repetition}`), other }))
    .filter((pair): pair is { vanguard: UnblindedRun; other: UnblindedRun } => pair.vanguard !== undefined);
  const reasons: string[] = [];
  if (pairs.length < manifest.minPairedTasks * manifest.repetitions) {
    reasons.push(`Only ${pairs.length} paired runs; ${manifest.minPairedTasks * manifest.repetitions} required.`);
  }
  const success = bootstrapDifference(
    pairs.map((pair) => Number(pair.vanguard.result.success)),
    pairs.map((pair) => Number(pair.other.result.success)),
    manifest,
    `success:${competitor}`,
  );
  const maintainability = bootstrapDifference(
    pairs.map((pair) => pair.vanguard.result.maintainability),
    pairs.map((pair) => pair.other.result.maintainability),
    manifest,
    `maintainability:${competitor}`,
  );
  const categories: Record<string, ConfidenceInterval> = {};
  for (const category of new Set(pairs.map((pair) => pair.other.category))) {
    const categoryPairs = pairs.filter((pair) => pair.other.category === category);
    categories[category] = bootstrapDifference(
      categoryPairs.map((pair) => Number(pair.vanguard.result.success)),
      categoryPairs.map((pair) => Number(pair.other.result.success)),
      manifest,
      `category:${competitor}:${category}`,
    );
  }
  const interventionDelta = mean(pairs.map((pair) => pair.vanguard.result.interventions - pair.other.result.interventions));
  const vanguardCost = sumKnown(pairs.map((pair) => pair.vanguard.result.costUsd));
  const competitorCost = sumKnown(pairs.map((pair) => pair.other.result.costUsd));
  const costRatio = vanguardCost === null || competitorCost === null || competitorCost === 0
    ? null : vanguardCost / competitorCost;
  const t = manifest.thresholds;
  if (success.lower <= t.parityOverallLowerBound) reasons.push("Overall success parity lower bound was missed.");
  if (maintainability.lower <= t.maintainabilityLowerBound) reasons.push("Maintainability non-inferiority was missed.");
  for (const [category, interval] of Object.entries(categories)) {
    if (interval.samples >= 10 && interval.lower <= t.parityCategoryLowerBound) reasons.push(`Category '${category}' missed non-inferiority.`);
  }
  if (interventionDelta > t.maxInterventionDelta) reasons.push("Human intervention delta exceeded the threshold.");
  if (costRatio !== null && costRatio > t.maxCostRatio) reasons.push("Cost ratio exceeded the threshold.");
  if (costRatio === null) reasons.push("Cost parity could not be computed from complete provider usage.");
  const parity = reasons.length === 0;
  const superiority = parity && success.lower >= t.superiorityOverallLowerBound;
  return {
    competitor,
    pairedTasks: pairs.length,
    successDifference: success,
    maintainabilityDifference: maintainability,
    categorySuccess: categories,
    interventionDelta: round6(interventionDelta),
    costRatio: costRatio === null ? null : round6(costRatio),
    parity,
    superiority,
    reasons,
  };
}

function bootstrapDifference(
  left: readonly number[],
  right: readonly number[],
  manifest: CertificationManifest,
  salt: string,
): ConfidenceInterval {
  if (left.length !== right.length || left.length === 0) return { estimate: 0, lower: -1, upper: 1, samples: 0 };
  const differences = left.map((value, index) => value - right[index]!);
  const rng = seededRandom(`${manifest.seed}:${salt}`);
  const draws: number[] = [];
  for (let sample = 0; sample < manifest.bootstrapSamples; sample += 1) {
    let total = 0;
    for (let index = 0; index < differences.length; index += 1) {
      total += differences[Math.floor(rng() * differences.length)]!;
    }
    draws.push(total / differences.length);
  }
  draws.sort((a, b) => a - b);
  const alpha = (1 - manifest.thresholds.confidence) / 2;
  return {
    estimate: round6(mean(differences)),
    lower: round6(draws[Math.floor(alpha * (draws.length - 1))]!),
    upper: round6(draws[Math.ceil((1 - alpha) * (draws.length - 1))]!),
    samples: differences.length,
  };
}

export function estimateCertificationCost(
  manifest: Pick<CertificationManifest, "engines" | "tasks" | "repetitions">,
  assumptions: Readonly<Record<string, { readonly meanCostPerTaskUsd: number }>>,
): { readonly runs: number; readonly estimatedUsd: number; readonly missingEngines: readonly string[] } {
  const holdoutTasks = manifest.tasks.filter((task) => task.layer === "holdout").length;
  const missingEngines = manifest.engines.filter((engine) => assumptions[engine.id] === undefined).map((engine) => engine.id);
  const estimatedUsd = manifest.engines.reduce((sum, engine) =>
    sum + (assumptions[engine.id]?.meanCostPerTaskUsd ?? 0) * holdoutTasks * manifest.repetitions, 0);
  return {
    runs: holdoutTasks * manifest.engines.length * manifest.repetitions,
    estimatedUsd: round6(estimatedUsd),
    missingEngines,
  };
}

function ledgerHash(previousHash: string, index: number, result: BlindRunResult): string {
  return createHash("sha256").update(previousHash).update("\n").update(String(index)).update("\n")
    .update(canonicalJson(result as unknown as JsonValue)).digest("hex");
}

function canonicalJson(value: JsonValue): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function seededRandom(seed: string): () => number {
  let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(values: T[], rng: () => number): T[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = Math.floor(rng() * (index + 1));
    [values[index], values[other]] = [values[other]!, values[index]!];
  }
  return values;
}

function unique(values: readonly string[], name: string): string[] {
  const result = [...new Set(values)];
  if (result.length !== values.length) throw new Error(`Duplicate ${name}.`);
  return result;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sumKnown(values: readonly (number | null)[]): number | null {
  return values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
