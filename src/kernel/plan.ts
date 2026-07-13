import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  JsonValue,
  PlanStatusPort,
  RunEvent,
  TaskContract,
  ToolContext,
  ToolDefinition,
  ToolPort,
  ToolResult,
} from "./contracts.js";
import { PLAN_TOOL_NAME } from "./contracts.js";
import { durableStateSha256, type DurableStateAnchorRequirement } from "./durableState.js";

export type MilestoneStatus = "pending" | "active" | "blocked" | "proven" | "invalidated";
export type EvidenceKind = "tool" | "verification" | "user";

/** A model claim. The runtime resolves it to one exact successful event. */
export interface EvidenceClaim {
  readonly kind: EvidenceKind;
  readonly sequence?: number;
  readonly callId?: string;
  readonly tool?: string;
  readonly verifier?: string;
  readonly exactText?: string;
}

/** Canonical, runtime-bound evidence persisted in the plan. */
export interface EvidenceRef extends EvidenceClaim {
  readonly sequence: number;
  readonly sha256: string;
}

export interface PlanInvalidation {
  readonly reason: string;
  readonly supersededBy: string;
  readonly evidence: EvidenceRef & { readonly kind: "user" };
}

export interface PlanMilestone {
  readonly id: string;
  readonly title: string;
  readonly acceptanceCriteria: readonly string[];
  readonly dependsOn: readonly string[];
  /** Stable task-contract criterion IDs owned by this milestone. */
  readonly covers: readonly string[];
  readonly status: MilestoneStatus;
  readonly evidence: readonly EvidenceRef[];
  readonly scope: readonly string[];
  readonly note?: string;
  readonly invalidation?: PlanInvalidation;
}

export interface PlanRevision {
  readonly revision: number;
  readonly summary: string;
  readonly at: string;
}

export interface PlanState {
  readonly revision: number;
  readonly requiredCriteria: readonly string[];
  readonly milestones: readonly PlanMilestone[];
  readonly history: readonly PlanRevision[];
}

export interface EvidenceResolverPort {
  resolve(claim: EvidenceClaim): Promise<EvidenceRef | undefined>;
}

interface JournalReader {
  readValidated(): Promise<readonly RunEvent[]>;
}

/** Resolves claims only against successful, hash-chained journal events. */
export class JournalEvidenceResolver implements EvidenceResolverPort {
  constructor(private readonly journal: JournalReader) {}

  async resolve(claim: EvidenceClaim): Promise<EvidenceRef | undefined> {
    const events = await this.journal.readValidated();
    const latestUser = [...events].reverse().find((event) => event.type === "user.message");
    const candidates = claim.sequence === undefined
      ? [...events].reverse()
      : events.filter((event) => event.sequence === claim.sequence);
    for (const event of candidates) {
      const data = record(event.data);
      if (claim.kind === "tool") {
        if (event.type !== "tool.completed" || data?.ok === false) continue;
        if (typeof claim.callId !== "string" || data?.callId !== claim.callId) continue;
        if (typeof claim.tool !== "string" || data?.tool !== claim.tool) continue;
        return canonicalEvidence(claim, event);
      }
      if (claim.kind === "verification") {
        if (event.type !== "verification.completed" || data?.passed !== true) continue;
        if (typeof claim.verifier !== "string" || data?.verifier !== claim.verifier) continue;
        return canonicalEvidence(claim, event);
      }
      if (claim.kind === "user") {
        // Requirement invalidation is authorized only by the most recent
        // exact user message, not by an arbitrary old conversation fragment.
        if (event !== latestUser || typeof claim.exactText !== "string") continue;
        if (record(event.data)?.text !== claim.exactText) continue;
        return canonicalEvidence(claim, event) as EvidenceRef & { kind: "user" };
      }
    }
    return undefined;
  }
}

const MILESTONE_STATUSES: readonly MilestoneStatus[] = ["pending", "active", "blocked", "proven", "invalidated"];

