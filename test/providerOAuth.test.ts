import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SerializableModelRequest } from "../src/index.js";
import {
  AnthropicMessagesCodec,
  ANTHROPIC_OAUTH_BETA,
  ANTHROPIC_OAUTH_IDENTITY,
  CODEX_RESPONSES_URL,
  VANGUARD_PROVIDER_CONFIG_VERSION,
  createConfiguredProviderModel,
  fetchCodexModels,
  openAIPlanType,
  refreshAnthropicTokens,
  resolveProviderProfile,
  runAnthropicLoginFlow,
  startAnthropicLogin,
} from "../src/index.js";
import { parseLoginTarget } from "../src/tui.js";

test("/login accepts the product names, not just the API vendor names", () => {
  assert.equal(parseLoginTarget("claude"), "anthropic");
  assert.equal(parseLoginTarget("codex"), "openai");
  assert.equal(parseLoginTarget("chatgpt"), "openai");
  assert.equal(parseLoginTarget("  CLAUDE  "), "anthropic");
  assert.equal(parseLoginTarget("anthropic"), "anthropic");
  assert.equal(parseLoginTarget("openai"), "openai");
  assert.equal(parseLoginTarget("gemini"), undefined);
  assert.equal(parseLoginTarget(""), undefined);
});

const request: SerializableModelRequest = {
  task: "repair",
  mode: "execution",
  workingState: null,
  remainingSteps: 10,
  tools: [],
  transcript: [{ role: "task", content: "repair" }],
};

/** Point VANGUARD_HOME at a throwaway directory for the duration of one test. */
async function withTemporaryHome<T>(body: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "vanguard-oauth-"));
  const previous = process.env.VANGUARD_HOME;
  process.env.VANGUARD_HOME = home;
  try {
    return await body(home);
  } finally {
    if (previous === undefined) delete process.env.VANGUARD_HOME;
    else process.env.VANGUARD_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test("an oauth credential resolves without an environment variable", () => {
  const profile = resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "anthropic",
    model: "claude-opus-4-8",
    credential: { source: "oauth", provider: "anthropic" },
  }, {});
  assert.equal(profile.endpoint, "https://api.anthropic.com/v1/messages");
  assert.equal(profile.wire, "anthropic-messages");
  assert.deepEqual(profile.credentialProvenance, {
    source: "oauth",
    provider: "anthropic",
    resolvedAtRequestTime: true,
  });
});

test("a ChatGPT subscription profile targets the Codex backend, not the platform API", () => {
  const profile = resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "openai",
    model: "gpt-5.6-codex",
    credential: { source: "oauth", provider: "openai" },
  }, {});
  assert.equal(profile.endpoint, CODEX_RESPONSES_URL);
  // An API key keeps the platform endpoint; only the OAuth path is rerouted.
  assert.equal(resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "openai",
    model: "gpt-5.6",
  }, {}).endpoint, "https://api.openai.com/v1/responses");
});

test("an oauth credential cannot be borrowed by another provider", () => {
  assert.throws(() => resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "openai",
    model: "gpt-5.6",
    credential: { source: "oauth", provider: "anthropic" },
  }, {}), /cannot authenticate the openai provider/u);
  assert.throws(() => resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "deepseek",
    model: "deepseek-v4-pro",
    credential: { source: "oauth", provider: "deepseek" } as never,
  }, {}), /only for the anthropic and openai providers/u);
});

test("a short-lived token still cannot masquerade as an environment API key", () => {
  assert.throws(() => resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "anthropic",
    model: "claude-opus-4-8",
    credential: { source: "environment", variable: "ANTHROPIC_OAUTH_TOKEN" },
  }, {}), /use credential source "oauth"/u);
});

test("the Anthropic OAuth contract identity leads the system prompt, and only for oauth", () => {
  const oauth = JSON.parse(JSON.stringify(
    new AnthropicMessagesCodec("claude-opus-4-8", 16_384, undefined, undefined, true).encode(request),
  )) as { system: Array<{ text: string; cache_control?: unknown }> };
  assert.equal(oauth.system[0]?.text, ANTHROPIC_OAUTH_IDENTITY);
  assert.equal(oauth.system.length, 2);
  // Vanguard's own prompt still follows, and still carries the cache breakpoint.
  assert.match(String(oauth.system[1]?.text), /You are Vanguard/u);
  assert.ok(oauth.system[1]?.cache_control !== undefined);

  const apiKey = JSON.parse(JSON.stringify(
    new AnthropicMessagesCodec("claude-opus-4-8").encode(request),
  )) as { system: Array<{ text: string }> };
  assert.equal(apiKey.system.length, 1);
  assert.match(String(apiKey.system[0]?.text), /You are Vanguard/u);
});

