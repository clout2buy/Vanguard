import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export interface PatchMetrics {
  readonly changedFiles: readonly string[];
  readonly filesAdded: number;
  readonly filesDeleted: number;
  readonly filesModified: number;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly beforeLines: number;
  readonly afterLines: number;
}

const IGNORED = new Set([".git", ".vanguard", "node_modules", "dist", "coverage"]);

export async function analyzePatch(sourceRoot: string, workspaceRoot: string): Promise<PatchMetrics> {
  const [before, after] = await Promise.all([files(sourceRoot), files(workspaceRoot)]);
  const changedFiles = [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => !buffersEqual(before.get(file), after.get(file)))
    .sort();
  let filesAdded = 0; let filesDeleted = 0; let filesModified = 0;
  let beforeBytes = 0; let afterBytes = 0; let beforeLines = 0; let afterLines = 0;
  for (const file of changedFiles) {
    const oldValue = before.get(file); const newValue = after.get(file);
    if (oldValue === undefined) filesAdded += 1;
    else if (newValue === undefined) filesDeleted += 1;
    else filesModified += 1;
    beforeBytes += oldValue?.length ?? 0; afterBytes += newValue?.length ?? 0;
    beforeLines += textLines(oldValue); afterLines += textLines(newValue);
  }
  return { changedFiles, filesAdded, filesDeleted, filesModified, beforeBytes, afterBytes, beforeLines, afterLines };
}

async function files(root: string): Promise<Map<string, Buffer>> {
  const resolved = await realpath(root); const result = new Map<string, Buffer>(); const queue = [resolved];
  while (queue.length) {
    const directory = queue.shift()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (!IGNORED.has(entry.name)) queue.push(absolute); continue; }
      if (entry.isFile()) result.set(path.relative(resolved, absolute).replaceAll("\\", "/"), await readFile(absolute));
    }
  }
  return result;
}

function buffersEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}

function textLines(value: Buffer | undefined): number {
  if (value === undefined || value.includes(0)) return 0;
  const text = value.toString("utf8");
  return text.length === 0 ? 0 : text.split(/\r?\n/u).length;
}
