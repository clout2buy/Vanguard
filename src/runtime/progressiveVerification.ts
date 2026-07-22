import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { LANGUAGE_PROFILES, type SupportTier } from "./repositoryModel.js";
import { WorkspaceBoundary } from "./workspace.js";

export type SyntaxCheckStatus = "passed" | "failed" | "inconclusive";

export interface SyntaxCheckResult {
  readonly status: SyntaxCheckStatus;
  /** Backward-compatible convenience: only a proven failure is false. */
  readonly ok: boolean;
  readonly tier: SupportTier | "unknown";
  readonly language: string;
  readonly detail: string;
  /** Hash of the exact workspace bytes that were checked. */
  readonly contentSha256: string;
}

/**
 * Runs a single command and reports success plus captured output. Injectable
 * so the progressive-verification ladder is testable without real toolchains.
 */
export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    cwd: string,
    input?: string,
  ): Promise<{ exitCode: number; output: string }>;
}

interface SyntaxStrategy {
  readonly language: string;
  readonly tier: SupportTier;
  readonly extensions: readonly string[];
  /** Builds the syntax-only check command for a file, or null if unsupported. */
  command(file: string, contents: string): { command: string; args: readonly string[]; input?: string } | null;
}

/**
 * Deep-tier syntax checks via first-party CLIs. These are cheap parse-only
 * invocations, not full type or build checks — the first rung of the ladder,
 * catching a broken edit immediately instead of at build cost.
 */
const SYNTAX_STRATEGIES: readonly SyntaxStrategy[] = [
  {
    language: "JavaScript",
    tier: "deep",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    command: (file) => ({ command: "node", args: ["--check", file] }),
  },
  {
    language: "Python",
    tier: "deep",
    extensions: [".py", ".pyi"],
    // Parse stdin in-memory. `py_compile` writes __pycache__ beside its target,
    // which is an unacceptable side effect for an observe-only tool.
    command: (_file, contents) => ({
      command: "python",
      args: ["-c", "import ast,sys; ast.parse(sys.stdin.read(), filename='<vanguard-workspace>')"],
      input: contents,
    }),
  },
  {
    language: "Go",
    tier: "deep",
    extensions: [".go"],
    command: (file) => ({ command: "gofmt", args: ["-e", file] }),
  },
  {
    // TypeScript has no cheap parse-only CLI (tsc needs the project graph),
    // so the rung parses in-process with the `typescript` compiler API when
    // that module is resolvable — from the target workspace first, then from
    // Vanguard's own installation — and only degrades to the structural
    // delimiter check when neither exists. Types are still the tsc rung's job.
    language: "TypeScript",
    tier: "deep",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    command: () => null,
  },
  {
    // Rust syntax-only checking requires the compiler front end; there is no
    // cheap standalone parse CLI, so it falls to the generic build rung.
    language: "Rust",
    tier: "deep",
    extensions: [".rs"],
    command: () => null,
  },
];

const EXTENSION_TO_STRATEGY = new Map<string, SyntaxStrategy>(
  SYNTAX_STRATEGIES.flatMap((strategy) => strategy.extensions.map((extension) => [extension, strategy])),
);

/** Minimal surface of the `typescript` compiler module used by the syntax rung. */
export interface TypeScriptModuleLike {
  transpileModule(input: string, options: {
    fileName?: string;
    reportDiagnostics?: boolean;
    compilerOptions?: Record<string, unknown>;
  }): { diagnostics?: ReadonlyArray<TypeScriptDiagnosticLike> };
  flattenDiagnosticMessageText(message: unknown, newLine: string): string;
  readonly DiagnosticCategory: { readonly Error: number };
  readonly JsxEmit: { readonly Preserve: number };
  readonly ScriptTarget: { readonly Latest: number };
}

export interface TypeScriptDiagnosticLike {
  readonly category: number;
  readonly code: number;
  readonly messageText: unknown;
  readonly start?: number;
  readonly file?: { getLineAndCharacterOfPosition(position: number): { line: number; character: number } };
}

export type TypeScriptLoader = (workspaceRoot: string) => Promise<TypeScriptModuleLike | undefined>;

/**
 * Resolves the `typescript` module for in-process parsing: the target
 * workspace's own installation wins (its parser matches the project's
 * language level), then Vanguard's, and a missing module is a normal
 * degradation to the structural rung — never an error.
 */
export async function loadWorkspaceTypeScript(workspaceRoot: string): Promise<TypeScriptModuleLike | undefined> {
  try {
    const require = createRequire(path.join(workspaceRoot, "package.json"));
    return require("typescript") as TypeScriptModuleLike;
  } catch {
    // The workspace does not carry its own compiler; fall through.
  }
  try {
    const imported = await import("typescript") as { default?: TypeScriptModuleLike };
    return imported.default ?? (imported as unknown as TypeScriptModuleLike);
  } catch {
    return undefined;
  }
}

