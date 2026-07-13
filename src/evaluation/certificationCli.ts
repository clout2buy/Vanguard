#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AssignmentBundle,
  CertificationLedgerEntry,
  CertificationManifest,
  PrivateAssignment,
  PublicAssignment,
} from "./certification.js";
import {
  createBlindedAssignments,
  estimateCertificationCost,
  evaluateCertificate,
  manifestSha256,
  validateCertificationLedger,
  validateCertificationManifest,
} from "./certification.js";

interface PublicAssignmentFile {
  readonly manifestSha256: string;
  readonly assignments: readonly PublicAssignment[];
}

interface PrivateAssignmentFile {
  readonly manifestSha256: string;
  readonly assignments: readonly PrivateAssignment[];
}

export async function runCertificationCli(argv: readonly string[]): Promise<JsonOutput> {
  const command = argv[0];
  const options = parseOptions(argv.slice(1));
  if (command === "validate") {
    const manifest = await readJson<CertificationManifest>(required(options, "manifest"));
    validateCertificationManifest(manifest);
    return { ok: true, manifestSha256: manifestSha256(manifest), holdoutTasks: manifest.tasks.filter((task) => task.layer === "holdout").length };
  }
  if (command === "blind") {
    const manifest = await readJson<CertificationManifest>(required(options, "manifest"));
    const secretName = options.get("secret-env") ?? "VANGUARD_BLINDING_SECRET";
    const secret = process.env[secretName];
    if (secret === undefined) throw new Error(`Blinding secret environment variable '${secretName}' is not set.`);
    const bundle = createBlindedAssignments(manifest, secret);
    const publicFile = path.resolve(required(options, "public-out"));
    const privateFile = path.resolve(required(options, "private-out"));
    if (publicFile === privateFile) throw new Error("Public and private assignment files must be different.");
    await exclusiveJson(publicFile, { manifestSha256: bundle.manifestSha256, assignments: bundle.publicAssignments });
    try {
      await exclusiveJson(privateFile, { manifestSha256: bundle.manifestSha256, assignments: bundle.privateAssignments });
    } catch (error) {
      // The public file contains no secret mapping and is safe to leave for
      // forensic visibility; never overwrite either side implicitly.
      throw error;
    }
    return {
      ok: true,
      manifestSha256: bundle.manifestSha256,
      assignments: bundle.publicAssignments.length,
      publicFile,
      privateFile,
    };
  }
  if (command === "evaluate") {
    const manifest = await readJson<CertificationManifest>(required(options, "manifest"));
    const publicFile = await readJson<PublicAssignmentFile>(required(options, "public"));
    const privateFile = await readJson<PrivateAssignmentFile>(required(options, "private"));
    const ledger = await readJson<readonly CertificationLedgerEntry[]>(required(options, "ledger"));
    if (publicFile.manifestSha256 !== privateFile.manifestSha256) throw new Error("Public/private assignment manifests differ.");
    const bundle: AssignmentBundle = {
      manifestSha256: publicFile.manifestSha256,
      publicAssignments: publicFile.assignments,
      privateAssignments: privateFile.assignments,
    };
    validateCertificationLedger(ledger);
    return evaluateCertificate(manifest, bundle, ledger) as unknown as JsonOutput;
  }
  if (command === "estimate") {
    const manifest = await readJson<CertificationManifest>(required(options, "manifest"));
    const assumptions = await readJson<Readonly<Record<string, { readonly meanCostPerTaskUsd: number }>>>(required(options, "assumptions"));
    return { ok: true, ...estimateCertificationCost(manifest, assumptions) };
  }
  throw new Error("Usage: certificationCli validate|blind|evaluate|estimate --manifest FILE [command options]");
}

type JsonOutput = { readonly [key: string]: unknown };

function parseOptions(args: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid option near '${key ?? "end of command"}'.`);
    }
    const name = key.slice(2);
    if (options.has(name)) throw new Error(`Duplicate option '--${name}'.`);
    options.set(name, value);
  }
  return options;
}

function required(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined) throw new Error(`Missing required option '--${name}'.`);
  return value;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.resolve(file), "utf8")) as T;
}

async function exclusiveJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/u, "$1"))) {
  runCertificationCli(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error: unknown) => {
      process.stderr.write(`Certification command failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
