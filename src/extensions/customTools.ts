import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import type { CustomToolDeclaration, ExtensionEffect, ExtensionPermissions } from "./config.js";
import { compareOrdinal, lowercaseInvariant } from "../deterministicText.js";

export interface CustomToolImplementation {
  readonly definition: ToolDefinition & { readonly effect: ExtensionEffect };
  /** Independently supplied by the implementation factory, not its config. */
  readonly implementationEffect: ExtensionEffect;
  readonly provenance: string;
  execute(input: JsonValue, context: ToolContext): Promise<ToolResult>;
}

export interface RegisteredToolProvenance {
  readonly name: string;
  readonly effect: ExtensionEffect;
  readonly provenance: string;
}

/** Exact-match permission policy. Wildcards are deliberately unsupported. */
export class ExtensionPermissionPolicy {
  readonly #effects: ReadonlySet<ExtensionEffect>;
  readonly #tools: ReadonlySet<string>;
  readonly #servers: ReadonlySet<string>;
  readonly #hooks: ReadonlySet<string>;
  readonly #commands: ReadonlySet<string>;

  constructor(permissions: ExtensionPermissions) {
    this.#effects = new Set(permissions.effects);
    this.#tools = new Set(permissions.customTools);
    this.#servers = new Set(permissions.mcpServers);
    this.#hooks = new Set(permissions.hooks);
    this.#commands = new Set(permissions.commands.map(normalizeCommand));
  }

  authorizeTool(name: string, effect: ExtensionEffect): void {
    if (!this.#tools.has(name)) throw new Error(`Custom tool '${name}' is not permitted.`);
    if (!this.#effects.has(effect)) throw new Error(`Custom tool '${name}' effect '${effect}' is not permitted.`);
  }

  authorizeServer(name: string): void {
    if (!this.#servers.has(name)) throw new Error(`MCP server '${name}' is not permitted.`);
  }

  authorizeHook(name: string): void {
    if (!this.#hooks.has(name)) throw new Error(`Hook '${name}' is not permitted.`);
  }

  authorizeCommand(command: string): void {
    if (!this.#commands.has(normalizeCommand(command))) throw new Error(`Extension command '${command}' is not permitted.`);
  }
}

export class CustomToolRegistry {
  readonly #tools = new Map<string, ToolPort>();
  readonly #provenance = new Map<string, RegisteredToolProvenance>();

  constructor(
    private readonly policy: ExtensionPermissionPolicy,
    private readonly declarations: readonly CustomToolDeclaration[],
  ) {}

  register(implementation: CustomToolImplementation): ToolPort {
    const name = implementation.definition.name;
    assertNamespaced(name);
    if (implementation.definition.effect !== implementation.implementationEffect) {
      throw new Error(`Custom tool '${name}' effect declaration does not match its implementation metadata.`);
    }
    if (this.#tools.has(name)) throw new Error(`Custom tool '${name}' is already registered.`);
    const declaration = this.declarations.find((item) => item.name === name);
    if (declaration === undefined) throw new Error(`Custom tool '${name}' has no config declaration.`);
    if (declaration.effect !== implementation.definition.effect) {
      throw new Error(`Custom tool '${name}' effect does not match config provenance.`);
    }
    this.policy.authorizeTool(name, declaration.effect);
    validateSchemaDefinition(implementation.definition.inputSchema, `${name} input schema`);
    const tool = new GuardedCustomTool(implementation, declaration);
    this.#tools.set(name, tool);
    this.#provenance.set(name, { name, effect: declaration.effect, provenance: implementation.provenance });
    return tool;
  }

  get(name: string): ToolPort | undefined {
    return this.#tools.get(name);
  }

  tools(): readonly ToolPort[] {
    return [...this.#tools.values()].sort((left, right) => compareOrdinal(left.name, right.name));
  }

  provenance(): readonly RegisteredToolProvenance[] {
    return [...this.#provenance.values()].sort((left, right) => compareOrdinal(left.name, right.name));
  }
}

class GuardedCustomTool implements ToolPort {
  readonly name: string;
  readonly definition: ToolDefinition;

  constructor(
    private readonly implementation: CustomToolImplementation,
    private readonly declaration: CustomToolDeclaration,
  ) {
    this.name = implementation.definition.name;
    this.definition = implementation.definition;
  }

  async execute(input: JsonValue, context: ToolContext): Promise<ToolResult> {
    const errors = validateJsonSchema(input, this.definition.inputSchema);
    if (errors.length > 0) return { ok: false, output: { error: "Input schema validation failed.", details: [...errors] } };
    const controller = new AbortController();
    let settleGuard!: (result: ToolResult) => void;
    const guard = new Promise<ToolResult>((resolve) => { settleGuard = resolve; });
    const abort = (): void => {
      settleGuard({ ok: false, output: { error: "Custom tool aborted." } });
      controller.abort();
    };
    context.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      settleGuard({ ok: false, output: { error: "Custom tool timed out.", timeoutMs: this.declaration.timeoutMs } });
      controller.abort();
    }, this.declaration.timeoutMs);
    try {
      const result = await Promise.race([
        this.implementation.execute(input, { ...context, signal: controller.signal }),
        guard,
      ]);
      const serialized = JSON.stringify(result.output);
      if (serialized === undefined) return { ok: false, output: { error: "Custom tool returned a non-JSON output." } };
      const bytes = Buffer.byteLength(serialized);
      if (bytes > this.declaration.maxOutputBytes) {
        return { ok: false, output: { error: "Custom tool output exceeded its cap.", bytes, maxOutputBytes: this.declaration.maxOutputBytes } };
      }
      return result;
    } catch (error) {
      return { ok: false, output: { error: error instanceof Error ? error.message : String(error) } };
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
    }
  }
}

export function validateJsonSchema(value: JsonValue, schema: JsonValue): readonly string[] {
  const errors: string[] = [];
  validateNode(value, schema, "$", errors);
  return errors;
}

export function validateSchemaDefinition(schema: JsonValue, label: string): void {
  if (schema === null || Array.isArray(schema) || typeof schema !== "object") throw new Error(`${label} must be an object.`);
  const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "minLength", "maxLength", "minimum", "maximum"]);
  const unknown = Object.keys(schema).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unsupported schema keys: ${unknown.sort().join(", ")}.`);
  if (schema.type !== undefined && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(schema.type))) {
    throw new Error(`${label} has an unsupported type.`);
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
  if (typeof type === "string" && !matchesType(value, type)) {
    errors.push(`${at}: expected ${type}.`);
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

function assertNamespaced(name: string): void {
  if (!/^[a-z][a-z0-9_-]{0,31}\.[a-z][a-z0-9_-]{0,63}$/i.test(name)) throw new Error(`Custom tool '${name}' must be namespace.tool.`);
}

function normalizeCommand(command: string): string {
  return process.platform === "win32" ? lowercaseInvariant(command.trim()) : command.trim();
}
