// Live API client for the bridge (ui/bridge.mjs).

async function req(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? body.error ?? `http ${res.status}`);
  return body;
}

export const live = {
  providers: () => req('/api/providers'),
  login: (provider) => req(`/api/login/${provider}`, { method: 'POST' }),
  createSession: ({ provider, model, workspace, securityProfile, maxSteps }) =>
    req('/api/session', {
      method: 'POST',
      body: JSON.stringify({ provider, model, workspace, securityProfile, maxSteps }),
    }),
  advance: (sessionId, message) =>
    req(`/api/session/${encodeURIComponent(sessionId)}/advance`, { method: 'POST', body: JSON.stringify({ message }) }),
  steer: (sessionId, message) =>
    req(`/api/session/${encodeURIComponent(sessionId)}/steer`, { method: 'POST', body: JSON.stringify({ message }) }),
  cancel: (sessionId) =>
    req(`/api/session/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST' }),
  status: (sessionId) => req(`/api/session/${encodeURIComponent(sessionId)}/status`),
  state: (sessionId) => req(`/api/session/${encodeURIComponent(sessionId)}/state`),
  credential: (provider, key) =>
    req('/api/credential', { method: 'POST', body: JSON.stringify({ provider, key }) }),

  onEvents(handler) {
    const source = new EventSource('/api/events');
    source.onmessage = (msg) => {
      try { handler(JSON.parse(msg.data)); } catch { /* malformed frame */ }
    };
    return () => source.close();
  },
};
