import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import vm from "node:vm";
import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { objectInput, stringField } from "./input.js";
import { detectDegenerateRepetition, degenerateRepetitionError } from "./outputDegeneration.js";
import { WorkspaceBoundary } from "./workspace.js";
import { WorkspaceMutationPolicy } from "./mutationPolicy.js";
import { WorkspaceVersionLedger } from "./versionLedger.js";

const DEFAULT_IGNORED_DIRECTORIES = new Set([".git", ".vanguard", "node_modules", "dist", "coverage"]);
// Reads page one bounded range per model round-trip, so small pages tax big
// files with extra decisions: 64KB pages forced 8 round trips for a 500KB
// file. 256KB default / 1MB ceiling keeps paging safe while cutting trips.
const DEFAULT_READ_PAGE_BYTES = 256 * 1024;
const MAX_READ_PAGE_BYTES = 1024 * 1024;
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
  readonly name = "read_file";
  readonly definition = toolDefinition(
    this.name,
    "Read one bounded UTF-8 byte range and return the full-file SHA-256. Continue sequentially with nextCursor.",
    {
      path: { type: "string", description: "Workspace-relative file path." },
      cursor: {
        type: "string",
        description: "Opaque nextCursor from a prior read of the same unchanged file. Omit it for a first read; an empty string is treated as omitted. Mutually exclusive with range.",
      },
      range: {
        type: "object",
        description: "Optional approximate UTF-8 byte range: startByte is inclusive and endByte is exclusive. Bounds are clamped to the file, one page, and complete UTF-8 characters; the response reports the range actually read with totalBytes and nextCursor.",
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
        description: `Sequential page size in bytes; defaults to ${DEFAULT_READ_PAGE_BYTES} and cannot exceed ${MAX_READ_PAGE_BYTES}. It is ignored when an exact range is supplied.`,
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
    const relativePath = this.workspace.relativize(stringField(fields, "path"));
    const cursor = optionalReadCursor(fields);
    const requestedRange = optionalReadRange(fields);
    const pageBytes = optionalIntegerField(fields, "maxBytes") ?? DEFAULT_READ_PAGE_BYTES;
    if (pageBytes < 4 || pageBytes > MAX_READ_PAGE_BYTES) {
      throw new Error(`Field 'maxBytes' must be an integer from 4 through ${MAX_READ_PAGE_BYTES}.`);
    }
    if (cursor !== undefined && requestedRange !== undefined) {
      throw new Error("Fields 'cursor' and 'range' are mutually exclusive.");
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

    const range = requestedRange === undefined
      ? sequentialReadRange(bytes, cursor?.offset ?? 0, pageBytes)
      : resolveReadRange(requestedRange, bytes);
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
  readonly name = "write_file";
  readonly definition = toolDefinition(
    this.name,
    "Create a UTF-8 file, or replace a previously read version using expectedSha256.",
    {
      path: { type: "string", description: "Workspace-relative file path." },
      contents: { type: "string", description: "Complete UTF-8 file contents." },
      contents_size: { type: "integer", minimum: 0, description: "Optional provider-supplied size metadata. Ignored; contents remains authoritative." },
      expectedSha256: { type: ["string", "null"], description: "Hash returned by read_file, or null for a new file." },
      allowRepetition: { type: "boolean", description: "Acknowledge that heavily repeated identical lines are intentional; without it the degeneration guard rejects them." },
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
    const relativePath = this.workspace.relativize(stringField(fields, "path"));
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

    if (optionalBooleanField(fields, "allowRepetition") !== true) {
      const degenerate = detectDegenerateRepetition(contents, existing);
      if (degenerate !== undefined) {
        return {
          ok: false,
          output: {
            error: degenerateRepetitionError(degenerate),
            line: degenerate.line,
            count: degenerate.count,
            startLine: degenerate.startLine,
            kind: degenerate.kind,
          },
        };
      }
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
  readonly name = "edit_file";
  readonly definition = toolDefinition(
    this.name,
    "Replace one unique exact text occurrence in a previously read file.",
    {
      path: { type: "string", description: "Workspace-relative file path." },
      expectedSha256: { type: "string", description: "Hash returned by read_file." },
      before: { type: "string", description: "Exact unique text to replace." },
      after: { type: "string", description: "Replacement text." },
      allowRepetition: { type: "boolean", description: "Acknowledge that heavily repeated identical lines are intentional; without it the degeneration guard rejects them." },
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
    const relativePath = this.workspace.relativize(stringField(fields, "path"));
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
    // A function replacement keeps `after` byte-literal: string replacement
    // would reinterpret $&, $', $`, and $$ as substitution patterns.
    const updated = contents.replace(before, () => after);
    if (optionalBooleanField(fields, "allowRepetition") !== true) {
      const degenerate = detectDegenerateRepetition(updated, contents);
      if (degenerate !== undefined) {
        return {
          ok: false,
          output: {
            error: degenerateRepetitionError(degenerate),
            line: degenerate.line,
            count: degenerate.count,
            startLine: degenerate.startLine,
            kind: degenerate.kind,
          },
        };
      }
    }
    await atomicWrite(this.workspace.lexical(relativePath), updated);
    this.versions?.record(relativePath, contentHash(updated));
    return {
      ok: true,
      output: { path: relativePath, replacements: 1, sha256: contentHash(updated) },
    };
  }
}

export class DeleteFileTool implements ToolPort {
  readonly name = "delete_file";
  readonly definition = toolDefinition(
    this.name,
    "Delete one previously read regular file within the mutation policy.",
    {
      path: { type: "string", description: "Workspace-relative file path." },
      expectedSha256: { type: "string", description: "Hash returned by read_file." },
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
    const relativePath = this.workspace.relativize(stringField(fields, "path"));
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
  readonly name = "list_dir";
  readonly definition = toolDefinition(this.name, "Recursively list regular files within a workspace directory.", {
    path: { type: "string", description: "Optional workspace-relative directory; defaults to the root." },
  }, [], "observe");

  constructor(
    private readonly workspace: WorkspaceBoundary,
    private readonly maxEntries = 5_000,
  ) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    const requested = this.workspace.relativize(optionalWorkspacePath(fields));
    const root = await this.workspace.existing(requested);
    const files: string[] = [];
    // Level-parallel BFS: directories of one depth are listed concurrently,
    // then consumed in discovery order so limits stay deterministic. Oversized
    // trees truncate shallow-first instead of failing — a huge Desktop
    // workspace still yields its most relevant (least nested) files.
    let level = [root];
    let truncated = false;
    while (level.length > 0 && !truncated) {
      const listings = await Promise.all(level.map(async (directory) => ({
        directory,
        entries: await readdir(directory, { withFileTypes: true }),
      })));
      const next: string[] = [];
      for (const { entries, directory } of listings) {
        for (const entry of entries) {
          const absolute = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory() && !DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) next.push(absolute);
          if (entry.isFile()) {
            if (files.length >= this.maxEntries) { truncated = true; break; }
            files.push(path.relative(this.workspace.root, absolute));
          }
        }
        if (truncated) break;
      }
      level = next;
    }

    files.sort();
    if (truncated) {
      return {
        ok: true,
        output: {
          files,
          truncated: true,
          note: `Listing truncated at ${this.maxEntries} files (shallowest first). Narrow with the 'path' argument or use glob/grep to reach deeper entries.`,
        },
      };
    }
    return { ok: true, output: { files } };
  }
}

type SearchMatch = { [key: string]: JsonValue };

const MAX_SEARCH_PATTERN_LENGTH = 512;
const MAX_SEARCH_CONTEXT_LINES = 5;
const REGEX_FILE_TIMEOUT_MS = 250;
const REGEX_SEARCH_BUDGET_MS = 5_000;

export class SearchTextTool implements ToolPort {
  readonly name = "grep";
  readonly definition = toolDefinition(
    this.name,
    "Search bounded UTF-8 workspace files for literal text (default) or a regular expression, and return source locations with optional context lines.",
    {
      query: { type: "string", description: "Literal text, or a JavaScript regular expression when regex is true." },
      path: { type: "string", description: "Optional workspace-relative file or directory. An empty string searches the workspace root." },
      caseSensitive: { type: "boolean", description: "Whether letter case must match; defaults to true." },
      regex: { type: "boolean", description: "Interpret query as a regular expression matched per line; defaults to false." },
      filePattern: {
        type: "string",
        description: "Optional glob restricting searched files, e.g. 'src/**/*.ts' or '*.java'. A pattern without '/' matches file names anywhere.",
      },
      context: {
        type: "integer",
        minimum: 0,
        maximum: MAX_SEARCH_CONTEXT_LINES,
        description: "Lines of surrounding context to include with each match; defaults to 0.",
      },
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
    rejectUnknownFields(fields, ["query", "path", "caseSensitive", "regex", "filePattern", "context"], this.name);
    const query = stringField(fields, "query");
    const requested = this.workspace.relativize(optionalWorkspacePath(fields));
    const caseSensitive = optionalBooleanField(fields, "caseSensitive") ?? true;
    const useRegex = optionalBooleanField(fields, "regex") ?? false;
    const contextLines = optionalIntegerField(fields, "context") ?? 0;
    if (contextLines < 0 || contextLines > MAX_SEARCH_CONTEXT_LINES) {
      throw new Error(`Field 'context' must be an integer from 0 through ${MAX_SEARCH_CONTEXT_LINES}.`);
    }
    if (query.length === 0) return { ok: false, output: { error: "Search query cannot be empty." } };
    if (query.length > MAX_SEARCH_PATTERN_LENGTH) {
      return { ok: false, output: { error: "Search query exceeds the pattern length limit.", limit: MAX_SEARCH_PATTERN_LENGTH } };
    }

    let pathFilter: ((relative: string) => boolean) | undefined;
    if (fields.filePattern !== undefined) {
      const pattern = stringField(fields, "filePattern");
      try {
        pathFilter = compileGlob(pattern);
      } catch (error) {
        return { ok: false, output: { error: `Invalid file pattern: ${(error as Error).message}` } };
      }
    }

    let matcher: LineMatcher;
    if (useRegex) {
      try {
        matcher = compileRegexMatcher(query, caseSensitive);
      } catch (error) {
        return { ok: false, output: { error: `Invalid regular expression: ${(error as Error).message}` } };
      }
    } else {
      matcher = literalMatcher(query, caseSensitive);
    }

    const root = await this.workspace.existing(requested);
    const rootMetadata = await stat(root);
    if (!rootMetadata.isFile() && !rootMetadata.isDirectory()) {
      return { ok: false, output: { error: "Search path is not a regular file or directory." } };
    }
    const requestedFile = rootMetadata.isFile()
      ? normalizeToolPath(path.relative(this.workspace.root, root))
      : undefined;
    const matches: SearchMatch[] = [];
    const deadline = Date.now() + REGEX_SEARCH_BUDGET_MS;
    let truncated = false;

    // Phase 1 — level-parallel BFS collects candidate files in the same
    // deterministic order the serial walk produced.
    const candidates: Array<{ absolute: string; relative: string }> = [];
    let level = [requestedFile === undefined ? root : path.dirname(root)];
    while (level.length > 0) {
      const listings = await Promise.all(level.map(async (directory) => ({
        directory,
        entries: await readdir(directory, { withFileTypes: true }),
      })));
      const next: string[] = [];
      for (const { directory, entries } of listings) {
        for (const entry of entries) {
          const absolute = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory() && requestedFile === undefined && !DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) {
            next.push(absolute);
            continue;
          }
          if (entry.isDirectory()) continue;
          if (!entry.isFile()) continue;
          const relative = normalizeToolPath(path.relative(this.workspace.root, absolute));
          if (requestedFile !== undefined && relative !== requestedFile) continue;
          if (pathFilter !== undefined && !pathFilter(relative)) continue;
          candidates.push({ absolute, relative });
        }
      }
      level = next;
    }

    // Phase 2 — bounded read-ahead keeps several file loads in flight while
    // matching consumes results strictly in candidate order, so match output
    // and truncation are identical to a serial scan.
    const READ_AHEAD = 8;
    const skipped = Symbol("skipped");
    type Loaded = { buffer: Buffer | typeof skipped } | { failure: unknown };
    const pending = new Map<number, Promise<Loaded>>();
    const load = async (candidate: { absolute: string }): Promise<Buffer | typeof skipped> => {
      const metadata = await stat(candidate.absolute);
      if (metadata.size > this.maxFileBytes) return skipped;
      const buffer = await readFile(candidate.absolute);
      return buffer.includes(0) ? skipped : buffer;
    };
    const ensureLoading = (index: number): void => {
      if (index >= candidates.length || pending.has(index)) return;
      pending.set(index, load(candidates[index]!).then(
        (buffer) => ({ buffer }),
        (failure: unknown) => ({ failure }),
      ));
    };

    for (let index = 0; index < candidates.length && !truncated; index += 1) {
      for (let ahead = index; ahead < index + READ_AHEAD; ahead += 1) ensureLoading(ahead);
      const outcome = await pending.get(index)!;
      pending.delete(index);
      if ("failure" in outcome) throw outcome.failure;
      if (outcome.buffer === skipped) continue;
      const buffer = outcome.buffer;
      const relative = candidates[index]!.relative;
      if (useRegex && Date.now() > deadline) {
        return { ok: false, output: { error: "Regex search exceeded its time budget; narrow the pattern, path, or filePattern.", matches, truncated: true } };
      }
      {
        const lines = buffer.toString("utf8").split(/\r?\n/u);
        let fileHits: ReadonlyArray<{ line: number; column: number }>;
        try {
          fileHits = matcher(lines, this.maxResults - matches.length);
        } catch (error) {
          if (isRegexTimeout(error)) {
            return { ok: false, output: { error: `Regular expression is too expensive: matching timed out in ${relative}. Simplify the pattern.` } };
          }
          throw error;
        }
        // A trailing newline makes split produce one empty final segment that
        // is not a real source line; keep it out of context windows.
        const lineCount = lines.at(-1) === "" ? lines.length - 1 : lines.length;
        for (const hit of fileHits) {
          const line = lines[hit.line] ?? "";
          matches.push({
            path: relative,
            line: hit.line + 1,
            column: hit.column + 1,
            text: line.slice(0, 500),
            ...(contextLines > 0 ? {
              before: lines.slice(Math.max(0, hit.line - contextLines), hit.line).map((value) => value.slice(0, 500)),
              after: lines.slice(hit.line + 1, Math.min(lineCount, hit.line + 1 + contextLines)).map((value) => value.slice(0, 500)),
            } : {}),
          });
          if (matches.length >= this.maxResults) {
            truncated = true;
            break;
          }
        }
      }
    }

    return { ok: true, output: { matches, truncated } };
  }
}

export class GlobTool implements ToolPort {
  readonly name = "glob";
  readonly definition = toolDefinition(
    this.name,
    "List workspace files matching a glob pattern, e.g. 'src/**/*.ts' or '*.md'. A pattern without '/' matches file names anywhere.",
    {
      pattern: { type: "string", description: "Glob pattern with *, **, ?, and character classes." },
      path: { type: "string", description: "Optional workspace-relative directory; defaults to the root." },
    },
    ["pattern"],
    "observe",
  );

  constructor(
    private readonly workspace: WorkspaceBoundary,
    private readonly maxEntries = 5_000,
  ) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    rejectUnknownFields(fields, ["pattern", "path"], this.name);
    const pattern = stringField(fields, "pattern");
    const requested = this.workspace.relativize(optionalWorkspacePath(fields));
    let matches: (relative: string) => boolean;
    try {
      matches = compileGlob(pattern);
    } catch (error) {
      return { ok: false, output: { error: `Invalid glob pattern: ${(error as Error).message}` } };
    }

    const root = await this.workspace.existing(requested);
    const rootRelativePrefix = normalizeToolPath(path.relative(this.workspace.root, root));
    const files: string[] = [];
    let scanned = 0;
    let truncated = false;

    // Level-parallel BFS: directories of one depth are listed concurrently,
    // then consumed in discovery order so scan limits stay deterministic.
    let level = [root];
    while (level.length > 0 && !truncated) {
      const listings = await Promise.all(level.map(async (directory) => ({
        directory,
        entries: await readdir(directory, { withFileTypes: true }),
      })));
      const next: string[] = [];
      for (const { directory, entries } of listings) {
        if (truncated) break;
        for (const entry of entries) {
          const absolute = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory() && !DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) next.push(absolute);
          if (!entry.isFile()) continue;
          scanned += 1;
          if (scanned > this.maxEntries * 20) {
            truncated = true;
            break;
          }
          const workspaceRelative = normalizeToolPath(path.relative(this.workspace.root, absolute));
          // Patterns are evaluated relative to the searched directory so
          // 'src/**/*.ts' behaves the same from the root and from src's parent.
          const patternRelative = rootRelativePrefix === ""
            ? workspaceRelative
            : workspaceRelative.slice(rootRelativePrefix.length + 1);
          if (!matches(patternRelative)) continue;
          files.push(workspaceRelative);
          if (files.length >= this.maxEntries) {
            truncated = true;
            break;
          }
        }
      }
      level = next;
    }

    files.sort();
    return { ok: true, output: { files, truncated } };
  }
}

type LineMatcher = (lines: readonly string[], remaining: number) => ReadonlyArray<{ line: number; column: number }>;

function literalMatcher(query: string, caseSensitive: boolean): LineMatcher {
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  return (lines, remaining) => {
    const hits: Array<{ line: number; column: number }> = [];
    for (let index = 0; index < lines.length && hits.length < remaining; index += 1) {
      const line = lines[index] ?? "";
      const haystack = caseSensitive ? line : line.toLocaleLowerCase();
      const column = haystack.indexOf(needle);
      if (column !== -1) hits.push({ line: index, column });
    }
    return hits;
  };
}

class RegexTimeoutError extends Error {}

function isRegexTimeout(error: unknown): boolean {
  return error instanceof RegexTimeoutError;
}

/**
 * Compiles a model-authored regular expression into a per-line matcher that
 * executes inside a vm context with a hard timeout: V8 interrupts runaway
 * backtracking, so a catastrophic pattern fails the tool call instead of
 * hanging the runtime.
 */
function compileRegexMatcher(source: string, caseSensitive: boolean): LineMatcher {
  const flags = caseSensitive ? "u" : "iu";
  const compiled = new RegExp(source, flags);
  return (lines, remaining) => {
    const sandbox = { re: compiled, lines, cap: Math.max(0, remaining), out: [] as number[] };
    try {
      runInTimedContext(sandbox);
    } catch (error) {
      // The timeout error is constructed in the sandbox realm, so it fails
      // instanceof Error here; the Node error code is realm-independent.
      if ((error as { code?: unknown } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        throw new RegexTimeoutError("Regular expression matching timed out.");
      }
      throw error;
    }
    const hits: Array<{ line: number; column: number }> = [];
    for (let index = 0; index + 1 < sandbox.out.length; index += 2) {
      hits.push({ line: sandbox.out[index]!, column: sandbox.out[index + 1]! });
    }
    return hits;
  };
}

function runInTimedContext(sandbox: { re: RegExp; lines: readonly string[]; cap: number; out: number[] }): void {
  vm.runInNewContext(
    "for (let i = 0; i < lines.length && out.length / 2 < cap; i += 1) { const m = re.exec(lines[i]); if (m !== null) { out.push(i, m.index); } re.lastIndex = 0; }",
    sandbox,
    { timeout: REGEX_FILE_TIMEOUT_MS },
  );
}

/**
 * Translates a bounded glob subset into a RegExp over '/'-separated relative
 * paths: '**' spans directories, '*' and '?' stay within one segment, and
 * '[...]' character classes pass through. Everything else is literal.
 */
function compileGlob(pattern: string): (relative: string) => boolean {
  if (pattern.length === 0) throw new Error("pattern cannot be empty");
  if (pattern.length > MAX_SEARCH_PATTERN_LENGTH) throw new Error("pattern is too long");
  if (pattern.includes("\\")) throw new Error("use '/' as the path separator");
  const matchBasename = !pattern.includes("/");
  let regex = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        // '**/' also matches zero directories.
        if (pattern[index + 2] === "/") {
          regex += "(?:[^/]+/)*";
          index += 3;
        } else {
          regex += ".*";
          index += 2;
        }
      } else {
        regex += "[^/]*";
        index += 1;
      }
    } else if (char === "?") {
      regex += "[^/]";
      index += 1;
    } else if (char === "[") {
      const closing = pattern.indexOf("]", index + 2);
      if (closing === -1) throw new Error("unterminated character class");
      const body = pattern.slice(index + 1, closing);
      if (body.includes("/")) throw new Error("character classes cannot contain '/'");
      regex += `[${body.replaceAll("\\", "\\\\")}]`;
      index = closing + 1;
    } else {
      regex += char.replace(/[.+^${}()|\\]/u, "\\$&");
      index += 1;
    }
  }
  const full = new RegExp(`^${regex}$`, "u");
  return (relative) => {
    if (matchBasename) {
      const basename = relative.split("/").at(-1) ?? relative;
      return full.test(basename);
    }
    return full.test(relative);
  };
}

function normalizeToolPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function optionalBooleanField(fields: Record<string, JsonValue>, name: string): boolean | undefined {
  const value = fields[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Field '${name}' must be a boolean.`);
  return value;
}

export function contentHash(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function atomicWrite(destination: string, contents: string): Promise<void> {
  const temporary = path.join(path.dirname(destination), `.vanguard-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await renameWithRetry(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * On OneDrive-synced folders the Windows sync client briefly holds a handle
 * on a freshly written file, so `rename(temp, dest)` EPERM-fails even though
 * nothing is actually wrong. Retry only the transient lock codes (EPERM,
 * EACCES, EBUSY) with a short backoff; anything else throws immediately.
 * The rename operation is injectable so the retry policy is testable.
 */
export async function renameWithRetry(
  source: string,
  destination: string,
  renameOperation: (source: string, destination: string) => Promise<void> = rename,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameOperation(source, destination);
      return;
    } catch (error) {
      const retryable = error instanceof Error && "code" in error
        && (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY");
      if (!retryable || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
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

function optionalWorkspacePath(fields: Record<string, JsonValue>): string {
  if (fields.path === undefined) return ".";
  const requested = stringField(fields, "path");
  return requested.length === 0 ? "." : requested;
}

function optionalReadRange(fields: Record<string, JsonValue>): ReadByteRange | undefined {
  const value = fields.range;
  if (value === undefined) return undefined;
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Field 'range' must be an object.");
  }
  rejectUnknownFields(value, ["startByte", "endByte"], "read_file range");
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
  if (value.length === 0) return undefined;
  if (value.length > 8_192) throw new Error("Field 'cursor' is invalid.");

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

/**
 * Resolve a requested range against the real file.
 *
 * Overshooting the end of a file is a normal request, not a caller error: the
 * length is only knowable by reading, so demanding an exact endByte up front
 * forces a guess-and-retry loop that burns turns and teaches nothing. This
 * clamps to the file and to one page — exactly what the cursor path already
 * does — and the result reports the range actually read next to totalBytes and
 * nextCursor, so the caller can always continue. Model-supplied byte offsets
 * are estimates: starts past EOF become an EOF read, and offsets inside a
 * multi-byte character expand to the nearest safe boundaries. Only a genuinely
 * incoherent range (inverted, negative, or unsafe integers) is refused.
 */
function resolveReadRange(range: ReadByteRange, bytes: Buffer): ReadByteRange {
  if (
    !Number.isSafeInteger(range.startByte)
    || !Number.isSafeInteger(range.endByte)
    || range.startByte < 0
    || range.endByte < range.startByte
  ) {
    throw new Error("Field 'range' must use safe integers with 0 <= startByte <= endByte.");
  }

  const clampedStart = Math.min(range.startByte, bytes.byteLength);
  let startByte = clampedStart;
  while (startByte > 0 && !isUtf8Boundary(bytes, startByte)) {
    startByte -= 1;
  }
  const requestedEnd = Math.min(range.endByte, bytes.byteLength, startByte + MAX_READ_PAGE_BYTES);
  let endByte = requestedEnd;
  while (endByte > startByte && endByte < bytes.byteLength && !isUtf8Boundary(bytes, endByte)) {
    endByte -= 1;
  }

  if (startByte === endByte && range.endByte > range.startByte && startByte < bytes.byteLength) {
    // A narrow approximate range may land entirely inside one character.
    // Include that complete character instead of returning a misleading empty page.
    endByte = Math.min(bytes.byteLength, startByte + 1);
    while (endByte < bytes.byteLength && !isUtf8Boundary(bytes, endByte)) {
      endByte += 1;
    }
  } else if (startByte === endByte && range.endByte === range.startByte && clampedStart < bytes.byteLength) {
    throw new Error("Field 'range' must not be empty for a non-empty file.");
  }
  return { startByte, endByte };
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