/**
 * The post-edit syntax rung. For a mutated file it runs the cheapest
 * available structural check: a first-party parse CLI for supported deep-tier
 * languages, an in-process compiler-API parse for TypeScript, a
 * delimiter-balance heuristic for brace languages without a resolvable
 * parser, and an explicit "no cheap check" result otherwise (never a false
 * pass). Higher rungs — targeted type/lint/test, milestone integration, the
 * sealed verifier, and independent patch review — sit above this in the CLI.
 */
export class PostEditSyntaxChecker {
  private typescriptModule: Promise<TypeScriptModuleLike | undefined> | undefined;
  /** Last result per file, keyed by content hash: re-checking an unchanged file is free. */
  private readonly resultCache = new Map<string, { sha256: string; result: SyntaxCheckResult }>();

  constructor(
    private readonly runner: CommandRunner,
    private readonly workspace: WorkspaceBoundary,
    private readonly typescriptLoader: TypeScriptLoader = loadWorkspaceTypeScript,
  ) {}

  async check(relativeFile: string): Promise<SyntaxCheckResult> {
    // `existing` resolves symlinks/junctions and proves containment before the
    // file path reaches a parser process.
    const absoluteFile = await this.workspace.existing(relativeFile);
    const contents = await readFile(absoluteFile, "utf8");
    const contentSha256 = createHash("sha256").update(contents).digest("hex");
    const cached = this.resultCache.get(relativeFile);
    if (cached?.sha256 === contentSha256) return cached.result;
    const result = await this.checkUncached(relativeFile, absoluteFile, contents, contentSha256);
    this.resultCache.set(relativeFile, { sha256: contentSha256, result });
    return result;
  }

  private async checkUncached(
    relativeFile: string,
    absoluteFile: string,
    contents: string,
    contentSha256: string,
  ): Promise<SyntaxCheckResult> {
    const extension = path.extname(relativeFile).toLowerCase();
    const strategy = EXTENSION_TO_STRATEGY.get(extension);
    const profile = LANGUAGE_PROFILES.find((candidate) => candidate.extensions.includes(extension));

    if (strategy?.language === "TypeScript") {
      return this.typescriptSyntax(relativeFile, contents, strategy, contentSha256);
    }
    if (strategy !== undefined) {
      const spec = strategy.command(absoluteFile, contents);
      if (spec !== null) {
        try {
          const result = await this.runner.run(spec.command, spec.args, this.workspace.root, spec.input);
          const status: SyntaxCheckStatus = result.exitCode === 0 ? "passed" : "failed";
          return {
            status,
            ok: status !== "failed",
            tier: strategy.tier,
            language: strategy.language,
            detail: result.exitCode === 0 ? "syntax ok" : truncate(result.output),
            contentSha256,
          };
        } catch (error) {
          // A missing parser cannot prove validity. The structural fallback
          // may still prove a broken delimiter/string, otherwise it is
          // explicitly inconclusive.
          return this.structural(relativeFile, contents, strategy.language, strategy.tier, contentSha256);
        }
      }
      return this.structural(relativeFile, contents, strategy.language, strategy.tier, contentSha256);
    }

    if (profile !== undefined) {
      return this.structural(relativeFile, contents, profile.language, profile.tier, contentSha256);
    }
    return {
      status: "inconclusive",
      ok: true,
      tier: "unknown",
      language: "unknown",
      detail: "no syntax parser for this file type",
      contentSha256,
    };
  }

