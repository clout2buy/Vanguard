import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GlobTool,
  ReadFileTool,
  ReplaceTextTool,
  SearchTextTool,
  WorkspaceBoundary,
  WorkspaceVersionLedger,
  contentHash,
} from "../src/index.js";

const context = { runId: "test", stepIndex: 0 } as never;

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-searchtools-"));
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "src", "alpha.ts"), "export const alpha = 1;\nfunction findAlpha() {}\n");
  await writeFile(path.join(root, "src", "nested", "beta.ts"), "export const beta = 2;\nconst needle_beta = true;\n");
  await writeFile(path.join(root, "docs", "readme.md"), "# Needle docs\nneedle_beta appears here too\n");
  return root;
}

test("regex search matches per line with groups and case-insensitivity", async () => {
  const root = await fixture();
  try {
    const search = new SearchTextTool(new WorkspaceBoundary(root));
    const result = await search.execute({ query: "export const (alpha|beta)", regex: true }, context);
    assert.equal(result.ok, true);
    const output = result.output as { matches: Array<{ path: string; line: number }> };
    assert.deepEqual(output.matches.map((match) => match.path).sort(), ["src/alpha.ts", "src/nested/beta.ts"]);

    const insensitive = await search.execute({ query: "NEEDLE_BETA", regex: true, caseSensitive: false }, context);
    assert.equal(insensitive.ok, true);
    const hits = (insensitive.output as { matches: Array<{ path: string }> }).matches;
    assert.equal(hits.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("search filePattern restricts scope and context lines are returned", async () => {
  const root = await fixture();
  try {
    const search = new SearchTextTool(new WorkspaceBoundary(root));
    const filtered = await search.execute({ query: "needle_beta", filePattern: "**/*.ts" }, context);
    assert.equal(filtered.ok, true);
    const matches = (filtered.output as { matches: Array<{ path: string; before?: string[]; after?: string[] }> }).matches;
    assert.deepEqual(matches.map((match) => match.path), ["src/nested/beta.ts"]);

    const contextual = await search.execute({ query: "needle_beta", filePattern: "*.ts", context: 1 }, context);
    assert.equal(contextual.ok, true);
    const [hit] = (contextual.output as { matches: Array<{ before: string[]; after: string[] }> }).matches;
    assert.deepEqual(hit?.before, ["export const beta = 2;"]);
    assert.deepEqual(hit?.after, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catastrophic regex fails closed instead of hanging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-redos-"));
  try {
    await writeFile(path.join(root, "victim.txt"), `${"a".repeat(2_000)}b\n`);
    const search = new SearchTextTool(new WorkspaceBoundary(root));
    const started = Date.now();
    const result = await search.execute({ query: "(a+)+$", regex: true }, context);
    assert.equal(result.ok, false);
    assert.match(String((result.output as { error: string }).error), /too expensive|timed out/iu);
    assert.equal(Date.now() - started < 5_000, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid regex and invalid glob produce clean failures", async () => {
  const root = await fixture();
  try {
    const search = new SearchTextTool(new WorkspaceBoundary(root));
    const badRegex = await search.execute({ query: "(unclosed", regex: true }, context);
    assert.equal(badRegex.ok, false);
    assert.match(String((badRegex.output as { error: string }).error), /Invalid regular expression/u);

    const badGlob = await search.execute({ query: "alpha", filePattern: "src/[bad" }, context);
    assert.equal(badGlob.ok, false);
    assert.match(String((badGlob.output as { error: string }).error), /Invalid file pattern/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("glob tool matches segment-aware patterns", async () => {
  const root = await fixture();
  try {
    const glob = new GlobTool(new WorkspaceBoundary(root));
    const doubleStar = await glob.execute({ pattern: "src/**/*.ts" }, context);
    assert.equal(doubleStar.ok, true);
    assert.deepEqual((doubleStar.output as { files: string[] }).files, ["src/alpha.ts", "src/nested/beta.ts"]);

    const singleStar = await glob.execute({ pattern: "src/*.ts" }, context);
    assert.deepEqual((singleStar.output as { files: string[] }).files, ["src/alpha.ts"]);

    const basename = await glob.execute({ pattern: "*.md" }, context);
    assert.deepEqual((basename.output as { files: string[] }).files, ["docs/readme.md"]);

    const scoped = await glob.execute({ pattern: "**/*.ts", path: "src" }, context);
    assert.deepEqual((scoped.output as { files: string[] }).files, ["src/alpha.ts", "src/nested/beta.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replacement text containing substitution patterns stays byte-literal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-replace-"));
  try {
    const original = "const template = OLD;\n";
    await writeFile(path.join(root, "code.js"), original);
    const workspace = new WorkspaceBoundary(root);
    const versions = new WorkspaceVersionLedger();
    const replace = new ReplaceTextTool(workspace, versions);
    const after = "`$& and $' and $` and $$name`";
    const result = await replace.execute({
      path: "code.js",
      expectedSha256: contentHash(original),
      before: "OLD",
      after,
    }, context);
    assert.equal(result.ok, true);
    const read = new ReadFileTool(workspace, 1_000_000, versions);
    const contents = await read.execute({ path: "code.js" }, context);
    assert.equal((contents.output as { contents: string }).contents, `const template = ${after};\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default read page covers a realistically large file in one call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-readpage-"));
  try {
    const body = `${"const line = 1;".repeat(3_000)}\n`;
    assert.equal(body.length > 32 * 1024, true);
    await writeFile(path.join(root, "big.js"), body);
    const read = new ReadFileTool(new WorkspaceBoundary(root), 1_000_000);
    const result = await read.execute({ path: "big.js" }, context);
    assert.equal(result.ok, true);
    const output = result.output as { contents: string; truncated: boolean };
    assert.equal(output.contents, body);
    assert.equal(output.truncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
