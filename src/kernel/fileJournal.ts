import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JournalPort, RunEvent } from "./contracts.js";

interface JournalEnvelope {
  readonly previousHash: string;
  readonly hash: string;
  readonly event: RunEvent;
}

const GENESIS_HASH = "0".repeat(64);

export class FileJournal implements JournalPort {
  #lastHash: string;
  #writeChain: Promise<void> = Promise.resolve();

  private constructor(
    readonly file: string,
    lastHash: string,
  ) {
    this.#lastHash = lastHash;
  }

  static async open(file: string): Promise<FileJournal> {
    const absolute = path.resolve(file);
    await mkdir(path.dirname(absolute), { recursive: true });
    try {
      await writeFile(absolute, "", { flag: "wx" });
    } catch (error) {
      if (!isExisting(error)) throw error;
    }
    const envelopes = await readValidatedJournal(absolute);
    return new FileJournal(absolute, envelopes.at(-1)?.hash ?? GENESIS_HASH);
  }

  async append(event: RunEvent): Promise<void> {
    const operation = this.#writeChain.then(async () => {
      const previousHash = this.#lastHash;
      const hash = envelopeHash(previousHash, event);
      const envelope: JournalEnvelope = { previousHash, hash, event };
      await appendFile(this.file, `${JSON.stringify(envelope)}\n`, "utf8");
      this.#lastHash = hash;
    });
    this.#writeChain = operation.catch(() => undefined);
    return operation;
  }

  async readValidated(): Promise<readonly RunEvent[]> {
    await this.#writeChain;
    return (await readValidatedJournal(this.file)).map((envelope) => envelope.event);
  }
}

async function readValidatedJournal(file: string): Promise<JournalEnvelope[]> {
  const contents = await readFile(file, "utf8");
  const lines = contents.split("\n").filter((line) => line.length > 0);
  const envelopes: JournalEnvelope[] = [];
  let previousHash = GENESIS_HASH;

  for (const [index, line] of lines.entries()) {
    const parsed = JSON.parse(line) as JournalEnvelope;
    if (parsed.previousHash !== previousHash || parsed.hash !== envelopeHash(previousHash, parsed.event)) {
      throw new Error(`Journal integrity failure at line ${index + 1}.`);
    }
    envelopes.push(parsed);
    previousHash = parsed.hash;
  }
  return envelopes;
}

function envelopeHash(previousHash: string, event: RunEvent): string {
  return createHash("sha256").update(previousHash).update("\n").update(JSON.stringify(event)).digest("hex");
}

function isExisting(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
