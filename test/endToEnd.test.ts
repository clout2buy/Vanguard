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
      receivedToolSchemas ||= payload.tools.some((tool) => tool.name === "workspace.replace");
      const decisions = payload.transcript.filter((entry) => entry.role === "decision").length;
      let decision: unknown;
      if (decisions === 0) {
        decision = { kind: "tool", call: { id: "read", name: "workspace.read", input: { path: "answer.mjs" } } };
      } else if (decisions === 1) {
        const observation = lastObservation(payload.transcript) as { output?: { sha256?: string } } | undefined;
        decision = {
          kind: "tool",
          call: {
            id: "patch",
            name: "workspace.replace",
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
          call: { id: "test", name: "process.run", input: { command: process.execPath, args: ["test.mjs"] } },
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
    assert.equal(outcome.status, "completed");
    assert.equal(receivedToolSchemas, true);
    assert.equal(inferenceRequests >= 5, true);
    assert.match(await readFile(path.join(root, "answer.mjs"), "utf8"), /42/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

function lastObservation(transcript: readonly WireEntry[]): unknown {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === "observation") return transcript[index]?.content;
  }
  return undefined;
}
