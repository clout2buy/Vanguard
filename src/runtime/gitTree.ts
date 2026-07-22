// Clean-git detection for the zero-ceremony workspace default.
//
// A clean git repository already provides everything the session copy and
// fingerprint brackets exist for: `git diff` is the review surface, `git
// checkout` is the undo, and the index is the drift baseline. Vanguard
// therefore runs direct (no copy, no baseline snapshot, no per-step tree
// fingerprint) when the workspace is a clean work tree, and falls back to the
// isolated copy anywhere else — a dirty tree, no git, or a git that does not
// answer. Detection never throws and never uses a shell.
import { execFile } from "node:child_process";

const GIT_TIMEOUT_MS = 5_000;

function git(root: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(error === null ? stdout : undefined),
    );
  });
}

/**
 * True only when `root` is inside a git work tree with no staged, unstaged,
 * or untracked-but-not-ignored changes. Any failure (no git binary, not a
 * repo, timeout) answers false so the caller keeps the isolated default.
 */
export async function isCleanGitRepository(root: string): Promise<boolean> {
  const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") return false;
  const status = await git(root, ["status", "--porcelain"]);
  return status !== undefined && status.trim().length === 0;
}