export function contractCriterionIds(contract: TaskContract): readonly string[] {
  return [
    ...contract.successCriteria.map((_criterion, index) => `success-${index + 1}`),
    ...(contract.requiredVerification ?? []).map((_criterion, index) => `verification-${index + 1}`),
    ...(contract.deliverables ?? []).map((_criterion, index) => `deliverable-${index + 1}`),
  ];
}

/** Runtime-owned durable plan with monotonic, non-weakening revisions. */
export class PlanLedger implements PlanStatusPort {
  #state: PlanState | undefined;
  readonly #file: string | undefined;
  readonly #requiredCriteria: readonly string[];

  constructor(initial?: PlanState, file?: string, requiredCriteria: readonly string[] = []) {
    this.#state = initial;
    this.#file = file;
    this.#requiredCriteria = initial?.requiredCriteria ?? uniqueStrings(requiredCriteria, "required criteria", 100);
  }

  static async open(
    file: string,
    requiredCriteria: readonly string[] = [],
    evidenceResolver?: EvidenceResolverPort,
    anchor?: DurableStateAnchorRequirement,
  ): Promise<PlanLedger> {
    const absolute = path.resolve(file);
    try {
      const parsed = JSON.parse(await readFile(absolute, "utf8")) as unknown;
      const state = migratePersistedPlan(parsed, requiredCriteria);
      validatePlanState(state);
      const actualSha256 = planStateSha256(state);
      if (anchor?.required === true && anchor.expectedSha256 === undefined) {
        throw new Error("Persisted plan has no committed journal anchor.");
      }
      if (anchor?.expectedSha256 !== undefined && actualSha256 !== anchor.expectedSha256) {
        throw new Error("Persisted plan does not match its committed journal anchor.");
      }
      if (evidenceResolver !== undefined) await validatePersistedEvidence(state, evidenceResolver);
      const requested = uniqueStrings(requiredCriteria, "required criteria", 100);
      if (requested.length > 0 && JSON.stringify(requested) !== JSON.stringify(state.requiredCriteria)) {
        throw new Error("Persisted plan criterion IDs do not match the contracted task.");
      }
      return new PlanLedger(state, absolute);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (anchor?.expectedSha256 !== undefined) throw new Error("Committed plan state is missing from disk.");
      return new PlanLedger(undefined, absolute, requiredCriteria);
    }
  }

  isEmpty(): boolean {
    return this.#state === undefined;
  }

