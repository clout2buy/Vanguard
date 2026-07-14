import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import type {
  JsonValue,
  ModelDecision,
  ModelPort,
  ModelRequest,
  ToolPort,
  VerifierPort,
} from "../src/index.js";
import {
  AgentKernel,
  FixedCommandTool,
  MemoryJournal,
  ProcessTool,
  WorkspaceBoundary,
} from "../src/index.js";

class ScriptedModel implements ModelPort {
  #index = 0;

  constructor(private readonly decisions: readonly ModelDecision[]) {}

  async decide(_request: ModelRequest): Promise<ModelDecision> {
    const decision = this.decisions[this.#index++];
    if (decision === undefined) throw new Error("Script exhausted");
    return decision;
  }
}

const passingVerifier: VerifierPort = {
  name: "tests",
  async verify() {
    return { verifier: "tests", passed: true, evidence: "passed" };
  },
};

test("kernel enforces every tool input schema before invoking its implementation", async () => {
  const received: JsonValue[] = [];
  const tool: ToolPort = {
    name: "fixture.bounded",
    definition: {
      name: "fixture.bounded",
      description: "Exercise the central runtime input-schema boundary.",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string" },
          count: { type: "integer", minimum: 1, maximum: 3 },
        },
        required: ["label", "count"],
        additionalProperties: false,
      },
      effect: "observe",
    },
    async execute(input) {
      received.push(input);
      return { ok: true, output: input };
    },
  };
  const call = (id: string, input: JsonValue): ModelDecision => ({
    kind: "tools",
    calls: [{ id, name: tool.name, input }],
  });
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      call("extra", { label: "ok", count: 2, surprise: true }),
      call("type", { label: "ok", count: "two" }),
      call("minimum", { label: "ok", count: 0 }),
      call("maximum", { label: "ok", count: 4 }),
      call("valid", { label: "ok", count: 3 }),
      { kind: "complete", answer: "done" },
    ]),
    tools: [tool],
    verifiers: [passingVerifier],
    journal,
    options: { maxRepeatedAction: 8 },
  });

  assert.equal((await kernel.run("validate runtime tool inputs")).status, "completed");
  assert.deepEqual(received, [{ label: "ok", count: 3 }], "invalid calls must never reach the tool implementation");

  const failures = journal.events
    .filter((event) => event.type === "tool.failed")
    .map((event) => JSON.stringify(event.data));
  assert.equal(failures.length, 4);
  assert.match(failures[0]!, /surprise.*additional property is not allowed/u);
  assert.match(failures[1]!, /count.*expected integer/u);
  assert.match(failures[2]!, /count.*below minimum/u);
  assert.match(failures[3]!, /count.*above maximum/u);
});

test("public AgentKernel rejects unsupported tool-schema semantics before execution", () => {
  let invoked = false;
  const tool: ToolPort = {
    name: "fixture.unsupported",
    definition: {
      name: "fixture.unsupported",
      description: "Must never run under a schema Vanguard cannot enforce.",
      inputSchema: {
        type: "object",
        anyOf: [
          { properties: { safe: { enum: [true] } } },
          { properties: { fallback: { type: "string" } } },
        ],
      },
      effect: "observe",
    },
    async execute() {
      invoked = true;
      return { ok: true, output: null };
    },
  };

  assert.throws(
    () => new AgentKernel({
      model: new ScriptedModel([]),
      tools: [tool],
      verifiers: [],
      journal: new MemoryJournal(),
    }),
    /unsupported schema keys: anyOf/u,
  );
  assert.equal(invoked, false);
});

test("schema enforcement treats prototype-named inputs as own JSON properties", async () => {
  let invoked = 0;
  const tool: ToolPort = {
    name: "fixture.prototype-safe",
    definition: {
      name: "fixture.prototype-safe",
      description: "Reject undeclared own keys and require own properties.",
      inputSchema: {
        type: "object",
        properties: { allowed: { type: "string" }, constructor: { type: "string" } },
        required: ["allowed", "constructor"],
        additionalProperties: false,
      },
      effect: "observe",
    },
    async execute() {
      invoked += 1;
      return { ok: true, output: null };
    },
  };
  const ownProto = JSON.parse('{"allowed":"ok","constructor":"own","__proto__":{"polluted":true}}') as JsonValue;
  const missingOwnConstructor = { allowed: "ok" } as JsonValue;
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "tools", calls: [{ id: "proto", name: tool.name, input: ownProto }] },
      { kind: "tools", calls: [{ id: "required", name: tool.name, input: missingOwnConstructor }] },
      { kind: "complete", answer: "invalid inputs were contained" },
    ]),
    tools: [tool],
    verifiers: [passingVerifier],
    journal,
  });

  assert.equal((await kernel.run("validate prototype-named JSON keys")).status, "completed");
  assert.equal(invoked, 0);
  const failures = journal.events.filter((event) => event.type === "tool.failed");
  assert.match(JSON.stringify(failures[0]?.data), /__proto__.*additional property/u);
  assert.match(JSON.stringify(failures[1]?.data), /constructor.*required/u);
});

test("fixed commands tolerate provider noise while keeping command and argv runtime-owned", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-fixed-schema-"));
  try {
    const tool = new FixedCommandTool(
      "project.check",
      "Run the runtime-owned check.",
      new ProcessTool(new WorkspaceBoundary(root), { allowedCommands: [process.execPath] }),
      { command: process.execPath, args: ["-e", "process.stdout.write('runtime-owned')"] },
    );
    const journal = new MemoryJournal();
    const kernel = new AgentKernel({
      model: new ScriptedModel([
        {
          kind: "tools",
          calls: [{
            id: "check",
            name: tool.name,
            input: { command: "malicious", args: ["malicious"], summary: "harmless provider narration" },
          }],
        },
        { kind: "complete", answer: "done" },
      ]),
      tools: [tool],
      verifiers: [passingVerifier],
      journal,
    });

    assert.equal((await kernel.run("run the sealed command")).status, "completed");
    const completed = journal.events.find((event) => event.type === "tool.completed");
    assert.match(JSON.stringify(completed?.data), /runtime-owned/u);
    assert.doesNotMatch(JSON.stringify(completed?.data), /malicious/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kernel enforces nullable union types instead of silently skipping type arrays", async () => {
  const received: JsonValue[] = [];
  const tool: ToolPort = {
    name: "fixture.nullable",
    definition: {
      name: "fixture.nullable",
      description: "Accept a string or null, matching built-in guarded-write schemas.",
      inputSchema: {
        type: "object",
        properties: { expectedSha256: { type: ["string", "null"] } },
        required: ["expectedSha256"],
        additionalProperties: false,
      },
      effect: "observe",
    },
    async execute(input) {
      received.push(input);
      return { ok: true, output: input };
    },
  };
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "tools", calls: [{ id: "invalid", name: tool.name, input: { expectedSha256: 42 } }] },
      { kind: "tools", calls: [{ id: "null", name: tool.name, input: { expectedSha256: null } }] },
      { kind: "tools", calls: [{ id: "string", name: tool.name, input: { expectedSha256: "abc" } }] },
      { kind: "complete", answer: "done" },
    ]),
    tools: [tool],
    verifiers: [passingVerifier],
    journal,
  });

  assert.equal((await kernel.run("validate nullable built-in input")).status, "completed");
  assert.deepEqual(received, [{ expectedSha256: null }, { expectedSha256: "abc" }]);
  const failure = journal.events.find((event) => event.type === "tool.failed");
  assert.match(JSON.stringify(failure?.data), /expected string or null/u);
});
