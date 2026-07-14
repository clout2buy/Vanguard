import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const executeFile = promisify(execFile);

test("compiled CLI reports setup failures without a stack trace", async () => {
  const cli = path.resolve("dist", "src", "cli.js");
  await assert.rejects(
    executeFile(process.execPath, [cli, "run"]),
    (error: unknown) => {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      assert.match(stderr, /^Vanguard failed: .+\r?\n$/);
      assert.doesNotMatch(stderr, /\n\s*at\s/);
      return true;
    },
  );
});

test("compiled CLI repairs an isolated copy and writes a scorecard", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "vanguard-cli-source-"));
  const exactTask = "Preserve \"registered\" and \"started\" while repairing the résumé cache → café…\nFinish with evidence.\n";
  await writeFile(path.join(source, "answer.mjs"), "export const answer = () => 41;\n");
  await writeFile(path.join(source, "test.mjs"), "import {answer} from './answer.mjs'; if(answer()!==42) process.exit(1);\n");
  await writeFile(path.join(source, "package.json"), JSON.stringify({ scripts: { test: "node test.mjs" } }));
  const taskFile = path.join(source, "TASK.md");
  await writeFile(taskFile, exactTask, "utf8");

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
            : decisions === 3
              ? { kind: "tool", call: { id: "review", name: "workspace.changes", input: {} } }
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
    const { stdout, stderr } = await executeFile(process.execPath, [
      cli,
      "run",
      "--workspace", source,
      "--task-file", taskFile,
      "--provider", "http",
      "--model", "mock",
      "--endpoint", `http://127.0.0.1:${address.port}`,
      "--disable-extensions", "true",
      "--max-steps", "10",
      "--protect", "package.json",
      "--editable-root", "answer.mjs",
      "--restrict-process", "true",
      "--verifier-evidence", "summary",
    ], { maxBuffer: 5_000_000, env: { ...process.env, VANGUARD_EVENT_STREAM: "1" } });
    const scorecard = JSON.parse(stdout) as {
      outcome: { status: string; verification?: unknown[] };
      grade: { executionQuality: { score: number; cleanFirstPass: boolean } };
      patch: { changedFiles: string[]; filesModified: number };
      workspaceRoot: string;
      scorecardFile: string;
      configurationFile: string;
      task: string;
      extensions: { config: { version: number }; provenance: unknown[] };
    };
    isolatedRoot = path.dirname(scorecard.workspaceRoot);
    assert.equal(scorecard.outcome.status, "completed");
    assert.equal(scorecard.outcome.verification?.length, 2);
    assert.deepEqual(scorecard.patch.changedFiles, ["answer.mjs"]);
    assert.equal(scorecard.patch.filesModified, 1);
    assert.equal(scorecard.grade.executionQuality.cleanFirstPass, true);
    assert.equal(scorecard.grade.executionQuality.score, 1);
    assert.equal(scorecard.extensions.config.version, 1);
    assert.ok(Array.isArray(scorecard.extensions.provenance));
    assert.equal(scorecard.task, exactTask, "strict task-file text must survive Unicode, quotes, and trailing LF exactly");
    const configuration = JSON.parse(await readFile(scorecard.configurationFile, "utf8")) as {
      options: { task: string; disableExtensions: boolean };
    };
    assert.equal(configuration.options.task, exactTask);
    assert.equal(configuration.options.disableExtensions, true);
    assert.match(await readFile(path.join(scorecard.workspaceRoot, "answer.mjs"), "utf8"), /42/);
    assert.match(await readFile(path.join(source, "answer.mjs"), "utf8"), /41/);
    assert.equal(JSON.parse(await readFile(scorecard.scorecardFile, "utf8")).outcome.status, "completed");
    assert.match(stderr, /@@VANGUARD_EVENT@@.*"type":"session.ready"/);
    assert.match(stderr, /@@VANGUARD_EVENT@@.*"type":"tool.started".*"workspace.read"/);
    assert.match(stderr, /@@VANGUARD_EVENT@@.*"type":"verification.completed"/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(source, { recursive: true, force: true });
    if (isolatedRoot !== undefined) await rm(isolatedRoot, { recursive: true, force: true });
  }
});

