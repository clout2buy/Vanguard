import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { objectInput, stringField } from "./input.js";
import { loadWorkspaceTypeScript, type TypeScriptLoader } from "./progressiveVerification.js";
import { WorkspaceBoundary } from "./workspace.js";

/**
 * Symbol-grade code intelligence: definition, references, and hover info via
 * the target workspace's own TypeScript LanguageService — the same compiler
 * the project builds with, driven in-process with zero new dependencies.
 *
 * This is the difference between navigating by grep and navigating by IDE:
 * "who calls this?" becomes one exact answer instead of a dozen text
 * searches whose hits still need reading. Repos without a resolvable
 * `typescript` module or tsconfig degrade to an honest refusal that points
 * the model back at grep.
 */

const MAX_PROJECT_FILES = 4_000;
const MAX_RESULTS = 60;

interface LanguageServiceLike {
  getDefinitionAtPosition(file: string, position: number): readonly { fileName: string; textSpan: { start: number } }[] | undefined;
  getReferencesAtPosition(file: string, position: number): readonly { fileName: string; textSpan: { start: number }; isWriteAccess?: boolean }[] | undefined;
  getQuickInfoAtPosition(file: string, position: number): { displayParts?: readonly { text: string }[]; documentation?: readonly { text: string }[] } | undefined;
}

interface TsForIntel {
  findConfigFile(searchPath: string, exists: (file: string) => boolean): string | undefined;
  readConfigFile(file: string, read: (file: string) => string | undefined): { config?: unknown; error?: unknown };
  parseJsonConfigFileContent(json: unknown, host: unknown, basePath: string): { fileNames: string[]; options: unknown };
  createLanguageService(host: unknown): LanguageServiceLike;
  sys: { fileExists(file: string): boolean; readFile(file: string): string | undefined; readDirectory(...parts: unknown[]): string[]; useCaseSensitiveFileNames: boolean; getCurrentDirectory(): string; directoryExists(dir: string): boolean; getDirectories(dir: string): string[] };
  getDefaultLibFilePath(options: unknown): string;
  ScriptSnapshot: { fromString(text: string): unknown };
}

