import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { compareOrdinal } from "../deterministicText.js";
import { VanguardEngineError, type VanguardCreateOperationStoreOptions } from "./types.js";

const STORE_MARKER = Object.freeze({ version: 1, kind: "vanguard.create-operation-store" });
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;

export interface DurableCreateClaim {
  readonly version: 1;
  readonly operationIdSha256: string;
  /** Digest of the normalized, caller-supplied request before repo discovery. */
  readonly requestSha256: string;
  /** Digest of the canonical effective run configuration. */
  readonly configSha256: string;
  readonly sessionId: string;
  /** Source-tree identity captured before the durable session is published. */
  readonly sourceFingerprint: string;
  readonly runConfigurationSha256: string;
  readonly runConfiguration: unknown;
}

export interface DurableCreateReceipt {
  readonly version: 1;
  readonly operationIdSha256: string;
  readonly requestSha256: string;
  readonly configSha256: string;
  readonly sessionId: string;
  readonly sourceFingerprint: string;
  readonly runConfigurationSha256: string;
}

export interface DurableOwnershipLease {
  readonly version: 1;
  readonly operationIdSha256: string;
  readonly ownerToken: string;
  readonly epoch: number;
}

interface StorePaths {
  readonly root: string;
  readonly operations: string;
  readonly rootIdentity: FileIdentity;
  readonly operationsIdentity: FileIdentity;
}

interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

/** Permanent, CAS-published operation claims. There are no stale leases. */
export class FileCreateOperationStore {
  readonly #configuredRoot: string;
  #initialization: Promise<StorePaths> | undefined;

  constructor(options: VanguardCreateOperationStoreOptions) {
    if (typeof options.root !== "string" || options.root.length === 0 || !path.isAbsolute(options.root)) {
      throw new VanguardEngineError(
        "invalid_create_operation_store",
        "createOperationStore.root must be a non-empty absolute path.",
      );
    }
    this.#configuredRoot = path.resolve(options.root);
  }

