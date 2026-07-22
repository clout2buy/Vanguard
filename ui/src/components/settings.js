// Settings — live providers and models from the kernel's own catalog
// (via the bridge), per-provider reasoning preference, kernel policy.
// Sealing a provider/model pair starts a new session with it.
import { REASONING_SCHEMES } from '../data.js';
import { store } from '../state.js';
import { el, toast } from '../util.js';
import { live } from '../live.js';

export function mountSettings(root, { onClose, onApply }) {
  const s = store.settings;
  let cards = [];             // live provider cards from the bridge
  let activeProvider = s.provider;
  let activeModel = s.model;
  let query = '';

  root.innerHTML = `
    <div class="set-head">
      <div>
        <div class="set-title">PROVING <em class="holo-text">GROUNDS</em></div>
        <div class="set-seal">provider state is live · sealing starts a new session</div>
      </div>
      <button class="set-close" aria-label="Close settings">✕</button>
    </div>
    <div class="set-tabs">
      <button class="set-tab on" data-view="models">Providers &amp; Models</button>
      <button class="set-tab" data-view="kernel">Kernel</button>
    </div>
    <div class="set-body">
      <div class="set-view on" data-view="models">
        <div class="prov-col"><div class="col-label">Providers · live</div><div data-prov-list></div></div>
        <div class="model-col">
          <div class="col-label">Model discovery</div>
          <div class="model-search">
            <span class="sig">▸</span>
            <input type="text" placeholder="search the catalog…" data-search />
            <span class="count" data-count></span>
          </div>
          <div data-model-list></div>
          <div class="model-search" style="margin-top:14px">
            <span class="sig">◆</span>
            <input type="text" placeholder="or pass any model id — the catalog never blocks" data-custom />
          </div>
        </div>
        <div class="reason-col">
          <div class="col-label">Selected model</div>
          <div data-sel-model></div>
          <div class="reason-head">Reasoning effort</div>
          <div class="reason-sub" data-scheme></div>
          <div data-levels></div>
          <div data-level-desc></div>
          <div class="set-save-row">
            <button class="btn primary" data-save>Seal &amp; start session</button>
            <span class="hint">per-provider tier is kept —<br/>switching models preserves it</span>
          </div>
        </div>
      </div>
      <div class="kernel-view" data-view="kernel">
        <div class="k-grid">
          <div class="k-card">
            <h3>Security profile</h3>
            <button class="profile-opt ${s.profile === 'workspace' ? 'on' : ''}" data-profile="workspace">
              <span class="po-name">workspace <span>${s.profile === 'workspace' ? '●' : ''}</span></span>
              <div class="po-desc">Compatibility-oriented. Interactive default; mutations confined to the session copy.</div>
            </button>
            <button class="profile-opt ${s.profile === 'guarded' ? 'on' : ''}" data-profile="guarded">
              <span class="po-name">guarded <span>${s.profile === 'guarded' ? '●' : ''}</span></span>
              <div class="po-desc">Fail-closed. For evaluation and untrusted trees — pair with host container isolation.</div>
            </button>
            <p class="k-note">Passed to the kernel as <code>securityProfile</code> on session create.</p>
          </div>
          <div class="k-card">
            <h3>Turn budget</h3>
            <div class="stepper">
              <button data-step="-20">−</button>
              <span class="val" data-turns>${s.maxTurns}</span>
              <button data-step="20">+</button>
            </div>
            <p class="k-note">Passed to the kernel as <code>maxSteps</code> on session create. The circuit breaker trips toward replanning long before this ceiling.</p>
          </div>
          <div class="k-card">
            <h3>Workspace</h3>
            <div class="model-search" style="margin-bottom:0">
              <span class="sig">▸</span>
              <input type="text" placeholder="D:\\path\\to\\your\\project" data-workspace value="${s.workspace ?? ''}" />
            </div>
            <p class="k-note">The directory Vanguard works on. Edits never touch it directly — a disposable session copy is materialized and returned via review/apply. Empty = the bridge's launch directory.</p>
          </div>
          <div class="k-card">
            <h3>Journal</h3>
            <p class="k-note">Append-only, hash-chained, content-addressed. What the inspector shows is the kernel's real sanitized event stream — <code>~/.vanguard</code> holds credentials, never the protocol.</p>
          </div>
        </div>
      </div>
    </div>
  `;

  const card = () => cards.find((c) => c.id === activeProvider);
  const models = () => {
    const c = card();
    if (!c) return [];
    const q = query.trim().toLowerCase();
    return c.models.filter((m) => !q || `${m.id} ${m.note ?? ''}`.toLowerCase().includes(q));
  };

  function renderProviders() {
    const host = root.querySelector('[data-prov-list]');
    host.innerHTML = '';
    if (!cards.length) { host.appendChild(el('div', 'model-empty', 'probing providers…')); return; }
    cards.forEach((c, i) => {
      const btn = el('button', `prov ${c.id === activeProvider ? 'on' : ''}`);
      btn.style.animationDelay = `${i * 0.05}s`;
      btn.innerHTML = `
        <div class="p-row"><span class="dot ${c.ready ? 'ok' : 'dead'}"></span><span class="p-name">${c.label}</span></div>
        <div class="p-kind">${c.auth === 'oauth' ? 'subscription' : 'api key'}</div>
        <div class="p-status">${c.detail}${c.ready ? '' : ' · <u>sign in</u>'}</div>`;
      btn.addEventListener('click', async () => {
        if (!c.ready) {
          if (c.auth === 'oauth' || ['kimi', 'anthropic', 'openai'].includes(c.id)) {
            toast(`opening ${c.label} sign-in in your browser…`);
            try { await live.login(c.id); } catch { /* flow runs async in browser */ }
            await refresh();
          }
          return;
        }
        activeProvider = c.id;
        activeModel = c.models.find((m) => m.id === activeModel)?.id ?? c.defaultModel;
        renderProviders(); renderModels(); renderReasoning();
      });
      host.appendChild(btn);

      // API-key providers get a direct paste field: stored into Vanguard's
      // DPAPI project secret store, same as the TUI's credential helper.
      if (!c.ready && c.auth === 'api-key' && c.id !== 'ollama') {
        const form = el('form', 'key-form');
        form.innerHTML = `
          <input type="password" placeholder="paste ${c.label} API key" autocomplete="off" spellcheck="false" />
          <button type="submit" class="key-save">store</button>`;
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const input = form.querySelector('input');
          const key = input.value.trim();
          if (key.length < 8) { toast('that key looks too short', 'signal'); return; }
          input.value = '';
          try {
            const result = await live.credential(c.id, key);
            toast(result.persisted ? `${c.label} key stored · encrypted project store` : `${c.label} key set for this bridge`, 'verify');
            await refresh();
          } catch (error) {
            toast(error.message, 'signal');
          }
        });
        host.appendChild(form);
      }
    });
  }

  function renderModels() {
    const host = root.querySelector('[data-model-list]');
    const list = models();
    root.querySelector('[data-count]').textContent = `${list.length} / ${card()?.models.length ?? 0}`;
    host.innerHTML = '';
    if (!list.length) { host.appendChild(el('div', 'model-empty', '— no catalog models match —')); return; }
    list.forEach((m, i) => {
      const row = el('button', `model-row ${m.id === activeModel ? 'on' : ''}`);
      row.style.animationDelay = `${i * 0.045}s`;
      row.innerHTML = `
        <div class="m-top">
          <span class="m-name">${m.id}</span>
          <span class="m-check">◆ selected</span>
        </div>
        ${m.note ? `<div class="m-tags"><span class="chip">${m.note}</span></div>` : ''}`;
      row.addEventListener('click', () => { activeModel = m.id; renderModels(); renderReasoning(); });
      host.appendChild(row);
    });
  }

  function renderReasoning() {
    const c = card();
    const scheme = REASONING_SCHEMES[activeProvider];
    root.querySelector('[data-sel-model]').innerHTML = `
      <div class="sel-model">
        <div class="s-k">${c?.label ?? activeProvider} · ${c?.auth ?? ''}</div>
        <div class="s-name">${activeModel}</div>
        <div class="s-blurb">${c?.ready ? `Live through ${c.detail}.` : 'Provider is not connected yet.'}</div>
      </div>`;
    root.querySelector('[data-scheme]').textContent = scheme ? `${c?.label ?? activeProvider} exposes “${scheme.scheme}”` : 'no scheme known';

    const levelsHost = root.querySelector('[data-levels]');
    const descHost = root.querySelector('[data-level-desc]');
    levelsHost.innerHTML = '';
    descHost.innerHTML = '';
    if (!scheme) {
      levelsHost.innerHTML = '<div class="reason-none">∅ no deliberation control known for this provider.</div>';
      return;
    }
    const current = s.levels[activeProvider] ?? scheme.levels.at(-1).id;
    scheme.levels.forEach((lv, i) => {
      const btn = el('button', `level ${lv.id === current ? 'on' : ''}`);
      btn.style.animationDelay = `${i * 0.05}s`;
      btn.innerHTML = `
        <span class="l-ticks">${scheme.levels.map((x) => `<i class="${scheme.levels.indexOf(x) <= i ? 'lit' : ''}"></i>`).join('')}</span>
        <span class="l-name">${lv.label}</span>
        <span class="l-cost">${lv.cost}</span>`;
      btn.addEventListener('click', () => { s.levels[activeProvider] = lv.id; renderReasoning(); });
      levelsHost.appendChild(btn);
    });
    descHost.appendChild(el('div', 'level-desc', scheme.levels.find((l) => l.id === current).desc));
  }

  async function refresh() {
    try {
      const { providers } = await live.providers();
      cards = providers;
    } catch {
      cards = [];
    }
    if (!card()?.ready) {
      const first = cards.find((c) => c.ready);
      if (first) { activeProvider = first.id; activeModel = first.defaultModel; }
    }
    renderProviders(); renderModels(); renderReasoning();
  }

  // ---------- kernel tab ----------
  root.querySelectorAll('[data-profile]').forEach((btn) =>
    btn.addEventListener('click', () => {
      s.profile = btn.dataset.profile;
      root.querySelectorAll('[data-profile]').forEach((b) => {
        b.classList.toggle('on', b === btn);
        b.querySelector('.po-name span:last-child').textContent = b === btn ? '●' : '';
      });
    }),
  );
  root.querySelectorAll('[data-step]').forEach((btn) =>
    btn.addEventListener('click', () => {
      s.maxTurns = Math.max(40, Math.min(600, s.maxTurns + Number(btn.dataset.step)));
      root.querySelector('[data-turns]').textContent = s.maxTurns;
    }),
  );

  // ---------- chrome ----------
  root.querySelectorAll('.set-tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      root.querySelectorAll('.set-tab').forEach((t) => t.classList.toggle('on', t === tab));
      root.querySelectorAll('[data-view]').forEach((v) => {
        if (v.classList.contains('set-view') || v.classList.contains('kernel-view')) {
          v.classList.toggle('on', v.dataset.view === tab.dataset.view);
        }
      });
    }),
  );
  root.querySelector('[data-search]').addEventListener('input', (e) => { query = e.target.value; renderModels(); });
  root.querySelector('[data-custom]').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    if (v) { activeModel = v; renderModels(); renderReasoning(); }
  });
  root.querySelector('[data-workspace]').addEventListener('input', (e) => {
    s.workspace = e.target.value.trim();
  });

  root.querySelector('[data-save]').addEventListener('click', () => {
    s.provider = activeProvider;
    s.model = activeModel;
    store.save();
    toast(`sealed · ${activeModel} @ ${s.levels[activeProvider] ?? 'default'} effort`, 'verify');
    close();
    onApply?.({ provider: activeProvider, model: activeModel });
  });

  function close() { root.classList.remove('open'); setTimeout(() => { root.hidden = true; onClose?.(); }, 700); }
  root.querySelector('.set-close').addEventListener('click', close);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) close(); });

  return {
    open() {
      root.hidden = false;
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('open')));
      refresh();
    },
    refresh,
    cards: () => cards,
  };
}
