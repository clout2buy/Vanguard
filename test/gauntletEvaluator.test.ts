import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const evaluator = path.join(root, "scripts", "gauntlet-evaluator.mjs");

test("independent gauntlet evaluator accepts only a bound, in-scope, freshly graded result", async () => {
  const fixture = await createFixture({ candidateValue: 42 });
  try {
    const result = evaluate(fixture.request);
    assert.equal(result.verified, true);
    assert.equal(result.classification, "verified");
    assert.equal(result.evaluator.bindingPassed, true);
    assert.equal(result.evaluator.integrityPassed, true);
    assert.equal(result.evaluator.graderPassed, true);
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
    assert.equal(result.capabilityEligible, true);
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
    assert.equal(result.capabilityEligible, true);
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
    scorecard.grade = { ...scorecard.grade, verified: false, classification: "infrastructure_error", score: null };
    stdout.outcome = scorecard.outcome;
    stdout.grade = scorecard.grade;
    const event = { sequence: 1, type: "run.failed", data: { step: 1, reason } };
    const previousHash = "0".repeat(64);
    const hash = createHash("sha256").update(previousHash).update("\n").update(JSON.stringify(event)).digest("hex");
    await writeFile(scorecard.journalFile, `${JSON.stringify({ previousHash, hash, event })}\n`, "utf8");
    await writeFile(scorecardFile, JSON.stringify(scorecard, null, 2), "utf8");
    await writeFile(fixture.request.candidateOutputFile, `${JSON.stringify(stdout, null, 2)}\n`, "utf8");
    fixture.request.engineExitCode = 1;

    const result = evaluate(fixture.request);
    assert.equal(result.verified, false);
    assert.equal(result.classification, "engine_error");
    assert.equal(result.capabilityEligible, true);
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
    scorecard.grade = { ...scorecard.grade, verified: false, classification: "infrastructure_error", score: null };
    stdout.outcome = scorecard.outcome;
    stdout.grade = scorecard.grade;
    const event = { sequence: 1, type: "run.failed", data: { step: 1, reason } };
    const previousHash = "0".repeat(64);
    const hash = createHash("sha256").update(previousHash).update("\n").update(JSON.stringify(event)).digest("hex");
    await writeFile(scorecard.journalFile, `${JSON.stringify({ previousHash, hash, event })}\n`, "utf8");
    await writeFile(scorecardFile, JSON.stringify(scorecard, null, 2), "utf8");
    await writeFile(fixture.request.candidateOutputFile, `${JSON.stringify(stdout, null, 2)}\n`, "utf8");
    fixture.request.engineExitCode = 1;

    const result = evaluate(fixture.request);
    assert.equal(result.verified, false);
    assert.equal(result.classification, "infrastructure_error");
    assert.equal(result.capabilityEligible, false);
    assert.equal(result.score, 0);
    assert.equal(result.evaluator.bindingPassed, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

interface FixtureOptions {
  readonly candidateValue: number;
  readonly mutateProtected?: boolean;
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
  const task = "Make the answer exactly 42.\n";
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
      publicCheck,
      protectedPaths,
      editableRoots,
      securityProfile: "guarded",
      restrictProcess: true,
      exposeRawProcess: false,
      verifierEvidence: "summary",
      maxSteps,
    },
  }, null, 2), "utf8");
  const event = { sequence: 1, type: "run.completed", data: { step: 1, answer: "done" } };
  const previousHash = "0".repeat(64);
  const hash = createHash("sha256").update(previousHash).update("\n").update(JSON.stringify(event)).digest("hex");
  await writeFile(journalFile, `${JSON.stringify({ previousHash, hash, event })}\n`, "utf8");

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
      sourceWorkspace: canonicalSource,
      grader,
      provider,
      model,
      task,
      maxSteps,
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
