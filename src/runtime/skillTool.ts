import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import type { LoadedSkill } from "../extensions/skills.js";
import { objectInput, stringField } from "./input.js";

/**
 * On-demand skill bodies.
 *
 * Skills used to be inlined wholesale into the task addendum, so every turn
 * paid for every skill whether or not it was relevant — the cost Pi's
 * progressive-disclosure argument is aimed at, and the reason a few large
 * skills could quietly dominate a long session's window. The addendum now
 * advertises names and descriptions; this returns a body when the model
 * decides it wants one.
 *
 * `observe` effect with no evidence authority: skill text is instruction-like
 * project data, never proof that anything was done.
 */

const MAX_BODY_BYTES = 128 * 1024;

export class SkillReadTool implements ToolPort {
  readonly name = "read_skill";
  readonly definition: ToolDefinition;

  readonly #skills: ReadonlyMap<string, LoadedSkill>;

  constructor(skills: readonly LoadedSkill[]) {
    this.#skills = new Map(skills.map((skill) => [skill.metadata.name, skill]));
    const names = [...this.#skills.keys()];
    this.definition = {
      name: this.name,
      description:
        "Read the full instructions of a workspace skill by name. The task lists each skill's name and summary; "
        + "load a body only when it is relevant to the work at hand."
        + (names.length === 0 ? "" : ` Available: ${names.join(", ")}.`),
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The skill name exactly as advertised in the task.",
            ...(names.length === 0 ? {} : { enum: names }),
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      effect: "observe",
    };
  }

  async execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    try {
      const name = stringField(objectInput(input), "name").trim();
      const skill = this.#skills.get(name);
      if (skill === undefined) {
        return {
          ok: false,
          output: {
            error: `No workspace skill named '${name}'.`,
            available: [...this.#skills.keys()] as unknown as JsonValue,
          },
        };
      }
      const instructions = skill.instructions.length > MAX_BODY_BYTES
        ? skill.instructions.slice(0, MAX_BODY_BYTES)
        : skill.instructions;
      return {
        ok: true,
        output: {
          name: skill.metadata.name,
          description: skill.metadata.description,
          ...(skill.metadata.version === undefined ? {} : { version: skill.metadata.version }),
          truncated: instructions.length < skill.instructions.length,
          // Skill text is project data the model chose to load; it is content
          // to apply, not authority to act outside the contract.
          instructions,
        },
      };
    } catch (error) {
      return { ok: false, output: { error: error instanceof Error ? error.message : String(error) } };
    }
  }
}