  operationDirectory(operationIdSha256: string): string {
    assertSha256(operationIdSha256, "operation ID digest");
    return path.join(this.#configuredRoot, "operations", operationIdSha256);
  }

  sessionRoot(operationIdSha256: string): string {
    return path.join(this.operationDirectory(operationIdSha256), sessionIdFor(operationIdSha256));
  }

  async reserve(proposed: DurableCreateClaim): Promise<{ readonly claim: DurableCreateClaim; readonly created: boolean }> {
    validateClaim(proposed);
    const paths = await this.#validatedPaths();
    const operationDirectory = path.join(paths.operations, proposed.operationIdSha256);
    const current = await readClaimIfPresent(operationDirectory);
    if (current !== undefined) return { claim: current, created: false };

    const staging = path.join(paths.operations, `.claim-${proposed.operationIdSha256}-${randomUUID()}.tmp`);
    await mkdir(staging);
    try {
      await writeDurableFile(path.join(staging, "claim.json"), `${canonicalJson(proposed)}\n`);
      await syncDirectoryBestEffort(staging);
      try {
        await rename(staging, operationDirectory);
        await syncDirectoryBestEffort(paths.operations);
        return { claim: proposed, created: true };
      } catch (error) {
        const winner = await readClaimIfPresent(operationDirectory);
        if (winner === undefined) throw error;
        return { claim: winner, created: false };
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async readClaim(operationIdSha256: string): Promise<DurableCreateClaim | undefined> {
    const paths = await this.#validatedPaths();
    assertSha256(operationIdSha256, "operation ID digest");
    return readClaimIfPresent(path.join(paths.operations, operationIdSha256));
  }

  async readReceipt(operationIdSha256: string): Promise<DurableCreateReceipt | undefined> {
    const paths = await this.#validatedPaths();
    const operationDirectory = await requiredOperationDirectory(paths.operations, operationIdSha256);
    const value = await readJsonIfPresent(path.join(operationDirectory, "receipt.json"));
    if (value === undefined) return undefined;
    validateReceipt(value);
    return value;
  }

  async validatePersistedClaim(expected: DurableCreateClaim): Promise<string> {
    validateClaim(expected);
    const paths = await this.#validatedPaths();
    const directory = await requiredOperationDirectory(paths.operations, expected.operationIdSha256);
    const persisted = await readClaimIfPresent(directory);
    if (persisted === undefined || canonicalJson(persisted) !== canonicalJson(expected)) {
      throw corrupt("The persisted create claim changed after reservation.");
    }
    return path.join(directory, expected.sessionId);
  }

  async commitReceipt(receipt: DurableCreateReceipt): Promise<DurableCreateReceipt> {
    validateReceipt(receipt);
    const paths = await this.#validatedPaths();
    const operationDirectory = await requiredOperationDirectory(paths.operations, receipt.operationIdSha256);
    const file = path.join(operationDirectory, "receipt.json");
    const expected = `${canonicalJson(receipt)}\n`;
    const created = await publishImmutableFile(file, expected);
    if (created) await syncDirectoryBestEffort(operationDirectory);
    const persisted = await readJson(file);
    validateReceipt(persisted);
    if (canonicalJson(persisted) !== canonicalJson(receipt)) {
      throw corrupt("The persisted create receipt conflicts with the claimed session.");
    }
    return persisted;
  }

  async acquireOwnership(
    operationIdSha256: string,
    ownerToken: string,
  ): Promise<DurableOwnershipLease> {
    validateOwnerToken(ownerToken);
    const paths = await this.#validatedPaths();
    const operationDirectory = await requiredOperationDirectory(paths.operations, operationIdSha256);
    const ownershipDirectory = path.join(operationDirectory, "ownership");
    await mkdir(ownershipDirectory, { recursive: true });
    await assertOwnedDirectory(ownershipDirectory, "operation ownership directory");
    const ownerFile = path.join(operationDirectory, "owner.json");
    const current = await readOwnerIfPresent(ownerFile);
    if (current !== undefined) {
      if (current.ownerToken === ownerToken) return current;
      throw owned(current);
    }
    const history = await ownershipHistory(ownershipDirectory);
    if (history.lastState === "abandoned") {
      throw new VanguardEngineError(
        "manual_takeover_required",
        "The prior owner was explicitly fenced; ownership recovery requires the matching manual takeover authority.",
      );
    }
    const proposed: DurableOwnershipLease = Object.freeze({
      version: 1,
      operationIdSha256,
      ownerToken,
      epoch: history.maximumEpoch + 1,
    });
    await publishImmutableFile(ownerFile, `${canonicalJson(proposed)}\n`);
    const persisted = await readOwnerIfPresent(ownerFile);
    if (persisted === undefined) throw corrupt("Operation ownership disappeared during acquisition.");
    if (persisted.ownerToken !== ownerToken || persisted.epoch !== proposed.epoch) throw owned(persisted);
    await syncDirectoryBestEffort(operationDirectory);
    return persisted;
  }

  assertOwnershipSync(lease: DurableOwnershipLease): void {
    validateOwnership(lease);
    const operationDirectory = this.operationDirectory(lease.operationIdSha256);
    const ownerFile = path.join(operationDirectory, "owner.json");
    let parsed: unknown;
    try {
      const metadata = lstatSync(ownerFile);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_RECEIPT_BYTES) {
        throw corrupt("Operation owner record is not a bounded regular file.");
      }
      parsed = JSON.parse(readFileSync(ownerFile, "utf8")) as unknown;
    } catch (error) {
      if (error instanceof VanguardEngineError) throw error;
      throw new VanguardEngineError("session_ownership_lost", "Durable session ownership is missing or unreadable.");
    }
    validateOwnership(parsed);
    if (parsed.ownerToken !== lease.ownerToken || parsed.epoch !== lease.epoch
      || parsed.operationIdSha256 !== lease.operationIdSha256) {
      throw new VanguardEngineError(
        "session_ownership_lost",
        "This engine instance no longer owns the durable session generation.",
      );
    }
  }

  async releaseOwnership(lease: DurableOwnershipLease): Promise<void> {
    this.assertOwnershipSync(lease);
    const paths = await this.#validatedPaths();
    const operationDirectory = await requiredOperationDirectory(paths.operations, lease.operationIdSha256);
    const ownershipDirectory = path.join(operationDirectory, "ownership");
    await mkdir(ownershipDirectory, { recursive: true });
    const archived = path.join(ownershipDirectory, ownershipArchiveName(lease, "released"));
    try {
      await rename(path.join(operationDirectory, "owner.json"), archived);
    } catch {
      throw new VanguardEngineError("session_ownership_lost", "Durable ownership changed before release.");
    }
    // rename mutates both parents. Persist the epoch archive before allowing
    // the operation directory's owner removal to count as a clean release.
    await syncDirectoryBestEffort(ownershipDirectory);
    await syncDirectoryBestEffort(operationDirectory);
  }

  async #initialize(): Promise<StorePaths> {
    await mkdir(this.#configuredRoot, { recursive: true });
    await assertOwnedDirectory(this.#configuredRoot, "create-operation store root");
    const root = await realpath(this.#configuredRoot);
    if (path.resolve(root) !== this.#configuredRoot) {
      throw new VanguardEngineError(
        "invalid_create_operation_store",
        "createOperationStore.root may not be a symbolic link or junction.",
      );
    }
    const markerFile = path.join(root, "store.json");
    await publishImmutableFile(markerFile, `${canonicalJson(STORE_MARKER)}\n`);
    const marker = await readJson(markerFile);
    if (canonicalJson(marker) !== canonicalJson(STORE_MARKER)) {
      throw new VanguardEngineError(
        "invalid_create_operation_store",
        "The configured directory is not a compatible Vanguard create-operation store.",
      );
    }
    const operations = path.join(root, "operations");
    await mkdir(operations, { recursive: true });
    await assertOwnedDirectory(operations, "create-operation claims directory");
    await syncDirectoryBestEffort(root);
    return {
      root,
      operations,
      rootIdentity: await fileIdentity(root),
      operationsIdentity: await fileIdentity(operations),
    };
  }

  async #validatedPaths(): Promise<StorePaths> {
    this.#initialization ??= this.#initialize();
    const paths = await this.#initialization;
    await assertUnchangedDirectory(paths.root, paths.rootIdentity, "create-operation store root");
    await assertUnchangedDirectory(paths.operations, paths.operationsIdentity, "create-operation claims directory");
    return paths;
  }
}

export function createOperationIdDigest(operationId: string): string {
  if (typeof operationId !== "string" || operationId.length === 0 || operationId.length > 512 || operationId.includes("\0")) {
    throw new VanguardEngineError(
      "invalid_operation_id",
      "operationId must be a non-empty opaque string of at most 512 characters.",
    );
  }
  return sha256(Buffer.from(operationId, "utf8"));
}

export function canonicalDigest(value: unknown): string {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

export function sessionIdFor(operationIdSha256: string): string {
  assertSha256(operationIdSha256, "operation ID digest");
  return `vanguard-session-${operationIdSha256}`;
}

function validateClaim(value: unknown): asserts value is DurableCreateClaim {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "configSha256",
    "operationIdSha256",
    "requestSha256",
    "runConfiguration",
    "runConfigurationSha256",
    "sessionId",
    "sourceFingerprint",
    "version",
  ])) throw corrupt("Create claim schema is invalid.");
  if (value.version !== 1) throw corrupt("Create claim version is unsupported.");
  assertSha256(value.operationIdSha256, "operation ID digest");
  assertSha256(value.requestSha256, "request digest");
  assertSha256(value.configSha256, "configuration digest");
  assertSha256(value.runConfigurationSha256, "run-configuration digest");
  if (value.sessionId !== sessionIdFor(value.operationIdSha256)) throw corrupt("Create claim session ID is invalid.");
  assertSha256(value.sourceFingerprint, "source fingerprint");
  if (canonicalDigest(value.runConfiguration) !== value.runConfigurationSha256) {
    throw corrupt("Create claim run configuration failed its digest check.");
  }
  if (value.configSha256 !== value.runConfigurationSha256) {
    throw corrupt("Create claim configuration binding is invalid.");
  }
}

function validateReceipt(value: unknown): asserts value is DurableCreateReceipt {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "configSha256",
    "operationIdSha256",
    "requestSha256",
    "runConfigurationSha256",
    "sessionId",
    "sourceFingerprint",
    "version",
  ])) throw corrupt("Create receipt schema is invalid.");
  if (value.version !== 1) throw corrupt("Create receipt version is unsupported.");
  assertSha256(value.operationIdSha256, "operation ID digest");
  assertSha256(value.requestSha256, "request digest");
  assertSha256(value.configSha256, "configuration digest");
  assertSha256(value.runConfigurationSha256, "run-configuration digest");
  if (value.sessionId !== sessionIdFor(value.operationIdSha256)) throw corrupt("Create receipt session ID is invalid.");
  assertSha256(value.sourceFingerprint, "source fingerprint");
  if (value.configSha256 !== value.runConfigurationSha256) {
    throw corrupt("Create receipt configuration binding is invalid.");
  }
}

