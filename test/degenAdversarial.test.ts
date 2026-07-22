import assert from "node:assert/strict";
import test from "node:test";
import { detectDegenerateRepetition } from "../src/index.js";

// Adversarial probe authored by Ares, not the building agent.
// The watchdog only catches CONSECUTIVE identical lines. A real decoder
// spiral often cycles between a small set of lines. These prove the seam.

function cycle(lines: string[], reps: number): string {
  const out: string[] = [];
  for (let i = 0; i < reps; i += 1) out.push(...lines);
  return out.join("\n");
}

test("ADVERSARIAL: 2-line alternating spiral juke", () => {
  // front/back/front/back... 20 lines of pure degenerate garbage, 0 runs of 5.
  const spiral = cycle(["// I'm a front-end developer", "// I'm a back-end developer"], 20);
  const found = detectDegenerateRepetition(spiral);
  console.log("alternating-2 result:", found);
  assert.ok(found !== undefined, "alternating 2-line spiral slips past the watchdog");
});

test("ADVERSARIAL: near-miss ramp (4 identical, break, 4 identical)", () => {
  const line = "// I'm a full-stack developer";
  const ramp = [
    ...Array(4).fill(line), "const x = 1;",
    ...Array(4).fill(line), "const y = 2;",
    ...Array(4).fill(line),
  ].join("\n");
  const found = detectDegenerateRepetition(ramp);
  console.log("ramp result:", found);
  assert.ok(found !== undefined, "ramped spiral broken by tiny variation slips past");
});
