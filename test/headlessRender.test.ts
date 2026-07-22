import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrowserLocator, RenderProcessRunner, ToolContext } from "../src/index.js";
import {
  HeadlessRenderRunner,
  HeadlessRenderTool,
  SystemChromiumLocator,
  WorkspaceBoundary,
  inspectRenderedDom,
} from "../src/index.js";

const context: ToolContext = { task: "test", step: 1, signal: new AbortController().signal };

const fakeBrowser: BrowserLocator = { async locate() { return "/fake/chromium"; } };
const noBrowser: BrowserLocator = { async locate() { return undefined; } };

function screenshotArgument(args: readonly string[]): string | undefined {
  return args.find((argument) => argument.startsWith("--screenshot="))?.slice("--screenshot=".length);
}

test("render_artifact invokes a headless browser and reports the screenshot honestly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-render-"));
  try {
    await writeFile(path.join(root, "page.html"), "<!doctype html><h1>hello</h1>");
    const invocations: string[][] = [];
    const runner: RenderProcessRunner = {
      async run(_executable, args) {
        invocations.push([...args]);
        await writeFile(screenshotArgument(args)!, "fake png bytes");
        return { exitCode: 0, output: "<!doctype html><html><body><h1>hello</h1></body></html>" };
      },
    };
    const tool = new HeadlessRenderTool(new WorkspaceBoundary(root), fakeBrowser, runner);
    assert.equal(tool.definition.effect, "execute");
    assert.equal(tool.definition.evidenceAuthority, "independent-execution");
    const result = await tool.execute({ path: "page.html" }, context);
    assert.equal(result.ok, true);
    const output = result.output as Record<string, unknown>;
    assert.equal(output.path, ".vanguard/renders/page.html.1280x800.png");
    assert.equal(output.sourcePath, "page.html");
    assert.equal(typeof output.sha256, "string");
    assert.equal(await readFile(path.join(root, ".vanguard", "renders", "page.html.1280x800.png"), "utf8"), "fake png bytes");

    const args = invocations[0]!;
    assert.equal(args[0], "--headless=new");
    assert.ok(args.includes("--window-size=1280,800"));
    assert.ok(args.at(-1)!.startsWith("file:///"), "the source must be addressed as a file URL");
    assert.ok(args.some((argument) => argument.startsWith("--user-data-dir=")), "renders must use a disposable profile");
    assert.ok(args.includes("--dump-dom"), "runtime DOM inspection must accompany the screenshot");

    // Small captures ride inline as base64 so vision providers get pixels.
    const image = output.image as Record<string, unknown>;
    assert.equal(image.mediaType, "image/png");
    assert.equal(image.base64, Buffer.from("fake png bytes").toString("base64"));

    // Opting out keeps the result on-disk only.
    const optOut = await tool.execute({ path: "page.html", inline: false }, context);
    assert.equal(optOut.ok, true);
    const optOutOutput = optOut.output as Record<string, unknown>;
    assert.equal(optOutOutput.image, undefined);
    assert.match(String(optOutOutput.imageOmitted), /disabled/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("render_artifact never inlines a capture over the byte budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-render-large-"));
  try {
    await writeFile(path.join(root, "page.html"), "<p>big</p>");
    const runner: RenderProcessRunner = {
      async run(_executable, args) {
        await writeFile(screenshotArgument(args)!, Buffer.alloc(200_000, 7));
        return { exitCode: 0, output: "<html><body><p>big</p></body></html>" };
      },
    };
    const tool = new HeadlessRenderTool(new WorkspaceBoundary(root), fakeBrowser, runner);
    const result = await tool.execute({ path: "page.html" }, context);
    assert.equal(result.ok, true);
    const output = result.output as Record<string, unknown>;
    assert.equal(output.image, undefined, "an oversized capture must not dominate the context budget");
    assert.match(String(output.imageOmitted), /inline budget/u);
    assert.match(String(output.imageOmitted), /smaller viewport/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("render_artifact falls back to the legacy headless flag for older browsers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-render-legacy-"));
  try {
    await writeFile(path.join(root, "page.html"), "<p>ok</p>");
    const flagsTried: string[] = [];
    const runner: RenderProcessRunner = {
      async run(_executable, args) {
        flagsTried.push(args[0]!);
        if (args[0] === "--headless=new") return { exitCode: 1, output: "Unknown flag" };
        await writeFile(screenshotArgument(args)!, "legacy png");
        return { exitCode: 0, output: "<html><body><p>ok</p></body></html>" };
      },
    };
    const tool = new HeadlessRenderTool(new WorkspaceBoundary(root), fakeBrowser, runner);
    const result = await tool.execute({ path: "page.html" }, context);
    assert.equal(result.ok, true);
    assert.deepEqual(flagsTried, ["--headless=new", "--headless"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("render_artifact fails honestly with no browser, a bad extension, or no screenshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-render-fail-"));
  try {
    await writeFile(path.join(root, "page.html"), "<p>ok</p>");
    await writeFile(path.join(root, "notes.txt"), "not renderable");

    const neverRun: RenderProcessRunner = { async run() { throw new Error("must not spawn"); } };
    const missingBrowser = new HeadlessRenderTool(new WorkspaceBoundary(root), noBrowser, neverRun);
    const noBrowserResult = await missingBrowser.execute({ path: "page.html" }, context);
    assert.equal(noBrowserResult.ok, false);
    assert.match(JSON.stringify(noBrowserResult.output), /VANGUARD_BROWSER/);

    const wrongType = new HeadlessRenderTool(new WorkspaceBoundary(root), fakeBrowser, neverRun);
    const wrongTypeResult = await wrongType.execute({ path: "notes.txt" }, context);
    assert.equal(wrongTypeResult.ok, false);

    const silentRunner: RenderProcessRunner = { async run() { return { exitCode: 0, output: "" }; } };
    const silent = new HeadlessRenderTool(new WorkspaceBoundary(root), fakeBrowser, silentRunner);
    const silentResult = await silent.execute({ path: "page.html" }, context);
    assert.equal(silentResult.ok, false, "a zero exit without a screenshot file must not pass");
    assert.match(JSON.stringify(silentResult.output), /did not produce a screenshot/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("render_artifact rejects a stuck loading shell and a visible failure overlay", async () => {
  assert.match(
    inspectRenderedDom('<html><body><div role="status">Initializing WebGPU…</div></body></html>') ?? "",
    /active loading status/u,
  );
  assert.match(
    inspectRenderedDom('<html><body><div role="alert" class="failure visible">Module failed to load</div></body></html>') ?? "",
    /visible alert/u,
  );
  assert.equal(
    inspectRenderedDom('<html><body><div role="status" class="hidden">Loading</div><div role="alert" id="failure-overlay">Dormant</div><main>Ready</main></body></html>'),
    undefined,
  );

  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-render-stuck-"));
  try {
    await writeFile(path.join(root, "page.html"), '<div role="status">Initializing WebGPU…</div>');
    const runner: RenderProcessRunner = {
      async run(_executable, args) {
        await writeFile(screenshotArgument(args)!, "polished loading screenshot");
        return { exitCode: 0, output: '<html><body><div role="status">Initializing WebGPU…</div></body></html>' };
      },
    };
    const result = await new HeadlessRenderTool(new WorkspaceBoundary(root), fakeBrowser, runner)
      .execute({ path: "page.html" }, context);
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result.output), /did not reach a healthy settled DOM/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("render_artifact captures real pixels with a system browser", async (t) => {
  const browser = await new SystemChromiumLocator().locate();
  if (browser === undefined) {
    t.skip("no system Chromium-family browser installed");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-render-real-"));
  try {
    await writeFile(
      path.join(root, "splash.html"),
      "<!doctype html><html><body style=\"margin:0;background:#102030\">"
      + "<div style=\"width:100%;height:100vh;display:grid;place-items:center;color:#7fffd4;font:32px monospace\">VANGUARD SEES</div>"
      + "</body></html>",
    );
    const tool = new HeadlessRenderTool(new WorkspaceBoundary(root), new SystemChromiumLocator(), new HeadlessRenderRunner());
    const result = await tool.execute({ path: "splash.html", width: 900, height: 600 }, context);
    assert.equal(result.ok, true, `render failed: ${JSON.stringify(result.output)}`);
    const output = result.output as Record<string, unknown>;
    const screenshot = await readFile(path.join(root, output.path as string));
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(screenshot.subarray(0, 8).equals(pngSignature), "the capture must be a real PNG");
    assert.equal(screenshot.readUInt32BE(16), 900, "IHDR width must match the requested viewport");
    assert.equal(screenshot.readUInt32BE(20), 600, "IHDR height must match the requested viewport");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
