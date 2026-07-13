import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ProcessTool,
  WorkspaceBoundary,
  resolveSecurityPolicy,
  sanitizedChildEnvironment,
  sanitizePublicEvent,
} from "../src/index.js";

test("guarded security posture is fail-closed and does not claim OS isolation", () => {
  const guarded = resolveSecurityPolicy({ profile: "guarded" });
  assert.equal(guarded.restrictProcess, true);
  assert.equal(guarded.exposeRawProcess, false);
  assert.equal(guarded.verifierEvidence, "summary");
  assert.equal(guarded.fixedChecksRequireExternalIsolationForUntrustedCode, true);
  assert.match(guarded.limitations.join("\n"), /not a cross-language OS sandbox/i);

  assert.throws(
    () => resolveSecurityPolicy({ profile: "guarded", exposeRawProcess: true }),
    /cannot expose the raw process tool/i,
  );
  assert.throws(
    () => resolveSecurityPolicy({ profile: "guarded", restrictProcess: false }),
    /requires restricted process mode/i,
  );
  assert.throws(
    () => resolveSecurityPolicy({ profile: "guarded", verifierEvidence: "full" }),
    /summary-only verifier evidence/i,
  );
});

test("child processes receive build context but not provider secrets or interpreter preload injection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-security-env-"));
  try {
    await mkdir(path.join(root, "workspace"));
    const environment = sanitizedChildEnvironment({
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      PROJECT_MODE: "test",
      DEEPSEEK_API_KEY: "deepseek-secret-value",
      ANTHROPIC_AUTH_TOKEN: "anthropic-secret-value",
      NPM_TOKEN: "npm-secret-value",
      NODE_OPTIONS: "--import=malicious-loader.mjs",
      PYTHONSTARTUP: "malicious-startup.py",
    });
    assert.equal(environment.PROJECT_MODE, "test");
    assert.equal(environment.DEEPSEEK_API_KEY, undefined);
    assert.equal(environment.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(environment.NPM_TOKEN, undefined);
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.PYTHONSTARTUP, undefined);

    const tool = new ProcessTool(new WorkspaceBoundary(path.join(root, "workspace")), {
      allowedCommands: [process.execPath],
      environment,
    });
    const result = await tool.execute({
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({project:process.env.PROJECT_MODE,key:process.env.DEEPSEEK_API_KEY,node:process.env.NODE_OPTIONS,marker:process.env.VANGUARD_CHILD_PROCESS}))"],
    }, { task: "security", step: 1, signal: new AbortController().signal });
    assert.equal(result.ok, true);
    const output = result.output as { stdout?: string };
    assert.deepEqual(JSON.parse(output.stdout ?? "{}"), {
      project: "test",
      marker: "1",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public diagnostics redact environment and inline credentials under destructive input", () => {
  const secret = "super-secret-provider-value";
  const event = sanitizePublicEvent({
    type: "run.failed",
    agentId: "main",
    title: "failed",
    detail: `Inference endpoint returned HTTP 500: authorization=Bearer ${secret} api_key=${secret}`,
    message: `token=${secret}`,
  }, { DEEPSEEK_API_KEY: secret });
  const rendered = JSON.stringify(event);
  assert.equal(rendered.includes(secret), false);
  assert.match(rendered, /REDACTED|withheld/);
});

