import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserLocator, CommandRunner, TypeScriptModuleLike } from "../src/index.js";
import { renderDoctorReport, runDoctor } from "../src/index.js";

const browserFound: BrowserLocator = { async locate() { return "C:/browsers/msedge.exe"; } };
const browserAbsent: BrowserLocator = { async locate() { return undefined; } };
const typescriptFound = async (): Promise<TypeScriptModuleLike> =>
  ({ version: "5.8.0" } as unknown as TypeScriptModuleLike);
const typescriptAbsent = async (): Promise<TypeScriptModuleLike | undefined> => undefined;
const cliPresent: CommandRunner = { async run() { return { exitCode: 0, output: "" }; } };
const cliAbsent: CommandRunner = { async run() { throw new Error("spawn ENOENT"); } };

test("doctor reports a fully equipped environment as ready with every rung ok", async () => {
  const report = await runDoctor({
    workspaceRoot: ".",
    environment: { ANTHROPIC_API_KEY: "key" } as NodeJS.ProcessEnv,
    browserLocator: browserFound,
    typescriptLoader: typescriptFound,
    syntaxRunner: cliPresent,
  });
  assert.equal(report.ready, true);
  const byName = new Map(report.results.map((result) => [result.name, result]));
  assert.equal(byName.get("provider credentials")?.status, "ok");
  assert.match(byName.get("provider credentials")?.detail ?? "", /ANTHROPIC_API_KEY/);
  assert.equal(byName.get("visual rung (artifact.render)")?.status, "ok");
  assert.equal(byName.get("TypeScript syntax rung")?.status, "ok");
  assert.match(byName.get("TypeScript syntax rung")?.detail ?? "", /5\.8\.0/);
  assert.equal(byName.get("Python syntax rung")?.status, "ok");
  assert.equal(byName.get("Go syntax rung")?.status, "ok");
});

test("doctor treats absent credentials as run-blocking and absent rungs as degraded", async () => {
  const report = await runDoctor({
    workspaceRoot: ".",
    environment: {} as NodeJS.ProcessEnv,
    browserLocator: browserAbsent,
    typescriptLoader: typescriptAbsent,
    syntaxRunner: cliAbsent,
    oauthConnected: async () => false,
  });
  assert.equal(report.ready, false, "no credentials must block readiness");
  const byName = new Map(report.results.map((result) => [result.name, result]));
  assert.equal(byName.get("provider credentials")?.status, "missing");
  assert.match(byName.get("provider credentials")?.remedy ?? "", /vanguard login/);
  // Degraded evidence rungs never block a run by themselves.
  assert.equal(byName.get("visual rung (artifact.render)")?.status, "degraded");
  assert.match(byName.get("visual rung (artifact.render)")?.remedy ?? "", /VANGUARD_BROWSER/);
  assert.equal(byName.get("TypeScript syntax rung")?.status, "degraded");
  assert.equal(byName.get("Python syntax rung")?.status, "degraded");
  assert.equal(byName.get("Go syntax rung")?.status, "degraded");

  const rendered = renderDoctorReport(report);
  assert.match(rendered, /\[MISS\] provider credentials/);
  assert.match(rendered, /\[WARN\] visual rung/);
  assert.match(rendered, /Not ready/);
});

test("doctor accepts an OAuth session or a whitespace-free key as credentials", async () => {
  const viaOAuth = await runDoctor({
    workspaceRoot: ".",
    environment: {} as NodeJS.ProcessEnv,
    browserLocator: browserFound,
    typescriptLoader: typescriptFound,
    syntaxRunner: cliPresent,
    oauthConnected: async () => true,
  });
  assert.equal(viaOAuth.ready, true);
  assert.match(
    viaOAuth.results.find((result) => result.name === "provider credentials")?.detail ?? "",
    /OAuth session/,
  );

  const blankKey = await runDoctor({
    workspaceRoot: ".",
    environment: { OPENAI_API_KEY: "   " } as NodeJS.ProcessEnv,
    browserLocator: browserFound,
    typescriptLoader: typescriptFound,
    syntaxRunner: cliPresent,
    oauthConnected: async () => false,
  });
  assert.equal(blankKey.ready, false, "a whitespace-only key is not a credential");

  // A throwing OAuth probe degrades to disconnected instead of crashing the doctor.
  const oauthError = await runDoctor({
    workspaceRoot: ".",
    environment: { DEEPSEEK_API_KEY: "key" } as NodeJS.ProcessEnv,
    browserLocator: browserFound,
    typescriptLoader: typescriptFound,
    syntaxRunner: cliPresent,
    oauthConnected: async () => { throw new Error("token store unreadable"); },
  });
  assert.equal(oauthError.ready, true);
});
