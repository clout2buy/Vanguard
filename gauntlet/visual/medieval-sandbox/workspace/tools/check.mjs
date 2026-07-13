import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(root, "src");
const outputRoot = path.join(root, "dist");
const executable = path.join(outputRoot, "MedievalSandbox.exe");
const reportFile = path.join(outputRoot, "self-test.json");
const captureFile = path.join(outputRoot, "capture.bmp");

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

const sources = collect(sourceRoot, ".cpp");
assert.ok(sources.length > 0, "at least one C++ source file is required");
const compiler = findCompiler();
const compile = spawnSync(compiler, [
  "-std=c++17",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Wno-unused-parameter",
  "-static-libgcc",
  "-static-libstdc++",
  ...sources,
  "-o",
  executable,
  "-lopengl32",
  "-lgdi32",
  "-luser32",
  "-lwinmm",
], { cwd: root, encoding: "utf8", timeout: 180_000, maxBuffer: 10_000_000 });
assert.equal(compile.status, 0, `native compile failed\n${compile.stdout}\n${compile.stderr}`);
assert.ok(existsSync(executable), "compiler did not create MedievalSandbox.exe");

const selfTest = spawnSync(executable, ["--self-test", reportFile], {
  cwd: root,
  encoding: "utf8",
  timeout: 30_000,
  windowsHide: true,
});
assert.equal(selfTest.status, 0, `self-test failed\n${selfTest.stdout}\n${selfTest.stderr}`);
const report = JSON.parse(readFileSync(reportFile, "utf8"));
assert.ok(Number.isFinite(report.buildings) && report.buildings >= 20, "self-test requires at least 20 buildings");
assert.ok(Number.isFinite(report.villagers) && report.villagers >= 15, "self-test requires at least 15 villagers");
assert.ok(Number.isFinite(report.birds) && report.birds >= 12, "self-test requires at least 12 birds");
assert.ok(Number.isFinite(report.dragons) && report.dragons >= 1, "self-test requires a dragon");
assert.ok(Array.isArray(report.systems), "self-test systems must be an array");
for (const system of ["terrain", "town", "villagers", "birds", "dragon", "dayNight", "collision", "renderer"]) {
  assert.ok(report.systems.includes(system), `self-test is missing the ${system} system`);
}

const capture = spawnSync(executable, ["--capture", captureFile], {
  cwd: root,
  encoding: "utf8",
  timeout: 45_000,
  windowsHide: false,
});
assert.equal(capture.status, 0, `showcase capture failed\n${capture.stdout}\n${capture.stderr}`);
const bitmap = readFileSync(captureFile);
assert.equal(bitmap.subarray(0, 2).toString("ascii"), "BM", "capture must be a BMP image");
const width = bitmap.readInt32LE(18);
const height = Math.abs(bitmap.readInt32LE(22));
const bits = bitmap.readUInt16LE(28);
const offset = bitmap.readUInt32LE(10);
assert.ok(width >= 960 && height >= 540, `capture is too small: ${width}x${height}`);
assert.ok(bits === 24 || bits === 32, `capture must use 24- or 32-bit color, got ${bits}`);
assert.ok(bitmap.length >= width * height * 3, "capture pixel payload is incomplete");

const stride = Math.max(1, Math.floor((width * height) / 25_000));
const bytesPerPixel = bits / 8;
const colors = new Set();
let darkest = 255;
let brightest = 0;
for (let pixel = 0; pixel < width * height; pixel += stride) {
  const index = offset + pixel * bytesPerPixel;
  if (index + 2 >= bitmap.length) break;
  const blue = bitmap[index];
  const green = bitmap[index + 1];
  const red = bitmap[index + 2];
  colors.add(`${red >> 3},${green >> 3},${blue >> 3}`);
  const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
  darkest = Math.min(darkest, luminance);
  brightest = Math.max(brightest, luminance);
}
assert.ok(colors.size >= 80, `capture lacks visual color/detail complexity (${colors.size} sampled colors)`);
assert.ok(brightest - darkest >= 70, "capture lacks useful luminance range");

console.log(`medieval-sandbox: build, systems, and ${width}x${height} rendered capture passed`);

function collect(directory, extension) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collect(absolute, extension);
    return entry.isFile() && entry.name.endsWith(extension) ? [absolute] : [];
  }).sort();
}

function findCompiler() {
  const candidates = [
    process.env.CXX,
    "C:\\msys64\\ucrt64\\bin\\g++.exe",
    "g++",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (probe.status === 0) return candidate;
  }
  throw new Error("No usable C++ compiler was found.");
}
