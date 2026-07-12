import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { objectInput, stringField } from "./input.js";
import { WorkspaceBoundary } from "./workspace.js";
import { WorkspaceVersionLedger } from "./versionLedger.js";

const DEFAULT_IGNORED_DIRECTORIES = new Set([".git", ".vanguard", "node_modules", "dist", "coverage"]);

export class ReadFileTool implements ToolPort {
  readonly name = "workspace.read";
  readonly definition = toolDefinition(this.name, "Read a UTF-8 file and return its contents and SHA-256 version.", {
    path: { type: "string", description: "Workspace-relative file path." },
  }, ["path"]);

  constructor(
    private readonly workspace: WorkspaceBoundary,
    private readonly maxBytes = 1_000_000,
    private readonly versions?: WorkspaceVersionLedger,
  ) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const relativePath = stringField(objectInput(input), "path");
    const file = await this.workspace.existing(relativePath);
    const metadata = await stat(file);
    if (!metadata.isFile()) return { ok: false, output: { error: "Path is not a file." } };
    if (metadata.size > this.maxBytes) {
      return { ok: false, output: { error: "File exceeds read limit.", bytes: metadata.size } };
    }
    const contents = await readFile(file, "utf8");
    const sha256 = contentHash(contents);
    this.versions?.record(relativePath, sha256);
    return { ok: true, output: { path: relativePath, sha256, contents } };
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
  );

  constructor(
    private readonly workspace: WorkspaceBoundary,
    private readonly versions?: WorkspaceVersionLedger,
  ) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    const relativePath = stringField(fields, "path");
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
  );

  constructor(
    private readonly workspace: WorkspaceBoundary,
    private readonly versions?: WorkspaceVersionLedger,
  ) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    const relativePath = stringField(fields, "path");
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

export class ListFilesTool implements ToolPort {
  readonly name = "workspace.list";
  readonly definition = toolDefinition(this.name, "Recursively list regular files within a workspace directory.", {
    path: { type: "string", description: "Optional workspace-relative directory; defaults to the root." },
  }, []);

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

function toolDefinition(
  name: string,
  description: string,
  properties: Record<string, JsonValue>,
  required: readonly string[],
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required: [...required], additionalProperties: false },
  };
}
