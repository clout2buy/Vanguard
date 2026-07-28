import path from "node:path";
import type { JournalPort, JsonValue, RunEvent, ToolPort, UserChannelPort, VerifierPort } from "../kernel/contracts.js";
import type { AgentKernel as AgentKernelType, RunOutcome } from "../kernel/run.js";
import { logicalRunEvents } from "../kernel/logicalHistory.js";
import { SESSION_EXCLUDED_DIRECTORIES, TreeSnapshotCache, snapshotTree } from "../runtime/treeSnapshot.js";
import {
  AdaptiveCommandVerifier,
  AgentKernel,
  CheckpointTool,
  CommandVerifier,
  adaptiveVerifyMode,
  isAdaptiveVerifyCommand,
  CreativeDirectionVerifier,
  RenderableArtifactVerifier,
  DeleteFileTool,
  FileJournal,
  HeadlessRenderTool,
  CodeIntelTool,
  RepoMemoryStore,
  RepoMemoryTool,
  ScoutDelegateTool,
  EvidenceReadTool,
  SkillReadTool,
  ImageInspectionTool,
  JournalEvidenceResolver,
  GlobTool,
  ListFilesTool,
  ProcessTool,
  prewarmExecutionRuntime,
  ReadFileTool,
  ReplaceTextTool,
  ReviewChangesTool,
  RunCheckpointLedger,
  SearchTextTool,
  WorkspaceBoundary,
  WorkspaceIntegrityVerifier,
  WorkspaceMutationPolicy,
  WorkspaceVersionLedger,
  WebFetchTool,
  WebSearchTool,
  WriteFileTool,
  contractCriterionIds,
  normalizeContract,
  FixedCommandTool,
  PlanLedger,
  PlanTool,
  PostEditSyntaxChecker,
  PublicRunEventPresenter,
  RepositoryMapTool,
  StickyContextPolicy,
  SyntaxCheckTool,
  SyntaxCommandRunner,
  UsageLedger,
  resolveExtensions,
  ExtensionPermissionPolicy,
  FileExtensionAuditJournal,
  HookRunner,
  McpStdioClient,
  loadWorkspaceSkills,
  latestDurableStateAnchor,
  type CodingSession,
  type StreamObserver,
  DelegationCoordinator,
  CliDelegateRunner,
  TransactionalDelegateMerger,
  createDelegationTools,
} from "../index.js";
import { boundedEnvironmentInteger, commandAliases, type CliOptions } from "./options.js";
import { commandApprover } from "./userChannel.js";
import { createModel } from "./modelFactory.js";
import { combinedObserver, createStreamPresenter, formatDuration, streamPublicEvent } from "./scorecard.js";

export interface ExecutionRuntime {
  readonly kernel: AgentKernelType;
  readonly mutationPolicyDescription: string;
  /** Extension-derived task augmentation (skills, instructions) for direct-run tasks. */
  readonly taskAugmentation?: string;
  readonly journalActivity: () => number;
  readonly usage?: UsageLedger;
  readonly dispose?: () => Promise<void>;
  readonly delegationSnapshot?: () => JsonValue;
}

