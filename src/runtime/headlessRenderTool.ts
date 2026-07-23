import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { objectInput, stringField } from "./input.js";
import { WorkspaceBoundary } from "./workspace.js";

/**
 * The render arm of visual verification: an HTML deliverable is turned into
 * actual pixels by the system's own Chromium browser, headless, with the
 * screenshot written under `.vanguard/renders/` — a session-excluded
 * directory, so producing evidence never opens a workspace mutation epoch.
 *
 * Without this rung Vanguard could prove an HTML page parses and never once
 * see it. The screenshot feeds `inspect_image` today (exposure,
 * occlusion, contrast, layout regions of the real render, not the source),
 * and is the substrate for direct image-to-model judgment once the provider
 * codecs carry image content.
 *
 * Zero dependencies by design: the browser is located among first-party
 * system installations (or `VANGUARD_BROWSER`), the executable never comes
 * from model input, and a missing browser is an honest failure — never a
 * false pass.
 */

const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 800;
const MIN_VIEWPORT = 240;
const MAX_VIEWPORT = 3_840;
const RENDER_TIMEOUT_MS = renderTimeoutMs();
/**
 * Virtual time lets animations, fonts, and deferred scripts settle
 * deterministically. 20 virtual seconds of a requestAnimationFrame game
 * loop burns more wall time than the old 30s cap allowed; 8 virtual seconds
 * is enough for first paint and screenshots.
 */
const VIRTUAL_TIME_BUDGET_MS = 8_000;
const RENDER_OUTPUT_DIRECTORY = ".vanguard/renders";
const RENDERABLE_EXTENSIONS = new Set([".html", ".htm", ".svg"]);
// `--dump-dom` is runtime evidence, not model context. Keep enough locally to
// inspect realistic pages, then return only a compact diagnosis.
const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;
/**
 * Screenshots at or under this size ride inline in the tool output as base64,
 * so vision-capable providers receive the actual pixels. The cap keeps one
 * render from dominating the context byte budget; a larger capture degrades
 * to the on-disk file plus inspect_image.
 */
const MAX_INLINE_IMAGE_BYTES = 96_000;

export interface BrowserLocator {
  /** Absolute path of a runnable Chromium-family browser, or undefined. */
  locate(): Promise<string | undefined>;
}

export interface RenderProcessRunner {
  run(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<{ exitCode: number; output: string }>;
}

/**
 * Finds a first-party Chromium-family browser without a shell and without
 * model influence: an explicit VANGUARD_BROWSER override wins, then the
 * platform's well-known Edge/Chrome/Chromium installation paths.
 */
export class SystemChromiumLocator implements BrowserLocator {
  #located: Promise<string | undefined> | undefined;

  locate(): Promise<string | undefined> {
    this.#located ??= this.#find();
    return this.#located;
  }

  async #find(): Promise<string | undefined> {
    for (const candidate of browserCandidates()) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Not installed there; keep looking.
      }
    }
    return undefined;
  }
}

function browserCandidates(): readonly string[] {
  const override = process.env.VANGUARD_BROWSER;
  const candidates: string[] = override === undefined || override.length === 0 ? [] : [override];
  if (process.platform === "win32") {
    const roots = [
      process.env["ProgramFiles"],
      process.env["ProgramFiles(x86)"],
      process.env["LocalAppData"],
    ].filter((root): root is string => typeof root === "string" && root.length > 0);
    for (const root of roots) {
      candidates.push(
        path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(root, "Chromium", "Application", "chrome.exe"),
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/snap/bin/chromium",
    );
  }
  return candidates;
}

export class HeadlessRenderRunner implements RenderProcessRunner {
  async run(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], { windowsHide: true, shell: false });
      let output = "";
      let capturedBytes = 0;
      const capture = (chunk: Buffer): void => {
        if (capturedBytes >= MAX_CAPTURED_OUTPUT_BYTES) return;
        const slice = chunk.subarray(0, MAX_CAPTURED_OUTPUT_BYTES - capturedBytes);
        output += slice.toString("utf8");
        capturedBytes += slice.length;
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.stdin.end();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(
          `Headless render timed out after ${timeoutMs}ms. Raise VANGUARD_RENDER_TIMEOUT_MS for heavy pages.`,
        ));
      }, timeoutMs);
      timer.unref();
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, output }); });
    });
  }
}

