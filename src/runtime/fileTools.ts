import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { objectInput, stringField } from "./input.js";
import { WorkspaceBoundary } from "./workspace.js";
import { WorkspaceMutationPolicy } from "./mutationPolicy.js";
import { WorkspaceVersionLedger } from "./versionLedger.js";

const DEFAULT_IGNORED_DIRECTORIES = new Set([".git", ".vanguard", "node_modules", "dist", "coverage"]);
const DEFAULT_READ_PAGE_BYTES = 8 * 1024;
const MAX_READ_PAGE_BYTES = 32 * 1024;
const READ_CURSOR_VERSION = 1;

interface ReadByteRange {
  readonly startByte: number;
  readonly endByte: number;
}

interface ReadCursorPayload {
  readonly version: typeof READ_CURSOR_VERSION;
  readonly path: string;
  readonly sha256: string;
  readonly offset: number;
}

export class ReadFileTool implements ToolPort {
  readonly name = "workspace.read";
  readonly definition = toolDefinition(
    this.name,
    "Read one bounded UTF-8 byte range and return the full-file SHA-256. Continue sequentially with nextCursor.",
    {
      path: { type: "string", description: "Workspace-relative file path." },
      cursor: {
        type: "string",
        description: "Opaque nextCursor from a prior read of the same unchanged file; mutually exclusive with range.",
      },
      range: {
        type: "object",
        description: "Optional exact UTF-8 byte range: startByte is inclusive and endByte is exclusive.",
        properties: {
          startByte: { type: "integer", minimum: 0 },
          endByte: { type: "integer", minimum: 0 },
        },
        required: ["startByte", "endByte"],
        additionalProperties: false,
      },
      maxBytes: {
        type: "integer",
        minimum: 4,
        maximum: MAX_READ_PAGE_BYTES,
        description: `Sequential page size in bytes; defaults to ${DEFAULT_READ_PAGE_BYTES} and cannot exceed ${MAX_READ_PAGE_BYTES}.`,
      },
    },
    ["path"],
    "observe",
  );

  constructor(
    private readonly workspace: WorkspaceBoundary,
    private readonly maxFileBytes = 1_000_000,
    private readonly versions?: WorkspaceVersionLedger,
  ) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    rejectUnknownFields(fields, ["path", "cursor", "range", "maxBytes"], this.name);
    const relativePath = stringField(fields, "path");
    const cursor = optionalReadCursor(fields);
    const requestedRange = optionalReadRange(fields);
    const pageBytes = optionalIntegerField(fields, "maxBytes") ?? DEFAULT_READ_PAGE_BYTES;
    if (pageBytes < 4 || pageBytes > MAX_READ_PAGE_BYTES) {
      throw new Error(`Field 'maxBytes' must be an integer from 4 through ${MAX_READ_PAGE_BYTES}.`);
    }
    if (cursor !== undefined && requestedRange !== undefined) {
      throw new Error("Fields 'cursor' and 'range' are mutually exclusive.");
    }
    if (requestedRange !== undefined && fields.maxBytes !== undefined) {
      throw new Error("Field 'maxBytes' cannot be combined with an exact 'range'.");
    }

    const file = await this.workspace.existing(relativePath);
    const metadata = await stat(file);
    if (!metadata.isFile()) return { ok: false, output: { error: "Path is not a file." } };
    if (metadata.size > this.maxFileBytes) {
      return { ok: false, output: { error: "File exceeds read limit.", bytes: metadata.size } };
    }

    const bytes = await readFile(file);
    if (bytes.byteLength > this.maxFileBytes) {
      return { ok: false, output: { error: "File exceeds read limit.", bytes: bytes.byteLength } };
    }
    if (!isValidUtf8(bytes)) {
      return { ok: false, output: { error: "File is not valid UTF-8." } };
    }

