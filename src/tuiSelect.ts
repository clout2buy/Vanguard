// Searchable, scrollable single-choice launcher surface.
//
// Large live model catalogs routinely contain dozens of entries, so the picker
// owns a bounded viewport and an incremental filter. It still restores raw mode,
// cursor visibility, and listeners on every exit path.

import { emitKeypressEvents } from "node:readline";

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  violet: "\x1b[38;2;158;118;255m",
  cyan: "\x1b[38;2;112;216;255m",
  green: "\x1b[38;2;88;240;178m",
  slate: "\x1b[38;2;136;142;178m",
  faint: "\x1b[38;2;86;92;130m",
  warmWhite: "\x1b[38;2;238;240;252m",
  activeRow: "\x1b[48;2;24;20;48m",
  panelBg: "\x1b[48;2;6;8;16m",
  headerBg: "\x1b[48;2;14;17;32m",
};

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/gu, "");
}

function padVisible(value: string, width: number): string {
  const visible = stripAnsi(value).length;
  return visible >= width ? value : `${value}${" ".repeat(width - visible)}`;
}

function truncatePlain(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

export interface SelectItem<T> {
  readonly value: T;
  readonly label: string;
  /** Dimmed trailing detail, e.g. "most capable" or "signed in". */
  readonly note?: string;
}

export interface SelectOptions<T> {
  readonly title: string;
  readonly items: readonly SelectItem<T>[];
  /** Index highlighted first; clamped into range. */
  readonly initialIndex?: number;
  readonly hint?: string;
  /** Defaults on for catalogs larger than eight entries. */
  readonly searchable?: boolean;
  /** Erase the selector frame on close so the caller can print a recap line. */
  readonly collapseOnClose?: boolean;
}

export class SelectCancelled extends Error {
  constructor() {
    super("Selection cancelled.");
    this.name = "SelectCancelled";
  }
}

interface Key {
  readonly name?: string;
  readonly ctrl?: boolean;
}

export function filterSelectItems<T>(items: readonly SelectItem<T>[], query: string): readonly SelectItem<T>[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return items;
  return items.filter((item) => {
    const haystack = `${item.label} ${item.note ?? ""}`.toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Resolve the chosen value, or reject with SelectCancelled on Esc / Ctrl+C. */
export async function select<T>(options: SelectOptions<T>): Promise<T> {
  const items = options.items;
  if (items.length === 0) throw new Error("A selector needs at least one item.");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("The Vanguard selector requires an interactive terminal.");
  }
  const searchable = options.searchable ?? items.length > 8;
  let query = "";
  let filtered = [...items];
  let index = clamp(options.initialIndex ?? 0, filtered.length);
  const out = process.stdout;
  const hint = options.hint ?? `${searchable ? "Type to filter · " : ""}↑↓ move · Enter select · Esc cancel`;
  let painted = 0;
  let paintedTop = 1;

  const applyFilter = (): void => {
    filtered = [...filterSelectItems(items, query)];
    index = clamp(index, Math.max(1, filtered.length));
  };

  const paint = (): void => {
    // A bordered panel with an aligned label column and a highlight bar: the
    // selector reads as a designed control, not a bare list in a void. Like
    // DoingCode's provider screen, it is positioned against the full terminal
    // canvas instead of flowing immediately after the launch header.
    const columns = out.columns ?? 80;
    const rows = out.rows ?? 24;
    const labelWidth = Math.max(...items.map((item) => item.label.length));
    const widest = Math.max(
      options.title.length + 6,
      hint.length + 6,
      ...items.map((item) => labelWidth + (item.note === undefined ? 0 : item.note.length + 2) + 6),
    );
    const inner = Math.max(40, Math.min(widest, columns - 4));
    const leftMargin = " ".repeat(Math.max(0, Math.floor((columns - inner - 2) / 2)));
    const lines: string[] = [];

    const count = filtered.length === items.length ? `${items.length}` : `${filtered.length}/${items.length}`;
    const title = truncatePlain(options.title, Math.max(10, inner - count.length - 12));
    // Every panel row is exactly inner+3 visible cells (" │" + inner + "│");
    // the borders must match that width EXACTLY or the frame shears apart.
    const titleFill = "─".repeat(Math.max(1, inner + 3 - 6 - title.length - 1 - 1 - count.length - 2));
    lines.push(
      `${ansi.headerBg}${ansi.faint} ╭─ ${ansi.reset}${ansi.headerBg}${ansi.violet}◆ ${ansi.reset}`
      + `${ansi.headerBg}${ansi.bold}${title}${ansi.reset}${ansi.headerBg} ${ansi.faint}${titleFill}${ansi.reset}`
      + `${ansi.headerBg} ${ansi.slate}${count}${ansi.reset}${ansi.headerBg}${ansi.faint} ╮${ansi.reset}`,
    );

    if (searchable) {
      const filterText = query.length === 0 ? `${ansi.faint}type to filter models…${ansi.reset}` : `${ansi.warmWhite}${truncatePlain(query, inner - 8)}${ansi.reset}`;
      const filterRow = ` ${ansi.violet}⌕${ansi.reset}  ${filterText}`;
      lines.push(`${ansi.panelBg} ${ansi.faint}│${ansi.reset}${ansi.panelBg}${padVisible(filterRow, inner)}${ansi.faint}│${ansi.reset}`);
      lines.push(`${ansi.panelBg} ${ansi.faint}├${"─".repeat(inner)}┤${ansi.reset}`);
    }

    // The launch logo and recaps remain above this panel, so leave enough
    // vertical headroom to avoid forcing the footer below the viewport.
    const reservedRows = searchable ? 17 : 15;
    const viewportSize = Math.max(3, Math.min(filtered.length || 1, rows - reservedRows));
    const start = Math.max(0, Math.min(index - Math.floor(viewportSize / 2), filtered.length - viewportSize));
    const visible = filtered.slice(start, start + viewportSize);
    for (const [offset, item] of visible.entries()) {
      const position = start + offset;
      const active = position === index;
      const label = padVisible(item.label, labelWidth);
      const note = item.note === undefined ? "" : `  ${truncatePlain(item.note, Math.max(4, inner - labelWidth - 6))}`;
      const padding = " ".repeat(Math.max(0, inner - 3 - labelWidth - note.length));
      // The active row is one continuous highlight bar: every character,
      // including the padding, is painted before the reset.
      const row = active
        ? `${ansi.activeRow}${ansi.cyan}${ansi.bold} ❯ ${label}\x1b[22m${ansi.warmWhite}${note}${padding}${ansi.reset}`
        : `${ansi.panelBg}   ${ansi.slate}${label}${ansi.reset}${ansi.panelBg}${ansi.faint}${note}${ansi.reset}${ansi.panelBg}${padding}`;
      lines.push(`${ansi.panelBg} ${ansi.faint}│${ansi.reset}${ansi.panelBg}${row}${ansi.panelBg}${ansi.faint}│${ansi.reset}`);
    }
    if (filtered.length === 0) {
      lines.push(`${ansi.panelBg} ${ansi.faint}│${ansi.reset}${ansi.panelBg}${padVisible(`   ${ansi.faint}No models match “${truncatePlain(query, inner - 24)}”${ansi.reset}`, inner)}${ansi.faint}│${ansi.reset}`);
    }

    const hintText = truncatePlain(hint, inner - 6);
    const hintFill = "─".repeat(Math.max(1, inner + 3 - 4 - hintText.length - 1 - 1));
    lines.push(`${ansi.headerBg}${ansi.faint} ╰─ ${hintText} ${hintFill}╯${ansi.reset}`);

    const maximumTop = Math.max(1, rows - lines.length);
    const centeredTop = Math.floor((rows - lines.length) / 2) + 1;
    const top = Math.max(1, Math.min(Math.max(10, centeredTop), maximumTop));
    let output = "";
    // Clear the previous absolute panel first. Its height can shrink while a
    // model filter is typed, and relative cursor motion is what left old rows
    // stranded in the lower half of large terminals.
    for (let offset = 0; offset < painted; offset += 1) {
      output += `\x1b[${paintedTop + offset};1H\x1b[2K`;
    }
    for (const [offset, line] of lines.entries()) {
      output += `\x1b[${top + offset};1H\x1b[2K${leftMargin}${line}`;
    }
    output += `\x1b[${Math.min(rows, top + lines.length)};1H\x1b[0J`;
    out.write(output);
    painted = lines.length;
    paintedTop = top;
  };

  const step = (delta: number): void => {
    if (filtered.length === 0) return;
    index = (index + delta + filtered.length) % filtered.length;
    paint();
  };

  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  out.write("\x1b[?25l");

  return new Promise<T>((resolve, reject) => {
    const done = (error?: Error, value?: T): void => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw === true);
      process.stdin.pause();
      if (options.collapseOnClose === true && painted > 0) {
        let erase = "";
        for (let offset = 0; offset < painted; offset += 1) {
          erase += `\x1b[${paintedTop + offset};1H\x1b[2K`;
        }
        out.write(`${erase}\x1b[${paintedTop};1H`);
        painted = 0;
      }
      out.write("\x1b[?25h");
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };

    function onKeypress(chunk: string | undefined, key: Key | undefined): void {
      if (key === undefined) return;
      if (key.ctrl === true && key.name === "c") {
        done(new SelectCancelled());
        return;
      }
      if (key.name === "escape") {
        if (query.length > 0) {
          query = "";
          applyFilter();
          paint();
        } else {
          done(new SelectCancelled());
        }
        return;
      }
      if (key.name === "up" || (!searchable && key.name === "k")) step(-1);
      else if (key.name === "down" || (!searchable && key.name === "j")) step(1);
      else if (key.name === "pageup") step(-8);
      else if (key.name === "pagedown") step(8);
      else if (key.name === "home") { index = 0; paint(); }
      else if (key.name === "end") { index = Math.max(0, filtered.length - 1); paint(); }
      else if (searchable && key.name === "backspace") {
        query = query.slice(0, -1);
        applyFilter();
        paint();
      }
      else if (searchable && key.ctrl === true && key.name === "u") {
        query = "";
        applyFilter();
        paint();
      }
      else if (key.name === "return" || key.name === "enter") {
        const chosen = filtered[index];
        if (chosen === undefined) return;
        // Leave the frame on screen and land the cursor below it.
        done(undefined, chosen.value);
      } else if (searchable && key.ctrl !== true && typeof chunk === "string" && /^[\p{L}\p{N}._:/@+\- ]$/u.test(chunk)) {
        query += chunk;
        applyFilter();
        paint();
      }
    }

    process.stdin.on("keypress", onKeypress);
    paint();
  });
}

function clamp(value: number, length: number): number {
  if (!Number.isInteger(value) || value < 0) return 0;
  return Math.min(value, length - 1);
}
