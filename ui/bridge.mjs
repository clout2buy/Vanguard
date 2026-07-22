// Vanguard UI bridge — connects the browser UI to the real kernel.
//
//   node ui/bridge.mjs  →  http://localhost:4173
//
// One embedded VanguardEngine (from dist/) drives everything:
//   GET  /api/providers            live readiness + catalog models
//   POST /api/login/:provider      opens the real OAuth flow in the browser
//   POST /api/session              {provider, model, auth, workspace} → create
//   POST /api/session/:id/advance  {message} → start/continue the run
//   POST /api/session/:id/steer    {message} → boundary-safe steering
//   POST /api/session/:id/cancel   → cancel the current generation
//   GET  /api/session/:id/status   → current state
//   GET  /api/events               SSE tap on the sanitized public event stream
//
// Bound to loopback only; no dependencies beyond Node and dist/src/index.js.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VanguardEngine,
  PROVIDER_CHOICES,
  catalogModels,
  defaultModel,
  supportsOAuth,
  oauthStatus,
  oauthLogin,
  credentialVariable,
} from '../dist/src/index.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const port = process.env.PORT ? Number(process.env.PORT) : 4173;
const host = '127.0.0.1';

const CREDENTIAL_VARIABLES = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

/**
 * Store a pasted API key exactly where the TUI keeps it: the DPAPI-encrypted
 * project secret store (.vanguard/secrets), and in this bridge's own
 * environment so it works immediately. The key never leaves loopback and is
 * never written back to any response.
 */
async function storeCredential(provider, key) {
  const variable = CREDENTIAL_VARIABLES[provider];
  if (variable === undefined) throw new Error('unsupported_provider');
  process.env[variable] = key;
  if (process.platform !== 'win32') return { persisted: false };
  // ConvertFrom-SecureString produces the same DPAPI blob set-project-secret.ps1 writes.
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$secure = [Console]::In.ReadToEnd().Trim() | ConvertTo-SecureString -AsPlainText -Force',
    `$dir = ${JSON.stringify(join(repoRoot, '.vanguard', 'secrets'))}`,
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    `$file = Join-Path $dir ${JSON.stringify(`${variable}.dpapi`)}`,
    '$secure | ConvertFrom-SecureString | Set-Content -LiteralPath $file -Encoding UTF8',
    '"stored"',
  ].join('; ');
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => resolve({ persisted: false }));
    child.on('close', (code) => resolve({ persisted: code === 0 && out.trim() === 'stored' }));
    child.stdin.end(key, 'utf8');
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const engine = new VanguardEngine({ logger: (line) => process.stderr.write(`[kernel] ${line}\n`) });

// ---------- SSE tap ----------
const sseClients = new Set();
engine.subscribe(({ sessionId, cursor, event }) => {
  broadcast({ sessionId, cursor, event });
});
function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { sseClients.delete(res); }
  }
}
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(': heartbeat\n\n'); } catch { sseClients.delete(res); }
  }
}, 15000).unref();

// ---------- provider readiness (mirrors the TUI launch selector) ----------
async function providerCards() {
  return Promise.all(PROVIDER_CHOICES.map(async (choice) => {
    let auth = choice.auth[0];
    let ready = false;
    let detail = '';
    if (choice.id === 'ollama') {
      ready = true;
      detail = 'live local + Cloud discovery';
      auth = 'api-key';
    } else if (supportsOAuth(choice.id)) {
      const status = await oauthStatus(choice.id);
      if (status.connected) {
        ready = true;
        auth = 'oauth';
        detail = status.expired === true
          ? 'signed in · token will refresh'
          : `signed in${status.account ? ` as ${status.account}` : ''}${status.plan ? ` · ${status.plan}` : ''}`;
      }
    }
    if (!ready && process.env[credentialVariable(choice.id)]) {
      ready = true;
      auth = 'api-key';
      detail = `${credentialVariable(choice.id)} set`;
    }
    if (!ready && !detail) {
      detail = supportsOAuth(choice.id) ? 'sign-in required' : `${choice.credentialVariable} not set`;
    }
    return {
      id: choice.id,
      label: choice.label,
      auth,
      ready,
      detail,
      models: catalogModels(choice.id, auth),
      defaultModel: catalogModels(choice.id, auth)[0]?.id ?? defaultModel(choice.id),
    };
  }));
}

