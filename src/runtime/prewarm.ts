import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Fire-and-forget warmup of lazily-initialized heavy tools, overlapped with
 * the model's first thinking time.
 *
 * The two known cold-start cliffs are the TypeScript compiler module (loaded
 * on the first `.ts` mutation's syntax rung) and the first headless-Chromium
 * launch (multiple seconds on a cold or antivirus-scanned machine). Both are
 * pure warmups: they change no observable behavior, produce no evidence, and
 * swallow their own failures — the real call sites still report real errors.
 *
 * VANGUARD_NO_PREWARM=1 disables everything (tests and constrained hosts).
 */
export function prewarmExecutionRuntime(options: {
  readonly workspaceRoot: string;
  readonly renderTool?: { warm(): Promise<void> };
}): void {
  if (process.env.VANGUARD_NO_PREWARM === "1") return;
  void import("typescript").catch(() => undefined);
  const render = options.renderTool;
  if (render === undefined) return;
  void (async () => {
    try {
      // Launch a browser process only when this workspace plausibly renders:
      // warming Chromium under a pure backend repo would be waste, not speed.
      if (await hasRenderableArtifact(options.workspaceRoot)) await render.warm();
    } catch {
      // Warmup is opportunistic by contract.
    }
  })();
}

const RENDERABLE = new Set([".html", ".htm", ".svg"]);
const SKIP_DIRECTORIES = new Set([".git", ".vanguard", "node_modules", "dist", "coverage", "build", "out"]);
const MAX_ENTRIES = 400;
const MAX_DEPTH = 2;

/** A bounded, shallow scan: enough to spot a UI project, cheap enough to always run. */
async function hasRenderableArtifact(root: string): Promise<boolean> {
  let scanned = 0;
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  while (queue.length > 0 && scanned < MAX_ENTRIES) {
    const { directory, depth } = queue.shift()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      scanned += 1;
      if (scanned >= MAX_ENTRIES) break;
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRECTORIES.has(entry.name)) {
          queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
        }
        continue;
      }
      if (entry.isFile() && RENDERABLE.has(path.extname(entry.name).toLowerCase())) return true;
    }
  }
  return false;
}