export class CodeIntelTool implements ToolPort {
  readonly name = "code_intel";
  readonly definition: ToolDefinition = {
    name: this.name,
    description: "Symbol-aware navigation via the project's own TypeScript compiler: exact definition sites, every reference (callers included), or hover type info for a named symbol. Far more precise than grep for 'who calls this' and 'where is this defined' questions in TypeScript/JavaScript projects.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file that contains an occurrence of the symbol." },
        line: { type: "integer", minimum: 1, description: "1-based line number of that occurrence." },
        symbol: { type: "string", description: "The identifier on that line to analyze." },
        query: { type: "string", enum: ["definition", "references", "info"], description: "What to look up." },
      },
      required: ["path", "line", "symbol", "query"],
      additionalProperties: false,
    },
    effect: "observe",
  };

  #service: { service: LanguageServiceLike; ts: TsForIntel; rootFiles: readonly string[] } | null | undefined;

  constructor(
    private readonly workspace: WorkspaceBoundary,
    private readonly typescriptLoader: TypeScriptLoader = loadWorkspaceTypeScript,
  ) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    const relativePath = stringField(fields, "path");
    const symbol = stringField(fields, "symbol");
    const query = stringField(fields, "query");
    const line = fields.line;
    if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) {
      throw new Error("Field 'line' must be a positive integer.");
    }
    if (query !== "definition" && query !== "references" && query !== "info") {
      throw new Error("Field 'query' must be definition, references, or info.");
    }

    const runtime = await this.#languageService();
    if (runtime === null) {
      return {
        ok: false,
        output: { error: "Code intelligence needs a resolvable `typescript` module and a tsconfig in this workspace; use grep instead." },
      };
    }
    const absolute = await this.workspace.existing(relativePath);
    let text: string;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      return { ok: false, output: { error: "The file could not be read." } };
    }
    const lines = text.split(/\r?\n/u);
    const lineText = lines[line - 1];
    if (lineText === undefined) {
      return { ok: false, output: { error: `The file has only ${lines.length} lines.` } };
    }
    const column = lineText.indexOf(symbol);
    if (column === -1) {
      return { ok: false, output: { error: `'${symbol}' does not occur on line ${line}. Line content: ${lineText.trim().slice(0, 200)}` } };
    }
    const position = lines.slice(0, line - 1).reduce((sum, current) => sum + current.length + 1, 0) + column;

    const normalizedAbsolute = absolute.replaceAll("\\", "/");
    if (query === "info") {
      const info = runtime.service.getQuickInfoAtPosition(normalizedAbsolute, position);
      if (info === undefined) return { ok: false, output: { error: `No type information at '${symbol}' (${relativePath}:${line}).` } };
      return {
        ok: true,
        output: {
          symbol,
          type: (info.displayParts ?? []).map((part) => part.text).join("").slice(0, 1_000),
          documentation: (info.documentation ?? []).map((part) => part.text).join("\n").slice(0, 1_000),
        },
      };
    }

    const spans = query === "definition"
      ? runtime.service.getDefinitionAtPosition(normalizedAbsolute, position)
      : runtime.service.getReferencesAtPosition(normalizedAbsolute, position);
    if (spans === undefined || spans.length === 0) {
      return { ok: false, output: { error: `No ${query} results for '${symbol}' (${relativePath}:${line}).` } };
    }
    const results: JsonValue[] = [];
    for (const span of spans.slice(0, MAX_RESULTS)) {
      const location = this.#locate(span.fileName, span.textSpan.start);
      if (location === undefined) continue;
      results.push({
        path: location.relative,
        line: location.line,
        text: location.lineText.trim().slice(0, 240),
        ...(query === "references" && (span as { isWriteAccess?: boolean }).isWriteAccess === true ? { write: true } : {}),
      });
    }
    return {
      ok: true,
      output: { symbol, query, results, ...(spans.length > MAX_RESULTS ? { truncated: true, total: spans.length } : {}) },
    };
  }

  #locate(fileName: string, start: number): { relative: string; line: number; lineText: string } | undefined {
    try {
      const text = readFileSync(fileName, "utf8");
      const before = text.slice(0, start);
      const line = before.split("\n").length;
      const lineText = text.split(/\r?\n/u)[line - 1] ?? "";
      const relative = path.relative(this.workspace.root, fileName).replaceAll("\\", "/");
      // Results inside node_modules or lib.d.ts are real answers too, but the
      // model can only act on workspace files; label externals clearly.
      return { relative: relative.startsWith("..") ? fileName.replaceAll("\\", "/") : relative, line, lineText };
    } catch {
      return undefined;
    }
  }

  async #languageService(): Promise<{ service: LanguageServiceLike; ts: TsForIntel; rootFiles: readonly string[] } | null> {
    if (this.#service !== undefined) return this.#service;
    const module = await this.typescriptLoader(this.workspace.root).catch(() => undefined);
    const ts = module as unknown as TsForIntel | undefined;
    if (ts === undefined || typeof ts.createLanguageService !== "function") {
      this.#service = null;
      return null;
    }
    const configFile = ts.findConfigFile(this.workspace.root, ts.sys.fileExists.bind(ts.sys));
    if (configFile === undefined) {
      this.#service = null;
      return null;
    }
    const parsedJson = ts.readConfigFile(configFile, ts.sys.readFile.bind(ts.sys));
    if (parsedJson.config === undefined) {
      this.#service = null;
      return null;
    }
    const parsed = ts.parseJsonConfigFileContent(parsedJson.config, ts.sys, path.dirname(configFile));
    if (parsed.fileNames.length === 0 || parsed.fileNames.length > MAX_PROJECT_FILES) {
      this.#service = null;
      return null;
    }
    const rootFiles = parsed.fileNames.map((file) => file.replaceAll("\\", "/"));
    // Script versions track mtime+size, so edits made mid-run are seen by the
    // next query without rebuilding the service.
    const version = (file: string): string => {
      try {
        const metadata = statSync(file);
        return `${metadata.mtimeMs}:${metadata.size}`;
      } catch {
        return "missing";
      }
    };
    const host = {
      getScriptFileNames: () => [...rootFiles],
      getScriptVersion: version,
      getScriptSnapshot: (file: string) => {
        try {
          return ts.ScriptSnapshot.fromString(readFileSync(file, "utf8"));
        } catch {
          return undefined;
        }
      },
      getCurrentDirectory: () => this.workspace.root,
      getCompilationSettings: () => parsed.options,
      getDefaultLibFileName: (options: unknown) => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists.bind(ts.sys),
      readFile: ts.sys.readFile.bind(ts.sys),
      readDirectory: ts.sys.readDirectory.bind(ts.sys),
      directoryExists: ts.sys.directoryExists.bind(ts.sys),
      getDirectories: ts.sys.getDirectories.bind(ts.sys),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    this.#service = { service: ts.createLanguageService(host), ts, rootFiles };
    return this.#service;
  }
}
