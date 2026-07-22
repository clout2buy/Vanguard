import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AgentKernel,
  CommandVerifier,
  HttpModelAdapter,
  InferenceError,
  MemoryJournal,
  ProcessTool,
  ReadFileTool,
  ReplaceTextTool,
  WorkspaceBoundary,
} from "../src/index.js";

interface WireEntry {
  readonly role: string;
  readonly content: unknown;
}

test("native HTTP agent inspects, patches, tests, and earns verification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-e2e-"));
  await writeFile(path.join(root, "answer.mjs"), "export const answer = () => 41;\n");
  await writeFile(
    path.join(root, "test.mjs"),
    "import { answer } from './answer.mjs'; if (answer() !== 42) process.exit(1);\n",
  );
  let receivedToolSchemas = false;
  let inferenceRequests = 0;
  const observedDecisionCounts: number[] = [];

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      inferenceRequests += 1;
      if (inferenceRequests === 1) {
        response.writeHead(503, { "content-type": "text/plain", "retry-after": "0" });
        response.end("temporary outage");
        return;
      }
      const payload = JSON.parse(body) as {
        transcript: WireEntry[];
        tools: Array<{ name: string }>;
      };
      receivedToolSchemas ||= payload.tools.some((tool) => tool.name === "edit_file");
      const decisions = payload.transcript.filter((entry) => entry.role === "decision").length;
      observedDecisionCounts.push(decisions);
      let decision: unknown;
      if (decisions === 0) {
        decision = { kind: "tool", call: { id: "read", name: "read_file", input: { path: "answer.mjs" } } };
      } else if (decisions === 1) {
        const observation = lastObservation(payload.transcript) as { output?: { sha256?: string } } | undefined;
        decision = {
          kind: "tool",
          call: {
            id: "patch",
            name: "edit_file",
            input: {
              path: "answer.mjs",
              expectedSha256: observation?.output?.sha256,
              before: "41",
              after: "42",
            },
          },
        };
      } else if (decisions === 2) {
        decision = {
          kind: "tool",
          call: { id: "test", name: "run_command", input: { command: process.execPath, args: ["test.mjs"] } },
        };
      } else {
        decision = { kind: "complete", answer: "Corrected answer.mjs and verified test.mjs." };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(decision));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Test server did not bind.");
    const workspace = new WorkspaceBoundary(root);
    const processTool = new ProcessTool(workspace, { allowedCommands: [process.execPath] });
    const kernel = new AgentKernel({
      model: new HttpModelAdapter({ endpoint: `http://127.0.0.1:${address.port}`, retryBaseMs: 1 }),
      tools: [new ReadFileTool(workspace), new ReplaceTextTool(workspace), processTool],
      verifiers: [
        new CommandVerifier("fixture tests", processTool, { command: process.execPath, args: ["test.mjs"] }),
      ],
      journal: new MemoryJournal(),
      options: { maxSteps: 8 },
    });

    const outcome = await kernel.run("Repair answer.mjs so test.mjs passes.");
    assert.equal(outcome.status, "completed", JSON.stringify({ outcome, inferenceRequests, observedDecisionCounts }));
    assert.equal(receivedToolSchemas, true);
    assert.equal(inferenceRequests >= 5, true);
    assert.match(await readFile(path.join(root, "answer.mjs"), "utf8"), /42/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("an oversized irreducible task is projected instead of failing context selection", async () => {
  let modelCalls = 0;
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: {
      async decide() {
        modelCalls += 1;
        return { kind: "complete" as const, answer: "projected safely" };
      },
    },
    tools: [],
    verifiers: [],
    journal,
    options: { maxSteps: 2, maxContextBytes: 500 },
  });

  const outcome = await kernel.run(`oversized-task:${"x".repeat(2_000)}`);
  assert.equal(outcome.status, "completed");
  assert.equal(modelCalls, 1);
  assert.equal(journal.events.some((event) => event.type === "context.compacted"
    && typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
    && event.data.operation === "overflow_delegation"), true);
});

