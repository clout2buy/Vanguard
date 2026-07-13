import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const workspace = path.resolve(process.argv[2] ?? ".");
const check = spawnSync(process.execPath, [path.join(workspace, "tools", "check.mjs")], {
  cwd: workspace,
  encoding: "utf8",
  timeout: 300_000,
  maxBuffer: 20_000_000,
});
assert.equal(check.status, 0, "Fresh native build, simulation self-test, or rendered capture failed.");

const sourceFiles = collect(path.join(workspace, "src"), ".cpp");
assert.ok(sourceFiles.length >= 1, "No C++ implementation was submitted.");
const source = sourceFiles.map((file) => readFileSync(file, "utf8")).join("\n");
assert.match(source, /(?:glBegin|glDrawArrays|glDrawElements)\s*\(/, "No OpenGL geometry submission was found.");
assert.match(source, /SwapBuffers\s*\(/, "No real-time frame presentation was found.");
assert.match(source, /(?:GetAsyncKeyState|WM_KEYDOWN|WM_MOUSEMOVE)/, "No interactive camera input was found.");
for (const concept of ["terrain", "villager", "bird", "dragon", "collision", "dayNight"]) {
  assert.match(source, new RegExp(concept, "i"), `Source does not contain a ${concept} implementation.`);
}
assert.ok(source.length >= 18_000, "Implementation is too small to substantiate the required multi-system 3D world.");

const bitmap = readFileSync(path.join(workspace, "dist", "capture.bmp"));
const width = bitmap.readInt32LE(18);
const height = Math.abs(bitmap.readInt32LE(22));
assert.ok(width >= 1280 && height >= 720, "Sealed capture requires at least 1280x720.");

console.log("medieval-sandbox: sealed native build and visual-system grader passed");

function collect(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collect(absolute, extension);
    return entry.isFile() && entry.name.endsWith(extension) ? [absolute] : [];
  }).sort();
}
