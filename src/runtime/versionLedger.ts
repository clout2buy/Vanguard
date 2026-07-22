import path from "node:path";
import { lowercaseInvariant } from "../deterministicText.js";

export class WorkspaceVersionLedger {
  readonly #versions = new Map<string, string>();
  /** Normalized key → the caller's original relative path, for enumeration. */
  readonly #originals = new Map<string, string>();

  record(relativePath: string, sha256: string): void {
    const normalized = key(relativePath);
    this.#versions.set(normalized, sha256);
    this.#originals.set(normalized, relativePath);
  }

  get(relativePath: string): string | undefined {
    return this.#versions.get(key(relativePath));
  }

  forget(relativePath: string): void {
    const normalized = key(relativePath);
    this.#versions.delete(normalized);
    this.#originals.delete(normalized);
  }

  /** Every path this session has observed or written through the file tools. */
  paths(): readonly string[] {
    return [...this.#originals.values()];
  }
}

function key(relativePath: string): string {
  const normalized = path.normalize(relativePath).replaceAll("\\", "/");
  return process.platform === "win32" ? lowercaseInvariant(normalized) : normalized;
}
