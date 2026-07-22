import assert from "node:assert/strict";
import test from "node:test";
import { scoreExecutionQuality } from "../src/index.js";

test("execution quality distinguishes clean verified work from churn", () => {
  const patch = {
    changedFiles: ["src/a.ts"], filesAdded: 0, filesDeleted: 0, filesModified: 1,
    beforeBytes: 100, afterBytes: 200, beforeLines: 10, afterLines: 20,
  };
  const clean = scoreExecutionQuality(true, {
    modelDecisions: 4, toolCalls: 3, toolFailures: 0, localTestFailures: 0, testHarnessFailures: 0, toolFrictionFailures: 0, completionClaims: 1,
    verificationAttempts: 1, verificationFailures: 0, policyBlocks: 0, contextCompactions: 0, contextProjections: 0,
    toolCallsByName: { "write_file": 1, "run_command": 1 },
  }, patch);
  assert.equal(clean.score, 1);
  assert.equal(clean.cleanFirstPass, true);
  assert.equal(clean.patchExpansionRatio, 2);

  const productive = scoreExecutionQuality(true, {
    modelDecisions: 7, toolCalls: 6, toolFailures: 1, localTestFailures: 1, testHarnessFailures: 0, toolFrictionFailures: 0, completionClaims: 1,
    verificationAttempts: 1, verificationFailures: 0, policyBlocks: 0, contextCompactions: 0, contextProjections: 0,
    toolCallsByName: { "write_file": 1, "edit_file": 1, "run_command": 2 },
  }, { ...patch, afterLines: 50 });
  assert.equal(productive.score, 1);
  assert.equal(productive.cleanFirstPass, true);
  assert.equal(productive.productiveTestFailures, 1);
  assert.deepEqual(productive.reviewFlags, ["large-patch-expansion"]);

  const churn = scoreExecutionQuality(true, {
    modelDecisions: 12, toolCalls: 9, toolFailures: 2, localTestFailures: 1, testHarnessFailures: 0, toolFrictionFailures: 1, completionClaims: 3,
    verificationAttempts: 3, verificationFailures: 2, policyBlocks: 0, contextCompactions: 0, contextProjections: 0,
    toolCallsByName: { "write_file": 4, "run_command": 2 },
  }, patch);
  assert.equal(churn.score < clean.score, true);
  assert.equal(churn.cleanFirstPass, false);
  assert.equal(scoreExecutionQuality(false, churnTrajectory(), patch).score, 0);
});

function churnTrajectory() {
  return {
    modelDecisions: 12, toolCalls: 9, toolFailures: 2, localTestFailures: 1, testHarnessFailures: 0, toolFrictionFailures: 1, completionClaims: 3,
    verificationAttempts: 3, verificationFailures: 2, policyBlocks: 0, contextCompactions: 0, contextProjections: 0,
    toolCallsByName: { "write_file": 4, "run_command": 2 },
  };
}
