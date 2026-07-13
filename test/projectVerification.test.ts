import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { detectProjectVerification } from "../src/runtime/projectVerification.js";

const executeFile = promisify(execFile);

test("project verification detects a Gradle wrapper without invoking a shell script", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "vanguard-gradle-detect-"));
  try {
    const wrapper = path.join(workspace, "gradle", "wrapper");
    await mkdir(wrapper, { recursive: true });
    await writeFile(path.join(wrapper, "gradle-wrapper.jar"), "fixture");

    assert.deepEqual(await detectProjectVerification(workspace), {
      command: "java",
      args: [
        "-classpath",
        path.join("gradle", "wrapper", "gradle-wrapper.jar"),
        "org.gradle.wrapper.GradleWrapperMain",
        "build",
        "--no-daemon",
      ],
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("project verification prefers a declared npm test command", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "vanguard-npm-detect-"));
  try {
    const wrapper = path.join(workspace, "gradle", "wrapper");
    await mkdir(wrapper, { recursive: true });
    await writeFile(path.join(wrapper, "gradle-wrapper.jar"), "fixture");
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node test.mjs" } }));

    assert.deepEqual(await detectProjectVerification(workspace), { command: "npm", args: ["test"] });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("automatic verification discovers a contract created after launch", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "vanguard-auto-verify-"));
  try {
    assert.equal(await detectProjectVerification(workspace), undefined);
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node test.mjs" } }));
    await writeFile(path.join(workspace, "test.mjs"), "import assert from 'node:assert/strict'; assert.equal(6 * 7, 42);\n");
    const executable = path.resolve("dist", "src", "autoVerify.js");
    const { stdout } = await executeFile(process.execPath, [executable], { cwd: workspace });
    assert.match(stdout, /\[verify\] npm test/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("automatic verification tells an agent how to establish a missing contract", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "vanguard-auto-missing-"));
  try {
    const executable = path.resolve("dist", "src", "autoVerify.js");
    await assert.rejects(
      executeFile(process.execPath, [executable], { cwd: workspace }),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string };
        assert.equal(failure.code, 2);
        assert.match(failure.stderr ?? "", /Create a package\.json test\/check\/build script/);
        return true;
      },
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
