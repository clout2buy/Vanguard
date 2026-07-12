import type { JsonValue } from "../kernel/contracts.js";

export function objectInput(input: JsonValue): Record<string, JsonValue> {
  if (input === null || Array.isArray(input) || typeof input !== "object") {
    throw new Error("Tool input must be an object.");
  }
  return input;
}

export function stringField(input: Record<string, JsonValue>, name: string): string {
  const value = input[name];
  if (typeof value !== "string") throw new Error(`Field '${name}' must be a string.`);
  return value;
}

export function optionalStringField(input: Record<string, JsonValue>, name: string): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Field '${name}' must be a string.`);
  return value;
}

export function stringArrayField(input: Record<string, JsonValue>, name: string): string[] {
  const value = input[name];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Field '${name}' must be an array of strings.`);
  }
  return value;
}