export class HeadlessRenderTool implements ToolPort {
  readonly name = "render_artifact";
  readonly definition: ToolDefinition = {
    name: this.name,
    description: "Execute a workspace HTML or SVG file in a headless system browser, reject visible failure/loading shells, and capture a PNG screenshot under .vanguard/renders/. On vision-capable providers a small enough screenshot is attached to this result as an image; otherwise analyze it with inspect_image. Fails honestly when no system browser exists or the page does not reach a settled DOM.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative .html, .htm, or .svg file to render." },
        width: { type: "integer", minimum: MIN_VIEWPORT, maximum: MAX_VIEWPORT, description: `Viewport width in pixels; defaults to ${DEFAULT_VIEWPORT_WIDTH}.` },
        height: { type: "integer", minimum: MIN_VIEWPORT, maximum: MAX_VIEWPORT, description: `Viewport height in pixels; defaults to ${DEFAULT_VIEWPORT_HEIGHT}.` },
        inline: { type: "boolean", description: "Attach the screenshot bytes to this result for vision judgment; defaults to true. Captures over the inline byte budget always fall back to the on-disk file." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    // A successful capture is a real execution of the deliverable in a
    // runtime-owned browser process, not a source-code observation.
    effect: "execute",
    evidenceAuthority: "independent-execution",
  };

  constructor(
    private readonly workspace: WorkspaceBoundary,
    private readonly locator: BrowserLocator = new SystemChromiumLocator(),
    private readonly runner: RenderProcessRunner = new HeadlessRenderRunner(),
    private readonly timeoutMs = RENDER_TIMEOUT_MS,
  ) {}

  #warmed = false;