test("compiled CLI advance flows from conversation to contracted execution", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "vanguard-cli-advance-source-"));
  await writeFile(path.join(source, "answer.mjs"), "export const answer = () => 41;\n");
  await writeFile(path.join(source, "test.mjs"), "import {answer} from './answer.mjs'; if(answer()!==42) process.exit(1);\n");

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body) as { mode: string; transcript: Array<{ role: string; content: unknown }> };
      const decisions = payload.transcript.filter((entry) => entry.role === "decision").length;
      const observation = [...payload.transcript].reverse().find((entry) => entry.role === "observation")?.content as {
        output?: { sha256?: string };
      } | undefined;
      const decision = payload.mode === "conversation"
        ? decisions === 0
          ? { kind: "respond", message: "Hey. What are we building, fixing, or investigating?" }
          : {
              kind: "execute",
              contract: {
                objective: "Make answer() return 42 with the existing test as proof.",
                successCriteria: ["node test.mjs exits 0"],
              },
            }
        : decisions === 2
          ? { kind: "tools", calls: [{ id: "read", name: "workspace.read", input: { path: "answer.mjs" } }] }
          : decisions === 3
            ? {
                kind: "tools",
                calls: [{
                  id: "edit",
                  name: "workspace.replace",
                  input: { path: "answer.mjs", expectedSha256: observation?.output?.sha256, before: "41", after: "42" },
                }],
              }
            : decisions === 4
              ? { kind: "tools", calls: [{ id: "test", name: "process.run", input: { command: "node", args: ["test.mjs"] } }] }
              : decisions === 5
                ? { kind: "tools", calls: [{ id: "review", name: "workspace.changes", input: {} }] }
                : { kind: "complete", answer: "Fixed and tested." };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(decision));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  let sessionRoot: string | undefined;
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Mock server failed to bind.");
    const cli = path.resolve("dist", "src", "cli.js");
    const creationArgs = [
      cli, "advance",
      "--workspace", source,
      "--message", "hi",
      "--provider", "http",
      "--model", "mock",
      "--endpoint", `http://127.0.0.1:${address.port}`,
      "--verify-command", "node",
      "--verify-arg", "test.mjs",
      "--max-steps", "20",
    ];
    const greeting = await executeFile(process.execPath, creationArgs, { maxBuffer: 5_000_000 });
    const greeted = JSON.parse(greeting.stdout) as {
      outcome: { status: string; message?: string };
      sessionRoot: string;
      workspaceRoot: string;
      journalFile: string;
    };
    sessionRoot = greeted.sessionRoot;
    assert.equal(greeted.outcome.status, "responded");
    assert.match(greeted.outcome.message ?? "", /What are we building/);
    // A greeting must not materialize a workspace copy or a contract.
    await assert.rejects(readFile(path.join(greeted.workspaceRoot, "answer.mjs"), "utf8"));
    const journalAfterGreeting = await readFile(greeted.journalFile, "utf8");
    assert.match(journalAfterGreeting, /"type":"user.message"/);
    assert.doesNotMatch(journalAfterGreeting, /"type":"run.contracted"/);

    const work = await executeFile(process.execPath, [
      cli, "advance",
      "--session", sessionRoot,
      "--message", "Please make answer() return 42 and prove it with the test.",
    ], { maxBuffer: 5_000_000 });
    const scorecard = JSON.parse(work.stdout) as {
      outcome: { status: string };
      workspaceRoot: string;
      journalFile: string;
    };
    assert.equal(scorecard.outcome.status, "completed");
    assert.match(await readFile(path.join(scorecard.workspaceRoot, "answer.mjs"), "utf8"), /42/);
    assert.match(await readFile(path.join(source, "answer.mjs"), "utf8"), /41/);
    const journal = await readFile(scorecard.journalFile, "utf8");
    assert.match(journal, /"type":"run.contracted"/);
    assert.match(journal, /Make answer\(\) return 42/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(source, { recursive: true, force: true });
    if (sessionRoot !== undefined) await rm(sessionRoot, { recursive: true, force: true });
  }
});