    const sha256 = contentHash(bytes);
    if (cursor !== undefined) {
      if (cursor.path !== relativePath) {
        throw new Error("Field 'cursor' was issued for a different path.");
      }
      if (cursor.sha256 !== sha256) {
        return {
          ok: false,
          output: {
            error: "File changed since the read cursor was issued.",
            expectedSha256: cursor.sha256,
            actualSha256: sha256,
          },
        };
      }
    }

    const range = requestedRange ?? sequentialReadRange(bytes, cursor?.offset ?? 0, pageBytes);
    validateReadRange(range, bytes);
    const contents = bytes.subarray(range.startByte, range.endByte).toString("utf8");
    const truncated = range.endByte < bytes.byteLength;
    const nextCursor = truncated
      ? encodeReadCursor({
        version: READ_CURSOR_VERSION,
        path: relativePath,
        sha256,
        offset: range.endByte,
      })
      : null;
    this.versions?.record(relativePath, sha256);
    return {
      ok: true,
      output: {
        path: relativePath,
        sha256,
        contents,
        totalBytes: bytes.byteLength,
        range: { startByte: range.startByte, endByte: range.endByte },
        truncated,
        nextCursor,
      },
    };
  }
}

export class WriteFileTool implements ToolPort {
  readonly name = "workspace.write";
  readonly definition = toolDefinition(
    this.name,
    "Create a UTF-8 file, or replace a previously read version using expectedSha256.",
    {
      path: { type: "string", description: "Workspace-relative file path." },
      contents: { type: "string", description: "Complete UTF-8 file contents." },
      expectedSha256: { type: ["string", "null"], description: "Hash returned by workspace.read, or null for a new file." },
    },
    ["path", "contents"],
    "mutate",
  );

  constructor(
    private readonly workspace: WorkspaceBoundary,
    private readonly versions?: WorkspaceVersionLedger,
    private readonly mutationPolicy?: WorkspaceMutationPolicy,
  ) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    const relativePath = stringField(fields, "path");
    const policyDenial = this.mutationPolicy?.check(relativePath);
    if (policyDenial !== undefined) return policyDenial;
    const contents = stringField(fields, "contents");
    const destination = await this.workspace.writable(relativePath);
    const suppliedSha256 = fields.expectedSha256;
    if (suppliedSha256 !== undefined && suppliedSha256 !== null && typeof suppliedSha256 !== "string") {
      throw new Error("Field 'expectedSha256' must be a string or null.");
    }
    const expectedSha256 = typeof suppliedSha256 === "string"
      ? suppliedSha256
      : this.versions?.get(relativePath);
    let existing: string | undefined;
    try {
      const existingPath = await this.workspace.existing(relativePath);
      existing = await readFile(existingPath, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    if (existing !== undefined) {
      if (typeof expectedSha256 !== "string") {
        return { ok: false, output: { error: "Overwriting a file requires expectedSha256 or a current read lease." } };
      }
      const actualSha256 = contentHash(existing);
      if (actualSha256 !== expectedSha256) {
        return { ok: false, output: { error: "File changed since it was read.", actualSha256 } };
      }
      if (existing === contents) {
        return { ok: false, output: { error: "Write rejected because contents are unchanged." } };
      }
    } else if (expectedSha256 !== undefined && expectedSha256 !== null) {
      return { ok: false, output: { error: "Cannot match expectedSha256 because the file does not exist." } };
    }

    await atomicWrite(destination, contents);
    this.versions?.record(relativePath, contentHash(contents));
    return {
      ok: true,
      output: { path: relativePath, bytes: Buffer.byteLength(contents), sha256: contentHash(contents) },
    };
  }
}

export class ReplaceTextTool implements ToolPort {
  readonly name = "workspace.replace";
  readonly definition = toolDefinition(
    this.name,
    "Replace one unique exact text occurrence in a previously read file.",
    {
      path: { type: "string", description: "Workspace-relative file path." },
      expectedSha256: { type: "string", description: "Hash returned by workspace.read." },
      before: { type: "string", description: "Exact unique text to replace." },
      after: { type: "string", description: "Replacement text." },
    },
    ["path", "before", "after"],
    "mutate",
  );

