// Transcript — renders the kernel's real sanitized event stream.
// agent.delta events stream into a live node; tool.started/completed pair up
// as cards; verification.completed rows fill the quorum block as they land.
import { el } from '../util.js';

const now = () => new Date().toTimeString().slice(0, 8);

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Events that can change plan/session state and should refresh the inspector.
const STATE_EVENTS = new Set([
  'session.ready', 'run.contracted', 'verification.completed',
  'run.completed', 'run.failed', 'tool.completed',
]);

export function mountTranscript(scrollHost, { inspector, rail, setStatus }) {
  scrollHost.className = 'stream-scroll';
  let sessionId = null;
  let streamNode = null;      // open streaming agent message
  let streamText = '';
  let lastStreamText = '';
  const busyTools = [];       // fifo of tool.started cards awaiting a result
  let quorumNode = null;

  const scroll = () => { scrollHost.scrollTop = scrollHost.scrollHeight; };

  // Empty state: the stream should never look broken before the first event.
  let heroEl = null;
  function renderHero() {
    heroEl = el('div', 'stream-hero', `
      <div class="sh-glyph"></div>
      <div class="sh-title">VANGUARD <em>is listening</em></div>
      <div class="sh-sub">conversation is free — coding begins only when a task contract is explicit. The original tree is never touched mid-run.</div>
      <div class="sh-hints">
        <span class="chip">ask about the codebase</span>
        <span class="chip">describe a change</span>
        <span class="chip signal">paste an error</span>
      </div>`);
    scrollHost.appendChild(heroEl);
  }
  function removeHero() {
    heroEl?.remove();
    heroEl = null;
  }

  function divider(text) {
    scrollHost.appendChild(el('div', 'divider-ev', esc(text)));
    scroll();
  }

  function agentMessage(text, who = 'vanguard') {
    const node = el('div', 'ev msg agent', `
      <div class="avatar">V</div>
      <div class="m-body">
        <div class="m-who">${who} <span class="t">${now()}</span></div>
        <div class="m-text"></div>
      </div>`);
    node.querySelector('.m-text').textContent = text;
    scrollHost.appendChild(node);
    scroll();
    return node;
  }

  function openStream() {
    if (streamNode) return streamNode;
    streamText = '';
    streamNode = el('div', 'ev msg agent', `
      <div class="avatar">V</div>
      <div class="m-body">
        <div class="m-who">vanguard <span class="t">${now()}</span></div>
        <div class="m-text"><span class="txt"></span><span class="cursor"></span></div>
      </div>`);
    scrollHost.appendChild(streamNode);
    setStatus('streaming');
    scroll();
    return streamNode;
  }

  function closeStream() {
    if (!streamNode) return;
    streamNode.querySelector('.cursor')?.remove();
    lastStreamText = streamText;
    streamNode = null;
  }

  function toolCard(ev, state) {
    const glyph = state === 'busy' ? '…' : state === 'ok' ? '✓' : '✗';
    const node = el('div', `ev tool ${state}`, `
      <div class="t-head">
        <span class="t-glyph">${glyph}</span>
        <span class="t-name">${esc(ev.tool ?? ev.title)}</span>
        <span class="t-target">${esc(ev.detail ?? '')}</span>
        <span class="t-dur"></span>
        <span class="t-chev">▶</span>
      </div>`);
    node.querySelector('.t-head').addEventListener('click', () => node.classList.toggle('open'));
    scrollHost.appendChild(node);
    scroll();
    return node;
  }

  function settleTool(ev, ok) {
    const node = busyTools.shift() ?? toolCard(ev, 'busy');
    node.className = `ev tool ${ok ? 'ok' : 'bad'}`;
    node.querySelector('.t-glyph').textContent = ok ? '✓' : '✗';
    if (ev.detail) {
      node.querySelector('.t-target').textContent = ev.detail;
      if (!ok) {
        const reason = el('div', 't-reason', `✗ ${esc(ev.detail)}`);
        node.appendChild(reason);
      }
    }
    rail.tickTurn();
  }

  function ensureQuorum() {
    if (quorumNode) return quorumNode;
    quorumNode = el('div', 'ev quorum', `
      <div class="q-head">
        <span class="q-title">Verifier quorum</span>
        <span class="chip warn" data-q-chip>evaluating</span>
      </div>
      <div data-q-rows></div>`);
    scrollHost.appendChild(quorumNode);
    setStatus('verifying');
    scroll();
    return quorumNode;
  }

  function userNote(text, kind = 'steering · journaled') {
    const node = el('div', 'ev msg user', `
      <div class="avatar">YOU</div>
      <div class="m-body">
        <div class="m-who">${kind} <span class="t">${now()}</span></div>
        <div class="m-text"></div>
      </div>`);
    node.querySelector('.m-text').textContent = text;
    scrollHost.appendChild(node);
    scroll();
  }

  // ---- event dispatch ------------------------------------------------
  function handle({ sessionId: sid, cursor, event: ev }) {
    if (sid !== sessionId) return;
    removeHero();
    const label = journalLabel(ev);
    if (label !== null) inspector.addJournal(label, journalTone(ev), cursor);
    if (STATE_EVENTS.has(ev.type)) inspector.refreshState();
    if (ev.turn) rail.tickTurn(ev.turn);

    switch (ev.type) {
      case 'agent.stream_started': openStream(); break;
      case 'agent.delta': {
        const node = openStream();
        streamText += ev.message ?? '';
        node.querySelector('.txt').textContent = streamText;
        scroll();
        break;
      }
      case 'agent.stream_committed': closeStream(); break;
      case 'agent.stream_reset': case 'agent.stream_failed':
        closeStream(); break;
      case 'agent.message': {
        const text = ev.message ?? '';
        // The canonical message always trails its own deltas — don't double-print.
        if (!streamNode && text && text === lastStreamText) { lastStreamText = ''; break; }
        closeStream();
        if (text) agentMessage(text);
        break;
      }
      case 'tool.started':
        busyTools.push(toolCard(ev, 'busy'));
        setStatus('streaming');
        break;
      case 'tool.completed': settleTool(ev, true); break;
      case 'tool.failed': settleTool(ev, false); break;
      case 'run.contracted':
        divider('task contract accepted');
        if (ev.detail) agentMessage(`Starting: ${ev.detail}`);
        break;
      case 'session.ready':
        if (ev.materialized) divider('disposable workspace materialized · original tree untouched');
        break;
      case 'completion.claimed':
        closeStream();
        ensureQuorum();
        break;
      case 'verification.completed': {
        const q = ensureQuorum();
        const row = el('div', 'q-row on', `
          <span class="q-mark">${ev.status === 'passed' ? '✓' : '✗'}</span>
          <span>${esc(ev.title)}</span>
          <span class="q-val">${esc(ev.detail ?? '')}</span>`);
        if (ev.status !== 'passed') row.querySelector('.q-mark').style.color = 'var(--fail)';
        q.querySelector('[data-q-rows]').appendChild(row);
        scroll();
        break;
      }
      case 'run.completed': {
        closeStream();
        if (quorumNode) {
          quorumNode.classList.add('accepted');
          const chip = quorumNode.querySelector('[data-q-chip]');
          chip.className = 'chip verify';
          chip.textContent = 'accepted';
          quorumNode = null;
        }
        setStatus('verified');
        rail.setState('completed');
        break;
      }
      case 'run.failed':
        closeStream();
        if (quorumNode) {
          const chip = quorumNode.querySelector('[data-q-chip]');
          chip.className = 'chip fail';
          chip.textContent = 'rejected';
          quorumNode = null;
        }
        agentMessage(ev.detail ? `Run stopped: ${ev.detail}` : 'Run stopped.');
        setStatus('failed');
        rail.setState('failed');
        break;
      case 'run.waiting_for_user':
        closeStream();
        if (ev.message) agentMessage(ev.message);
        setStatus('waiting');
        rail.setState('waiting_for_user');
        break;
      case 'context.compacted': divider(`${ev.title ?? 'context compacted'}${ev.detail ? ` · ${ev.detail}` : ''}`); break;
      case 'recovery.scheduled': divider(`safe retry scheduled · ${ev.detail ?? ''}`); break;
      case 'recovery.replan_required': divider('replan required · circuit breaker blocked identical replay'); break;
      case 'recovery.exhausted': divider(`recovery budget exhausted · ${ev.detail ?? ''}`); break;
      default: break;
    }
  }

  function journalLabel(ev) {
    switch (ev.type) {
      case 'agent.message': return 'agent message committed';
      case 'tool.started': return `${ev.tool ?? 'tool'} started`;
      case 'tool.completed': return `${ev.title} ✓`;
      case 'tool.failed': return `${ev.title} ✗`;
      case 'run.contracted': return 'task contract accepted';
      case 'verification.completed': return `verifier ${ev.title}: ${ev.detail ?? ev.status}`;
      case 'run.completed': return 'run completed · answer sealed';
      case 'run.failed': return `run stopped · ${ev.detail ?? ''}`;
      case 'context.compacted': return ev.title?.toLowerCase() ?? 'context compacted';
      case 'session.ready': return ev.materialized ? 'workspace materialized' : 'session ready';
      case 'run.waiting_for_user': return 'waiting for your answer';
      case 'recovery.scheduled': return `safe retry scheduled · ${ev.detail ?? ''}`;
      case 'recovery.replan_required': return 'replan required · circuit breaker';
      case 'recovery.exhausted': return 'recovery budget exhausted';
      default: return null; // stream lifecycle noise stays out of the journal
    }
  }
  const journalTone = (ev) =>
    ev.status === 'passed' ? 'ok' : ev.status === 'failed' ? 'bad' : 'sig';

  return {
    handle,
    noteSent: (text, running) => { removeHero(); userNote(text, running ? 'steering · journaled' : 'you'); },
    attach(id) {
      sessionId = id;
      scrollHost.innerHTML = '';
      streamNode = null; lastStreamText = ''; busyTools.length = 0; quorumNode = null;
      renderHero();
    },
  };
}
