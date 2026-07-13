import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CommandRunner } from "../src/index.js";
import {
  PostEditSyntaxChecker,
  WorkspaceBoundary,
  buildRepositoryModel,
  delimiterBalance,
} from "../src/index.js";

async function scaffold(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-repo-"));
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  return root;
}

test("repository model identifies a TypeScript npm project with tests and entry points", async () => {
  const root = await scaffold({
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "src/index.ts": "export const main = () => 0;\n",
    "src/util.ts": "export const add = (a: number, b: number) => a + b;\n",
    "test/util.test.ts": "import { add } from '../src/util.js';\n",
    "AGENTS.md": "Always run npm test before finishing.\n",
    "dist/index.js": "compiled\n",
  });
  try {
    const model = await buildRepositoryModel(root);
    assert.equal(model.primaryLanguage, "TypeScript");
    assert.equal(model.primaryTier, "deep");
    assert.ok(model.buildSystems.includes("npm"));
    assert.ok(model.entryPoints.includes("src/index.ts"));
    assert.ok(model.testFiles.includes("test/util.test.ts"));
    assert.ok(model.generatedDirectories.includes("dist"));
    assert.ok(model.instructionFiles.includes("AGENTS.md"));
    // Files under generated directories are not counted as source.
    assert.equal(model.languages.find((language) => language.language === "JavaScript"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository model tiers languages: Python/Rust/Go deep, Java/C# generic", async () => {
  const cases: { files: Record<string, string>; language: string; tier: string; build: string }[] = [
    { files: { "pyproject.toml": "", "app/main.py": "print(1)\n", "app/test_app.py": "def test(): pass\n" }, language: "Python", tier: "deep", build: "python/pyproject" },
    { files: { "Cargo.toml": "[package]", "src/main.rs": "fn main() {}\n" }, language: "Rust", tier: "deep", build: "cargo" },
    { files: { "go.mod": "module x", "main.go": "package main\n" }, language: "Go", tier: "deep", build: "go modules" },
    { files: { "pom.xml": "<project/>", "src/Main.java": "class Main {}\n" }, language: "Java", tier: "generic", build: "maven" },
    { files: { "Program.cs": "class P {}\n" }, language: "C#", tier: "generic", build: "" },
  ];
  for (const testCase of cases) {
    const root = await scaffold(testCase.files);
    try {
      const model = await buildRepositoryModel(root);
      assert.equal(model.primaryLanguage, testCase.language, `language for ${testCase.language}`);
      assert.equal(model.primaryTier, testCase.tier, `tier for ${testCase.language}`);
      if (testCase.build.length > 0) assert.ok(model.buildSystems.includes(testCase.build), `build for ${testCase.language}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("repository model handles a mixed frontend/backend repository", async () => {
  const root = await scaffold({
    "package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    "web/src/app.tsx": "export const App = () => null;\n",
    "web/src/app.test.tsx": "test('x', () => {});\n",
    "api/pyproject.toml": "",
    "api/server.py": "def main(): pass\n",
    "api/test_server.py": "def test(): pass\n",
  });
  try {
    const model = await buildRepositoryModel(root);
    const languages = model.languages.map((language) => language.language).sort();
    assert.deepEqual(languages, ["Python", "TypeScript"]);
    assert.ok(model.buildSystems.includes("npm"));
    assert.ok(model.testFiles.includes("web/src/app.test.tsx"));
    assert.ok(model.testFiles.includes("api/test_server.py"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delimiter balance catches broken edits and ignores strings and comments", () => {
  assert.equal(delimiterBalance("function f() { return [1, 2]; }").ok, true);
  assert.equal(delimiterBalance("const s = \"unbalanced ( brace\"; const t = `also } fine`;").ok, true);
  assert.equal(delimiterBalance("// } this is a comment\nconst x = 1;").ok, true);
  assert.equal(delimiterBalance("def f():\n    return { 'a': 1  # missing close\n").ok, false);
  assert.equal(delimiterBalance("function f() { return 1;").ok, false);
  assert.equal(delimiterBalance("const s = \"unterminated").ok, false);
});

test("post-edit syntax checker uses first-party CLIs for deep languages", async () => {
  const root = await scaffold({ "src/a.js": "const x = 1;", "app/main.py": "print(1)" });
  const calls: { command: string; args: readonly string[]; input?: string }[] = [];
  const okRunner: CommandRunner = {
    async run(command, args, _cwd, input) {
      calls.push({ command, args, ...(input === undefined ? {} : { input }) });
      return { exitCode: 0, output: "" };
    },
  };
  try {
    const checker = new PostEditSyntaxChecker(okRunner, new WorkspaceBoundary(root));
    const js = await checker.check("src/a.js");
    assert.equal(js.status, "passed");
    assert.equal(js.tier, "deep");
    assert.equal(calls[0]?.command, "node");
    assert.deepEqual(calls[0]?.args, ["--check", path.join(root, "src/a.js")]);

    const py = await checker.check("app/main.py");
    assert.equal(py.language, "Python");
    assert.equal(calls[1]?.command, "python");
    assert.equal(calls[1]?.input, "print(1)");
    assert.equal(calls[1]?.args.includes(path.join(root, "app/main.py")), false,
      "Python syntax checks must parse stdin, never py_compile a workspace path");
    assert.match(js.contentSha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-edit syntax checker reports a real CLI failure honestly", async () => {
  const root = await scaffold({ "src/broken.js": "const x = ;" });
  const failRunner: CommandRunner = {
    async run() { return { exitCode: 1, output: "SyntaxError: unexpected token" }; },
  };
  try {
    const checker = new PostEditSyntaxChecker(failRunner, new WorkspaceBoundary(root));
    const result = await checker.check("src/broken.js");
    assert.equal(result.status, "failed");
    assert.match(result.detail, /SyntaxError/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-edit syntax checker falls back to structural check when the toolchain is missing", async () => {
  const root = await scaffold({
    "src/a.js": "const x = () => 1;",
    "src/broken.js": "const x = () => 1;   {{{",
  });
  const missingRunner: CommandRunner = {
    async run() { throw new Error("spawn ENOENT"); },
  };
  try {
    const checker = new PostEditSyntaxChecker(missingRunner, new WorkspaceBoundary(root));
    const balanced = await checker.check("src/a.js");
    assert.equal(balanced.status, "inconclusive", "a missing parser must not report a false pass");
    const broken = await checker.check("src/broken.js");
    assert.equal(broken.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TypeScript uses the structural rung and generic languages get a structural check too", async () => {
  const root = await scaffold({
    "src/a.ts": "export const x: number = 1;",
    "Main.java": "class Main { }",
    "notes.txt": "anything at all (",
  });
  const runner: CommandRunner = { async run() { return { exitCode: 0, output: "" }; } };
  try {
    const checker = new PostEditSyntaxChecker(runner, new WorkspaceBoundary(root));
    const ts = await checker.check("src/a.ts");
    assert.equal(ts.language, "TypeScript");
    assert.equal(ts.tier, "deep");
    assert.equal(ts.status, "inconclusive");
    const java = await checker.check("Main.java");
    assert.equal(java.tier, "generic");
    assert.equal(java.status, "inconclusive");
    const unknownType = await checker.check("notes.txt");
    assert.equal(unknownType.status, "inconclusive", "unknown file types cannot claim syntax validity");
    assert.equal(unknownType.tier, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syntax checks reject traversal and never accept hypothetical model contents", async () => {
  const root = await scaffold({ "actual.py": "def broken(:\n    pass\n" });
  const outside = await scaffold({ "outside.py": "print('safe')\n" });
  const calls: { input?: string }[] = [];
  const runner: CommandRunner = {
    async run(_command, _args, _cwd, input) {
      calls.push({ ...(input === undefined ? {} : { input }) });
      return { exitCode: 1, output: "SyntaxError" };
    },
  };
  try {
    const checker = new PostEditSyntaxChecker(runner, new WorkspaceBoundary(root));
    await assert.rejects(() => checker.check(path.relative(root, path.join(outside, "outside.py"))), /escapes workspace/i);
    const result = await checker.check("actual.py");
    assert.equal(result.status, "failed");
    assert.equal(calls[0]?.input, "def broken(:\n    pass\n",
      "the checker must read the workspace file rather than model-provided text");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
