import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CustomToolRegistry,
  ExtensionPermissionPolicy,
  FileExtensionAuditJournal,
  HookRunner,
  McpStdioClient,
  VanguardExtensionRegistry,
  WorkspaceBoundary,
  loadWorkspaceSkills,
  resolveExtensions,
  type ExtensionAuditEvent,
  type ExtensionAuditPort,
  type HookDeclaration,
  type McpServerDeclaration,
} from "../src/index.js";

const roots: string[] = [];
test.after(async () => {
  for (const root of roots.reverse()) await rm(root, { recursive: true, force: true });
});

test("hierarchical config and AGENTS discovery is deterministic, strict, and provenance-bearing", async () => {
  const { workspace, home } = await fixture("config");
  await mkdir(path.join(workspace, "src", "feature"), { recursive: true });
  await writeFile(path.join(workspace, "AGENTS.md"), "root rules");
  await writeFile(path.join(workspace, "src", "AGENTS.md"), "src rules");
  await writeFile(path.join(home, ".vanguard", "AGENTS.md"), "user rules");
  await writeJson(path.join(home, ".vanguard", "config.json"), {
    version: 1,
    permissions: {
      effects: ["observe", "execute"],
      customTools: ["acme.echo"],
      mcpServers: ["local"],
      hooks: ["audit"],
      commands: [process.execPath],
    },
    skills: { roots: ["skills"], maxFiles: 10, maxFileBytes: 4096, maxTotalBytes: 8192 },
  });
  await writeJson(path.join(workspace, ".vanguard", "config.json"), {
    version: 1,
    permissions: {
      effects: ["observe"], customTools: ["acme.echo"], mcpServers: [], hooks: [], commands: [],
    },
    skills: { maxFiles: 4 },
    tools: [{ name: "acme.echo", effect: "observe", timeoutMs: 100, maxOutputBytes: 2048 }],
  });

  const options = { workspaceRoot: workspace, workingDirectory: "src/feature", userHome: home };
  const first = await resolveExtensions(options);
  const second = await resolveExtensions(options);
  assert.deepEqual(second, first);
  assert.deepEqual(first.config.permissions.effects, ["observe"]);
  assert.equal(first.config.skills.maxFiles, 4);
  assert.match(first.instructions, /user rules[\s\S]*root rules[\s\S]*src rules/);
  assert.deepEqual(first.provenance.map((item) => item.scope), ["user", "user", "workspace", "workspace", "workspace"]);
  assert.ok(first.provenance.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
});

test("hermetic extension resolution ignores every user and workspace layer", async () => {
  const { workspace, home } = await fixture("hermetic-user-layer");
  await writeFile(path.join(home, ".vanguard", "AGENTS.md"), "untrusted user instruction");
  await writeJson(path.join(home, ".vanguard", "config.json"), {
    version: 1,
    permissions: {
      effects: ["observe", "execute"], customTools: [], mcpServers: [], hooks: [], commands: ["node"],
    },
  });
  await writeFile(path.join(workspace, "AGENTS.md"), "untrusted workspace instruction");
  await writeJson(path.join(workspace, ".vanguard", "config.json"), {
    version: 1,
    permissions: { effects: ["observe"], customTools: [], mcpServers: [], hooks: [], commands: [] },
    skills: { roots: ["workspace-skills"], maxFiles: 1, maxFileBytes: 128, maxTotalBytes: 128 },
  });

  const resolved = await resolveExtensions({ workspaceRoot: workspace, userHome: home, disableExtensions: true });
  assert.equal(resolved.instructions, "");
  assert.deepEqual(resolved.provenance, []);
  assert.deepEqual(resolved.config.permissions.effects, ["observe", "review", "state"]);
  assert.deepEqual(resolved.config.permissions.commands, []);
});

test("unknown config keys and workspace permission widening are rejected", async () => {
  const unknown = await fixture("unknown");
  await writeJson(path.join(unknown.workspace, ".vanguard", "config.json"), { version: 1, surprise: true });
  await assert.rejects(resolveExtensions({ workspaceRoot: unknown.workspace, userHome: unknown.home }), /unknown keys: surprise/);

  const widening = await fixture("widening");
  await writeJson(path.join(widening.home, ".vanguard", "config.json"), {
    version: 1,
    permissions: { effects: ["observe"], customTools: [], mcpServers: [], hooks: [], commands: [] },
  });
  await writeJson(path.join(widening.workspace, ".vanguard", "config.json"), {
    version: 1,
    permissions: { effects: ["observe", "execute"] },
  });
  await assert.rejects(resolveExtensions({ workspaceRoot: widening.workspace, userHome: widening.home }), /cannot widen effects: execute/);

  const nested = await fixture("nested-widening");
  await mkdir(path.join(nested.workspace, "src"), { recursive: true });
  await writeJson(path.join(nested.home, ".vanguard", "config.json"), {
    version: 1,
    permissions: { effects: ["observe", "execute"], customTools: [], mcpServers: [], hooks: [], commands: [] },
  });
  await writeJson(path.join(nested.workspace, ".vanguard", "config.json"), { version: 1, permissions: { effects: ["observe"] } });
  await writeJson(path.join(nested.workspace, "src", ".vanguard", "config.json"), { version: 1, permissions: { effects: ["observe", "execute"] } });
  await assert.rejects(resolveExtensions({ workspaceRoot: nested.workspace, workingDirectory: "src", userHome: nested.home }), /cannot widen effects: execute/);
});

test("workspace traversal and out-of-root config symlinks are refused", async (context) => {
  const { workspace, home, root } = await fixture("boundary");
  await assert.rejects(resolveExtensions({ workspaceRoot: workspace, workingDirectory: "..", userHome: home }), /escapes workspace/);
  const outside = path.join(root, "outside.json");
  await writeFile(outside, JSON.stringify({ version: 1 }));
  await mkdir(path.join(workspace, ".vanguard"), { recursive: true });
  try {
    await symlink(outside, path.join(workspace, ".vanguard", "config.json"), "file");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
      context.skip("Symlink creation is unavailable on this Windows host.");
      return;
    }
    throw error;
  }
  await assert.rejects(resolveExtensions({ workspaceRoot: workspace, userHome: home }), /escapes workspace/);
});

