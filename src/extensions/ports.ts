import type { JsonValue, ModelPort, VerificationResult, VerifierPort } from "../kernel/contracts.js";
import type { RepositoryModel } from "../runtime/repositoryModel.js";
import { compareOrdinal } from "../deterministicText.js";

export interface ExtensionIdentity {
  readonly name: string;
  readonly version: string;
  readonly provenance: string;
}

/** Wire-neutral model factory: implementations own HTTP, not Vanguard SDKs. */
export interface ProviderAdapterExtension extends ExtensionIdentity {
  readonly kind: "provider";
  create(configuration: Readonly<Record<string, JsonValue>>): ModelPort;
}

export interface RepositoryDetectorExtension extends ExtensionIdentity {
  readonly kind: "repository-detector";
  detect(root: string, signal: AbortSignal): Promise<Partial<RepositoryModel>>;
}

export interface VerifierExtension extends ExtensionIdentity {
  readonly kind: "verifier";
  create(configuration: Readonly<Record<string, JsonValue>>): VerifierPort;
}

export interface ReviewCandidate {
  readonly sourceRoot: string;
  readonly workspaceRoot: string;
  readonly task: string;
  readonly verification: readonly VerificationResult[];
}

export interface ReviewResult {
  readonly reviewer: string;
  readonly passed: boolean;
  readonly findings: readonly { readonly severity: "info" | "warning" | "error"; readonly message: string; readonly file?: string }[];
}

export interface ReviewerExtension extends ExtensionIdentity {
  readonly kind: "reviewer";
  review(candidate: ReviewCandidate, signal: AbortSignal): Promise<ReviewResult>;
}

export type VanguardExtension =
  | ProviderAdapterExtension
  | RepositoryDetectorExtension
  | VerifierExtension
  | ReviewerExtension;

export interface ExtensionRegistryEntry {
  readonly kind: VanguardExtension["kind"];
  readonly name: string;
  readonly version: string;
  readonly provenance: string;
}

/** Registration only; loading/importing extensions remains an explicit host action. */
export class VanguardExtensionRegistry {
  readonly #entries = new Map<string, VanguardExtension>();

  register(extension: VanguardExtension): void {
    assertIdentity(extension);
    const key = `${extension.kind}:${extension.name}`;
    if (this.#entries.has(key)) throw new Error(`Extension '${key}' is already registered.`);
    this.#entries.set(key, extension);
  }

  get<T extends VanguardExtension["kind"]>(kind: T, name: string): Extract<VanguardExtension, { kind: T }> | undefined {
    return this.#entries.get(`${kind}:${name}`) as Extract<VanguardExtension, { kind: T }> | undefined;
  }

  manifest(): readonly ExtensionRegistryEntry[] {
    return [...this.#entries.values()]
      .map(({ kind, name, version, provenance }) => ({ kind, name, version, provenance }))
      .sort((left, right) => compareOrdinal(`${left.kind}:${left.name}`, `${right.kind}:${right.name}`));
  }
}

function assertIdentity(extension: VanguardExtension): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(extension.name)) throw new Error("Extension name is invalid.");
  if (!/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(extension.version)) throw new Error("Extension version must be semantic.");
  if (extension.provenance.trim().length === 0) throw new Error("Extension provenance is required.");
}
