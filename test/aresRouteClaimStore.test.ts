import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  link,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ARES_ROUTE_CLAIM_CAPABILITY,
  AresRouteClaimStoreError,
  FileAresRouteClaimStore,
  aresAdapterSessionIdForOperationDigest,
  aresRouteClaimDigest,
  aresRouteOperationDigest,
  aresUpstreamIdentityDigest,
  validateAresDurableRouteClaim,
  validateAresDurableRouteReceipt,
  type AresClaimedCore,
  type AresRouteClaimRequest,
} from "../src/integration/aresRouteClaimStore.js";

const INPUT_A = sha("canonical-input-a");
const INPUT_B = sha("canonical-input-b");
const POLICY_A = sha("policy-a");
const POLICY_B = sha("policy-b");

test("route claim is durable, deterministic, private, immutable, and policy drift cannot change its core", async () => {
  const fixture = await createFixture("basic");
  const operationId = operation(1);
  try {
    const store = new FileAresRouteClaimStore({ root: fixture.store });
    assert.deepEqual(store.capabilities(), [ARES_ROUTE_CLAIM_CAPABILITY]);
    const first = await store.claim(request(operationId, "vanguard", INPUT_A, POLICY_A));
    const operationIdSha256 = aresRouteOperationDigest(operationId);
    assert.equal(first.created, true);
    assert.equal(first.claim.operationIdSha256, operationIdSha256);
    assert.equal(first.claim.adapterSessionId, aresAdapterSessionIdForOperationDigest(operationIdSha256));
    assert.equal(first.claim.chosenCore, "vanguard");
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.claim), true);
    assert.throws(() => { (first.claim as { chosenCore: string }).chosenCore = "legacy"; }, TypeError);
    assert.doesNotThrow(() => validateAresDurableRouteClaim(first.claim));

    const drifted = await store.claim(request(operationId, "legacy", INPUT_A, POLICY_B));
    assert.equal(drifted.created, false);
    assert.deepEqual(drifted.claim, first.claim, "the first durable route and policy win permanently");

    const restarted = new FileAresRouteClaimStore({ root: fixture.store });
    assert.deepEqual(await restarted.read(operationId), first.claim);
    const operationNames = await readdir(path.join(fixture.store, "operations"));
    assert.deepEqual(operationNames, [operationIdSha256]);
    const persisted = await allFileContents(fixture.store);
    assert.equal(persisted.includes(operationId), false, "raw operation IDs are never persisted");
    assert.equal("delete" in store || "clear" in store || "gc" in store, false, "the store has no record-reuse API");
  } finally {
    await fixture.cleanup();
  }
});

