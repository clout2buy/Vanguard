import assert from "node:assert/strict";
import test from "node:test";
import { launchConversationResponseForTest, renderTuiPreviewForTest, renderWelcomeForTest } from "../src/tui.js";

test("default terminal launch asks only for the coding task", () => {
  const welcome = renderWelcomeForTest().replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(welcome, /VANGUARD/);
  assert.match(welcome, /Expert coding/);
  assert.match(welcome, /What should I build or fix\?/);
  assert.doesNotMatch(welcome, /Provider|Maximum agent turns|Verification command|Start isolated run|Workspace.*>/);
});

test("greetings stay conversational instead of launching coding tools", () => {
  assert.match(launchConversationResponseForTest("hi") ?? "", /What are we building/);
  assert.match(launchConversationResponseForTest("Hello, Vanguard!") ?? "", /What are we building/);
  assert.match(launchConversationResponseForTest("help") ?? "", /coding outcome/);
  assert.equal(launchConversationResponseForTest("Build a tested Node CLI"), undefined);
  assert.equal(launchConversationResponseForTest("Fix the failing parser"), undefined);
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
