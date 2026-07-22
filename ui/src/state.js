// Minimal pub-sub store. Settings persist to localStorage so the
// prototype remembers your provider/model/effort choices between loads.
import { DEFAULT_SETTINGS } from './data.js';

const KEY = 'vanguard.ui.settings';

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    return { ...structuredClone(DEFAULT_SETTINGS), ...JSON.parse(raw) };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

const listeners = new Set();

export const store = {
  settings: load(),
  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.settings)); } catch { /* prototype */ }
    listeners.forEach((fn) => fn(this.settings));
  },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