test("a fresh tool result larger than the main window is delegated in bounded chunks", async () => {
  let mainCalls = 0;
  let delegateCalls = 0;
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: {
      async decide(request) {
        if (request.task.includes("context-overflow delegate")) {
          delegateCalls += 1;
          return { kind: "respond" as const, message: "The read succeeded; inspect src/huge.ts in smaller ranges." };
        }
        mainCalls += 1;
        return mainCalls === 1
          ? { kind: "tools" as const, calls: [{ id: "huge", name: "workspace.huge", input: null }] }
          : { kind: "complete" as const, answer: "Handled the delegated evidence." };
      },
    },
    tools: [{
      name: "workspace.huge",
      definition: {
        name: "workspace.huge",
        description: "Return a deliberately oversized observation.",
        inputSchema: { type: "null" },
        effect: "observe" as const,
      },
      async execute() {
        return { ok: true, output: { path: "src/huge.ts", contents: `EVIDENCE:${"x".repeat(30_000)}` } };
      },
    }],
    verifiers: [],
    journal,
    options: { maxSteps: 4, maxContextBytes: 10_000 },
  });

  const outcome = await kernel.run("Inspect the oversized evidence and finish.");
  assert.equal(outcome.status, "completed", outcome.status === "failed" ? outcome.reason : undefined);
  assert.equal(mainCalls, 2);
  assert.equal(delegateCalls > 1, true, "the source should be split across isolated delegate calls");
  const delegation = journal.events.find((event) => event.type === "context.compacted"
    && typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
    && event.data.operation === "overflow_delegation");
  assert.ok(delegation !== undefined);
  assert.equal(typeof delegation.data === "object" && delegation.data !== null && !Array.isArray(delegation.data)
    ? Number(delegation.data.chunks) > 1 : false, true);
});

test("a provider context rejection teaches the kernel a smaller effective window and retries", async () => {
  let mainCalls = 0;
  let delegateCalls = 0;
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: {
      async decide(request) {
        if (request.task.includes("context-overflow delegate")) {
          delegateCalls += 1;
          return { kind: "respond" as const, message: "Keep the exact objective and finish." };
        }
        mainCalls += 1;
        if (mainCalls === 1) {
          throw new InferenceError("context_length", "maximum context length exceeded", 413, false);
        }
        return { kind: "complete" as const, answer: "Adapted to the discovered provider window." };
      },
    },
    tools: [],
    verifiers: [],
    journal,
    options: { maxSteps: 2, maxContextBytes: 20_000 },
  });

  const outcome = await kernel.run("Complete after adapting the provider window.");
  assert.equal(outcome.status, "completed", outcome.status === "failed" ? outcome.reason : undefined);
  assert.equal(mainCalls, 2);
  assert.equal(delegateCalls, 1);
  assert.equal(journal.events.some((event) => event.type === "context.compacted"
    && typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
    && event.data.operation === "provider_window_adaptation"), true);
});

test("oversized dynamic working state fails before inference and is snapshotted once", async () => {
  let modelCalls = 0;
  let snapshotCalls = 0;
  const snapshot = { summary: "x".repeat(2_000) };
  const kernel = new AgentKernel({
    model: {
      async decide() {
        modelCalls += 1;
        return { kind: "respond" as const, message: "must not be called" };
      },
    },
    tools: [],
    verifiers: [],
    journal: new MemoryJournal(),
    workingState: {
      snapshot() {
        snapshotCalls += 1;
        return snapshot;
      },
    },
    // A third-party policy may ignore the reserved tail; the kernel's sealed
    // post-check must still prevent an oversized provider request.
    contextPolicy: { select: () => [] },
    options: { maxSteps: 2, maxContextBytes: 500 },
  });

  const outcome = await kernel.run("small task");
  assert.equal(outcome.status, "failed");
  assert.equal(modelCalls, 0);
  assert.equal(snapshotCalls, 1);
  assert.match(outcome.status === "failed" ? outcome.reason : "", /Context failure/);
});

function lastObservation(transcript: readonly WireEntry[]): unknown {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === "observation") return transcript[index]?.content;
  }
  return undefined;
}