test("closed schemas and bounded scalar admission fail before creating records", async () => {
  const fixture = await createFixture("admission");
  try {
    assert.throws(() => new FileAresRouteClaimStore({ root: "relative" }), /absolute path/i);
    const store = new FileAresRouteClaimStore({ root: fixture.store });
    await assert.rejects(() => store.claim({
      ...request(operation(2), "vanguard", INPUT_A, POLICY_A),
      surprise: true,
    } as never), hasCode("invalid_route_claim_request"));
    await assert.rejects(() => store.claim(request("not-an-operation", "vanguard", INPUT_A, POLICY_A)), /operationId/i);
    await assert.rejects(() => store.claim(request(operation(2), "vanguard", "A".repeat(64), POLICY_A)), /SHA-256/i);

    const accessor = request(operation(2), "vanguard", INPUT_A, POLICY_A) as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "policySha256", { enumerable: true, get: () => POLICY_A });
    await assert.rejects(() => store.claim(accessor as never), /data properties/i);
    assert.deepEqual(await readdir(path.join(fixture.store, "operations")), []);
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent independent store instances atomically converge on one route claim", async () => {
  const fixture = await createFixture("claim-race");
  const operationId = operation(3);
  try {
    const stores = Array.from({ length: 16 }, () => new FileAresRouteClaimStore({ root: fixture.store }));
    const results = await Promise.all(stores.map((store, index) => store.claim(request(
      operationId,
      index % 2 === 0 ? "vanguard" : "legacy",
      INPUT_A,
      index % 2 === 0 ? POLICY_A : POLICY_B,
    ))));
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(new Set(results.map((result) => JSON.stringify(result.claim))).size, 1);
    assert.equal((await readdir(path.join(fixture.store, "operations"))).length, 1);
    await assert.rejects(
      () => stores[0]!.claim(request(operationId, "vanguard", INPUT_B, POLICY_A)),
      hasCode("route_claim_conflict"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("separate Node processes converge through the filesystem CAS", async () => {
  const fixture = await createFixture("process-race");
  const operationId = operation(30);
  try {
    const moduleUrl = new URL("../src/integration/aresRouteClaimStore.js", import.meta.url).href;
    const results = await Promise.all([
      runClaimProcess(moduleUrl, fixture.store, request(operationId, "vanguard", INPUT_A, POLICY_A)),
      runClaimProcess(moduleUrl, fixture.store, request(operationId, "legacy", INPUT_A, POLICY_B)),
    ]);
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(new Set(results.map((result) => JSON.stringify(result.claim))).size, 1);
    assert.deepEqual(
      await new FileAresRouteClaimStore({ root: fixture.store }).read(operationId),
      results[0]!.claim,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("receipt is claim-bound and idempotent, while its global identity index contains no raw upstream ID", async () => {
  const fixture = await createFixture("receipt");
  const operationId = operation(4);
  const upstreamSessionId = "vanguard-session-receipt-4";
  try {
    const store = new FileAresRouteClaimStore({ root: fixture.store });
    const claimed = await store.claim(request(operationId, "vanguard", INPUT_A, POLICY_A));
    const first = await store.commitReceipt({ operationId, source: "vanguard", upstreamSessionId });
    assert.equal(first.created, true);
    assert.equal(first.receipt.claimSha256, aresRouteClaimDigest(claimed.claim));
    assert.equal(first.receipt.upstreamIdentitySha256, aresUpstreamIdentityDigest("vanguard", upstreamSessionId));
    assert.equal(Object.isFrozen(first.receipt), true);
    assert.doesNotThrow(() => validateAresDurableRouteReceipt(first.receipt));

    const restarted = new FileAresRouteClaimStore({ root: fixture.store });
    const replay = await restarted.commitReceipt({ operationId, source: "vanguard", upstreamSessionId });
    assert.equal(replay.created, false);
    assert.deepEqual(await restarted.readReceipt(operationId), first.receipt);
    await assert.rejects(
      () => restarted.commitReceipt({ operationId, source: "legacy", upstreamSessionId }),
      hasCode("route_receipt_conflict"),
    );
    await assert.rejects(
      () => restarted.commitReceipt({ operationId, source: "vanguard", upstreamSessionId: "different-session" }),
      hasCode("route_receipt_conflict"),
    );
    const identityFile = path.join(
      fixture.store,
      "identities",
      first.receipt.upstreamIdentitySha256,
      "binding.json",
    );
    assert.equal((await readFile(identityFile, "utf8")).includes(upstreamSessionId), false);
  } finally {
    await fixture.cleanup();
  }
});

test("global identity CAS permits exactly one operation to own an upstream session across processes", async () => {
  const fixture = await createFixture("identity-race");
  const firstOperation = operation(5);
  const secondOperation = operation(6);
  const sharedUpstream = "shared-upstream-session";
  try {
    const firstStore = new FileAresRouteClaimStore({ root: fixture.store });
    const secondStore = new FileAresRouteClaimStore({ root: fixture.store });
    await Promise.all([
      firstStore.claim(request(firstOperation, "vanguard", INPUT_A, POLICY_A)),
      secondStore.claim(request(secondOperation, "vanguard", INPUT_B, POLICY_A)),
    ]);
    const raced = await Promise.allSettled([
      firstStore.commitReceipt({ operationId: firstOperation, source: "vanguard", upstreamSessionId: sharedUpstream }),
      secondStore.commitReceipt({ operationId: secondOperation, source: "vanguard", upstreamSessionId: sharedUpstream }),
    ]);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(raced.filter((result) => result.status === "rejected").length, 1);
    const winnerIsFirst = raced[0]!.status === "fulfilled";
    const loserStore = winnerIsFirst ? secondStore : firstStore;
    const loserOperation = winnerIsFirst ? secondOperation : firstOperation;
    assert.equal(await loserStore.readReceipt(loserOperation), undefined);
    const recovered = await loserStore.commitReceipt({
      operationId: loserOperation,
      source: "vanguard",
      upstreamSessionId: "unique-recovery-session",
    });
    assert.equal(recovered.created, true);
  } finally {
    await fixture.cleanup();
  }
});

test("contradictory same-operation receipts leave conservative identity poison, never silent success", async () => {
  const fixture = await createFixture("receipt-poison");
  const operationId = operation(31);
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const faultInjector = async (point: string): Promise<void> => {
    if (point !== "identity_published") return;
    arrivals += 1;
    if (arrivals === 2) release();
    await gate;
  };
  try {
    const seed = new FileAresRouteClaimStore({ root: fixture.store });
    await seed.claim(request(operationId, "vanguard", INPUT_A, POLICY_A));
    const first = new FileAresRouteClaimStore({ root: fixture.store, faultInjector });
    const second = new FileAresRouteClaimStore({ root: fixture.store, faultInjector });
    const raced = await Promise.allSettled([
      first.commitReceipt({ operationId, source: "vanguard", upstreamSessionId: "contradiction-a" }),
      second.commitReceipt({ operationId, source: "vanguard", upstreamSessionId: "contradiction-b" }),
    ]);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(raced.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await readdir(path.join(fixture.store, "identities"))).length, 2,
      "index-first publication conservatively reserves both contradictory identities");
    const receipt = await seed.readReceipt(operationId);
    assert.notEqual(receipt, undefined);
    const losingIdentity = receipt!.upstreamSessionId === "contradiction-a" ? "contradiction-b" : "contradiction-a";
    await assert.rejects(
      () => seed.commitReceipt({ operationId, source: "vanguard", upstreamSessionId: losingIdentity }),
      hasCode("route_receipt_conflict"),
    );
  } finally {
    release?.();
    await fixture.cleanup();
  }
});

test("every publication crash seam is recoverable without changing route or duplicating identity", async () => {
  const fixture = await createFixture("crash-seams");
  const operationId = operation(7);
  try {
    const crashAfterClaim = new FileAresRouteClaimStore({
      root: fixture.store,
      faultInjector(point) {
        if (point === "claim_published") throw new Error("crash after claim");
      },
    });
    await assert.rejects(() => crashAfterClaim.claim(request(operationId, "vanguard", INPUT_A, POLICY_A)), /crash after claim/);
    const recovered = new FileAresRouteClaimStore({ root: fixture.store });
    const claim = await recovered.claim(request(operationId, "legacy", INPUT_A, POLICY_B));
    assert.equal(claim.created, false);
    assert.equal(claim.claim.chosenCore, "vanguard");
    const claimFile = operationFile(fixture.store, operationId, "claim.json");
    const crashAlias = `${claimFile}.crash-window.tmp`;
    await link(claimFile, crashAlias);
    assert.deepEqual(await recovered.read(operationId), claim.claim);
    await assert.rejects(() => readFile(crashAlias), /ENOENT/u,
      "recovery removes a crash-left hard-link alias of the authoritative record");

    const crashAfterIdentity = new FileAresRouteClaimStore({
      root: fixture.store,
      faultInjector(point) {
        if (point === "identity_published") throw new Error("crash after identity");
      },
    });
    await assert.rejects(() => crashAfterIdentity.commitReceipt({
      operationId,
      source: "vanguard",
      upstreamSessionId: "crash-seam-upstream",
    }), /crash after identity/);
    assert.equal(await recovered.readReceipt(operationId), undefined);
    assert.equal((await recovered.commitReceipt({
      operationId,
      source: "vanguard",
      upstreamSessionId: "crash-seam-upstream",
    })).created, true);

    const receiptCrashOperation = operation(70);
    await recovered.claim(request(receiptCrashOperation, "legacy", INPUT_B, POLICY_B));
    const crashAfterReceipt = new FileAresRouteClaimStore({
      root: fixture.store,
      faultInjector(point) {
        if (point === "receipt_published") throw new Error("crash after receipt");
      },
    });
    await assert.rejects(() => crashAfterReceipt.commitReceipt({
      operationId: receiptCrashOperation,
      source: "legacy",
      upstreamSessionId: "crash-after-receipt-upstream",
    }), /crash after receipt/);
    assert.equal((await recovered.commitReceipt({
      operationId: receiptCrashOperation,
      source: "legacy",
      upstreamSessionId: "crash-after-receipt-upstream",
    })).created, false);
  } finally {
    await fixture.cleanup();
  }
});

test("torn JSON, semantic tampering, and identity-index tampering fail closed", async () => {
  const claimFixture = await createFixture("claim-tamper");
  try {
    const operationId = operation(8);
    const store = new FileAresRouteClaimStore({ root: claimFixture.store });
    await store.claim(request(operationId, "vanguard", INPUT_A, POLICY_A));
    const claimFile = operationFile(claimFixture.store, operationId, "claim.json");
    const envelope = JSON.parse(await readFile(claimFile, "utf8")) as { payload: { chosenCore: string } };
    envelope.payload.chosenCore = "legacy";
    await writeFile(claimFile, JSON.stringify(envelope), { mode: 0o600 });
    await assert.rejects(() => new FileAresRouteClaimStore({ root: claimFixture.store }).read(operationId), /integrity/i);
  } finally {
    await claimFixture.cleanup();
  }

  const receiptFixture = await createFixture("receipt-tamper");
  try {
    const operationId = operation(9);
    const store = new FileAresRouteClaimStore({ root: receiptFixture.store });
    await store.claim(request(operationId, "vanguard", INPUT_A, POLICY_A));
    const receipt = await store.commitReceipt({
      operationId,
      source: "vanguard",
      upstreamSessionId: "tamper-upstream",
    });
    const bindingFile = path.join(
      receiptFixture.store,
      "identities",
      receipt.receipt.upstreamIdentitySha256,
      "binding.json",
    );
    await writeFile(bindingFile, "{", { mode: 0o600 });
    await assert.rejects(() => store.readReceipt(operationId), /malformed|bounded/i);
  } finally {
    await receiptFixture.cleanup();
  }
});

test("root, record-directory, and record-file symbolic links or junctions are never followed", async (context) => {
  const container = await mkdtemp(path.join(os.tmpdir(), "vanguard-route-links-"));
  const outside = path.join(container, "outside");
  const linkedRoot = path.join(container, "linked-store");
  await mkdir(outside, { mode: 0o700 });
  try {
    try {
      await symlink(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`link creation unavailable: ${String(error)}`);
      return;
    }
    const linked = new FileAresRouteClaimStore({ root: linkedRoot });
    await assert.rejects(() => linked.claim(request(operation(10), "vanguard", INPUT_A, POLICY_A)), /link|junction|real directory/i);

    const realRoot = path.join(container, "real-store");
    const store = new FileAresRouteClaimStore({ root: realRoot });
    await store.claim(request(operation(11), "vanguard", INPUT_A, POLICY_A));
    const operations = path.join(realRoot, "operations");
    const moved = path.join(realRoot, "operations-original");
    await rename(operations, moved);
    await symlink(outside, operations, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => store.claim(request(operation(12), "legacy", INPUT_B, POLICY_B)), /real directory|replaced|link/i);
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

function request(
  operationId: string,
  proposedCore: AresClaimedCore,
  inputFingerprintSha256: string,
  policySha256: string,
): AresRouteClaimRequest {
  return { operationId, inputFingerprintSha256, proposedCore, policySha256 };
}

function operation(index: number): string {
  return `op_${index.toString(16).padStart(32, "0")}`;
}

function operationFile(root: string, operationId: string, name: string): string {
  return path.join(root, "operations", aresRouteOperationDigest(operationId), name);
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AresRouteClaimStoreError && error.code === code;
}

async function createFixture(label: string): Promise<{
  store: string;
  cleanup: () => Promise<void>;
}> {
  const container = await mkdtemp(path.join(os.tmpdir(), `vanguard-route-${label}-`));
  return {
    store: path.join(container, "store"),
    cleanup: () => rm(container, { recursive: true, force: true }),
  };
}

async function allFileContents(root: string): Promise<string> {
  const contents: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) contents.push(await readFile(absolute, "utf8"));
    }
  }
  await visit(root);
  return contents.join("\n");
}

async function runClaimProcess(
  moduleUrl: string,
  root: string,
  claimRequest: AresRouteClaimRequest,
): Promise<{ created: boolean; claim: unknown }> {
  const program = [
    `const { FileAresRouteClaimStore } = await import(process.env.ROUTE_STORE_MODULE);`,
    `const request = JSON.parse(Buffer.from(process.env.ROUTE_STORE_REQUEST, "base64").toString("utf8"));`,
    `const result = await new FileAresRouteClaimStore({ root: process.env.ROUTE_STORE_ROOT }).claim(request);`,
    `process.stdout.write(JSON.stringify(result));`,
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
      env: {
        ...process.env,
        ROUTE_STORE_MODULE: moduleUrl,
        ROUTE_STORE_ROOT: root,
        ROUTE_STORE_REQUEST: Buffer.from(JSON.stringify(claimRequest), "utf8").toString("base64"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`route-store child failed (${String(code)}): ${stderr}`));
      else resolve(JSON.parse(stdout) as { created: boolean; claim: unknown });
    });
  });
}
