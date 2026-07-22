// Live Ollama model discovery for the terminal launcher.
//
// Ollama has three useful views of its catalog:
//   1. the local daemon's /api/tags (installed local models + pulled Cloud stubs),
//   2. ollama.com's authenticated /api/tags (direct Cloud API inventory), and
//   3. the public Cloud library (models that can be pulled through a signed-in
//      local daemon but are not installed yet).
//
// Vanguard merges all three. A stale baked-in menu must never hide a model that
// Ollama already knows how to run.

export type OllamaModelSource = "local" | "cloud" | "cloud-catalog";

export interface OllamaModelChoice {
  readonly id: string;
  readonly note: string;
  readonly source: OllamaModelSource;
  /** OpenAI-compatible chat endpoint to bind onto the Vanguard session. */
  readonly endpoint: string;
  /** False means the local daemon must pull the tiny Cloud model stub first. */
  readonly ready: boolean;
}

export interface OllamaDiscovery {
  readonly models: readonly OllamaModelChoice[];
  readonly localAvailable: boolean;
  readonly cloudApiAvailable: boolean;
  readonly publicCatalogAvailable: boolean;
  readonly localBaseUrl: string;
}

interface TagsModel {
  readonly id: string;
  readonly size?: number;
  readonly parameterSize?: string;
  readonly quantization?: string;
}

interface DiscoverOptions {
  readonly fetchImpl?: typeof fetch;
  readonly environment?: NodeJS.ProcessEnv;
  /** Tests and offline embedders can skip the public library crawl. */
  readonly includePublicCatalog?: boolean;
  readonly timeoutMs?: number;
}

const DEFAULT_LOCAL_BASE = "http://127.0.0.1:11434";
const CLOUD_BASE = "https://ollama.com";
const MAX_MODELS = 500;
const MAX_MODEL_ID = 512;

export async function discoverOllamaModels(options: DiscoverOptions = {}): Promise<OllamaDiscovery> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const environment = options.environment ?? process.env;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const localBaseUrl = normalizeBaseUrl(environment.OLLAMA_HOST);
  const cloudKey = environment.OLLAMA_API_KEY?.trim();

  const [local, cloud] = await Promise.all([
    fetchTags(fetchImpl, `${localBaseUrl}/api/tags`, undefined, timeoutMs),
    cloudKey === undefined || cloudKey.length === 0
      ? Promise.resolve(null)
      : fetchTags(fetchImpl, `${CLOUD_BASE}/api/tags`, cloudKey, timeoutMs),
  ]);

  const localAvailable = local !== null;
  const cloudApiAvailable = cloud !== null;
  const merged = new Map<string, OllamaModelChoice>();

  for (const model of local ?? []) {
    const cloudModel = isCloudModel(model);
    merged.set(model.id, {
      id: model.id,
      note: modelNote(cloudModel ? "cloud" : "local", model, true),
      source: cloudModel ? "cloud" : "local",
      endpoint: `${localBaseUrl}/v1/chat/completions`,
      ready: true,
    });
  }

  for (const model of cloud ?? []) {
    const existing = merged.get(model.id);
    if (existing !== undefined) continue;
    merged.set(model.id, {
      id: model.id,
      note: modelNote("cloud API", model, true),
      source: "cloud",
      endpoint: `${CLOUD_BASE}/v1/chat/completions`,
      ready: true,
    });
  }

  let publicCatalogAvailable = false;
  // Public Cloud tags use local-daemon IDs (for example glm-5.2:cloud). Keep
  // them visible even while the daemon is stopped; selection then produces the
  // actionable pull/connection error instead of making the whole catalog vanish.
  if (options.includePublicCatalog !== false) {
    const publicModels = await fetchPublicCloudCatalog(fetchImpl, timeoutMs);
    publicCatalogAvailable = publicModels !== null;
    for (const id of publicModels ?? []) {
      if (merged.has(id)) continue;
      merged.set(id, {
        id,
        note: "cloud catalog · pulls on selection",
        source: "cloud-catalog",
        endpoint: `${localBaseUrl}/v1/chat/completions`,
        ready: false,
      });
    }
  }

  return {
    models: [...merged.values()],
    localAvailable,
    cloudApiAvailable,
    publicCatalogAvailable,
    localBaseUrl,
  };
}

