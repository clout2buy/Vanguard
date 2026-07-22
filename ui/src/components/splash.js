// Splash — the calibration protocol intro.
// Staged via classes on #splash so CSS owns every transition; JS only
// conducts timing. Skip jumps all stages to their final state at once.
import { el, wait } from '../util.js';

const WORD = 'VANGUARD';
const ACCENT_LETTER = 0; // the V burns signal-orange

const LOG_LINES = [
  ['append-only run journal', 'SEALED', 'ok'],
  ['verifier quorum', 'ARMED', 'ok'],
  ['mutation boundary', 'LOCKED', 'ok'],
  ['circuit breaker', '240-TURN BUDGET', 'sig'],
  ['provider ports', '5 DETECTED', 'sig'],
];

export function mountSplash(root, onEnter) {
  root.innerHTML = `
    <div class="splash-grid"></div>
    <div class="splash-vignette"></div>
    ${['tl', 'tr', 'bl', 'br'].map((p) => `<div class="crosshair ${p}"></div>`).join('')}
    <div class="splash-meta">
      <span>Vanguard // calibration protocol</span>
      <span class="cal">CAL 000</span>
      <span>kernel 0.1.0 · clean-room</span>
    </div>
    <div class="splash-stage">
      <h1 class="wordmark" aria-label="VANGUARD">
        ${[...WORD].map((ch, i) => `
          <span class="wl ${i === ACCENT_LETTER ? 'accent' : ''}">
            <span style="transition-delay:${0.05 + i * 0.07}s">${ch}</span>
          </span>`).join('')}
        <span class="scanline"></span>
      </h1>
      <div class="splash-rule"></div>
      <div class="splash-sub">
        <div class="tag">verification-first <b>coding kernel</b></div>
        <div class="coords">51.5072°N · 0.1276°W · PROVING GROUND 01</div>
      </div>
      <button class="splash-enter"><span>Enter the proving ground</span><span class="arrow">→</span></button>
    </div>
    <div class="splash-log"></div>
    <div class="stamp">attested<small>journal sealed · build 0.1.0</small></div>
    <button class="splash-skip">skip calibration</button>
  `;

  const logHost = root.querySelector('.splash-log');
  const cal = root.querySelector('.cal');
  const timers = [];
  let done = false;

  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  const setStage = (s) => root.classList.add(s);

  function renderLogLine([label, res, tone]) {
    const line = el('div', 'll',
      `<span class="arrow">▸</span><span>${label}</span><span class="res ${tone}">${res}</span>`);
    logHost.appendChild(line);
    requestAnimationFrame(() => line.classList.add('on'));
  }

  function tickCalibration(from, to, ms) {
    const steps = Math.max(1, Math.floor(ms / 28));
    for (let i = 0; i <= steps; i++) {
      later(i * 28, () => {
        const v = Math.round(from + ((to - from) * i) / steps);
        cal.textContent = `CAL ${String(v).padStart(3, '0')}`;
      });
    }
  }

  function finishAll() {
    ['s-grid', 's-word', 's-sub', 's-log', 's-stamp', 's-cta'].forEach(setStage);
    LOG_LINES.forEach(renderLogLine);
    cal.textContent = 'CAL 100';
  }

  async function run() {
    tickCalibration(0, 34, 900);
    later(150, () => setStage('s-grid'));
    later(750, () => setStage('s-word'));
    later(1650, () => setStage('s-sub'));
    later(2000, () => setStage('s-log'));
    LOG_LINES.forEach((line, i) => later(2150 + i * 210, () => renderLogLine(line)));
    later(2100, () => tickCalibration(34, 92, 1400));
    later(3500, () => setStage('s-stamp'));
    later(3600, () => tickCalibration(92, 100, 500));
    later(4100, () => setStage('s-cta'));
  }

  function enter() {
    if (done) return;
    done = true;
    timers.forEach(clearTimeout);
    root.classList.add('depart');
    setTimeout(() => { root.remove(); }, 1000);
    onEnter();
  }

  root.querySelector('.splash-skip').addEventListener('click', () => {
    timers.forEach(clearTimeout);
    finishAll();
  });
  root.querySelector('.splash-enter').addEventListener('click', enter);
  window.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Enter' && root.isConnected && root.classList.contains('s-cta')) {
      enter();
      window.removeEventListener('keydown', onKey);
    }
  });

  run();
}
