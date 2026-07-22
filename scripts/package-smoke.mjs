import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    "LICENSE",
    "docs/EMBEDDING.md",
    "docs/ACCEPTANCE.md",
    "docs/ARCHITECTURE.md",
    "docs/ARES_INTEGRATION.md",
    "docs/CERTIFICATION.md",
    "docs/DELEGATION.md",
    "docs/ENGINE_PROTOCOL.md",
    "docs/INDEPENDENCE.md",
    "docs/LIVE_RESULTS.md",
    "docs/PROVIDERS.md",
    "docs/PORTABILITY.md",
    "docs/EXTENSIONS.md",
    "docs/TESTING.md",
    "docs/THREAT_MODEL.md",
    "gauntlet/README.md",
    "scripts/credential.ps1",
    "scripts/export-credential.ps1",
    "scripts/set-project-secret.ps1",
    "scripts/install-cli.ps1",
    "scripts/run-preview.ps1",
    "scripts/run-project.ps1",
    "scripts/vanguard",
    "scripts/vanguard.ps1",
    "gauntlet/fixtures/repair-cart/TASK.md",
    "gauntlet/fixtures/repair-cart/src/cart.mjs",
  ]) {
    assert.equal(names.has(required), true, `packed artifact is missing ${required}`);
  }
  // Closed-source posture: compiled artifacts only — no TypeScript sources,
  // no source maps mapping the build back to them.
  for (const name of names) {
    assert.doesNotMatch(name, /\.map$/u, `packed artifact leaks a source map: ${name}`);
    assert.doesNotMatch(name, /^src\//u, `packed artifact leaks source: ${name}`);
    assert.equal(name.endsWith(".ts") && !name.endsWith(".d.ts"), false, `packed artifact leaks source: ${name}`);
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
  await writeFile(path.join(consumer, "consumer.ts"), [
    'import { AresVanguardAdapter, VanguardEngine, VANGUARD_PROTOCOL_VERSION } from "vanguard";',
    'const version: 1 = VANGUARD_PROTOCOL_VERSION;',
    'const engineType: typeof VanguardEngine = VanguardEngine;',
    'const adapterType: typeof AresVanguardAdapter = AresVanguardAdapter;',
    'void version; void engineType; void adapterType;',
  ].join("\n"), "utf8");
  run(process.execPath, [
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext",
    "--moduleResolution", "NodeNext", "--types", "node", "consumer.ts",
  ], consumer);
  const installedRoot = path.join(consumer, "node_modules", "vanguard");
  assert.equal(
    await readFile(path.join(consumer, "node_modules", "@types", "node", "package.json"), "utf8").then(() => true),
    true,
    "the packed public declarations require the declared @types/node runtime dependency",
  );
  if (process.platform === "win32") {
    const credentialHelper = path.join(installedRoot, "scripts", "export-credential.ps1");
    for (const [provider, variable] of [
      ["deepseek", "DEEPSEEK_API_KEY"],
      ["openai", "OPENAI_API_KEY"],
      ["anthropic", "ANTHROPIC_API_KEY"],
    ]) {
      const fixture = `vanguard-pack-${provider}-fixture`;
      const helperResult = spawnSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", credentialHelper, "-Provider", provider,
        "-Root", installedRoot,
      ], {
        cwd: consumer,
        encoding: "utf8",
        env: { ...process.env, [variable]: fixture },
        windowsHide: true,
      });
      assert.equal(helperResult.status, 0, helperResult.stderr);
      assert.equal(helperResult.stdout, fixture);
    }
    const packedLauncher = path.join(installedRoot, "scripts", "vanguard.ps1");
    const launcherResult = spawnSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", packedLauncher, "--help",
    ], { cwd: consumer, encoding: "utf8", windowsHide: true });
    assert.equal(launcherResult.status, 0, launcherResult.stderr);
    assert.match(launcherResult.stdout, /Vanguard expert coding agent/u);
  } else {
    const packedLauncher = path.join(installedRoot, "scripts", "vanguard");
    assert.match(run("sh", [packedLauncher, "--help"], consumer), /Vanguard expert coding agent/u);
  }
  const cli = path.join(installedRoot, "dist", "src", "cli.js");
  const help = run(process.execPath, [cli, "--help"], consumer);
  assert.match(help, /Vanguard expert coding agent/u);
  const installedBin = path.join(consumer, "node_modules", ".bin", "vanguard");
  const binResult = process.platform === "win32"
    ? spawnSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command", "& $env:VANGUARD_SMOKE_BIN --help",
      ], {
        cwd: consumer,
        encoding: "utf8",
        env: { ...process.env, VANGUARD_SMOKE_BIN: `${installedBin}.cmd` },
        windowsHide: true,
      })
    : spawnSync(installedBin, ["--help"], { cwd: consumer, encoding: "utf8" });
  assert.equal(binResult.status, 0, binResult.stderr);
  assert.match(binResult.stdout, /Vanguard expert coding agent/u);
  const tuiUrl = pathToFileURL(path.join(installedRoot, "dist", "src", "tui.js")).href;
  run(process.execPath, ["--input-type=module", "--eval", [
    `const tui = await import(${JSON.stringify(tuiUrl)});`,
    'const welcome = tui.renderWelcomeForTest("C:\\\\portable project", "fixture-model");',
    // Assert the packed TUI renders, not how it styles its wordmark: the banner
    // letter-spaces and per-letter colors "V A N G U A R D", so a substring
    // match on the raw string pins a cosmetic choice and fails on restyling.
    'const plain = welcome.replace(/\\x1b\\[[0-9;]*m/g, "");',
    'const wordmark = plain.replace(/\\s+/g, "");',
    'if (!wordmark.includes("VANGUARD") || !plain.includes("fixture-model")) throw new Error("packed TUI unavailable: " + JSON.stringify(plain.slice(0, 200)));',
  ].join("\n")], consumer);
  const installed = JSON.parse(await readFile(path.join(consumer, "node_modules", "vanguard", "package.json"), "utf8"));
  assert.match(installed.engines.node, />=20/u);
  process.stdout.write(`Package smoke passed: ${entry.filename} (${entry.size} bytes)\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