export function buildConversationRuntime(
  session: CodingSession,
  options: CliOptions,
  fileJournal: FileJournal,
  userChannel: UserChannelPort | undefined,
): ExecutionRuntime {
  const source = new WorkspaceBoundary(session.sourceRoot);
  const versions = new WorkspaceVersionLedger();
  const mutationPolicy = new WorkspaceMutationPolicy(options.editableRoots, options.protectedPaths);
  const { journal, journalActivity, markActivity } = instrumentJournal(fileJournal);
  const conversationTools = [
    new ListFilesTool(source),
    new SearchTextTool(source),
    new GlobTool(source),
    new ReadFileTool(source, 1_000_000, versions),
    new RepositoryMapTool(source, { includeInstructions: !options.disableExtensions }),
    new HeadlessRenderTool(source),
    new ImageInspectionTool(source),
    new CodeIntelTool(source),
    new WebSearchTool(),
    new WebFetchTool(),
  ];
  const kernel = new AgentKernel({
    model: createModel(options, createStreamPresenter(markActivity)),
    tools: [
      ...conversationTools,
      // Compaction drops old tool outputs from context but not from the
      // journal; this reads them back by evidence id so a long conversation
      // stops forgetting what it already looked at.
      new EvidenceReadTool(fileJournal),
      // The internal delegation loop: scouts investigate on a separate model
      // context and return digests, so even pre-contract exploration cannot
      // flood the conversation with raw file contents.
      new ScoutDelegateTool(createModel(options), conversationTools),
    ],
    verifiers: [],
    journal,
    contextPolicy: new StickyContextPolicy({ retrievableEvidence: true }),
    ...(options.extensions === undefined ? {} : { workingState: { snapshot: () => ({ extensions: options.extensions! }) } }),
    taskAddendum: taskAddendum(options, mutationPolicy),
    ...(userChannel === undefined ? {} : { userChannel }),
    options: {
      maxSteps: options.maxSteps,
      maxContextBytes: options.maxContextBytes,
      maxRepeatedAction: 3,
      interactive: true,
    },
  });
  return { kernel, mutationPolicyDescription: mutationPolicy.describe(), journalActivity };
}

