// Small shared helpers for the Vanguard UI modules.

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
}

export function fakeHash(seed) {
  let h = 0x811c9dc5 ^ seed;
  let out = '';
  for (let i = 0; i < 12; i++) {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    out += (h >>> 4 & 0xf).toString(16);
  }
  return out;
}

export function toast(message, kind = 'signal') {
  const host = document.getElementById('toasts');
  const t = el('div', `toast ${kind === 'verify' ? 'verify' : ''}`);
  t.innerHTML = `<span class="dot ${kind === 'verify' ? 'ok' : 'signal'}"></span><span>${message}</span>`;
  host.appendChild(t);
  setTimeout(() => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 320);
  }, 3200);
}

// Typewriter that respects an abort flag; returns when done.
export async function typeInto(node, text, { cps = 90, aborted } = {}) {
  const step = Math.max(1, Math.round(cps / 60));
  for (let i = 0; i < text.length; i += step) {
    if (aborted?.()) return;
    node.textContent = text.slice(0, i + step);
    await wait(1000 / 60);
  }
  node.textContent = text;
}
