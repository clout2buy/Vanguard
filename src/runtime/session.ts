import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readlink, readdir, readFile, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asciiLowercase, compareOrdinal } from "../deterministicText.js";
import {
  SESSION_EXCLUDED_DIRECTORIES,
  atomicWriteJson,
  createFsLimiter,
  readTreeSnapshot,
  snapshotTree,
  type TreeSnapshot,
} from "./treeSnapshot.js";

/**
 * Where session containers live. The OS temp directory was the original home,
 * and it silently destroyed "durable" journals on every disk cleanup — a
 * resumable session store must survive reboots. Overridable for tests and
 * portable runtimes via VANGUARD_SESSIONS_DIR.
 */
async function sessionContainer(): Promise<string> {
  const configured = process.env.VANGUARD_SESSIONS_DIR;
  const home = os.homedir();
  const parent = configured !== undefined && configured !== ""
    ? configured
    : home === "" ? os.tmpdir() : path.join(home, ".vanguard", "sessions");
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, "vanguard-session-"));
}

export interface SessionLineage {
  readonly parentSessionId: string;
  readonly parentCheckpointId: string;
  readonly parentJournalHash: string;
}

export interface CodingSession {
  readonly id: string;
  readonly sourceRoot: string;
  readonly workspaceRoot: string;
  readonly metadataFile: string;
  readonly baselineFile: string;
  /** Whether the disposable workspace copy exists yet. */
  readonly materialized: boolean;
  /** Source-tree fingerprint captured when the session began. */
  readonly sourceFingerprint?: string;
  /** True when the original project changed between conversation and copy. */
  readonly sourceChangedDuringConversation?: boolean;
  /** Genesis hash used by a forked journal; absent for root sessions. */
  readonly journalGenesisHash?: string;
  /** Cryptographic branch point for forked sessions. */
  readonly lineage?: SessionLineage;
  /**
   * In-place sessions edit the real project directly: workspaceRoot is the
   * source tree and the session-container copy becomes the pristine baseline
   * for review, drift detection, and undo. Persisted metadata always stores
   * the canonical container workspace path; the flip happens at open time.
   */
  readonly inPlace?: true;
  /** Pristine baseline copy for in-place sessions. */
  readonly pristineRoot?: string;
  /**
   * Direct sessions edit the real project with no ceremony at all: no source
   * fingerprint, no pristine copy, no baseline snapshot. The session container
   * still holds the journal, plan, and checkpoints — none of which touch the
   * project tree — but review/apply/undo and time travel have nothing to diff
   * against and are refused. Version control is the user's safety net.
   */
  readonly direct?: true;
  readonly createdAt: string;
}

export interface CreateSessionOptions {
  readonly inPlace?: boolean;
  /** Implies inPlace; skips fingerprints, copies, and baselines entirely. */
  readonly direct?: boolean;
}

export interface MaterializeSessionWorkspaceOptions {
  /**
   * Narrow injection seam for deterministic filesystem-race tests. Production
   * callers should use the default copier by omitting this option.
   * @internal
   */
  readonly copyWorkspace?: (sourceRoot: string, destinationRoot: string) => Promise<void>;
}

export async function createCodingSession(source: string, options: CreateSessionOptions = {}): Promise<CodingSession> {
  return materializeSessionWorkspace(await createSessionShell(source, options));
}

/**
 * Creates the durable session container (journal home, metadata) without
 * copying the project. Conversation happens against the read-only original;
 * the disposable workspace copy is created only when a task contract exists.
 */
export async function createSessionShell(source: string, options: CreateSessionOptions = {}): Promise<CodingSession> {
  const sourceRoot = await realpath(path.resolve(source));
  if (!(await stat(sourceRoot)).isDirectory()) throw new Error("Workspace must be a directory.");
  const direct = options.direct === true;
  const container = await sessionContainer();
  const workspaceRoot = path.join(container, "workspace");
  const id = path.basename(container);
  const session: CodingSession = {
    id,
    sourceRoot,
    workspaceRoot,
    metadataFile: path.join(container, "session.json"),
    baselineFile: path.join(container, "baseline.json"),
    materialized: false,
    // A direct session never walks the source tree: fingerprinting a home
    // directory is exactly the cost direct mode exists to avoid.
    ...(direct ? {} : { sourceFingerprint: await fingerprintSessionSource(sourceRoot) }),
    ...(direct || options.inPlace === true ? { inPlace: true as const } : {}),
    ...(direct ? { direct: true as const } : {}),
    createdAt: new Date().toISOString(),
  };
  await writeSessionMetadata(session);
  return session;
}