  /**
   * The in-process TypeScript parse rung. `transpileModule` surfaces only
   * syntactic diagnostics — no project graph, no type checking — which is
   * exactly the shape of this rung: it proves the edit parses, and leaves
   * types to the project's own tsc at the targeted-check rung.
   */
  private async typescriptSyntax(
    relativeFile: string,
    contents: string,
    strategy: SyntaxStrategy,
    contentSha256: string,
  ): Promise<SyntaxCheckResult> {
    this.typescriptModule ??= this.typescriptLoader(this.workspace.root).catch(() => undefined);
    const ts = await this.typescriptModule;
    if (ts === undefined) {
      return this.structural(relativeFile, contents, strategy.language, strategy.tier, contentSha256);
    }
    let failures: TypeScriptDiagnosticLike[];
    let render: (diagnostic: TypeScriptDiagnosticLike) => string;
    try {
      const result = ts.transpileModule(contents, {
        fileName: relativeFile,
        reportDiagnostics: true,
        compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest },
      });
      failures = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
      render = (diagnostic) => {
        const position = diagnostic.file !== undefined && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : undefined;
        const location = position === undefined ? "" : ` at ${position.line + 1}:${position.character + 1}`;
        return `TS${diagnostic.code}${location}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
      };
    } catch {
      // A compiler-internal failure proves nothing either way; the structural
      // scan may still prove a truncation, otherwise it is inconclusive.
      return this.structural(relativeFile, contents, strategy.language, strategy.tier, contentSha256);
    }
    if (failures.length === 0) {
      return {
        status: "passed",
        ok: true,
        tier: strategy.tier,
        language: strategy.language,
        detail: "syntax ok (TypeScript parse)",
        contentSha256,
      };
    }
    return {
      status: "failed",
      ok: false,
      tier: strategy.tier,
      language: strategy.language,
      detail: truncate(failures.slice(0, 5).map(render).join("; ")),
      contentSha256,
    };
  }

  private structural(
    file: string,
    contents: string,
    language: string,
    tier: SupportTier,
    contentSha256: string,
  ): SyntaxCheckResult {
    const balance = delimiterBalance(contents);
    return {
      status: balance.ok ? "inconclusive" : "failed",
      ok: balance.ok,
      tier,
      language,
      detail: balance.ok
        ? "delimiter scan found no obvious truncation; no parser proof is available"
        : `unbalanced ${balance.detail} in ${file}`,
      contentSha256,
    };
  }
}

/**
 * A structural delimiter-balance check that ignores strings, template
 * literals, and comments. Not a parser — it catches the common broken-edit
 * signature (an unclosed brace/paren/bracket) cheaply and never false-passes
 * an obviously truncated edit.
 */
export function delimiterBalance(source: string): { ok: boolean; detail: string } {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") { inBlockComment = false; index += 1; }
      continue;
    }
    if (inString !== null) {
      if (char === "\\") { index += 1; continue; }
      if (char === inString) inString = null;
      continue;
    }
    if (char === "/" && next === "/") { inLineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { inBlockComment = true; index += 1; continue; }
    if (char === "#") { inLineComment = true; continue; }
    if (char === "\"" || char === "'" || char === "`") { inString = char; continue; }
    if (char === "(" || char === "[" || char === "{") { stack.push(char); continue; }
    if (char === ")" || char === "]" || char === "}") {
      const expected = pairs[char];
      if (stack.pop() !== expected) return { ok: false, detail: `'${char}'` };
    }
  }
  if (inString !== null) return { ok: false, detail: "unterminated string" };
  if (stack.length > 0) return { ok: false, detail: `unclosed '${stack.at(-1)}'` };
  return { ok: true, detail: "balanced" };
}

/**
 * Exposes the syntax rung as an observe tool so the model can self-check an
 * edit before spending a build. It never mutates and never gates on its own;
 * the kernel's completion policy still requires the sealed verifier.
 */
export class SyntaxCheckTool implements ToolPort {
  readonly name = "verify.syntax";
  readonly definition: ToolDefinition = {
    name: this.name,
    description: "Cheaply check whether a file you just wrote is structurally valid (parse/delimiter check) before running an expensive build. Reports the language support tier. Passing here does not replace the sealed verifier.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path of the file to check." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    effect: "observe",
  };

  constructor(private readonly checker: PostEditSyntaxChecker) {}

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    if (input === null || Array.isArray(input) || typeof input !== "object") {
      throw new Error("Syntax check input must be an object.");
    }
    const file = input.path;
    if (typeof file !== "string") {
      throw new Error("Syntax check requires string 'path'.");
    }
    const result = await this.checker.check(file);
    return { ok: result.ok, output: result as unknown as JsonValue };
  }
}

function truncate(value: string, max = 400): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

/**
 * A minimal, hard-allowlisted command runner for the fixed syntax-check
 * executables only. It never runs a shell and rejects any command outside
 * the syntax allowlist, so it cannot become a general process escape.
 */
export class SyntaxCommandRunner implements CommandRunner {
  static readonly ALLOWED = new Set(["node", "python", "python3", "gofmt"]);

  constructor(private readonly timeoutMs = 15_000) {}

  async run(
    command: string,
    args: readonly string[],
    cwd: string,
    input?: string,
  ): Promise<{ exitCode: number; output: string }> {
    if (!SyntaxCommandRunner.ALLOWED.has(command)) {
      throw new Error(`Syntax runner refuses non-allowlisted command: ${command}`);
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { cwd, windowsHide: true, shell: false });
      let output = "";
      let capturedBytes = 0;
      const maxOutputBytes = 8_000;
      const capture = (chunk: Buffer): void => {
        if (capturedBytes >= maxOutputBytes) return;
        const remaining = maxOutputBytes - capturedBytes;
        const slice = chunk.subarray(0, remaining);
        output += slice.toString("utf8");
        capturedBytes += slice.length;
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      if (input === undefined) child.stdin.end();
      else child.stdin.end(input, "utf8");
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("syntax check timed out")); }, this.timeoutMs);
      timer.unref();
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, output }); });
    });
  }
}
