export class TTLCache {
  constructor(clock = Date.now) {
    this.clock = clock;
    this.entries = new Map();
  }

  set(key, value, ttlMs) {
    this.entries.set(key, value);
  }

  get(key) {
    return this.entries.get(key);
  }

  has(key) {
    return this.entries.has(key);
  }

  delete(key) {
    return this.entries.delete(key);
  }

  prune() {
    return 0;
  }

  get size() {
    return this.entries.size;
  }
}
