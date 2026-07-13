import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { NdjsonFramer, NdjsonWriter } from "../engine/ndjson.js";
import { createSecretRedactor } from "../engine/security.js";
import { WorkspaceBoundary } from "../runtime/workspace.js";
import type { McpServerDeclaration } from "./config.js";
import { ExtensionPermissionPolicy, validateJsonSchema, validateSchemaDefinition } from "./customTools.js";
import type { ExtensionAuditPort } from "./hooks.js";
import { compareOrdinal } from "../deterministicText.js";

const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26"]);

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: JsonValue;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: JsonValue };
}

interface PendingRequest {
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
}

export interface McpClientState {
  readonly server: string;
  readonly protocolVersion: string;
  readonly capabilities: JsonValue;
  readonly tools: readonly McpToolDescriptor[];
}

/** Bounded, allowlisted MCP stdio client. No SDK and no shell. */
export class McpStdioClient {
  readonly #writer: NdjsonWriter;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #redact: (text: string) => string;
  readonly #child: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #closed = false;
  #cleanupDone = false;
  #state: McpClientState | undefined;

  private constructor(
    private readonly declaration: McpServerDeclaration,
    private readonly policy: ExtensionPermissionPolicy,
    private readonly audit: ExtensionAuditPort,
    child: ChildProcessWithoutNullStreams,
    environment: NodeJS.ProcessEnv,
  ) {
    this.#child = child;
    this.#redact = createSecretRedactor(environment);
    this.#writer = new NdjsonWriter(child.stdin, {
      maxFrameBytes: declaration.maxFrameBytes,
      maxQueueBytes: declaration.maxFrameBytes * 4,
    });
    const framer = new NdjsonFramer({
      maxFrameBytes: declaration.maxFrameBytes,
      onFrame: (frame) => this.#receive(frame),
      onError: (code, message) => this.#fail(new Error(`MCP ${code}: ${message}`)),
    });
    child.stdout.on("data", (chunk: Buffer) => framer.push(chunk));
    child.stdout.on("end", () => framer.end());
    child.on("error", (error) => this.#fail(error));
    child.on("close", () => this.#fail(new Error(`MCP server '${declaration.name}' disconnected.`)));
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > declaration.maxFrameBytes) this.#fail(new Error("MCP stderr exceeded its bounded capacity."));
    });
  }

  static async connect(
    workspace: WorkspaceBoundary,
    declaration: McpServerDeclaration,
    policy: ExtensionPermissionPolicy,
    audit: ExtensionAuditPort,
    environment: NodeJS.ProcessEnv = process.env,
  ): Promise<McpStdioClient> {
    policy.authorizeServer(declaration.name);
    policy.authorizeCommand(declaration.command);
    const cwd = await workspace.existing(declaration.cwd);
    const child = spawn(declaration.command, [...declaration.args], {
      cwd,
      shell: false,
      windowsHide: true,
      env: safeEnvironment(environment),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new McpStdioClient(declaration, policy, audit, child, environment);
    await audit.record({ type: "mcp.lifecycle", name: declaration.name, status: "started", detail: { pid: child.pid ?? null } });
    try {
      await client.#initialize();
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  state(): McpClientState {
    if (this.#state === undefined) throw new Error("MCP client is not initialized.");
    return this.#state;
  }

  tools(namespace = `mcp_${this.declaration.name}`): readonly ToolPort[] {
    return this.state().tools.map((descriptor) => new McpToolPort(this, descriptor, namespace));
  }

  async callTool(name: string, input: JsonValue): Promise<ToolResult> {
    const descriptor = this.state().tools.find((tool) => tool.name === name);
    if (descriptor === undefined) return { ok: false, output: { error: `MCP tool '${name}' is not allowlisted.` } };
    const validation = validateJsonSchema(input, descriptor.inputSchema);
    if (validation.length > 0) return { ok: false, output: { error: "MCP tool input validation failed.", details: [...validation] } };
    try {
      const result = await this.#request("tools/call", { name, arguments: input });
      const bounded = JSON.stringify(result);
      if (bounded === undefined || Buffer.byteLength(bounded) > this.declaration.maxFrameBytes) {
        return { ok: false, output: { error: "MCP tool result exceeded its cap." } };
      }
      const redacted = redactJson(result, this.#redact);
      const isError = redacted !== null && !Array.isArray(redacted) && typeof redacted === "object" && redacted.isError === true;
      return { ok: !isError, output: redacted };
    } catch (error) {
      return { ok: false, output: { error: this.#redact(error instanceof Error ? error.message : String(error)) } };
    }
  }

  async close(): Promise<void> {
    if (this.#cleanupDone) return;
    this.#cleanupDone = true;
    this.#closed = true;
    this.#fail(new Error(`MCP server '${this.declaration.name}' closed.`));
    await this.#writer.close().catch(() => undefined);
    if (!this.#child.killed) this.#child.kill();
    await this.audit.record({ type: "mcp.lifecycle", name: this.declaration.name, status: "stopped", detail: {} });
  }

  async #initialize(): Promise<void> {
    const result = await this.#request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "vanguard", version: "0.1.0" },
    });
    if (result === null || Array.isArray(result) || typeof result !== "object") throw new Error("MCP initialize result is malformed.");
    const protocolVersion = result.protocolVersion;
    if (typeof protocolVersion !== "string" || !SUPPORTED_PROTOCOLS.has(protocolVersion)) {
      throw new Error(`MCP server selected unsupported protocol '${String(protocolVersion)}'.`);
    }
    const capabilities = result.capabilities;
    if (capabilities === null || Array.isArray(capabilities) || typeof capabilities !== "object") throw new Error("MCP capabilities are malformed.");
    await this.#notify("notifications/initialized", {});
    const listed = await this.#request("tools/list", {});
    if (listed === null || Array.isArray(listed) || typeof listed !== "object" || !Array.isArray(listed.tools)) {
      throw new Error("MCP tools/list result is malformed.");
    }
    const allowed = new Set(this.declaration.tools);
    const tools = listed.tools.map(parseToolDescriptor).filter((tool) => allowed.has(tool.name));
    const missing = this.declaration.tools.filter((name) => !tools.some((tool) => tool.name === name));
    if (missing.length > 0) throw new Error(`MCP server did not provide allowlisted tools: ${missing.join(", ")}.`);
    this.#state = { server: this.declaration.name, protocolVersion, capabilities, tools: tools.sort((a, b) => compareOrdinal(a.name, b.name)) };
  }

  #request(method: string, params: JsonValue): Promise<JsonValue> {
    if (this.#closed) return Promise.reject(new Error("MCP client is closed."));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out.`));
      }, this.declaration.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      void this.#writer.send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  #notify(method: string, params: JsonValue): Promise<void> {
    return this.#writer.send({ jsonrpc: "2.0", method, params });
  }

  #receive(frame: string): void {
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch {
      this.#fail(new Error("MCP server emitted malformed JSON."));
      return;
    }
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      this.#fail(new Error("MCP server emitted a non-object response."));
      return;
    }
    const response = value as Partial<JsonRpcResponse>;
    if (response.jsonrpc !== "2.0" || !Number.isSafeInteger(response.id)) {
      // Server notifications are ignored unless explicitly supported later.
      if (!("method" in value)) this.#fail(new Error("MCP response envelope is malformed."));
      return;
    }
    const pending = this.#pending.get(response.id!);
    if (pending === undefined) {
      this.#fail(new Error(`MCP response has unknown id '${response.id}'.`));
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(response.id!);
    if (response.error !== undefined) pending.reject(new Error(`MCP ${response.error.code}: ${response.error.message}`));
    else if (response.result === undefined) pending.reject(new Error("MCP response has neither result nor error."));
    else pending.resolve(response.result);
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    if (!this.#closed) {
      this.#closed = true;
      if (!this.#child.killed) this.#child.kill();
    }
  }
}

class McpToolPort implements ToolPort {
  readonly name: string;
  readonly definition: ToolDefinition;

  constructor(
    private readonly client: McpStdioClient,
    private readonly descriptor: McpToolDescriptor,
    namespace: string,
  ) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(namespace)) throw new Error("MCP namespace is invalid.");
    this.name = `${namespace}.${descriptor.name}`;
    this.definition = {
      name: this.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      effect: "execute",
    };
  }

  execute(input: JsonValue, _context: ToolContext): Promise<ToolResult> {
    return this.client.callTool(this.descriptor.name, input);
  }
}

function parseToolDescriptor(value: JsonValue): McpToolDescriptor {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error("MCP tool descriptor is malformed.");
  if (typeof value.name !== "string" || !/^[a-z][a-z0-9_.-]{0,127}$/i.test(value.name)) throw new Error("MCP tool name is invalid.");
  if (typeof value.description !== "string") throw new Error(`MCP tool '${value.name}' description is invalid.`);
  if (value.inputSchema === null || Array.isArray(value.inputSchema) || typeof value.inputSchema !== "object") {
    throw new Error(`MCP tool '${value.name}' input schema is invalid.`);
  }
  validateSchemaDefinition(value.inputSchema, `MCP tool '${value.name}' input schema`);
  return { name: value.name, description: value.description, inputSchema: value.inputSchema };
}

function redactJson(value: JsonValue, redact: (text: string) => string): JsonValue {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, redact));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactJson(child, redact)]));
  }
  return value;
}

function safeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = process.platform === "win32"
    ? ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "PATHEXT", "COMSPEC"]
    : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
  const safe: NodeJS.ProcessEnv = {};
  for (const name of names) if (environment[name] !== undefined) safe[name] = environment[name];
  safe.VANGUARD_MCP = "1";
  return safe;
}