  constructor(
    private readonly workspace: WorkspaceBoundary,
    private readonly versions?: WorkspaceVersionLedger,
    private readonly mutationPolicy?: WorkspaceMutationPolicy,
  ) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    const relativePath = stringField(fields, "path");
    const policyDenial = this.mutationPolicy?.check(relativePath);
    if (policyDenial !== undefined) return policyDenial;
    const suppliedSha256 = fields.expectedSha256;
    if (suppliedSha256 !== undefined && typeof suppliedSha256 !== "string") {
      throw new Error("Field 'expectedSha256' must be a string.");
    }
    const expectedSha256 = suppliedSha256 ?? this.versions?.get(relativePath);
    const before = stringField(fields, "before");
    const after = stringField(fields, "after");
    if (before.length === 0) return { ok: false, output: { error: "Replacement target cannot be empty." } };

    const file = await this.workspace.existing(relativePath);
    const contents = await readFile(file, "utf8");
    const actualSha256 = contentHash(contents);
    if (expectedSha256 === undefined) {
      return { ok: false, output: { error: "Replacement requires expectedSha256 or a current read lease." } };
    }
    if (actualSha256 !== expectedSha256) {
      return { ok: false, output: { error: "File changed since it was read.", actualSha256 } };
    }

    const occurrences = countOccurrences(contents, before);
    if (occurrences !== 1) {
      return { ok: false, output: { error: "Replacement target must occur exactly once.", occurrences } };
    }
    const updated = contents.replace(before, after);
    await atomicWrite(this.workspace.lexical(relativePath), updated);
    this.versions?.record(relativePath, contentHash(updated));
    return {
      ok: true,
      output: { path: relativePath, replacements: 1, sha256: contentHash(updated) },
    };
  }
}

export class DeleteFileTool implements ToolPort {
  readonly name = "workspace.delete";
  readonly definition = toolDefinition(
    this.name,
    "Delete one previously read regular file within the mutation policy.",
    {
      path: { type: "string", description: "Workspace-relative file path." },
      expectedSha256: { type: "string", description: "Hash returned by workspace.read." },
    },
    ["path"],
    "mutate",
  );

  constructor(
    private readonly workspace: WorkspaceBoundary,
    private readonly versions?: WorkspaceVersionLedger,
    private readonly mutationPolicy?: WorkspaceMutationPolicy,
  ) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    const relativePath = stringField(fields, "path");
    const policyDenial = this.mutationPolicy?.check(relativePath);
    if (policyDenial !== undefined) return policyDenial;
    const suppliedSha256 = fields.expectedSha256;
    if (suppliedSha256 !== undefined && typeof suppliedSha256 !== "string") {
      throw new Error("Field 'expectedSha256' must be a string.");
    }
    const expectedSha256 = suppliedSha256 ?? this.versions?.get(relativePath);
    if (expectedSha256 === undefined) {
      return { ok: false, output: { error: "Deletion requires expectedSha256 or a current read lease." } };
    }
    const file = await this.workspace.existing(relativePath);
    const metadata = await stat(file);
    if (!metadata.isFile()) return { ok: false, output: { error: "Path is not a regular file." } };
    const contents = await readFile(file);
    const actualSha256 = createHash("sha256").update(contents).digest("hex");
    if (actualSha256 !== expectedSha256) {
      return { ok: false, output: { error: "File changed since it was read.", actualSha256 } };
    }
    await rm(file);
    this.versions?.forget(relativePath);
    return { ok: true, output: { path: relativePath, deleted: true, sha256: actualSha256 } };
  }
}