test("skills are bounded data-only packages; scripts are never executed", async () => {
  const { workspace } = await fixture("skills");
  const skill = path.join(workspace, "skills", "safe");
  await mkdir(path.join(skill, "scripts"), { recursive: true });
  const marker = path.join(workspace, "EXECUTED");
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: safe\ndescription: Safe portable instructions\nversion: 1.0.0\n---\nRead, reason, and report.");
  await writeFile(path.join(skill, "scripts", "danger.mjs"), `await import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(marker)}, 'bad'));`);
  const loaded = await loadWorkspaceSkills(new WorkspaceBoundary(workspace), {
    roots: ["skills"], maxFiles: 8, maxFileBytes: 4096, maxTotalBytes: 8192,
  });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.metadata.name, "safe");
  assert.equal(loaded[0]?.resources.length, 2);
  await assert.rejects(access(marker));

  await writeFile(path.join(skill, "SKILL.md"), `---\nname: safe\ndescription: Big\n---\n${"x".repeat(5000)}`);
  await assert.rejects(loadWorkspaceSkills(new WorkspaceBoundary(workspace), {
    roots: ["skills"], maxFiles: 8, maxFileBytes: 1024, maxTotalBytes: 8192,
  }), /exceeds 1024 bytes/);
});

test("custom tools require exact permission, effect agreement, schema validity, and bounded output", async () => {
  const permissions = {
    effects: ["observe"] as const,
    customTools: ["acme.echo"],
    mcpServers: [], hooks: [], commands: [],
  };
  const declaration = { name: "acme.echo", effect: "observe" as const, timeoutMs: 200, maxOutputBytes: 100 };
  const registry = new CustomToolRegistry(new ExtensionPermissionPolicy(permissions), [declaration]);
  assert.throws(() => registry.register({
    definition: { name: "acme.echo", description: "echo", inputSchema: { type: "object" }, effect: "observe" },
    implementationEffect: "mutate",
    provenance: "test",
    execute: async () => ({ ok: true, output: {} }),
  }), /effect declaration does not match/);

  const tool = registry.register({
    definition: {
      name: "acme.echo", description: "echo",
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      effect: "observe",
      evidenceAuthority: "independent-execution",
    },
    implementationEffect: "observe",
    provenance: "fixture:acme@1",
    execute: async (input) => ({ ok: true, output: input }),
  });
  const context = { task: "test", step: 1, signal: new AbortController().signal };
  assert.equal((await tool.execute({}, context)).ok, false);
  assert.equal((await tool.execute({ value: "ok" }, context)).ok, true);
  assert.equal((await tool.execute({ value: "x".repeat(200) }, context)).ok, false);
  assert.equal(tool.definition.evidenceAuthority, undefined);
  assert.deepEqual(registry.provenance(), [{ name: "acme.echo", effect: "observe", provenance: "fixture:acme@1" }]);

  const slowRegistry = new CustomToolRegistry(
    new ExtensionPermissionPolicy({ ...permissions, customTools: ["acme.slow"] }),
    [{ name: "acme.slow", effect: "observe", timeoutMs: 25, maxOutputBytes: 100 }],
  );
  const slow = slowRegistry.register({
    definition: { name: "acme.slow", description: "slow", inputSchema: { type: "object" }, effect: "observe" },
    implementationEffect: "observe", provenance: "fixture:slow@1",
    execute: async (_input, inner) => new Promise((resolve) => inner.signal.addEventListener("abort", () => resolve({ ok: false, output: {} }), { once: true })),
  });
  const timeout = await slow.execute({}, context);
  assert.equal(timeout.ok, false);
  assert.match(JSON.stringify(timeout.output), /timed out/);
});

