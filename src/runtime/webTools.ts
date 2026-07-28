import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { objectInput, stringField } from "./input.js";

const DEFAULT_FETCH_BYTES = 256 * 1024;
const MAX_FETCH_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const DEFAULT_SEARCH_RESULTS = 8;
const MAX_SEARCH_RESULTS = 10;
const SEARCH_RESPONSE_BYTES = 512 * 1024;
const SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const USER_AGENT = "Vanguard/0.2 (+https://github.com/vanguard)";

export interface NetworkTargetPolicy {
  assertAllowed(url: URL): Promise<void>;
}

export interface WebTransportOptions {
  readonly fetchImplementation?: typeof fetch;
  readonly targetPolicy?: NetworkTargetPolicy;
  readonly timeoutMs?: number;
}

interface BoundedResponse {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/**
 * Default-deny network policy for model-selected URLs. HTTP(S) is allowed only
 * for public DNS targets on the default ports; loopback, private, link-local,
 * documentation, multicast, and unspecified addresses are rejected.
 */
/**
 * Loopback reachability for services the runtime itself started.
 *
 * Supplied by the supervised-process registry, never by the model: the
 * allowance is derived from what Vanguard actually launched, so an agent can
 * check its own dev server without being able to ask for 127.0.0.1:22.
 */
export interface SupervisedLoopbackAllowance {
  allows(hostname: string, port: number): boolean;
}

export class PublicNetworkTargetPolicy implements NetworkTargetPolicy {
  constructor(private readonly loopback?: SupervisedLoopbackAllowance) {}

  async assertAllowed(url: URL): Promise<void> {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Only http:// and https:// URLs are supported.");
    }
    if (url.username.length > 0 || url.password.length > 0) {
      throw new Error("URLs containing credentials are not allowed.");
    }
    // A port a live supervised service is listening on is the one exception to
    // default-deny, and it is granted by the registry rather than requested.
    const requestedPort = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    if (this.loopback?.allows(url.hostname, requestedPort) === true) return;
    if ((url.protocol === "https:" && url.port !== "" && url.port !== "443")
      || (url.protocol === "http:" && url.port !== "" && url.port !== "80")) {
      throw new Error("Only the default HTTP and HTTPS ports are allowed.");
    }
    const hostname = normalizeHostname(url.hostname);
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
      throw new Error("Local network targets are not allowed.");
    }
    const literalFamily = isIP(hostname);
    if (literalFamily !== 0) {
      if (!isPublicAddress(hostname)) throw new Error("Private or non-routable network targets are not allowed.");
      return;
    }
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new Error("The target resolves to a private or non-routable address.");
    }
  }
}

export class WebFetchTool implements ToolPort {
  readonly name = "fetch_url";
  readonly definition: ToolDefinition = {
    name: this.name,
    description: "Fetch a public HTTP(S) page as bounded model-readable text, or a local port a run_service service is listening on. Redirects are revalidated and other private/local network targets are refused.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute public http:// or https:// URL." },
        maxBytes: {
          type: "integer",
          minimum: 4_096,
          maximum: MAX_FETCH_BYTES,
          description: `Maximum decoded response bytes; defaults to ${DEFAULT_FETCH_BYTES}.`,
        },
        includeLinks: { type: "boolean", description: "Extract a bounded list of links from HTML; defaults to true." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    effect: "observe",
  };

  readonly #client: BoundedWebClient;

  constructor(options: WebTransportOptions = {}) {
    this.#client = new BoundedWebClient(options);
  }

  async execute(input: JsonValue, context: ToolContext): Promise<ToolResult> {
    try {
      const fields = objectInput(input);
      const requestedUrl = stringField(fields, "url");
      const maxBytes = optionalNumberField(fields, "maxBytes") ?? DEFAULT_FETCH_BYTES;
      const includeLinks = optionalBooleanField(fields, "includeLinks") ?? true;
      assertIntegerRange(maxBytes, 4_096, MAX_FETCH_BYTES, "maxBytes");
      const response = await this.#client.get(requestedUrl, maxBytes, context.signal);
      const decoded = decodeText(response.bytes, response.contentType);
      const html = isHtml(response.contentType, decoded);
      const text = html ? htmlToText(decoded) : decoded;
      const output: Record<string, JsonValue> = {
        requestedUrl: response.requestedUrl,
        finalUrl: response.finalUrl,
        status: response.status,
        contentType: response.contentType,
        bytes: response.bytes.byteLength,
        truncated: response.truncated,
        sha256: createHash("sha256").update(response.bytes).digest("hex"),
        text,
      };
      if (html) {
        const title = htmlTitle(decoded);
        if (title !== undefined) output.title = title;
        if (includeLinks) output.links = extractLinks(decoded, response.finalUrl, 40) as unknown as JsonValue;
      }
      return { ok: response.status >= 200 && response.status < 300, output };
    } catch (error) {
      return { ok: false, output: { error: errorMessage(error) } };
    }
  }
}

