// On-disk home for OAuth tokens.
//
// Vanguard keeps subscription credentials in its OWN directory and never reads
// Claude Code, Codex, or Ares credential stores: a token this process did not
// mint is a token this process cannot reason about the provenance of. Files are
// written atomically (temp + rename) at mode 0600 so a crashed write can never
// leave a half-parsed token behind.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function vanguardHome(): string {
  const configured = process.env.VANGUARD_HOME?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  return path.join(os.homedir(), ".vanguard");
}

export function oauthFilePath(file: string): string {
  return path.join(vanguardHome(), file);
}

/** Parse a stored token file, or null when absent/corrupt. Never throws. */
export async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  const temp = `${file}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, file);
}

export async function removeFile(file: string): Promise<void> {
  await rm(file, { force: true }).catch(() => {});
}

export function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/**
 * Decode a JWT payload without verifying it. The id_token here arrives over TLS
 * from the token endpoint we just called, and is read only for display claims
 * (email, plan) and the account id header — never for an authorization decision.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1];
    if (payload === undefined) return {};
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return {};
    return decoded as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Truncate provider error bodies so an HTML challenge page never reaches the UI. */
export function shortDetail(raw: string): string {
  const text = raw.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
  if (text.length === 0) return "";
  if (text.length > 140) return "the sign-in service returned an unexpected page (possibly a bot check)";
  return text;
}
