#!/usr/bin/env node
import { runAutomaticVerification } from "./runtime/automaticVerification.js";

const result = await runAutomaticVerification(process.cwd());
process.exitCode = result.exitCode;