test("compiled CLI answers a mid-execution question over the stdin control channel", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "vanguard-cli-steer-source-"));
  await writeFile(path.join(source, "check.mjs"), "console.log('ok');\n");

  const ANSWER = "Proceed with the defaults.";
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body) as { mode: string; transcript: Array<{ role: string; content: unknown }> };
      const answered = JSON.stringify(payload.transcript).includes(ANSWER);
      const decision = payload.mode === "conversation"
        ? {
            kind: "execute",
            contract: { objective: "Run the project checks after confirming settings.", successCriteria: ["check.mjs exits 0"] },
          }
        : answered
          ? { kind: "complete", answer: `Confirmed (“${ANSWER}”) and checks pass.` }
          : { kind: "ask_user", question: "Any special settings before I run the checks?" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(decision));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  let sessionRoot: string | undefined;
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Mock server failed to bind.");
    const cli = path.resolve("dist", "src", "cli.js");
    const child = spawn(process.execPath, [
      cli, "advance",
      "--workspace", source,
      "--message", "Run the checks for me.",
      "--provider", "http",
      "--model", "mock",
      "--endpoint", `http://127.0.0.1:${address.port}`,
      "--verify-command", "node",
      "--verify-arg", "check.mjs",
      "--max-steps", "20",
    ], {
      env: { ...process.env, VANGUARD_EVENT_STREAM: "1", VANGUARD_CONTROL_STREAM: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let answeredOnce = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (!answeredOnce && stderr.includes('"type":"run.waiting_for_user"')) {
        answeredOnce = true;
        child.stdin.write(`${JSON.stringify({ type: "user_message", text: ANSWER })}\n`);
      }
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(answeredOnce, true, "the run must have asked over the event stream");
    assert.equal(exitCode, 0, `advance exited ${exitCode}: ${stderr.slice(-500)}`);
    const scorecard = JSON.parse(stdout) as { outcome: { status: string }; workspaceRoot: string; journalFile: string };
    sessionRoot = path.dirname(scorecard.workspaceRoot);
    assert.equal(scorecard.outcome.status, "completed");
    const journal = await readFile(scorecard.journalFile, "utf8");
    assert.match(journal, /"type":"run.waiting_for_user"/);
    assert.match(journal, new RegExp(`"type":"user.message".*${ANSWER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(source, { recursive: true, force: true });
    if (sessionRoot !== undefined) await rm(sessionRoot, { recursive: true, force: true });
  }
});

test("compiled CLI advance recovers a contracted session whose workspace copy never happened", async () => {
  // Simulates an interruption in the window between journaling run.contracted
  // and materializing the disposable workspace: resume must copy the
  // workspace before building the execution runtime instead of ENOENTing.
  const { FileJournal, createSessionShell } = await import("../src/index.js");
  const source = await mkdtemp(path.join(os.tmpdir(), "vanguard-cli-seam-source-"));
  await writeFile(path.join(source, "answer.mjs"), "export const answer = () => 41;\n");
  await writeFile(path.join(source, "test.mjs"), "import {answer} from './answer.mjs'; if(answer()!==42) process.exit(1);\n");

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
      const decision = decisions === 1
        ? { kind: "tools", calls: [{ id: "read", name: "workspace.read", input: { path: "answer.mjs" } }] }
        : decisions === 2
          ? {
              kind: "tools",
              calls: [{
                id: "edit",
                name: "workspace.replace",
                input: { path: "answer.mjs", expectedSha256: observation?.output?.sha256, before: "41", after: "42" },
              }],
            }
          : decisions === 3
            ? { kind: "tools", calls: [{ id: "test", name: "process.run", input: { command: "node", args: ["test.mjs"] } }] }
            : decisions === 4
              ? { kind: "tools", calls: [{ id: "review", name: "workspace.changes", input: {} }] }
              : { kind: "complete", answer: "Recovered, fixed, and tested." };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(decision));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  let sessionRoot: string | undefined;
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Mock server failed to bind.");
    const session = await createSessionShell(source);
    sessionRoot = path.dirname(session.workspaceRoot);
    const contract = {
      objective: "Make answer() return 42 with the existing test as proof.",
      successCriteria: ["node test.mjs exits 0"],
    };
    const journal = await FileJournal.open(path.join(sessionRoot, "run.jsonl"));
    await journal.append({ sequence: 1, type: "user.message", data: { text: "Please make answer() return 42." } });
    await journal.append({ sequence: 2, type: "model.decided", data: { kind: "execute", contract } });
    await journal.append({ sequence: 3, type: "run.contracted", data: { contract, task: contract.objective } });
    await writeFile(path.join(sessionRoot, "run-config.json"), JSON.stringify({
      version: 1,
      options: {
        workspace: source,
        task: "",
        provider: "http",
        model: "mock",
        endpoint: `http://127.0.0.1:${address.port}`,
        verification: { command: "node", args: ["test.mjs"] },
        allowedCommands: [],
        maxSteps: 20,
        maxDurationMs: 120_000,
        commandTimeoutMs: 60_000,
        maxContextBytes: 2_000_000,
        maxFailedVerificationAttempts: 3,
        protectedPaths: [],
        editableRoots: [],
        restrictProcess: false,
        verifierEvidence: "full",
        exposeRawProcess: true,
      },
    }, null, 2));

    const cli = path.resolve("dist", "src", "cli.js");
    const { stdout } = await executeFile(process.execPath, [cli, "advance", "--session", sessionRoot], {
      maxBuffer: 5_000_000,
    });
    const scorecard = JSON.parse(stdout) as { outcome: { status: string }; workspaceRoot: string };
    assert.equal(scorecard.outcome.status, "completed");
    assert.match(await readFile(path.join(scorecard.workspaceRoot, "answer.mjs"), "utf8"), /42/);
    assert.match(await readFile(path.join(source, "answer.mjs"), "utf8"), /41/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(source, { recursive: true, force: true });
    if (sessionRoot !== undefined) await rm(sessionRoot, { recursive: true, force: true });
  }
});