// ---------- http helpers ----------
function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) { reject(new Error('body_too_large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  let rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if (rel === '' || rel.endsWith('/') || rel.endsWith('\\')) rel = join(rel, 'index.html');
  const file = join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

// ---------- routes ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  try {
    if (path === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (path === '/api/providers' && req.method === 'GET') {
      sendJson(res, 200, { providers: await providerCards() });
      return;
    }

    if (path === '/api/credential' && req.method === 'POST') {
      const body = await readBody(req);
      const provider = String(body.provider ?? '');
      const key = String(body.key ?? '').trim();
      if (CREDENTIAL_VARIABLES[provider] === undefined) { sendJson(res, 400, { error: 'unsupported_provider' }); return; }
      if (key.length < 8) { sendJson(res, 400, { error: 'key_too_short' }); return; }
      const { persisted } = await storeCredential(provider, key);
      sendJson(res, 200, { ok: true, persisted });
      return;
    }

    const loginMatch = path.match(/^\/api\/login\/([a-z]+)$/);
    if (loginMatch && req.method === 'POST') {
      const provider = loginMatch[1];
      if (!supportsOAuth(provider)) { sendJson(res, 400, { error: 'oauth_not_supported' }); return; }
      // The real flow opens the user's browser and blocks until tokens are
      // stored (5 min timeout inside); the UI polls /api/providers meanwhile.
      const status = await oauthLogin(provider);
      sendJson(res, 200, { connected: status.connected, account: status.account });
      return;
    }

    if (path === '/api/session' && req.method === 'POST') {
      const body = await readBody(req);
      const card = (await providerCards()).find((c) => c.id === body.provider);
      if (!card) { sendJson(res, 400, { error: 'unknown_provider', message: String(body.provider) }); return; }
      if (!card.ready) { sendJson(res, 409, { error: 'provider_not_ready', message: card.detail }); return; }
      const session = await engine.create({
        workspace: typeof body.workspace === 'string' && body.workspace.trim() ? body.workspace.trim() : process.cwd(),
        provider: card.id,
        model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : card.defaultModel,
        auth: card.auth,
        ...(body.securityProfile === 'guarded' ? { securityProfile: 'guarded' } : {}),
        ...(Number.isInteger(body.maxSteps) && body.maxSteps > 0 ? { maxSteps: body.maxSteps } : {}),
      });
      sendJson(res, 200, { session });
      return;
    }

    const sessionMatch = path.match(/^\/api\/session\/([^/]+)\/(advance|steer|cancel|status|state)$/);
    if (sessionMatch) {
      const [, sessionId, op] = sessionMatch;
      if (op === 'status' && req.method === 'GET') { sendJson(res, 200, { session: engine.status(sessionId) }); return; }
      if (op === 'state' && req.method === 'GET') {
        const status = engine.status(sessionId);
        // Plan state lives in the session container; absent plan.json means no
        // plan has been materialized yet. Read-only, fail-open to empty.
        let plan = null;
        try {
          plan = JSON.parse(await readFile(join(status.sessionRoot, 'plan.json'), 'utf8'));
        } catch { /* no plan yet */ }
        sendJson(res, 200, { session: status, plan });
        return;
      }
      if (op === 'cancel' && req.method === 'POST') { sendJson(res, 200, { session: engine.cancel(sessionId) }); return; }
      if ((op === 'advance' || op === 'steer') && req.method === 'POST') {
        const body = await readBody(req);
        const message = typeof body.message === 'string' ? body.message : '';
        if (!message.trim() && op === 'steer') { sendJson(res, 400, { error: 'message_required' }); return; }
        const session = op === 'advance'
          ? engine.advance(sessionId, message || undefined)
          : engine.steer(sessionId, message);
        sendJson(res, 200, { session });
        return;
      }
    }

    if (path.startsWith('/api/')) { sendJson(res, 404, { error: 'not_found' }); return; }
    await serveStatic(req, res, path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { error: 'bridge_error', message });
  }
});

server.listen(port, host, () => {
  console.log(`vanguard ui bridge → http://${host}:${port}`);
  console.log('kernel: embedded VanguardEngine · workspace', process.cwd());
});

async function shutdown() {
  for (const res of sseClients) { try { res.end(); } catch { /* closing */ } }
  server.close();
  const receipt = await engine.shutdown();
  if (!receipt.complete) {
    console.error('unresolved sessions:', receipt.unresolvedSessionIds);
    process.exitCode = 1;
  }
  process.exit();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