test("Claude subscription requests carry the bearer token and Claude Code beta headers", async () => {
  await withTemporaryHome(async () => {
    const previous = process.env.VANGUARD_ANTHROPIC_OAUTH_TOKEN;
    process.env.VANGUARD_ANTHROPIC_OAUTH_TOKEN = "test-access-token";
    try {
      let seen: Record<string, string> = {};
      const model = createConfiguredProviderModel({
        version: VANGUARD_PROVIDER_CONFIG_VERSION,
        provider: "anthropic",
        model: "claude-opus-4-8",
        credential: { source: "oauth", provider: "anthropic" },
      }, {
        disableStreaming: true,
        fetchImplementation: (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
          seen = init?.headers ?? {};
          return new Response(JSON.stringify({
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
          }), { status: 200, headers: { "content-type": "application/json" } });
        }) as unknown as typeof fetch,
      });
      await model.decide({ ...request, signal: new AbortController().signal });
      assert.equal(seen.authorization, "Bearer test-access-token");
      assert.equal(seen["anthropic-beta"], ANTHROPIC_OAUTH_BETA);
      assert.equal(seen["anthropic-version"], "2023-06-01");
      // The subscription path must never also send an API key.
      assert.equal(seen["x-api-key"], undefined);
    } finally {
      if (previous === undefined) delete process.env.VANGUARD_ANTHROPIC_OAUTH_TOKEN;
      else process.env.VANGUARD_ANTHROPIC_OAUTH_TOKEN = previous;
    }
  });
});

