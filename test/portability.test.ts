import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { nodePermissionFlag, resolveNodePackageManagerAlias } from "../src/runtime/nodePackageManager.js";

const compiledCli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function closeOf(child: ChildProcessWithoutNullStreams, timeoutMs = 10_000): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("child process did not exit before the portability timeout"));
    }, timeoutMs);
    timeout.unref?.();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function waitForLine(child: ChildProcessWithoutNullStreams, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error("stdio server did not answer before timeout")), timeoutMs);
    timeout.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      resolve(buffer.slice(0, newline).replace(/\r$/u, ""));
    });
  });
}

test("compiled CLI resolves and runs from a Unicode path containing spaces", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "vanguard path \u03A9 "));
  try {
    const result = spawnSync(process.execPath, [compiledCli, "--help"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Vanguard expert coding agent/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("real stdio CLI accepts split UTF-8/CRLF handshake frames and closes cleanly on EOF", { timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, [compiledCli, "serve", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const closed = closeOf(child);
  const handshake = JSON.stringify({
    type: "request",
    id: "portable-\u03A9",
    protocolVersion: 1,
    operation: "handshake",
    params: { versions: [1] },
  });
  const bytes = Buffer.from(`${handshake}\r\n`, "utf8");
  child.stdin.write(bytes.subarray(0, 11));
  child.stdin.write(bytes.subarray(11, 19));
  child.stdin.write(bytes.subarray(19));
  const frame = JSON.parse(await waitForLine(child)) as { id?: string; ok?: boolean; result?: { protocolVersion?: number } };
  assert.equal(frame.id, "portable-\u03A9");
  assert.equal(frame.ok, true);
  assert.equal(frame.result?.protocolVersion, 1);
  child.stdin.end();
  const exit = await closed;
  assert.equal(exit.code, 0);
});

test("real stdio CLI obeys host termination without leaving a child behind", { timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, [compiledCli, "serve", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const closed = closeOf(child);
  assert.equal(child.kill(), true);
  const exit = await closed;
  assert.equal(exit.code !== null || exit.signal !== null, true);
});

test("native platform launcher forwards arguments and exit status", async (context) => {
  if (process.platform === "win32") {
    const script = path.join(repositoryRoot, "scripts", "vanguard.ps1");
    const result = spawnSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "--help",
    ], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Vanguard expert coding agent/u);
    return;
  }
  const script = path.join(repositoryRoot, "scripts", "vanguard");
  await chmod(script, 0o755);
  const result = spawnSync(script, ["--help"], { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    context.skip("POSIX shell is unavailable on this host");
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Vanguard expert coding agent/u);
});

test("declared Node support and portable path behavior are explicit", async () => {
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(repositoryRoot, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };
  assert.equal(manifest.engines?.node, ">=20.19 <25");
  assert.equal(path.posix.normalize("/workspace/src/../test"), "/workspace/test");
  assert.equal(path.win32.normalize("C:\\workspace\\src\\..\\test"), "C:\\workspace\\test");
});

test("npm and npx resolution follows npm_execpath outside the Node installation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vanguard portable npm "));
  try {
    const npmBin = path.join(root, "portable npm", "bin");
    await mkdir(npmBin, { recursive: true });
    const npmCli = path.join(npmBin, "npm-cli.js");
    const npxCli = path.join(npmBin, "npx-cli.js");
    await writeFile(npmCli, "// fixture\n", "utf8");
    await writeFile(npxCli, "// fixture\n", "utf8");
    const nodeExecutable = path.join(root, "standalone node", "node.exe");
    const environment = { npm_execpath: npmCli, PATH: "" };
    assert.deepEqual(resolveNodePackageManagerAlias("npm", environment, nodeExecutable), {
      executable: nodeExecutable,
      argsPrefix: [npmCli],
    });
    assert.deepEqual(resolveNodePackageManagerAlias("npx", environment, nodeExecutable), {
      executable: nodeExecutable,
      argsPrefix: [npxCli],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm resolution fails closed when no shell-free JavaScript entry point exists", () => {
  const absentNode = path.join(tmpdir(), "vanguard-absent-node", "node.exe");
  assert.equal(resolveNodePackageManagerAlias("npm", { PATH: "" }, absentNode), undefined);
});

test("Node permission flag follows the supported runtime generation", () => {
  assert.equal(nodePermissionFlag("20.19.0"), "--experimental-permission");
  assert.equal(nodePermissionFlag("22.0.0"), "--permission");
  assert.equal(nodePermissionFlag("24.4.1"), "--permission");
  assert.throws(() => nodePermissionFlag("not-a-version"), /Unsupported Node version/u);
});
