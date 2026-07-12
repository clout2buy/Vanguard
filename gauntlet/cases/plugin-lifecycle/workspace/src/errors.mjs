export class PluginLifecycleError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PluginLifecycleError";
  }
}