export class WebSearchTool implements ToolPort {
  readonly name = "search_web";
  readonly definition: ToolDefinition = {
    name: this.name,
    description: "Search the public web and return bounded titles, URLs, and snippets. Use fetch_url to inspect a result.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query, 1 to 500 characters." },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SEARCH_RESULTS,
          description: `Maximum results; defaults to ${DEFAULT_SEARCH_RESULTS}.`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    effect: "observe",
  };

  readonly #client: BoundedWebClient;
  readonly #searchEndpoint: string;

  constructor(options: WebTransportOptions & { readonly searchEndpoint?: string } = {}) {
    this.#client = new BoundedWebClient(options);
    this.#searchEndpoint = options.searchEndpoint ?? SEARCH_ENDPOINT;
  }

  async execute(input: JsonValue, context: ToolContext): Promise<ToolResult> {
    try {
      const fields = objectInput(input);
      const query = stringField(fields, "query").trim();
      const maxResults = optionalNumberField(fields, "maxResults") ?? DEFAULT_SEARCH_RESULTS;
      if (query.length === 0 || query.length > 500) throw new Error("query must contain 1 to 500 characters.");
      assertIntegerRange(maxResults, 1, MAX_SEARCH_RESULTS, "maxResults");
      const endpoint = new URL(this.#searchEndpoint);
      endpoint.searchParams.set("q", query);
      const response = await this.#client.get(endpoint.href, SEARCH_RESPONSE_BYTES, context.signal);
      if (response.status < 200 || response.status >= 300) {
        return {
          ok: false,
          output: { error: `Search provider returned HTTP ${response.status}.`, query, provider: endpoint.hostname },
        };
      }
      const html = decodeText(response.bytes, response.contentType);
      const results = parseSearchResults(html, response.finalUrl, maxResults);
      return {
        ok: true,
        output: {
          query,
          provider: new URL(response.finalUrl).hostname,
          results: results as unknown as JsonValue,
          truncated: results.length === maxResults,
        },
      };
    } catch (error) {
      return { ok: false, output: { error: errorMessage(error) } };
    }
  }
}

class BoundedWebClient {
  readonly #fetch: typeof fetch;
  readonly #policy: NetworkTargetPolicy;
  readonly #timeoutMs: number;

  constructor(options: WebTransportOptions) {
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
    this.#policy = options.targetPolicy ?? new PublicNetworkTargetPolicy();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    assertIntegerRange(this.#timeoutMs, 1, 120_000, "timeoutMs");
  }

  async get(input: string, maxBytes: number, signal: AbortSignal): Promise<BoundedResponse> {
    const requested = parseAbsoluteUrl(input);
    let current = requested;
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      await this.#policy.assertAllowed(current);
      const controller = new AbortController();
      const abort = (): void => controller.abort(signal.reason);
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("Web request timed out.")), this.#timeoutMs);
      try {
        const response = await this.#fetch(current.href, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "text/html,application/xhtml+xml,application/json,text/plain,text/markdown,application/xml,text/xml;q=0.9,*/*;q=0.1",
            "user-agent": USER_AGENT,
          },
        });
        if (isRedirect(response.status)) {
          const location = response.headers.get("location");
          if (location === null) throw new Error(`Redirect HTTP ${response.status} omitted Location.`);
          if (redirect === MAX_REDIRECTS) throw new Error(`Web request exceeded ${MAX_REDIRECTS} redirects.`);
          current = new URL(location, current);
          continue;
        }
        const contentLength = parseContentLength(response.headers.get("content-length"));
        if (contentLength !== undefined && contentLength > maxBytes) {
          throw new Error(`Web response declares ${contentLength} bytes, exceeding the ${maxBytes} byte limit.`);
        }
        const { bytes, truncated } = await readBounded(response.body, maxBytes, controller);
        return {
          requestedUrl: requested.href,
          finalUrl: current.href,
          status: response.status,
          contentType: response.headers.get("content-type") ?? "application/octet-stream",
          bytes,
          truncated,
        };
      } catch (error) {
        if (controller.signal.aborted) {
          if (signal.aborted) throw new Error("Web request aborted.");
          throw new Error("Web request timed out.");
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    }
    throw new Error("Web redirect handling failed.");
  }
}

async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  controller: AbortController,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (body === null) return { bytes: new Uint8Array(), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const remaining = maxBytes - total;
      if (item.value.byteLength > remaining) {
        if (remaining > 0) chunks.push(item.value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        controller.abort();
        break;
      }
      chunks.push(item.value);
      total += item.value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: output, truncated };
}

