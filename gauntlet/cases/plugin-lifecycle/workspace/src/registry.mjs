import { PluginLifecycleError } from "./errors.mjs";

export class PluginRegistry {
  constructor() {
    this.plugins = new Map();
  }

  register(plugin) {
    this.plugins.set(plugin.name, plugin);
  }

  async startAll() {
    for (const plugin of this.plugins.values()) await plugin.start();
  }

  async stopAll() {
    for (const plugin of this.plugins.values()) await plugin.stop();
  }

  status() {
    return Object.fromEntries([...this.plugins.keys()].map((name) => [name, "registered"]));
  }
}

export { PluginLifecycleError };
