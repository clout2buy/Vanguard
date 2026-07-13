import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
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

const sourceFiles = [
  ...collect(path.join(workspace, "src"), ".cpp"),
  ...collect(path.join(workspace, "src"), ".h"),
].sort();
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
const quality = analyzeBitmap(bitmap);
const { width, height } = quality;
assert.ok(width >= 1280 && height >= 720, "Sealed capture requires at least 1280x720.");
assert.ok(
  quality.meanLuminance >= 90 && quality.meanLuminance <= 220,
  `Showcase frame is not readably exposed (mean luminance ${quality.meanLuminance.toFixed(1)}).`,
);
assert.ok(
  quality.luminanceDeviation >= 22,
  `Showcase frame lacks readable tonal separation (${quality.luminanceDeviation.toFixed(1)} luminance deviation).`,
);
assert.ok(
  quality.quantizedColors >= 96,
  `Showcase frame lacks broad scene/color detail (${quality.quantizedColors} quantized colors).`,
);
assert.ok(
  quality.bottomHudBrightRatio >= 0.0005,
  "Showcase frame does not contain visible high-contrast HUD/help evidence in its lower region.",
);

const repeatFile = path.join(workspace, "dist", "capture-repeat.bmp");
const repeat = spawnSync(path.join(workspace, "dist", "MedievalSandbox.exe"), ["--capture", repeatFile], {
  cwd: workspace,
  encoding: "utf8",
  timeout: 45_000,
  windowsHide: true,
});
assert.equal(repeat.status, 0, `Repeated deterministic capture failed.\n${repeat.stdout}\n${repeat.stderr}`);
const repeatedBitmap = readFileSync(repeatFile);
rmSync(repeatFile, { force: true });
const stability = compareBitmapPixels(bitmap, repeatedBitmap);
assert.ok(
  stability.changedPixelRatio <= 0.001 && stability.meanAbsoluteChannelDelta <= 0.05,
  `Repeated showcase captures are not pixel-stable (${(stability.changedPixelRatio * 100).toFixed(3)}% changed pixels, ${stability.meanAbsoluteChannelDelta.toFixed(3)} mean channel delta).`,
);

console.log("medieval-sandbox: sealed native build and visual-system grader passed");

function analyzeBitmap(bitmap) {
  assert.equal(bitmap.subarray(0, 2).toString("ascii"), "BM", "Sealed capture must be a BMP image.");
  const pixelOffset = bitmap.readUInt32LE(10);
  const width = bitmap.readInt32LE(18);
  const signedHeight = bitmap.readInt32LE(22);
  const height = Math.abs(signedHeight);
  const bits = bitmap.readUInt16LE(28);
  assert.ok(bits === 24 || bits === 32, `Sealed capture must use 24- or 32-bit color, got ${bits}.`);
  const bytesPerPixel = bits / 8;
  const rowStride = Math.ceil((width * bytesPerPixel) / 4) * 4;
  assert.ok(bitmap.length >= pixelOffset + rowStride * height, "Sealed capture pixel payload is incomplete.");

  const colors = new Set();
  let luminanceTotal = 0;
  let luminanceSquaredTotal = 0;
  let bottomPixels = 0;
  let bottomHudBrightPixels = 0;
  for (let fileY = 0; fileY < height; fileY += 1) {
    const visualY = signedHeight > 0 ? height - 1 - fileY : fileY;
    const inBottomRegion = visualY >= Math.floor(height * 0.72);
    for (let x = 0; x < width; x += 1) {
      const index = pixelOffset + fileY * rowStride + x * bytesPerPixel;
      const blue = bitmap[index];
      const green = bitmap[index + 1];
      const red = bitmap[index + 2];
      colors.add(`${red >> 4},${green >> 4},${blue >> 4}`);
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      luminanceTotal += luminance;
      luminanceSquaredTotal += luminance * luminance;
      if (inBottomRegion) {
        bottomPixels += 1;
        const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
        if (luminance >= 210 && chroma <= 45) bottomHudBrightPixels += 1;
      }
    }
  }

  const pixels = width * height;
  const meanLuminance = luminanceTotal / pixels;
  const variance = Math.max(0, luminanceSquaredTotal / pixels - meanLuminance ** 2);
  return {
    width,
    height,
    meanLuminance,
    luminanceDeviation: Math.sqrt(variance),
    quantizedColors: colors.size,
    bottomHudBrightRatio: bottomHudBrightPixels / bottomPixels,
  };
}

function compareBitmapPixels(left, right) {
  const leftInfo = bitmapInfo(left);
  const rightInfo = bitmapInfo(right);
  assert.equal(rightInfo.width, leftInfo.width, "Repeated capture width changed.");
  assert.equal(rightInfo.height, leftInfo.height, "Repeated capture height changed.");
  let changedPixels = 0;
  let absoluteDelta = 0;
  for (let visualY = 0; visualY < leftInfo.height; visualY += 1) {
    const leftFileY = leftInfo.signedHeight > 0 ? leftInfo.height - 1 - visualY : visualY;
    const rightFileY = rightInfo.signedHeight > 0 ? rightInfo.height - 1 - visualY : visualY;
    for (let x = 0; x < leftInfo.width; x += 1) {
      const leftIndex = leftInfo.pixelOffset + leftFileY * leftInfo.rowStride + x * leftInfo.bytesPerPixel;
      const rightIndex = rightInfo.pixelOffset + rightFileY * rightInfo.rowStride + x * rightInfo.bytesPerPixel;
      let changed = false;
      for (let channel = 0; channel < 3; channel += 1) {
        const delta = Math.abs(left[leftIndex + channel] - right[rightIndex + channel]);
        absoluteDelta += delta;
        if (delta !== 0) changed = true;
      }
      if (changed) changedPixels += 1;
    }
  }
  const pixels = leftInfo.width * leftInfo.height;
  return {
    changedPixelRatio: changedPixels / pixels,
    meanAbsoluteChannelDelta: absoluteDelta / (pixels * 3),
  };
}

function bitmapInfo(bitmap) {
  assert.equal(bitmap.subarray(0, 2).toString("ascii"), "BM", "Capture must be a BMP image.");
  const pixelOffset = bitmap.readUInt32LE(10);
  const width = bitmap.readInt32LE(18);
  const signedHeight = bitmap.readInt32LE(22);
  const height = Math.abs(signedHeight);
  const bits = bitmap.readUInt16LE(28);
  assert.ok(bits === 24 || bits === 32, `Capture must use 24- or 32-bit color, got ${bits}.`);
  const bytesPerPixel = bits / 8;
  const rowStride = Math.ceil((width * bytesPerPixel) / 4) * 4;
  assert.ok(bitmap.length >= pixelOffset + rowStride * height, "Capture pixel payload is incomplete.");
  return { pixelOffset, width, signedHeight, height, bytesPerPixel, rowStride };
}

function collect(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collect(absolute, extension);
    return entry.isFile() && entry.name.endsWith(extension) ? [absolute] : [];
  }).sort();
}
