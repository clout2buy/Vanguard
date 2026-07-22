import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReadFileTool, WorkspaceBoundary } from "../src/index.js";

const context = { task: "read-range", step: 1, signal: new AbortController().signal };

interface ReadOutput {
  readonly contents: string;
  readonly totalBytes: number;
  readonly range: { startByte: number; endByte: number };
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

async function withFile<T>(contents: string, body: (read: ReadFileTool) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-read-"));
  try {
    await writeFile(path.join(root, "index.html"), contents, "utf8");
    return await body(new ReadFileTool(new WorkspaceBoundary(root)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a range that overshoots the file clamps instead of failing", async () => {
  const html = "<!doctype html><title>Vanguard</title>";
  await withFile(html, async (read) => {
    // A caller cannot know a file's byte length before reading it. Asking for
    // more than exists used to be rejected outright, which sent the model into
    // a guess-and-retry loop against its own file.
    const result = await read.execute({ path: "index.html", range: { startByte: 0, endByte: 100_000 } }, context);
    assert.equal(result.ok, true);
    const output = result.output as unknown as ReadOutput;
    assert.equal(output.contents, html);
    assert.equal(output.totalBytes, Buffer.byteLength(html));
    // The response states the range actually read, so the caller learns the size.
    assert.deepEqual(output.range, { startByte: 0, endByte: Buffer.byteLength(html) });
    assert.equal(output.truncated, false);
    assert.equal(output.nextCursor, null);
  });
});

test("provider-style empty cursors and redundant page limits do not waste a retry", async () => {
  await withFile("0123456789", async (read) => {
    const result = await read.execute({
      path: "index.html",
      cursor: "",
      range: { startByte: 2, endByte: 6 },
      maxBytes: 20_000,
    }, context);
    assert.equal(result.ok, true);
    assert.equal((result.output as unknown as ReadOutput).contents, "2345");
  });
});

test("an overshooting range from a midpoint reads the remainder", async () => {
  const html = "0123456789abcdef";
  await withFile(html, async (read) => {
    const result = await read.execute({ path: "index.html", range: { startByte: 10, endByte: 999 } }, context);
    assert.equal(result.ok, true);
    const output = result.output as unknown as ReadOutput;
    assert.equal(output.contents, "abcdef");
    assert.deepEqual(output.range, { startByte: 10, endByte: 16 });
  });
});

test("reading at the end of the file is EOF, not an error", async () => {
  await withFile("abc", async (read) => {
    const result = await read.execute({ path: "index.html", range: { startByte: 3, endByte: 3 } }, context);
    assert.equal(result.ok, true);
    assert.equal((result.output as unknown as ReadOutput).contents, "");
  });
});

test("incoherent ranges are refused while a start beyond EOF becomes an EOF read", async () => {
  await withFile("abc", async (read) => {
    // Inverted.
    await assert.rejects(
      read.execute({ path: "index.html", range: { startByte: 2, endByte: 1 } }, context),
      /startByte <= endByte/u,
    );
    const eof = await read.execute({ path: "index.html", range: { startByte: 99, endByte: 120 } }, context);
    assert.equal(eof.ok, true);
    assert.equal((eof.output as unknown as ReadOutput).contents, "");
    assert.deepEqual((eof.output as unknown as ReadOutput).range, { startByte: 3, endByte: 3 });
    // Deliberately empty inside a non-empty file.
    await assert.rejects(
      read.execute({ path: "index.html", range: { startByte: 1, endByte: 1 } }, context),
      /must not be empty/u,
    );
  });
});

test("a clamped range never splits a multi-byte character", async () => {
  // "é" is two bytes; an endByte landing between them must snap back.
  const text = `${"a".repeat(4)}é${"b".repeat(4)}`;
  await withFile(text, async (read) => {
    const result = await read.execute({ path: "index.html", range: { startByte: 0, endByte: 5 } }, context);
    assert.equal(result.ok, true);
    const output = result.output as unknown as ReadOutput;
    assert.equal(output.contents, "aaaa");
    assert.equal(output.range.endByte, 4);
    assert.equal(output.truncated, true);
    assert.ok(output.nextCursor !== null, "a snapped range must still offer a way forward");
  });
});

test("approximate ranges that start inside a multi-byte character expand safely", async () => {
  const text = `aéb`;
  await withFile(text, async (read) => {
    const middle = await read.execute({ path: "index.html", range: { startByte: 2, endByte: 3 } }, context);
    assert.equal(middle.ok, true);
    const output = middle.output as unknown as ReadOutput;
    assert.equal(output.contents, "é");
    assert.deepEqual(output.range, { startByte: 1, endByte: 3 });

    const narrow = await read.execute({ path: "index.html", range: { startByte: 1, endByte: 2 } }, context);
    assert.equal(narrow.ok, true);
    assert.equal((narrow.output as unknown as ReadOutput).contents, "é");
  });
});
