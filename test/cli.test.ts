import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const executeFile = promisify(execFile);

test("compiled CLI repairs an isolated copy and writes a scorecard", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "vanguard-cli-source-"));
  await writeFile(path.join(source, "answer.mjs"), "export const answer = () => 41;\n");
  await writeFile(path.join(source, "test.mjs"), "import {answer} from './answer.mjs'; if(answer()!==42) process.exit(1);\n");
  await writeFile(path.join(source, "package.json"), JSON.stringify({ scripts: { test: "node test.mjs" } }));

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
        ? { kind: "tool", call: { id: "read", name: "workspace.read", input: { path: "answer.mjs" } } }
        : decisions === 1
          ? {
              kind: "tool",
              call: {
                id: "edit",
                name: "workspace.replace",
                input: { path: "answer.mjs", expectedSha256: observation?.output?.sha256, before: "41", after: "42" },
              },
            }
          : decisions === 2
            ? { kind: "tool", call: { id: "test", name: "process.run", input: { command: "node", args: ["test.mjs"] } } }
            : { kind: "complete", answer: "Fixed and tested." };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(decision));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  let isolatedRoot: string | undefined;
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Mock server failed to bind.");
    const cli = path.resolve("dist", "src", "cli.js");
    const { stdout } = await executeFile(process.execPath, [
      cli,
      "run",
      "--workspace", source,
      "--task", "Make answer() return 42.",
      "--provider", "http",
      "--model", "mock",
      "--endpoint", `http://127.0.0.1:${address.port}`,
      "--max-steps", "10",
      "--protect", "package.json",
      "--editable-root", "answer.mjs",
      "--restrict-process", "true",
      "--verifier-evidence", "summary",
    ], { maxBuffer: 5_000_000 });
    const scorecard = JSON.parse(stdout) as {
      outcome: { status: string; verification?: unknown[] };
      workspaceRoot: string;
      scorecardFile: string;
    };
    isolatedRoot = path.dirname(scorecard.workspaceRoot);
    assert.equal(scorecard.outcome.status, "completed");
    assert.equal(scorecard.outcome.verification?.length, 2);
    assert.match(await readFile(path.join(scorecard.workspaceRoot, "answer.mjs"), "utf8"), /42/);
    assert.match(await readFile(path.join(source, "answer.mjs"), "utf8"), /41/);
    assert.equal(JSON.parse(await readFile(scorecard.scorecardFile, "utf8")).outcome.status, "completed");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(source, { recursive: true, force: true });
    if (isolatedRoot !== undefined) await rm(isolatedRoot, { recursive: true, force: true });
  }
});
