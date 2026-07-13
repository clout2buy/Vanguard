import { cp, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
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

export async function openCodingSession(location: string): Promise<CodingSession> {
  let requested = path.resolve(location);
  const metadata = await stat(requested);
  if (metadata.isFile()) requested = path.dirname(requested);
  if (path.basename(requested).toLocaleLowerCase() === "workspace") requested = path.dirname(requested);
  const metadataFile = path.join(requested, "session.json");
  const parsed = JSON.parse(await readFile(metadataFile, "utf8")) as Partial<CodingSession>;
  if (typeof parsed.id !== "string" || typeof parsed.sourceRoot !== "string" || typeof parsed.workspaceRoot !== "string") {
    throw new Error("Session metadata is malformed.");
  }
  const workspaceRoot = await realpath(parsed.workspaceRoot);
  if (path.dirname(workspaceRoot) !== await realpath(requested)) {
    throw new Error("Session workspace does not belong to the requested session container.");
  }
  return {
    id: parsed.id,
    sourceRoot: await realpath(parsed.sourceRoot),
    workspaceRoot,
    metadataFile,
  };
}
