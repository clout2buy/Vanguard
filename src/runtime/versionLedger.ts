import path from "node:path";

export class WorkspaceVersionLedger {
  readonly #versions = new Map<string, string>();

  record(relativePath: string, sha256: string): void {
    this.#versions.set(key(relativePath), sha256);
  }

  get(relativePath: string): string | undefined {
    return this.#versions.get(key(relativePath));
  }

  forget(relativePath: string): void {
    this.#versions.delete(key(relativePath));
  }
}

function key(relativePath: string): string {
  const normalized = path.normalize(relativePath).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}
