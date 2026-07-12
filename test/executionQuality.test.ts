import assert from "node:assert/strict";
import test from "node:test";
import { scoreExecutionQuality } from "../src/index.js";

test("execution quality distinguishes clean verified work from churn", () => {
  const patch = {
    changedFiles: ["src/a.ts"], filesAdded: 0, filesDeleted: 0, filesModified: 1,
    beforeBytes: 100, afterBytes: 200, beforeLines: 10, afterLines: 20,
  };
  const clean = scoreExecutionQuality(true, {
    modelDecisions: 4, toolCalls: 3, toolFailures: 0, completionClaims: 1,
    verificationAttempts: 1, verificationFailures: 0, policyBlocks: 0,
    toolCallsByName: { "workspace.write": 1, "process.run": 1 },
  }, patch);
  assert.equal(clean.score, 1);
  assert.equal(clean.cleanFirstPass, true);
  assert.equal(clean.patchExpansionRatio, 2);

  const churn = scoreExecutionQuality(true, {
    modelDecisions: 12, toolCalls: 9, toolFailures: 2, completionClaims: 3,
    verificationAttempts: 3, verificationFailures: 2, policyBlocks: 0,
    toolCallsByName: { "workspace.write": 4, "process.run": 2 },
  }, patch);
  assert.equal(churn.score < clean.score, true);
  assert.equal(churn.cleanFirstPass, false);
  assert.equal(scoreExecutionQuality(false, churnTrajectory(), patch).score, 0);
});

function churnTrajectory() {
  return {
    modelDecisions: 12, toolCalls: 9, toolFailures: 2, completionClaims: 3,
    verificationAttempts: 3, verificationFailures: 2, policyBlocks: 0,
    toolCallsByName: { "workspace.write": 4, "process.run": 2 },
  };
}