test("hooks use literal argv, enforce timeout/failure policy, redact, and audit every outcome", async () => {
  const { workspace } = await fixture("hooks");
  const marker = path.join(workspace, "INJECTED");
  const injection = `; require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`;
  const hooks: HookDeclaration[] = [
    {
      name: "audit", when: "before-run", command: process.execPath,
      args: ["-e", "process.stdout.write(process.argv.slice(1).join('|'))", injection, "token=super-secret-value"], cwd: ".", timeoutMs: 2_000, failure: "fail-closed",
    },
    {
      name: "slow", when: "after-run", command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"], cwd: ".", timeoutMs: 50, failure: "fail-open",
    },
    {
      name: "closed", when: "before-tool", command: process.execPath,
      args: ["-e", "process.exit(2)"], cwd: ".", timeoutMs: 2_000, failure: "fail-closed",
    },
  ];
  const audit = new MemoryAudit();
  const policy = new ExtensionPermissionPolicy({
    effects: [], customTools: [], mcpServers: [], hooks: ["audit", "slow", "closed"], commands: [process.execPath],
  });
  const runner = new HookRunner(new WorkspaceBoundary(workspace), policy, hooks, audit, { TEST_API_KEY: "super-secret-value", PATH: process.env.PATH });
  const passed = await runner.run("before-run", new AbortController().signal);
  assert.equal(passed[0]?.stdout, `${injection}|token=[REDACTED]`);
  await assert.rejects(access(marker));
  const timed = await runner.run("after-run", new AbortController().signal);
  assert.equal(timed[0]?.timedOut, true);
  assert.equal(audit.events.length, 2);
  assert.deepEqual(audit.events.map((event) => event.status), ["passed", "timed-out"]);
  await assert.rejects(runner.run("before-tool", new AbortController().signal), /fail-closed/);
  assert.equal(audit.events.at(-1)?.status, "failed");

  const durable = await FileExtensionAuditJournal.open(path.join(workspace, ".vanguard", "extension-audit.jsonl"));
  await durable.record(audit.events[0]!);
  await durable.record(audit.events[1]!);
  await durable.record(audit.events[2]!);
  assert.deepEqual((await durable.readValidated()).map((event) => event.status), ["passed", "timed-out", "failed"]);
  await writeFile(durable.file, (await readFile(durable.file, "utf8")).replace('"status":"passed"', '"status":"failed"'));
  await assert.rejects(durable.readValidated(), /audit integrity failure/);
});

