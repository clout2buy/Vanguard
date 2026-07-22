#!/usr/bin/env node
import { parseVerificationMode, runAutomaticVerification } from "./runtime/automaticVerification.js";

// The mode rides in the sealed verifier's own argv, so it is part of the frozen
// command recorded on the session — not an environment variable the agent could
// reach in to change mid-run.
const flag = process.argv.indexOf("--mode");
const mode = parseVerificationMode(flag === -1 ? undefined : process.argv[flag + 1]);
const result = await runAutomaticVerification(process.cwd(), mode);
process.exitCode = result.exitCode;