/**
 * Atomically publishes an unmaterialized session at a caller-owned durable
 * location. The initializer runs inside an invisible staging directory, so
 * session metadata and engine-owned configuration become visible together.
 * Concurrent callers targeting the same container converge on the one
 * published session; no age-based lock takeover is used.
 */
export async function createSessionShellAt(
  source: string,
  container: string,
  initialize?: (stagingRoot: string, session: CodingSession) => Promise<void>,
  options: CreateSessionOptions = {},
): Promise<CodingSession> {
  if (options.direct === true) {
    throw new Error("Durable sessions are identified by their source fingerprint, which direct mode never computes. Create a direct session without a durable container.");
  }
  const sourceRoot = await realpath(path.resolve(source));
  if (!(await stat(sourceRoot)).isDirectory()) throw new Error("Workspace must be a directory.");
  const requestedContainer = path.resolve(container);
  const parent = path.dirname(requestedContainer);
  await mkdir(parent, { recursive: true });

  const existing = await openExistingSession(requestedContainer, sourceRoot);
  if (existing !== undefined) return assertRequestedSessionMode(existing, options);

  const staging = path.join(parent, `.${path.basename(requestedContainer)}.${randomUUID()}.tmp`);
  const session: CodingSession = {
    id: path.basename(requestedContainer),
    sourceRoot,
    workspaceRoot: path.join(requestedContainer, "workspace"),
    metadataFile: path.join(requestedContainer, "session.json"),
    baselineFile: path.join(requestedContainer, "baseline.json"),
    materialized: false,
    sourceFingerprint: await fingerprintSessionSource(sourceRoot),
    ...(options.inPlace === true ? { inPlace: true as const } : {}),
    createdAt: new Date().toISOString(),
  };
  await mkdir(staging);
  try {
    await writeSessionMetadataTo(path.join(staging, "session.json"), session);
    await initialize?.(staging, session);
    await syncFile(path.join(staging, "session.json"));
    await syncDirectoryBestEffort(staging);
    try {
      await rename(staging, requestedContainer);
      await syncDirectoryBestEffort(parent);
    } catch (error) {
      const winner = await openExistingSession(requestedContainer, sourceRoot);
      if (winner === undefined) throw error;
      return assertRequestedSessionMode(winner, options);
    }
    return openCodingSession(requestedContainer);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function assertRequestedSessionMode(session: CodingSession, options: CreateSessionOptions): CodingSession {
  if ((session.inPlace === true) !== (options.inPlace === true) || session.direct === true) {
    throw new Error("The existing durable session uses a different workspace mode.");
  }
  return session;
}

/**
 * Copies the original project into the disposable workspace. The copy is
 * prepared under a sibling temporary name and renamed into place, so a crash
 * cannot expose a half-materialized execution workspace. A content-addressed
 * baseline is captured at exactly the same boundary for later drift checks.
 * Fingerprints bracketing the copy must agree with the staged tree, preventing
 * a source mutation from publishing a mixed-time workspace snapshot.
 */
export async function materializeSessionWorkspace(
  session: CodingSession,
  options: MaterializeSessionWorkspaceOptions = {},
): Promise<CodingSession> {
  if (session.materialized) return session;
  // Direct sessions have nothing to materialize: no copy, no baseline. The
  // flip to the real source tree happens here and at open time, exactly like
  // in-place sessions, while metadata keeps the canonical container path.
  if (session.direct === true) {
    const materialized: CodingSession = { ...session, materialized: true };
    await writeSessionMetadata(materialized);
    return { ...materialized, workspaceRoot: session.sourceRoot };
  }
  const container = await realpath(path.dirname(session.metadataFile));
  if (path.dirname(session.workspaceRoot) !== container) throw new Error("Session workspace is outside its container.");
  const sourceFingerprintBeforeCopy = await fingerprintSessionSource(session.sourceRoot);
  const sourceChanged = session.sourceFingerprint !== undefined
    && sourceFingerprintBeforeCopy !== session.sourceFingerprint;
  const temporary = path.join(container, `.workspace-${randomUUID()}.tmp`);
  try {
    await (options.copyWorkspace ?? copySessionWorkspace)(session.sourceRoot, temporary);
    const sourceFingerprintAfterCopy = await fingerprintSessionSource(session.sourceRoot);
    if (sourceFingerprintAfterCopy !== sourceFingerprintBeforeCopy) {
      throw new Error("Source changed while materializing the session workspace; no workspace was published.");
    }
    const copiedFingerprint = await fingerprintSessionSource(temporary);
    if (copiedFingerprint !== sourceFingerprintAfterCopy) {
      throw new Error("Materialized workspace copy does not match the source; no workspace was published.");
    }
    const baseline = await snapshotTree(temporary);
    await rm(session.workspaceRoot, { recursive: true, force: true });
    await rename(temporary, session.workspaceRoot);
    await atomicWriteJson(session.baselineFile, baseline);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const materialized: CodingSession = {
    ...session,
    materialized: true,
    ...(sourceChanged ? { sourceChangedDuringConversation: true } : {}),
  };
  await writeSessionMetadata(materialized);
  // The copy just made is the pristine baseline for an in-place session;
  // the agent works directly on the real source tree. Metadata above keeps
  // the canonical container workspace path so open-time validation holds.
  if (session.inPlace === true) {
    return {
      ...materialized,
      workspaceRoot: session.sourceRoot,
      pristineRoot: path.join(container, "workspace"),
    };
  }
  return materialized;
}

/**
 * Manual recursive copy that skips OS-locked files exactly as the source
 * fingerprint marks them, so the copied tree and the fingerprint agree.
 * fs.cp is unsuitable because one locked file aborts the whole copy.
 */
async function copySessionWorkspace(sourceRoot: string, destinationRoot: string): Promise<void> {
  await mkdir(destinationRoot, { recursive: true });
  const fileJobs: Array<() => Promise<void>> = [];
  const queue: Array<{ source: string; destination: string }> = [{ source: sourceRoot, destination: destinationRoot }];
  while (queue.length > 0) {
    const { source, destination } = queue.shift()!;
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const sourcePath = path.join(source, entry.name);
      if (!shouldCopy(sourcePath)) continue;
      const destinationPath = path.join(destination, entry.name);
      const details = await lstat(sourcePath);
      if (details.isSymbolicLink()) {
        const target = await readlink(sourcePath);
        const targetIsDirectory = await stat(sourcePath).then((meta) => meta.isDirectory(), () => false);
        await symlink(target, destinationPath, targetIsDirectory ? "junction" : "file");
      } else if (details.isDirectory()) {
        await mkdir(destinationPath, { recursive: true });
        queue.push({ source: sourcePath, destination: destinationPath });
      } else if (details.isFile()) {
        // Copies dominate first-launch time in large projects; run them on
        // the bounded pool instead of one round-trip per file.
        fileJobs.push(async () => {
          try {
            await copyFile(sourcePath, destinationPath);
          } catch (error) {
            if (!isLockedFileError(error)) throw error;
            // Locked at the OS level: excluded from fingerprint and copy alike.
          }
        });
      }
    }
  }
  await runFilePool(fileJobs);
}

/** Creates an isolated child at an already captured checkpoint. */
export async function createForkedCodingSession(
  parent: CodingSession,
  checkpointWorkspace: string,
  lineage: SessionLineage,
): Promise<CodingSession> {
  const container = await sessionContainer();
  const workspaceRoot = path.join(container, "workspace");
  const baselineFile = path.join(container, "baseline.json");
  const metadataFile = path.join(container, "session.json");
  try {
    await copySessionWorkspace(checkpointWorkspace, workspaceRoot);
    const baseline = await loadSessionBaseline(parent);
    await atomicWriteJson(baselineFile, baseline);
    const session: CodingSession = {
      id: path.basename(container),
      sourceRoot: parent.sourceRoot,
      workspaceRoot,
      metadataFile,
      baselineFile,
      materialized: true,
      ...(parent.sourceFingerprint === undefined ? {} : { sourceFingerprint: parent.sourceFingerprint }),
      ...(parent.sourceChangedDuringConversation === true ? { sourceChangedDuringConversation: true } : {}),
      ...(parent.journalGenesisHash === undefined ? {} : { journalGenesisHash: parent.journalGenesisHash }),
      lineage,
      createdAt: new Date().toISOString(),
    };
    await writeSessionMetadata(session);
    return session;
  } catch (error) {
    await rm(container, { recursive: true, force: true });
    throw error;
  }
}

export async function openCodingSession(location: string): Promise<CodingSession> {
  let requested = path.resolve(location);
  const metadata = await stat(requested);
  if (metadata.isFile()) requested = path.dirname(requested);
  if (asciiLowercase(path.basename(requested)) === "workspace") requested = path.dirname(requested);
  const container = await realpath(requested);
  const metadataFile = path.join(container, "session.json");
  const parsed = JSON.parse(await readFile(metadataFile, "utf8")) as Partial<CodingSession>;
  if (typeof parsed.id !== "string" || typeof parsed.sourceRoot !== "string" || typeof parsed.workspaceRoot !== "string") {
    throw new Error("Session metadata is malformed.");
  }
  const materialized = parsed.materialized !== false;
  const direct = parsed.direct === true;
  const expectedWorkspace = path.join(container, "workspace");
  if (path.resolve(parsed.workspaceRoot) !== expectedWorkspace) {
    throw new Error("Session workspace does not belong to the requested session container.");
  }
  // A direct session's container never holds a workspace copy, so there is no
  // interrupted swap to recover and no copy to validate.
  if (materialized && !direct) await recoverInterruptedWorkspaceSwap(container, expectedWorkspace);
  const sourcePath = path.resolve(parsed.sourceRoot);
  if ((await lstat(sourcePath)).isSymbolicLink()) {
    throw new Error("Session source root was replaced by a symbolic link or junction.");
  }
  if (materialized && !direct && (await lstat(expectedWorkspace)).isSymbolicLink()) {
    throw new Error("Session workspace root was replaced by a symbolic link or junction.");
  }
  const workspaceRoot = materialized && !direct
    ? await realpath(parsed.workspaceRoot)
    : path.join(container, "workspace");
  if (path.dirname(workspaceRoot) !== container) {
    throw new Error("Session workspace does not belong to the requested session container.");
  }
  const lineage = validateLineage(parsed.lineage);
  const inPlace = parsed.inPlace === true || direct;
  const resolvedSource = await realpath(sourcePath);
  return {
    id: parsed.id,
    sourceRoot: resolvedSource,
    // An in-place session works directly on the real source tree; the
    // validated container workspace is its pristine baseline copy. A direct
    // session works on the source tree with no baseline at all.
    workspaceRoot: inPlace && materialized ? resolvedSource : workspaceRoot,
    metadataFile,
    baselineFile: path.join(container, "baseline.json"),
    materialized,
    ...(typeof parsed.sourceFingerprint === "string" ? { sourceFingerprint: parsed.sourceFingerprint } : {}),
    ...(parsed.sourceChangedDuringConversation === true ? { sourceChangedDuringConversation: true } : {}),
    ...(typeof parsed.journalGenesisHash === "string" ? { journalGenesisHash: parsed.journalGenesisHash } : {}),
    ...(lineage === undefined ? {} : { lineage }),
    ...(inPlace ? { inPlace: true as const } : {}),
    ...(inPlace && materialized && !direct ? { pristineRoot: workspaceRoot } : {}),
    ...(direct ? { direct: true as const } : {}),
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
  };
}

export async function loadSessionBaseline(session: CodingSession): Promise<TreeSnapshot> {
  if (session.direct === true) {
    throw new Error("Direct sessions record no baseline: edits land straight in the project, so there is nothing to diff, apply, or undo. Use version control.");
  }
  if (!session.materialized) throw new Error("Session workspace has not been materialized.");
  try {
    return await readTreeSnapshot(session.baselineFile);
  } catch (error) {
    if (isMissing(error)) {
      throw new Error("Session predates deterministic baselines and cannot be safely applied; create a new session.");
    }
    throw error;
  }
}

/** Content hashing beyond this size switches to size-based identity. */
const LARGE_FILE_IDENTITY_BYTES = 8 * 1024 * 1024;
const FILE_IO_CONCURRENCY = 8;

/**
 * Mirror of the tree-snapshot racy-mtime rule: a cached digest is served only
 * when size, mtime, and ctime are identical to the hashed observation AND the
 * mtime is strictly older than that observation by this slop, so coarse
 * filesystem timestamps can never bless a same-window rewrite.
 */
const FINGERPRINT_RACY_MTIME_SLOP_MS = 2_000;

interface FingerprintCacheEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly digest: string;
  readonly hashedAtMs: number;
}

/**
 * Stat-validated digest cache for repeated fingerprints of one source root.
 * Session flows fingerprint the same tree several times (shell creation, the
 * materialization bracket, engine create idempotency); each pass after the
 * first only re-reads files whose stats changed, which turns a full-content
 * walk into a stat walk without weakening content identity.
 */
class SourceFingerprintCache {
  readonly #entries = new Map<string, FingerprintCacheEntry>();

  lookup(absolutePath: string, stats: Stats): string | undefined {
    const cached = this.#entries.get(absolutePath);
    if (cached === undefined) return undefined;
    if (cached.size !== stats.size || cached.mtimeMs !== stats.mtimeMs || cached.ctimeMs !== stats.ctimeMs) return undefined;
    if (cached.mtimeMs + FINGERPRINT_RACY_MTIME_SLOP_MS >= cached.hashedAtMs) return undefined;
    return cached.digest;
  }

  store(absolutePath: string, stats: Stats, digest: string): void {
    this.#entries.set(absolutePath, {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      digest,
      hashedAtMs: Date.now(),
    });
  }

  retainOnly(seen: ReadonlySet<string>): void {
    for (const key of this.#entries.keys()) {
      if (!seen.has(key)) this.#entries.delete(key);
    }
  }
}

