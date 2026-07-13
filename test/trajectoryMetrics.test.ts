import assert from "node:assert/strict";
import test from "node:test";
import type { RunEvent } from "../src/index.js";
import { analyzeTrajectory } from "../src/index.js";

test("trajectory metrics distinguish clean completion from recovery and policy failures", () => {
  const events: RunEvent[] = [
    { sequence: 1, type: "model.decided", data: { kind: "tool", call: { name: "workspace.read" } } },
    { sequence: 2, type: "tool.completed", data: { ok: true } },
    { sequence: 3, type: "model.decided", data: { kind: "tool", call: { name: "process.run" } } },
    { sequence: 4, type: "tool.failed", data: { ok: false, output: { error: "Argument is blocked by process policy." } } },
    { sequence: 5, type: "model.decided", data: { kind: "complete" } },
    { sequence: 6, type: "verification.completed", data: { passed: false } },
    { sequence: 7, type: "model.decided", data: { kind: "complete" } },
    { sequence: 8, type: "verification.completed", data: { passed: true } },
  ];
  assert.deepEqual(analyzeTrajectory(events), {
    modelDecisions: 4,
    toolCalls: 2,
    toolFailures: 1,
    localTestFailures: 0,
    testHarnessFailures: 0,
    toolFrictionFailures: 1,
    completionClaims: 2,
    verificationAttempts: 2,
    verificationFailures: 1,
    policyBlocks: 1,
    toolCallsByName: { "workspace.read": 1, "process.run": 1 },
  });
});

test("trajectory metrics treat a non-zero local test exit as productive evidence", () => {
  const events: RunEvent[] = [
    { sequence: 1, type: "model.decided", data: { kind: "tool", call: { name: "process.run" } } },
    { sequence: 2, type: "tool.failed", data: { ok: false, output: { exitCode: 1, stderr: "assertion" } } },
    { sequence: 3, type: "model.decided", data: { kind: "tool", call: { name: "workspace.replace" } } },
    { sequence: 4, type: "tool.completed", data: { ok: true } },
  ];
  const metrics = analyzeTrajectory(events);
  assert.equal(metrics.toolFailures, 1);
  assert.equal(metrics.localTestFailures, 1);
  assert.equal(metrics.testHarnessFailures, 0);
  assert.equal(metrics.toolFrictionFailures, 0);
});

test("trajectory metrics classify malformed inline tests as harness friction", () => {
  const events: RunEvent[] = [
    { sequence: 1, type: "model.decided", data: { kind: "tool", call: { name: "process.run" } } },
    { sequence: 2, type: "tool.failed", data: { ok: false, output: { exitCode: 1, stderr: "SyntaxError: Unexpected end at [eval1]" } } },
  ];
  const metrics = analyzeTrajectory(events);
  assert.equal(metrics.localTestFailures, 0);
  assert.equal(metrics.testHarnessFailures, 1);
  assert.equal(metrics.toolFrictionFailures, 1);
});

test("trajectory metrics classify invalid Node eval flags as harness friction", () => {
  const events: RunEvent[] = [
    { sequence: 1, type: "model.decided", data: { kind: "tool", call: { name: "process.run" } } },
    { sequence: 2, type: "tool.failed", data: { ok: false, output: { exitCode: 1, stderr: "ERR_EVAL_ESM_CANNOT_PRINT" } } },
  ];
  const metrics = analyzeTrajectory(events);
  assert.equal(metrics.testHarnessFailures, 1);
  assert.equal(metrics.toolFrictionFailures, 1);
});