test("compiled CLI resumes a failed session from its durable journal", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "vanguard-cli-resume-source-"));
  await writeFile(path.join(source, "answer.mjs"), "export const answer = () => 40;\n");
  await writeFile(path.join(source, "test.mjs"), "import {answer} from './answer.mjs'; if(answer()!==42) process.exit(1);\n");
  await writeFile(path.join(source, "package.json"), JSON.stringify({ scripts: { test: "node test.mjs" } }));

  let inferencePaused = true;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body) as { transcript: Array<{ role: string; content: unknown }> };
      const decisions = payload.transcript.filter((entry) => entry.role === "decision").length;
      if (decisions > 0 && inferencePaused) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("intentional test interruption");
        return;
      }
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
                input: { path: "answer.mjs", expectedSha256: observation?.output?.sha256, before: "40", after: "42" },
              },
            }
          : decisions === 2
            ? { kind: "tool", call: { id: "test", name: "process.run", input: { command: "node", args: ["test.mjs"] } } }
            : decisions === 3
              ? { kind: "tool", call: { id: "review", name: "workspace.changes", input: {} } }
              : { kind: "complete", answer: "Resumed, fixed, and tested." };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(decision));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  let sessionRoot: string | undefined;
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Mock server failed to bind.");
    const cli = path.resolve("dist", "src", "cli.js");
    let failedStdout = "";
    try {
      await executeFile(process.execPath, [
        cli, "run",
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
      assert.fail("initial interrupted run should fail");
    } catch (error) {
      failedStdout = String((error as { stdout?: string }).stdout ?? "");
    }
    const failedScorecard = JSON.parse(failedStdout) as { workspaceRoot: string; outcome: { status: string } };
    sessionRoot = path.dirname(failedScorecard.workspaceRoot);
    assert.equal(failedScorecard.outcome.status, "failed");

    inferencePaused = false;
    const { stdout } = await executeFile(process.execPath, [cli, "resume", "--session", sessionRoot], {
      maxBuffer: 5_000_000,
    });
    const resumed = JSON.parse(stdout) as {
      resumed: boolean;
      outcome: { status: string };
      workspaceRoot: string;
      journalFile: string;
    };
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.outcome.status, "completed");
    assert.match(await readFile(path.join(resumed.workspaceRoot, "answer.mjs"), "utf8"), /42/);
    assert.match(await readFile(resumed.journalFile, "utf8"), /"type":"run.resumed"/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(source, { recursive: true, force: true });
    if (sessionRoot !== undefined) await rm(sessionRoot, { recursive: true, force: true });
  }
});