  unproven(): readonly string[] {
    if (this.#state === undefined) return [];
    return this.#state.milestones
      .filter((milestone) => milestone.status !== "proven" && milestone.status !== "invalidated")
      .map((milestone) => `${milestone.id} — ${milestone.title}`);
  }

  requiredCriteria(): readonly string[] {
    return this.#requiredCriteria;
  }

  state(): PlanState | undefined {
    return this.#state;
  }

  snapshot(): JsonValue {
    if (this.#state === undefined) {
      return { requiredCriteria: [...this.#requiredCriteria], revision: 0, milestones: [] };
    }
    return {
      revision: this.#state.revision,
      requiredCriteria: [...this.#state.requiredCriteria],
      milestones: this.#state.milestones.map((milestone) => ({
        id: milestone.id,
        title: milestone.title,
        status: milestone.status,
        acceptanceCriteria: [...milestone.acceptanceCriteria],
        dependsOn: [...milestone.dependsOn],
        covers: [...milestone.covers],
        evidence: milestone.evidence.map((evidence) => ({ ...evidence })),
        scope: [...milestone.scope],
        ...(milestone.note === undefined ? {} : { note: milestone.note }),
        ...(milestone.invalidation === undefined ? {} : { invalidation: milestone.invalidation }),
      })),
    } as unknown as JsonValue;
  }

  async update(summary: string, milestones: readonly PlanMilestone[]): Promise<PlanState> {
    const revision = (this.#state?.revision ?? 0) + 1;
    const history = [
      ...(this.#state?.history ?? []),
      { revision, summary, at: new Date().toISOString() },
    ].slice(-100);
    const next: PlanState = {
      revision,
      requiredCriteria: this.#requiredCriteria,
      milestones,
      history,
    };
    validatePlanState(next);
    validateRevision(this.#state, next);
    if (this.#file !== undefined) await atomicJsonWrite(this.#file, next);
    this.#state = next;
    return next;
  }
}

export class PlanTool implements ToolPort {
  readonly name = PLAN_TOOL_NAME;
  readonly definition: ToolDefinition;

  constructor(
    private readonly ledger: PlanLedger,
    private readonly evidenceResolver?: EvidenceResolverPort,
  ) {
    const criteria = ledger.requiredCriteria();
    this.definition = {
      name: this.name,
      description: "Establish or revise the durable engineering plan. Revisions are monotonic: never delete or weaken a milestone. Proven milestones require runtime-bound successful tool/verifier evidence. Invalidations require the latest exact user message and a superseding milestone."
        + (criteria.length === 0 ? "" : ` Contract criterion IDs that must be covered exactly: ${criteria.join(", ")}.`),
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          milestones: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                acceptanceCriteria: { type: "array", items: { type: "string" } },
                dependsOn: { type: "array", items: { type: "string" } },
                covers: { type: "array", items: { type: "string" } },
                status: { type: "string", enum: [...MILESTONE_STATUSES] },
                evidence: { type: "array", items: evidenceSchema() },
                scope: { type: "array", items: { type: "string" } },
                note: { type: "string" },
                invalidation: {
                  type: "object",
                  properties: {
                    reason: { type: "string" },
                    supersededBy: { type: "string" },
                    evidence: evidenceSchema(),
                  },
                  required: ["reason", "supersededBy", "evidence"],
                  additionalProperties: false,
                },
              },
              required: ["id", "title", "acceptanceCriteria", "dependsOn", "covers", "status", "evidence", "scope"],
              additionalProperties: false,
            },
          },
        },
        required: ["summary", "milestones"],
        additionalProperties: false,
      },
      effect: "state",
    };
  }

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    if (input === null || Array.isArray(input) || typeof input !== "object") {
      throw new Error("Plan input must be an object.");
    }
    const summary = input.summary;
    if (typeof summary !== "string" || summary.length === 0 || summary.length > 2_000) {
      throw new Error("Plan summary must contain 1 to 2,000 characters.");
    }
    if (!Array.isArray(input.milestones)) throw new Error("Plan milestones must be an array.");
    const drafts = input.milestones.map(parseMilestoneDraft);
    const milestones: PlanMilestone[] = [];
    for (const draft of drafts) {
      const evidence = await this.#resolveAll(draft.evidence, draft.id);
      const invalidation = draft.invalidation === undefined
        ? undefined
        : {
            reason: draft.invalidation.reason,
            supersededBy: draft.invalidation.supersededBy,
            evidence: await this.#resolveUser(draft.invalidation.evidence, draft.id),
          };
      const { evidence: _claims, invalidation: _invalidationClaim, ...base } = draft;
      milestones.push({
        ...base,
        evidence,
        ...(invalidation === undefined ? {} : { invalidation }),
      });
    }
    const state = await this.ledger.update(summary, milestones);
    return {
      ok: true,
      output: {
        revision: state.revision,
        stateSha256: planStateSha256(state),
        milestones: state.milestones.length,
        unproven: [...this.ledger.unproven()],
      },
    };
  }

  async #resolveAll(claims: readonly EvidenceClaim[], milestone: string): Promise<readonly EvidenceRef[]> {
    const resolved: EvidenceRef[] = [];
    for (const claim of claims) {
      const reference = await this.evidenceResolver?.resolve(claim);
      if (reference === undefined) {
        throw new Error(`Milestone '${milestone}' cites evidence that does not resolve to a successful journal event.`);
      }
      resolved.push(reference);
    }
    return resolved;
  }

  async #resolveUser(claim: EvidenceClaim, milestone: string): Promise<EvidenceRef & { kind: "user" }> {
    if (claim.kind !== "user") throw new Error(`Milestone '${milestone}' invalidation requires user evidence.`);
    const reference = await this.evidenceResolver?.resolve(claim);
    if (reference?.kind !== "user") {
      throw new Error(`Milestone '${milestone}' invalidation does not match the latest exact user message.`);
    }
    return reference as EvidenceRef & { kind: "user" };
  }
}

