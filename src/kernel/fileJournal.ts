import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JournalPort, RunEvent } from "./contracts.js";

interface JournalEnvelope {
  readonly previousHash: string;
  readonly hash: string;
  readonly event: RunEvent;
}

export const JOURNAL_GENESIS_HASH = "0".repeat(64);

export interface JournalTip {
  readonly hash: string;
  readonly sequence: number;
}

export class FileJournal implements JournalPort {
  #lastHash: string;
  #writeChain: Promise<void> = Promise.resolve();
  /**
   * Events validated so far, in order, plus the exact byte length of the file
   * they came from. This instance is the session's single sanctioned writer,
   * so its own appends keep the cache exact; a byte-length mismatch means an
   * out-of-band writer touched the file and forces a full re-validation.
   * Without this cache every readValidated() re-parsed and re-hashed the whole
   * chain, which made evidence resolution O(history²) over a session.
   */
  #events: RunEvent[];
  #validBytes: number;

  private constructor(
    readonly file: string,
    readonly genesisHash: string,
    envelopes: readonly JournalEnvelope[],
    validBytes: number,
  ) {
    this.#lastHash = envelopes.at(-1)?.hash ?? genesisHash;
    this.#events = envelopes.map((envelope) => envelope.event);
    this.#validBytes = validBytes;
  }

  static async open(file: string, options: { readonly genesisHash?: string } = {}): Promise<FileJournal> {
    const absolute = path.resolve(file);
    const genesisHash = options.genesisHash ?? JOURNAL_GENESIS_HASH;
    if (!/^[a-f0-9]{64}$/.test(genesisHash)) throw new Error("Journal genesis hash is malformed.");
    await mkdir(path.dirname(absolute), { recursive: true });
    try {
      await writeFile(absolute, "", { flag: "wx" });
    } catch (error) {
      if (!isExisting(error)) throw error;
    }
    const { envelopes, byteLength } = await readValidatedJournal(absolute, genesisHash);
    return new FileJournal(absolute, genesisHash, envelopes, byteLength);
  }

  async append(event: RunEvent): Promise<void> {
    const operation = this.#writeChain.then(async () => {
      const previousHash = this.#lastHash;
      const hash = envelopeHash(previousHash, event);
      const envelope: JournalEnvelope = { previousHash, hash, event };
      const line = `${JSON.stringify(envelope)}\n`;
      await appendFile(this.file, line, "utf8");
      this.#lastHash = hash;
      this.#events.push(event);
      this.#validBytes += Buffer.byteLength(line, "utf8");
    });
    this.#writeChain = operation.catch(() => undefined);
    return operation;
  }

  async readValidated(): Promise<readonly RunEvent[]> {
    await this.#writeChain;
    await this.#refresh();
    return [...this.#events];
  }

  async tip(): Promise<JournalTip> {
    await this.#writeChain;
    await this.#refresh();
    return { hash: this.#lastHash, sequence: this.#events.at(-1)?.sequence ?? 0 };
  }

  /** Re-validates from disk only when the file no longer matches our own writes. */
  async #refresh(): Promise<void> {
    const size = (await stat(this.file)).size;
    if (size === this.#validBytes) return;
    const { envelopes, byteLength } = await readValidatedJournal(this.file, this.genesisHash);
    this.#events = envelopes.map((envelope) => envelope.event);
    this.#lastHash = envelopes.at(-1)?.hash ?? this.genesisHash;
    this.#validBytes = byteLength;
  }
}

async function readValidatedJournal(
  file: string,
  genesisHash: string,
): Promise<{ envelopes: JournalEnvelope[]; byteLength: number }> {
  const contents = await readFile(file, "utf8");
  const lines = contents.split("\n").filter((line) => line.length > 0);
  const envelopes: JournalEnvelope[] = [];
  let previousHash = genesisHash;

  for (const [index, line] of lines.entries()) {
    const parsed = JSON.parse(line) as JournalEnvelope;
    if (parsed.previousHash !== previousHash || parsed.hash !== envelopeHash(previousHash, parsed.event)) {
      throw new Error(`Journal integrity failure at line ${index + 1}.`);
    }
    envelopes.push(parsed);
    previousHash = parsed.hash;
  }
  return { envelopes, byteLength: Buffer.byteLength(contents, "utf8") };
}

function envelopeHash(previousHash: string, event: RunEvent): string {
  return createHash("sha256").update(previousHash).update("\n").update(JSON.stringify(event)).digest("hex");
}

function isExisting(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
