import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import type {
  JsonValue,
  ModelPort,
  TaskContract,
  ToolContext,
  ToolResult,
  TranscriptEntry,
  VerificationResult,
  VerifierPort,
} from "../kernel/contracts.js";
import { WorkspaceBoundary } from "./workspace.js";

/**
 * The judge rung: correctness verifiers prove "done"; this one rules on
 * "good". When a contract declares a creative direction, completion must
 * survive a model judgment of the rendered deliverable against that
 * direction — on vision-capable wires the judge sees the actual pixels via
 * the same inline-image channel the agent uses.
 *
 * The judge is deliberately scoped: it activates only when the contract
 * carries a creativeDirection AND a renderable deliverable exists. Judging
 * arbitrary code text against taste is noise, not verification, so with
 * nothing to look at it passes with an honest note instead of blocking on a
 * guess. An unreachable judge model also passes-with-note: taste must never
 * turn a provider outage into a failed run.
 */

export type DeliverableRenderer = (relativePath: string, context: ToolContext) => Promise<ToolResult>;

/**
 * Bounds for the fallback discovery scan. `touchedPaths` are files the session
 * observed or wrote through its own tools; `modifiedSinceMs` admits files a
 * subprocess produced during the run. Without a scope, any pre-existing
 * `.html` in the tree — a docs page, a coverage report — becomes the newest
 * renderable and drags a headless-browser launch into every completion
 * attempt of an unrelated task.
 */
export interface DeliverableScanScope {
  readonly touchedPaths: readonly string[];
  readonly modifiedSinceMs: number;
}

export interface RenderableDeliverable {
  readonly relative: string;
  /** Contract-listed deliverables must render; scan discoveries degrade politely. */
  readonly source: "contract" | "scan";
}

const RENDERABLE = new Set([".html", ".htm", ".svg"]);
const MAX_SCAN_ENTRIES = 2_000;
const SKIP_DIRECTORIES = new Set([".git", ".vanguard", "node_modules", "dist", "coverage", "build", "out"]);

export class CreativeDirectionVerifier implements VerifierPort {
  readonly name = "creative direction";

  constructor(
    private readonly judge: ModelPort,
    private readonly workspace: WorkspaceBoundary,
    private readonly contract: TaskContract,
    private readonly renderer: DeliverableRenderer,
    private readonly scanScope?: () => DeliverableScanScope,
  ) {}

  async verify(_candidate: string, task: string): Promise<VerificationResult> {
    const direction = this.contract.creativeDirection;
    if (direction === undefined) {
      return { verifier: this.name, passed: true, evidence: "No creative direction was contracted." };
    }
    const found = await findRenderableDeliverable(this.workspace, this.contract, this.scanScope?.());
    if (found === undefined) {
      return {
        verifier: this.name,
        passed: true,
        evidence: "No renderable deliverable (.html/.svg) exists to judge; the direction was enforced by prompt and review only.",
      };
    }
    const target = found.relative;
    const controller = new AbortController();
    const context: ToolContext = { task, step: 0, signal: controller.signal };
    const rendered = await this.renderer(target, context);
    if (!rendered.ok) {
      return {
        verifier: this.name,
        passed: false,
        evidence: `The deliverable '${target}' could not reach a healthy rendered state (${snippet(rendered.output)}).`,
      };
    }

    // The judge sees the render through the transcript's ordinary tool
    // channel, so vision-capable wires attach the real pixels and text-only
    // wires get the honest omission note plus the numeric metadata.
    const transcript: TranscriptEntry[] = [
      {
        role: "decision",
        content: {
          kind: "tools",
          calls: [{ id: "judge-render", name: "artifact.render", input: { path: target } }],
        } as unknown as JsonValue,
      },
      {
        role: "observation",
        content: {
          callId: "judge-render",
          tool: "artifact.render",
          ok: true,
          output: rendered.output,
        } as unknown as JsonValue,
      },
    ];
    const judgeTask = "You are an uncompromising creative director reviewing a finished deliverable against its contracted direction.\n"
      + `Contracted creative direction: ${direction}\n`
      + `Deliverable objective: ${this.contract.objective}\n`
      + `The render above is the actual deliverable '${target}'. Judge whether it honors the direction: identity, palette, committed concept — `
      + "not correctness. Generic-but-competent violates a specific direction. Reply with exactly one line starting with "
      + "VERDICT: PASS or VERDICT: FAIL, followed by your specific reasons (name what is missing or generic).";
    let reply: string;
    try {
      const decision = await this.judge.decide({
        task: judgeTask,
        mode: "conversation",
        transcript: [{ role: "task", content: judgeTask }, ...transcript],
        tools: [],
        remainingSteps: 1,
        signal: controller.signal,
        workingState: null,
      });
      reply = decision.kind === "respond" ? decision.message : JSON.stringify(decision);
    } catch (error) {
      return {
        verifier: this.name,
        passed: true,
        evidence: `The judge model was unreachable (${error instanceof Error ? error.message : String(error)}); visual judgment was skipped.`,
      };
    }
    const passed = /VERDICT:\s*PASS/iu.test(reply) && !/VERDICT:\s*FAIL/iu.test(reply);
    return {
      verifier: this.name,
      passed,
      evidence: `Judged '${target}' against the contracted direction. ${bounded(reply, 1_200)}`,
    };
  }

}

