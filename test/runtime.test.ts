import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CommandVerifier,
  DeleteFileTool,
  FixedCommandTool,
  ImageInspectionTool,
  ListFilesTool,
  ProcessTool,
  ReadFileTool,
  ReplaceTextTool,
  SearchTextTool,
  WorkspaceBoundary,
  WorkspaceMutationPolicy,
  WorkspaceVersionLedger,
  WriteFileTool,
  contentHash,
} from "../src/index.js";
import { nodePermissionFlag } from "../src/runtime/nodePackageManager.js";

const context = { task: "test", step: 1, signal: new AbortController().signal };

test("workspace rejects absolute paths and traversal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-boundary-"));
  try {
    const workspace = new WorkspaceBoundary(root);
    assert.throws(() => workspace.lexical("../outside.txt"), /escapes workspace/);
    assert.throws(() => workspace.lexical(path.resolve(root, "absolute.txt")), /relative/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file tools write atomically, read, and enumerate workspace files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-files-"));
  try {
    const workspace = new WorkspaceBoundary(root);
    const writer = new WriteFileTool(workspace);
    const reader = new ReadFileTool(workspace);
    const list = new ListFilesTool(workspace);

    const writeResult = await writer.execute({ path: "src/answer.txt", contents: "forty-two" }, context);
    assert.equal(writeResult.ok, true);
    assert.equal(await readFile(path.join(root, "src", "answer.txt"), "utf8"), "forty-two");

    const readResult = await reader.execute({ path: "src/answer.txt" }, context);
    assert.equal(readResult.ok, true);
    assert.deepEqual(readResult.output, {
      path: "src/answer.txt",
      sha256: contentHash("forty-two"),
      contents: "forty-two",
      totalBytes: 9,
      range: { startByte: 0, endByte: 9 },
      truncated: false,
      nextCursor: null,
    });

    const listResult = await list.execute({}, context);
    assert.equal(listResult.ok, true);
    assert.deepEqual(listResult.output, { files: [path.join("src", "answer.txt")] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace.read returns bounded UTF-8 pages with a stable full-file hash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-read-pages-"));
  try {
    const contents = "alpha αβγ\n".repeat(16_000);
    await writeFile(path.join(root, "large.txt"), contents);
    const reader = new ReadFileTool(new WorkspaceBoundary(root), 1_000_000);

    const first = await reader.execute({ path: "large.txt" }, context);
    assert.equal(first.ok, true);
    type ReadPage = {
      contents: string;
      sha256: string;
      totalBytes: number;
      range: { startByte: number; endByte: number };
      truncated: boolean;
      nextCursor: string | null;
    };
    const firstOutput = first.output as ReadPage;
    assert.equal(firstOutput.sha256, contentHash(contents));
    assert.equal(firstOutput.totalBytes, Buffer.byteLength(contents));
    assert.deepEqual(firstOutput.range, { startByte: 0, endByte: Buffer.byteLength(firstOutput.contents) });
    assert.equal(Buffer.byteLength(firstOutput.contents) <= 64 * 1_024, true);
    assert.equal(firstOutput.contents.includes("\ufffd"), false);
    assert.equal(firstOutput.truncated, true);
    assert.equal(typeof firstOutput.nextCursor, "string");

    const pages = [firstOutput.contents];
    let current = firstOutput;
    while (current.nextCursor !== null) {
      const next = await reader.execute({ path: "large.txt", cursor: current.nextCursor }, context);
      assert.equal(next.ok, true);
      const nextOutput = next.output as ReadPage;
      assert.equal(nextOutput.sha256, firstOutput.sha256);
      assert.equal(nextOutput.totalBytes, firstOutput.totalBytes);
      assert.equal(nextOutput.range.startByte, current.range.endByte);
      assert.equal(Buffer.byteLength(nextOutput.contents) <= 64 * 1_024, true);
      assert.equal(nextOutput.contents.includes("\ufffd"), false);
      pages.push(nextOutput.contents);
      current = nextOutput;
    }
    assert.equal(pages.length > 2, true);
    assert.equal(pages.join(""), contents);
    assert.equal(current.range.endByte, Buffer.byteLength(contents));
    assert.equal(current.truncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace.read supports exact byte ranges and rejects ambiguous or unknown input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-read-range-"));
  try {
    await writeFile(path.join(root, "value.txt"), "0123456789");
    await writeFile(path.join(root, "unicode.txt"), "αβ");
    const reader = new ReadFileTool(new WorkspaceBoundary(root));

    const ranged = await reader.execute({
      path: "value.txt",
      range: { startByte: 2, endByte: 5 },
    }, context);
    assert.equal(ranged.ok, true);
    assert.deepEqual(ranged.output, {
      path: "value.txt",
      sha256: contentHash("0123456789"),
      contents: "234",
      totalBytes: 10,
      range: { startByte: 2, endByte: 5 },
      truncated: true,
      nextCursor: Buffer.from(JSON.stringify({
        version: 1,
        path: "value.txt",
        sha256: contentHash("0123456789"),
        offset: 5,
      }), "utf8").toString("base64url"),
    });

    await assert.rejects(
      reader.execute({ path: "value.txt", unexpected: true }, context),
      /workspace\.read received unknown field: unexpected/u,
    );
    await assert.rejects(
      reader.execute({ path: "value.txt", range: { startByte: 0, endByte: 1, extra: 1 } }, context),
      /unknown field: extra/u,
    );
    await assert.rejects(
      reader.execute({
        path: "value.txt",
        cursor: (ranged.output as { nextCursor: string }).nextCursor,
        range: { startByte: 0, endByte: 1 },
      }, context),
      /mutually exclusive/u,
    );
    await assert.rejects(
      reader.execute({ path: "value.txt", range: { startByte: 0, endByte: 1 }, maxBytes: 4 }, context),
      /cannot be combined/u,
    );
    await assert.rejects(
      reader.execute({ path: "value.txt", maxBytes: 3 }, context),
      /from 4 through 131072/u,
    );
    await assert.rejects(
      reader.execute({ path: "unicode.txt", range: { startByte: 0, endByte: 1 } }, context),
      /UTF-8 character boundaries/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace.read cursors reject cross-file use and file drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-read-cursor-"));
  try {
    await writeFile(path.join(root, "one.txt"), "abcdefghij");
    await writeFile(path.join(root, "two.txt"), "abcdefghij");
    const reader = new ReadFileTool(new WorkspaceBoundary(root));

    const first = await reader.execute({ path: "one.txt", maxBytes: 4 }, context);
    const cursor = (first.output as { nextCursor: string }).nextCursor;
    await assert.rejects(
      reader.execute({ path: "two.txt", cursor }, context),
      /issued for a different path/u,
    );

    await writeFile(path.join(root, "one.txt"), "abcdXfghij");
    const stale = await reader.execute({ path: "one.txt", cursor }, context);
    assert.equal(stale.ok, false);
    assert.match(JSON.stringify(stale.output), /changed since the read cursor was issued/u);
    assert.match(JSON.stringify(stale.output), /expectedSha256/u);
    assert.match(JSON.stringify(stale.output), /actualSha256/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writes reject stale content hashes and guarded replacement requires a unique target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-edit-"));
  try {
    const workspace = new WorkspaceBoundary(root);
    await writeFile(path.join(root, "code.ts"), "const answer = 41;\n");
    const writer = new WriteFileTool(workspace);
    const replacer = new ReplaceTextTool(workspace);

    const blind = await writer.execute({ path: "code.ts", contents: "broken" }, context);
    assert.equal(blind.ok, false);
    const unchanged = await writer.execute({
      path: "code.ts",
      expectedSha256: contentHash("const answer = 41;\n"),
      contents: "const answer = 41;\n",
    }, context);
    assert.equal(unchanged.ok, false);
    assert.match(JSON.stringify(unchanged.output), /unchanged/i);
    const stale = await replacer.execute({
      path: "code.ts",
      expectedSha256: contentHash("different"),
      before: "41",
      after: "42",
    }, context);
    assert.equal(stale.ok, false);
    const replaced = await replacer.execute({
      path: "code.ts",
      expectedSha256: contentHash("const answer = 41;\n"),
      before: "41",
      after: "42",
    }, context);
    assert.equal(replaced.ok, true);
    assert.equal(await readFile(path.join(root, "code.ts"), "utf8"), "const answer = 42;\n");

    await writeFile(path.join(root, "duplicate.txt"), "same same");
    const ambiguous = await replacer.execute({
      path: "duplicate.txt",
      expectedSha256: contentHash("same same"),
      before: "same",
      after: "changed",
    }, context);
    assert.equal(ambiguous.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read leases eliminate hash bookkeeping without weakening stale-write protection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-lease-"));
  try {
    await writeFile(path.join(root, "code.ts"), "const value = 1;\n");
    const workspace = new WorkspaceBoundary(root);
    const versions = new WorkspaceVersionLedger();
    const reader = new ReadFileTool(workspace, 1_000_000, versions);
    const writer = new WriteFileTool(workspace, versions);
    const replacer = new ReplaceTextTool(workspace, versions);

    await reader.execute({ path: "code.ts" }, context);
    const replaced = await replacer.execute({ path: "code.ts", before: "1", after: "2" }, context);
    assert.equal(replaced.ok, true);
    const written = await writer.execute({ path: "code.ts", contents: "const value = 3;\n" }, context);
    assert.equal(written.ok, true);

    await writeFile(path.join(root, "code.ts"), "external change\n");
    const stale = await writer.execute({ path: "code.ts", contents: "would clobber\n" }, context);
    assert.equal(stale.ok, false);
    assert.match(JSON.stringify(stale.output), /changed since it was read/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mutation policy blocks out-of-scope writes and supports guarded deletion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-mutation-policy-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "protected.ts"), "keep\n");
    const workspace = new WorkspaceBoundary(root);
    const versions = new WorkspaceVersionLedger();
    const policy = new WorkspaceMutationPolicy(["src"], ["src/protected.ts"]);
    const writer = new WriteFileTool(workspace, versions, policy);
    const reader = new ReadFileTool(workspace, 1_000_000, versions);
    const deleter = new DeleteFileTool(workspace, versions, policy);

    const outside = await writer.execute({ path: "test/generated.mjs", contents: "bad" }, context);
    assert.equal(outside.ok, false);
    assert.match(JSON.stringify(outside.output), /outside the declared editable roots/i);
    const protectedWrite = await writer.execute({ path: "src/protected.ts", contents: "bad" }, context);
    assert.equal(protectedWrite.ok, false);

    const created = await writer.execute({ path: "src/generated.ts", contents: "temporary\n" }, context);
    assert.equal(created.ok, true);
    await reader.execute({ path: "src/generated.ts" }, context);
    const deleted = await deleter.execute({ path: "src/generated.ts" }, context);
    assert.equal(deleted.ok, true);
    await assert.rejects(() => readFile(path.join(root, "src", "generated.ts"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("search returns bounded source evidence and ignores binary files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-search-"));
  try {
    await writeFile(path.join(root, "one.ts"), "const SIGNAL = true;\n");
    await writeFile(path.join(root, "two.ts"), "// signal again\n");
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 83, 73, 71, 78, 65, 76]));
    const search = new SearchTextTool(new WorkspaceBoundary(root), 1);
    const result = await search.execute({ query: "signal", caseSensitive: false }, context);
    assert.equal(result.ok, true);
    assert.equal(result.output !== null && typeof result.output === "object" && !Array.isArray(result.output)
      ? result.output.truncated
      : false, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process tool enforces its command allowlist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-process-"));
  try {
    const tool = new ProcessTool(new WorkspaceBoundary(root), { allowedCommands: [process.execPath] });
    assert.equal(tool.definition.evidenceAuthority, "independent-execution");
    const denied = await tool.execute({ command: "definitely-not-allowed", args: [] }, context);
    assert.equal(denied.ok, false);

    const allowed = await tool.execute(
      { command: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
      context,
    );
    assert.equal(allowed.ok, true);
    assert.equal(
      allowed.output !== null && typeof allowed.output === "object" && !Array.isArray(allowed.output)
        ? allowed.output.stdout
        : "",
      "ok",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixed command tool exposes a trusted check without model-controlled arguments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-fixed-command-"));
  try {
    const processTool = new ProcessTool(new WorkspaceBoundary(root), { allowedCommands: [process.execPath] });
    const tool = new FixedCommandTool(
      "project.check",
      "run fixed check",
      processTool,
      { command: process.execPath, args: ["-e", "process.stdout.write('fixed')"] },
    );
    const result = await tool.execute({}, context);
    assert.equal(result.ok, true);
    assert.match(JSON.stringify(result.output), /fixed/);
    assert.equal((await tool.execute({ summary: "run trusted checks" }, context)).ok, true);
    const ignored = await tool.execute({ command: "malicious", args: ["malicious"] }, context);
    assert.equal(ignored.ok, true);
    assert.match(JSON.stringify(ignored.output), /fixed/);
    assert.doesNotMatch(JSON.stringify(ignored.output), /malicious/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image inspection gives non-vision models regional evidence and pixel comparisons", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-image-inspection-"));
  try {
    await mkdir(path.join(root, "images"));
    const first = createBmp(64, 48, (x, y) => {
      if (y >= 40 && x < 32 && x % 3 !== 0) return [240, 240, 240];
      return y < 20 ? [90, 145, 220] : [55, 115, 45];
    });
    const second = createBmp(64, 48, (x, y) => {
      if (x >= 20 && x < 36 && y >= 15 && y < 31) return [0, 0, 0];
      if (y >= 40 && x < 32 && x % 3 !== 0) return [240, 240, 240];
      return y < 20 ? [90, 145, 220] : [55, 115, 45];
    });
    await writeFile(path.join(root, "images", "first.bmp"), first);
    await writeFile(path.join(root, "images", "second.bmp"), second);
    const tool = new ImageInspectionTool(new WorkspaceBoundary(root));
    const inspected = await tool.execute({ path: "images/first.bmp", comparePath: "images/second.bmp" }, context);
    assert.equal(inspected.ok, true);
    const evidence = JSON.stringify(inspected.output);
    assert.match(evidence, /"format":"bmp"/);
    assert.match(evidence, /"luminanceMap"/);
    assert.match(evidence, /"hudEvidence":true/);
    assert.match(evidence, /"exactPixelMatch":false/);
    assert.match(evidence, /"changedPixelRatio":/);
    const identical = await tool.execute({ path: "images/first.bmp", comparePath: "images/first.bmp" }, context);
    assert.match(JSON.stringify(identical.output), /"exactPixelMatch":true/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process evidence policy rejects non-failing console assertions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-process-evidence-"));
  try {
    const tool = new ProcessTool(new WorkspaceBoundary(root), {
      allowedCommands: [process.execPath],
      deniedArgumentSubstrings: ["console.assert"],
    });
    const result = await tool.execute({
      command: process.execPath,
      args: ["--eval", "console.assert(false); console.log('looks green')"],
    }, context);
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result.output), /assertion library that throws/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process tool resolves safe public command aliases without a shell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-alias-"));
  try {
    const tool = new ProcessTool(new WorkspaceBoundary(root), {
      allowedCommands: ["friendly-node"],
      commandAliases: {
        "friendly-node": { executable: process.execPath, argsPrefix: ["-e"] },
      },
    });
    const result = await tool.execute({ command: "friendly-node", args: ["process.stdout.write('aliased')"] }, context);
    assert.equal(result.ok, true);
    assert.match(JSON.stringify(result.output), /aliased/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restricted Node process cannot read outside workspace or widen its own permissions", async () => {
  const container = await mkdtemp(path.join(os.tmpdir(), "vanguard-permission-"));
  const root = path.join(container, "workspace");
  try {
    await mkdir(root);
    const inside = path.join(root, "inside.txt");
    const outside = path.join(container, "secret.txt");
    await writeFile(inside, "inside");
    await writeFile(outside, "secret");
    const tool = new ProcessTool(new WorkspaceBoundary(root), {
      allowedCommands: ["node"],
      commandAliases: {
        node: {
          executable: process.execPath,
          argsPrefix: [nodePermissionFlag(), `--allow-fs-read=${root}`, `--allow-fs-write=${root}`],
        },
      },
      deniedArgumentPrefixes: ["--allow-", "--no-permission", "--no-experimental-permission"],
    });
    const allowed = await tool.execute({
      command: "node",
      args: ["-e", "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))", inside],
    }, context);
    assert.equal(allowed.ok, true);
    const denied = await tool.execute({
      command: "node",
      args: ["-e", "require('fs').readFileSync(process.argv[1])", outside],
    }, context);
    assert.equal(denied.ok, false);
    assert.match(JSON.stringify(denied.output), /ERR_ACCESS_DENIED|restricted/i);
    const escalation = await tool.execute({ command: "node", args: ["--allow-fs-read=*", "-e", "0"] }, context);
    assert.equal(escalation.ok, false);
    assert.match(JSON.stringify(escalation.output), /blocked by process policy/i);
    const disable = await tool.execute({ command: "node", args: ["--no-permission", "-e", "0"] }, context);
    assert.equal(disable.ok, false);
    assert.match(JSON.stringify(disable.output), /blocked by process policy/i);
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

test("restricted Node process cannot mutate outside declared editable roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-process-scope-"));
  try {
    const editable = path.join(root, "src");
    await mkdir(editable);
    await mkdir(path.join(root, "test"));
    const tool = new ProcessTool(new WorkspaceBoundary(root), {
      allowedCommands: ["node"],
      commandAliases: {
        node: {
          executable: process.execPath,
          argsPrefix: [nodePermissionFlag(), `--allow-fs-read=${root}`, `--allow-fs-write=${editable}`],
        },
      },
    });
    const allowed = await tool.execute({
      command: "node",
      args: ["-e", "require('fs').writeFileSync('src/allowed.txt','ok')"],
    }, context);
    assert.equal(allowed.ok, true);
    const denied = await tool.execute({
      command: "node",
      args: ["-e", "require('fs').writeFileSync('test/outside.txt','bad')"],
    }, context);
    assert.equal(denied.ok, false);
    assert.match(JSON.stringify(denied.output), /ERR_ACCESS_DENIED|permission/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command verifier grades observable exit state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-verifier-"));
  try {
    await writeFile(path.join(root, "check.mjs"), "process.exit(0)");
    const tool = new ProcessTool(new WorkspaceBoundary(root), { allowedCommands: [process.execPath] });
    const verifier = new CommandVerifier("project tests", tool, {
      command: process.execPath,
      args: ["check.mjs"],
    });
    const result = await verifier.verify("I am done", "make it work");
    assert.equal(result.passed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command verifier summary hides privileged command output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-verifier-summary-"));
  try {
    await writeFile(path.join(root, "fail.mjs"), "process.stderr.write('SECRET_GRADER_PATH'); process.exit(1)");
    const tool = new ProcessTool(new WorkspaceBoundary(root), { allowedCommands: [process.execPath] });
    const verifier = new CommandVerifier("sealed", tool, {
      command: process.execPath,
      args: ["fail.mjs"],
    }, "summary");
    const result = await verifier.verify("done", "repair");
    assert.equal(result.passed, false);
    assert.doesNotMatch(JSON.stringify(result.evidence), /SECRET_GRADER_PATH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createBmp(
  width: number,
  height: number,
  colorAt: (x: number, y: number) => readonly [number, number, number],
): Buffer {
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const buffer = Buffer.alloc(54 + pixelBytes);
  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixelBytes, 34);
  for (let fileY = 0; fileY < height; fileY += 1) {
    const visualY = height - 1 - fileY;
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = colorAt(x, visualY);
      const index = 54 + fileY * rowStride + x * 3;
      buffer[index] = blue;
      buffer[index + 1] = green;
      buffer[index + 2] = red;
    }
  }
  return buffer;
}
