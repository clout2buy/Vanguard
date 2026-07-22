#!/usr/bin/env node

// Gate Zero's evaluator is deliberately outside the candidate engine. The
// engine may report a scorecard, but only this process decides whether that
// report is bound to a valid journal, an in-scope final tree, and a fresh
// execution of the sealed grader.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const JOURNAL_GENESIS = "0".repeat(64);
const IGNORED_DIRECTORIES = new Set([".git", ".vanguard", "node_modules"]);
const OUTPUT_LIMIT = 20_000;
const DEFAULT_MAX_DURATION_MS = 600_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 1_800_000;
const DEFAULT_MAX_CONTEXT_BYTES = 2_000_000;
const DEFAULT_MAX_VERIFICATION_ATTEMPTS = 3;
const SEALED_DEFAULT_EXTENSIONS = {
  config: {
    version: 1,
    permissions: {
      effects: ["observe", "review", "state"],
      customTools: [],
      mcpServers: [],
      hooks: [],
      commandCount: 0,
    },
    skills: {
      roots: [".vanguard/skills"],
      maxFiles: 32,
      maxFileBytes: 128 * 1024,
      maxTotalBytes: 512 * 1024,
    },
    tools: [],
    mcp: [],
    hooks: [],
  },
  provenance: [],
  instructionBytes: 0,
};
const RUN_CONFIGURATION_KEYS = ["options", "version"];
const RUN_OPTION_KEYS = [
  "allowedCommands", "commandTimeoutMs", "disableExtensions", "editableRoots", "exposeRawProcess",
  "extensions", "maxContextBytes", "maxDurationMs", "maxFailedVerificationAttempts", "maxSteps", "model",
  "protectedPaths", "provider", "publicCheck", "restrictProcess", "securityProfile", "task", "verification",
  "verifierEvidence", "workspace",
];

