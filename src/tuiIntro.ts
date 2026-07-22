// CONVERGENCE — the Vanguard launch sequence.
//
// The screen opens on a cold starfield. The stars hesitate, then all of them
// fall inward at once, accelerating into a single white point. The point
// detonates into a shockwave, the wave freezes mid-flight into a crystalline
// frame, the VANGUARD wordmark crystallizes letter by letter, and a gold
// verification sweep seals the emblem before the whole thing fades to void.
//
// Pure ANSI, no dependencies, fully deterministic frames (seeded, analytic —
// never simulated), so the entire sequence is unit-testable. It owns the
// whole screen while it plays and refuses to run anywhere it could
// misbehave: non-TTY streams, tiny terminals, and VANGUARD_NO_INTRO=1 skip
// straight to the welcome. The cursor is restored on every exit path.

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

const rgb = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`;

const ink = {
  ice: rgb(112, 216, 255),
  violet: rgb(158, 118, 255),
  pink: rgb(226, 132, 255),
  gold: rgb(255, 214, 110),
  white: `${BOLD}${rgb(246, 248, 255)}`,
  steel: rgb(122, 130, 170),
  slate: rgb(136, 142, 178),
  faint: rgb(62, 68, 104),
  dimStar: rgb(40, 45, 72),
};

/** Deterministic PRNG (mulberry32) — the same frames on every launch. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

interface Cell {
  readonly ch: string;
  readonly color: string;
}

type Grid = Cell[][];

function newGrid(width: number, height: number): Grid {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ ch: " ", color: "" })));
}

function plot(grid: Grid, x: number, y: number, ch: string, color: string): void {
  const row = grid[Math.round(y)];
  if (row === undefined) return;
  const column = Math.round(x);
  if (column < 0 || column >= row.length) return;
  row[column] = { ch, color };
}

/** Run-length encode a grid into ANSI rows: one color escape per run, never per cell. */
function serialize(grid: Grid): string[] {
  return grid.map((row) => {
    let out = "";
    let runColor = row[0]?.color ?? "";
    let run = "";
    for (const cell of row) {
      if (cell.color === runColor) {
        run += cell.ch;
        continue;
      }
      out += runColor.length === 0 ? run : `${runColor}${run}${RESET}`;
      runColor = cell.color;
      run = cell.ch;
    }
    out += runColor.length === 0 ? run : `${runColor}${run}${RESET}`;
    return out;
  });
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

/** Violet → ice → white ramp used by the wordmark and the convergence. */
function rampColor(t: number): string {
  if (t < 0.45) return ink.violet;
  if (t < 0.8) return ink.ice;
  return ink.white;
}

interface Star {
  readonly x: number;
  readonly y: number;
  readonly phase: number;
  readonly stagger: number;
}

function makeStars(count: number, width: number, height: number, seed: number): Star[] {
  const random = mulberry32(seed);
  const stars: Star[] = [];
  for (let index = 0; index < count; index += 1) {
    stars.push({
      x: Math.floor(random() * width),
      y: Math.floor(random() * height),
      phase: Math.floor(random() * 3),
      stagger: random() * 0.25,
    });
  }
  return stars;
}

export interface IntroFrame {
  readonly lines: readonly string[];
  readonly holdMs: number;
}

/** Letter reveal order for the wordmark: crystallize from the center outward. */
function centerOutOrder(length: number): number[] {
  const order: number[] = [];
  let left = Math.floor((length - 1) / 2);
  let right = left + 1;
  if (length % 2 === 0) {
    order.push(left, right);
    left -= 1;
    right += 1;
  } else {
    order.push(left);
    left -= 1;
  }
  while (left >= 0 || right < length) {
    if (left >= 0) order.push(left);
    if (right < length) order.push(right);
    left -= 1;
    right += 1;
  }
  return order;
}

interface EmblemOptions {
  /** 0..1 — how far the box border has grown from the center. */
  readonly borderGrow: number;
  /** Letters (center-out order) currently visible. */
  readonly lettersVisible: number;
  /** 0..1 — gold seal line under the wordmark. */
  readonly seal: number;
  /** X of the verification sweep head, or undefined when not sweeping. */
  readonly sweepX?: number;
  /** Tagline characters currently visible (center-out). */
  readonly taglineVisible: number;
  /** Paint everything in one flat color (fade-out). */
  readonly ghost?: boolean;
}

/** The frozen shockwave: box, wordmark, seal line, and tagline, staged. */
function paintEmblem(
  grid: Grid,
  cx: number,
  cy: number,
  wordmark: string,
  tagline: string,
  options: EmblemOptions,
): void {
  const width = grid[0]!.length;
  const innerWidth = wordmark.length + 2;
  const left = cx - Math.floor(innerWidth / 2) - 1;
  const borderColor = options.ghost === true ? ink.faint : ink.violet;

  // Border grows horizontally from the center; corners and sides land last.
  const halfReach = Math.floor(options.borderGrow * (innerWidth / 2 + 1));
  for (let x = cx - halfReach; x <= cx + halfReach; x += 1) {
    const edge = x === cx - halfReach || x === cx + halfReach;
    plot(grid, x, cy - 2, edge && options.borderGrow < 1 ? "•" : "─", borderColor);
    plot(grid, x, cy + 2, edge && options.borderGrow < 1 ? "•" : "─", borderColor);
  }
  if (options.borderGrow >= 1) {
    plot(grid, left, cy - 2, "╭", borderColor);
    plot(grid, left + innerWidth + 1, cy - 2, "╮", borderColor);
    plot(grid, left, cy + 2, "╰", borderColor);
    plot(grid, left + innerWidth + 1, cy + 2, "╯", borderColor);
    for (const y of [cy - 1, cy, cy + 1]) {
      plot(grid, left, y, "│", borderColor);
      plot(grid, left + innerWidth + 1, y, "│", borderColor);
    }
  }

  // The wordmark crystallizes letter by letter, center outward. The order
  // runs over letter positions, not raw indices, so spacing never eats a reveal.
  const letterPositions = [...wordmark].flatMap((character, index) => (character === " " ? [] : [index]));
  const order = centerOutOrder(letterPositions.length).map((position) => letterPositions[position]!);
  const visible = new Set(order.slice(0, options.lettersVisible));
  const wordLeft = left + 2;
  for (let index = 0; index < wordmark.length; index += 1) {
    const character = wordmark[index]!;
    const x = wordLeft + index;
    if (character === " ") continue;
    if (!visible.has(index)) {
      if (options.lettersVisible > 0 && options.ghost !== true) plot(grid, x, cy, "·", ink.faint);
      continue;
    }
    let color = options.ghost === true ? ink.faint : rampColor(index / Math.max(1, wordmark.length - 1));
    if (options.sweepX !== undefined && options.ghost !== true) {
      const distance = Math.abs(x - options.sweepX);
      if (distance === 0) color = ink.white;
      else if (distance <= 2) color = ink.gold;
    }
    plot(grid, x, cy, character, color);
  }

  // The gold seal line under the wordmark: verification made visible.
  if (options.seal > 0 && options.borderGrow >= 1) {
    const sealed = Math.floor(options.seal * innerWidth);
    for (let offset = 0; offset < sealed; offset += 1) {
      plot(grid, left + 1 + offset, cy + 1, "─", options.ghost === true ? ink.faint : ink.gold);
    }
  }

  // Tagline condenses out of the void, center outward.
  if (options.taglineVisible > 0) {
    const tagOrder = centerOutOrder(tagline.length);
    const tagVisible = new Set(tagOrder.slice(0, options.taglineVisible));
    const tagLeft = Math.max(0, Math.floor((width - tagline.length) / 2));
    for (let index = 0; index < tagline.length; index += 1) {
      if (!tagVisible.has(index)) continue;
      plot(grid, tagLeft + index, cy + 4, tagline[index]!, options.ghost === true ? ink.faint : ink.slate);
    }
  }
}

/**
 * Deterministic frame script for the launch animation; exported for tests.
 * Every frame paints the same fixed-size canvas, so the sequence can never
 * jitter or shear the terminal.
 */
export function buildIntroFrames(columns = 80, rows = 24): readonly IntroFrame[] {
  const grand = columns >= 96 && rows >= 28;
  const width = Math.max(40, Math.min(columns - 2, grand ? 92 : 72));
  const height = grand ? 17 : 13;
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const wordmark = grand ? "V A N G U A R D" : "VANGUARD";
  const tagline = "VERIFICATION-FIRST · AGENTIC ENGINE";
  const letters = [...wordmark].filter((character) => character !== " ").length;
  const stars = makeStars(grand ? 30 : 20, width, height, 0x9e3779b9);
  const frames: IntroFrame[] = [];
  const push = (grid: Grid, holdMs: number): void => {
    frames.push({ lines: serialize(grid), holdMs });
  };

  // Phase 1 — cold open: a sparse starfield twinkles in the void.
  for (let frame = 0; frame < 6; frame += 1) {
    const grid = newGrid(width, height);
    for (const star of stars) {
      const brightness = (frame + star.phase) % 3;
      if (brightness === 0) plot(grid, star.x, star.y, "·", ink.dimStar);
      else if (brightness === 1) plot(grid, star.x, star.y, "+", ink.steel);
      else plot(grid, star.x, star.y, "✦", ink.violet);
    }
    push(grid, 88);
  }

  // Phase 2 — convergence: every star falls into the center, accelerating.
  for (let frame = 0; frame < 8; frame += 1) {
    const grid = newGrid(width, height);
    const t = (frame + 1) / 8;
    for (const star of stars) {
      const local = Math.min(1, Math.max(0, t * t - star.stagger * 0.4));
      const headX = lerp(star.x, cx, local);
      const headY = lerp(star.y, cy, local);
      const trailX = lerp(star.x, cx, Math.max(0, local - 0.16));
      const trailY = lerp(star.y, cy, Math.max(0, local - 0.16));
      plot(grid, trailX, trailY, "·", ink.faint);
      const glyph = local < 0.5 ? "·" : local < 0.85 ? "•" : "●";
      const color = local < 0.35 ? ink.steel : local < 0.7 ? ink.violet : local < 0.95 ? ink.ice : ink.white;
      plot(grid, headX, headY, glyph, color);
    }
    push(grid, 58);
  }

  // Phase 3 — ignition: the mass collapses to a point and flashes.
  {
    const grid = newGrid(width, height);
    plot(grid, cx, cy, "●", ink.white);
    push(grid, 120);
  }
  {
    const grid = newGrid(width, height);
    plot(grid, cx, cy, "◉", ink.white);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-2, 0], [2, 0], [-1, -1], [1, 1]] as const) {
      plot(grid, cx + dx, cy + dy, "·", ink.ice);
    }
    push(grid, 100);
  }
  {
    const grid = newGrid(width, height);
    for (let x = 0; x < width; x += 1) {
      const distance = Math.abs(x - cx) / cx;
      plot(grid, x, cy, "═", distance < 0.12 ? ink.white : distance < 0.55 ? ink.ice : ink.faint);
    }
    plot(grid, cx, cy, "◉", ink.white);
    push(grid, 95);
  }

  // Phase 4 — shockwave: one elliptical front races outward and cools.
  const radii = [2, 3.8, 5.8, 8, 10.4];
  for (const [ringIndex, radius] of radii.entries()) {
    const grid = newGrid(width, height);
    const cooling = ringIndex / (radii.length - 1);
    const color = cooling < 0.34 ? ink.ice : cooling < 0.67 ? ink.violet : ink.faint;
    for (let degree = 0; degree < 360; degree += 2) {
      const angle = (degree * Math.PI) / 180;
      plot(grid, cx + Math.cos(angle) * radius * 2.1, cy + Math.sin(angle) * radius, "·", color);
    }
    plot(grid, cx, cy, ringIndex < 2 ? "●" : "·", ringIndex < 2 ? ink.violet : ink.faint);
    push(grid, 54);
  }

  // Phase 5 — crystallization: the wave freezes into the emblem, the
  // wordmark condenses letter by letter, faint stars return for depth.
  const crystallizeFrames = 7;
  for (let frame = 0; frame < crystallizeFrames; frame += 1) {
    const grid = newGrid(width, height);
    for (const star of stars) plot(grid, star.x, star.y, "·", ink.dimStar);
    const grow = Math.min(1, ((frame + 1) / crystallizeFrames) * 1.35);
    const lettersVisible = frame < 2 ? 0 : Math.min(letters, (frame - 1) * 2);
    paintEmblem(grid, cx, cy, wordmark, tagline, {
      borderGrow: grow,
      lettersVisible,
      seal: 0,
      taglineVisible: 0,
    });
    push(grid, 64);
  }

  // Phase 6 — the tagline condenses.
  for (let frame = 0; frame < 3; frame += 1) {
    const grid = newGrid(width, height);
    for (const star of stars) plot(grid, star.x, star.y, "·", ink.dimStar);
    paintEmblem(grid, cx, cy, wordmark, tagline, {
      borderGrow: 1,
      lettersVisible: letters,
      seal: 0,
      taglineVisible: Math.floor(((frame + 1) / 3) * tagline.length),
    });
    push(grid, 62);
  }

  // Phase 7 — the verification sweep: a gold front crosses the wordmark and
  // seals it. This is the brand promise staged as motion: proof, then rest.
  for (let frame = 0; frame < 4; frame += 1) {
    const grid = newGrid(width, height);
    for (const star of stars) plot(grid, star.x, star.y, "·", ink.dimStar);
    paintEmblem(grid, cx, cy, wordmark, tagline, {
      borderGrow: 1,
      lettersVisible: letters,
      seal: (frame + 1) / 4,
      sweepX: Math.floor(((frame + 1) / 4) * (width - 1)),
      taglineVisible: tagline.length,
    });
    push(grid, 66);
  }

  // Phase 8 — the sealed emblem holds.
  {
    const grid = newGrid(width, height);
    for (const star of stars) plot(grid, star.x, star.y, "·", ink.dimStar);
    paintEmblem(grid, cx, cy, wordmark, tagline, {
      borderGrow: 1,
      lettersVisible: letters,
      seal: 1,
      taglineVisible: tagline.length,
    });
    push(grid, 620);
  }

  // Phase 9 — fade to void: first the color drains, then only the cold box
  // remains, and the welcome inherits a quiet screen.
  {
    const grid = newGrid(width, height);
    paintEmblem(grid, cx, cy, wordmark, tagline, {
      borderGrow: 1,
      lettersVisible: letters,
      seal: 1,
      taglineVisible: tagline.length,
      ghost: true,
    });
    push(grid, 110);
  }
  {
    const grid = newGrid(width, height);
    paintEmblem(grid, cx, cy, wordmark, tagline, {
      borderGrow: 1,
      lettersVisible: 0,
      seal: 0,
      taglineVisible: 0,
      ghost: true,
    });
    push(grid, 95);
  }

  return frames;
}

/**
 * Plays CONVERGENCE over a cleared screen — centered vertically and
 * horizontally — then wipes it so the welcome starts clean. Returns
 * immediately anywhere the animation could misbehave.
 */
export async function playIntroAnimation(
  out: Pick<NodeJS.WriteStream, "write" | "isTTY" | "columns" | "rows"> = process.stdout,
): Promise<void> {
  if (out.isTTY !== true) return;
  if (process.env.VANGUARD_NO_INTRO === "1") return;
  const columns = out.columns ?? 0;
  const rows = out.rows ?? 0;
  if (columns < 47 || rows < 17) return;
  const frames = buildIntroFrames(columns, rows);
  const height = frames[0]!.lines.length;
  const top = Math.max(1, Math.floor((rows - height) / 2) + 1);
  // Take the whole screen: the intro is a curtain, not a log line.
  out.write("\x1b[?25l\x1b[2J\x1b[H");
  try {
    for (const frame of frames) {
      out.write(`\x1b[${top};1H${frame.lines.map((line) => `\x1b[2K${line}`).join("\n")}`);
      await new Promise((resolve) => setTimeout(resolve, frame.holdMs));
    }
  } finally {
    out.write("\x1b[2J\x1b[H\x1b[?25h");
  }
}
