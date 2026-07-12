import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceIntegrityVerifier } from "../src/index.js";

test("integrity verifier accepts scoped source changes and rejects test tampering", async () => {
  const container = await mkdtemp(path.join(os.tmpdir(), "vanguard-integrity-"));
  const source = path.join(container, "source");
  const workspace = path.join(container, "workspace");
  try {
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(path.join(source, "src", "code.js"), "broken");
    await writeFile(path.join(source, "test.js"), "protected");
    await cp(source, workspace, { recursive: true });
    const verifier = new WorkspaceIntegrityVerifier({
      sourceRoot: source,
      workspaceRoot: workspace,
      protectedPaths: ["test.js"],
      editableRoots: ["src"],
    });

    await writeFile(path.join(workspace, "src", "code.js"), "fixed");
    assert.equal((await verifier.verify("done", "repair")).passed, true);
    await writeFile(path.join(workspace, "test.js"), "weakened");
    const rejected = await verifier.verify("done", "repair");
    assert.equal(rejected.passed, false);
    assert.match(JSON.stringify(rejected.evidence), /test\.js/);
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});
