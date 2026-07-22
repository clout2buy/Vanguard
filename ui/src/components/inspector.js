// Inspector — live RUN STATE (plan milestones, verifications, session meta)
// plus the filtered journal feed. Stream deltas never reach the journal
// panel; state refreshes from the bridge on plan/verification events.
import { el, fakeHash } from '../util.js';
import { live } from '../live.js';

const MS_STATUS = {
  proven: { cls: 'ok', glyph: '✓' },
  active: { cls: 'live', glyph: '◆' },
  pending: { cls: '', glyph: '◇' },
  blocked: { cls: 'warn', glyph: '◐' },
  invalidated: { cls: 'bad', glyph: '✗' },
};

export function mountInspector(root) {
  root.innerHTML = `
    <div class="insp-tabs">
      <button class="insp-tab on" data-tab="state">Run state</button>
      <button class="insp-tab" data-tab="journal">Journal</button>
    </div>
    <div class="insp-body" data-pane="state"></div>
    <div class="insp-body" data-pane="journal" hidden></div>
  `;

  const [statePane, journalPane] = [root.querySelector('[data-pane="state"]'), root.querySelector('[data-pane="journal"]')];

  root.querySelectorAll('.insp-tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      root.querySelectorAll('.insp-tab').forEach((t) => t.classList.toggle('on', t === tab));
      statePane.hidden = tab.dataset.tab !== 'state';
      journalPane.hidden = tab.dataset.tab !== 'journal';
    }),
  );

  let sessionId = null;
  let refreshTimer = 0;

  function addJournal(action, tone = 'sig', cursor) {
    const seq = typeof cursor === 'number' ? cursor : (journalPane.childElementCount + 1);
    const h = fakeHash(seq * 7919);
    const row = el('div', 'journal-row', `
      <span class="seq">${String(seq).padStart(3, '0')}</span>
      <span>
        <span class="j-act">${action}</span>
        <span class="j-hash"><i class="${tone === 'ok' ? 'ok' : tone === 'bad' ? 'bad' : ''}">#${h.slice(0, 6)}</i> ← #${fakeHash((seq - 1) * 7919).slice(0, 6)}</span>
      </span>`);
    journalPane.appendChild(row);
    journalPane.scrollTop = journalPane.scrollHeight;
  }

  function renderEmpty() {
    statePane.innerHTML = `
      <div class="state-empty">
        <div class="se-glyph"></div>
        <div class="se-title">No live session</div>
        <div class="se-sub">plan milestones, verifier verdicts and workspace epochs land here while the kernel works</div>
      </div>`;
  }

  function renderState({ session, plan }) {
    const milestones = plan?.milestones ?? [];
    statePane.innerHTML = `
      <div class="state-block">
        <h3>Session</h3>
        <div class="state-kv"><span>state</span><b class="st-${session.state}">${session.state}</b></div>
        <div class="state-kv"><span>workspace</span><b>${session.materialized ? 'materialized' : session.workspaceRoot === session.sourceRoot ? 'direct' : 'pending'}</b></div>
        <div class="state-kv"><span>worker gen</span><b>${session.workerGeneration ?? 0}</b></div>
        <div class="state-kv"><span>cursor</span><b>#${session.latestCursor}</b></div>
      </div>
      <div class="state-block">
        <h3>Plan ${milestones.length ? `· rev ${plan.revision}` : ''}</h3>
        ${milestones.length === 0
          ? '<div class="model-empty">no milestones — the kernel stays in the small-change lane until work outgrows it</div>'
          : milestones.map((m) => {
              const meta = MS_STATUS[m.status] ?? MS_STATUS.pending;
              return `
                <div class="ms-row ${meta.cls}">
                  <span class="ms-glyph">${meta.glyph}</span>
                  <span class="ms-body">
                    <span class="ms-title">${m.title}</span>
                    <span class="ms-sub">${m.id} · ${m.status}${m.evidence?.length ? ` · evidence ×${m.evidence.length}` : ''}${m.scope?.length ? ` · owns ${m.scope.join(', ')}` : ''}</span>
                  </span>
                </div>`;
            }).join('')}
      </div>`;
  }

  async function refreshState() {
    if (!sessionId) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      try {
        renderState(await live.state(sessionId));
      } catch { /* session gone */ }
    }, 250);
  }

  renderEmpty();
  return {
    addJournal,
    refreshState,
    attach(id) {
      sessionId = id;
      journalPane.innerHTML = '';
      renderEmpty();
      refreshState();
    },
    clear() {
      journalPane.innerHTML = '';
      renderEmpty();
    },
  };
}
