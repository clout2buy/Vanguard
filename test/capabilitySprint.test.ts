import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DelegateRecord, DelegationCoordinator, JsonValue, ModelPort, TaskContract, ToolContext } from "../src/index.js";
import {
  CodeIntelTool,
  CreativeDirectionVerifier,
  DelegateRaceTool,
  RenderableArtifactVerifier,
  WorkspaceBoundary,
  estimateTokens,
  tokenCeilingForBytes,
} from "../src/index.js";

const context: ToolContext = { task: "t", step: 1, signal: new AbortController().signal };

// ── Judge rung ─────────────────────────────────────────────────────────────

function judgeModel(reply: string): ModelPort {
  return { async decide() { return { kind: "respond", message: reply }; } };
}

async function judgeFixture(): Promise<{ root: string; contract: TaskContract }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-judge-"));
  await writeFile(path.join(root, "showcase.html"), "<!doctype html><h1>NEBULA</h1>");
  return {
    root,
    contract: {
      objective: "Build a showcase page",
      successCriteria: ["page renders"],
      deliverables: ["showcase.html"],
      creativeDirection: "a terminal-noir signal lab: acid green on near-black, monospace voice",
    },
  };
}

test("the judge rung fails a completion that betrays the contracted direction", async () => {
  const { root, contract } = await judgeFixture();
  try {
    const renderer = async () => ({ ok: true as const, output: { path: ".vanguard/renders/x.png", image: { mediaType: "image/png", base64: "AAAA" } } });
    const failing = new CreativeDirectionVerifier(
      judgeModel("VERDICT: FAIL — stock purple gradient; nothing terminal-noir about it."),
      new WorkspaceBoundary(root),
      contract,
      renderer,
    );
    const verdict = await failing.verify("candidate", "task");
    assert.equal(verdict.passed, false);
    assert.match(String(verdict.evidence), /stock purple gradient/);

    const passing = new CreativeDirectionVerifier(
      judgeModel("VERDICT: PASS — acid palette and mono voice carried through."),
      new WorkspaceBoundary(root),
      contract,
      renderer,
    );
    assert.equal((await passing.verify("candidate", "task")).passed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the judge rung fails closed when a contracted artifact cannot render", async () => {
  const { root, contract } = await judgeFixture();
  try {
    const workspace = new WorkspaceBoundary(root);
    // A render failure is a broken user-facing deliverable, not missing taste evidence.
    const blind = new CreativeDirectionVerifier(
      judgeModel("VERDICT: FAIL"),
      workspace,
      contract,
      async () => ({ ok: false as const, output: { error: "no browser" } }),
    );
    const blindVerdict = await blind.verify("candidate", "task");
    assert.equal(blindVerdict.passed, false);
    assert.match(String(blindVerdict.evidence), /could not reach a healthy rendered state/);

    // No renderable deliverable at all: pass with an honest note.
    const codeOnly = new CreativeDirectionVerifier(
      judgeModel("VERDICT: FAIL"),
      workspace,
      { ...contract, deliverables: ["src/lib.ts"] },
      async () => ({ ok: true as const, output: {} }),
    );
    await rm(path.join(root, "showcase.html"), { force: true });
    const codeVerdict = await codeOnly.verify("candidate", "task");
    assert.equal(codeVerdict.passed, true);
    assert.match(String(codeVerdict.evidence), /No renderable deliverable/);

    // Judge model down: pass with an honest note, never a taste outage.
    await writeFile(path.join(root, "showcase.html"), "<p>x</p>");
    const outage = new CreativeDirectionVerifier(
      { async decide() { throw new Error("provider down"); } },
      workspace,
      contract,
      async () => ({ ok: true as const, output: { path: "p.png" } }),
    );
    const outageVerdict = await outage.verify("candidate", "task");
    assert.equal(outageVerdict.passed, true);
    assert.match(String(outageVerdict.evidence), /unreachable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the model-independent artifact verifier gates every HTML completion", async () => {
  const { root, contract } = await judgeFixture();
  try {
    const workspace = new WorkspaceBoundary(root);
    const failing = new RenderableArtifactVerifier(
      workspace,
      contract,
      async () => ({ ok: false as const, output: { runtimeFailure: "active loading status" } }),
    );
    const failed = await failing.verify("candidate", "task");
    assert.equal(failed.passed, false);
    assert.match(String(failed.evidence), /active loading status/);

    const passing = new RenderableArtifactVerifier(
      workspace,
      contract,
      async () => ({ ok: true as const, output: { runtimeInspection: "settled DOM" } }),
    );
    assert.equal((await passing.verify("candidate", "task")).passed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── Code intelligence ──────────────────────────────────────────────────────

test("code.intel answers definition and references from the project's own compiler", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-intel-"));
  try {
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "retry.ts"), "export function retryCount(): number {\n  return 3;\n}\n");
    await writeFile(
      path.join(root, "src", "main.ts"),
      "import { retryCount } from \"./retry.js\";\nexport const total = retryCount() + retryCount();\n",
    );
    const tool = new CodeIntelTool(new WorkspaceBoundary(root));

    const definition = await tool.execute({ path: "src/main.ts", line: 2, symbol: "retryCount", query: "definition" }, context);
    assert.equal(definition.ok, true, JSON.stringify(definition.output));
    const definitionResults = (definition.output as { results: Array<{ path: string; line: number }> }).results;
    assert.equal(definitionResults[0]?.path, "src/retry.ts");
    assert.equal(definitionResults[0]?.line, 1);

    const references = await tool.execute({ path: "src/retry.ts", line: 1, symbol: "retryCount", query: "references" }, context);
    assert.equal(references.ok, true);
    const referenceResults = (references.output as { results: Array<{ path: string; line: number }> }).results;
    assert.ok(referenceResults.some((result) => result.path === "src/main.ts" && result.line === 2), JSON.stringify(referenceResults));
    assert.ok(referenceResults.length >= 3, "declaration, import, and both calls");

    const info = await tool.execute({ path: "src/main.ts", line: 2, symbol: "retryCount", query: "info" }, context);
    assert.equal(info.ok, true);
    assert.match(String((info.output as { type: string }).type), /\(\) => number|retryCount\(\): number/u);

    const missing = await tool.execute({ path: "src/main.ts", line: 2, symbol: "nowhere", query: "definition" }, context);
    assert.equal(missing.ok, false);
    assert.match(JSON.stringify(missing.output), /does not occur on line/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("code.intel refuses honestly without a tsconfig", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-intel-none-"));
  try {
    await writeFile(path.join(root, "a.ts"), "export const x = 1;\n");
    const tool = new CodeIntelTool(new WorkspaceBoundary(root), async () => undefined);
    const result = await tool.execute({ path: "a.ts", line: 1, symbol: "x", query: "definition" }, context);
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result.output), /workspace\.search/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── Token estimation ───────────────────────────────────────────────────────

test("token estimation sees symbol-dense content as costlier than prose per byte", () => {
  const prose = "The quiet afternoon settled over the harbor while the fishermen mended their long nets. ";
  const code = "const x={a:1,b:[2,3],c:()=>({d:4})};if(x.a>0){x.b.push(x.c().d);} ";
  const proseTokens = estimateTokens(prose.repeat(20));
  const codeTokens = estimateTokens(code.repeat(20));
  const proseDensity = proseTokens / (prose.length * 20);
  const codeDensity = codeTokens / (code.length * 20);
  assert.ok(codeDensity > proseDensity * 1.5, `code must be denser: ${codeDensity} vs ${proseDensity}`);
  assert.ok(proseDensity < 1 / 2.5, "ordinary prose must sit under the budget ceiling density");
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("hello world") >= 2);
  assert.equal(tokenCeilingForBytes(1_000), 400);
});

// ── Hypothesis racing ──────────────────────────────────────────────────────

function fakeCoordinator(records: Map<string, DelegateRecord>, script: {
  onWait: (id: string) => DelegateRecord;
  cancelled: string[];
}): DelegationCoordinator {
  let started = 0;
  return {
    start: async (request: { task: string }) => {
      started += 1;
      const record = { id: `child-${started}`, task: request.task, scopes: [], maxSteps: 5, state: "running" } as unknown as DelegateRecord;
      records.set(record.id, record);
      return record;
    },
    wait: async (id: string) => script.onWait(id),
    cancel: async (id: string) => {
      script.cancelled.push(id);
      const record = { ...records.get(id)!, state: "cancelled" } as DelegateRecord;
      records.set(id, record);
      return record;
    },
    get: (id: string) => records.get(id)!,
  } as unknown as DelegationCoordinator;
}

test("delegate.race keeps the first completed child and cancels every loser", async () => {
  const records = new Map<string, DelegateRecord>();
  const cancelled: string[] = [];
  let waits = 0;
  const coordinator = fakeCoordinator(records, {
    cancelled,
    onWait: (id) => {
      waits += 1;
      if (id === "child-2" && waits > 2) {
        const winner = { ...records.get(id)!, state: "completed", answer: "hypothesis B landed" } as DelegateRecord;
        records.set(id, winner);
        return winner;
      }
      return records.get(id)!;
    },
  });
  const race = new DelegateRaceTool(coordinator);
  const result = await race.execute({
    variants: ["fix via cache invalidation", "fix via lock ordering"],
    scopes: ["src"],
    maxSteps: 10,
  }, context);
  assert.equal(result.ok, true);
  const output = result.output as { winner: string; answer: string; cancelled: string[] };
  assert.equal(output.winner, "child-2");
  assert.match(output.answer, /hypothesis B/);
  assert.deepEqual(output.cancelled, ["child-1"]);
  assert.deepEqual(cancelled, ["child-1"], "the loser must actually be cancelled");
});

test("delegate.race reports total defeat honestly", async () => {
  const records = new Map<string, DelegateRecord>();
  const cancelled: string[] = [];
  const coordinator = fakeCoordinator(records, {
    cancelled,
    onWait: (id) => {
      const failed = { ...records.get(id)!, state: "failed", answer: "no dice" } as DelegateRecord;
      records.set(id, failed);
      return failed;
    },
  });
  const race = new DelegateRaceTool(coordinator);
  const result = await race.execute({ variants: ["a plan", "b plan"], scopes: ["src"], maxSteps: 5 }, context);
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.output), /Every hypothesis failed/);
});