const SOURCE_FINGERPRINT_CACHE_ROOTS = 8;
const sourceFingerprintCaches = new Map<string, SourceFingerprintCache>();

/** One digest cache per resolved root, capped so temporary roots cannot pile up. */
function sourceFingerprintCacheFor(root: string): SourceFingerprintCache {
  const key = path.resolve(root);
  const existing = sourceFingerprintCaches.get(key);
  if (existing !== undefined) return existing;
  if (sourceFingerprintCaches.size >= SOURCE_FINGERPRINT_CACHE_ROOTS) {
    const oldest = sourceFingerprintCaches.keys().next().value;
    if (oldest !== undefined) sourceFingerprintCaches.delete(oldest);
  }
  const created = new SourceFingerprintCache();
  sourceFingerprintCaches.set(key, created);
  return created;
}

/** Run async jobs with bounded parallelism; results keep job order. */
async function runFilePool<T>(jobs: readonly (() => Promise<T>)[], limit = FILE_IO_CONCURRENCY): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      results[index] = await jobs[index]!();
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Content-addressed source identity used across durable create and later
 * materialization. Paths and entry types are framed explicitly; file bytes
 * and symlink targets, rather than mutable timestamps, determine identity.
 *
 * Speed is a correctness property here: this walk runs before anything else
 * a user sees, and on cloud-synced folders (OneDrive) reading a file forces
 * a download while stat does not. Small files hash content in parallel;
 * files past the large-file threshold are identified by size alone — size
 * survives copying (mtime does not), so materialization checks still hold,
 * at the documented cost that a same-size edit to a huge asset reads as
 * unchanged. Assets that big are not what a coding session is guarding.
 */