function validateOwnership(value: unknown): asserts value is DurableOwnershipLease {
  if (!isPlainObject(value) || !hasExactKeys(value, ["epoch", "operationIdSha256", "ownerToken", "version"])) {
    throw corrupt("Operation owner schema is invalid.");
  }
  if (value.version !== 1 || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1) {
    throw corrupt("Operation owner epoch is invalid.");
  }
  assertSha256(value.operationIdSha256, "owner operation digest");
  validateOwnerToken(value.ownerToken);
}

function validateOwnerToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9-]{36,80}$/u.test(value)) {
    throw new VanguardEngineError("invalid_owner_token", "Durable owner token is invalid.");
  }
}

async function readOwnerIfPresent(file: string): Promise<DurableOwnershipLease | undefined> {
  const value = await readJsonIfPresent(file);
  if (value === undefined) return undefined;
  validateOwnership(value);
  return Object.freeze(value);
}

async function ownershipHistory(directory: string): Promise<{
  readonly maximumEpoch: number;
  readonly lastState?: "abandoned" | "released";
  readonly lastOwnerToken?: string;
}> {
  let maximumEpoch = 0;
  let lastState: "abandoned" | "released" | undefined;
  let lastOwnerToken: string | undefined;
  for (const name of await readdir(directory)) {
    const match = /^epoch-([0-9]{12})-([a-f0-9-]+)\.(abandoned|released)\.json$/u.exec(name);
    if (match === null) throw corrupt("Operation ownership history contains an unexpected entry.");
    const epoch = Number(match[1]);
    if (epoch > maximumEpoch) {
      maximumEpoch = epoch;
      lastOwnerToken = match[2]!;
      lastState = match[3] as "abandoned" | "released";
    }
  }
  return {
    maximumEpoch,
    ...(lastState === undefined ? {} : { lastState }),
    ...(lastOwnerToken === undefined ? {} : { lastOwnerToken }),
  };
}

