import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildContinuationMessageForTest,
  flattenInlineProtocol,
  inspectTuiLifecycleForTest,
  renderFooterForTest,
  renderTranscriptForTest,
  splitStreamableMarkdown,
} from "../src/tui.js";
import {
  InlineRenderer,
  formatChatMessage,
  hardTruncate,
  layoutStreamRows,
  renderMarkdownLite,
  visibleCells,
} from "../src/tuiInline.js";
import type { PublicRunEvent } from "../src/runtime/publicRunEvents.js";

const plain = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");

test("conversation replies settle back to ready instead of spinning forever", () => {
  const state = inspectTuiLifecycleForTest([], { status: "responded", message: "Done." });
  assert.equal(state.phase, "idle");
  assert.equal(state.action, "ready");
  assert.match(state.detail, /next message/iu);
});

test("tool lifecycle tracks concurrent calls and clears the last completed tool", () => {
  const base = { agentId: "main", title: "workspace.read" } as const;
  const oneRemaining = inspectTuiLifecycleForTest([
    { ...base, type: "tool.started", status: "pending" },
    { ...base, type: "tool.started", status: "pending" },
    { ...base, type: "tool.completed", status: "passed" },
  ]);
  assert.equal(oneRemaining.phase, "tooling");
  assert.equal(oneRemaining.activeTools, 1);
  assert.match(oneRemaining.detail, /1 tool call still/iu);

  const settled = inspectTuiLifecycleForTest([
    { ...base, type: "tool.started", status: "pending" },
    { ...base, type: "tool.completed", status: "passed" },
  ]);
  assert.equal(settled.phase, "thinking");
  assert.equal(settled.activeTools, 0);
  assert.equal(settled.action, "reviewing result");
});

test("user and approval waits have an explicit waiting phase", () => {
  const waiting = inspectTuiLifecycleForTest([{
    type: "run.waiting_for_user",
    agentId: "main",
    title: "Waiting for your answer",
    status: "info",
    message: "Which target?",
  }]);
  assert.equal(waiting.phase, "waiting");
});

test("a streamed reply never prints raw markdown markers, at any chunk split", () => {
  const reply = "Fixed **two** bugs in `src/main.ts` and ran `npm test`.";
  // Whatever boundaries the provider streams on, the reader must never see a
  // literal ** or ` — the markers only appear once their span closes.
  for (const size of [1, 2, 3, 5, 8, 13, 21]) {
    let held = "";
    let printed = "";
    for (let at = 0; at < reply.length; at += size) {
      const split = splitStreamableMarkdown(held + reply.slice(at, at + size));
      printed += split.ready;
      held = split.held;
    }
    printed += held;
    assert.equal(printed, reply, `chunk size ${size} must stream the reply losslessly`);
    // Nothing may be emitted while its span is still open.
    let running = "";
    let openHeld = "";
    for (let at = 0; at < reply.length; at += size) {
      const split = splitStreamableMarkdown(openHeld + reply.slice(at, at + size));
      running += split.ready;
      openHeld = split.held;
      assert.equal((running.split("**").length - 1) % 2, 0, `bold span leaked at chunk ${size}`);
      assert.equal((running.split("`").length - 1) % 2, 0, `code span leaked at chunk ${size}`);
    }
  }
});

test("streamable split holds a marker that may still be growing", () => {
  assert.deepEqual(splitStreamableMarkdown("plain text"), { ready: "plain text", held: "" });
  // A lone trailing * could still become **; a lone ** could still close.
  assert.deepEqual(splitStreamableMarkdown("done *"), { ready: "done ", held: "*" });
  assert.deepEqual(splitStreamableMarkdown("a **bo"), { ready: "a ", held: "**bo" });
  assert.deepEqual(splitStreamableMarkdown("a **bold** b"), { ready: "a **bold** b", held: "" });
  assert.deepEqual(splitStreamableMarkdown("run `npm"), { ready: "run ", held: "`npm" });
  assert.deepEqual(splitStreamableMarkdown("run `npm test` now"), { ready: "run `npm test` now", held: "" });
});

