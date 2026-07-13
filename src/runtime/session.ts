import { cp, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CodingSession {
  readonly id: string;
  readonly sourceRoot: string;
  readonly workspaceRoot: string;
  readonly metadataFile: string;
  /** Whether the disposable workspace copy exists yet. */
  readonly materialized: boolean;
}

const EXCLUDED_DIRECTORIES = new Set([".git", ".vanguard", "node_modules"]);

export async function createCodingSession(source: string): Promise<CodingSession> {
  return materializeSessionWorkspace(await createSessionShell(source));
}

/**
 * Creates the durable session container (journal home, metadata) without
 * copying the project. Conversation happens against the read-only original;
 * the disposable workspace copy is created only when a task contract exists.
 */
export async function createSessionShell(source: string): Promise<CodingSession> {
  const sourceRoot = await realpath(path.resolve(source));
  if (!(await stat(sourceRoot)).isDirectory()) throw new Error("Workspace must be a directory.");
  const container = await mkdtemp(path.join(os.tmpdir(), "vanguard-session-"));
  const workspaceRoot = path.join(container, "workspace");
  const id = path.basename(container);
  const metadataFile = path.join(container, "session.json");
  const session: CodingSession = { id, sourceRoot, workspaceRoot, metadataFile, materialized: false };
  await writeSessionMetadata(session);
  return session;
}

/** Copies the original project into the disposable workspace. Idempotent. */
export async function materializeSessionWorkspace(session: CodingSession): Promise<CodingSession> {
  if (session.materialized) return session;
  await cp(session.sourceRoot, session.workspaceRoot, {
    recursive: true,
    filter: (candidate) => candidate === session.sourceRoot || !EXCLUDED_DIRECTORIES.has(path.basename(candidate)),
  });
  const materialized: CodingSession = { ...session, materialized: true };
  await writeSessionMetadata(materialized);
  return materialized;
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
  const materialized = parsed.materialized !== false;
  const workspaceRoot = materialized ? await realpath(parsed.workspaceRoot) : path.join(await realpath(requested), "workspace");
  if (path.dirname(workspaceRoot) !== await realpath(requested)) {
    throw new Error("Session workspace does not belong to the requested session container.");
  }
  return {
    id: parsed.id,
    sourceRoot: await realpath(parsed.sourceRoot),
    workspaceRoot,
    metadataFile,
    materialized,
  };
}

async function writeSessionMetadata(session: CodingSession): Promise<void> {
  await writeFile(session.metadataFile, JSON.stringify({
    id: session.id,
    sourceRoot: session.sourceRoot,
    workspaceRoot: session.workspaceRoot,
    materialized: session.materialized,
    createdAt: new Date().toISOString(),
  }, null, 2));
}
