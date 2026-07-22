// Runs rail — the live session card, driven by real engine state.
import { store } from '../state.js';

const STATE_META = {
  idle: { glyph: '◇', cls: '', label: 'idle' },
  running: { glyph: '◆', cls: 'live', label: 'running' },
  waiting_for_user: { glyph: '◐', cls: 'live', label: 'waiting' },
  cancelling: { glyph: '◆', cls: 'live', label: 'cancelling' },
  cancelled: { glyph: '✗', cls: 'bad', label: 'cancelled' },
  completed: { glyph: '✓', cls: 'ok', label: 'verified' },
  failed: { glyph: '✗', cls: 'bad', label: 'failed' },
};

export function mountRail(root) {
  root.innerHTML = `
    <div class="rail-head"><h2>Runs</h2><span data-count>0 live</span></div>
    <div class="runs" data-runs>
      <div class="model-empty" style="padding:26px 10px">no live session —<br/>one opens when the bridge connects</div>
    </div>
    <div class="rail-foot" data-foot></div>
  `;

  const runs = root.querySelector('[data-runs]');
  const foot = root.querySelector('[data-foot]');
  let turns = 0;

  function renderFoot(meta = {}) {
    foot.innerHTML = `
      <div>kernel <b>0.1.0</b> · profile <b>${store.settings.profile}</b></div>
      ${meta.provider ? `<div>${meta.provider} · <b>${meta.model}</b></div>` : ''}
      ${store.settings.workspace ? `<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">▸ <b>${store.settings.workspace}</b></div>` : ''}
      <div>journal <span class="ok">hash-chained</span> · merge <b>exact-hash</b></div>
    `;
  }
  renderFoot();

  function setSession({ title, state, provider, model }) {
    turns = 0;
    root.querySelector('[data-count]').textContent = '1 live';
    runs.innerHTML = `
      <button class="run active" data-live>
        <div class="r-top">
          <span class="r-state" data-glyph></span>
          <span class="r-title" data-title>${title}</span>
        </div>
        <div class="r-meta"><span data-label></span><span data-turns>000 / ${store.settings.maxTurns}</span></div>
        <div class="budget"><i></i></div>
      </button>`;
    setState(state ?? 'idle');
    renderFoot({ provider, model });
  }

  function setState(state) {
    const meta = STATE_META[state] ?? STATE_META.idle;
    const glyph = runs.querySelector('[data-glyph]');
    const label = runs.querySelector('[data-label]');
    if (!glyph || !label) return;
    glyph.textContent = meta.glyph;
    glyph.className = `r-state ${meta.cls}`;
    label.textContent = meta.label;
  }

  function setTitle(title) {
    const node = runs.querySelector('[data-title]');
    if (node) node.textContent = title.length > 42 ? `${title.slice(0, 41)}…` : title;
  }

  function tickTurn(n) {
    turns = typeof n === 'number' ? n : turns + 1;
    const node = runs.querySelector('[data-turns]');
    const bar = runs.querySelector('.budget i');
    if (node) node.textContent = `${String(turns).padStart(3, '0')} / ${store.settings.maxTurns}`;
    if (bar) bar.style.width = `${Math.min(100, (turns / store.settings.maxTurns) * 100)}%`;
  }

  return { setSession, setState, setTitle, tickTurn, renderFoot };
}