/** Pull a not-yet-installed Cloud stub through the signed-in local daemon. */
export async function prepareOllamaModel(
  model: OllamaModelChoice,
  options: Pick<DiscoverOptions, "fetchImpl" | "timeoutMs"> & { readonly localBaseUrl: string },
): Promise<void> {
  if (model.ready || model.source !== "cloud-catalog") return;
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchWithTimeout(fetchImpl, `${options.localBaseUrl}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: model.id, stream: false }),
  }, Math.max(options.timeoutMs ?? 120_000, 10_000));
  if (!response.ok) throw new Error(await responseError(response, `Ollama could not pull ${model.id}`));
  const body: unknown = await response.json();
  if (!isRecord(body) || body.status !== "success") {
    throw new Error(`Ollama returned an invalid pull receipt for ${model.id}.`);
  }
}

function normalizeBaseUrl(configured: string | undefined): string {
  const raw = configured?.trim() || DEFAULT_LOCAL_BASE;
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return DEFAULT_LOCAL_BASE;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username.length > 0 || url.password.length > 0) {
    return DEFAULT_LOCAL_BASE;
  }
  return `${url.origin}${url.pathname.replace(/\/$/u, "")}`;
}

async function fetchTags(
  fetchImpl: typeof fetch,
  url: string,
  bearer: string | undefined,
  timeoutMs: number,
): Promise<TagsModel[] | null> {
  try {
    const response = await fetchWithTimeout(fetchImpl, url, {
      headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
    }, timeoutMs);
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.models) || body.models.length > MAX_MODELS) return null;
    const models: TagsModel[] = [];
    for (const raw of body.models) {
      if (!isRecord(raw)) continue;
      const candidate = typeof raw.model === "string" ? raw.model : typeof raw.name === "string" ? raw.name : undefined;
      const id = candidate?.trim();
      if (id === undefined || id.length === 0 || id.length > MAX_MODEL_ID) continue;
      const details = isRecord(raw.details) ? raw.details : undefined;
      models.push({
        id,
        ...(typeof raw.size === "number" && Number.isFinite(raw.size) && raw.size >= 0 ? { size: raw.size } : {}),
        ...(typeof details?.parameter_size === "string" ? { parameterSize: details.parameter_size } : {}),
        ...(typeof details?.quantization_level === "string" ? { quantization: details.quantization_level } : {}),
      });
    }
    return models;
  } catch {
    return null;
  }
}

async function fetchPublicCloudCatalog(fetchImpl: typeof fetch, timeoutMs: number): Promise<string[] | null> {
  try {
    const search = await fetchWithTimeout(fetchImpl, `${CLOUD_BASE}/search?c=cloud`, {}, timeoutMs);
    if (!search.ok) return null;
    const html = await search.text();
    const families = uniqueMatches(html, /href="\/library\/([^"?#/:]+)"/gu).slice(0, 80);
    const tags = await mapConcurrent(families, 6, async (family) => {
      try {
        const response = await fetchWithTimeout(fetchImpl, `${CLOUD_BASE}/library/${encodeURIComponent(family)}/tags`, {}, timeoutMs);
        if (!response.ok) return [];
        const page = await response.text();
        return uniqueMatches(page, /href="\/library\/([^"?#]+(?:cloud))"/gu)
          .filter((id) => id === `${family}:cloud` || id.startsWith(`${family}:`) || id.startsWith(`${family}-`));
      } catch {
        return [];
      }
    });
    return [...new Set(tags.flat())].slice(0, MAX_MODELS);
  } catch {
    return null;
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await operation(values[index]!);
    }
  });
  await Promise.all(workers);
  return output;
}

function uniqueMatches(input: string, pattern: RegExp): string[] {
  return [...new Set([...input.matchAll(pattern)].map((match) => match[1]!).filter(Boolean))];
}

function isCloudModel(model: TagsModel): boolean {
  return /(?:[:\-]cloud)$/iu.test(model.id) || (model.size !== undefined && model.size > 0 && model.size < 1_000_000);
}

function modelNote(kind: string, model: TagsModel, ready: boolean): string {
  const details = [kind, ready ? "ready" : undefined, model.parameterSize, model.quantization]
    .filter((value): value is string => value !== undefined && value.length > 0);
  return details.join(" · ");
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.error === "string" && body.error.trim().length > 0) {
      return `${fallback}: ${body.error.trim()}`;
    }
  } catch {
    // The status line below is still useful.
  }
  return `${fallback} (HTTP ${response.status}).`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
