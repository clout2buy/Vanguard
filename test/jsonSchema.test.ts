import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "../src/index.js";
import { validateJsonSchema, validateSchemaDefinition } from "../src/jsonSchema.js";

test("schema keywords are own properties and inherited composition cannot execute", () => {
  const inherited = Object.create({ oneOf: [{ type: "number" }] }) as Record<string, JsonValue>;
  inherited.type = "string";

  assert.doesNotThrow(() => validateSchemaDefinition(inherited, "inherited schema"));
  assert.deepEqual(validateJsonSchema("safe", inherited), []);
  assert.match(validateJsonSchema(42, inherited).join(" "), /expected string/u);
});

test("schema definitions reject non-finite, fractional, negative, and inverted bounds", () => {
  for (const [schema, message] of [
    [{ type: "number", minimum: Number.NaN }, /minimum must be a finite number/u],
    [{ type: "number", maximum: Number.POSITIVE_INFINITY }, /maximum must be a finite number/u],
    [{ type: "string", minLength: -1 }, /minLength must be a nonnegative safe integer/u],
    [{ type: "string", maxLength: 1.5 }, /maxLength must be a nonnegative safe integer/u],
    [{ type: "string", minLength: 3, maxLength: 2 }, /minLength cannot exceed maxLength/u],
    [{ type: "number", minimum: 2, maximum: 1 }, /minimum cannot exceed maximum/u],
  ] as const) {
    assert.throws(() => validateSchemaDefinition(schema as JsonValue, "bounded schema"), message);
  }
});

test("oneOf is exact: zero or multiple matching branches fail", () => {
  const schema: JsonValue = {
    oneOf: [
      { type: "string", minLength: 1 },
      { type: "string", maxLength: 3 },
    ],
  };
  validateSchemaDefinition(schema, "oneOf schema");
  assert.deepEqual(validateJsonSchema("abcdef", schema), []);
  assert.match(validateJsonSchema("ab", schema).join(" "), /exactly one oneOf/u);
  assert.match(validateJsonSchema(42, schema).join(" "), /exactly one oneOf/u);
});
