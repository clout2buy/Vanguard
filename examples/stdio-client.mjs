// Minimal external-agent adapter for `vanguard serve --stdio`.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = new URL("../dist/src/cli.js", import.meta.url);
const child = spawn(process.execPath, [fileURLToPath(cli), "serve", "--stdio"], {
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
});

let nextId = 1;
const pending = new Map();
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const frame = JSON.parse(line);
    if (frame.type === "event") {
      process.stdout.write(`[${frame.sessionId} #${frame.cursor}] ${frame.event.type}\n`);
      continue;
    }
    pending.get(frame.id)?.(frame);
    pending.delete(frame.id);
  }
});

function request(operation, params = {}) {
  const id = String(nextId++);
  child.stdin.write(`${JSON.stringify({ type: "request", id, protocolVersion: 1, operation, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, (frame) => frame.ok ? resolve(frame.result) : reject(new Error(`${frame.error.code}: ${frame.error.message}`)));
  });
}

try {
  await request("handshake", { versions: [1], client: { name: "example", version: "1" } });
  const session = await request("create", {
    config: {
      workspace: process.argv[2] ?? process.cwd(),
      provider: process.env.VANGUARD_PROVIDER ?? "deepseek",
      model: process.env.VANGUARD_MODEL ?? "deepseek-v4-pro",
    },
  });
  await request("advance", { sessionId: session.sessionId, message: "Explain this repository without changing it." });
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  child.stdin.end();
  process.exitCode = 1;
}