export class ListFilesTool implements ToolPort {
  readonly name = "workspace.list";
  readonly definition = toolDefinition(this.name, "Recursively list regular files within a workspace directory.", {
    path: { type: "string", description: "Optional workspace-relative directory; defaults to the root." },
  }, [], "observe");

  constructor(
    private readonly workspace: WorkspaceBoundary,
    private readonly maxEntries = 5_000,
  ) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    const requested = fields.path === undefined ? "." : stringField(fields, "path");
    const root = await this.workspace.existing(requested);
    const files: string[] = [];
    const queue = [root];

    while (queue.length > 0) {
      const directory = queue.shift();
      if (directory === undefined) break;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && !DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) queue.push(absolute);
        if (entry.isFile()) files.push(path.relative(this.workspace.root, absolute));
        if (files.length + queue.length > this.maxEntries) {
          return { ok: false, output: { error: "Workspace listing limit exceeded.", limit: this.maxEntries } };
        }
      }
    }

    files.sort();
    return { ok: true, output: { files } };
  }
}

export class SearchTextTool implements ToolPort {
  readonly name = "workspace.search";
  readonly definition = toolDefinition(
    this.name,
    "Search bounded UTF-8 workspace files for literal text and return source locations.",
    {
      query: { type: "string", description: "Literal text to find." },
      path: { type: "string", description: "Optional workspace-relative directory." },
      caseSensitive: { type: "boolean", description: "Whether letter case must match; defaults to true." },
    },
    ["query"],
    "observe",
  );

  constructor(
    private readonly workspace: WorkspaceBoundary,
    private readonly maxResults = 200,
    private readonly maxFileBytes = 2_000_000,
  ) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    const query = stringField(fields, "query");
    const requested = fields.path === undefined ? "." : stringField(fields, "path");
    const caseSensitive = fields.caseSensitive === undefined ? true : fields.caseSensitive;
    if (typeof caseSensitive !== "boolean") throw new Error("Field 'caseSensitive' must be a boolean.");
    if (query.length === 0) return { ok: false, output: { error: "Search query cannot be empty." } };

    const root = await this.workspace.existing(requested);
    const queue = [root];
    const matches: Array<{ path: string; line: number; column: number; text: string }> = [];
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    let truncated = false;

    while (queue.length > 0 && !truncated) {
      const directory = queue.shift();
      if (directory === undefined) break;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && !DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) {
          queue.push(absolute);
          continue;
        }
        if (entry.isDirectory()) continue;
        if (!entry.isFile()) continue;
        const metadata = await stat(absolute);
        if (metadata.size > this.maxFileBytes) continue;
        const buffer = await readFile(absolute);
        if (buffer.includes(0)) continue;
        const lines = buffer.toString("utf8").split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          const haystack = caseSensitive ? line : line.toLocaleLowerCase();
          const column = haystack.indexOf(needle);
          if (column === -1) continue;
          matches.push({
            path: path.relative(this.workspace.root, absolute),
            line: index + 1,
            column: column + 1,
            text: line.slice(0, 500),
          });
          if (matches.length >= this.maxResults) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
    }

    return { ok: true, output: { matches, truncated } };
  }
}

