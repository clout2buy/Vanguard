import assert from "node:assert/strict";
import { planTasks } from "../src/planner.mjs";

const tasks = [{ id: "build", dependsOn: ["lint"] }, { id: "docs" }, { id: "lint" }];
const copy = JSON.parse(JSON.stringify(tasks));
assert.deepEqual(planTasks(tasks), ["docs", "lint", "build"]); assert.deepEqual(tasks, copy);
assert.throws(() => planTasks([{ id: "a", dependsOn: ["b"] }]), /missing|unknown|depend/i);
assert.throws(() => planTasks([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }]), /cycle|circular/i);
console.log("dependency-planner: public checks passed");
