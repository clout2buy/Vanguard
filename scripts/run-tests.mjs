import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = path.join(root, "dist", "test");
const files = await collectTests(testRoot);

if (files.length === 0) {
  throw new Error(`No compiled tests were found under ${testRoot}. Run the build first.`);
}

const child = spawn(process.execPath, ["--test", ...files], {
  cwd: root,
  env: process.env,
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