export function planStateSha256(state: PlanState): string {
  return durableStateSha256(state as unknown as JsonValue);
}

interface MilestoneDraft extends Omit<PlanMilestone, "evidence" | "invalidation"> {
  readonly evidence: readonly EvidenceClaim[];
  readonly invalidation?: { readonly reason: string; readonly supersededBy: string; readonly evidence: EvidenceClaim };
}

function parseMilestoneDraft(value: JsonValue): MilestoneDraft {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Each milestone must be an object.");
  }
  const id = expectBoundedString(value.id, "id", 64);
  const status = value.status;
  if (!MILESTONE_STATUSES.includes(status as MilestoneStatus)) {
    throw new Error(`Milestone '${id}' has an invalid status.`);
  }
  const invalidationValue = value.invalidation;
  const invalidation = invalidationValue === undefined
    ? undefined
    : parseInvalidation(invalidationValue, id);
  return {
    id,
    title: expectBoundedString(value.title, "title", 300),
    acceptanceCriteria: stringList(value.acceptanceCriteria, `${id}.acceptanceCriteria`),
    dependsOn: stringList(value.dependsOn, `${id}.dependsOn`),
    covers: stringList(value.covers, `${id}.covers`),
    status: status as MilestoneStatus,
    evidence: evidenceClaims(value.evidence, `${id}.evidence`),
    scope: stringList(value.scope, `${id}.scope`),
    ...(typeof value.note === "string" && value.note.length > 0 ? { note: value.note.slice(0, 1_000) } : {}),
    ...(invalidation === undefined ? {} : { invalidation }),
  };
}

function parseInvalidation(value: JsonValue, id: string): NonNullable<MilestoneDraft["invalidation"]> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Milestone '${id}' invalidation must be an object.`);
  }
  return {
    reason: expectBoundedString(value.reason, `${id}.invalidation.reason`, 1_000),
    supersededBy: expectBoundedString(value.supersededBy, `${id}.invalidation.supersededBy`, 64),
    evidence: evidenceClaim(value.evidence, `${id}.invalidation.evidence`),
  };
}

function validatePlanState(state: PlanState): void {
  if (!Number.isSafeInteger(state.revision) || state.revision < 1) throw new Error("Persisted plan is malformed.");
  if (!Array.isArray(state.milestones) || state.milestones.length < 1 || state.milestones.length > 24) {
    throw new Error("A materialized plan holds between 1 and 24 milestones.");
  }
  const required = new Set(uniqueStrings(state.requiredCriteria, "required criteria", 100));
  const covered = new Set<string>();
  const ids = new Set<string>();
  for (const milestone of state.milestones) {
    if (ids.has(milestone.id)) throw new Error(`Milestone id '${milestone.id}' is duplicated.`);
    ids.add(milestone.id);
    for (const criterion of milestone.covers) {
      if (!required.has(criterion)) throw new Error(`Milestone '${milestone.id}' covers unknown criterion '${criterion}'.`);
      covered.add(criterion);
    }
    if (milestone.status === "proven") {
      if (milestone.evidence.length === 0
        || !milestone.evidence.some((evidence: EvidenceRef) => evidence.kind === "tool" || evidence.kind === "verification")) {
        throw new Error(`Milestone '${milestone.id}' cannot be proven without successful executable evidence.`);
      }
    }
    if (milestone.status === "invalidated" && milestone.invalidation === undefined) {
      throw new Error(`Milestone '${milestone.id}' cannot be invalidated without user evidence and a superseding milestone.`);
    }
    if (milestone.status !== "invalidated" && milestone.invalidation !== undefined) {
      throw new Error(`Milestone '${milestone.id}' carries invalidation data but is not invalidated.`);
    }
  }
  for (const criterion of required) {
    if (!covered.has(criterion)) throw new Error(`Contract criterion '${criterion}' is not covered by any milestone.`);
  }
  for (const milestone of state.milestones) {
    for (const dependency of milestone.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Milestone '${milestone.id}' depends on unknown milestone '${dependency}'.`);
    }
    if (milestone.invalidation !== undefined) {
      const superseding = state.milestones.find((candidate) => candidate.id === milestone.invalidation!.supersededBy);
      if (superseding === undefined || superseding.status === "invalidated" || superseding.id === milestone.id) {
        throw new Error(`Milestone '${milestone.id}' has no active superseding milestone.`);
      }
    }
  }
  assertAcyclic(state.milestones);
}