function parseSearchResults(html: string, baseUrl: string, limit: number): readonly SearchResult[] {
  const anchors = [...html.matchAll(
    /<a\b[^>]*class\s*=\s*["'][^"']*(?:result__a|result-link)[^"']*["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu,
  )];
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const [index, anchor] of anchors.entries()) {
    if (results.length >= limit) break;
    const href = anchor[1];
    const titleMarkup = anchor[2];
    if (href === undefined || titleMarkup === undefined) continue;
    const url = unwrapSearchUrl(href, baseUrl);
    if (url === undefined || seen.has(url)) continue;
    const segmentStart = (anchor.index ?? 0) + anchor[0].length;
    const segmentEnd = anchors[index + 1]?.index ?? Math.min(html.length, segmentStart + 8_000);
    const segment = html.slice(segmentStart, segmentEnd);
    const snippetMatch = /<(?:a|div|td)\b[^>]*class\s*=\s*["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|td)>/iu.exec(segment);
    const title = inlineText(titleMarkup);
    if (title.length === 0) continue;
    results.push({
      title,
      url,
      snippet: snippetMatch?.[1] === undefined ? "" : inlineText(snippetMatch[1]),
    });
    seen.add(url);
  }
  return results;
}

function extractLinks(html: string, baseUrl: string, limit: number): readonly { text: string; url: string }[] {
  const links: Array<{ text: string; url: string }> = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/giu)) {
    if (links.length >= limit) break;
    const href = match[1];
    if (href === undefined) continue;
    try {
      const url = new URL(decodeEntities(href), baseUrl);
      if ((url.protocol !== "https:" && url.protocol !== "http:") || seen.has(url.href)) continue;
      links.push({ text: inlineText(match[2] ?? "").slice(0, 300), url: url.href });
      seen.add(url.href);
    } catch {
      // Malformed page links are ignored; they do not invalidate the fetch.
    }
  }
  return links;
}

function unwrapSearchUrl(href: string, baseUrl: string): string | undefined {
  try {
    const parsed = new URL(decodeEntities(href), baseUrl);
    const redirected = parsed.searchParams.get("uddg");
    const target = redirected === null ? parsed : new URL(redirected);
    if (target.protocol !== "https:" && target.protocol !== "http:") return undefined;
    target.hash = "";
    return target.href;
  } catch {
    return undefined;
  }
}

function htmlTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  if (match?.[1] === undefined) return undefined;
  const title = inlineText(match[1]);
  return title.length === 0 ? undefined : title.slice(0, 500);
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(?:script|style|noscript|svg|template)\b[\s\S]*?<\/(?:script|style|noscript|svg|template)>/giu, " ")
      .replace(/<(?:br|hr)\b[^>]*>|<\/(?:p|div|section|article|main|header|footer|li|h[1-6]|tr)>/giu, "\n")
      .replace(/<[^>]+>/gu, " "),
  )
    .replace(/[ \t\f\v]+/gu, " ")
    .replace(/ +([,.;:!?])/gu, "$1")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function inlineText(markup: string): string {
  return decodeEntities(markup.replace(/<[^>]+>/gu, " "))
    .replace(/\s+/gu, " ")
    .replace(/ +([,.;:!?])/gu, "$1")
    .trim();
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/giu, (entity, body: string) => {
    const lowered = body.toLowerCase();
    if (lowered === "amp") return "&";
    if (lowered === "apos") return "'";
    if (lowered === "gt") return ">";
    if (lowered === "lt") return "<";
    if (lowered === "nbsp") return " ";
    if (lowered === "quot") return "\"";
    const point = lowered.startsWith("#x")
      ? Number.parseInt(lowered.slice(2), 16)
      : Number.parseInt(lowered.slice(1), 10);
    return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

function decodeText(bytes: Uint8Array, contentType: string): string {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/iu.exec(contentType)?.[1]?.toLowerCase();
  try {
    return new TextDecoder(charset === "us-ascii" ? "utf-8" : charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function isHtml(contentType: string, text: string): boolean {
  return /(?:text\/html|application\/xhtml\+xml)/iu.test(contentType) || /^\s*<!doctype\s+html|^\s*<html\b/iu.test(text);
}

function parseAbsoluteUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("url must be an absolute http:// or https:// URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http:// and https:// URLs are supported.");
  }
  return parsed;
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
}

function isPublicAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family !== 6) return false;
  const lowered = normalized.toLowerCase();
  if (lowered.startsWith("::ffff:")) {
    const mapped = lowered.slice("::ffff:".length);
    return isIP(mapped) === 4 && isPublicIpv4(mapped);
  }
  if (lowered === "::" || lowered === "::1") return false;
  const first = Number.parseInt(lowered.split(":")[0] ?? "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return false; // multicast ff00::/8
  if (lowered.startsWith("2001:db8:")) return false; // documentation
  return true;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function assertIntegerRange(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function optionalNumberField(input: Record<string, JsonValue>, name: string): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(`Field '${name}' must be a number.`);
  return value;
}

function optionalBooleanField(input: Record<string, JsonValue>, name: string): boolean | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Field '${name}' must be a boolean.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