test("ChatGPT subscription requests reach the Codex backend with the account header", async () => {
  await withTemporaryHome(async (home) => {
    const previous = process.env.VANGUARD_OPENAI_OAUTH_TOKEN;
    delete process.env.VANGUARD_OPENAI_OAUTH_TOKEN;
    mkdirSync(home, { recursive: true });
    await writeFile(path.join(home, "openai-oauth.json"), JSON.stringify({
      accessToken: "chatgpt-access",
      refreshToken: "chatgpt-refresh",
      idToken: "",
      expiresAt: Date.now() + 3_600_000,
      accountId: "acct_123",
      profile: { email: "you@example.com" },
    }), "utf8");
    try {
      let seenUrl = "";
      let seen: Record<string, string> = {};
      const model = createConfiguredProviderModel({
        version: VANGUARD_PROVIDER_CONFIG_VERSION,
        provider: "openai",
        model: "gpt-5.6-codex",
        credential: { source: "oauth", provider: "openai" },
      }, {
        disableStreaming: true,
        fetchImplementation: (async (url: unknown, init?: { headers?: Record<string, string> }) => {
          seenUrl = String(url);
          seen = init?.headers ?? {};
          return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as unknown as typeof fetch,
      });
      await model.decide({ ...request, signal: new AbortController().signal });
      assert.equal(seenUrl, CODEX_RESPONSES_URL);
      assert.equal(seen.authorization, "Bearer chatgpt-access");
      assert.equal(seen["chatgpt-account-id"], "acct_123");
    } finally {
      if (previous !== undefined) process.env.VANGUARD_OPENAI_OAUTH_TOKEN = previous;
    }
  });
});

test("a missing sign-in fails with an actionable message rather than a provider 401", async () => {
  await withTemporaryHome(async () => {
    const previous = process.env.VANGUARD_ANTHROPIC_OAUTH_TOKEN;
    delete process.env.VANGUARD_ANTHROPIC_OAUTH_TOKEN;
    try {
      const model = createConfiguredProviderModel({
        version: VANGUARD_PROVIDER_CONFIG_VERSION,
        provider: "anthropic",
        model: "claude-opus-4-8",
        credential: { source: "oauth", provider: "anthropic" },
      }, {
        disableStreaming: true,
        maxAttempts: 1,
        fetchImplementation: (async () => {
          throw new Error("the request must never reach the network");
        }) as unknown as typeof fetch,
      });
      await assert.rejects(
        model.decide({ ...request, signal: new AbortController().signal }),
        /vanguard login anthropic/u,
      );
    } finally {
      if (previous !== undefined) process.env.VANGUARD_ANTHROPIC_OAUTH_TOKEN = previous;
    }
  });
});

test("the loopback sign-in turns a browser callback into stored tokens", async () => {
  await withTemporaryHome(async (home) => {
    let exchange: Record<string, string> = {};
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      exchange = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
      return new Response(JSON.stringify({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        scope: "user:inference user:profile",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const tokens = await runAnthropicLoginFlow((url: string) => {
      // Stand in for the browser: approve, then hit the loopback callback.
      const authorize = new URL(url);
      const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", "auth-code-123");
      redirect.searchParams.set("state", authorize.searchParams.get("state") ?? "");
      void fetch(redirect.toString()).catch(() => {});
    }, fetchImpl, 15_000);

    assert.equal(tokens.accessToken, "access-1");
    assert.equal(tokens.refreshToken, "refresh-1");
    assert.deepEqual(tokens.scopes, ["user:inference", "user:profile"]);
    assert.equal(exchange.code, "auth-code-123");
    assert.equal(exchange.grant_type, "authorization_code");
    // The provider's public client only accepts the verifier reused as state.
    assert.equal(exchange.code_verifier, exchange.state);
    const stored = JSON.parse(await readFile(path.join(home, "anthropic-oauth.json"), "utf8")) as { accessToken: string };
    assert.equal(stored.accessToken, "access-1");
  });
});

test("a callback carrying the wrong state never reaches the token endpoint", async () => {
  await withTemporaryHome(async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await assert.rejects(runAnthropicLoginFlow((url: string) => {
      const redirect = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", "stolen-code");
      redirect.searchParams.set("state", "not-the-state");
      void fetch(redirect.toString()).catch(() => {});
    }, fetchImpl, 15_000), /missing code or invalid state/u);
    assert.equal(called, false, "a forged callback must not trigger a token exchange");
  });
});

test("an entitlement-free plan is reported as [] and never confused with a failed probe", async () => {
  await withTemporaryHome(async (home) => {
    const previous = process.env.VANGUARD_OPENAI_OAUTH_TOKEN;
    delete process.env.VANGUARD_OPENAI_OAUTH_TOKEN;
    await writeFile(path.join(home, "openai-oauth.json"), JSON.stringify({
      accessToken: "a", refreshToken: "r", idToken: "",
      expiresAt: Date.now() + 3_600_000, profile: {},
    }), "utf8");
    try {
      // A live endpoint answering "you have no models" is a real answer: [].
      const none = await fetchCodexModels((async () => new Response(JSON.stringify({ models: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch);
      assert.deepEqual(none, [], "an empty entitlement list must survive as []");

      // Anything that prevents asking is null, so the caller may fall back.
      for (const failure of [
        async () => new Response("nope", { status: 500 }),
        async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
        async () => { throw new Error("offline"); },
      ]) {
        assert.equal(await fetchCodexModels(failure as unknown as typeof fetch), null);
      }

      const live = await fetchCodexModels((async () => new Response(JSON.stringify({
        models: [{ slug: "gpt-5.1-codex", title: "Codex" }],
      }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch);
      assert.deepEqual(live, [{ id: "gpt-5.1-codex", label: "Codex" }]);
    } finally {
      if (previous !== undefined) process.env.VANGUARD_OPENAI_OAUTH_TOKEN = previous;
    }
  });
});

test("the ChatGPT plan is read from the namespaced claim, including for older logins", () => {
  // chatgpt_plan_type lives under the auth namespace, not at the top level.
  const claims = Buffer.from(JSON.stringify({
    email: "you@example.com",
    "https://api.openai.com/auth": { chatgpt_plan_type: "prolite", chatgpt_account_id: "acct_9" },
  }), "utf8").toString("base64url");
  const idToken = `header.${claims}.signature`;
  // A login stored before the claim path was fixed carries no profile.planType.
  assert.equal(openAIPlanType({
    accessToken: "a", refreshToken: "r", idToken, expiresAt: 0, profile: {},
  }), "prolite");
  // A stored plan still wins.
  assert.equal(openAIPlanType({
    accessToken: "a", refreshToken: "r", idToken, expiresAt: 0, profile: { planType: "pro" },
  }), "pro");
});

test("the Anthropic authorize URL reuses the PKCE verifier as state", () => {
  const challenge = startAnthropicLogin();
  const url = new URL(challenge.authorizeUrl);
  assert.equal(url.origin + url.pathname, "https://claude.ai/oauth/authorize");
  assert.equal(url.searchParams.get("state"), challenge.pkceVerifier);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), `http://localhost:${challenge.port}/callback`);
  // The challenge is the hash, never the verifier itself.
  assert.notEqual(url.searchParams.get("code_challenge"), challenge.pkceVerifier);
  assert.notEqual(startAnthropicLogin().pkceVerifier, challenge.pkceVerifier);
});

test("a refresh keeps the existing refresh token when the provider omits one", async () => {
  await withTemporaryHome(async (home) => {
    mkdirSync(home, { recursive: true });
    const file = path.join(home, "anthropic-oauth.json");
    await writeFile(file, JSON.stringify({
      accessToken: "old",
      refreshToken: "keep-me",
      expiresAt: 0,
    }), "utf8");
    const refreshed = await refreshAnthropicTokens({
      accessToken: "old",
      refreshToken: "keep-me",
      expiresAt: 0,
    }, (async () => new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch);
    assert.equal(refreshed.accessToken, "fresh");
    assert.equal(refreshed.refreshToken, "keep-me");
    assert.ok(refreshed.expiresAt > Date.now());
    // The rotation must be persisted, or the next process would replay a dead token.
    const stored = JSON.parse(await readFile(file, "utf8")) as { accessToken: string };
    assert.equal(stored.accessToken, "fresh");
  });
});

test("a rejected refresh reports the provider status without dumping the page body", async () => {
  await withTemporaryHome(async () => {
    await assert.rejects(
      refreshAnthropicTokens(
        { accessToken: "old", refreshToken: "revoked", expiresAt: 0 },
        (async () => new Response(`<html>${"x".repeat(400)}</html>`, { status: 401 })) as unknown as typeof fetch,
      ),
      (error: Error) => {
        assert.match(error.message, /Claude token refresh failed \(401\)/u);
        assert.ok(error.message.length < 200, "the error must not carry a full HTML body");
        return true;
      },
    );
  });
});

test("the Claude subscription model list is advisory and keeps [] distinct from null", async () => {
  await withTemporaryHome(async (home) => {
    await writeFile(path.join(home, "anthropic-oauth.json"), JSON.stringify({
      accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000,
    }), "utf8");
    const { fetchClaudeModels } = await import("../src/index.js");

    const live = await fetchClaudeModels((async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer a");
      assert.match(headers["anthropic-beta"] ?? "", /oauth-2025-04-20/u);
      return new Response(JSON.stringify({
        data: [
          { id: "claude-fable-5", display_name: "Claude Fable 5" },
          { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch);
    assert.deepEqual(live, [
      { id: "claude-fable-5", label: "Claude Fable 5" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    ]);

    // A live "none" answer survives as []; a failure to ask is null.
    const none = await fetchClaudeModels((async () => new Response(JSON.stringify({ data: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch);
    assert.deepEqual(none, []);
    for (const failure of [
      async () => new Response("nope", { status: 500 }),
      async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      async () => { throw new Error("offline"); },
    ]) {
      assert.equal(await fetchClaudeModels(failure as unknown as typeof fetch), null);
    }
  });
});

test("a ChatGPT account is offered Codex slugs, never the API-only aliases", async () => {
  const { catalogModels } = await import("../src/inference/modelCatalog.js");
  const oauthIds = catalogModels("openai", "oauth").map((model) => model.id);
  assert.ok(oauthIds.includes("gpt-5.6-sol"), "the Codex flagship slug must be offered");
  assert.ok(!oauthIds.includes("gpt-5.6"), "bare API aliases 400 on the Codex backend");
  const apiIds = catalogModels("openai", "api-key").map((model) => model.id);
  assert.ok(apiIds.includes("gpt-5.6"));
  // Providers without a separate subscription list keep one menu.
  assert.deepEqual(catalogModels("anthropic", "oauth"), catalogModels("anthropic", "api-key"));
});