function ownershipArchiveName(lease: DurableOwnershipLease, state: "abandoned" | "released"): string {
  return `epoch-${String(lease.epoch).padStart(12, "0")}-${lease.ownerToken}.${state}.json`;
}

function owned(owner: DurableOwnershipLease): VanguardEngineError {
  return new VanguardEngineError(
    "session_owned",
    "The durable session is owned by another engine instance; no automatic stale takeover is allowed.",
    true,
    { ownerEpoch: owner.epoch },
  );
}

async function readClaimIfPresent(operationDirectory: string): Promise<DurableCreateClaim | undefined> {
  try {
    const metadata = await lstat(operationDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw corrupt("Create claim path is not an owned directory.");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const value = await readJson(path.join(operationDirectory, "claim.json"));
  validateClaim(value);
  return value;
}

async function requiredOperationDirectory(operations: string, digest: string): Promise<string> {
  assertSha256(digest, "operation ID digest");
  const directory = path.join(operations, digest);
  const claim = await readClaimIfPresent(directory);
  if (claim === undefined) throw corrupt("Create operation claim is missing.");
  if (claim.operationIdSha256 !== digest) throw corrupt("Create operation claim is misbound.");
  return directory;
}

async function publishImmutableFile(file: string, contents: string): Promise<boolean> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeDurableFile(temporary, contents);
    try {
      await link(temporary, file);
      return true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      return false;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeDurableFile(file: string, contents: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJsonIfPresent(file: string): Promise<unknown | undefined> {
  try {
    return await readJson(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function readJson(file: string): Promise<unknown> {
  const metadata = await lstat(file);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_RECEIPT_BYTES) {
    throw corrupt("Create-operation record is not a bounded regular file.");
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (isMissing(error)) throw error;
    throw corrupt("Create-operation record is malformed JSON.");
  }
}

async function assertOwnedDirectory(directory: string, label: string): Promise<void> {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new VanguardEngineError("invalid_create_operation_store", `The ${label} must be a real directory.`);
  }
}

async function fileIdentity(directory: string): Promise<FileIdentity> {
  const metadata = await lstat(directory, { bigint: true });
  return { dev: metadata.dev, ino: metadata.ino };
}

async function assertUnchangedDirectory(directory: string, expected: FileIdentity, label: string): Promise<void> {
  await assertOwnedDirectory(directory, label);
  const actual = await fileIdentity(directory);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new VanguardEngineError(
      "create_operation_store_replaced",
      `The ${label} changed after engine initialization; create is refused.`,
      true,
    );
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw corrupt("Canonical create configuration contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw corrupt("Canonical create configuration contains an unsupported value.");
  if (seen.has(value)) throw corrupt("Canonical create configuration is cyclic.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw corrupt("Canonical create configuration contains a sparse array.");
        entries.push(canonicalJson(value[index], seen));
      }
      return `[${entries.join(",")}]`;
    }
    if (!isPlainObject(value)) throw corrupt("Canonical create configuration contains a non-plain object.");
    const keys = Object.keys(value).sort(compareOrdinal);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareOrdinal);
  const sortedExpected = [...expected].sort(compareOrdinal);
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw corrupt(`Create ${label} is invalid.`);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function corrupt(message: string): VanguardEngineError {
  return new VanguardEngineError("create_operation_corrupt", message, false);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && ["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(String(error.code));
}