if (process.argv.includes("--preflight-case-file")) {
  try {
    const material = await readCaseMaterial("--preflight-case-file");
    process.stdout.write(`${JSON.stringify({
      caseFile: material.caseFile,
      sourceWorkspace: material.sourceWorkspace,
      taskFile: material.taskFile,
      grader: material.grader,
    })}\n`);
  } catch (error) {
    process.stderr.write(`Evaluator case preflight is invalid: ${message(error)}\n`);
    process.exit(2);
  }
} else {
  let request;
  try {
    request = process.argv.includes("--case-file")
      ? await requestFromCaseFile()
      : JSON.parse(Buffer.from(argument("--request-base64"), "base64").toString("utf8"));
    validateRequest(request);
  } catch (error) {
    process.stderr.write(`Evaluator request is invalid: ${message(error)}\n`);
    process.exit(2);
  }

  const result = await evaluate(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function requestFromCaseFile() {
  const { definition, sourceWorkspace, taskFile, grader } = await readCaseMaterial("--case-file");
  const engineExitCodeText = argument("--engine-exit-code");
  if (!/^-?\d+$/u.test(engineExitCodeText)) throw new Error("engine exit code is invalid");
  const engineExitCode = Number(engineExitCodeText);
  if (!Number.isSafeInteger(engineExitCode)) throw new Error("engine exit code is invalid");
  const engineTimedOutText = argument("--engine-timed-out");
  if (engineTimedOutText !== "true" && engineTimedOutText !== "false") {
    throw new Error("engine timed-out flag is invalid");
  }
  return {
    caseId: definition.id,
    caseVersion: definition.version ?? 1,
    track: definition.track,
    candidateOutputFile: path.resolve(argument("--candidate-output-file")),
    engineExitCode,
    engineTimedOut: engineTimedOutText === "true",
    sourceWorkspace,
    grader,
    provider: argument("--provider"),
    model: argument("--model"),
    task: await readUtf8Strict(taskFile, "case task"),
    maxSteps: definition.maxSteps,
    maxDurationMs: definition.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
    commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    maxContextBytes: definition.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES,
    maxFailedVerificationAttempts: DEFAULT_MAX_VERIFICATION_ATTEMPTS,
    exposeRawProcess: definition.rawProcess ?? false,
    disableExtensions: true,
    graderTimeoutMs: 600_000,
    editableRoots: definition.editableRoots,
    protectedPaths: definition.protected,
    publicCheck: definition.publicCheck,
  };
}

async function readCaseMaterial(argumentName) {
  const caseFile = await realpath(path.resolve(argument(argumentName)));
  const caseRoot = path.dirname(caseFile);
  const definition = parseSingleObject(await readUtf8Strict(caseFile, "case definition"), "case definition");
  validateCaseDefinition(definition);
  const sourceWorkspace = await confinedCasePath(caseRoot, definition.workspace, "workspace", "directory");
  const taskFile = await confinedCasePath(caseRoot, definition.task, "task", "file");
  const grader = await confinedCasePath(caseRoot, definition.grader, "grader", "file");
  const sealedFiles = [["case definition", caseFile], ["task", taskFile], ["grader", grader]];
  for (const [label, file] of sealedFiles) {
    if (isWithin(sourceWorkspace, file)) throw new Error(`case ${label} must be outside the source workspace`);
  }
  for (let left = 0; left < sealedFiles.length; left += 1) {
    for (let right = left + 1; right < sealedFiles.length; right += 1) {
      if (samePath(sealedFiles[left][1], sealedFiles[right][1])) {
        throw new Error(`case ${sealedFiles[left][0]} and ${sealedFiles[right][0]} must be distinct files`);
      }
    }
  }
  return { caseFile, caseRoot, definition, sourceWorkspace, taskFile, grader };
}

function validateCaseDefinition(value) {
  if (!isObject(value)) throw new Error("case definition must be an object");
  const allowed = new Set([
    "id", "version", "track", "workspace", "task", "grader", "publicCheck", "rawProcess",
    "protected", "editableRoots", "maxSteps", "maxDurationMs", "maxContextBytes",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`case definition contains unsupported field '${key}'`);
  }
  for (const field of ["id", "track", "workspace", "task", "grader"]) requireString(value[field], field);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(value.id)) throw new Error("case id is invalid");
  if (value.version !== undefined
    && (!Number.isSafeInteger(value.version) || value.version < 1 || value.version > 1_000_000)) {
    throw new Error("case version is invalid");
  }
  if (!Number.isSafeInteger(value.maxSteps) || value.maxSteps < 1) throw new Error("case maxSteps is invalid");
  if (value.maxDurationMs !== undefined
    && (!Number.isSafeInteger(value.maxDurationMs) || value.maxDurationMs < 1 || value.maxDurationMs > 604_800_000)) {
    throw new Error("case maxDurationMs is invalid");
  }
  if (value.maxContextBytes !== undefined
    && (!Number.isSafeInteger(value.maxContextBytes) || value.maxContextBytes < 1_024 || value.maxContextBytes > 100_000_000)) {
    throw new Error("case maxContextBytes is invalid");
  }
  if (value.rawProcess !== undefined && typeof value.rawProcess !== "boolean") {
    throw new Error("case rawProcess is invalid");
  }
  if (value.rawProcess === true) throw new Error("case rawProcess is incompatible with guarded execution");
  if (!Array.isArray(value.editableRoots) || !value.editableRoots.every((entry) => typeof entry === "string")) {
    throw new Error("case editableRoots is invalid");
  }
  if (!Array.isArray(value.protected) || !value.protected.every((entry) => typeof entry === "string")) {
    throw new Error("case protected paths are invalid");
  }
  if (!isObject(value.publicCheck) || typeof value.publicCheck.command !== "string" || value.publicCheck.command.length === 0
    || !Array.isArray(value.publicCheck.args)
    || !value.publicCheck.args.every((entry) => typeof entry === "string")) {
    throw new Error("case publicCheck is invalid");
  }
}

async function confinedCasePath(root, relative, label, expectedType) {
  if (typeof relative !== "string" || relative.length === 0 || path.isAbsolute(relative)) {
    throw new Error(`case ${label} path is invalid`);
  }
  const canonicalRoot = await realpath(root);
  const lexical = path.resolve(canonicalRoot, relative);
  if (!isWithin(canonicalRoot, lexical)) throw new Error(`case ${label} escapes its case root`);
  const canonical = await realpath(lexical);
  if (!isWithin(canonicalRoot, canonical)) throw new Error(`case ${label} resolves outside its case root`);
  const details = await lstat(canonical);
  if ((expectedType === "file" && !details.isFile())
    || (expectedType === "directory" && !details.isDirectory())) {
    throw new Error(`case ${label} is not a ${expectedType}`);
  }
  return canonical;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function evaluate(input) {
  const base = {
    id: input.caseId,
    caseVersion: input.caseVersion,
    track: input.track,
    score: 0,
    verified: false,
    classification: "engine_error",
    canaryDenominatorEligible: true,
    steps: 0,
    durationMs: 0,
    toolFailures: 0,
    localTestFailures: 0,
    testHarnessFailures: 0,
    toolFrictionFailures: 0,
    verificationFailures: 0,
    completionClaims: 0,
    policyBlocks: 0,
    contextCompactions: 0,
    contextProjections: 0,
    executionQuality: 0,
    changedFiles: 0,
    filesAdded: 0,
    filesDeleted: 0,
    filesModified: 0,
    beforeLines: 0,
    afterLines: 0,
    session: null,
    scorecard: null,
    engineOutputFile: path.resolve(input.candidateOutputFile),
    engineOutputSha256: null,
    exitCode: input.engineExitCode,
    timedOut: input.engineTimedOut,
    evaluator: {
      bindingPassed: false,
      integrityPassed: false,
      graderPassed: false,
      violations: [],
      changedPaths: [],
      workspaceManifestSha256: null,
      journalTipSha256: null,
      grader: null,
    },
  };

  let output;
  let scorecard;
  let workspace;
  let journal;
  const violations = base.evaluator.violations;
  if (input.engineTimedOut) {
    try {
      const rawBytes = await readFile(input.candidateOutputFile);
      base.engineOutputSha256 = createHash("sha256").update(rawBytes).digest("hex");
    } catch {}
    violations.push("candidate engine exceeded the sealed harness wall-clock deadline");
    return base;
  }
  try {
    const rawBytes = await readFile(input.candidateOutputFile);
    base.engineOutputSha256 = createHash("sha256").update(rawBytes).digest("hex");
    const raw = rawBytes.toString("utf8");
    output = parseSingleObject(raw, "candidate stdout");
    requireString(output.scorecardFile, "stdout scorecardFile");
    const scorecardFile = await canonicalFile(output.scorecardFile, "scorecardFile");
    scorecard = parseSingleObject(await readFile(scorecardFile, "utf8"), "on-disk scorecard");
    const stdoutScorecard = { ...output };
    delete stdoutScorecard.scorecardFile;
    if (stableJson(stdoutScorecard) !== stableJson(scorecard)) {
      violations.push("stdout scorecard does not equal the canonical on-disk scorecard");
    }

    workspace = await validateScorecardBinding(input, scorecard, scorecardFile, violations);
    journal = await validateSessionArtifacts(input, scorecard, workspace, violations);
    base.session = workspace;
    base.scorecard = scorecardFile;
    copyMetrics(scorecard, base, journal, violations);
  } catch (error) {
    violations.push(message(error));
  }

  base.evaluator.bindingPassed = violations.length === 0;
  if (workspace !== undefined) {
    try {
      const integrity = await verifyWorkspaceIntegrity(
        input.sourceWorkspace,
        workspace,
        input.editableRoots,
        input.protectedPaths,
      );
      base.evaluator.integrityPassed = integrity.violations.length === 0;
      base.evaluator.changedPaths = integrity.changedPaths;
      base.evaluator.workspaceManifestSha256 = integrity.workspaceManifestSha256;
      violations.push(...integrity.violations);
      if (scorecard !== undefined) validatePatchMetrics(scorecard.patch, integrity, violations);
    } catch (error) {
      violations.push(`independent workspace integrity failed: ${message(error)}`);
    }

    try {
      const grade = await runSealedGrader(input.grader, workspace, input.graderTimeoutMs);
      base.evaluator.grader = grade;
      base.evaluator.graderPassed = grade.exitCode === 0;
      if (!base.evaluator.graderPassed) violations.push(`independent sealed grader exited ${grade.exitCode}`);
    } catch (error) {
      violations.push(`independent sealed grader could not run: ${message(error)}`);
    }
  }
  if (journal !== undefined) base.evaluator.journalTipSha256 = journal.tip;

  const engineClassification = scorecard?.grade?.classification;
  const engineCompleted = scorecard?.outcome?.status === "completed";
  const engineVerified = scorecard?.grade?.verified === true;
  const canaryAccepted = base.evaluator.bindingPassed
    && base.evaluator.integrityPassed
    && base.evaluator.graderPassed
    && violations.length === 0
    && engineCompleted
    && engineVerified
    && input.engineExitCode === 0;

  if (canaryAccepted) {
    base.verified = true;
    base.score = 1;
    base.classification = "verified";
    base.canaryDenominatorEligible = true;
  } else if (base.evaluator.bindingPassed && engineClassification === "infrastructure_error") {
    base.score = 0;
    base.classification = "infrastructure_error";
    base.canaryDenominatorEligible = false;
  } else {
    // Invalid stdout, broken session bindings, verifier mismatches, and engine
    // crashes are candidate failures. They must not disappear from the
    // denominator under the infrastructure-error label.
    base.score = 0;
    base.classification = base.evaluator.bindingPassed ? "capability_failure" : "engine_error";
    base.canaryDenominatorEligible = true;
  }
  return base;
}

async function validateScorecardBinding(input, scorecard, scorecardFile, violations) {
  if (scorecard.version !== 3) violations.push("scorecard version is not 3");
  requireString(scorecard.sessionId, "scorecard sessionId");
  requireString(scorecard.sourceRoot, "scorecard sourceRoot");
  requireString(scorecard.workspaceRoot, "scorecard workspaceRoot");
  if (scorecard.provider !== input.provider) violations.push("scorecard provider does not match the requested provider");
  if (scorecard.model !== input.model) violations.push("scorecard model does not match the requested model");
  if (scorecard.task !== input.task) violations.push("scorecard task does not match the sealed case task");

  const source = await canonicalDirectory(input.sourceWorkspace, "source workspace");
  const reportedSource = await canonicalDirectory(scorecard.sourceRoot, "reported sourceRoot");
  if (!samePath(source, reportedSource)) violations.push("scorecard sourceRoot is not the sealed case workspace");
  const workspace = await canonicalDirectory(scorecard.workspaceRoot, "reported workspaceRoot");
  if (samePath(source, workspace)) violations.push("candidate edited the source workspace instead of an isolated session");
  const sessionRoot = path.dirname(workspace);
  if (asciiLowercase(path.basename(workspace)) !== "workspace") {
    violations.push("scorecard workspaceRoot is not the canonical session workspace");
  }
  if (!samePath(scorecardFile, path.join(sessionRoot, "scorecard.json"))) {
    violations.push("scorecardFile is outside the canonical session root");
  }

  const expectedVerification = { command: "node", args: [path.resolve(input.grader), "."] };
  if (stableJson(scorecard.verification) !== stableJson(expectedVerification)) {
    violations.push("scorecard verifier command is not the sealed grader contract");
  }
  const outcome = scorecard.outcome;
  const grade = scorecard.grade;
  if (!isObject(outcome) || !isObject(grade)) {
    violations.push("scorecard outcome or grade is malformed");
    return workspace;
  }
  const steps = outcome.steps;
  if (!Number.isSafeInteger(steps) || steps < 0 || steps > input.maxSteps || grade.steps !== steps) {
    violations.push("scorecard steps are outside the case budget or internally inconsistent");
  }
  if (outcome.status === "completed") {
    if (input.engineExitCode !== 0 || grade.verified !== true || grade.classification !== "verified" || grade.score !== 1
      || typeof outcome.answer !== "string" || steps < 1) {
      violations.push("completed scorecard is inconsistent with exit status, grade, or outcome");
    }
  } else if (outcome.status === "failed") {
    const expectedClassification = classifyFailure(outcome.reason);
    const expectedScore = expectedClassification === "infrastructure_error" ? null : 0;
    if (input.engineExitCode === 0 || grade.verified !== false
      || grade.classification !== expectedClassification
      || grade.score !== expectedScore || typeof outcome.reason !== "string") {
      violations.push("failed scorecard is inconsistent with exit status, grade, or outcome");
    }
  } else {
    violations.push("run command produced a non-terminal outcome");
  }
  return workspace;
}

async function validateSessionArtifacts(input, scorecard, workspace, violations) {
  const sessionRoot = path.dirname(workspace);
  const expected = {
    journalFile: path.join(sessionRoot, "run.jsonl"),
    sessionFile: path.join(sessionRoot, "session.json"),
    configurationFile: path.join(sessionRoot, "run-config.json"),
  };
  for (const [field, value] of Object.entries(expected)) {
    requireString(scorecard[field], `scorecard ${field}`);
    const actual = await canonicalFile(scorecard[field], field);
    if (!samePath(actual, value)) violations.push(`${field} is outside the canonical session root`);
  }

  const session = parseSingleObject(await readFile(expected.sessionFile, "utf8"), "session metadata");
  if (session.id !== scorecard.sessionId || session.materialized !== true
    || !samePath(path.resolve(session.sourceRoot ?? ""), path.resolve(input.sourceWorkspace))
    || !samePath(path.resolve(session.workspaceRoot ?? ""), workspace)) {
    violations.push("session metadata does not bind the scorecard identity and workspace");
  }
  const configuration = parseSingleObject(await readFile(expected.configurationFile, "utf8"), "run configuration");
  const options = configuration.options;
  if (!hasExactKeys(configuration, RUN_CONFIGURATION_KEYS)
    || configuration.version !== 1 || !hasExactKeys(options, RUN_OPTION_KEYS)
    || !samePath(path.resolve(options.workspace ?? ""), path.resolve(input.sourceWorkspace))
    || options.task !== input.task || options.provider !== input.provider || options.model !== input.model
    || stableJson(options.verification) !== stableJson({ command: "node", args: [path.resolve(input.grader), "."] })
    || stableJson(options.publicCheck) !== stableJson(input.publicCheck)
    || stableJson(options.protectedPaths) !== stableJson(input.protectedPaths)
    || stableJson(options.editableRoots) !== stableJson(input.editableRoots)
    || stableJson(options.allowedCommands) !== stableJson([])
    || options.securityProfile !== "guarded" || options.restrictProcess !== true
    || options.exposeRawProcess !== input.exposeRawProcess || options.verifierEvidence !== "summary"
    || options.maxSteps !== input.maxSteps
    || options.maxDurationMs !== input.maxDurationMs
    || options.commandTimeoutMs !== input.commandTimeoutMs
    || options.maxContextBytes !== input.maxContextBytes
    || options.maxFailedVerificationAttempts !== input.maxFailedVerificationAttempts
    || options.disableExtensions !== input.disableExtensions
    || stableJson(options.extensions) !== stableJson(SEALED_DEFAULT_EXTENSIONS)
  ) {
    violations.push("run configuration does not bind the sealed case and guarded execution policy");
  }

  const genesis = typeof session.journalGenesisHash === "string" ? session.journalGenesisHash : JOURNAL_GENESIS;
  const journal = await validateJournal(expected.journalFile, genesis);
  const terminal = journal.events.at(-1);
  if (scorecard.outcome?.status === "completed") {
    if (terminal?.type !== "run.completed" || terminal.data?.step !== scorecard.outcome.steps
      || terminal.data?.answer !== scorecard.outcome.answer) {
      violations.push("validated journal does not terminate in the scorecard completion");
    }
  } else if (scorecard.outcome?.status === "failed") {
    if (terminal?.type !== "run.failed" || terminal.data?.reason !== scorecard.outcome.reason) {
      violations.push("validated journal does not terminate in the scorecard failure");
    }
  }
  return journal;
}

async function validateJournal(file, genesis) {
  if (!/^[a-f0-9]{64}$/u.test(genesis)) throw new Error("journal genesis hash is malformed");
  const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("journal is empty");
  const events = [];
  let previous = genesis;
  for (const [offset, line] of lines.entries()) {
    const envelope = parseSingleObject(line, `journal line ${offset + 1}`);
    const expected = createHash("sha256").update(previous).update("\n").update(JSON.stringify(envelope.event)).digest("hex");
    if (envelope.previousHash !== previous || envelope.hash !== expected) {
      throw new Error(`journal hash chain failed at line ${offset + 1}`);
    }
    if (!isObject(envelope.event) || envelope.event.sequence !== offset + 1) {
      throw new Error(`journal sequence failed at line ${offset + 1}`);
    }
    previous = envelope.hash;
    events.push(envelope.event);
  }
  return { events, tip: previous };
}

async function verifyWorkspaceIntegrity(sourceRoot, workspaceRoot, editableRoots, protectedPaths) {
  const [source, workspace] = await Promise.all([snapshot(sourceRoot), snapshot(workspaceRoot)]);
  const changedPaths = [...new Set([...source.files.keys(), ...workspace.files.keys()])]
    .filter((file) => source.files.get(file)?.sha256 !== workspace.files.get(file)?.sha256)
    .sort();
  const normalizedEditable = editableRoots.map(normalizeRelative);
  const normalizedProtected = protectedPaths.map(normalizeRelative);
  const scopeViolations = changedPaths.filter((file) => !normalizedEditable.some((root) => within(file, root)));
  const protectedViolations = changedPaths.filter((file) => normalizedProtected.some((root) => within(file, root)));
  const violations = [
    ...source.links.map((entry) => `source workspace contains unsupported reparse point: ${entry}`),
    ...workspace.links.map((entry) => `candidate workspace contains a reparse point: ${entry}`),
    ...scopeViolations.map((entry) => `out-of-scope workspace change: ${entry}`),
    ...protectedViolations.map((entry) => `protected workspace change: ${entry}`),
  ];
  const patch = patchMetrics(source.files, workspace.files, changedPaths);
  return {
    ...patch,
    changedPaths,
    violations,
    workspaceManifestSha256: manifestHash(workspace.files),
  };
}

async function snapshot(root) {
  const canonicalRoot = await canonicalDirectory(root, "snapshot root");
  const files = new Map();
  const links = [];
  const queue = [canonicalRoot];
  while (queue.length > 0) {
    const directory = queue.shift();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizeRelative(path.relative(canonicalRoot, absolute));
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) {
        links.push(relative);
      } else if (details.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) queue.push(absolute);
      } else if (details.isFile()) {
        const bytes = await readFile(absolute);
        files.set(relative, {
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  return { files, links: links.sort() };
}

function patchMetrics(before, after, changedPaths) {
  let filesAdded = 0;
  let filesDeleted = 0;
  let filesModified = 0;
  let beforeBytes = 0;
  let afterBytes = 0;
  let beforeLines = 0;
  let afterLines = 0;
  for (const file of changedPaths) {
    const oldValue = before.get(file)?.bytes;
    const newValue = after.get(file)?.bytes;
    if (oldValue === undefined) filesAdded += 1;
    else if (newValue === undefined) filesDeleted += 1;
    else filesModified += 1;
    beforeBytes += oldValue?.length ?? 0;
    afterBytes += newValue?.length ?? 0;
    beforeLines += textLines(oldValue);
    afterLines += textLines(newValue);
  }
  return { filesAdded, filesDeleted, filesModified, beforeBytes, afterBytes, beforeLines, afterLines };
}

function validatePatchMetrics(reported, observed, violations) {
  if (!isObject(reported)
    || stableJson(reported.changedFiles) !== stableJson(observed.changedPaths)
    || reported.filesAdded !== observed.filesAdded
    || reported.filesDeleted !== observed.filesDeleted
    || reported.filesModified !== observed.filesModified
    || reported.beforeBytes !== observed.beforeBytes
    || reported.afterBytes !== observed.afterBytes
    || reported.beforeLines !== observed.beforeLines
    || reported.afterLines !== observed.afterLines) {
    violations.push("scorecard patch metrics do not match the independently observed final workspace");
  }
}

async function runSealedGrader(grader, workspace, timeout) {
  try {
    const completed = await execute(process.execPath, [path.resolve(grader), workspace], {
      cwd: workspace,
      timeout,
      maxBuffer: 5_000_000,
      windowsHide: true,
      env: sanitizedEnvironment(),
    });
    return { exitCode: 0, stdout: truncate(completed.stdout), stderr: truncate(completed.stderr) };
  } catch (error) {
    if (error !== null && typeof error === "object" && ("code" in error || "signal" in error)) {
      return {
        exitCode: Number.isSafeInteger(error.code) ? error.code : -1,
        signal: typeof error.signal === "string" ? error.signal : null,
        stdout: truncate(typeof error.stdout === "string" ? error.stdout : ""),
        stderr: truncate(typeof error.stderr === "string" ? error.stderr : message(error)),
      };
    }
    throw error;
  }
}

function copyMetrics(scorecard, target, journal, violations) {
  const trajectory = isObject(scorecard.trajectory) ? scorecard.trajectory : {};
  const patch = isObject(scorecard.patch) ? scorecard.patch : {};
  target.steps = nonnegativeInteger(scorecard.grade?.steps, "scorecard grade.steps", violations);
  target.durationMs = nonnegativeNumber(scorecard.durationMs, "scorecard durationMs", violations);
  const derived = deriveTrajectory(journal.events);
  for (const field of [
    "toolFailures", "localTestFailures", "testHarnessFailures", "toolFrictionFailures",
    "verificationFailures", "completionClaims", "policyBlocks", "contextCompactions", "contextProjections",
  ]) {
    const reported = nonnegativeInteger(trajectory[field], `scorecard trajectory.${field}`, violations);
    if (reported !== derived[field]) {
      violations.push(`scorecard trajectory.${field} does not match the validated journal`);
    }
    target[field] = derived[field];
  }
  const derivedQuality = scorecard.grade?.verified === true
    ? roundMetric(Math.max(0, 1
      - Math.min(0.32, derived.toolFrictionFailures * 0.08)
      - Math.min(0.36, derived.verificationFailures * 0.12)
      - Math.min(0.16, Math.max(0, derived.completionClaims - 1) * 0.04)))
    : 0;
  const reportedQuality = scorecard.grade?.executionQuality?.score;
  if (typeof reportedQuality !== "number" || !Number.isFinite(reportedQuality)
    || reportedQuality < 0 || reportedQuality > 1 || reportedQuality !== derivedQuality) {
    violations.push("scorecard execution quality does not match the validated journal");
  }
  target.executionQuality = derivedQuality;
  target.changedFiles = Array.isArray(patch.changedFiles) ? patch.changedFiles.length : 0;
  target.filesAdded = nonnegativeInteger(patch.filesAdded, "scorecard patch.filesAdded", violations);
  target.filesDeleted = nonnegativeInteger(patch.filesDeleted, "scorecard patch.filesDeleted", violations);
  target.filesModified = nonnegativeInteger(patch.filesModified, "scorecard patch.filesModified", violations);
  target.beforeLines = nonnegativeInteger(patch.beforeLines, "scorecard patch.beforeLines", violations);
  target.afterLines = nonnegativeInteger(patch.afterLines, "scorecard patch.afterLines", violations);
}

function deriveTrajectory(events) {
  const metrics = {
    toolFailures: 0,
    localTestFailures: 0,
    testHarnessFailures: 0,
    toolFrictionFailures: 0,
    verificationFailures: 0,
    completionClaims: 0,
    policyBlocks: 0,
    contextCompactions: 0,
    contextProjections: 0,
  };
  let pendingToolNames = [];
  for (const event of events) {
    const data = isObject(event.data) ? event.data : {};
    if (event.type === "model.decided") {
      pendingToolNames = [];
      const calls = data.kind === "tools" && Array.isArray(data.calls)
        ? data.calls
        : data.kind === "tool" ? [data.call] : [];
      for (const value of calls) {
        if (isObject(value) && typeof value.name === "string") pendingToolNames.push(value.name);
      }
      if (data.kind === "complete") metrics.completionClaims += 1;
    }
    if (event.type === "tool.failed") {
      metrics.toolFailures += 1;
      const serialized = asciiLowercase(JSON.stringify(event.data));
      const output = isObject(data.output) ? data.output : {};
      const failedToolName = typeof data.tool === "string" ? data.tool : pendingToolNames[0];
      const localTest = (failedToolName === "run_command" || failedToolName === "check_project")
        && typeof output.exitCode === "number";
      const harness = localTest && (
        serialized.includes("syntaxerror") && serialized.includes("[eval")
        || serialized.includes("err_eval_esm_cannot_print")
      );
      if (harness) {
        metrics.testHarnessFailures += 1;
        metrics.toolFrictionFailures += 1;
      } else if (localTest) {
        metrics.localTestFailures += 1;
      } else {
        metrics.toolFrictionFailures += 1;
      }
      if (serialized.includes("process policy")
        || serialized.includes("evidence policy")
        || serialized.includes("workspace mutation policy")
        || serialized.includes("outside the declared editable roots")) {
        metrics.policyBlocks += 1;
      }
    }
    if (event.type === "tool.completed" || event.type === "tool.failed") {
      const completedName = typeof data.tool === "string" ? data.tool : undefined;
      const index = completedName === undefined ? 0 : pendingToolNames.indexOf(completedName);
      if (index >= 0) pendingToolNames.splice(index, 1);
      else pendingToolNames.shift();
    }
    if (event.type === "verification.completed" && data.passed === false) {
      metrics.verificationFailures += 1;
    }
    if (event.type === "context.compacted") {
      if (data.operation === "request_projection" && data.durableHistoryChanged === false) {
        metrics.contextProjections += 1;
      } else {
        metrics.contextCompactions += 1;
      }
    }
  }
  return metrics;
}

function validateRequest(value) {
  if (!isObject(value)) throw new Error("request must be an object");
  for (const field of [
    "caseId", "track", "candidateOutputFile", "sourceWorkspace", "grader", "provider", "model", "task",
  ]) requireString(value[field], field);
  if (!Number.isSafeInteger(value.caseVersion) || value.caseVersion < 1) throw new Error("caseVersion is invalid");
  if (!Number.isSafeInteger(value.engineExitCode)) throw new Error("engineExitCode is invalid");
  if (typeof value.engineTimedOut !== "boolean") throw new Error("engineTimedOut is invalid");
  if (!Number.isSafeInteger(value.maxSteps) || value.maxSteps < 1) throw new Error("maxSteps is invalid");
  if (!Number.isSafeInteger(value.maxDurationMs) || value.maxDurationMs < 1) throw new Error("maxDurationMs is invalid");
  if (!Number.isSafeInteger(value.commandTimeoutMs) || value.commandTimeoutMs < 1) {
    throw new Error("commandTimeoutMs is invalid");
  }
  if (!Number.isSafeInteger(value.maxContextBytes) || value.maxContextBytes < 1_024) {
    throw new Error("maxContextBytes is invalid");
  }
  if (!Number.isSafeInteger(value.maxFailedVerificationAttempts) || value.maxFailedVerificationAttempts < 1) {
    throw new Error("maxFailedVerificationAttempts is invalid");
  }
  if (value.exposeRawProcess !== false) throw new Error("exposeRawProcess must be false");
  if (value.disableExtensions !== true) throw new Error("disableExtensions must be true");
  if (!Number.isSafeInteger(value.graderTimeoutMs) || value.graderTimeoutMs < 1) throw new Error("graderTimeoutMs is invalid");
  if (!Array.isArray(value.editableRoots) || !value.editableRoots.every((entry) => typeof entry === "string")) {
    throw new Error("editableRoots is invalid");
  }
  if (!Array.isArray(value.protectedPaths) || !value.protectedPaths.every((entry) => typeof entry === "string")) {
    throw new Error("protectedPaths is invalid");
  }
  if (!isObject(value.publicCheck) || typeof value.publicCheck.command !== "string"
    || !Array.isArray(value.publicCheck.args) || !value.publicCheck.args.every((entry) => typeof entry === "string")) {
    throw new Error("publicCheck is invalid");
  }
}

async function readUtf8Strict(file, label) {
  const bytes = await readFile(file);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function parseSingleObject(text, label) {
  let value;
  try {
    value = JSON.parse(text.trim());
  } catch (error) {
    throw new Error(`${label} is not exactly one JSON document: ${message(error)}`);
  }
  if (!isObject(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function hasExactKeys(value, expected) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort(compareOrdinal);
  const wanted = [...expected].sort(compareOrdinal);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function manifestHash(files) {
  const canonical = [...files.entries()].sort(([left], [right]) => compareOrdinal(left, right))
    .map(([name, value]) => `${name}\t${value.bytes.length}\t${value.sha256}`).join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function textLines(value) {
  if (value === undefined || value.includes(0)) return 0;
  const text = value.toString("utf8");
  return text.length === 0 ? 0 : text.split(/\r?\n/u).length;
}

function sanitizedEnvironment() {
  const allowed = new Set([
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
    "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "JAVA_HOME", "LANG", "LC_ALL",
  ]);
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) => allowed.has(name) && value !== undefined));
}

function classifyFailure(reason) {
  if (typeof reason !== "string") return "capability_failure";
  const lower = asciiLowercase(reason);
  const infrastructureMarkers = [
    "inference endpoint returned http",
    "missing credential environment variable",
    "fetch failed",
    "network error",
    "request timed out",
  ];
  return reason.startsWith("Model failure:") && infrastructureMarkers.some((marker) => lower.includes(marker))
    ? "infrastructure_error"
    : "capability_failure";
}

function normalizeRelative(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (normalized.length === 0 || normalized === ".." || normalized.startsWith("../") || path.isAbsolute(normalized)) {
    throw new Error(`integrity path must be a non-empty relative path: ${value}`);
  }
  return normalized;
}

function within(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

async function canonicalDirectory(value, label) {
  const resolved = await realpath(path.resolve(value));
  if (!(await lstat(resolved)).isDirectory()) throw new Error(`${label} is not a directory`);
  return resolved;
}

async function canonicalFile(value, label) {
  const resolved = await realpath(path.resolve(value));
  if (!(await lstat(resolved)).isFile()) throw new Error(`${label} is not a file`);
  return resolved;
}

function samePath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asciiLowercase(value) {
  return value.replace(/[A-Z]/gu, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 0x20));
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function nonnegativeInteger(value, label, violations) {
  if (!Number.isSafeInteger(value) || value < 0) {
    violations.push(`${label} must be a nonnegative safe integer`);
    return 0;
  }
  return value;
}

function nonnegativeNumber(value, label, violations) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    violations.push(`${label} must be a nonnegative finite number`);
    return 0;
  }
  return value;
}

function roundMetric(value) {
  return Math.round(value * 1_000) / 1_000;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function truncate(value) {
  const text = String(value ?? "");
  return text.length <= OUTPUT_LIMIT ? text : `${text.slice(0, OUTPUT_LIMIT)}\n...[truncated]`;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function argument(name) {
  const offset = process.argv.indexOf(name);
  if (offset < 0 || process.argv[offset + 1] === undefined) {
    process.stderr.write(`Missing ${name}.\n`);
    process.exit(2);
  }
  return process.argv[offset + 1];
}
