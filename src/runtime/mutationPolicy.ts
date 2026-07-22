import path from "node:path";
import type { JsonValue, ToolResult } from "../kernel/contracts.js";
import { lowercaseInvariant } from "../deterministicText.js";

export class WorkspaceMutationPolicy {
  readonly #editableRoots: readonly string[];
  readonly #protectedPaths: readonly string[];

  constructor(editableRoots: readonly string[] = [], protectedPaths: readonly string[] = []) {
    this.#editableRoots = editableRoots.map(normalizeScope);
    this.#protectedPaths = protectedPaths.map(normalizeScope);
  }

  check(relativePath: string): ToolResult | undefined {
    const target = normalizeScope(relativePath);
    const protectedPath = this.#protectedPaths.find((scope) => contains(scope, target));
    if (protectedPath !== undefined) {
      return denied("Path is protected by the workspace mutation policy.", target, this.snapshot());
    }
    if (this.#editableRoots.length > 0 && !this.#editableRoots.some((scope) => contains(scope, target))) {
      return denied("Path is outside the declared editable roots.", target, this.snapshot());
    }
    return undefined;
  }

  snapshot(): JsonValue {
    return { editableRoots: [...this.#editableRoots], protectedPaths: [...this.#protectedPaths] };
  }

  describe(): string {
    const editable = this.#editableRoots.length === 0 ? "the entire workspace" : this.#editableRoots.join(", ");
    const protectedText = this.#protectedPaths.length === 0 ? "none" : this.#protectedPaths.join(", ");
    return `Editable roots: ${editable}. Protected paths: ${protectedText}. Use delete_file for unwanted files.`;
  }

  writableAbsoluteRoots(workspaceRoot: string): readonly string[] {
    const roots = this.#editableRoots.length === 0 ? ["."] : this.#editableRoots;
    return roots.map((root) => path.resolve(workspaceRoot, root));
  }
}

function normalizeScope(value: string): string {
  const normalized = path.normalize(value).replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  return process.platform === "win32" ? lowercaseInvariant(normalized) : normalized;
}

function contains(scope: string, target: string): boolean {
  return scope === "." || target === scope || target.startsWith(`${scope}/`);
}

function denied(error: string, pathValue: string, policy: JsonValue): ToolResult {
  return { ok: false, output: { error, path: pathValue, policy } };
}
