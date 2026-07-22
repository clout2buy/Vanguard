import assert from "node:assert/strict";
import test from "node:test";
import { discoverOllamaModels, prepareOllamaModel, type OllamaModelChoice } from "../src/inference/ollamaModels.js";
import { filterSelectItems } from "../src/tuiSelect.js";

test("Ollama discovery merges local, direct Cloud, and the public Cloud catalog", async () => {
  const seen: Array<{ url: string; authorization?: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, ...(headers.get("authorization") === null ? {} : { authorization: headers.get("authorization")! }) });
    if (url === "http://127.0.0.1:11434/api/tags") {
      return Response.json({ models: [
        { model: "glm-5.2:cloud", size: 338, details: { parameter_size: "756B" } },
        { model: "qwen3-coder:30b", size: 18_000_000_000, details: { parameter_size: "30.5B", quantization_level: "Q4_K_M" } },
      ] });
    }
    if (url === "https://ollama.com/api/tags") {
      return Response.json({ models: [
        { model: "glm-5.2:cloud", size: 338 },
        { model: "direct-only", size: 0, details: { parameter_size: "1T" } },
      ] });
    }
    if (url === "https://ollama.com/search?c=cloud") {
      return new Response('<a href="/library/kimi-k2.7-code">Kimi</a><a href="/library/glm-5.2">GLM</a>');
    }
    if (url.endsWith("/library/kimi-k2.7-code/tags")) {
      return new Response('<a href="/library/kimi-k2.7-code:cloud">cloud</a>');
    }
    if (url.endsWith("/library/glm-5.2/tags")) {
      return new Response('<a href="/library/glm-5.2:cloud">cloud</a>');
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const result = await discoverOllamaModels({
    fetchImpl,
    environment: { OLLAMA_API_KEY: "secret" },
  });

  assert.equal(result.localAvailable, true);
  assert.equal(result.cloudApiAvailable, true);
  assert.equal(result.publicCatalogAvailable, true);
  assert.deepEqual(result.models.map((model) => model.id), [
    "glm-5.2:cloud",
    "qwen3-coder:30b",
    "direct-only",
    "kimi-k2.7-code:cloud",
  ]);
  assert.match(result.models[0]!.note, /cloud · ready · 756B/);
  assert.match(result.models[1]!.note, /local · ready · 30\.5B · Q4_K_M/);
  assert.equal(result.models[2]!.endpoint, "https://ollama.com/v1/chat/completions");
  assert.equal(result.models[3]!.ready, false);
  assert.equal(result.models[3]!.endpoint, "http://127.0.0.1:11434/v1/chat/completions");
  assert.ok(seen.some((request) => request.url === "https://ollama.com/api/tags" && request.authorization === "Bearer secret"));
});

test("Ollama discovery fails soft when every inventory is offline", async () => {
  const fetchImpl = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const result = await discoverOllamaModels({ fetchImpl, environment: {}, timeoutMs: 20 });
  assert.deepEqual(result.models, []);
  assert.equal(result.localAvailable, false);
  assert.equal(result.cloudApiAvailable, false);
  assert.equal(result.publicCatalogAvailable, false);
});

test("a public Cloud selection is pulled through the local daemon before use", async () => {
  let body = "";
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = String(init?.body);
    return Response.json({ status: "success" });
  }) as typeof fetch;
  const model: OllamaModelChoice = {
    id: "kimi-k2.7-code:cloud",
    note: "cloud catalog · pulls on selection",
    source: "cloud-catalog",
    endpoint: "http://127.0.0.1:11434/v1/chat/completions",
    ready: false,
  };
  await prepareOllamaModel(model, { fetchImpl, localBaseUrl: "http://127.0.0.1:11434", timeoutMs: 100 });
  assert.deepEqual(JSON.parse(body), { model: model.id, stream: false });
});

test("large selectors filter across model ids and source notes", () => {
  const items = [
    { value: 1, label: "glm-5.2:cloud", note: "cloud · ready · 756B" },
    { value: 2, label: "qwen3-coder:30b", note: "local · ready" },
    { value: 3, label: "kimi-k2.7-code:cloud", note: "cloud catalog · pulls on selection" },
  ];
  assert.deepEqual(filterSelectItems(items, "cloud kimi").map((item) => item.value), [3]);
  assert.deepEqual(filterSelectItems(items, "LOCAL").map((item) => item.value), [2]);
  assert.equal(filterSelectItems(items, "").length, 3);
});
