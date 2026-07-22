// Per-provider tool-name compatibility, in one place.
//
// Vanguard's built-in tools use flat snake_case names (`read_file`,
// `check_project`) that every provider accepts verbatim, but extension tools
// keep dotted `namespace.tool` names (custom tools, MCP servers) — and no
// current provider accepts those: OpenAI and Anthropic both require
// ^[a-zA-Z0-9_-]+$ and answer a dotted name with a 400 that names the
// offending field and nothing else. So every wire codec still has to translate
// names out on encode and back on decode, and any codec that forgets is broken
// for every extension tool call it makes.
//
// That is exactly how it broke once: the Anthropic codec shipped without the
// mapping its OpenAI siblings had, and mocked conformance tests never noticed
// because the mock accepted whatever it was handed. Centralizing the rule here
// means a provider declares its constraint once and gets the translation for
// free — there is no per-call-site step left to forget.

import type { ToolDefinition } from "../kernel/contracts.js";
import { CONTROL_TOOL_NAMES, LEGACY_TOOL_NAMES } from "../kernel/contracts.js";

/** One provider's documented tool-name constraint. */
export interface ToolNamingRules {
  /** Used in diagnostics; the provider's own name. */
  readonly vendor: string;
  readonly maxLength: number;
}

/** OpenAI Responses and Chat Completions: ^[a-zA-Z0-9_-]+$, 64 characters. */
export const OPENAI_TOOL_NAMING: ToolNamingRules = { vendor: "OpenAI", maxLength: 64 };

/** Anthropic Messages: ^[a-zA-Z0-9_-]{1,128}$, as the API's own 400 states. */
export const ANTHROPIC_TOOL_NAMING: ToolNamingRules = { vendor: "Anthropic", maxLength: 128 };

const DISALLOWED = /[^a-zA-Z0-9_-]/gu;

/** The vendor spelling of an internal name, with no mapping state required. */
export function sanitizeToolName(internalName: string): string {
  return internalName.replace(DISALLOWED, "_");
}

/**
 * Control tools decode independently of encode state: a provider may return
 * their sanitized spelling before this codec has encoded anything.
 */
const CONTROL_VENDOR_NAMES: Readonly<Record<string, string>> = Object.fromEntries([
  ...Object.values(CONTROL_TOOL_NAMES).map((name) => [sanitizeToolName(name), name]),
  // Pre-rename spellings a resumed conversation may still carry.
  ...Object.entries(LEGACY_TOOL_NAMES).map(([legacy, current]) => [sanitizeToolName(legacy), current]),
]);

/**
 * Translates tool names between Vanguard's internal spelling and one provider's.
 *
 * A codec holds one of these and uses exactly three calls: `register` at the top
 * of encode, `toVendor` wherever a name goes onto the wire, and `toInternal`
 * wherever one comes back.
 */
export class ToolNameTranslator {
  readonly #vendorToInternal = new Map<string, string>();

  constructor(private readonly rules: ToolNamingRules) {}

  /** Rebuild the mapping for one request; call at the top of encode(). */
  register(tools: readonly ToolDefinition[]): void {
    this.#vendorToInternal.clear();
    for (const tool of tools) {
      const vendorName = this.toVendor(tool.name);
      const existing = this.#vendorToInternal.get(vendorName);
      // Two internal names collapsing to one vendor name would silently route a
      // decoded call to the wrong tool.
      if (existing !== undefined && existing !== tool.name) {
        throw new Error(`${this.rules.vendor} tool-name collision between '${existing}' and '${tool.name}'.`);
      }
      this.#vendorToInternal.set(vendorName, tool.name);
    }
  }

  /** Internal name to the spelling this provider accepts. */
  toVendor(internalName: string): string {
    const safe = sanitizeToolName(internalName);
    if (safe.length === 0 || safe.length > this.rules.maxLength) {
      throw new Error(`Tool name cannot be mapped to ${this.rules.vendor}: ${internalName}`);
    }
    return safe;
  }

  /**
   * A name off the wire back to its internal spelling. Falls back to the control
   * table, then to the name as given, so decoding never depends on having
   * encoded first.
   */
  toInternal(vendorName: string): string {
    return this.#vendorToInternal.get(vendorName) ?? CONTROL_VENDOR_NAMES[vendorName] ?? vendorName;
  }
}
