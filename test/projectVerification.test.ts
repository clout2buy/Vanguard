import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectProjectVerification } from "../src/runtime/projectVerification.js";

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
