import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
const javaRoot = path.join(root, "src", "main", "java", "dev", "vanguard", "ward");
const required = ["Claim.java", "ClaimStore.java", "PermissionService.java", "WardCommand.java", "WardMod.java"];
const files = await readdir(javaRoot);
for (const name of required) assert.ok(files.includes(name), `missing ${name}`);
for (const name of required) {
  const source = await readFile(path.join(javaRoot, name), "utf8");
  assert.doesNotMatch(source, /TODO|UnsupportedOperationException/, `${name} still contains a stub`);
  assert.match(source, /class\s+\w+|enum\s+\w+/, `${name} has no type declaration`);
}
const metadata = JSON.parse(await readFile(path.join(root, "src", "main", "resources", "fabric.mod.json"), "utf8"));
assert.equal(metadata.id, "ward");
assert.equal(metadata.version, "1.0.0");
assert.ok(metadata.entrypoints?.main?.includes("dev.vanguard.ward.WardMod"));
const lang = JSON.parse(await readFile(path.join(root, "src", "main", "resources", "assets", "ward", "lang", "en_us.json"), "utf8"));
for (const key of ["ward.claim.created", "ward.claim.overlap", "ward.claim.limit", "ward.build.denied"]) {
  assert.equal(typeof lang[key], "string"); assert.ok(lang[key].trim());
}
console.log("ward-mod: local structural checks passed");
