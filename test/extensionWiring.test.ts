import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const cli = path.resolve("dist", "src", "cli.js");

async function userHomeWithConfig(config: unknown): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "vanguard-exthome-"));
  await mkdir(path.join(home, ".vanguard"), { recursive: true });
  await writeFile(path.join(home, ".vanguard", "config.json"), JSON.stringify(config, null, 2));
  return home;
}

async function repairableProject(): Promise<string> {
  const source = await mkdtemp(path.join(os.tmpdir(), "vanguard-extsrc-"));
  await writeFile(path.join(source, "answer.mjs"), "export const answer = () => 41;\n");
  await writeFile(path.join(source, "test.mjs"), "import {answer} from './answer.mjs'; if(answer()!==42) process.exit(1);\n");
  await writeFile(path.join(source, "package.json"), JSON.stringify({ scripts: { test: "node test.mjs" } }));
  return source;
}

function homeEnvironment(home: string): NodeJS.ProcessEnv {
  return { ...process.env, USERPROFILE: home, HOME: home };
}

test("a fail-closed before-run hook refuses the whole run", async () => {
  const home = await userHomeWithConfig({
    version: 1,
    permissions: { effects: ["observe", "review", "state"], customTools: [], mcpServers: [], hooks: ["gate"], commands: ["node"] },
    hooks: [{
      name: "gate",
      when: "before-run",
      command: "node",
      args: ["-e", "process.exit(1)"],
      cwd: ".",
      timeoutMs: 30_000,
      failure: "fail-closed",
    }],
  });
  const source = await repairableProject();
  try {
    const result = await executeFile(process.execPath, [
      cli, "run",
      "--workspace", source,
      "--task", "noop",
      "--provider", "http",
      "--model", "mock",
      "--endpoint", "http://127.0.0.1:9",
      "--max-steps", "2",
    ], { maxBuffer: 5_000_000, env: homeEnvironment(home) }).then(
      () => undefined,
      (error: Error & { stderr?: string }) => error,
    );
    assert.notEqual(result, undefined, "run must fail before contacting the provider");
    assert.match(String(result?.stderr ?? result?.message), /Hook 'gate' failed under fail-closed policy/u);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("configured MCP server tools are live and callable by the model", async () => {
  const source = await repairableProject();
  const serverScript = `
import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (message.method === 'tools/list') result = { tools: [
    { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }
  ] };
  else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'mcp says: ' + message.params.arguments.text }] };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`;
  await writeFile(path.join(source, "mcp-fixture.mjs"), serverScript, "utf8");
  const home = await userHomeWithConfig({
    version: 1,
    permissions: { effects: ["observe", "review", "state", "execute", "mutate"], customTools: [], mcpServers: ["fixture"], hooks: [], commands: ["node"] },
    mcp: [{
      name: "fixture",
      command: "node",
      args: ["mcp-fixture.mjs"],
      cwd: ".",
      tools: ["echo"],
      timeoutMs: 30_000,
      maxFrameBytes: 65_536,
    }],
  });

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body) as { transcript: Array<{ role: string; content: unknown }> };
      const decisions = payload.transcript.filter((entry) => entry.role === "decision").length;
      const observation = [...payload.transcript].reverse().find((entry) => entry.role === "observation")?.content as {
        output?: { sha256?: string };
      } | undefined;
      const decision = decisions === 0
        ? { kind: "tool", call: { id: "mcp", name: "mcp_fixture.echo", input: { text: "hello" } } }
        : decisions === 1
          ? { kind: "tool", call: { id: "read", name: "read_file", input: { path: "answer.mjs" } } }
          : decisions === 2
            ? {
                kind: "tool",
                call: {
                  id: "edit",
                  name: "edit_file",
                  input: { path: "answer.mjs", expectedSha256: observation?.output?.sha256, before: "41", after: "42" },
                },
              }
            : decisions === 3
              ? { kind: "tool", call: { id: "test", name: "run_command", input: { command: "node", args: ["test.mjs"] } } }
              : decisions === 4
                ? { kind: "tool", call: { id: "review", name: "review_changes", input: {} } }
                : { kind: "complete", answer: "Fixed with MCP assistance." };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(decision));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  let isolatedRoot: string | undefined;
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Mock server failed to bind.");
    const { stdout, stderr } = await executeFile(process.execPath, [
      cli, "run",
      "--workspace", source,
      "--task", "Repair the project; you may use the MCP echo tool.",
      "--provider", "http",
      "--model", "mock",
      "--endpoint", `http://127.0.0.1:${address.port}`,
      "--max-steps", "12",
      "--protect", "package.json",
    ], { maxBuffer: 5_000_000, env: { ...homeEnvironment(home), VANGUARD_EVENT_STREAM: "1" } });
    const scorecard = JSON.parse(stdout) as { outcome: { status: string }; workspaceRoot: string };
    isolatedRoot = path.dirname(scorecard.workspaceRoot);
    assert.equal(scorecard.outcome.status, "completed");
    assert.match(stderr, /@@VANGUARD_EVENT@@.*mcp_fixture\.echo/u);
    const journal = await readFile(path.join(isolatedRoot, "run.jsonl"), "utf8");
    assert.match(journal, /mcp says: hello/u);
    assert.match(journal, /"tool":"mcp_fixture\.echo","ok":true/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
    if (isolatedRoot !== undefined) await rm(isolatedRoot, { recursive: true, force: true });
  }
});

test("workspace skills are advertised to contracted runs", async () => {
  const source = await repairableProject();
  await mkdir(path.join(source, ".vanguard", "skills", "demo"), { recursive: true });
  await writeFile(
    path.join(source, ".vanguard", "skills", "demo", "SKILL.md"),
    "---\nname: demo-skill\ndescription: Explains how to repair answers.\n---\n\nAlways set the answer to 42.\n",
  );
  const home = await userHomeWithConfig({
    version: 1,
    permissions: { effects: ["observe", "review", "state"], customTools: [], mcpServers: [], hooks: [], commands: [] },
  });

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body) as { task: string; transcript: Array<{ role: string; content: unknown }> };
      const decisions = payload.transcript.filter((entry) => entry.role === "decision").length;
      const observation = [...payload.transcript].reverse().find((entry) => entry.role === "observation")?.content as {
        output?: { sha256?: string };
      } | undefined;
      const decision = decisions === 0
        ? { kind: "tool", call: { id: "read", name: "read_file", input: { path: "answer.mjs" } } }
        : decisions === 1
          ? {
              kind: "tool",
              call: {
                id: "edit",
                name: "edit_file",
                input: { path: "answer.mjs", expectedSha256: observation?.output?.sha256, before: "41", after: "42" },
              },
            }
          : decisions === 2
            ? { kind: "tool", call: { id: "test", name: "run_command", input: { command: "node", args: ["test.mjs"] } } }
            : decisions === 3
              ? { kind: "tool", call: { id: "review", name: "review_changes", input: {} } }
              : { kind: "complete", answer: "Applied the demo skill." };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(decision));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  let isolatedRoot: string | undefined;
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Mock server failed to bind.");
    const { stdout } = await executeFile(process.execPath, [
      cli, "run",
      "--workspace", source,
      "--task", "Inspect the project.",
      "--provider", "http",
      "--model", "mock",
      "--endpoint", `http://127.0.0.1:${address.port}`,
      "--max-steps", "10",
    ], { maxBuffer: 5_000_000, env: homeEnvironment(home) });
    const scorecard = JSON.parse(stdout) as { outcome: { status: string }; workspaceRoot: string };
    isolatedRoot = path.dirname(scorecard.workspaceRoot);
    assert.equal(scorecard.outcome.status, "completed");
    const journal = await readFile(path.join(isolatedRoot, "run.jsonl"), "utf8");
    assert.match(journal, /Available workspace skills/u);
    assert.match(journal, /Skill: demo-skill — Explains how to repair answers\./u);
    assert.match(journal, /Always set the answer to 42\./u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
    if (isolatedRoot !== undefined) await rm(isolatedRoot, { recursive: true, force: true });
  }
});