function validateRevision(previous: PlanState | undefined, next: PlanState): void {
  if (previous === undefined) return;
  const nextById = new Map(next.milestones.map((milestone) => [milestone.id, milestone]));
  for (const prior of previous.milestones) {
    const current = nextById.get(prior.id);
    if (current === undefined) throw new Error(`Plan revision cannot delete milestone '${prior.id}'.`);
    for (const field of ["title", "acceptanceCriteria", "dependsOn", "covers", "scope"] as const) {
      if (JSON.stringify(prior[field]) !== JSON.stringify(current[field])) {
        throw new Error(`Plan revision cannot weaken or rewrite '${prior.id}.${field}'. Add a superseding milestone instead.`);
      }
    }
    if ((prior.status === "proven" || prior.status === "invalidated") && current.status !== prior.status) {
      throw new Error(`Terminal milestone '${prior.id}' cannot move back from ${prior.status}.`);
    }
    if (prior.status === "proven"
      && JSON.stringify(prior.evidence) !== JSON.stringify(current.evidence)) {
      throw new Error(`Proven milestone '${prior.id}' evidence is immutable.`);
    }
  }
}

async function validatePersistedEvidence(
  state: PlanState,
  resolver: EvidenceResolverPort,
): Promise<void> {
  for (const milestone of state.milestones) {
    for (const reference of milestone.evidence) {
      const resolved = await resolver.resolve(reference);
      if (resolved === undefined || !sameEvidence(reference, resolved)) {
        throw new Error(`Persisted plan evidence integrity failure in milestone '${milestone.id}'.`);
      }
    }
    if (milestone.invalidation !== undefined) {
      const resolved = await resolver.resolve(milestone.invalidation.evidence);
      if (resolved === undefined || !sameEvidence(milestone.invalidation.evidence, resolved)) {
        throw new Error(`Persisted plan invalidation integrity failure in milestone '${milestone.id}'.`);
      }
    }
  }
}

function sameEvidence(left: EvidenceRef, right: EvidenceRef): boolean {
  return left.kind === right.kind
    && left.sequence === right.sequence
    && left.sha256 === right.sha256
    && left.callId === right.callId
    && left.tool === right.tool
    && left.verifier === right.verifier
    && left.exactText === right.exactText;
}

function assertAcyclic(milestones: readonly PlanMilestone[]): void {
  const byId = new Map(milestones.map((milestone) => [milestone.id, milestone]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Plan dependency cycle includes '${id}'.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const milestone of milestones) visit(milestone.id);
}

function evidenceSchema(): JsonValue {
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["tool", "verification", "user"] },
      sequence: { type: "integer", minimum: 1 },
      callId: { type: "string" },
      tool: { type: "string" },
      verifier: { type: "string" },
      exactText: { type: "string" },
      sha256: { type: "string" },
    },
    required: ["kind"],
    additionalProperties: false,
  };
}

