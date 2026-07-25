import { writeFile } from "node:fs/promises";
import type { JsonValue } from "../kernel/contracts.js";
import type { RunOutcome } from "../kernel/run.js";
import {
  analyzeTrajectory,
  analyzePatch,
  scoreExecutionQuality,
  classifyOutcome,
  createStreamLifecyclePresenter,
  encodePublicRunEvent,
  UsageLedger,
  type CodingSession,
  type FileJournal,
  type StreamObserver,
} from "../index.js";
import type { CliOptions } from "./options.js";

export interface ScorecardContext {
  readonly session: CodingSession;
  readonly options: CliOptions;
  readonly outcome: RunOutcome;
  readonly fileJournal: FileJournal;
  readonly scorecardFile: string;
  readonly journalFile: string;
  readonly configurationFile: string;
  readonly startedAt: number;
  readonly resumed: boolean;
  readonly usage?: UsageLedger | undefined;
  readonly delegation?: JsonValue | undefined;
}

export async function writeScorecard(context: ScorecardContext): Promise<void> {
  const { session, options, outcome } = context;
  const events = await context.fileJournal.readValidated();
  const trajectory = analyzeTrajectory(events);
  // Sessions contracted through conversation carry their task in the journal.
  const contracted = events.find((event) => event.type === "run.contracted")?.data;
  const contractedTask = contracted !== null && typeof contracted === "object" && !Array.isArray(contracted)
    && typeof contracted.task === "string" ? contracted.task : undefined;
  const task = options.task.length > 0 ? options.task : contractedTask ?? "";
  const patch = session.materialized
    ? await analyzePatch(session.sourceRoot, session.workspaceRoot)
    : emptyPatchMetrics();
  const verified = outcome.status === "completed";
  const classification = classifyOutcome(outcome);
  const executionQuality = scoreExecutionQuality(verified, trajectory, patch);
  const scorecard = {
    version: 3,
    sessionId: session.id,
    sourceRoot: session.sourceRoot,
    workspaceRoot: session.workspaceRoot,
    provider: options.provider,
    model: options.model,
    task,
    verification: options.verification,
    outcome,
    trajectory,
    patch,
    grade: {
      verified,
      classification,
      score: classification === "infrastructure_error" ? null : verified ? 1 : 0,
      executionQuality,
      steps: outcome.steps,
    },
    usage: context.usage?.usage() ?? null,
    estimatedCost: context.usage?.estimatedCost() ?? null,
    latency: context.usage?.latencyMs() ?? null,
    cacheEfficiency: context.usage?.cacheEfficiency() ?? null,
    durationMs: Date.now() - context.startedAt,
    journalFile: context.journalFile,
    completedAt: new Date().toISOString(),
    resumed: context.resumed,
    sessionFile: session.metadataFile,
    configurationFile: context.configurationFile,
    extensions: options.extensions ?? null,
    delegation: context.delegation ?? null,
  };
  await writeFile(context.scorecardFile, JSON.stringify(scorecard, null, 2));
  process.stdout.write(`${JSON.stringify({ ...scorecard, scorecardFile: context.scorecardFile }, null, 2)}\n`);
}

export function emptyPatchMetrics(): Awaited<ReturnType<typeof analyzePatch>> {
  return {
    changedFiles: [],
    filesAdded: 0,
    filesDeleted: 0,
    filesModified: 0,
    beforeBytes: 0,
    afterBytes: 0,
    beforeLines: 0,
    afterLines: 0,
  };
}

export function printAdvanceOutcome(
  outcome: RunOutcome,
  session: CodingSession,
  container: string,
  journalFile: string,
): void {
  process.stdout.write(`${JSON.stringify({
    outcome,
    sessionId: session.id,
    sessionRoot: container,
    workspaceRoot: session.workspaceRoot,
    journalFile,
  }, null, 2)}\n`);
}

export function createStreamPresenter(markActivity: () => void): StreamObserver {
  return createStreamLifecyclePresenter(streamPublicEvent, markActivity);
}

/** Merges the public-event stream presenter with usage accounting. */
export function combinedObserver(presenter: StreamObserver, usage: UsageLedger): StreamObserver {
  const ledger = usage.observer();
  return {
    started: (attempt) => presenter.started?.(attempt),
    delta: (text) => presenter.delta(text),
    thinking: (text) => presenter.thinking?.(text),
    reset: () => presenter.reset?.(),
    committed: () => presenter.committed?.(),
    failed: (reason) => presenter.failed?.(reason),
    usage: (value) => {
      ledger.usage?.(value);
      presenter.usage?.(value);
    },
  };
}

export function streamPublicEvent(event: Parameters<typeof encodePublicRunEvent>[0]): void {
  if (process.env.VANGUARD_EVENT_STREAM !== "1") return;
  process.stderr.write(encodePublicRunEvent(event));
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes === 0 ? `${remainder}s` : `${minutes}m ${remainder}s`;
}
