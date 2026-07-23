import { realpathSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

export class WorkspaceBoundary {
  readonly root: string;

  constructor(root: string) {
    this.root = realpathSync.native(path.resolve(root));
  }

  lexical(relativePath: string): string {
    if (relativePath.length === 0) {
      throw new Error("Workspace paths must be non-empty.");
    }
    if (path.isAbsolute(relativePath)) {
      // Models routinely echo the absolute spelling of an in-workspace path
      // (Desktop workspaces especially). A contained absolute is the same
      // file — accept it; anything outside the boundary still throws.
      const absolute = path.resolve(relativePath);
      this.#assertContained(absolute);
      return absolute;
    }
    const candidate = path.resolve(this.root, relativePath);
    this.#assertContained(candidate);
    return candidate;
  }

  async existing(relativePath: string): Promise<string> {
    const candidate = this.lexical(relativePath);
    const resolved = await realpath(candidate);
    this.#assertContained(resolved);
    return resolved;
  }

  async writable(relativePath: string): Promise<string> {
    const candidate = this.lexical(relativePath);
    let ancestor = path.dirname(candidate);

    while (true) {
      try {
        await lstat(ancestor);
        break;
      } catch (error) {
        if (!isMissing(error)) throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw new Error("No existing workspace ancestor.");
        ancestor = parent;
      }
    }

    const resolvedAncestor = await realpath(ancestor);
    this.#assertContained(resolvedAncestor);
    await mkdir(path.dirname(candidate), { recursive: true });
    return candidate;
  }

  /**
   * The workspace-relative spelling of a requested path. Contained absolutes
   * relativize so version ledgers and policy checks key one spelling per
   * file; relative requests pass through untouched.
   */
  relativize(requested: string): string {
    if (requested.length === 0 || !path.isAbsolute(requested)) return requested;
    const absolute = path.resolve(requested);
    this.#assertContained(absolute);
    const relative = path.relative(this.root, absolute);
    return relative === "" ? "." : relative;
  }

  #assertContained(candidate: string): void {
    const relative = path.relative(this.root, candidate);
    if (relative === "") return;
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new Error(`Path escapes workspace: ${candidate}`);
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

