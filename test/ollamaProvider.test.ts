import assert from "node:assert/strict";
import test from "node:test";
import {
  OptionalBearerHeaders,
  resolveProviderProfile,
  VANGUARD_PROVIDER_CONFIG_VERSION,
} from "../src/index.js";

test("ollama profile defaults to keyless local chat completions", () => {
  const profile = resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "ollama",
    model: "qwen3-coder",
  }, {});
  assert.equal(profile.endpoint, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(profile.wire, "openai-chat-completions");
  assert.equal(profile.credentialOptional, true);
  assert.equal(profile.capabilities.streaming, true);
  assert.equal(profile.capabilities.parallelToolCalls, false);
  assert.equal(profile.capabilities.continuationReplay, false);
  assert.equal(profile.credentialProvenance.present, false);
});

test("hosted providers still require their credential", () => {
  const profile = resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "deepseek",
    model: "deepseek-v4-pro",
  }, {});
  assert.equal(profile.credentialOptional, false);
});

test("optional bearer headers omit authorization when the variable is absent", async () => {
  const absent = new OptionalBearerHeaders("OLLAMA_API_KEY", {});
  assert.deepEqual(await absent.headers(), {});
  assert.equal(absent.provenance().present, false);

  const present = new OptionalBearerHeaders("OLLAMA_API_KEY", { OLLAMA_API_KEY: "cloud-key" });
  assert.deepEqual(await present.headers(), { authorization: "Bearer cloud-key" });
  assert.equal(present.provenance().present, true);
});

test("ollama accepts a custom https cloud endpoint", () => {
  const profile = resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "ollama",
    model: "qwen3-coder:480b-cloud",
    endpoint: "https://ollama.com/v1/chat/completions",
  }, { OLLAMA_API_KEY: "key" });
  assert.equal(profile.endpoint, "https://ollama.com/v1/chat/completions");
  assert.equal(profile.credentialProvenance.present, true);
});
