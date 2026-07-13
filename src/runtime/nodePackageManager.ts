import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export type NodePackageManager = "npm" | "npx";

export interface NodePackageManagerAlias {
  readonly executable: string;
  readonly argsPrefix: readonly string[];
}

/** Node 20 uses the experimental spelling; Node 22+ accepts the stable flag. */
export function nodePermissionFlag(version = process.versions.node): "--experimental-permission" | "--permission" {
  const major = Number(version.split(".", 1)[0]);
  if (!Number.isSafeInteger(major) || major < 20) {
    throw new Error(`Unsupported Node version for the permission model: ${version}.`);
  }
  return major >= 22 ? "--permission" : "--experimental-permission";
}

/**
 * Locate npm's JavaScript entry point without invoking a command shell.
 *
 * npm is normally adjacent to the Node executable, but that is not true for
 * portable Node distributions, version-manager shims, or an `npx node@...`
 * runtime. `npm_execpath` is authoritative when Vanguard itself was launched
 * by npm; the remaining candidates cover the standard bundled/prefix layouts.
 */
export function resolveNodePackageManagerAlias(
  manager: NodePackageManager,
  environment: NodeJS.ProcessEnv = process.env,
  nodeExecutable = process.execPath,
): NodePackageManagerAlias | undefined {
  const entrypoint = `${manager}-cli.js`;
  const candidates: string[] = [];
  const npmExecPath = environment.npm_execpath?.trim();
  if (npmExecPath !== undefined && npmExecPath.length > 0) {
    candidates.push(manager === "npm" ? npmExecPath : path.join(path.dirname(npmExecPath), entrypoint));
  }

  const executableDirectory = path.dirname(nodeExecutable);
  candidates.push(path.join(executableDirectory, "node_modules", "npm", "bin", entrypoint));

  const prefix = environment.npm_config_prefix?.trim();
  if (prefix !== undefined && prefix.length > 0) {
    candidates.push(
      path.join(prefix, "node_modules", "npm", "bin", entrypoint),
      path.join(prefix, "lib", "node_modules", "npm", "bin", entrypoint),
    );
  }

  for (const directory of (environment.PATH ?? environment.Path ?? "").split(path.delimiter)) {
    if (directory.length === 0) continue;
    candidates.push(
      path.join(directory, "node_modules", "npm", "bin", entrypoint),
      path.join(directory, "..", "npm", "bin", entrypoint),
    );
    for (const commandName of process.platform === "win32"
      ? [manager, `${manager}.cmd`, `${manager}.ps1`]
      : [manager]) {
      const command = path.join(directory, commandName);
      if (!existsSync(command)) continue;
      try {
        const resolved = realpathSync(command);
        if (path.basename(resolved).toLocaleLowerCase() === entrypoint) candidates.push(resolved);
      } catch {
        // A stale or inaccessible PATH entry is not a fatal configuration.
      }
    }
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    const key = process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    if (path.basename(normalized).toLocaleLowerCase() !== entrypoint) continue;
    if (!existsSync(normalized)) continue;
    return { executable: nodeExecutable, argsPrefix: [normalized] };
  }
  return undefined;
}