export async function fingerprintSessionSource(root: string): Promise<string> {
  const cache = sourceFingerprintCacheFor(root);
  const entries: string[] = [];
  const hashJobs: Array<() => Promise<string | undefined>> = [];
  const seenFiles = new Set<string>();
  const limitFs = createFsLimiter(FINGERPRINT_FS_CONCURRENCY);

  const walk = async (directory: string): Promise<void> => {
    const children = await limitFs(() => readdir(directory, { withFileTypes: true }));
    const subdirectories: string[] = [];
    await Promise.all(children.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      const details = await limitFs(() => lstat(absolute));
      if (details.isSymbolicLink()) {
        const target = await limitFs(() => readlink(absolute));
        entries.push(JSON.stringify(["link", relative, target]));
      } else if (details.isDirectory()) {
        if (!SESSION_EXCLUDED_DIRECTORIES.has(entry.name)) {
          entries.push(JSON.stringify(["directory", relative, details.mode & 0o7777]));
          subdirectories.push(absolute);
        }
      } else if (details.isFile()) {
        if (details.size > LARGE_FILE_IDENTITY_BYTES) {
          entries.push(JSON.stringify(["file", relative, details.mode & 0o7777, details.size, `large:${details.size}`]));
          return;
        }
        const cached = cache.lookup(absolute, details);
        if (cached !== undefined) {
          seenFiles.add(absolute);
          entries.push(JSON.stringify(["file", relative, details.mode & 0o7777, details.size, cached]));
          return;
        }
        hashJobs.push(async () => {
          const digest = await hashStableFileOrLocked(absolute, details);
          // OS-locked files (registry hives, running executables) cannot be
          // read and are never copied into a session, so they are invisible
          // to the session model: excluded from fingerprints and copies
          // alike, exactly like SESSION_EXCLUDED_DIRECTORIES. A file that
          // later becomes readable enters the fingerprint as source drift.
          if (digest === undefined) return undefined;
          // hashStableFile proved these exact stats survived the read, so the
          // digest is safe to serve for identical stats on a later pass.
          seenFiles.add(absolute);
          cache.store(absolute, details, digest);
          return JSON.stringify(["file", relative, details.mode & 0o7777, details.size, digest]);
        });
      } else {
        throw new Error(`Source contains unsupported filesystem entry: ${relative}`);
      }
    }));
    await Promise.all(subdirectories.map((subdirectory) => walk(subdirectory)));
  };

  await walk(root);
  for (const hashed of await runFilePool(hashJobs)) {
    if (hashed !== undefined) entries.push(hashed);
  }
  cache.retainOnly(seenFiles);
  entries.sort(compareOrdinal);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