/** Model-independent completion gate for HTML/SVG artifacts. */
export class RenderableArtifactVerifier implements VerifierPort {
  readonly name = "renderable artifact runtime";
  /** Content-addressed result reuse: an unchanged artifact renders once, not once per completion attempt. */
  readonly #rendered = new Map<string, { sha256: string; result: VerificationResult }>();

  constructor(
    private readonly workspace: WorkspaceBoundary,
    private readonly contract: TaskContract | undefined,
    private readonly renderer: DeliverableRenderer,
    private readonly scanScope?: () => DeliverableScanScope,
  ) {}

  async verify(_candidate: string, task: string): Promise<VerificationResult> {
    const target = await findRenderableDeliverable(this.workspace, this.contract, this.scanScope?.());
    if (target === undefined) {
      return { verifier: this.name, passed: true, evidence: "No HTML or SVG artifact exists; runtime render gate is not applicable." };
    }
    // Hashing only the entry file is deliberate: a changed stylesheet or
    // script beside an unchanged shell misses the cache and re-renders, never
    // the other way around, because the agent edits the entry file to wire
    // new assets in the flows this gate protects. A false re-render costs
    // seconds; a false cache hit would forge evidence.
    let sha256: string | undefined;
    try {
      sha256 = createHash("sha256").update(await readFile(await this.workspace.existing(target.relative))).digest("hex");
      const cached = this.#rendered.get(target.relative);
      if (cached !== undefined && cached.sha256 === sha256) return cached.result;
    } catch {
      // Unreadable for hashing; fall through to a real render, which reports it.
    }
    const context: ToolContext = { task, step: 0, signal: new AbortController().signal };
    const rendered = await this.renderer(target.relative, context);
    if (!rendered.ok && target.source === "scan" && isMissingBrowser(rendered.output)) {
      // A contract-listed deliverable must render; an incidental scan hit on
      // a browserless machine must not fail an unrelated task.
      return {
        verifier: this.name,
        passed: true,
        evidence: `'${target.relative}' was discovered by scan but no system browser exists to render it; the render gate was skipped, not passed.`,
      };
    }
    const result: VerificationResult = {
      verifier: this.name,
      passed: rendered.ok,
      evidence: rendered.ok
        ? `Executed '${target.relative}' in Chromium; screenshot and settled-DOM inspection passed.`
        : `Runtime rendering '${target.relative}' failed: ${snippet(rendered.output)}`,
    };
    if (sha256 !== undefined) this.#rendered.set(target.relative, { sha256, result });
    return result;
  }
}

function isMissingBrowser(output: JsonValue): boolean {
  return typeof output === "object" && output !== null && !Array.isArray(output)
    && typeof output.error === "string"
    && output.error.includes("No system Chromium-family browser");
}

/**
 * The newest renderable deliverable: contract-listed paths win, then paths the
 * session touched through its own tools, then a bounded workspace scan limited
 * to files modified during this run (a subprocess may have produced them).
 * The scan stays mtime-anchored so the gate cannot be dodged by writing the
 * artifact outside the file tools — but a scope keeps a stale, unrelated
 * `.html` elsewhere in the tree from hijacking the completion gate.
 */
export async function findRenderableDeliverable(
  workspace: WorkspaceBoundary,
  contract: TaskContract | undefined,
  scope?: DeliverableScanScope,
): Promise<RenderableDeliverable | undefined> {
  for (const deliverable of contract?.deliverables ?? []) {
    if (!RENDERABLE.has(path.extname(deliverable).toLowerCase())) continue;
    try {
      await workspace.existing(deliverable);
      return { relative: deliverable, source: "contract" };
    } catch {
      // Not on disk (yet); keep looking.
    }
  }
  let newest: { relative: string; mtimeMs: number } | undefined;
  const consider = (relative: string, mtimeMs: number): void => {
    if (newest === undefined || mtimeMs > newest.mtimeMs) {
      newest = { relative: relative.replaceAll("\\", "/"), mtimeMs };
    }
  };
  for (const touched of scope?.touchedPaths ?? []) {
    if (!RENDERABLE.has(path.extname(touched).toLowerCase())) continue;
    try {
      consider(touched, (await stat(await workspace.existing(touched))).mtimeMs);
    } catch {
      // Deleted since it was touched; ignore.
    }
  }
  let scanned = 0;
  const queue = [workspace.root];
  while (queue.length > 0 && scanned < MAX_SCAN_ENTRIES) {
    const directory = queue.shift()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      scanned += 1;
      if (scanned >= MAX_SCAN_ENTRIES) break;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) queue.push(absolute);
        continue;
      }
      if (!entry.isFile() || !RENDERABLE.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const metadata = await stat(absolute);
        if (scope !== undefined && metadata.mtimeMs < scope.modifiedSinceMs) continue;
        consider(path.relative(workspace.root, absolute), metadata.mtimeMs);
      } catch {
        // Raced deletion; ignore.
      }
    }
  }
  return newest === undefined ? undefined : { relative: newest.relative, source: "scan" };
}

function snippet(value: JsonValue): string {
  return bounded(typeof value === "string" ? value : JSON.stringify(value), 200);
}

function bounded(value: string, max: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}
