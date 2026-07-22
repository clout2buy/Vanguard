import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ToolContext } from "../src/index.js";
import {
  DEGENERATE_RUN_THRESHOLD,
  ReplaceTextTool,
  WorkspaceBoundary,
  WriteFileTool,
  contentHash,
  detectDegenerateRepetition,
} from "../src/index.js";

const context: ToolContext = { task: "test", step: 1, signal: new AbortController().signal };

function repeated(line: string, count: number): string {
  return Array.from({ length: count }, () => line).join("\n");
}

test("degeneration detector flags a runaway identical-line run", () => {
  const spiral = `function setup() {\n${repeated("// I'm a front-end developer", 12)}\n}\n`;
  const found = detectDegenerateRepetition(spiral);
  assert.ok(found !== undefined);
  assert.equal(found.line, "// I'm a front-end developer");
  assert.equal(found.count, 12);
  assert.equal(found.startLine, 2);
});

test("degeneration detector ignores structural and short repetition", () => {
  // Blank lines, braces, and separator rules are legitimate repetition.
  assert.equal(detectDegenerateRepetition(repeated("", 40)), undefined);
  assert.equal(detectDegenerateRepetition(repeated("}", 20)), undefined);
  assert.equal(detectDegenerateRepetition(repeated("# ------------------", 10)), undefined);
  assert.equal(detectDegenerateRepetition(repeated("<br/>", 10)), undefined);
  // Below the threshold is fine even for significant lines.
  assert.equal(
    detectDegenerateRepetition(repeated("console.log(marker);", DEGENERATE_RUN_THRESHOLD - 1)),
    undefined,
  );
  // A short alternation below the cycle threshold is legitimate structure.
  assert.equal(
    detectDegenerateRepetition("const a = 1;\nconst b = 2;\nconst a = 1;\nconst b = 2;\nconst a = 1;\nconst b = 2;\nconst a = 1;\nconst b = 2;\nconst a = 1;\nconst b = 2;"),
    undefined,
  );
});

test("degeneration detector catches alternating cycles and jittered near-miss ramps", () => {
  // The A/B spiral: no identical-line run ever forms, but the cycle is unmistakable.
  const alternating = Array.from({ length: 20 }, () => "// I'm a front-end developer\n// I'm a back-end developer").join("\n");
  const cycle = detectDegenerateRepetition(alternating);
  assert.ok(cycle !== undefined);
  assert.equal(cycle.kind, "cycle");
  assert.equal(cycle.count, 20);

  // The ramp: runs of 4 broken by one-line jitter, 12 repeats total.
  const line = "// I'm a full-stack developer";
  const ramp = [
    ...Array.from({ length: 4 }, () => line), "const x = 1;",
    ...Array.from({ length: 4 }, () => line), "const y = 2;",
    ...Array.from({ length: 4 }, () => line),
  ].join("\n");
  const scattered = detectDegenerateRepetition(ramp);
  assert.ok(scattered !== undefined);
  assert.equal(scattered.kind, "scattered");
  assert.equal(scattered.count, 12);

  // Legitimately recurring lines keep enough real code between repeats to
  // stay under the density floor: ten `return null;` across a real switch.
  const switchBody = Array.from({ length: 10 }, (_, index) => `  case ${index}:\n    return null;`).join("\n");
  assert.equal(detectDegenerateRepetition(`switch (value) {\n${switchBody}\n}`), undefined);
});

test("degeneration detector never blames repetition that already existed", () => {
  const prior = `header\n${repeated("data row identical", 9)}\nfooter\n`;
  const rewrite = `new header\n${repeated("data row identical", 9)}\nfooter\n`;
  assert.equal(detectDegenerateRepetition(rewrite, prior), undefined);
  // But growing a fresh run in the same file is still degeneration.
  const degenerated = `${rewrite}${repeated("// TODO fix this later", 7)}\n`;
  const found = detectDegenerateRepetition(degenerated, prior);
  assert.ok(found !== undefined);
  assert.equal(found.line, "// TODO fix this later");
});

test("write_file rejects degenerated contents and honors allowRepetition", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-degen-"));
  try {
    const workspace = new WorkspaceBoundary(root);
    const writer = new WriteFileTool(workspace);

    const spiral = `const app = 1;\n${repeated("// I'm a front-end developer", 8)}\n`;
    const rejected = await writer.execute({ path: "src/app.ts", contents: spiral }, context);
    assert.equal(rejected.ok, false);
    assert.match(JSON.stringify(rejected.output), /degenerated output/i);

    const allowed = await writer.execute(
      { path: "src/fixture.txt", contents: repeated("row row row row row", 30), allowRepetition: true },
      context,
    );
    assert.equal(allowed.ok, true);
    assert.equal(
      await readFile(path.join(root, "src", "fixture.txt"), "utf8"),
      repeated("row row row row row", 30),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edit_file rejects a splice that completes a degenerate run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-degen-replace-"));
  try {
    const original = `start\n${repeated("// filler comment line", DEGENERATE_RUN_THRESHOLD - 1)}\nMARKER\nend\n`;
    await writeFile(path.join(root, "code.ts"), original);
    const workspace = new WorkspaceBoundary(root);
    const replacer = new ReplaceTextTool(workspace);

    // The replacement text itself is a single innocent line, but splicing it
    // in extends the neighboring run past the threshold.
    const rejected = await replacer.execute({
      path: "code.ts",
      expectedSha256: contentHash(original),
      before: "MARKER",
      after: "// filler comment line",
    }, context);
    assert.equal(rejected.ok, false);
    assert.match(JSON.stringify(rejected.output), /degenerated output/i);
    assert.equal(await readFile(path.join(root, "code.ts"), "utf8"), original, "a rejected replace must not touch the file");

    const benign = await replacer.execute({
      path: "code.ts",
      expectedSha256: contentHash(original),
      before: "MARKER",
      after: "const done = true;",
    }, context);
    assert.equal(benign.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
