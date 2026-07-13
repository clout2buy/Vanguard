import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
const temporary = await mkdtemp(path.join(os.tmpdir(), "ward-public-check-"));
const classes = path.join(temporary, "classes");
await mkdir(classes);
try {
  const sources = await javaFiles(path.join(root, "src", "main", "java"));
  const harness = path.join(root, "tools", "PublicWardHarness.java");
  await execute("javac", ["-encoding", "UTF-8", "-source", "8", "-target", "8", "-d", classes, ...sources, harness], { maxBuffer: 5_000_000 });
  await execute("java", ["-ea", "-cp", classes, "PublicWardHarness"], { maxBuffer: 5_000_000 });

  const metadata = JSON.parse(await readFile(path.join(root, "src", "main", "resources", "fabric.mod.json"), "utf8"));
  assert.equal(metadata.id, "ward"); assert.equal(metadata.version, "1.0.0");
  assert.ok(metadata.entrypoints?.main?.includes("dev.vanguard.ward.WardMod"));
  const lang = JSON.parse(await readFile(path.join(root, "src", "main", "resources", "assets", "ward", "lang", "en_us.json"), "utf8"));
  for (const key of ["ward.claim.created", "ward.claim.overlap", "ward.claim.limit", "ward.build.denied"]) {
    assert.equal(typeof lang[key], "string"); assert.ok(lang[key].trim());
  }
  console.log("ward-mod: public compile and behavior checks passed");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function javaFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javaFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".java")) files.push(absolute);
  }
  return files.sort();
}
