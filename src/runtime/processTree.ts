import { spawn, type ChildProcess } from "node:child_process";

/**
 * Process-tree termination.
 *
 * `child.kill()` reaches only the direct child. A wrapper — `cmd.exe /c`, a
 * shell script, an npm lifecycle — leaves its grandchildren alive holding the
 * stdio pipes, so `close` never fires and the caller cannot prove the tree
 * died. That is not academic: it is exactly how a silent installer survived an
 * idle-kill, kept running unsupervised, and permanently fenced a session.
 *
 * The ladder is the same wherever a child must die: signal the whole tree,
 * escalate, then report honestly if closure still cannot be proven.
 */

/** Kills the child and everything it spawned, as one tree. */
export function killProcessTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    // taskkill /T must run while the direct child is still alive: its PID is
    // the only handle to the tree, and grandchildren reparent beyond reach
    // the moment it dies.
    if (child.pid !== undefined) {
      try {
        spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        }).on("error", () => {
          try { child.kill("SIGKILL"); } catch { /* closure proof is the authority */ }
        });
        return;
      } catch { /* fall through to the direct kill */ }
    }
    try { child.kill("SIGKILL"); } catch { /* closure proof is the authority */ }
    return;
  }
  // POSIX children are spawned detached, so the negative pid addresses the
  // whole process group in one signal.
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch { /* the group may already be gone; fall back to the direct child */ }
  }
  try { child.kill(signal); } catch { /* closure proof is the authority */ }
}

/** Grace period before escalating from SIGTERM to SIGKILL. */
const ESCALATION_MS = 1_000;
/** taskkill spawns a process and walks the tree; give it room on Windows. */
const CLOSURE_DEADLINE_MS = process.platform === "win32" ? 2_000 : 1_000;

/**
 * Terminates a tree and reports whether closure was actually observed.
 * `false` means the caller must treat containment as uncertain — never that
 * the process is presumed dead.
 */
export async function terminateProcessTree(
  child: ChildProcess,
  isClosed: () => boolean,
): Promise<boolean> {
  if (isClosed()) return true;
  killProcessTree(child, "SIGTERM");
  if (await waitFor(isClosed, ESCALATION_MS)) return true;
  killProcessTree(child, "SIGKILL");
  return waitFor(isClosed, CLOSURE_DEADLINE_MS);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}
