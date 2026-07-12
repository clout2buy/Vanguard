import { cp, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CodingSession {
  readonly id: string;
  readonly sourceRoot: string;
  readonly workspaceRoot: string;
  readonly metadataFile: string;
}

const EXCLUDED_DIRECTORIES = new Set([".git", ".vanguard", "node_modules"]);

export async function createCodingSession(source: string): Promise<CodingSession> {
  const sourceRoot = await realpath(path.resolve(source));
  const container = await mkdtemp(path.join(os.tmpdir(), "vanguard-session-"));
  const workspaceRoot = path.join(container, "workspace");
  await cp(sourceRoot, workspaceRoot, {
    recursive: true,
    filter: (candidate) => candidate === sourceRoot || !EXCLUDED_DIRECTORIES.has(path.basename(candidate)),
  });
  const id = path.basename(container);
  const metadataFile = path.join(container, "session.json");
  await writeFile(metadataFile, JSON.stringify({ id, sourceRoot, workspaceRoot, createdAt: new Date().toISOString() }, null, 2));
  return { id, sourceRoot, workspaceRoot, metadataFile };
}

