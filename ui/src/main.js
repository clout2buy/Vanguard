// Vanguard UI — orchestrator. Live build: the shell is driven by the
// embedded kernel through the bridge (ui/bridge.mjs), not by a script.
import { mountSplash } from './components/splash.js';
import { mountRail } from './components/rail.js';
import { mountTranscript } from './components/transcript.js';
import { mountInspector } from './components/inspector.js';
import { mountComposer } from './components/composer.js';
import { mountSettings } from './components/settings.js';
import { store } from './state.js';
import { el, toast } from './util.js';
import { live } from './live.js';

const GEAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
  <circle cx="12" cy="12" r="3.2"/>
  <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.1 2.1M16.9 16.9L19 19M19 5l-2.1 2.1M7.1 16.9L5 19"/>
</svg>`;

const SPEC_SELECTOR = '.tool, .model-row, .prov, .level, .proof, .k-card, .composer-box, .sel-model, .quorum, .profile-opt, .run';

function mountLightLayer() {
  const sheen = el('div');
  sheen.id = 'sheen';
  document.body.appendChild(sheen);
  let sx = innerWidth / 2, sy = innerHeight / 2, tx = sx, ty = sy;
  addEventListener('pointermove', (e) => { tx = e.clientX; ty = e.clientY; });
  (function drift() {
    sx += (tx - sx) * 0.075;
    sy += (ty - sy) * 0.075;
    sheen.style.transform = `translate(${sx - 310}px, ${sy - 310}px)`;
    requestAnimationFrame(drift);
  })();
  document.addEventListener('pointermove', (e) => {
    const tile = e.target.closest?.(SPEC_SELECTOR);
    if (!tile) return;
    const r = tile.getBoundingClientRect();
    tile.style.setProperty('--lx', `${e.clientX - r.left}px`);
    tile.style.setProperty('--ly', `${e.clientY - r.top}px`);
  });
}

function shellMarkup() {
  return `
    <header id="topbar" class="rise">
      <div class="brand"><span class="glyph"></span><span class="holo-text">VANGUARD</span><em>·</em><span class="topbar-hash">session <b data-session-hash>…</b></span></div>
      <div class="topbar-spacer"></div>
      <span class="chip" data-model-chip>connecting…</span>
      <span class="status-pill idle" data-status><span class="dot dead"></span><span data-status-label>connecting</span></span>
      <button class="gear-btn" data-gear aria-label="Open settings">${GEAR}</button>
    </header>
    <aside id="rail" class="rise"></aside>
    <main id="stream" class="rise">
      <div data-scroll></div>
      <div id="composer"></div>
    </main>
    <aside id="inspector" class="rise"></aside>
  `;
}

function enterApp() {
  const app = document.getElementById('app');
  app.innerHTML = shellMarkup();
  app.hidden = false;

  app.querySelectorAll('.rise').forEach((node, i) => {
    node.style.transitionDelay = `${0.25 + i * 0.12}s`;
    requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add('in')));
  });

  const statusPill = app.querySelector('[data-status]');
  const statusLabel = app.querySelector('[data-status-label]');
  const STATUS_DOT = { idle: 'dead', streaming: 'signal', verifying: 'warn', waiting: 'warn', verified: 'ok', failed: 'dead' };
  const setStatus = (state) => {
    statusPill.className = `status-pill ${state}`;
    statusPill.querySelector('.dot').className = `dot ${STATUS_DOT[state] ?? 'dead'}`;
    statusLabel.textContent = state === 'waiting' ? 'waiting on you' : state;
  };

  const inspector = mountInspector(app.querySelector('#inspector'));
  const rail = mountRail(app.querySelector('#rail'));
  const transcript = mountTranscript(app.querySelector('[data-scroll]'), { inspector, rail, setStatus });

  let session = null;      // VanguardSessionStatus from the bridge
  let greeted = false;

  const modelChip = app.querySelector('[data-model-chip]');
  const hashChip = app.querySelector('[data-session-hash]');

  function trackState(ev) {
    if (!session) return;
    if (ev.type === 'run.completed') session = { ...session, state: 'completed' };
    else if (ev.type === 'run.failed') session = { ...session, state: 'failed' };
    else if (ev.type === 'run.waiting_for_user') session = { ...session, state: 'waiting_for_user' };
    else if (ev.type === 'agent.stream_started' || ev.type === 'tool.started') session = { ...session, state: 'running' };
  }

  live.onEvents((payload) => {
    if (payload.sessionId !== session?.sessionId) return;
    trackState(payload.event);
    transcript.handle(payload);
  });

  async function bootSession(provider, model) {
    setStatus('idle');
    modelChip.textContent = `${provider} · ${model} · opening session…`;
    try {
      const { session: s } = await live.createSession({
        provider,
        model,
        workspace: store.settings.workspace || undefined,
        securityProfile: store.settings.profile,
        maxSteps: store.settings.maxTurns,
      });
      session = s;
      greeted = false;
      transcript.attach(s.sessionId);
      inspector.attach(s.sessionId);
      rail.setSession({ title: 'live session', state: s.state, provider, model });
      hashChip.textContent = `${s.sessionId.replace('vanguard-session-', '').slice(0, 8)}…`;
      modelChip.textContent = `${provider} · ${model} · ${store.settings.levels[provider] ?? 'default'}`;
      inspector.addJournal(`session created · ${provider} / ${model}`, 'ok', 0);
      setStatus('idle');
      toast(`live · ${provider} / ${model}`, 'verify');
    } catch (error) {
      session = null;
      modelChip.textContent = 'no provider ready';
      setStatus('failed');
      toast(error.message, 'signal');
    }
  }

  async function boot() {
    let cards = [];
    try { cards = (await live.providers()).providers; }
    catch { toast('bridge unreachable — start node ui/bridge.mjs', 'signal'); setStatus('failed'); return; }

    const wanted = cards.find((c) => c.id === store.settings.provider && c.ready);
    const first = cards.find((c) => c.ready);
    const pick = wanted ?? first;
    if (!pick) { setStatus('failed'); modelChip.textContent = 'no provider ready — open settings to sign in'; return; }
    await bootSession(pick.id, wanted ? store.settings.model : pick.defaultModel);
  }

  mountComposer(app.querySelector('#composer'), {
    onSteer: async (text) => {
      if (!session) { toast('no live session — check the bridge', 'signal'); return; }
      const running = session.state === 'running';
      transcript.noteSent(text, running);
      if (!greeted) { rail.setTitle(text); greeted = true; }
      try {
        const res = running
          ? await live.steer(session.sessionId, text)
          : await live.advance(session.sessionId, text);
        session = res.session;
        if (session.state === 'running') { setStatus('streaming'); rail.setState('running'); }
      } catch (error) {
        toast(error.message, 'signal');
      }
    },
  });

  const settings = mountSettings(document.getElementById('settings'), {
    onApply: async ({ provider, model }) => {
      if (session && (session.state === 'running' || session.state === 'waiting_for_user')) {
        try { await live.cancel(session.sessionId); } catch { /* already settled */ }
      }
      rail.renderFoot({ provider, model });
      await bootSession(provider, model);
    },
  });
  app.querySelector('[data-gear]').addEventListener('click', () => settings.open());

  boot();
}

mountLightLayer();
mountSplash(document.getElementById('splash'), enterApp);
