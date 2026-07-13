import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonValue, ToolDefinition } from "../kernel/contracts.js";
import { WorkspaceBoundary } from "../runtime/workspace.js";
import { compareOrdinal } from "../deterministicText.js";

export type ExtensionEffect = NonNullable<ToolDefinition["effect"]>;
export type HookFailurePolicy = "fail-open" | "fail-closed";
export type HookWhen = "before-run" | "after-run" | "before-tool" | "after-tool";

export interface ExtensionPermissions {
  readonly effects: readonly ExtensionEffect[];
  readonly customTools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly hooks: readonly string[];
  readonly commands: readonly string[];
}

export interface SkillPolicyConfig {
  readonly roots: readonly string[];
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface CustomToolDeclaration {
  readonly name: string;
  readonly effect: ExtensionEffect;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface McpServerDeclaration {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly timeoutMs: number;
  readonly maxFrameBytes: number;
}

export interface HookDeclaration {
  readonly name: string;
  readonly when: HookWhen;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly failure: HookFailurePolicy;
}

export interface EffectiveExtensionConfig {
  readonly version: 1;
  readonly permissions: ExtensionPermissions;
  readonly skills: SkillPolicyConfig;
  readonly tools: readonly CustomToolDeclaration[];
  readonly mcp: readonly McpServerDeclaration[];
  readonly hooks: readonly HookDeclaration[];
}

export interface ExtensionProvenance {
  readonly kind: "config" | "instructions";
  readonly scope: "user" | "workspace";
  readonly file: string;
  readonly sha256: string;
}

export interface ResolvedExtensions {
  readonly config: EffectiveExtensionConfig;
  readonly instructions: string;
  readonly provenance: readonly ExtensionProvenance[];
}

export interface ResolveExtensionOptions {
  readonly workspaceRoot: string;
  readonly workingDirectory?: string;
  readonly userHome?: string;
  readonly maxInstructionBytes?: number;
}

interface ParsedLayer {
  readonly permissions?: Partial<ExtensionPermissions>;
  readonly skills?: Partial<SkillPolicyConfig>;
  readonly tools?: readonly CustomToolDeclaration[];
  readonly mcp?: readonly McpServerDeclaration[];
  readonly hooks?: readonly HookDeclaration[];
}

const EFFECTS = ["observe", "mutate", "execute", "review", "state"] as const;
const HOOK_WHEN = ["before-run", "after-run", "before-tool", "after-tool"] as const;
const SAFE_DEFAULTS: EffectiveExtensionConfig = {
  version: 1,
  permissions: { effects: ["observe", "review", "state"], customTools: [], mcpServers: [], hooks: [], commands: [] },
  skills: { roots: [".vanguard/skills"], maxFiles: 32, maxFileBytes: 128 * 1024, maxTotalBytes: 512 * 1024 },
  tools: [],
  mcp: [],
  hooks: [],
};

/**
 * Resolves user then workspace layers deterministically. Workspace permission
 * declarations are narrowing assertions: a project file that asks for any
 * capability outside the user ceiling is rejected instead of silently
 * escalating or being ignored.
 */
export async function resolveExtensions(options: ResolveExtensionOptions): Promise<ResolvedExtensions> {
  const workspace = new WorkspaceBoundary(options.workspaceRoot);
  const root = workspace.root;
  const working = await resolveWorkingDirectory(workspace, options.workingDirectory ?? ".");
  const provenance: ExtensionProvenance[] = [];
  const instructionParts: string[] = [];
  const maxInstructionBytes = bounded(options.maxInstructionBytes ?? 256 * 1024, 1, 4 * 1024 * 1024, "maxInstructionBytes");

  let effective = SAFE_DEFAULTS;
  const userHome = await realpath(path.resolve(options.userHome ?? os.homedir()));
  {
    const userAgents = path.join(userHome, ".vanguard", "AGENTS.md");
    await readInstructionFile(userAgents, "user", maxInstructionBytes, instructionParts, provenance, false);
    const userConfig = path.join(userHome, ".vanguard", "config.json");
    const layer = await readConfigFile(userConfig, "user", provenance, false);
    if (layer !== undefined) {
      effective = mergeLayer(effective, layer);
    }
  }

  const directories = hierarchicalDirectories(root, working);
  for (const directory of directories) {
    const relativeDirectory = path.relative(root, directory);
    const agentsRelative = path.join(relativeDirectory, "AGENTS.md");
    const configRelative = path.join(relativeDirectory, ".vanguard", "config.json");
    await readWorkspaceInstruction(workspace, agentsRelative, maxInstructionBytes, instructionParts, provenance);
    const layer = await readWorkspaceConfig(workspace, configRelative, provenance);
    if (layer !== undefined) {
      // Every workspace layer is monotonic: a deeper directory may narrow
      // its parent, but it cannot re-enable a capability removed above it.
      assertDoesNotWiden(layer.permissions, effective.permissions, configRelative);
      effective = mergeLayer(effective, layer, effective.permissions);
    }
  }

  const instructions = instructionParts.join("\n\n");
  if (Buffer.byteLength(instructions) > maxInstructionBytes) {
    throw new Error(`Combined AGENTS.md instructions exceed ${maxInstructionBytes} bytes.`);
  }
  return { config: effective, instructions, provenance };
}

function mergeLayer(
  current: EffectiveExtensionConfig,
  layer: ParsedLayer,
  ceiling?: ExtensionPermissions,
): EffectiveExtensionConfig {
  const requestedPermissions: ExtensionPermissions = {
    effects: layer.permissions?.effects ?? current.permissions.effects,
    customTools: layer.permissions?.customTools ?? current.permissions.customTools,
    mcpServers: layer.permissions?.mcpServers ?? current.permissions.mcpServers,
    hooks: layer.permissions?.hooks ?? current.permissions.hooks,
    commands: layer.permissions?.commands ?? current.permissions.commands,
  };
  const permissions = ceiling === undefined ? requestedPermissions : intersectPermissions(requestedPermissions, ceiling);
  return {
    version: 1,
    permissions,
    skills: {
      roots: layer.skills?.roots ?? current.skills.roots,
      maxFiles: layer.skills?.maxFiles ?? current.skills.maxFiles,
      maxFileBytes: layer.skills?.maxFileBytes ?? current.skills.maxFileBytes,
      maxTotalBytes: layer.skills?.maxTotalBytes ?? current.skills.maxTotalBytes,
    },
    tools: mergeNamed(current.tools, layer.tools),
    mcp: mergeNamed(current.mcp, layer.mcp),
    hooks: mergeNamed(current.hooks, layer.hooks),
  };
}

function mergeNamed<T extends { readonly name: string }>(
  current: readonly T[],
  incoming: readonly T[] | undefined,
): readonly T[] {
  if (incoming === undefined) return current;
  const merged = new Map(current.map((item) => [item.name, item]));
  for (const item of incoming) merged.set(item.name, item);
  return [...merged.values()].sort((left, right) => compareOrdinal(left.name, right.name));
}

function intersectPermissions(requested: ExtensionPermissions, ceiling: ExtensionPermissions): ExtensionPermissions {
  return {
    effects: intersection(requested.effects, ceiling.effects),
    customTools: intersection(requested.customTools, ceiling.customTools),
    mcpServers: intersection(requested.mcpServers, ceiling.mcpServers),
    hooks: intersection(requested.hooks, ceiling.hooks),
    commands: intersection(requested.commands, ceiling.commands),
  };
}

function assertDoesNotWiden(
  requested: Partial<ExtensionPermissions> | undefined,
  ceiling: ExtensionPermissions,
  source: string,
): void {
  if (requested === undefined) return;
  for (const field of ["effects", "customTools", "mcpServers", "hooks", "commands"] as const) {
    const values = requested[field];
    if (values === undefined) continue;
    const allowed = new Set(ceiling[field]);
    const widened = values.filter((value) => !allowed.has(value as never));
    if (widened.length > 0) {
      throw new Error(`Workspace config '${source}' cannot widen ${field}: ${widened.join(", ")}.`);
    }
  }
}

function intersection<T extends string>(left: readonly T[], right: readonly T[]): readonly T[] {
  const allowed = new Set(right);
  return [...new Set(left.filter((item) => allowed.has(item)))].sort();
}

async function resolveWorkingDirectory(workspace: WorkspaceBoundary, relative: string): Promise<string> {
  if (path.isAbsolute(relative)) {
    const candidate = await realpath(relative);
    const rel = path.relative(workspace.root, candidate);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("workingDirectory escapes workspace.");
    return candidate;
  }
  return workspace.existing(relative);
}

function hierarchicalDirectories(root: string, working: string): readonly string[] {
  const relative = path.relative(root, working);
  if (relative === "") return [root];
  const output = [root];
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    output.push(cursor);
  }
  return output;
}

async function readWorkspaceInstruction(
  workspace: WorkspaceBoundary,
  relative: string,
  maxBytes: number,
  parts: string[],
  provenance: ExtensionProvenance[],
): Promise<void> {
  try {
    const file = await workspace.existing(relative);
    await readInstructionFile(file, "workspace", maxBytes, parts, provenance, true);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function readWorkspaceConfig(
  workspace: WorkspaceBoundary,
  relative: string,
  provenance: ExtensionProvenance[],
): Promise<ParsedLayer | undefined> {
  try {
    const file = await workspace.existing(relative);
    return readConfigFile(file, "workspace", provenance, true);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function readInstructionFile(
  file: string,
  scope: "user" | "workspace",
  maxBytes: number,
  parts: string[],
  provenance: ExtensionProvenance[],
  knownExisting: boolean,
): Promise<void> {
  try {
    const contents = await readFile(file);
    if (contents.byteLength > maxBytes) throw new Error(`Instruction file '${file}' exceeds ${maxBytes} bytes.`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    parts.push(`[Instructions: ${file}]\n${text}`);
    provenance.push(provenanceRecord("instructions", scope, file, contents));
  } catch (error) {
    if (!knownExisting && isMissing(error)) return;
    throw error;
  }
}

async function readConfigFile(
  file: string,
  scope: "user" | "workspace",
  provenance: ExtensionProvenance[],
  knownExisting: boolean,
): Promise<ParsedLayer | undefined> {
  try {
    const contents = await readFile(file);
    if (contents.byteLength > 512 * 1024) throw new Error(`Config file '${file}' exceeds 524288 bytes.`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    const raw: unknown = JSON.parse(text);
    const parsed = parseLayer(raw, file);
    provenance.push(provenanceRecord("config", scope, file, contents));
    return parsed;
  } catch (error) {
    if (!knownExisting && isMissing(error)) return undefined;
    throw error;
  }
}

function parseLayer(value: unknown, source: string): ParsedLayer {
  const object = strictObject(value, source, ["version", "permissions", "skills", "tools", "mcp", "hooks"]);
  if (object.version !== 1) throw new Error(`${source}: version must be 1.`);
  return {
    ...(object.permissions === undefined ? {} : { permissions: parsePermissions(object.permissions, source) }),
    ...(object.skills === undefined ? {} : { skills: parseSkills(object.skills, source) }),
    ...(object.tools === undefined ? {} : { tools: array(object.tools, `${source}.tools`).map((item, index) => parseTool(item, `${source}.tools[${index}]`)) }),
    ...(object.mcp === undefined ? {} : { mcp: array(object.mcp, `${source}.mcp`).map((item, index) => parseMcp(item, `${source}.mcp[${index}]`)) }),
    ...(object.hooks === undefined ? {} : { hooks: array(object.hooks, `${source}.hooks`).map((item, index) => parseHook(item, `${source}.hooks[${index}]`)) }),
  };
}

function parsePermissions(value: unknown, source: string): Partial<ExtensionPermissions> {
  const object = strictObject(value, `${source}.permissions`, ["effects", "customTools", "mcpServers", "hooks", "commands"]);
  return {
    ...(object.effects === undefined ? {} : { effects: enumArray(object.effects, EFFECTS, `${source}.permissions.effects`) }),
    ...(object.customTools === undefined ? {} : { customTools: stringArray(object.customTools, `${source}.permissions.customTools`) }),
    ...(object.mcpServers === undefined ? {} : { mcpServers: stringArray(object.mcpServers, `${source}.permissions.mcpServers`) }),
    ...(object.hooks === undefined ? {} : { hooks: stringArray(object.hooks, `${source}.permissions.hooks`) }),
    ...(object.commands === undefined ? {} : { commands: stringArray(object.commands, `${source}.permissions.commands`) }),
  };
}

function parseSkills(value: unknown, source: string): Partial<SkillPolicyConfig> {
  const object = strictObject(value, `${source}.skills`, ["roots", "maxFiles", "maxFileBytes", "maxTotalBytes"]);
  return {
    ...(object.roots === undefined ? {} : { roots: stringArray(object.roots, `${source}.skills.roots`) }),
    ...(object.maxFiles === undefined ? {} : { maxFiles: boundedNumber(object.maxFiles, 1, 1_000, `${source}.skills.maxFiles`) }),
    ...(object.maxFileBytes === undefined ? {} : { maxFileBytes: boundedNumber(object.maxFileBytes, 1, 4 * 1024 * 1024, `${source}.skills.maxFileBytes`) }),
    ...(object.maxTotalBytes === undefined ? {} : { maxTotalBytes: boundedNumber(object.maxTotalBytes, 1, 16 * 1024 * 1024, `${source}.skills.maxTotalBytes`) }),
  };
}

function parseTool(value: unknown, source: string): CustomToolDeclaration {
  const object = strictObject(value, source, ["name", "effect", "timeoutMs", "maxOutputBytes"]);
  return {
    name: namespacedName(object.name, `${source}.name`),
    effect: enumValue(object.effect, EFFECTS, `${source}.effect`),
    timeoutMs: boundedNumber(object.timeoutMs ?? 30_000, 1, 10 * 60_000, `${source}.timeoutMs`),
    maxOutputBytes: boundedNumber(object.maxOutputBytes ?? 256 * 1024, 1, 4 * 1024 * 1024, `${source}.maxOutputBytes`),
  };
}

function parseMcp(value: unknown, source: string): McpServerDeclaration {
  const object = strictObject(value, source, ["name", "command", "args", "cwd", "tools", "timeoutMs", "maxFrameBytes"]);
  return {
    name: simpleName(object.name, `${source}.name`),
    command: nonemptyString(object.command, `${source}.command`),
    args: stringArray(object.args ?? [], `${source}.args`),
    cwd: nonemptyString(object.cwd ?? ".", `${source}.cwd`),
    tools: stringArray(object.tools ?? [], `${source}.tools`),
    timeoutMs: boundedNumber(object.timeoutMs ?? 30_000, 1, 10 * 60_000, `${source}.timeoutMs`),
    maxFrameBytes: boundedNumber(object.maxFrameBytes ?? 1024 * 1024, 1_024, 4 * 1024 * 1024, `${source}.maxFrameBytes`),
  };
}

function parseHook(value: unknown, source: string): HookDeclaration {
  const object = strictObject(value, source, ["name", "when", "command", "args", "cwd", "timeoutMs", "failure"]);
  return {
    name: simpleName(object.name, `${source}.name`),
    when: enumValue(object.when, HOOK_WHEN, `${source}.when`),
    command: nonemptyString(object.command, `${source}.command`),
    args: stringArray(object.args ?? [], `${source}.args`),
    cwd: nonemptyString(object.cwd ?? ".", `${source}.cwd`),
    timeoutMs: boundedNumber(object.timeoutMs ?? 10_000, 1, 60_000, `${source}.timeoutMs`),
    failure: enumValue(object.failure ?? "fail-closed", ["fail-open", "fail-closed"] as const, `${source}.failure`),
  };
}

function strictObject(value: unknown, source: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error(`${source} must be an object.`);
  const object = value as Record<string, unknown>;
  const unknown = Object.keys(object).filter((key) => !keys.includes(key)).sort();
  if (unknown.length > 0) throw new Error(`${source} contains unknown keys: ${unknown.join(", ")}.`);
  return object;
}

function array(value: unknown, source: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${source} must be an array.`);
  return value;
}

function stringArray(value: unknown, source: string): readonly string[] {
  const values = array(value, source);
  if (!values.every((item) => typeof item === "string" && item.length > 0)) throw new Error(`${source} must contain non-empty strings.`);
  return [...new Set(values as string[])].sort();
}

function enumArray<T extends string>(value: unknown, allowed: readonly T[], source: string): readonly T[] {
  return stringArray(value, source).map((item) => enumValue(item, allowed, source));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], source: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${source} must be one of: ${allowed.join(", ")}.`);
  return value as T;
}

function nonemptyString(value: unknown, source: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error(`${source} must be a non-empty string.`);
  return value;
}

function simpleName(value: unknown, source: string): string {
  const name = nonemptyString(value, source);
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(name)) throw new Error(`${source} is not a valid extension name.`);
  return name;
}

function namespacedName(value: unknown, source: string): string {
  const name = nonemptyString(value, source);
  if (!/^[a-z][a-z0-9_-]{0,31}\.[a-z][a-z0-9_-]{0,63}$/i.test(name)) throw new Error(`${source} must be namespace.tool.`);
  return name;
}

function boundedNumber(value: unknown, min: number, max: number, source: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${source} must be an integer from ${min} to ${max}.`);
  return value as number;
}

function bounded(value: number, min: number, max: number, source: string): number {
  return boundedNumber(value, min, max, source);
}

function provenanceRecord(
  kind: ExtensionProvenance["kind"],
  scope: ExtensionProvenance["scope"],
  file: string,
  contents: Uint8Array,
): ExtensionProvenance {
  return { kind, scope, file, sha256: createHash("sha256").update(contents).digest("hex") };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** JSON-safe representation for journals and scorecards. */
export function extensionRuntimeState(value: ResolvedExtensions): JsonValue {
  return {
    config: {
      version: value.config.version,
      permissions: {
        effects: [...value.config.permissions.effects],
        customTools: [...value.config.permissions.customTools],
        mcpServers: [...value.config.permissions.mcpServers],
        hooks: [...value.config.permissions.hooks],
        commandCount: value.config.permissions.commands.length,
      },
      skills: value.config.skills as unknown as JsonValue,
      tools: value.config.tools as unknown as JsonValue,
      // Commands and argv are deliberately omitted from public runtime state:
      // source hashes preserve provenance without copying possible secrets.
      mcp: value.config.mcp.map((server) => ({ name: server.name, tools: [...server.tools] })),
      hooks: value.config.hooks.map((hook) => ({ name: hook.name, when: hook.when, failure: hook.failure })),
    },
    provenance: value.provenance as unknown as JsonValue,
    instructionBytes: Buffer.byteLength(value.instructions),
  };
}