  /**
   * Best-effort cold-start warmup: locate the browser and run one headless
   * about:blank launch so the OS has the executable and its libraries in the
   * file cache before the first real render. The first Chromium launch on a
   * cold (or antivirus-scanned) machine costs multiple seconds; overlapping
   * it with the model's own thinking time makes the first real render cheap.
   * Never throws — a warmup must not be able to fail a run.
   */
  async warm(): Promise<void> {
    if (this.#warmed) return;
    this.#warmed = true;
    const browser = await this.locator.locate();
    if (browser === undefined) return;
    const profileDirectory = path.join(os.tmpdir(), `vanguard-warm-${randomUUID()}`);
    try {
      await this.runner.run(browser, [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--mute-audio",
        `--user-data-dir=${profileDirectory}`,
        "--dump-dom",
        "about:blank",
      ], Math.min(this.timeoutMs, 20_000));
    } catch {
      // Warmup is opportunistic; the real render reports real failures.
    } finally {
      await rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    const fields = objectInput(input);
    const relativePath = stringField(fields, "path");
    const width = integerField(fields, "width") ?? DEFAULT_VIEWPORT_WIDTH;
    const height = integerField(fields, "height") ?? DEFAULT_VIEWPORT_HEIGHT;
    const inline = fields.inline !== false;
    if (width < MIN_VIEWPORT || width > MAX_VIEWPORT || height < MIN_VIEWPORT || height > MAX_VIEWPORT) {
      throw new Error(`Viewport dimensions must be integers from ${MIN_VIEWPORT} through ${MAX_VIEWPORT}.`);
    }
    const extension = path.extname(relativePath).toLowerCase();
    if (!RENDERABLE_EXTENSIONS.has(extension)) {
      return { ok: false, output: { error: "render_artifact accepts .html, .htm, and .svg files." } };
    }

    const sourceFile = await this.workspace.existing(relativePath);
    const browser = await this.locator.locate();
    if (browser === undefined) {
      return {
        ok: false,
        output: {
          error: "No system Chromium-family browser (Edge, Chrome, Chromium) was found, so the page cannot be rendered. Set VANGUARD_BROWSER to a browser executable to enable visual evidence.",
        },
      };
    }

    const screenshotRelative = renderOutputPath(relativePath, width, height);
    const screenshotAbsolute = await this.workspace.writable(screenshotRelative);
    // A stale screenshot from a prior render must never pass as fresh evidence.
    await rm(screenshotAbsolute, { force: true });
    // A disposable profile keeps the render independent of any signed-in
    // browser state and immune to profile locks held by a running browser.
    const profileDirectory = path.join(os.tmpdir(), `vanguard-render-${randomUUID()}`);
    try {
      const attempts: string[] = [];
      let rendered = false;
      // `--headless=new` is the current mode; retry with the legacy flag for
      // older installations rather than failing the rung on flag vocabulary.
      for (const headlessFlag of ["--headless=new", "--headless"]) {
        const args = [
          headlessFlag,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          "--disable-sync",
          "--hide-scrollbars",
          "--mute-audio",
          "--force-device-scale-factor=1",
          `--user-data-dir=${profileDirectory}`,
          `--window-size=${width},${height}`,
          `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
          "--dump-dom",
          `--screenshot=${screenshotAbsolute}`,
          pathToFileURL(sourceFile).href,
        ];
        const result = await this.runner.run(browser, args, this.timeoutMs);
        if (result.exitCode === 0 && await isNonEmptyFile(screenshotAbsolute)) {
          const runtimeFailure = inspectRenderedDom(result.output);
          if (runtimeFailure !== undefined) {
            return {
              ok: false,
              output: {
                error: "The page rendered pixels but did not reach a healthy settled DOM.",
                browser: path.basename(browser),
                sourcePath: relativePath,
                runtimeFailure,
              },
            };
          }
          rendered = true;
          break;
        }
        attempts.push(`${headlessFlag}: exit ${result.exitCode}${result.output.trim().length === 0 ? "" : ` — ${compact(result.output)}`}`);
      }
      if (!rendered) {
        return {
          ok: false,
          output: {
            error: "The headless browser did not produce a screenshot.",
            browser: path.basename(browser),
            attempts,
          },
        };
      }
      const screenshot = await readFile(screenshotAbsolute);
      // Over-budget screenshots are DOWNSCALED, never omitted: a judge that
      // cannot see the pixels fails verification for a size reason the model
      // then grinds against forever. The full-resolution PNG stays on disk;
      // the inline copy is the same pixels captured smaller.
      let inlineImage: Buffer = screenshot;
      let inlineScale = 1;
      if (inline && screenshot.byteLength > MAX_INLINE_IMAGE_BYTES) {
        const shrunk = await this.#downscaleScreenshot(browser, screenshotAbsolute, width, height, profileDirectory);
        if (shrunk !== undefined) {
          inlineImage = shrunk.bytes;
          inlineScale = shrunk.scale;
        }
      }
      const inlined = inline && inlineImage.byteLength <= MAX_INLINE_IMAGE_BYTES;
      return {
        ok: true,
        output: {
          path: screenshotRelative,
          sourcePath: relativePath,
          browser: path.basename(browser),
          width,
          height,
          bytes: screenshot.byteLength,
          sha256: createHash("sha256").update(screenshot).digest("hex"),
          runtimeInspection: "settled DOM; no active loading status or visible failure alert",
          ...(inlined
            ? {
              image: {
                mediaType: "image/png",
                base64: inlineImage.toString("base64"),
                ...(inlineScale === 1 ? {} : { note: `downscaled to ${Math.round(inlineScale * 100)}% for the inline budget; the full-resolution PNG is at the recorded path` }),
              },
            }
            : {
              imageOmitted: inline
                ? `screenshot is ${screenshot.byteLength} bytes and could not be downscaled under the ${MAX_INLINE_IMAGE_BYTES}-byte inline budget; judge via inspect_image`
                : "inline attachment was disabled for this call",
            }),
          note: "This PNG is the real rendered page. Judge the deliverable from it, never from the source text.",
        },
      };
    } finally {
      await rm(profileDirectory, { recursive: true, force: true });
    }
  }

  /**
   * Re-captures an oversized screenshot at reduced scale using the same
   * Chromium: a wrapper page displays the PNG at scale and is screenshotted
   * at the scaled viewport. Tries progressively smaller scales until the
   * result fits the inline budget; undefined when none fits or capture fails.
   */
  async #downscaleScreenshot(
    browser: string,
    screenshotAbsolute: string,
    width: number,
    height: number,
    profileParent: string,
  ): Promise<{ bytes: Buffer; scale: number } | undefined> {
    for (const scale of [0.55, 0.4, 0.3]) {
      const scaledWidth = Math.max(MIN_VIEWPORT, Math.round(width * scale));
      const scaledHeight = Math.max(MIN_VIEWPORT, Math.round(height * scale));
      const wrapper = path.join(profileParent, `downscale-${Math.round(scale * 100)}.html`);
      const output = path.join(profileParent, `downscale-${Math.round(scale * 100)}.png`);
      try {
        await writeFile(wrapper, [
          "<!doctype html><html><head><style>",
          "html,body{margin:0;padding:0;background:#fff;overflow:hidden}",
          `img{display:block;width:${scaledWidth}px;height:${scaledHeight}px}`,
          "</style></head><body>",
          `<img src="${pathToFileURL(screenshotAbsolute).href}">`,
          "</body></html>",
        ].join(""), "utf8");
        const result = await this.runner.run(browser, [
          "--headless=new",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          "--hide-scrollbars",
          "--mute-audio",
          "--force-device-scale-factor=1",
          `--user-data-dir=${path.join(profileParent, `downscale-profile-${Math.round(scale * 100)}`)}`,
          `--window-size=${scaledWidth},${scaledHeight}`,
          `--screenshot=${output}`,
          pathToFileURL(wrapper).href,
        ], Math.min(this.timeoutMs, 30_000));
        if (result.exitCode !== 0 || !(await isNonEmptyFile(output))) continue;
        const bytes = await readFile(output);
        if (bytes.byteLength <= MAX_INLINE_IMAGE_BYTES) return { bytes, scale };
      } catch {
        // downscale is best-effort; the caller falls back to honest omission
      }
    }
    return undefined;
  }
}

/**
 * Chromium's serialized post-script DOM closes a gap screenshots cannot: a
 * polished loading veil can look intentional even when the application behind
 * it never booted. Treat an active loading status or explicitly visible alert
 * as a runtime failure. This is deliberately semantic and framework-agnostic.
 */
export function inspectRenderedDom(output: string): string | undefined {
  const htmlStart = output.search(/<(?:!doctype\s+html|html)\b/iu);
  if (htmlStart === -1) return "Chromium produced no serialized DOM; script execution could not be verified.";
  const html = output.slice(htmlStart);
  const startTag = /<([a-z][a-z0-9-]*)\b([^>]*)>/giu;
  for (const match of html.matchAll(startTag)) {
    const tag = match[1]!;
    const attributes = match[2] ?? "";
    if (isExplicitlyHidden(attributes)) continue;
    const role = attributeValue(attributes, "role")?.toLowerCase();
    const classes = (attributeValue(attributes, "class") ?? "").toLowerCase().split(/\s+/u);
    const content = [attributeValue(attributes, "aria-label"), elementText(html, tag, (match.index ?? 0) + match[0].length)]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join(" ");
    const inlineStyle = attributeValue(attributes, "style") ?? "";
    const alertIsActive = classes.some((name) => /^(?:visible|show|shown|active|error|open)$/u.test(name))
      || /display\s*:\s*(?:block|flex|grid)/iu.test(inlineStyle);
    if (role === "alert" && alertIsActive) {
      return `visible alert${content.length === 0 ? "" : `: ${content}`}`;
    }
    if (role === "status" && !hasInactiveClass(classes)
      && /\b(?:initiali[sz](?:e|ing)|loading|booting|starting|connecting|please wait)\b/iu.test(content)) {
      return `active loading status: ${content}`;
    }
  }
  return undefined;
}

function attributeValue(attributes: string, name: string): string | undefined {
  const expression = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu");
  const match = expression.exec(attributes);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function isExplicitlyHidden(attributes: string): boolean {
  if (/(?:^|\s)hidden(?:\s|=|$)/iu.test(attributes)) return true;
  if (attributeValue(attributes, "aria-hidden")?.toLowerCase() === "true") return true;
  return /display\s*:\s*none/iu.test(attributeValue(attributes, "style") ?? "");
}

function hasInactiveClass(classes: readonly string[]): boolean {
  return classes.some((name) => /^(?:hidden|hide|inactive|complete|completed|ready|sr-only)$/u.test(name));
}

function elementText(html: string, tag: string, contentStart: number): string {
  // Do not stop at the first closing tag: status/alert shells commonly contain
  // nested spinner/icon elements before their meaningful label.
  void tag;
  return html.slice(contentStart, Math.min(html.length, contentStart + 1_000))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}

/** Deterministic per-source-and-viewport location under the session-excluded renders directory. */
function renderOutputPath(relativePath: string, width: number, height: number): string {
  const flattened = relativePath
    .replaceAll("\\", "/")
    .replaceAll("/", "_")
    .replace(/[^A-Za-z0-9._-]/gu, "_");
  return `${RENDER_OUTPUT_DIRECTORY}/${flattened}.${width}x${height}.png`;
}

async function isNonEmptyFile(absolutePath: string): Promise<boolean> {
  try {
    const metadata = await stat(absolutePath);
    return metadata.isFile() && metadata.size > 0;
  } catch {
    return false;
  }
}

function compact(value: string, max = 400): string {
  const flattened = value.replace(/\s+/gu, " ").trim();
  return flattened.length <= max ? flattened : `${flattened.slice(0, max - 1)}…`;
}

/**
 * Wall-clock cap for one browser run. Heavy pages (large bundles, slow
 * fonts) can exceed two minutes on cold machines, so operators get an env
 * override; an absent or unparseable value falls back to the default.
 */
function renderTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.VANGUARD_RENDER_TIMEOUT_MS ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 120_000;
}

function integerField(fields: Record<string, JsonValue>, name: string): number | undefined {
  const value = fields[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Field '${name}' must be an integer.`);
  }
  return value;
}