function evidenceClaims(value: JsonValue | undefined, name: string): readonly EvidenceClaim[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error(`Plan '${name}' must be an array of at most 20 evidence claims.`);
  return value.map((item, index) => evidenceClaim(item, `${name}[${index}]`));
}

function evidenceClaim(value: JsonValue | undefined, name: string): EvidenceClaim {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Plan '${name}' must be a structured evidence object.`);
  }
  if (value.kind !== "tool" && value.kind !== "verification" && value.kind !== "user") {
    throw new Error(`Plan '${name}' has an invalid evidence kind.`);
  }
  const optional = (field: "callId" | "tool" | "verifier" | "exactText"): string | undefined => {
    const item = value[field];
    if (item === undefined) return undefined;
    if (typeof item !== "string" || item.length === 0 || item.length > 4_000) {
      throw new Error(`Plan '${name}.${field}' must be a bounded string.`);
    }
    return item;
  };
  const sequence = value.sequence;
  if (sequence !== undefined && (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1)) {
    throw new Error(`Plan '${name}.sequence' must be a positive integer.`);
  }
  const callId = optional("callId");
  const tool = optional("tool");
  const verifier = optional("verifier");
  const exactText = optional("exactText");
  return {
    kind: value.kind,
    ...(typeof sequence === "number" ? { sequence } : {}),
    ...(callId === undefined ? {} : { callId }),
    ...(tool === undefined ? {} : { tool }),
    ...(verifier === undefined ? {} : { verifier }),
    ...(exactText === undefined ? {} : { exactText }),
  };
}

function canonicalEvidence(claim: EvidenceClaim, event: RunEvent): EvidenceRef {
  return {
    ...claim,
    sequence: event.sequence,
    sha256: createHash("sha256").update(JSON.stringify({
      sequence: event.sequence,
      type: event.type,
      data: event.data,
    })).digest("hex"),
  };
}

function migratePersistedPlan(value: unknown, requestedCriteria: readonly string[]): PlanState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Persisted plan is malformed.");
  const state = value as Partial<PlanState> & { milestones?: unknown[] };
  const requiredCriteria = Array.isArray(state.requiredCriteria)
    ? uniqueStrings(state.requiredCriteria, "required criteria", 100)
    : uniqueStrings(requestedCriteria, "required criteria", 100);
  const milestones = Array.isArray(state.milestones) ? state.milestones.map((raw: unknown) => {
    const item = raw as Partial<PlanMilestone> & { evidence?: unknown[] };
    const legacyEvidence = !Array.isArray(item.evidence)
      || item.evidence.some((evidence: unknown) => typeof evidence === "string");
    const legacyInvalidation = item.status === "invalidated" && item.invalidation === undefined;
    return {
      ...item,
      covers: Array.isArray(item.covers) ? item.covers : [],
      evidence: legacyEvidence ? [] : item.evidence,
      status: legacyEvidence && item.status === "proven" || legacyInvalidation ? "active" : item.status,
      ...(legacyEvidence || legacyInvalidation
        ? { note: `${item.note ?? ""}${item.note ? " " : ""}Legacy unbound evidence was rejected during migration.` }
        : {}),
    } as PlanMilestone;
  }) : [];
  return {
    revision: state.revision as number,
    requiredCriteria,
    milestones,
    history: Array.isArray(state.history) ? state.history : [],
  };
}

function expectBoundedString(value: JsonValue | undefined, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`Milestone ${name} must contain 1 to ${max} characters.`);
  }
  return value;
}

function stringList(value: JsonValue | undefined, name: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`Plan '${name}' must be an array.`);
  return uniqueStrings(value, name, 50);
}

function uniqueStrings(value: readonly unknown[], name: string, maxItems: number): readonly string[] {
  if (value.length > maxItems || !value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 1_000)) {
    throw new Error(`Plan '${name}' must contain at most ${maxItems} unique bounded strings.`);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) throw new Error(`Plan '${name}' cannot contain duplicates.`);
  return [...result];
}

async function atomicJsonWrite(file: string, state: PlanState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
