import assert from "node:assert/strict";
import test from "node:test";
import { renderTuiPreviewForTest } from "../src/tui.js";

test("terminal UI renders agent chat, tool activity, and verifier state within bounds", () => {
  const width = 96;
  const height = 32;
  const rendered = renderTuiPreviewForTest(width, height);
  const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /VANGUARD/);
  assert.match(plain, /AGENT STREAMS/);
  assert.match(plain, /main.*turn 7.*project\.check/);
  assert.match(plain, /scout.*turn 3.*workspace\.search/);
  assert.match(plain, /AGENT CHAT/);
  assert.match(plain, /implementation is ready/);
  assert.match(plain, /LIVE ACTIVITY/);
  assert.match(plain, /workspace integrity/);
  const lines = plain.split("\n");
  assert.ok(lines.length <= height);
  assert.ok(lines.every((line) => line.length <= width), "TUI lines must not overflow the terminal width");
});

test("terminal UI collapses cleanly at its minimum supported size", () => {
  const rendered = renderTuiPreviewForTest(58, 24).replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(rendered, /VANGUARD/);
  assert.match(rendered, /Q \/ Ctrl\+C cancel/);
  assert.ok(rendered.split("\n").every((line) => line.length <= 58));
});