export function contentHash(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function atomicWrite(destination: string, contents: string): Promise<void> {
  const temporary = path.join(path.dirname(destination), `.vanguard-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function countOccurrences(contents: string, target: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = contents.indexOf(target, offset);
    if (found === -1) return count;
    count += 1;
    offset = found + target.length;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function rejectUnknownFields(
  fields: Record<string, JsonValue>,
  allowed: readonly string[],
  toolName: string,
): void {
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(fields).filter((field) => !allowedFields.has(field)).sort();
  if (unknown.length > 0) {
    throw new Error(`${toolName} received unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
  }
}

function optionalIntegerField(fields: Record<string, JsonValue>, name: string): number | undefined {
  const value = fields[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Field '${name}' must be an integer.`);
  }
  return value;
}

function optionalReadRange(fields: Record<string, JsonValue>): ReadByteRange | undefined {
  const value = fields.range;
  if (value === undefined) return undefined;
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Field 'range' must be an object.");
  }
  rejectUnknownFields(value, ["startByte", "endByte"], "workspace.read range");
  const startByte = optionalIntegerField(value, "startByte");
  const endByte = optionalIntegerField(value, "endByte");
  if (startByte === undefined || endByte === undefined) {
    throw new Error("Field 'range' requires integer 'startByte' and 'endByte' values.");
  }
  return { startByte, endByte };
}

function optionalReadCursor(fields: Record<string, JsonValue>): ReadCursorPayload | undefined {
  const value = fields.cursor;
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Field 'cursor' must be a string.");
  if (value.length === 0 || value.length > 8_192) throw new Error("Field 'cursor' is invalid.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Field 'cursor' is invalid.");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Field 'cursor' is invalid.");
  }
  const payload = parsed as Record<string, unknown>;
  const fieldsInCursor = Object.keys(payload).sort();
  if (fieldsInCursor.join(",") !== "offset,path,sha256,version") {
    throw new Error("Field 'cursor' is invalid.");
  }
  if (
    payload.version !== READ_CURSOR_VERSION
    || typeof payload.path !== "string"
    || typeof payload.sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(payload.sha256)
    || typeof payload.offset !== "number"
    || !Number.isSafeInteger(payload.offset)
    || payload.offset < 0
  ) {
    throw new Error("Field 'cursor' is invalid.");
  }
  return {
    version: READ_CURSOR_VERSION,
    path: payload.path,
    sha256: payload.sha256,
    offset: payload.offset,
  };
}

function encodeReadCursor(payload: ReadCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function sequentialReadRange(bytes: Buffer, startByte: number, maxBytes: number): ReadByteRange {
  if (!Number.isSafeInteger(startByte) || startByte < 0 || startByte > bytes.byteLength) {
    throw new Error("Read cursor offset is outside the file.");
  }
  if (!isUtf8Boundary(bytes, startByte)) {
    throw new Error("Read cursor offset is not on a UTF-8 character boundary.");
  }
  let endByte = Math.min(startByte + maxBytes, bytes.byteLength);
  while (endByte > startByte && endByte < bytes.byteLength && !isUtf8Boundary(bytes, endByte)) {
    endByte -= 1;
  }
  return { startByte, endByte };
}

function validateReadRange(range: ReadByteRange, bytes: Buffer): void {
  const { startByte, endByte } = range;
  if (
    !Number.isSafeInteger(startByte)
    || !Number.isSafeInteger(endByte)
    || startByte < 0
    || endByte < startByte
    || endByte > bytes.byteLength
  ) {
    throw new Error("Field 'range' must be within the file and use startByte <= endByte.");
  }
  if (endByte - startByte > MAX_READ_PAGE_BYTES) {
    throw new Error(`Field 'range' cannot exceed ${MAX_READ_PAGE_BYTES} bytes.`);
  }
  if (bytes.byteLength > 0 && startByte === endByte) {
    throw new Error("Field 'range' must not be empty for a non-empty file.");
  }
  if (!isUtf8Boundary(bytes, startByte) || !isUtf8Boundary(bytes, endByte)) {
    throw new Error("Field 'range' must begin and end on UTF-8 character boundaries.");
  }
}

function isUtf8Boundary(bytes: Buffer, offset: number): boolean {
  if (offset === 0 || offset === bytes.byteLength) return true;
  const byte = bytes[offset];
  return byte !== undefined && (byte & 0b1100_0000) !== 0b1000_0000;
}

function isValidUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function toolDefinition(
  name: string,
  description: string,
  properties: Record<string, JsonValue>,
  required: readonly string[],
  effect: NonNullable<ToolDefinition["effect"]>,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required: [...required], additionalProperties: false },
    effect,
  };
}
