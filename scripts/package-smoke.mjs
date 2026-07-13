import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "vanguard-pack-smoke-"));
const packed = path.join(temporary, "packed");
const consumer = path.join(temporary, "consumer with spaces");
const npmCli = process.env.npm_execpath
  ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} failed with ${String(result.status)}.`,
      result.error?.message ?? "",
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result.stdout;
}

try {
  await mkdir(packed);
  await mkdir(consumer);
  const packOutput = run(process.execPath, [npmCli, "pack", "--json", "--pack-destination", packed], root);
  const report = JSON.parse(packOutput);
  assert.equal(Array.isArray(report), true);
  const entry = report[0];
  assert.equal(typeof entry?.filename, "string");
  const names = new Set((entry.files ?? []).map((file) => file.path));
  for (const required of [
    "dist/src/cli.js",
    "dist/src/index.js",
    "dist/src/inference/providerProfiles.js",
    "docs/ENGINE_PROTOCOL.md",
    "docs/PROVIDERS.md",
    "docs/PORTABILITY.md",
    "docs/EXTENSIONS.md",
    "docs/THREAT_MODEL.md",
    "scripts/vanguard",
    "scripts/vanguard.ps1",
  ]) {
    assert.equal(names.has(required), true, `packed artifact is missing ${required}`);
  }
  const tarball = path.join(packed, entry.filename);
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }), "utf8");
  run(process.execPath, [npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumer);
  run(process.execPath, ["--input-type=module", "--eval", [
    'const api = await import("vanguard");',
    'if (api.VANGUARD_PROTOCOL_VERSION !== 1) throw new Error("engine export unavailable");',
    'if (typeof api.resolveProviderProfile !== "function") throw new Error("provider profile export unavailable");',
    'if (typeof api.VanguardEngine !== "function") throw new Error("embedded engine export unavailable");',
    'if (typeof api.resolveSecurityPolicy !== "function") throw new Error("security policy export unavailable");',
    'if (typeof api.reviewSessionChanges !== "function") throw new Error("review/apply export unavailable");',
    'if (typeof api.createSessionCheckpoint !== "function") throw new Error("time-travel export unavailable");',
    'if (typeof api.createConfiguredProviderModel !== "function") throw new Error("provider runtime export unavailable");',
    'if (typeof api.AresVanguardAdapter !== "function") throw new Error("Ares adapter export unavailable");',
  ].join("\n")], consumer);
  const help = run(process.execPath, [path.join(consumer, "node_modules", "vanguard", "dist", "src", "cli.js"), "--help"], consumer);
  assert.match(help, /Vanguard expert coding agent/u);
  const installed = JSON.parse(await readFile(path.join(consumer, "node_modules", "vanguard", "package.json"), "utf8"));
  assert.match(installed.engines.node, />=20/u);
  process.stdout.write(`Package smoke passed: ${entry.filename} (${entry.size} bytes)\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