export async function buildExecutionRuntime(
  session: CodingSession,
  options: CliOptions,
  fileJournal: FileJournal,
  interactive: boolean,
  userChannel?: UserChannelPort,
): Promise<ExecutionRuntime> {
  const container = path.dirname(session.metadataFile);
  const workspace = new WorkspaceBoundary(session.workspaceRoot);
  const versions = new WorkspaceVersionLedger();
  const mutationPolicy = new WorkspaceMutationPolicy(options.editableRoots, options.protectedPaths);
  const commandTimeoutMs = Math.min(options.commandTimeoutMs, options.maxDurationMs);
  // Idle watchdog for every process lane: agent commands, the sealed verifier,
  // and the public check. A hung server or wedged test fixture is killed after
  // sustained silence instead of occupying the full flat timeout.
  const idleOption = options.commandIdleTimeoutMs === undefined
    ? {}
    : { idleTimeoutMs: Math.min(options.commandIdleTimeoutMs, commandTimeoutMs) };
  const agentAllowedCommands = options.restrictProcess
    ? [...new Set(["node", ...options.allowedCommands])]
    : [...new Set(["node", "npm", "npx", "git", options.verification.command, ...options.allowedCommands])];
  const processTool = new ProcessTool(workspace, {
    allowedCommands: agentAllowedCommands,
    ...(userChannel === undefined ? {} : { requestApproval: commandApprover(userChannel) }),
    commandAliases: commandAliases(session.workspaceRoot, options.restrictProcess, mutationPolicy.writableAbsoluteRoots(session.workspaceRoot)),
    deniedArgumentPrefixes: options.restrictProcess ? ["--allow-", "--no-permission", "--no-experimental-permission"] : [],
    deniedArgumentSubstrings: options.restrictProcess ? ["console.assert"] : [],
    timeoutMs: commandTimeoutMs,
    ...idleOption,
    maxOutputBytes: 2_000_000,
  });
  const verifierProcessTool = new ProcessTool(workspace, {
    allowedCommands: [options.verification.command],
    commandAliases: commandAliases(session.workspaceRoot, false, []),
    timeoutMs: commandTimeoutMs,
    ...idleOption,
    maxOutputBytes: 2_000_000,
  });
  const publicCheckTool = options.publicCheck === undefined ? undefined : new FixedCommandTool(
    "check_project",
    "Run the project's trusted public compile and test command with its fixed arguments.",
    new ProcessTool(workspace, {
      allowedCommands: [options.publicCheck.command],
      commandAliases: commandAliases(session.workspaceRoot, false, []),
      timeoutMs: commandTimeoutMs,
      ...idleOption,
      maxOutputBytes: 2_000_000,
    }),
    options.publicCheck,
  );
  const verifiers: VerifierPort[] = [
    // The reserved builtin runs in-process with captured output; everything
    // else is a sealed external command exactly as before.
    isAdaptiveVerifyCommand(options.verification)
      ? new AdaptiveCommandVerifier("adaptive verification", session.workspaceRoot, adaptiveVerifyMode(options.verification))
      : new CommandVerifier("required command", verifierProcessTool, options.verification, options.verifierEvidence),
  ];
  if (options.protectedPaths.length > 0 || options.editableRoots.length > 0) {
    verifiers.push(new WorkspaceIntegrityVerifier({
      sourceRoot: session.sourceRoot,
      workspaceRoot: session.workspaceRoot,
      protectedPaths: options.protectedPaths,
      editableRoots: options.editableRoots,
    }));
  }
  // Configured extensions become live runtime capability here: MCP servers
  // contribute execute-effect tools, hooks gate run/tool boundaries, and
  // data-only skills are advertised in the task addendum. Everything stays
  // inside the exact-match permission ceiling resolved from config layers.
  const extensionCloseables: Array<() => Promise<void>> = [];
  const extensionTools: ToolPort[] = [];
  let hookRunner: HookRunner | undefined;
  let skillsAddendum = "";
  // Read-only, so every profile gets it — the addendum advertises read_skill
  // to all of them, and a scout must not be told to call a tool it lacks.
  let skillTool: ToolPort | undefined;
  if (options.disableExtensions !== true) {
    // Configuration and skills are project truth, so they resolve from the
    // original source tree: session copies deliberately exclude .vanguard.
    const resolved = await resolveExtensions({ workspaceRoot: session.sourceRoot });
    const policy = new ExtensionPermissionPolicy(resolved.config.permissions);
    const needsAudit = resolved.config.mcp.length > 0 || resolved.config.hooks.length > 0;
    const audit = needsAudit
      ? await FileExtensionAuditJournal.open(path.join(container, "extension-audit.jsonl"))
      : undefined;
    for (const server of resolved.config.mcp) {
      const client = await McpStdioClient.connect(workspace, server, policy, audit!);
      extensionTools.push(...client.tools());
      extensionCloseables.push(() => client.close());
    }
    if (resolved.config.hooks.length > 0) {
      hookRunner = new HookRunner(workspace, policy, resolved.config.hooks, audit!);
    }
    const sourceBoundary = new WorkspaceBoundary(session.sourceRoot);
    const skillRoots: string[] = [];
    for (const root of resolved.config.skills.roots) {
      try {
        await sourceBoundary.existing(root);
        skillRoots.push(root);
      } catch {
        // A missing skills directory simply contributes no skills.
      }
    }
    if (skillRoots.length > 0) {
      const skills = await loadWorkspaceSkills(sourceBoundary, { ...resolved.config.skills, roots: skillRoots });
      if (skills.length > 0) {
        // Progressive disclosure: the task carries names and summaries, and
        // read_skill fetches a body on demand. Inlining every body cost the
        // full corpus on every turn of every run, relevant or not — a fixed
        // tax that grows with the skill library and never with its usefulness.
        skillsAddendum = "\n\nAvailable workspace skills — read one with read_skill when it is relevant:"
          + skills.map((skill) => `\n- ${skill.metadata.name}: ${skill.metadata.description}`).join("");
        skillTool = new SkillReadTool(skills);
      }
    }
  }
  const hasToolHooks = hookRunner !== undefined;
  const withToolHooks = (tool: ToolPort): ToolPort =>
    !hasToolHooks ? tool : {
      name: tool.name,
      definition: tool.definition,
      execute: async (input, context) => {
        // Hooks see the actual call now, and a fail-closed before-tool hook
        // denies exactly that call: the model receives a refusal it can plan
        // around instead of the run dying on a single disallowed command.
        const before = await hookRunner!.run("before-tool", context.signal, { tool: tool.name, input });
        const blocking = before.find((outcome) => outcome.blocked);
        if (blocking !== undefined) {
          return {
            ok: false,
            output: {
              error: `Blocked by the '${blocking.hook}' before-tool hook.`,
              hook: blocking.hook,
              ...(blocking.stderr.trim().length === 0 ? {} : { detail: blocking.stderr.trim().slice(0, 2_000) }),
            },
          };
        }
        const result = await tool.execute(input, context);
        await hookRunner!.run("after-tool", context.signal, {
          tool: tool.name,
          input,
          ok: result.ok,
          ...(result.output === undefined ? {} : { output: result.output }),
        });
        return result;
      },
    };
  if (hookRunner !== undefined) {
    // A fail-closed before-run hook refuses the whole run.
    await hookRunner.run("before-run", new AbortController().signal);
  }

  const { journal, journalActivity, markActivity } = instrumentJournal(fileJournal);
  const priorEvents = await fileJournal.readValidated();
  const logicalPriorEvents = logicalRunEvents(priorEvents);
  const checkpointAnchor = latestDurableStateAnchor(logicalPriorEvents, "run.checkpoint");
  const checkpoint = await RunCheckpointLedger.open(path.join(container, "checkpoint.json"), {
    required: true,
    ...(checkpointAnchor === undefined ? {} : { expectedSha256: checkpointAnchor.sha256 }),
  });
  const contractedEvent = [...logicalPriorEvents].reverse().find((event) => event.type === "run.contracted");
  const contractedData = contractedEvent?.data;
  const contract = contractedData !== null && contractedData !== undefined
    && typeof contractedData === "object" && !Array.isArray(contractedData)
    ? normalizeContract(contractedData.contract)
    : undefined;
  // Plans are contract-scoped: milestone revisions are monotonic and the
  // persisted criteria must match the contracted task, so a follow-up
  // contract gets its own plan file and its own update_plan anchor scope
  // instead of colliding with the finished contract's ledger. The first
  // contract keeps the legacy file name so existing sessions resume intact.
  const contractOrdinal = logicalPriorEvents.filter((event) =>
    event.type === "run.contracted"
    || (event.type === "run.started" && event.data !== null && typeof event.data === "object"
      && !Array.isArray(event.data) && typeof event.data.task === "string")).length;
  const planFile = path.join(container, contractOrdinal <= 1 ? "plan.json" : `plan-${contractOrdinal}.json`);
  const planAnchorEvents = contractedEvent === undefined
    ? logicalPriorEvents
    : logicalPriorEvents.filter((event) => event.sequence > contractedEvent.sequence);
  // Every provider gets the same browser-executed completion gate. The model
  // cannot substitute source inspection or a plausible screenshot for a page
  // that actually reaches a settled runtime state. The discovery scope keeps
  // the gate honest without dragging Chromium into unrelated tasks: only
  // session-touched files and files modified during this run qualify for the
  // fallback scan, so a stale docs page elsewhere in the tree never triggers
  // a render on every completion attempt.
  const runtimeStartedAtMs = Date.now();
  const renderScanScope = () => ({ touchedPaths: versions.paths(), modifiedSinceMs: runtimeStartedAtMs });
  const completionRender = new HeadlessRenderTool(workspace);
  // Overlap tool cold starts (TypeScript compiler, first Chromium launch)
  // with the model's first thinking time instead of paying them inside the
  // first verification of the run.
  prewarmExecutionRuntime({ workspaceRoot: session.workspaceRoot, renderTool: completionRender });
  verifiers.push(new RenderableArtifactVerifier(
    workspace,
    contract,
    (relativePath, renderContext) => completionRender.execute({ path: relativePath }, renderContext),
    renderScanScope,
  ));
  // The judge rung: a contracted creative direction makes "good" part of
  // verification, judged from the rendered pixels where the wire carries them.
  if (contract?.creativeDirection !== undefined) {
    verifiers.push(new CreativeDirectionVerifier(
      createModel(options),
      workspace,
      contract,
      (relativePath, judgeContext) => completionRender.execute({ path: relativePath }, judgeContext),
      renderScanScope,
    ));
  }
  const evidenceResolver = new JournalEvidenceResolver(fileJournal);
  const plan = await PlanLedger.open(
    planFile,
    contract === undefined ? [] : contractCriterionIds(contract),
    evidenceResolver,
    {
      required: true,
      ...(latestDurableStateAnchor(planAnchorEvents, "update_plan") === undefined
        ? {}
        : { expectedSha256: latestDurableStateAnchor(planAnchorEvents, "update_plan")!.sha256 }),
    },
  );
  const usage = new UsageLedger(options.model);
  const delegationDepth = boundedEnvironmentInteger("VANGUARD_DELEGATION_DEPTH", 0, 0, 16);
  const delegationMaxDepth = boundedEnvironmentInteger("VANGUARD_DELEGATION_MAX_DEPTH", 1, 0, 4);
  const delegation = await DelegationCoordinator.open({
    storeFile: path.join(container, "delegations.json"),
    parentWorkspace: session.workspaceRoot,
    runner: new CliDelegateRunner({
      provider: options.provider,
      model: options.model,
      ...(options.auth === undefined ? {} : { auth: options.auth }),
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      ...(options.credentialVariable === undefined ? {} : { credentialVariable: options.credentialVariable }),
      verification: options.verification,
      ...(options.publicCheck === undefined ? {} : { publicCheck: options.publicCheck }),
      protectedPaths: options.protectedPaths,
      maxDurationMs: Math.min(options.maxDurationMs, 30 * 60 * 1_000),
      commandTimeoutMs,
      maxContextBytes: options.maxContextBytes,
      maxFailedVerificationAttempts: options.maxFailedVerificationAttempts,
      disableExtensions: options.disableExtensions,
    }),
    merger: new TransactionalDelegateMerger(session.workspaceRoot),
    depth: delegationDepth,
    maxDepth: delegationMaxDepth,
    maxConcurrent: boundedEnvironmentInteger("VANGUARD_DELEGATION_CONCURRENCY", 2, 1, 8),
    maxChildren: boundedEnvironmentInteger("VANGUARD_DELEGATION_MAX_CHILDREN", 6, 1, 16),
    maxChildSteps: Math.min(options.maxSteps, 80),
    maxTotalSteps: Math.max(Math.min(options.maxSteps * 2, 240), Math.min(options.maxSteps, 80)),
    onEvent: streamPublicEvent,
  });
  // A private sealed verifier must never become indirectly model-callable in
  // a child. Delegation is offered only when the parent has a distinct trusted
  // public check the child can use for post-mutation execution evidence.
  const delegationTools = delegationDepth < delegationMaxDepth && options.publicCheck !== undefined
    && options.agentProfile === "coder"
    ? createDelegationTools(delegation)
    : [];
  // Both durable states ride into every request as runtime-owned context.
  const workingState = {
    snapshot: () => ({
      checkpoint: checkpoint.snapshot(),
      plan: plan.snapshot(),
      delegations: JSON.parse(JSON.stringify(delegation.snapshot())) as JsonValue,
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    }),
  };
  const observer: StreamObserver = interactive
    ? combinedObserver(createStreamPresenter(markActivity), usage)
    : { delta: () => {}, usage: (value) => usage.record(value) };
  // Memory lives with the real project so it survives sessions; in isolated
  // sessions the source tree is the durable home, not the disposable copy.
  const repoMemory = new RepoMemoryStore(session.sourceRoot);
  const memoryAddendum = await repoMemory.addendum();
  const executionObserveTools = [
    new ListFilesTool(workspace),
    new SearchTextTool(workspace),
    new GlobTool(workspace),
    new ReadFileTool(workspace, 1_000_000, versions),
    new RepositoryMapTool(workspace, { includeInstructions: !options.disableExtensions }),
    new CodeIntelTool(workspace),
    new WebSearchTool(),
    new WebFetchTool(),
  ];
  // One checker instance serves both the model-facing tool and the runtime's
  // automatic post-mutation rung; its content-hash cache makes a model
  // re-check of an unchanged file free.
  const postMutationSyntaxChecker = new PostEditSyntaxChecker(new SyntaxCommandRunner(), workspace);
  const profileTools = options.agentProfile === "coder" ? [
      new RepoMemoryTool(repoMemory),
      new WriteFileTool(workspace, versions, mutationPolicy),
      new ReplaceTextTool(workspace, versions, mutationPolicy),
      new DeleteFileTool(workspace, versions, mutationPolicy),
      ...(session.direct === true ? [] : [new ReviewChangesTool(session.pristineRoot ?? session.sourceRoot, session.workspaceRoot)]),
      new HeadlessRenderTool(workspace),
      new ImageInspectionTool(workspace),
      new SyntaxCheckTool(postMutationSyntaxChecker),
      new CheckpointTool(checkpoint),
      new PlanTool(plan, evidenceResolver),
      ...delegationTools,
      ...(publicCheckTool === undefined ? [] : [publicCheckTool]),
      ...(options.exposeRawProcess ? [processTool] : []),
      ...extensionTools,
    ] : [];
  const kernel = new AgentKernel({
    model: createModel(options, observer),
    contextPolicy: new StickyContextPolicy({ retrievableEvidence: true }),
    tools: [
      new ListFilesTool(workspace),
      new SearchTextTool(workspace),
      new GlobTool(workspace),
      new ReadFileTool(workspace, 1_000_000, versions),
      // Compacted evidence stays reachable: long execution runs lose old tool
      // outputs from context, and re-reading a file is both slower and less
      // faithful than reading back what was actually observed at the time.
      new EvidenceReadTool(fileJournal),
      // The internal delegation loop: reconnaissance on a separate model
      // context that returns a digest instead of raw file contents.
      new ScoutDelegateTool(createModel(options), executionObserveTools),
      new CodeIntelTool(workspace),
      new RepositoryMapTool(workspace, { includeInstructions: !options.disableExtensions }),
      new WebSearchTool(),
      new WebFetchTool(),
      ...(skillTool === undefined ? [] : [skillTool]),
      ...profileTools,
    ].map(withToolHooks),
    verifiers,
    journal,
    workingState,
    // Boundary fingerprinting hashes the whole workspace several times per
    // step. That is the exact cost a direct session opts out of, so direct
    // runs skip the out-of-band change monitor; tool effects still drive
    // mutation epochs and evidence gates.
    ...(session.direct === true ? {} : {
      workspaceState: {
        fingerprint: (() => {
          // One stat-validated cache per built runtime: boundary fingerprints
          // run several times per step, and only changed files need re-hashing.
          const fingerprintCache = new TreeSnapshotCache();
          return async () => (await snapshotTree(session.workspaceRoot, {
            excludedDirectories: SESSION_EXCLUDED_DIRECTORIES,
            cache: fingerprintCache,
          })).rootHash;
        })(),
      },
    }),
    postMutationSyntaxCheck: async (relativePath) => {
      const result = await postMutationSyntaxChecker.check(relativePath);
      return { ok: result.ok, output: result as unknown as JsonValue };
    },
    plan,
    completionGates: [{ blockers: () => delegation.completionBlockers() }],
    taskAddendum: `${taskAddendum(options, mutationPolicy)}${options.agentProfile === "coder" ? "" : `\n\nThis is a runtime-enforced ${options.agentProfile} subagent. Only read-only workspace tools are available; return analysis, do not attempt edits.`}${session.direct === true
      ? "\n\nThis is a direct session: you are editing the real project with no isolated copy and no baseline, and no review_changes review tool exists. Rely on targeted reads, version control, and executable checks for confidence."
      : ""}${memoryAddendum}${skillsAddendum}`,
    ...(userChannel === undefined ? {} : { userChannel }),
    options: {
      maxSteps: options.maxSteps,
      maxContextBytes: options.maxContextBytes,
      maxRepeatedAction: 3,
      maxFailedVerificationAttempts: options.maxFailedVerificationAttempts,
      interactive,
      // A project with no build/test contract has no independent check to run,
      // so syntax is the strongest pre-claim evidence available.
      ...(options.executionEvidence === undefined ? {} : { executionEvidence: options.executionEvidence }),
    },
  });
  return {
    kernel,
    mutationPolicyDescription: mutationPolicy.describe(),
    ...(skillsAddendum.length === 0 ? {} : { taskAugmentation: skillsAddendum }),
    journalActivity,
    usage,
    delegationSnapshot: () => JSON.parse(JSON.stringify(delegation.snapshot())) as JsonValue,
    dispose: async () => {
      if (hookRunner !== undefined) {
        // after-run hooks are observational at teardown; a failure is
        // reported by the hook audit journal, never by masking run results.
        await hookRunner.run("after-run", new AbortController().signal).catch(() => {});
      }
      for (const close of extensionCloseables) await close().catch(() => {});
      await delegation.close();
    },
  };
}

