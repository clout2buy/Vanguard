import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CommandVerifier,
  ListFilesTool,
  ProcessTool,
  ReadFileTool,
  ReplaceTextTool,
  SearchTextTool,
  WorkspaceBoundary,
  WorkspaceVersionLedger,
  WriteFileTool,
  contentHash,
} from "../src/index.js";

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
    });

    const listResult = await list.execute({}, context);
    assert.equal(listResult.ok, true);
    assert.deepEqual(listResult.output, { files: [path.join("src", "answer.txt")] });
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
          argsPrefix: ["--experimental-permission", `--allow-fs-read=${root}`, `--allow-fs-write=${root}`],
        },
      },
      deniedArgumentPrefixes: ["--allow-", "--no-experimental-permission"],
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
  } finally {
    await rm(container, { recursive: true, force: true });
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
