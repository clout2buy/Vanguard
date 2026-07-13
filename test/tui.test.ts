import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderTuiPreviewForTest, renderWelcomeForTest } from "../src/tui.js";

test("terminal product flow has one engine-backed execution path", async () => {
  const compiled = await readFile(new URL("../src/tui.js", import.meta.url), "utf8");
  assert.match(compiled, /new VanguardEngine\(/u);
  assert.match(compiled, /engine\.advance\(/u);
  assert.doesNotMatch(compiled, /function (?:startAgent|consumeChild|consumeLine)\b/u);
  assert.doesNotMatch(compiled, /PUBLIC_EVENT_PREFIX/u);
  assert.match(compiled, /process\.env\[credentialName\] = loadCredential\(config\.provider\)/u);
  assert.match(compiled, /delete process\.env\[credentialName\]/u);
});

test("default terminal launch opens a single conversational prompt", () => {
  const welcome = renderWelcomeForTest().replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(welcome, /VANGUARD/);
  assert.match(welcome, /Expert coding/);
  assert.match(welcome, /What should we work on\?/);
  assert.match(welcome, /Coding starts only when you ask for it/);
  assert.doesNotMatch(welcome, /Provider|Maximum agent turns|Verification command|Start isolated run|Workspace.*>/);
});

test("terminal UI renders agent chat, tool activity, and verifier state within bounds", () => {
  const width = 96;
  const height = 32;
  const rendered = renderTuiPreviewForTest(width, height);
  const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /VANGUARD/);
  assert.match(plain, /main.*#7.*project\.check/);
  assert.match(plain, /scout.*#3.*workspace\.search/);
  assert.match(plain, /You.*Repair the project/);
  assert.match(plain, /implementation is ready/);
  assert.match(plain, /workspace integrity/);
  assert.doesNotMatch(plain, /AGENT STREAMS|AGENT CHAT|LIVE ACTIVITY/);
  const lines = plain.split("\n");
  assert.ok(lines.length <= height);
  assert.ok(lines.every((line) => line.length <= width), "TUI lines must not overflow the terminal width");
});

test("terminal UI collapses cleanly at its minimum supported size", () => {
  const rendered = renderTuiPreviewForTest(58, 24).replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(rendered, /VANGUARD/);
  assert.match(rendered, /Ctrl\+C to stop/);
  assert.ok(rendered.split("\n").every((line) => line.length <= 58));
});