test("terminal product flow has one engine-backed execution path", async () => {
  const compiled = await readFile(new URL("../src/tui.js", import.meta.url), "utf8");
  assert.match(compiled, /new VanguardEngine\(/u);
  assert.match(compiled, /engine\.advance\(/u);
  assert.doesNotMatch(compiled, /function (?:startAgent|consumeChild|consumeLine)\b/u);
  assert.doesNotMatch(compiled, /PUBLIC_EVENT_PREFIX/u);
  // An API-key launch installs the credential for the embedded engine and
  // restores the caller's environment on the way out; a subscription launch
  // must place no secret in the environment at all.
  assert.match(compiled, /config\.auth !== "api-key"\)\s*return \{ restore/u);
  assert.match(compiled, /process\.env\[credentialName\] = requireCredential\(config\.provider\)/u);
  assert.match(compiled, /delete process\.env\[credentialName\]/u);
  assert.doesNotMatch(compiled, /prompt\.question|createInterface/u, "the visible composer must own the real input");
});

test("the transcript lives on the normal screen buffer, never the alternate one", async () => {
  // The alternate screen is what took scrollback away; it must never come back.
  const compiled = await readFile(new URL("../src/tui.js", import.meta.url), "utf8");
  const inline = await readFile(new URL("../src/tuiInline.js", import.meta.url), "utf8");
  assert.doesNotMatch(compiled + inline, /\?1049/u, "no alternate-screen enter/leave anywhere");
});

test("the footer carries the live status contract: phase, budget, model", () => {
  const [status, composer] = renderFooterForTest("thinking", 100).map(plain);
  assert.match(status!, /thinking/);
  assert.match(status!, /turn 7\/240/, "the step budget stays visible while thinking");
  assert.match(status!, /12 tools/);
  assert.match(status!, /deepseek-v4-pro/);
  assert.match(status!, /ISOLATED/);
  assert.match(composer!, /steer or answer, then press Enter/, "an active turn keeps the steering composer live");
});

test("a pending tool owns the status row with its own elapsed clock", () => {
  const [status] = renderFooterForTest("tooling", 100).map(plain);
  assert.match(status!, /project\.check/);
  assert.match(status!, /trusted project verification/);
  assert.match(status!, /00:1[0-9]/, "the tool's own runtime shows, so long calls read as work, not a freeze");
});

test("footer rows never exceed the terminal width, even at the minimum size", () => {
  for (const phase of ["thinking", "tooling", "idle", "completed", "failed"] as const) {
    for (const line of renderFooterForTest(phase, 58)) {
      assert.ok(plain(line).length <= 58, `footer overflow at ${phase}: ${JSON.stringify(line)}`);
    }
  }
});

test("the transcript prints tool cards, chat, and verifier results", () => {
  const events: PublicRunEvent[] = [
    { type: "tool.started", agentId: "main", title: "workspace.read", status: "pending", detail: "src/main.ts", turn: 6 },
    { type: "tool.completed", agentId: "main", title: "workspace.read", status: "passed", detail: "src/main.ts" },
    { type: "agent.message", agentId: "main", title: "Agent", status: "info", message: "The implementation is ready for a full trusted build.", turn: 7 },
    { type: "verification.completed", agentId: "main", title: "workspace integrity", status: "passed" },
    { type: "run.completed", agentId: "main", title: "Run completed", status: "passed" },
  ];
  const rendered = plain(renderTranscriptForTest(events, 96));
  assert.match(rendered, /✓ workspace\.read src\/main\.ts/);
  assert.match(rendered, /◆ Vanguard {2}The implementation is ready/);
  assert.match(rendered, /◈ workspace integrity — passed/);
  assert.match(rendered, /◈ VERIFIED ◈ 1 tools · 0 files/);
});

test("a failed tool card carries its reason into the transcript", () => {
  const rendered = plain(renderTranscriptForTest([
    { type: "tool.started", agentId: "main", title: "process.run", status: "pending", detail: "npm run build" },
    { type: "tool.failed", agentId: "main", title: "process.run", status: "failed", detail: "exit 1 · src/main.js:42: Unexpected token" },
  ], 96));
  assert.match(rendered, /× process\.run/);
  assert.match(rendered, /exit 1 · src\/main\.js:42: Unexpected token/, "the actual compiler error must be visible, not just 'exit 1'");
});

test("delegate work is attributed, not anonymous", () => {
  const rendered = plain(renderTranscriptForTest([
    { type: "tool.completed", agentId: "scout-1", title: "workspace.search", status: "passed", detail: "texture loader" },
  ], 96));
  assert.match(rendered, /✓ scout-1 workspace\.search/);
});

test("an identical agent message prints exactly once", () => {
  const message = "Milestone m3 is done.";
  const rendered = plain(renderTranscriptForTest([
    { type: "agent.message", agentId: "main", title: "Agent", status: "info", message, turn: 3 },
    { type: "run.waiting_for_user", agentId: "main", title: "Waiting for your answer", status: "info", message },
  ], 96));
  assert.equal(rendered.split(message).length - 1, 1, "the ask_user echo must not print the same text twice");
});

test("streamed deltas plus their committed message print the reply once", () => {
  const reply = "Fixed **two** bugs in `src/main.ts`.";
  const events: PublicRunEvent[] = [
    { type: "agent.delta", agentId: "main", title: "Agent", status: "info", message: reply.slice(0, 20) },
    { type: "agent.delta", agentId: "main", title: "Agent", status: "info", message: reply.slice(20) },
    { type: "agent.message", agentId: "main", title: "Agent", status: "info", message: reply, turn: 2 },
  ];
  const rendered = plain(renderTranscriptForTest(events, 96));
  assert.equal(rendered.split("Fixed").length - 1, 1, "the streamed line must not reprint at commit time");
  assert.match(rendered, /◆ Vanguard {2}Fixed/);
});

test("approval requests print the command and its numbered actions", () => {
  const command = "bash -lc curl -sI https://unpkg.com --max-time 5";
  const rendered = plain(renderTranscriptForTest([
    { type: "approval.requested", agentId: "main", title: "Approval requested", status: "info", detail: command },
  ], 110));
  assert.match(rendered, /APPROVAL REQUIRED/);
  assert.match(rendered, /bash -lc curl -sI https:\/\/unpkg\.com/);
  assert.match(rendered, /\[1\] RUN ONCE/);
  assert.match(rendered, /\[2\] ALLOW SESSION/);
  assert.match(rendered, /\[3\] DENY/);
});

test("the inline renderer erases and repaints the footer without touching history", () => {
  let output = "";
  const renderer = new InlineRenderer({ write: (text: string) => { output += text; return true; } }, () => 80);
  renderer.setFooter(["status one", "composer"]);
  renderer.print("transcript line");
  renderer.setFooter(["status two", "composer"]);
  renderer.clearFooter();
  const text = plain(output);
  assert.match(text, /transcript line\n/, "content lands above the footer");
  assert.ok(output.includes("\x1b[1A\r\x1b[J"), "a two-row footer is erased with one relative move up");
  assert.ok(text.indexOf("status one") < text.indexOf("transcript line"), "footer stays below older content");
  assert.ok(text.indexOf("transcript line") < text.indexOf("status two"), "the repainted footer follows the new content");
});

test("footer repaints during an open stream never land inside the streamed prose", () => {
  // The production failure mode: the animation tick repainted the status row
  // while a reply streamed, gluing "⠴ thinking…" and the model badge into the
  // middle of sentences and chopping prose one chunk per line.
  let output = "";
  const renderer = new InlineRenderer({ write: (text: string) => { output += text; return true; } }, () => 60);
  renderer.setFooter(["⠴ thinking… 00:38 · turn 2/240", "composer"]);
  renderer.beginStream("◆ Vanguard  ");
  renderer.writeStream("I'm building it as a zero-dependency ");
  renderer.setFooter(["⠦ thinking… 00:39 · turn 2/240", "composer"]);
  renderer.writeStream("Node app so it stays lightweight and easy to run locally.");
  renderer.setFooter(["⠇ thinking… 00:40 · turn 2/240", "composer"]);
  renderer.endStream();
  renderer.clearFooter();
  const screen = plain(flattenInlineProtocol(output));
  assert.ok(!/zero-dependency.*thinking/.test(screen.replace(/\n/g, " ").slice(0, screen.indexOf("run locally."))),
    "the status line must never interleave with streamed prose");
  const prose = screen.split("\n").filter((line) => !line.includes("thinking") && !line.includes("composer")).join(" ");
  assert.match(prose.replace(/\s+/g, " "), /I'm building it as a zero-dependency Node app so it stays lightweight and easy to run locally\./,
    "every streamed word survives soft-wrapping and footer repaints");
  for (const line of flattenInlineProtocol(output).split("\n")) {
    assert.ok(plain(line).length < 60, `no physical row may reach the terminal width (got ${plain(line).length}: ${plain(line)})`);
  }
});

test("a streamed bold span keeps its styling across a soft-wrapped row boundary", () => {
  const { committed, tail, tailSgr } = layoutStreamRows(`start \x1b[1mbold text that wraps\x1b[0m end`, 16, "  ");
  assert.ok(committed.length >= 1, "long text must commit completed rows");
  assert.ok(committed[0]!.endsWith("\x1b[0m"), "committed rows are reset-terminated for scrollback");
  const continuation = committed.length > 1 ? committed[1]! : tailSgr + tail;
  assert.ok(continuation.includes("\x1b[1m"), "the bold span re-opens on the continuation row");
});

test("a verified follow-up carries prior task context without pretending it is a fresh build", () => {
  const message = buildContinuationMessageForTest(
    "Build a working inventory screen.",
    "main: Implemented it and the test command passed.",
    "The save button does not work.",
  );
  assert.match(message, /previous verified coding task completed in this same live project/iu);
  assert.match(message, /Build a working inventory screen/u);
  assert.match(message, /The save button does not work/u);
  assert.match(message, /Inspect and build on the existing files/iu);
});

test("CONVERGENCE collapses the starfield, seals the wordmark, and fades out", async () => {
  const { buildIntroFrames, playIntroAnimation } = await import("../src/tuiIntro.js");
  const frames = buildIntroFrames(100, 24);
  assert.ok(frames.length >= 24, "the sequence needs starfield, convergence, ignition, shockwave, crystallize, sweep, and fade phases");

  const plainFrames = frames.map((frame) => frame.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")));
  // Cold open: a starfield, no wordmark yet.
  assert.doesNotMatch(plainFrames[0]!.join("\n"), /VANGUARD/);
  // Ignition: the collapse lands on a single hot point.
  assert.ok(plainFrames.some((lines) => lines.join("\n").includes("◉")), "the convergence must ignite");
  // The held emblem carries the wordmark and the tagline; the final fade
  // hands a quiet screen to the welcome.
  assert.match(plainFrames.at(-3)!.join("\n"), /VANGUARD/);
  assert.match(plainFrames.at(-3)!.join("\n"), /VERIFICATION-FIRST · AGENTIC ENGINE/);
  assert.doesNotMatch(plainFrames.at(-1)!.join("\n"), /VANGUARD/, "the fade hands a quiet screen to the welcome");
  // Fixed canvas: every line of every frame has the same visible width, so
  // the animation cannot jitter, and it always fits the declared terminal.
  const widths = new Set(plainFrames.flat().map((line) => line.length));
  assert.equal(widths.size, 1, "all frames must share one canvas width");
  assert.ok([...widths][0]! <= 100);
  // Deterministic: same terminal size, same frames.
  const again = buildIntroFrames(100, 24);
  assert.deepEqual(again.map((frame) => frame.lines), frames.map((frame) => frame.lines));
  // The total runtime stays a moment, not a cutscene.
  const totalMs = frames.reduce((sum, frame) => sum + frame.holdMs, 0);
  assert.ok(totalMs >= 2_200, `the intro should feel cinematic, got only ${totalMs}ms`);
  assert.ok(totalMs <= 4_000, `the intro must stay skippably brief, got ${totalMs}ms`);

  // Big terminals get the grand canvas with the wider wordmark.
  const grand = buildIntroFrames(140, 40).map((frame) => frame.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")));
  assert.match(grand.at(-3)!.join("\n"), /V A N G U A R D/);
  const grandWidth = grand[0]![0]!.length;
  const compactWidth = plainFrames[0]![0]!.length;
  assert.ok(grandWidth > compactWidth, "a large terminal must get the grand canvas");

  // Non-TTY streams skip the animation entirely and never write.
  let wrote = false;
  await playIntroAnimation({ isTTY: false, columns: 100, rows: 40, write: () => { wrote = true; return true; } });
  assert.equal(wrote, false, "a non-interactive stream must never receive animation frames");
});

test("the launch flow runs inside a branded full-screen frame", async () => {
  const { renderLaunchHeaderForTest } = await import("../src/tui.js");
  const header = renderLaunchHeaderForTest("D:\\ForzaClone");
  assert.ok(header.startsWith("\x1b[2J\x1b[H"), "the launch frame must own the whole screen");
  const headerPlain = header.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[2J\x1b\[H/g, "");
  assert.match(headerPlain, /VANGUARD/);
  assert.match(headerPlain, /LAUNCH/);
  assert.match(headerPlain, /D:\\ForzaClone/);
});

test("a fenced code block streams as one unit and renders with a gutter, never raw fences", () => {
  // Held while the fence is still open, at any prefix.
  const open = splitStreamableMarkdown("Here is the fix:\n```ts\nconst x = 1;\nmore");
  assert.equal(open.ready, "Here is the fix:\n");
  assert.ok(open.held.startsWith("```ts"), "an open fence must be held whole");
  // Released once the closing fence line completes.
  const reply = "Here is the fix:\n```ts\nconst x = 1;\n```\ndone";
  const closed = splitStreamableMarkdown(reply);
  assert.equal(closed.ready + closed.held, reply, "a closed fence must stream losslessly");
  assert.ok(closed.ready.includes("const x = 1;"), "the closed fence body must be released");
  // Rendering strips the ``` markers and adds the gutter.
  const rendered = plain(renderMarkdownLite("```ts\nconst x = 1;\n```"));
  assert.ok(!rendered.includes("```"), "raw fence markers must never print");
  assert.ok(rendered.includes("│ const x = 1;"), "code lines carry the gutter verbatim");
  assert.match(rendered, /╭─+ ?ts/u, "the opening rule names the language");
});

test("headings hold until their line completes and render without hash markers", () => {
  const partial = splitStreamableMarkdown("## Summ");
  assert.equal(partial.ready, "");
  assert.equal(partial.held, "## Summ");
  const full = splitStreamableMarkdown("## Summary\nBody text");
  assert.equal(full.ready, "## Summary\nBody text");
  const rendered = plain(renderMarkdownLite("## Summary"));
  assert.equal(rendered, "Summary");
});

test("wide glyphs count as two terminal cells so row accounting cannot drift", () => {
  assert.equal(visibleCells("abc"), 3);
  assert.equal(visibleCells("日本語"), 6);
  assert.equal(visibleCells("\x1b[1m日本\x1b[0m"), 4);
  // Truncation never slices a wide glyph in half.
  assert.equal(plain(hardTruncate("日本語", 5)), "日本");
  // Streamed layout never splits a surrogate pair across committed rows.
  const emoji = "🎉".repeat(30);
  const rows = layoutStreamRows(emoji, 20, "");
  for (const row of [...rows.committed, rows.tail]) {
    assert.ok(!/[\ud800-\udbff]$/u.test(plain(row).replace(/\x1b\[0m$/u, "")), "no dangling high surrogate");
  }
});

test("chat messages keep code indentation and paragraph breaks", () => {
  const message = "First paragraph.\n\nSecond paragraph.\n```js\nif (x) {\n  nested();\n}\n```";
  const lines = formatChatMessage("main", message, 100).map(plain);
  assert.ok(lines.some((line) => line.includes("│   nested();")), "code indentation must survive formatting");
  const joined = lines.join("\n");
  assert.ok(!joined.includes("```"), "fence markers must not print in chat messages");
  const first = lines.findIndex((line) => line.includes("First paragraph."));
  const second = lines.findIndex((line) => line.includes("Second paragraph."));
  assert.ok(second - first === 2, "the blank line between paragraphs must survive");
});

test("live thinking feeds the footer, never the transcript", () => {
  const rendered = renderTranscriptForTest([
    { type: "agent.thinking", agentId: "main", title: "Agent", status: "info", message: "secret reasoning tail" },
    { type: "agent.message", agentId: "main", title: "Agent", status: "info", message: "The reply." },
  ]);
  assert.ok(!rendered.includes("secret reasoning tail"), "reasoning must stay out of scrollback");
  assert.ok(rendered.includes("The reply."), "the visible reply still prints");
});

test("the footer context gauge tracks the latest reported prompt size", () => {
  const state = inspectTuiLifecycleForTest([
    { type: "agent.usage", agentId: "main", title: "Agent", status: "info", detail: "24100" },
    { type: "agent.usage", agentId: "main", title: "Agent", status: "info", detail: "not-a-number" },
  ]);
  assert.equal(state.contextTokens, 24_100, "the latest valid report wins; garbage is ignored");
});