export function taskAddendum(options: CliOptions, mutationPolicy: WorkspaceMutationPolicy): string {
  const adaptive = options.adaptiveVerification === true
    ? "\nVanguard expert-mode contract: own the implementation end to end. This project did not have a recognized verification contract at launch. Establish an appropriate deterministic build/test contract as part of the work, use check_project throughout, and finish only when the automatic trusted verifier passes."
    : "";
  const instructions = options.extensionInstructions === undefined || options.extensionInstructions.length === 0
    ? ""
    : `\n\nResolved project instructions (with recorded provenance):\n${options.extensionInstructions}`;
  return `Vanguard runtime mutation policy: ${mutationPolicy.describe()}${adaptive}${instructions}`;
}

export async function runWithBudgets(
  options: CliOptions,
  journalActivity: () => number,
  controller: AbortController,
  run: (signal: AbortSignal) => Promise<RunOutcome>,
): Promise<RunOutcome> {
  const durationTimer = setTimeout(() => controller.abort(), options.maxDurationMs);
  const heartbeatTimer = setInterval(() => {
    const quietMs = Date.now() - journalActivity();
    if (quietMs >= 45_000) {
      process.stderr.write(`[Vanguard] working: provider or tool response pending (${formatDuration(quietMs)} since last event)\n`);
    }
  }, 45_000);
  heartbeatTimer.unref();
  return run(controller.signal).finally(() => {
    clearTimeout(durationTimer);
    clearInterval(heartbeatTimer);
  });
}

