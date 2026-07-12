import assert from "node:assert/strict";
import test from "node:test";
import { classifyOutcome } from "../src/index.js";

test("outcome classification excludes provider failures from capability scoring", () => {
  assert.equal(classifyOutcome({ status: "completed", answer: "done", steps: 1, verification: [] }), "verified");
  assert.equal(classifyOutcome({ status: "failed", reason: "Model failure: Inference endpoint returned HTTP 400", steps: 4 }), "infrastructure_error");
  assert.equal(classifyOutcome({ status: "failed", reason: "Model failure: Inference response is not actionable", steps: 4 }), "capability_failure");
  assert.equal(classifyOutcome({ status: "failed", reason: "Step budget exhausted without verified completion.", steps: 50 }), "capability_failure");
});
