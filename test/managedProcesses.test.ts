import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PublicNetworkTargetPolicy,
  ServiceTool,
  SupervisedProcessRegistry,
  WebFetchTool,
  WorkspaceBoundary,
} from "../src/index.js";

const context = { task: "services", step: 1, signal: new AbortController().signal };

async function withRegistry<T>(
  body: (registry: SupervisedProcessRegistry, tool: ServiceTool) => Promise<T>,
  options: { readonly maxServices?: number; readonly readyTimeoutMs?: number } = {},
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-service-"));
  const registry = new SupervisedProcessRegistry(new WorkspaceBoundary(root), {
    allowedCommands: [process.execPath],
    readyTimeoutMs: options.readyTimeoutMs ?? 15_000,
    settleMs: 250,
    ...(options.maxServices === undefined ? {} : { maxServices: options.maxServices }),
  });
  try {
    return await body(registry, new ServiceTool(registry));
  } finally {
    await registry.stopAll().catch(() => []);
    // Closure is proven by the child's `close` event, but Windows releases the
    // working-directory handle a moment later; retry rather than flake.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

/** A server that announces its port, then serves until it is killed. */
const HTTP_SERVER = [
  "const http=require('node:http');",
  "const s=http.createServer((_q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end('<html><title>Live</title><body>service ok</body></html>');});",
  "s.listen(0,'127.0.0.1',()=>{console.log('listening on http://127.0.0.1:'+s.address().port);});",
].join("");

test("a service starts, reports readiness, and is reachable on its own port", async () => {
  await withRegistry(async (registry, tool) => {
    const started = await tool.execute({
      operation: "start",
      command: process.execPath,
      args: ["-e", HTTP_SERVER],
      readyPattern: "listening on",
    }, context);
    assert.equal(started.ok, true, JSON.stringify(started.output));
    const info = started.output as { handle: string; ready: boolean; running: boolean; ports: number[] };
    assert.equal(info.ready, true);
    assert.equal(info.running, true);
    assert.equal(info.ports.length >= 1, true, "the announced port is discovered");

    const port = info.ports[0]!;
    // The allowance comes from the registry, not from the caller.
    assert.equal(registry.allows("127.0.0.1", port), true);
    assert.equal(registry.allows("127.0.0.1", port + 1), false, "only a port a service actually holds");
    assert.equal(registry.allows("example.com", port), false, "loopback hosts only");

    // fetch_url can now reach the service the runtime started.
    const fetcher = new WebFetchTool({ targetPolicy: new PublicNetworkTargetPolicy(registry) });
    const page = await fetcher.execute({ url: `http://127.0.0.1:${port}/` }, context);
    assert.equal(page.ok, true, JSON.stringify(page.output));
    assert.match(String((page.output as { text: string }).text), /service ok/u);

    const stopped = await tool.execute({ operation: "stop", handle: info.handle }, context);
    assert.equal(stopped.ok, true, JSON.stringify(stopped.output));
    assert.equal((stopped.output as { directChildClosed: boolean }).directChildClosed, true);
    // Reachability dies with the service.
    assert.equal(registry.allows("127.0.0.1", port), false);
  });
});

test("a public fetch still refuses loopback that no service holds", async () => {
  await withRegistry(async (registry) => {
    const fetcher = new WebFetchTool({ targetPolicy: new PublicNetworkTargetPolicy(registry) });
    // A port no service holds stays refused — the allowance is not a blanket
    // loopback exemption, so the agent cannot reach 127.0.0.1:22.
    const ssh = await fetcher.execute({ url: "http://127.0.0.1:22/" }, context);
    assert.equal(ssh.ok, false);
    assert.match(String((ssh.output as { error: string }).error), /port/iu);
    // And the default port is still refused as a non-routable target.
    const bare = await fetcher.execute({ url: "http://127.0.0.1/" }, context);
    assert.equal(bare.ok, false);
    assert.match(String((bare.output as { error: string }).error), /private|non-routable|local/iu);
  });
});

test("a service that exits during startup reads as an ordinary failed command", async () => {
  await withRegistry(async (_registry, tool) => {
    const result = await tool.execute({
      operation: "start",
      command: process.execPath,
      args: ["-e", "console.log('boot');console.error('port in use');process.exit(3);"],
      readyPattern: "listening on",
    }, context);
    assert.equal(result.ok, false);
    const output = result.output as { error: string; exitCode: number; output: string };
    assert.match(output.error, /exited during startup/u);
    assert.equal(output.exitCode, 3);
    assert.match(output.output, /port in use/u);
  });
});

test("a quiet service is still ready, and logs page with explicit truncation", async () => {
  await withRegistry(async (registry, tool) => {
    // No ready pattern and no output: staying alive is the readiness signal.
    const quiet = await tool.execute({
      operation: "start",
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000);"],
    }, context);
    assert.equal(quiet.ok, true);
    assert.equal((quiet.output as { ready: boolean }).ready, true);

    const chatty = await tool.execute({
      operation: "start",
      command: process.execPath,
      args: ["-e", "for(let i=0;i<200;i++)console.log('line '+i);setInterval(()=>{},1000);"],
      readyPattern: "line 199",
    }, context);
    assert.equal(chatty.ok, true);
    const handle = (chatty.output as { handle: string }).handle;

    const firstPage = await tool.execute({ operation: "logs", handle, maxBytes: 256 }, context);
    assert.equal(firstPage.ok, true);
    const page = firstPage.output as { output: string; truncated: boolean; nextOffset?: number; droppedBytes: number };
    assert.equal(page.truncated, true);
    assert.equal(page.droppedBytes, 0);
    assert.match(page.output, /line 0/u);
    const second = await tool.execute({ operation: "logs", handle, offset: page.nextOffset ?? 0, maxBytes: 256 }, context);
    assert.equal(second.ok, true);
    assert.notEqual((second.output as { output: string }).output, page.output);

    const listed = await tool.execute({ operation: "list" }, context);
    assert.equal((listed.output as { services: unknown[] }).services.length, 2);
    assert.equal(registry.live().length, 2);
  });
});

test("the service count is bounded and stopAll sweeps everything", async () => {
  await withRegistry(async (registry, tool) => {
    for (let index = 0; index < 2; index += 1) {
      const started = await tool.execute({
        operation: "start",
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000);"],
      }, context);
      assert.equal(started.ok, true);
    }
    const refused = await tool.execute({
      operation: "start",
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000);"],
    }, context);
    assert.equal(refused.ok, false);
    assert.match(String((refused.output as { error: string }).error), /At most 2 services/u);

    const swept = await registry.stopAll();
    assert.equal(swept.length, 2);
    assert.equal(registry.live().length, 0);
  }, { maxServices: 2 });
});