function instrumentJournal(fileJournal: FileJournal): {
  journal: JournalPort;
  journalActivity: () => number;
  markActivity: () => void;
} {
  let lastProgressAt = Date.now();
  let modelTurns = 0;
  const presenter = new PublicRunEventPresenter();
  const markActivity = (): void => { lastProgressAt = Date.now(); };
  const journal: JournalPort = {
    async append(event: RunEvent): Promise<void> {
      await fileJournal.append(event);
      markActivity();
      for (const publicEvent of presenter.present(event)) streamPublicEvent(publicEvent);
      if (event.type === "model.decided") {
        modelTurns += 1;
        const decision = event.data as { kind?: string; calls?: { name?: string }[]; call?: { name?: string } };
        const action = decision.kind === "tools"
          ? (decision.calls ?? []).map((call) => call.name ?? "unknown tool").join(", ")
          : decision.kind === "tool" ? decision.call?.name ?? "unknown tool"
            : decision.kind === "complete" ? "completion claim"
              : decision.kind ?? "decision";
        process.stderr.write(`[Vanguard] turn ${modelTurns}: ${action}\n`);
      } else if (event.type === "verification.completed") {
        const verification = event.data as { verifier?: string; passed?: boolean };
        process.stderr.write(
          `[Vanguard] verifier ${verification.verifier ?? "unknown"}: ${verification.passed ? "passed" : "failed"}\n`,
        );
      } else if (event.type === "run.failed") {
        const failure = event.data as { reason?: string };
        process.stderr.write(`[Vanguard] stopped: ${failure.reason ?? "run failed"}\n`);
      }
    },
  };
  return { journal, journalActivity: () => lastProgressAt, markActivity };
}
