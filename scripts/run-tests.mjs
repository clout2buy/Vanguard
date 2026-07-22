import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = path.join(root, "dist", "test");
const files = await collectTests(testRoot);
const testConcurrency = boundedTestConcurrency(process.env.VANGUARD_TEST_CONCURRENCY);

if (files.length === 0) {
  throw new Error(`No compiled tests were found under ${testRoot}. Run the build first.`);
}

const child = spawn(process.execPath, ["--test", `--test-concurrency=${testConcurrency}`, ...files], {
  cwd: root,
  // Warmups spawn real browser processes; tests must stay hermetic.
  env: { ...process.env, VANGUARD_NO_PREWARM: "1" },
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", (error) => {
  process.stderr.write(`Could not start the Node test runner: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  if (signal !== null) {
    process.stderr.write(`Node test runner stopped by ${signal}.\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

async function collectTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const discovered = [];
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) discovered.push(...await collectTests(absolute));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) discovered.push(absolute);
  }
  return discovered;
}

function boundedTestConcurrency(configured) {
  if (configured === undefined || configured.trim().length === 0) return 4;
  if (!/^[1-9][0-9]*$/u.test(configured)) {
    throw new Error("VANGUARD_TEST_CONCURRENCY must be a positive integer.");
  }
  return Math.min(Number(configured), 4);
}
