import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { expandPromptCommand, loadPromptCommands } from "../src/index.js";
import type { PromptCommand } from "../src/index.js";

async function withRoots<T>(
  body: (roots: { workspaceRoot: string; userHome: string }) => Promise<T>,
): Promise<T> {
  const base = await mkdtemp(path.join(os.tmpdir(), "vanguard-commands-"));
  const workspaceRoot = path.join(base, "workspace");
  const userHome = path.join(base, "home");
  await mkdir(path.join(workspaceRoot, ".vanguard", "commands"), { recursive: true });
  await mkdir(path.join(userHome, ".vanguard", "commands"), { recursive: true });
  try {
    return await body({ workspaceRoot, userHome });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function commandFile(root: string, name: string): string {
  return path.join(root, ".vanguard", "commands", name);
}

function byName(commands: readonly PromptCommand[], name: string): PromptCommand {
  const found = commands.find((command) => command.name === name);
  assert.ok(found !== undefined, `expected a '${name}' command`);
  return found;
}

test("markdown templates become described commands with frontmatter honored", async () => {
  await withRoots(async ({ workspaceRoot, userHome }) => {
    await writeFile(
      commandFile(workspaceRoot, "review.md"),
      "---\ndescription: Adversarially review the working tree\n---\nReview the diff for $ARGUMENTS and report only real defects.\n",
      "utf8",
    );
    // No frontmatter: the first meaningful line becomes the description.
    await writeFile(commandFile(workspaceRoot, "ship.md"), "# Cut a release\nBuild, test, then tag.\n", "utf8");
    const commands = await loadPromptCommands({ workspaceRoot, userHome });
    assert.deepEqual(commands.map((command) => command.name), ["review", "ship"]);
    assert.equal(byName(commands, "review").description, "Adversarially review the working tree");
    assert.equal(byName(commands, "ship").description, "Cut a release");
    assert.equal(byName(commands, "review").scope, "workspace");
    assert.match(byName(commands, "review").sha256, /^[0-9a-f]{64}$/u);
  });
});

test("a workspace command shadows a user command of the same name", async () => {
  await withRoots(async ({ workspaceRoot, userHome }) => {
    await writeFile(commandFile(userHome, "audit.md"), "User level audit.\n", "utf8");
    await writeFile(commandFile(userHome, "personal.md"), "Only mine.\n", "utf8");
    await writeFile(commandFile(workspaceRoot, "audit.md"), "Project level audit.\n", "utf8");
    const commands = await loadPromptCommands({ workspaceRoot, userHome });
    assert.deepEqual(commands.map((command) => command.name), ["audit", "personal"]);
    assert.equal(byName(commands, "audit").template, "Project level audit.");
    assert.equal(byName(commands, "audit").scope, "workspace");
    assert.equal(byName(commands, "personal").scope, "user");
  });
});

test("placeholders substitute and unreferenced arguments are appended, never dropped", () => {
  const base = { name: "x", description: "", source: "", scope: "workspace", sha256: "" } as const;
  const all: PromptCommand = { ...base, template: "Explain $ARGUMENTS in depth." };
  assert.equal(expandPromptCommand(all, "  the kernel loop "), "Explain the kernel loop in depth.");

  const positional: PromptCommand = { ...base, template: "Move $1 to $2." };
  assert.equal(expandPromptCommand(positional, '"src/a b.ts" dist/'), "Move src/a b.ts to dist/.");

  // A template that references nothing must still receive typed arguments.
  const silent: PromptCommand = { ...base, template: "Run the standard review." };
  assert.equal(expandPromptCommand(silent, "focus on auth"), "Run the standard review.\n\nfocus on auth");
  assert.equal(expandPromptCommand(silent, ""), "Run the standard review.");

  // An unsupplied positional collapses rather than leaking the placeholder.
  const missing: PromptCommand = { ...base, template: "Check $1 and $2." };
  assert.equal(expandPromptCommand(missing, "only"), "Check only and .");
});

test("discovery ignores non-markdown, symlinks, oversized files, and bad names", async () => {
  await withRoots(async ({ workspaceRoot, userHome }) => {
    await writeFile(commandFile(workspaceRoot, "good.md"), "Fine.\n", "utf8");
    await writeFile(commandFile(workspaceRoot, "notes.txt"), "Not a command.\n", "utf8");
    await writeFile(commandFile(workspaceRoot, "9bad.md"), "Bad name.\n", "utf8");
    await writeFile(commandFile(workspaceRoot, "empty.md"), "   \n", "utf8");
    await writeFile(commandFile(workspaceRoot, "huge.md"), "x".repeat(65 * 1024), "utf8");
    const target = path.join(workspaceRoot, "outside.md");
    await writeFile(target, "Linked.\n", "utf8");
    try {
      await symlink(target, commandFile(workspaceRoot, "linked.md"));
    } catch {
      // Unprivileged Windows cannot create symlinks; the rest still asserts.
    }
    const commands = await loadPromptCommands({ workspaceRoot, userHome });
    assert.deepEqual(commands.map((command) => command.name), ["good"]);
  });
});

test("a missing commands directory and disabled extensions both yield nothing", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "vanguard-commands-bare-"));
  try {
    assert.deepEqual(await loadPromptCommands({ workspaceRoot: base, userHome: base }), []);
    await mkdir(path.join(base, ".vanguard", "commands"), { recursive: true });
    await writeFile(commandFile(base, "present.md"), "Here.\n", "utf8");
    assert.equal((await loadPromptCommands({ workspaceRoot: base, userHome: base })).length, 1);
    assert.deepEqual(
      await loadPromptCommands({ workspaceRoot: base, userHome: base, disableExtensions: true }),
      [],
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
