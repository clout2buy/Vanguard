import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const SESSION_EXCLUDED_DIRECTORIES = new Set([".git", ".vanguard", "node_modules"]);

export interface TreeSnapshotOptions {
  readonly excludedDirectories?: ReadonlySet<string>;
}

export interface TreeEntry {
  readonly path: string;
  readonly kind: "file" | "symlink";
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
  readonly binary: boolean;
  readonly linkTarget?: string;
}

export interface TreeSnapshot {
  readonly version: 1;
  readonly rootHash: string;
  readonly entries: readonly TreeEntry[];
}

export async function snapshotTree(root: string, options: TreeSnapshotOptions = {}): Promise<TreeSnapshot> {
  const requestedRoot = path.resolve(root);
  const rootMetadata = await lstat(requestedRoot);
  if (rootMetadata.isSymbolicLink()) throw new Error("Snapshot root cannot be a symbolic link or junction.");
  const absoluteRoot = await realpath(requestedRoot);
  if (!(await stat(absoluteRoot)).isDirectory()) throw new Error("Snapshot root must be a directory.");
  const entries: TreeEntry[] = [];
  const excludedDirectories = options.excludedDirectories ?? SESSION_EXCLUDED_DIRECTORIES;
  const queue = [absoluteRoot];
  while (queue.length > 0) {
    const directory = queue.shift()!;
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = normalizeRelative(path.relative(absoluteRoot, absolute));
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) {
        const target = await readlink(absolute);
        entries.push({
          path: relative,
          kind: "symlink",
          sha256: sha256(Buffer.from(target, "utf8")),
          size: Buffer.byteLength(target),
          mode: details.mode & 0o777,
          binary: false,
          linkTarget: target,
        });
      } else if (details.isDirectory()) {
        if (!excludedDirectories.has(child.name)) queue.push(absolute);
      } else if (details.isFile()) {
        const contents = await readFile(absolute);
        entries.push({
          path: relative,
          kind: "file",
          sha256: sha256(contents),
          size: contents.byteLength,
          mode: details.mode & 0o777,
          binary: contents.subarray(0, 8_192).includes(0),
        });
      }
    }
  }
  entries.sort((left, right) => compareText(left.path, right.path));
  const canonical = JSON.stringify(entries);
  return { version: 1, rootHash: sha256(Buffer.from(canonical, "utf8")), entries };
}

export function validateTreeSnapshot(value: unknown): asserts value is TreeSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Tree snapshot is malformed.");
  const snapshot = value as Partial<TreeSnapshot>;
  if (snapshot.version !== 1 || !isSha256(snapshot.rootHash) || !Array.isArray(snapshot.entries)) {
    throw new Error("Tree snapshot is malformed.");
  }
  let previous = "";
  for (const raw of snapshot.entries) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Tree snapshot is malformed.");
    const entry = raw as Partial<TreeEntry>;
    if (
      typeof entry.path !== "string"
      || (entry.kind !== "file" && entry.kind !== "symlink")
      || !isSha256(entry.sha256)
      || !Number.isSafeInteger(entry.size) || (entry.size ?? -1) < 0
      || !Number.isSafeInteger(entry.mode) || (entry.mode ?? -1) < 0
      || typeof entry.binary !== "boolean"
    ) throw new Error("Tree snapshot is malformed.");
    assertSafeRelativePath(entry.path);
    if (compareText(entry.path, previous) <= 0) throw new Error("Tree snapshot entries are not canonical.");
    if (entry.kind === "symlink" && typeof entry.linkTarget !== "string") throw new Error("Tree snapshot is malformed.");
    previous = entry.path;
  }
  const expected = sha256(Buffer.from(JSON.stringify(snapshot.entries), "utf8"));
  if (expected !== snapshot.rootHash) throw new Error("Tree snapshot integrity failure.");
}

export async function readTreeSnapshot(file: string): Promise<TreeSnapshot> {
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  validateTreeSnapshot(parsed);
  return parsed;
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function safeRoot(root: string): Promise<string> {
  const requested = path.resolve(root);
  const requestedMetadata = await lstat(requested);
  if (requestedMetadata.isSymbolicLink()) throw new Error("Boundary root cannot be a symbolic link or junction.");
  const resolved = await realpath(requested);
  if (!(await stat(resolved)).isDirectory()) throw new Error("Boundary root must be a directory.");
  return resolved;
}

/**
 * Resolves a relative path lexically and refuses every symbolic-link or
 * junction ancestor. The final component is checked when it exists. This is
 * deliberately stricter than realpath containment: apply operations never
 * write through a link even when that link currently resolves inside root.
 */
export async function linkSafePath(root: string, relativePath: string): Promise<string> {
  assertSafeRelativePath(relativePath);
  const canonicalRoot = await safeRoot(root);
  const nativeRelative = relativePath.split("/").join(path.sep);
  const candidate = path.resolve(canonicalRoot, nativeRelative);
  const relative = path.relative(canonicalRoot, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes boundary: ${relativePath}`);
  }
  let cursor = canonicalRoot;
  for (const segment of nativeRelative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      const details = await lstat(cursor);
      if (details.isSymbolicLink()) throw new Error(`Symbolic-link or junction path is not writable: ${relativePath}`);
    } catch (error) {
      if (isMissing(error)) break;
      throw error;
    }
  }
  return candidate;
}

export async function copyFileWithMode(source: string, destination: string, mode: number): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (process.platform !== "win32") await chmod(destination, mode);
}

export function assertSafeRelativePath(relativePath: string): void {
  if (relativePath.length === 0 || path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized !== relativePath || normalized.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function normalizeRelative(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  assertSafeRelativePath(normalized);
  return normalized;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