/** Walk parallelism for fingerprinting; hashing keeps its own bounded pool. */
const FINGERPRINT_FS_CONCURRENCY = 16;

export function isLockedFileError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES";
}

async function hashStableFileOrLocked(file: string, observed: Stats): Promise<string | undefined> {
  try {
    return await hashStableFile(file, observed);
  } catch (error) {
    if (isLockedFileError(error)) return undefined;
    throw error;
  }
}

async function hashStableFile(file: string, observed: Stats): Promise<string> {
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileVersion(observed, opened)) {
      throw new Error(`Source file changed while fingerprinting: ${file}`);
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(file)]);
    if (!afterPath.isFile() || !sameFileVersion(opened, afterHandle) || !sameFileVersion(afterHandle, afterPath)) {
      throw new Error(`Source file changed while fingerprinting: ${file}`);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function sameFileVersion(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && (left.mode & 0o7777) === (right.mode & 0o7777)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function writeSessionMetadata(session: CodingSession): Promise<void> {
  await writeSessionMetadataTo(session.metadataFile, session);
}

async function writeSessionMetadataTo(file: string, session: CodingSession): Promise<void> {
  // Metadata always stores the canonical container workspace path, even when
  // an in-place session object carries the flipped source-tree workspaceRoot.
  // Use the session's final metadata location rather than `file`: durable
  // creation writes through an atomic staging directory before publication.
  const canonicalWorkspaceRoot = session.inPlace === true
    ? path.join(path.dirname(session.metadataFile), "workspace")
    : session.workspaceRoot;
  await atomicWriteJson(file, {
    id: session.id,
    sourceRoot: session.sourceRoot,
    workspaceRoot: canonicalWorkspaceRoot,
    materialized: session.materialized,
    ...(session.sourceFingerprint === undefined ? {} : { sourceFingerprint: session.sourceFingerprint }),
    ...(session.sourceChangedDuringConversation === true ? { sourceChangedDuringConversation: true } : {}),
    ...(session.journalGenesisHash === undefined ? {} : { journalGenesisHash: session.journalGenesisHash }),
    ...(session.lineage === undefined ? {} : { lineage: session.lineage }),
    ...(session.inPlace === true ? { inPlace: true } : {}),
    ...(session.direct === true ? { direct: true } : {}),
    createdAt: session.createdAt,
  });
}

async function openExistingSession(container: string, sourceRoot: string): Promise<CodingSession | undefined> {
  try {
    const metadata = await lstat(container);
    if (metadata.isSymbolicLink()) throw new Error("Session container cannot be a symbolic link or junction.");
    if (!metadata.isDirectory()) throw new Error("Session container must be a directory.");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const session = await openCodingSession(container);
  if (path.resolve(session.sourceRoot) !== path.resolve(sourceRoot)) {
    throw new Error("Existing durable session belongs to a different source workspace.");
  }
  return session;
}

async function syncFile(file: string): Promise<void> {
  const handle = await open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!(error instanceof Error && "code" in error
      && ["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(String(error.code)))) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function shouldCopy(candidate: string): boolean {
  return !SESSION_EXCLUDED_DIRECTORIES.has(path.basename(candidate));
}

function validateLineage(value: unknown): SessionLineage | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Session lineage is malformed.");
  const lineage = value as Partial<SessionLineage>;
  if (
    typeof lineage.parentSessionId !== "string"
    || typeof lineage.parentCheckpointId !== "string"
    || typeof lineage.parentJournalHash !== "string"
    || !/^[a-f0-9]{64}$/.test(lineage.parentJournalHash)
  ) throw new Error("Session lineage is malformed.");
  return lineage as SessionLineage;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function recoverInterruptedWorkspaceSwap(container: string, workspaceRoot: string): Promise<void> {
  const marker = path.join(container, "time-travel", "restore.json");
  try {
    const parsed = JSON.parse(await readFile(marker, "utf8")) as {
      version?: number; restoreId?: string; checkpointId?: string; state?: string;
    };
    if (
      parsed.version !== 1 || typeof parsed.restoreId !== "string" || !/^restore-[a-f0-9-]+$/.test(parsed.restoreId)
      || typeof parsed.checkpointId !== "string"
      || !/^checkpoint-[a-f0-9-]+$/.test(parsed.checkpointId)
      || !["prepared", "old_moved", "new_moved", "committed"].includes(parsed.state ?? "")
    ) throw new Error("Restore recovery marker is malformed.");
    const journal = await readFile(path.join(container, "run.jsonl"), "utf8").catch(() => "");
    if (parsed.state === "committed" || (journal.includes(parsed.restoreId) && journal.includes('"type":"session.restored"'))) {
      await rm(path.join(container, "workspace.restore-backup"), { recursive: true, force: true });
      await rm(path.join(container, "workspace.restore-new"), { recursive: true, force: true });
      await rm(path.join(container, "time-travel", "restore-state-new"), { recursive: true, force: true });
      await rm(path.join(container, "time-travel", "restore-state-backup"), { recursive: true, force: true });
      await rm(marker, { force: true });
      return;
    }
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const backup = path.join(container, "workspace.restore-backup");
  const staged = path.join(container, "workspace.restore-new");
  const stateBackup = path.join(container, "time-travel", "restore-state-backup");
  await restoreOptionalStateBackup(stateBackup, container);
  try {
    await stat(backup);
    await rm(workspaceRoot, { recursive: true, force: true });
    await rename(backup, workspaceRoot);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await rm(staged, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await rm(path.join(container, "time-travel", "restore-state-new"), { recursive: true, force: true });
  await rm(stateBackup, { recursive: true, force: true });
  await rm(marker, { force: true });
}

async function restoreOptionalStateBackup(source: string, container: string): Promise<void> {
  let parsed: { version?: number; present?: unknown };
  try {
    parsed = JSON.parse(await readFile(path.join(source, "presence.json"), "utf8")) as typeof parsed;
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const allowed = ["run-config.json", "plan.json", "checkpoint.json", "delegations.json"] as const;
  if (
    parsed.version !== 1 || !Array.isArray(parsed.present)
    || !parsed.present.every((name) => typeof name === "string" && allowed.includes(name as typeof allowed[number]))
  ) throw new Error("Restore state backup is malformed.");
  const present = new Set(parsed.present as string[]);
  for (const name of allowed) {
    const target = path.join(container, name);
    if (!present.has(name)) {
      await rm(target, { force: true });
      continue;
    }
    const temporary = `${target}.restore.tmp`;
    await copyFile(path.join(source, name), temporary);
    try {
      await rm(target, { force: true });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
