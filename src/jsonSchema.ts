import type { JsonValue } from "./kernel/contracts.js";

const SUPPORTED_JSON_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/**
 * Validate a JSON value against the deliberately small JSON-schema subset
 * accepted by Vanguard tool definitions. The validator is dependency-free so
 * the kernel, extension boundary, and MCP adapter all enforce identical rules.
 */
export function validateJsonSchema(value: JsonValue, schema: JsonValue): readonly string[] {
  const errors: string[] = [];
  validateNode(value, schema, "$", errors);
  return errors;
}

/** Validate that a schema uses only Vanguard's supported declaration subset. */
export function validateSchemaDefinition(schema: JsonValue, label: string): void {
  if (schema === null || Array.isArray(schema) || typeof schema !== "object") throw new Error(`${label} must be an object.`);
  const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "minLength", "maxLength", "minimum", "maximum"]);
  const unknown = Object.keys(schema).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unsupported schema keys: ${unknown.sort().join(", ")}.`);
  if (schema.type !== undefined) {
    const declaredTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (declaredTypes.length === 0
      || !declaredTypes.every((type) => typeof type === "string" && SUPPORTED_JSON_TYPES.has(type))) {
      throw new Error(`${label} has an unsupported type.`);
    }
  }
  if (schema.properties !== undefined) {
    if (schema.properties === null || Array.isArray(schema.properties) || typeof schema.properties !== "object") throw new Error(`${label}.properties must be an object.`);
    for (const [name, child] of Object.entries(schema.properties)) validateSchemaDefinition(child, `${label}.properties.${name}`);
  }
  if (schema.items !== undefined) validateSchemaDefinition(schema.items, `${label}.items`);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((item) => typeof item === "string"))) {
    throw new Error(`${label}.required must be an array of strings.`);
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    throw new Error(`${label}.additionalProperties must be boolean.`);
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new Error(`${label}.enum must be an array.`);
  for (const numeric of ["minLength", "maxLength", "minimum", "maximum"] as const) {
    if (schema[numeric] !== undefined && typeof schema[numeric] !== "number") throw new Error(`${label}.${numeric} must be numeric.`);
  }
}

function validateNode(value: JsonValue, schema: JsonValue, at: string, errors: string[]): void {
  if (schema === null || Array.isArray(schema) || typeof schema !== "object") {
    errors.push(`${at}: invalid schema.`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${at}: value is not in enum.`);
  }
  const type = schema.type;
  let declaredTypes: readonly string[] = [];
  if (type !== undefined) {
    declaredTypes = typeof type === "string"
      ? [type]
      : Array.isArray(type) && type.length > 0 && type.every((item): item is string => typeof item === "string")
        ? type
        : [];
    if (declaredTypes.length === 0 || declaredTypes.some((declared) => !SUPPORTED_JSON_TYPES.has(declared))) {
      errors.push(`${at}: invalid schema type declaration.`);
      return;
    }
  }
  if (declaredTypes.length > 0 && !declaredTypes.some((declared) => matchesType(value, declared))) {
    errors.push(`${at}: expected ${declaredTypes.join(" or ")}.`);
    return;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${at}: shorter than minLength.`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${at}: longer than maxLength.`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${at}: below minimum.`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${at}: above maximum.`);
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => validateNode(item, schema.items as JsonValue, `${at}[${index}]`, errors));
  }
  if (value !== null && !Array.isArray(value) && typeof value === "object") {
    const properties = schema.properties !== null && schema.properties !== undefined && !Array.isArray(schema.properties) && typeof schema.properties === "object"
      ? schema.properties as Record<string, JsonValue>
      : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const name of required) if (!(name in value)) errors.push(`${at}.${name}: required.`);
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) if (!(name in properties)) errors.push(`${at}.${name}: additional property is not allowed.`);
    }
    for (const [name, child] of Object.entries(value)) {
      const childSchema = properties[name];
      if (childSchema !== undefined) validateNode(child, childSchema, `${at}.${name}`, errors);
    }
  }
}

function matchesType(value: JsonValue, type: string): boolean {
  switch (type) {
    case "object": return value !== null && !Array.isArray(value) && typeof value === "object";
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return false;
  }
}
