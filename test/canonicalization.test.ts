import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue } from "../src/kernel/contracts.js";
import { durableStateSha256 } from "../src/kernel/durableState.js";
import { canonicalCertificationJson } from "../src/evaluation/certification.js";
import { sanitizedChildEnvironment } from "../src/engine/security.js";
import {
  asciiLowercase,
  asciiUppercase,
  compareOrdinal,
  lowercaseInvariant,
} from "../src/deterministicText.js";

test("signed and durable JSON uses exact ordinal ordering for adversarial Unicode keys", () => {
  const keys = ["z", "ä", "Z", "é", "e\u0301", "I", "İ", "ı", "i"];
  const value = Object.fromEntries(keys.map((key) => [key, key])) as JsonValue;
  const reversed = Object.fromEntries([...keys].reverse().map((key) => [key, key])) as JsonValue;
  const expected = "{\"I\":\"I\",\"Z\":\"Z\",\"é\":\"é\",\"i\":\"i\",\"z\":\"z\",\"ä\":\"ä\",\"é\":\"é\",\"İ\":\"İ\",\"ı\":\"ı\"}";
  const expectedHash = createHash("sha256").update(expected).digest("hex");

  assert.equal(canonicalCertificationJson(value), expected);
  assert.equal(canonicalCertificationJson(reversed), expected);
  assert.equal(durableStateSha256(value), expectedHash);
  assert.equal(durableStateSha256(reversed), expectedHash);
  assert.deepEqual([...keys].sort(compareOrdinal), ["I", "Z", "é", "i", "z", "ä", "é", "İ", "ı"]);
});

test("existing lowercase-ASCII canonical fixture remains byte-identical", () => {
  const fixture = { version: 1, nested: { zeta: 2, alpha: 1 }, kind: "result" } as const;
  const expected = "{\"kind\":\"result\",\"nested\":{\"alpha\":1,\"zeta\":2},\"version\":1}";

  assert.equal(canonicalCertificationJson(fixture), expected);
  assert.equal(durableStateSha256(fixture), "a67f9f8a84d89ca314ac8e9dba4dc177621f8cf3c32aba2c6b85606b775e64be");
});

test("integrity and secret filtering never consult host locale APIs", () => {
  const localeCompare = Object.getOwnPropertyDescriptor(String.prototype, "localeCompare")!;
  const localeLower = Object.getOwnPropertyDescriptor(String.prototype, "toLocaleLowerCase")!;
  const localeUpper = Object.getOwnPropertyDescriptor(String.prototype, "toLocaleUpperCase")!;
  const forbidden = (): never => { throw new Error("host locale API was consulted"); };
  Object.defineProperties(String.prototype, {
    localeCompare: { ...localeCompare, value: forbidden },
    toLocaleLowerCase: { ...localeLower, value: forbidden },
    toLocaleUpperCase: { ...localeUpper, value: forbidden },
  });
  try {
    assert.equal(canonicalCertificationJson({ beta: 2, alpha: 1 }), "{\"alpha\":1,\"beta\":2}");
    assert.match(durableStateSha256({ beta: 2, alpha: 1 }), /^[a-f0-9]{64}$/u);
    assert.deepEqual(sanitizedChildEnvironment({
      node_options: "--require=malicious.js",
      NoDe_PaTh: "malicious",
      PROJECT_MODE: "test",
    }), {
      PROJECT_MODE: "test",
      VANGUARD_CHILD_PROCESS: "1",
    });
  } finally {
    Object.defineProperties(String.prototype, {
      localeCompare,
      toLocaleLowerCase: localeLower,
      toLocaleUpperCase: localeUpper,
    });
  }
});

test("ASCII protocol folding does not conflate Turkish-I or compatibility characters", () => {
  assert.equal(asciiLowercase("DEEPSEEK_API_KEY-I-İ-ı-i"), "deepseek_api_key-i-İ-ı-i");
  assert.equal(asciiUppercase("node_options-i-İ-ı-I"), "NODE_OPTIONS-I-İ-ı-I");
  assert.equal(lowercaseInvariant("C:/I/İ/ı/i"), "c:/i/i̇/ı/i");
  assert.notEqual(asciiLowercase("İ"), asciiLowercase("I"));
});
