import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(process.argv[2] ?? ".");
const { planTasks } = await import(pathToFileURL(path.join(workspace, "src", "planner.mjs")));

const tasks = [
  { id: "deploy", dependsOn: ["build", "test"] },
  { id: "lint" },
  { id: "build", dependsOn: ["lint"] },
  { id: "docs", dependsOn: ["lint"] },
  { id: "test", dependsOn: ["build"] },
];
const snapshot = structuredClone(tasks);
assert.deepEqual(planTasks(tasks), ["lint", "build", "docs", "test", "deploy"]);
assert.deepEqual(tasks, snapshot);
assert.deepEqual(planTasks([{ id: "a" }, { id: "b" }, { id: "c" }]), ["a", "b", "c"]);
assert.deepEqual(planTasks([]), []);
assert.throws(() => planTasks([{ id: "a" }, { id: "a" }]), /duplicate/i);
assert.throws(() => planTasks([{ id: "a", dependsOn: ["missing"] }]), /missing|unknown/i);
assert.throws(() => planTasks([{ id: "a", dependsOn: ["a"] }]), /self|cycle/i);
assert.throws(
  () => planTasks([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }]),
  /cycle|circular/i,
);
assert.throws(() => planTasks(null));
assert.throws(() => planTasks([{ id: "" }]));
assert.throws(() => planTasks([{ id: "a", dependsOn: "b" }]));
console.log("dependency-planner: sealed grader passed");
