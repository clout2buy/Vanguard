import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const evaluator = path.join(root, "scripts", "gauntlet-evaluator.mjs");
const sealedExtensions = {
  config: {
    version: 1,
    permissions: {
      effects: ["observe", "review", "state"],
      customTools: [], mcpServers: [], hooks: [], commandCount: 0,
    },
    skills: {
      roots: [".vanguard/skills"], maxFiles: 32, maxFileBytes: 128 * 1024, maxTotalBytes: 512 * 1024,
    },
    tools: [], mcp: [], hooks: [],
  },
  provenance: [],
  instructionBytes: 0,
};

test("independent gauntlet evaluator accepts only a bound, in-scope, freshly graded result", async () => {
  const fixture = await createFixture({ candidateValue: 42 });
  try {
    const result = evaluate(fixture.request);
    assert.equal(result.verified, true);
    assert.equal(result.classification, "verified");
    assert.equal(result.evaluator.bindingPassed, true);
    assert.equal(result.evaluator.integrityPassed, true);
    assert.equal(result.evaluator.graderPassed, true);
    assert.equal(result.canaryDenominatorEligible, true);
    assert.equal(result.contextProjections, 7, "nondestructive request projections must survive independent evaluation");
    assert.equal("capabilityEligible" in result, false);
    assert.deepEqual(result.evaluator.changedPaths, ["src/answer.mjs"]);
    assert.match(result.evaluator.workspaceManifestSha256, /^[a-f0-9]{64}$/u);
    assert.match(result.evaluator.journalTipSha256, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a self-reported pass is rejected when the independent sealed grader fails", async () => {
  const fixture = await createFixture({ candidateValue: 41 });
  try {
    const result = evaluate(fixture.request);
    assert.equal(result.verified, false);
    assert.equal(result.classification, "capability_failure");
    assert.equal(result.canaryDenominatorEligible, true);
    assert.equal(result.evaluator.bindingPassed, true);
    assert.equal(result.evaluator.integrityPassed, true);
    assert.equal(result.evaluator.graderPassed, false);
    assert.ok(result.evaluator.violations.some((entry: string) => /sealed grader exited/u.test(entry)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a self-reported pass is rejected when a protected file changed", async () => {
  const fixture = await createFixture({ candidateValue: 42, mutateProtected: true });
  try {
    const result = evaluate(fixture.request);
    assert.equal(result.verified, false);
    assert.equal(result.classification, "capability_failure");
    assert.equal(result.evaluator.graderPassed, true);
    assert.equal(result.evaluator.integrityPassed, false);
    assert.ok(result.evaluator.violations.some((entry: string) => /out-of-scope workspace change: package\.json/u.test(entry)));
    assert.ok(result.evaluator.violations.some((entry: string) => /protected workspace change: package\.json/u.test(entry)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("forged patch metrics cannot pass even when stdout and the scorecard agree", async () => {
  const fixture = await createFixture({ candidateValue: 42 });
  try {
    const stdout = JSON.parse(await readFile(fixture.request.candidateOutputFile, "utf8"));
    const scorecardFile = stdout.scorecardFile as string;
    const scorecard = JSON.parse(await readFile(scorecardFile, "utf8"));
    scorecard.patch.afterBytes += 1;
    stdout.patch.afterBytes += 1;
    await writeFile(scorecardFile, JSON.stringify(scorecard, null, 2), "utf8");
    await writeFile(fixture.request.candidateOutputFile, `${JSON.stringify(stdout, null, 2)}\n`, "utf8");

    const result = evaluate(fixture.request);
    assert.equal(result.verified, false);
    assert.equal(result.classification, "capability_failure");
    assert.equal(result.evaluator.bindingPassed, true);
    assert.equal(result.evaluator.integrityPassed, true);
    assert.equal(result.evaluator.graderPassed, true);
    assert.ok(result.evaluator.violations.some((entry: string) => /patch metrics do not match/u.test(entry)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("malformed engine stdout is an evaluated engine failure, not an excluded infrastructure error", async () => {
  const fixture = await createFixture({ candidateValue: 42 });
  try {
    await writeFile(fixture.request.candidateOutputFile, "not-json\n", "utf8");
    const result = evaluate(fixture.request);
    assert.equal(result.verified, false);
    assert.equal(result.classification, "engine_error");
    assert.equal(result.canaryDenominatorEligible, true);
    assert.equal(result.score, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an engine cannot exclude an internal failure by relabeling it as infrastructure", async () => {
  const fixture = await createFixture({ candidateValue: 42 });
  try {
    const stdout = JSON.parse(await readFile(fixture.request.candidateOutputFile, "utf8"));
    const scorecardFile = stdout.scorecardFile as string;
    const scorecard = JSON.parse(await readFile(scorecardFile, "utf8"));
    const reason = "Internal parser exploded";
    scorecard.outcome = { status: "failed", reason, steps: 1 };
    scorecard.grade = {
      ...scorecard.grade,
      verified: false,
      classification: "infrastructure_error",
      score: null,
      executionQuality: { ...scorecard.grade.executionQuality, score: 0 },
    };
    stdout.outcome = scorecard.outcome;
    stdout.grade = scorecard.grade;
    await writeFile(scorecard.journalFile, projectedJournal("run.failed", { step: 1, reason }), "utf8");
    await writeFile(scorecardFile, JSON.stringify(scorecard, null, 2), "utf8");
    await writeFile(fixture.request.candidateOutputFile, `${JSON.stringify(stdout, null, 2)}\n`, "utf8");
    fixture.request.engineExitCode = 1;

    const result = evaluate(fixture.request);
    assert.equal(result.verified, false);
    assert.equal(result.classification, "engine_error");
    assert.equal(result.canaryDenominatorEligible, true);
    assert.equal(result.score, 0);
    assert.ok(result.evaluator.violations.some((entry: string) => /failed scorecard is inconsistent/u.test(entry)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a canonically bound provider failure is diagnostic infrastructure but still scores zero", async () => {
  const fixture = await createFixture({ candidateValue: 42 });
  try {
    const stdout = JSON.parse(await readFile(fixture.request.candidateOutputFile, "utf8"));
    const scorecardFile = stdout.scorecardFile as string;
    const scorecard = JSON.parse(await readFile(scorecardFile, "utf8"));
    const reason = "Model failure: Inference endpoint returned HTTP 503";
    scorecard.outcome = { status: "failed", reason, steps: 1 };
    scorecard.grade = {
      ...scorecard.grade,
      verified: false,
      classification: "infrastructure_error",
      score: null,
      executionQuality: { ...scorecard.grade.executionQuality, score: 0 },
    };
    stdout.outcome = scorecard.outcome;
    stdout.grade = scorecard.grade;
    await writeFile(scorecard.journalFile, projectedJournal("run.failed", { step: 1, reason }), "utf8");
    await writeFile(scorecardFile, JSON.stringify(scorecard, null, 2), "utf8");
    await writeFile(fixture.request.candidateOutputFile, `${JSON.stringify(stdout, null, 2)}\n`, "utf8");
    fixture.request.engineExitCode = 1;

    const result = evaluate(fixture.request);
    assert.equal(result.verified, false);
    assert.equal(result.classification, "infrastructure_error");
    assert.equal(result.canaryDenominatorEligible, false);
    assert.equal(result.score, 0);
    assert.equal(result.evaluator.bindingPassed, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("independent evaluator derives projection telemetry from the validated journal", async () => {
  const fixture = await createFixture({ candidateValue: 42 });
  try {
    const stdout = JSON.parse(await readFile(fixture.request.candidateOutputFile, "utf8"));
    const scorecardFile = stdout.scorecardFile as string;
    const scorecard = JSON.parse(await readFile(scorecardFile, "utf8"));
    scorecard.trajectory.contextProjections = 99;
    stdout.trajectory.contextProjections = 99;
    await writeFile(scorecardFile, JSON.stringify(scorecard, null, 2), "utf8");
    await writeFile(fixture.request.candidateOutputFile, `${JSON.stringify(stdout, null, 2)}\n`, "utf8");

    const result = evaluate(fixture.request);
    assert.equal(result.verified, false);
    assert.equal(result.contextProjections, 7, "reported output must use the hash-validated journal count");
    assert.ok(result.evaluator.violations.some((entry: string) => /contextProjections.*validated journal/u.test(entry)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("independent evaluator recomputes execution quality from journaled failures and claims", async () => {
  const fixture = await createFixture({ candidateValue: 42 });
  try {
    const stdout = JSON.parse(await readFile(fixture.request.candidateOutputFile, "utf8"));
    const scorecardFile = stdout.scorecardFile as string;
    const scorecard = JSON.parse(await readFile(scorecardFile, "utf8"));
    scorecard.grade.executionQuality.score = 0.5;
    stdout.grade.executionQuality.score = 0.5;
    await writeFile(scorecardFile, JSON.stringify(scorecard, null, 2), "utf8");
    await writeFile(fixture.request.candidateOutputFile, `${JSON.stringify(stdout, null, 2)}\n`, "utf8");

    const result = evaluate(fixture.request);
    assert.equal(result.verified, false);
    assert.equal(result.executionQuality, 1);
    assert.ok(result.evaluator.violations.some((entry: string) => /execution quality.*validated journal/u.test(entry)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the independent evaluator does not ignore out-of-scope dist output", async () => {
  const fixture = await createFixture({ candidateValue: 42 });
  try {
    const workspace = String(JSON.parse(await readFile(fixture.request.candidateOutputFile, "utf8")).workspaceRoot);
    await mkdir(path.join(workspace, "dist"), { recursive: true });
    await writeFile(path.join(workspace, "dist", "payload.js"), "export const payload = true;\n", "utf8");
    const result = evaluate(fixture.request);
    assert.equal(result.verified, false);
    assert.equal(result.evaluator.integrityPassed, false);
    assert.ok(result.evaluator.violations.some((entry: string) =>
      /out-of-scope workspace change: dist\/payload\.js/u.test(entry)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a harness candidate timeout is scored as an engine failure", async () => {
  const fixture = await createFixture({ candidateValue: 42 });
  try {
    fixture.request.engineExitCode = 124;
    fixture.request.engineTimedOut = true;
    await writeFile(fixture.request.candidateOutputFile, "partial output", "utf8");
    const result = evaluate(fixture.request);
    assert.equal(result.verified, false);
    assert.equal(result.classification, "engine_error");
    assert.equal(result.canaryDenominatorEligible, true);
    assert.equal(result.score, 0);
    assert.equal(result.timedOut, true);
    assert.ok(result.evaluator.violations.some((entry: string) => /wall-clock deadline/u.test(entry)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("case-file transport preserves exact UTF-8 and trailing-newline task text without PowerShell JSON", async () => {
  const fixture = await createFixture({
    candidateValue: 42,
    task: "Repair the résumé cache → keep café keys exact.\nFinish with evidence.\n",
  });
  try {
    const task = fixture.request.task as string;
    assert.equal(task.endsWith("\n"), true);
    const caseFile = path.join(fixture.root, "case.json");
    await writeFile(path.join(fixture.root, "TASK.md"), task, "utf8");
    await writeFile(caseFile, JSON.stringify({
      id: "fixture",
      version: 1,
      track: "repair",
      workspace: "source",
      task: "TASK.md",
      grader: "grader.mjs",
      publicCheck: fixture.request.publicCheck,
      protected: fixture.request.protectedPaths,
      editableRoots: fixture.request.editableRoots,
      maxSteps: fixture.request.maxSteps,
      maxDurationMs: fixture.request.maxDurationMs,
      maxContextBytes: fixture.request.maxContextBytes,
      rawProcess: fixture.request.exposeRawProcess,
    }, null, 2), "utf8");
    const completed = spawnSync(process.execPath, [
      evaluator,
      "--case-file", caseFile,
      "--candidate-output-file", fixture.request.candidateOutputFile,
      "--engine-exit-code", String(fixture.request.engineExitCode),
      "--engine-timed-out", "false",
      "--provider", String(fixture.request.provider),
      "--model", String(fixture.request.model),
    ], { cwd: root, encoding: "utf8", timeout: 20_000 });
    assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
    const result = JSON.parse(completed.stdout);
    assert.equal(result.verified, true);
    assert.equal(result.evaluator.bindingPassed, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("independent evaluator rejects drift in sealed limits and extension defaults", async () => {
  const fixture = await createFixture({ candidateValue: 42 });
  try {
    const stdout = JSON.parse(await readFile(fixture.request.candidateOutputFile, "utf8"));
    const scorecard = JSON.parse(await readFile(stdout.scorecardFile, "utf8"));
    const configuration = JSON.parse(await readFile(scorecard.configurationFile, "utf8"));
    configuration.options.maxContextBytes += 1;
    configuration.options.allowedCommands = ["pwsh"];
    configuration.options.extensions.config.permissions.effects.push("execute");
    await writeFile(scorecard.configurationFile, JSON.stringify(configuration, null, 2), "utf8");

    const result = evaluate(fixture.request);
    assert.equal(result.verified, false);
    assert.equal(result.evaluator.bindingPassed, false);
    assert.ok(result.evaluator.violations.some((entry: string) => /run configuration does not bind/u.test(entry)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("independent evaluator rejects unknown run configuration fields", async () => {
  const fixture = await createFixture({ candidateValue: 42 });
  try {
    const stdout = JSON.parse(await readFile(fixture.request.candidateOutputFile, "utf8"));
    const scorecard = JSON.parse(await readFile(stdout.scorecardFile, "utf8"));
    const configuration = JSON.parse(await readFile(scorecard.configurationFile, "utf8"));
    configuration.options.futureBehaviorOverride = true;
    await writeFile(scorecard.configurationFile, JSON.stringify(configuration, null, 2), "utf8");
    const result = evaluate(fixture.request);
    assert.equal(result.verified, false);
    assert.equal(result.evaluator.bindingPassed, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("case preflight separates sealed files while hermetic workspace extension sources remain inert", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "vanguard-case-preflight-"));
  try {
    const workspace = path.join(temporary, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(temporary, "TASK.md"), "task\n", "utf8");
    await writeFile(path.join(temporary, "grader.mjs"), "process.exit(0);\n", "utf8");
    const caseFile = path.join(temporary, "case.json");
    const definition = {
      id: "preflight", version: 1, track: "repair", workspace: "workspace", task: "TASK.md", grader: "grader.mjs",
      publicCheck: { command: "node", args: ["check.mjs"] }, protected: [], editableRoots: ["src"], maxSteps: 4,
    };
    await writeFile(caseFile, JSON.stringify(definition), "utf8");
    assert.equal(preflight(caseFile).status, 0);

    await writeFile(path.join(workspace, "AGENTS.md"), "injected", "utf8");
    assert.equal(preflight(caseFile).status, 0);
    await rm(path.join(workspace, "AGENTS.md"));

    await mkdir(path.join(workspace, ".vanguard"));
    assert.equal(preflight(caseFile).status, 0);
    await rm(path.join(workspace, ".vanguard"), { recursive: true });

    await writeFile(path.join(workspace, "TASK.md"), "hidden task", "utf8");
    await writeFile(caseFile, JSON.stringify({ ...definition, task: "workspace/TASK.md" }), "utf8");
    const separated = preflight(caseFile);
    assert.equal(separated.status, 2);
    assert.match(separated.stderr, /must be outside the source workspace/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

interface FixtureOptions {
  readonly candidateValue: number;
  readonly mutateProtected?: boolean;
  readonly task?: string;
}

async function createFixture(options: FixtureOptions): Promise<{
  readonly root: string;
  readonly request: Record<string, unknown> & {
    readonly candidateOutputFile: string;
    engineExitCode: number;
  };
}> {
  const temporary = await mkdtemp(path.join(tmpdir(), "vanguard-external-evaluator-"));
  const source = path.join(temporary, "source");
  const sessionRoot = path.join(temporary, "vanguard-session-fixture");
  const workspace = path.join(sessionRoot, "workspace");
  await mkdir(path.join(source, "src"), { recursive: true });
  await mkdir(path.join(source, "tools"), { recursive: true });
  await writeFile(path.join(source, "package.json"), "{\"private\":true}\n", "utf8");
  await writeFile(path.join(source, "src", "answer.mjs"), "export default 0;\n", "utf8");
  await writeFile(path.join(source, "tools", "check.mjs"), "// trusted public check\n", "utf8");
  await cp(source, workspace, { recursive: true });
  await writeFile(path.join(workspace, "src", "answer.mjs"), `export default ${options.candidateValue};\n`, "utf8");
  if (options.mutateProtected === true) {
    await writeFile(path.join(workspace, "package.json"), "{\"private\":false}\n", "utf8");
  }

  const grader = path.join(temporary, "grader.mjs");
  await writeFile(grader, [
    'import assert from "node:assert/strict";',
    'import { readFile } from "node:fs/promises";',
    'import path from "node:path";',
    'const workspace = path.resolve(process.argv[2]);',
    'assert.match(await readFile(path.join(workspace, "src", "answer.mjs"), "utf8"), /default 42/);',
    'console.log("sealed fixture passed");',
  ].join("\n"), "utf8");

  const canonicalSource = await realpath(source);
  const canonicalWorkspace = await realpath(workspace);
  const id = path.basename(sessionRoot);
  const task = options.task ?? "Make the answer exactly 42.\n";
  const provider = "deepseek";
  const model = "deepseek-v4-pro";
  const maxSteps = 8;
  const publicCheck = { command: "node", args: ["tools/check.mjs"] };
  const protectedPaths = ["package.json", "tools/check.mjs"];
  const editableRoots = ["src/answer.mjs"];
  const verification = { command: "node", args: [grader, "."] };
  const sessionFile = path.join(sessionRoot, "session.json");
  const journalFile = path.join(sessionRoot, "run.jsonl");
  const configurationFile = path.join(sessionRoot, "run-config.json");
  const scorecardFile = path.join(sessionRoot, "scorecard.json");
  await writeFile(sessionFile, JSON.stringify({
    id,
    sourceRoot: canonicalSource,
    workspaceRoot: canonicalWorkspace,
    materialized: true,
    createdAt: new Date().toISOString(),
  }, null, 2), "utf8");
  await writeFile(configurationFile, JSON.stringify({
    version: 1,
    options: {
      workspace: canonicalSource,
      task,
      provider,
      model,
      verification,
      allowedCommands: [],
      publicCheck,
      protectedPaths,
      editableRoots,
      securityProfile: "guarded",
      restrictProcess: true,
      exposeRawProcess: false,
      disableExtensions: true,
      verifierEvidence: "summary",
      maxSteps,
      maxDurationMs: 600_000,
      commandTimeoutMs: 1_800_000,
      maxContextBytes: 2_000_000,
      maxFailedVerificationAttempts: 3,
      extensions: sealedExtensions,
    },
  }, null, 2), "utf8");
  await writeFile(journalFile, projectedJournal("run.completed", { step: 1, answer: "done" }), "utf8");

  const patch = await patchMetrics(canonicalSource, canonicalWorkspace);
  const scorecard = {
    version: 3,
    sessionId: id,
    sourceRoot: canonicalSource,
    workspaceRoot: canonicalWorkspace,
    provider,
    model,
    task,
    verification,
    outcome: { status: "completed", answer: "done", steps: 1 },
    trajectory: {
      toolFailures: 0,
      localTestFailures: 0,
      testHarnessFailures: 0,
      toolFrictionFailures: 0,
      verificationFailures: 0,
      completionClaims: 1,
      policyBlocks: 0,
      contextCompactions: 0,
      contextProjections: 7,
    },
    patch,
    grade: {
      verified: true,
      classification: "verified",
      score: 1,
      executionQuality: { score: 1 },
      steps: 1,
    },
    durationMs: 50,
    journalFile,
    completedAt: new Date().toISOString(),
    resumed: false,
    sessionFile,
    configurationFile,
  };
  await writeFile(scorecardFile, JSON.stringify(scorecard, null, 2), "utf8");
  const candidateOutputFile = path.join(temporary, "candidate-output.json");
  await writeFile(candidateOutputFile, `${JSON.stringify({ ...scorecard, scorecardFile }, null, 2)}\n`, "utf8");
  return {
    root: temporary,
    request: {
      caseId: "fixture",
      caseVersion: 1,
      track: "repair",
      candidateOutputFile,
      engineExitCode: 0,
      engineTimedOut: false,
      sourceWorkspace: canonicalSource,
      grader,
      provider,
      model,
      task,
      maxSteps,
      maxDurationMs: 600_000,
      commandTimeoutMs: 1_800_000,
      maxContextBytes: 2_000_000,
      maxFailedVerificationAttempts: 3,
      exposeRawProcess: false,
      disableExtensions: true,
      graderTimeoutMs: 10_000,
      editableRoots,
      protectedPaths,
      publicCheck,
    },
  };
}

function evaluate(request: Record<string, unknown>): any {
  const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  const completed = spawnSync(process.execPath, [evaluator, "--request-base64", payload], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
  return JSON.parse(completed.stdout);
}

function projectedJournal(terminalType: "run.completed" | "run.failed", terminalData: Record<string, unknown>): string {
  const events: Array<{ sequence: number; type: string; data: unknown }> = [
    { sequence: 1, type: "run.started", data: { task: "fixture task" } },
    ...Array.from({ length: 7 }, (_unused, index) => ({
      sequence: index + 2,
      type: "context.compacted",
      data: { operation: "request_projection", durableHistoryChanged: false },
    })),
    { sequence: 9, type: "model.decided", data: { kind: "complete", answer: "done" } },
    { sequence: 10, type: terminalType, data: terminalData },
  ];
  let previousHash = "0".repeat(64);
  return events.map((event) => {
    const hash = createHash("sha256").update(previousHash).update("\n").update(JSON.stringify(event)).digest("hex");
    const line = JSON.stringify({ previousHash, hash, event });
    previousHash = hash;
    return line;
  }).join("\n") + "\n";
}

function preflight(caseFile: string) {
  return spawnSync(process.execPath, [evaluator, "--preflight-case-file", caseFile], {
    cwd: root, encoding: "utf8", timeout: 10_000,
  });
}

async function patchMetrics(beforeRoot: string, afterRoot: string): Promise<{
  readonly changedFiles: readonly string[];
  readonly filesAdded: number;
  readonly filesDeleted: number;
  readonly filesModified: number;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly beforeLines: number;
  readonly afterLines: number;
}> {
  const [before, after] = await Promise.all([files(beforeRoot), files(afterRoot)]);
  const changedFiles = [...new Set([...before.keys(), ...after.keys()])]
    .filter((name) => !before.get(name)?.equals(after.get(name) ?? Buffer.alloc(0)) || !after.has(name))
    .sort();
  let filesAdded = 0; let filesDeleted = 0; let filesModified = 0;
  let beforeBytes = 0; let afterBytes = 0; let beforeLines = 0; let afterLines = 0;
  for (const name of changedFiles) {
    const oldValue = before.get(name); const newValue = after.get(name);
    if (oldValue === undefined) filesAdded += 1;
    else if (newValue === undefined) filesDeleted += 1;
    else filesModified += 1;
    beforeBytes += oldValue?.length ?? 0; afterBytes += newValue?.length ?? 0;
    beforeLines += lines(oldValue); afterLines += lines(newValue);
  }
  return { changedFiles, filesAdded, filesDeleted, filesModified, beforeBytes, afterBytes, beforeLines, afterLines };
}

async function files(directory: string, prefix = ""): Promise<Map<string, Buffer>> {
  const output = new Map<string, Buffer>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [name, value] of await files(absolute, relative)) output.set(name, value);
    } else if (entry.isFile()) {
      output.set(relative, await readFile(absolute));
    }
  }
  return output;
}

function lines(value: Buffer | undefined): number {
  if (value === undefined || value.includes(0)) return 0;
  const text = value.toString("utf8");
  return text.length === 0 ? 0 : text.split(/\r?\n/u).length;
}
