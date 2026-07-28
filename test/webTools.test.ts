import assert from "node:assert/strict";
import test from "node:test";
import {
  PublicNetworkTargetPolicy,
  WebFetchTool,
  WebSearchTool,
  type NetworkTargetPolicy,
} from "../src/index.js";

const context = { task: "test", step: 1, signal: new AbortController().signal };
const allowAll: NetworkTargetPolicy = { assertAllowed: async () => {} };

test("fetch_url returns bounded readable HTML with links and provenance", async () => {
  const html = `<!doctype html><html><head><title>Docs &amp; API</title><style>hidden</style></head>
    <body><h1>Reference</h1><p>Hello <strong>world</strong>.</p>
    <a href="/guide">Read the guide</a><script>secret()</script></body></html>`;
  const tool = new WebFetchTool({
    targetPolicy: allowAll,
    fetchImplementation: (async () => new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as typeof fetch,
  });
  const result = await tool.execute({ url: "https://example.test/docs" }, context);
  assert.equal(result.ok, true);
  const output = result.output as {
    title: string;
    text: string;
    links: Array<{ text: string; url: string }>;
    sha256: string;
  };
  assert.equal(output.title, "Docs & API");
  assert.match(output.text, /Reference\s+Hello world\./u);
  assert.doesNotMatch(output.text, /hidden|secret/iu);
  assert.deepEqual(output.links, [{ text: "Read the guide", url: "https://example.test/guide" }]);
  assert.match(output.sha256, /^[a-f0-9]{64}$/u);
});

test("fetch_url revalidates redirects and refuses oversized declared responses", async () => {
  const checked: string[] = [];
  const policy: NetworkTargetPolicy = { assertAllowed: async (url) => { checked.push(url.href); } };
  let calls = 0;
  const redirecting = new WebFetchTool({
    targetPolicy: policy,
    fetchImplementation: (async () => {
      calls += 1;
      return calls === 1
        ? new Response(null, { status: 302, headers: { location: "https://cdn.example.test/final" } })
        : new Response("done", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch,
  });
  const redirected = await redirecting.execute({ url: "https://example.test/start" }, context);
  assert.equal(redirected.ok, true);
  assert.deepEqual(checked, ["https://example.test/start", "https://cdn.example.test/final"]);

  const oversized = new WebFetchTool({
    targetPolicy: allowAll,
    fetchImplementation: (async () => new Response("small", {
      status: 200,
      headers: { "content-length": "999999", "content-type": "text/plain" },
    })) as typeof fetch,
  });
  const rejected = await oversized.execute({ url: "https://example.test", maxBytes: 4096 }, context);
  assert.equal(rejected.ok, false);
  assert.match(String((rejected.output as { error: string }).error), /exceeding/iu);
});

test("fetch_url truncates streaming responses at the requested byte bound", async () => {
  const body = "x".repeat(8_000);
  const tool = new WebFetchTool({
    targetPolicy: allowAll,
    fetchImplementation: (async () => new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch,
  });
  const result = await tool.execute({ url: "https://example.test", maxBytes: 4096 }, context);
  assert.equal(result.ok, true);
  const output = result.output as { bytes: number; text: string; truncated: boolean };
  assert.equal(output.bytes, 4096);
  assert.equal(output.text.length, 4096);
  assert.equal(output.truncated, true);
});

test("search_web parses and unwraps bounded search results", async () => {
  const html = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example &amp; Docs</a>
      <a class="result__snippet">The <b>official</b> documentation.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://second.example/page">Second result</a>
      <div class="result__snippet">Another answer.</div>
    </div>`;
  const tool = new WebSearchTool({
    targetPolicy: allowAll,
    searchEndpoint: "https://search.example.test/html/",
    fetchImplementation: (async (input) => {
      assert.match(String(input), /\?q=vanguard\+kernel$/u);
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch,
  });
  const result = await tool.execute({ query: "vanguard kernel", maxResults: 1 }, context);
  assert.equal(result.ok, true);
  const output = result.output as { results: Array<{ title: string; url: string; snippet: string }> };
  assert.deepEqual(output.results, [{
    title: "Example & Docs",
    url: "https://example.com/docs",
    snippet: "The official documentation.",
  }]);
});

test("public network policy blocks local, private, credentialed, and alternate-port targets", async () => {
  const policy = new PublicNetworkTargetPolicy();
  for (const target of [
    "http://127.0.0.1/",
    "http://10.1.2.3/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "https://user:secret@example.com/",
    "https://example.com:8443/",
  ]) {
    await assert.rejects(policy.assertAllowed(new URL(target)), /not allowed|default HTTP|credentials/iu);
  }
});