test("a service tree dies with its wrapper instead of orphaning grandchildren", async () => {
  await withRegistry(async (registry, tool) => {
    // The Godot shape: a wrapper whose real work is a grandchild. Stopping the
    // wrapper must take the whole tree, and closure must be provable.
    const started = await tool.execute({
      operation: "start",
      command: process.execPath,
      args: ["-e", [
        "const {spawn}=require('node:child_process');",
        "spawn(process.execPath,['-e','setInterval(()=>{},1000);'],{stdio:'inherit'});",
        "console.log('wrapper up');",
        "setInterval(()=>{},1000);",
      ].join("")],
      readyPattern: "wrapper up",
    }, context);
    assert.equal(started.ok, true);
    const handle = (started.output as { handle: string }).handle;

    const stopped = await tool.execute({ operation: "stop", handle }, context);
    assert.equal(stopped.ok, true, JSON.stringify(stopped.output));
    const output = stopped.output as { directChildClosed: boolean; containmentUncertain?: boolean };
    assert.equal(output.directChildClosed, true);
    assert.notEqual(output.containmentUncertain, true, "tree termination must prove closure");

    const status = await tool.execute({ operation: "status", handle }, context);
    assert.equal((status.output as { running: boolean }).running, false);
    assert.equal(registry.live().length, 0);
  });
});

test("unknown handles and unknown operations fail without throwing", async () => {
  await withRegistry(async (_registry, tool) => {
    const missing = await tool.execute({ operation: "status", handle: "service-99" }, context);
    assert.equal(missing.ok, false);
    assert.match(String((missing.output as { error: string }).error), /No service/u);

    const blockedCommand = await tool.execute({
      operation: "start",
      command: "definitely-not-allowlisted",
      args: [],
    }, context);
    assert.equal(blockedCommand.ok, false);
    assert.match(String((blockedCommand.output as { error: string }).error), /not allowed/u);

    const badPattern = await tool.execute({
      operation: "start",
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000);"],
      readyPattern: "([",
    }, context);
    assert.equal(badPattern.ok, false);
    assert.match(String((badPattern.output as { error: string }).error), /regular expression/u);
  });
});