test("MCP performs handshake, allowlists tools, validates inputs, redacts secrets, and cleans up", async () => {
  const { workspace } = await fixture("mcp-ok");
  const server = await mcpServer(workspace, "normal");
  const audit = new MemoryAudit();
  const policy = mcpPolicy("local");
  const client = await McpStdioClient.connect(new WorkspaceBoundary(workspace), mcpDeclaration(server), policy, audit, {
    PATH: process.env.PATH,
    TEST_API_KEY: "mcp-secret-value",
  });
  try {
    assert.equal(client.state().protocolVersion, "2025-03-26");
    assert.deepEqual(client.state().tools.map((tool) => tool.name), ["echo"]);
    assert.equal((await client.callTool("hidden", {})).ok, false);
    assert.equal((await client.callTool("echo", {})).ok, false);
    const result = await client.callTool("echo", { text: "mcp-secret-value" });
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result.output).includes("mcp-secret-value"), false);
  } finally {
    await client.close();
  }
  assert.deepEqual(audit.events.map((event) => event.status), ["started", "stopped"]);
});

test("MCP rejects traversal, malformed and oversized frames, and disconnects without hanging", async () => {
  for (const mode of ["malformed", "oversized", "disconnect"] as const) {
    const { workspace } = await fixture(`mcp-${mode}`);
    const server = await mcpServer(workspace, mode);
    await assert.rejects(
      McpStdioClient.connect(new WorkspaceBoundary(workspace), mcpDeclaration(server, mode === "oversized" ? 1024 : 4096), mcpPolicy("local"), new MemoryAudit()),
      /MCP|disconnected|malformed|frame/i,
    );
  }
  const { workspace } = await fixture("mcp-traversal");
  const server = await mcpServer(workspace, "normal");
  await assert.rejects(
    McpStdioClient.connect(new WorkspaceBoundary(workspace), { ...mcpDeclaration(server), cwd: ".." }, mcpPolicy("local"), new MemoryAudit()),
    /escapes workspace/,
  );
});

test("extension interface registry is deterministic and rejects duplicate identities", () => {
  const registry = new VanguardExtensionRegistry();
  registry.register({
    kind: "reviewer", name: "maintainability", version: "1.0.0", provenance: "builtin:test",
    review: async () => ({ reviewer: "maintainability", passed: true, findings: [] }),
  });
  registry.register({
    kind: "provider", name: "wire", version: "1.2.0", provenance: "builtin:test",
    create: () => ({ decide: async () => ({ kind: "respond", message: "ok" }) }),
  });
  assert.deepEqual(registry.manifest().map((item) => `${item.kind}:${item.name}`), ["provider:wire", "reviewer:maintainability"]);
  assert.throws(() => registry.register({
    kind: "reviewer", name: "maintainability", version: "1.0.0", provenance: "again",
    review: async () => ({ reviewer: "x", passed: true, findings: [] }),
  }), /already registered/);
});

class MemoryAudit implements ExtensionAuditPort {
  readonly events: ExtensionAuditEvent[] = [];
  async record(event: ExtensionAuditEvent): Promise<void> { this.events.push(event); }
}

async function fixture(name: string): Promise<{ root: string; workspace: string; home: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `vanguard-ext-${name}-`));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(home, ".vanguard"), { recursive: true });
  return { root, workspace, home };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), "utf8");
}

function mcpPolicy(name: string): ExtensionPermissionPolicy {
  return new ExtensionPermissionPolicy({
    effects: ["execute"], customTools: [], mcpServers: [name], hooks: [], commands: [process.execPath],
  });
}

function mcpDeclaration(server: string, maxFrameBytes = 4096): McpServerDeclaration {
  return {
    name: "local", command: process.execPath, args: [server], cwd: ".", tools: ["echo"],
    timeoutMs: 2_000, maxFrameBytes,
  };
}

async function mcpServer(workspace: string, mode: "normal" | "malformed" | "oversized" | "disconnect"): Promise<string> {
  const file = path.join(workspace, `mcp-${mode}.mjs`);
  const source = `
import readline from 'node:readline';
const mode = ${JSON.stringify(mode)};
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (mode === 'disconnect') process.exit(0);
  if (mode === 'malformed') { process.stdout.write('{bad\\n'); return; }
  if (mode === 'oversized') { process.stdout.write('x'.repeat(5000) + '\\n'); return; }
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (message.method === 'tools/list') result = { tools: [
    { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
    { name: 'hidden', description: 'hidden', inputSchema: { type: 'object' } }
  ] };
  else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: message.params.arguments.text }] };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`;
  await writeFile(file, source, "utf8");
  return file;
}
