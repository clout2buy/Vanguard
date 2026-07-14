import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyReviewedManifest,
  createCodingSession,
  FileJournal,
  openCodingSession,
  reviewSessionChanges,
} from "../src/index.js";

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-inplace-src-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.ts"), "export const value = 1;\n");
  await writeFile(path.join(root, "readme.md"), "# project\n");
  return root;
}

test("an in-place session works directly on the real tree with a pristine baseline", async () => {
  const project = await projectFixture();
  let container: string | undefined;
  try {
    const session = await createCodingSession(project, { inPlace: true });
    container = path.dirname(session.metadataFile);
    assert.equal(session.inPlace, true);
    assert.equal(session.workspaceRoot, project);
    assert.equal(session.pristineRoot, path.join(container, "workspace"));
    assert.equal(session.materialized, true);

    // The pristine copy matches the original bytes.
    const pristine = await readFile(path.join(session.pristineRoot!, "src", "main.ts"), "utf8");
    assert.equal(pristine, "export const value = 1;\n");

    // An edit through the workspace root lands in the real project.
    await writeFile(path.join(session.workspaceRoot, "src", "main.ts"), "export const value = 2;\n");
    assert.equal(await readFile(path.join(project, "src", "main.ts"), "utf8"), "export const value = 2;\n");
    // The pristine baseline is untouched.
    assert.equal(await readFile(path.join(session.pristineRoot!, "src", "main.ts"), "utf8"), "export const value = 1;\n");
  } finally {
    await rm(project, { recursive: true, force: true });
    if (container !== undefined) await rm(container, { recursive: true, force: true });
  }
});

test("in-place review diffs the live tree against the baseline and apply is refused", async () => {
  const project = await projectFixture();
  let container: string | undefined;
  try {
    const session = await createCodingSession(project, { inPlace: true });
    container = path.dirname(session.metadataFile);
    await writeFile(path.join(project, "src", "main.ts"), "export const value = 3;\n");
    const journal = await FileJournal.open(path.join(container, "run.jsonl"));
    const manifest = await reviewSessionChanges(session, journal);
    assert.deepEqual(manifest.changes.map((change) => "path" in change ? change.path : change.kind), ["src/main.ts"]);

    await assert.rejects(
      applyReviewedManifest(session, journal, manifest.manifestHash, manifest.manifestHash),
      /no apply step/u,
    );
  } finally {
    await rm(project, { recursive: true, force: true });
    if (container !== undefined) await rm(container, { recursive: true, force: true });
  }
});

test("reopening an in-place session restores the flipped roots from canonical metadata", async () => {
  const project = await projectFixture();
  let container: string | undefined;
  try {
    const created = await createCodingSession(project, { inPlace: true });
    container = path.dirname(created.metadataFile);
    const metadata = JSON.parse(await readFile(created.metadataFile, "utf8")) as Record<string, unknown>;
    // Persisted metadata keeps the canonical container workspace path.
    assert.equal(metadata.workspaceRoot, path.join(container, "workspace"));
    assert.equal(metadata.inPlace, true);

    const reopened = await openCodingSession(container);
    assert.equal(reopened.inPlace, true);
    assert.equal(reopened.workspaceRoot, project);
    assert.equal(reopened.pristineRoot, path.join(container, "workspace"));
  } finally {
    await rm(project, { recursive: true, force: true });
    if (container !== undefined) await rm(container, { recursive: true, force: true });
  }
});

test("sandboxed sessions are unchanged by the in-place feature", async () => {
  const project = await projectFixture();
  let container: string | undefined;
  try {
    const session = await createCodingSession(project);
    container = path.dirname(session.metadataFile);
    assert.equal(session.inPlace, undefined);
    assert.equal(session.pristineRoot, undefined);
    assert.equal(session.workspaceRoot, path.join(container, "workspace"));
    // Editing the sandbox copy does not touch the real project.
    await writeFile(path.join(session.workspaceRoot, "src", "main.ts"), "export const value = 9;\n");
    assert.equal(await readFile(path.join(project, "src", "main.ts"), "utf8"), "export const value = 1;\n");
  } finally {
    await rm(project, { recursive: true, force: true });
    if (container !== undefined) await rm(container, { recursive: true, force: true });
  }
});
