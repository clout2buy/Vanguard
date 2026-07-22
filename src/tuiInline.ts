/**
 * Inline terminal renderer: an append-only transcript in the terminal's own
 * scrollback buffer plus a two-row live footer (status + composer) pinned to
 * the bottom of the output.
 *
 * Why not the alternate screen: `\x1b[?1049h` gives a clean grid but takes
 * away the terminal's scrollback — every message older than one screen is
 * unreachable, which users read as "messages disappear". Printing inline
 * keeps the whole session scrollable, copyable, and survives truncation of
 * any single frame.
 *
 * Invariant: after every operation the footer is the last thing on screen and
 * the cursor sits on the last footer row. Every write therefore follows the
 * same shape — erase the footer rows (relative cursor moves only, so user
 * scrollback is never disturbed), append content, repaint the footer — and is
 * issued as ONE batched write so rapid token streams cannot tear the frame.
 */

export interface InlineOutput {
  write(text: string): unknown;
}

export class InlineRenderer {
  readonly #out: InlineOutput;
  readonly #width: () => number;
  /**
   * Physical rows of the live (erasable) region currently on screen: the open
   * stream's partial row, when one exists, plus the footer rows. Counting
   * physical rows — never logical lines — is the whole ballgame: the old
   * renderer counted footer lines while `writeStream` glued the footer onto a
   * wrapped stream row, so every erase landed one row short and baked status
   * spinners into the transcript.
   */
  #liveRows = 0;
  /** Footer content to repaint; set by setFooter on every animation tick. */
  #footer: readonly string[] = [];
  /** Exact live-region text last painted; identical repaints are skipped. */
  #paintedLive = "";
  /** True while a streamed reply is open (its final row is still growing). */
  #streamOpen = false;
  /** The open stream's partial physical row (bounded below one terminal row). */
  #streamTail = "";
  /** Indent applied to the stream's soft-wrapped continuation rows. */
  #streamIndent = "";
  /** SGR codes active at the stream tail's start, so styling survives re-paints. */
  #streamSgr = "";

  constructor(out: InlineOutput, width: () => number) {
    this.#out = out;
    this.#width = width;
  }

  get streamOpen(): boolean {
    return this.#streamOpen;
  }

  /** Append transcript lines above the live region. Lines may wrap naturally. */
  print(lines: string | readonly string[]): void {
    const list = typeof lines === "string" ? [lines] : lines;
    if (list.length === 0) return;
    // The open stream's partial row stays live: it is re-painted below the
    // printed lines, so interleaved tool cards never chop a reply mid-word.
    this.#frame(`${list.join("\n")}\n`);
  }

  /** Open a streamed text line (an agent reply as it is generated). */
  beginStream(prefix: string): void {
    if (this.#streamOpen) this.endStream();
    this.#streamOpen = true;
    this.#streamTail = prefix;
    this.#streamSgr = "";
    const indentWidth = stripAnsi(prefix).length;
    this.#streamIndent = " ".repeat(indentWidth > 24 ? 2 : indentWidth);
    this.#frame("");
  }

  /**
   * Append the next streamed chunk. Rows are soft-wrapped explicitly and
   * committed to scrollback as they complete; only the final partial row stays
   * in the live region, so physical-row accounting is exact by construction.
   */
  writeStream(chunk: string): void {
    if (chunk.length === 0) return;
    if (!this.#streamOpen) {
      // A chunk with no open stream must never glue onto the footer.
      this.beginStream("");
    }
    const capacity = Math.max(8, Math.max(20, this.#width()) - 1);
    const layout = layoutStreamRows(this.#streamSgr + this.#streamTail + chunk, capacity, this.#streamIndent);
    this.#streamTail = layout.tail;
    this.#streamSgr = layout.tailSgr;
    this.#frame(layout.committed.length === 0 ? "" : `${layout.committed.join("\n")}\n`);
  }

  /** Close the streamed line; the text stays in scrollback forever. */
  endStream(): void {
    if (!this.#streamOpen) return;
    this.#streamOpen = false;
    const tail = this.#streamSgr + this.#streamTail;
    this.#streamTail = "";
    this.#streamSgr = "";
    this.#frame(tail.length === 0 ? "" : `${tail}\x1b[0m\n`);
  }

  /** Store new footer content and repaint it in place (the animation tick).
   * Identical repaints are skipped: an idle composer costs zero terminal I/O. */
  setFooter(lines: readonly string[]): void {
    this.#footer = lines;
    if (this.#liveRows > 0 && this.#paintLivePreview() === this.#paintedLive) return;
    this.#frame("");
  }

  /** Remove the footer from the screen (selectors, prompts, shutdown). */
  clearFooter(): void {
    if (this.#liveRows === 0) return;
    this.#out.write(this.#eraseLive());
  }

  /**
   * The single writer. Every visible mutation is one batched write with the
   * same shape — erase the live region, append committed content, repaint the
   * live region — so no call site can carry its own cursor assumptions.
   */
  #frame(committed: string): void {
    this.#out.write(this.#eraseLive() + committed + this.#paintLive());
  }

  /** Cursor is on the last live row: move to the first, erase to screen end. */
  #eraseLive(): string {
    if (this.#liveRows === 0) return "";
    const rows = this.#liveRows;
    this.#liveRows = 0;
    this.#paintedLive = "";
    return rows === 1 ? "\r\x1b[J" : `\x1b[${rows - 1}A\r\x1b[J`;
  }

  /**
   * Paint the live region: the open stream's partial row (if any) above the
   * footer rows. Each row is hard-truncated to width - 1: a row that hits the
   * exact terminal edge auto-wraps on ConPTY and the cursor bookkeeping above
   * would silently drift by one row.
   */
  #paintLive(): string {
    const rows = this.#liveRowsPreview();
    if (rows.length === 0) return "";
    this.#liveRows = rows.length;
    this.#paintedLive = rows.join("\n");
    return this.#paintedLive;
  }

  /** What #paintLive would emit, without side effects. */
  #paintLivePreview(): string {
    return this.#liveRowsPreview().join("\n");
  }

  #liveRowsPreview(): readonly string[] {
    const width = Math.max(20, this.#width());
    const rows: string[] = [];
    if (this.#streamOpen) rows.push(hardTruncate(this.#streamSgr + this.#streamTail, width - 1));
    for (const line of this.#footer) rows.push(hardTruncate(line, width - 1));
    return rows;
  }
}

/**
 * Split streamed text into complete physical rows (committed to scrollback)
 * and the final partial row (kept live). Soft-wraps at `capacity` visible
 * cells, ANSI-aware, and re-opens active SGR codes on continuation rows so a
 * bold or colored span survives the row boundary — committed rows are
 * reset-terminated and therefore self-contained in scrollback.
 */
export function layoutStreamRows(
  text: string,
  capacity: number,
  indent: string,
): { committed: string[]; tail: string; tailSgr: string } {
  const committed: string[] = [];
  let sgr: string[] = [];
  let row = "";
  let cells = 0;
  let rowSgr = "";
  let lastSpace: { at: number; cell: number; sgr: string } | undefined;
  const indentCells = Math.min(indent.length, Math.max(0, capacity - 8));
  const pad = " ".repeat(indentCells);
  const commit = (content: string): void => {
    const styled = rowSgr.length > 0 || content.includes("\x1b[");
    committed.push(rowSgr + content + (styled ? "\x1b[0m" : ""));
  };
  const breakAtNewline = (): void => {
    commit(row);
    rowSgr = sgr.join("");
    row = pad;
    cells = indentCells;
    lastSpace = undefined;
  };
  const breakAtOverflow = (): void => {
    if (lastSpace !== undefined && lastSpace.cell > indentCells) {
      // Wrap at the last word boundary; the partial word carries to the next
      // row with the SGR state that was active where it began.
      commit(row.slice(0, lastSpace.at));
      const carryCells = cells - lastSpace.cell - 1;
      rowSgr = lastSpace.sgr;
      row = pad + row.slice(lastSpace.at + 1);
      cells = indentCells + carryCells;
    } else {
      // A single word longer than the row: hard-break it.
      commit(row);
      rowSgr = sgr.join("");
      row = pad;
      cells = indentCells;
    }
    lastSpace = undefined;
  };
  let at = 0;
  while (at < text.length) {
    const escape = text.slice(at).match(/^\x1b\[[0-9;]*m/);
    if (escape !== null) {
      sgr = escape[0] === "\x1b[0m" ? [] : [...sgr, escape[0]];
      row += escape[0];
      at += escape[0].length;
      continue;
    }
    if (text[at] === "\n") {
      breakAtNewline();
      at += 1;
      continue;
    }
    // Step by code point, never by UTF-16 unit: splitting a surrogate pair
    // across a committed row boundary prints mojibake on both rows.
    const codePoint = text.codePointAt(at) ?? 0;
    const glyph = text.slice(at, at + (codePoint > 0xffff ? 2 : 1));
    const width = cellWidth(codePoint);
    if (cells + width > capacity) breakAtOverflow();
    if (glyph === " ") {
      // A space at a fresh wrapped row's start would double the separator.
      if (row === pad && committed.length > 0) {
        at += 1;
        continue;
      }
      lastSpace = { at: row.length, cell: cells, sgr: sgr.join("") };
    }
    row += glyph;
    cells += width;
    at += glyph.length;
  }
  return { committed, tail: row, tailSgr: rowSgr };
}

/**
 * Visible terminal cells for one code point. Emoji and East Asian wide forms
 * occupy two cells on every terminal Vanguard targets; zero-width joiners and
 * variation selectors occupy none. Counting UTF-16 units instead was how CJK
 * output drifted the inline renderer's physical-row accounting.
 */
function cellWidth(codePoint: number): number {
  if (codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f)
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe4f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) return 2;
  return 1;
}

/** Visible cell count of a string, ANSI stripped, wide glyphs counted as two. */
export function visibleCells(value: string): number {
  let cells = 0;
  for (const glyph of stripAnsi(value)) cells += cellWidth(glyph.codePointAt(0) ?? 0);
  return cells;
}

/** ANSI-aware truncation to a visible cell count, reset-terminated. */
export function hardTruncate(value: string, width: number): string {
  if (visibleCells(value) <= width) return value;
  let cells = 0;
  let at = 0;
  let output = "";
  while (at < value.length) {
    const escape = value.slice(at).match(/^\x1b\[[0-9;]*m/);
    if (escape !== null) {
      output += escape[0];
      at += escape[0].length;
      continue;
    }
    const codePoint = value.codePointAt(at) ?? 0;
    const glyph = value.slice(at, at + (codePoint > 0xffff ? 2 : 1));
    const glyphWidth = cellWidth(codePoint);
    if (cells + glyphWidth > width) break;
    output += glyph;
    cells += glyphWidth;
    at += glyph.length;
  }
  return `${output}\x1b[0m`;
}

/** The aurora spectrum: deep-space blues, an ice-to-violet brand axis, mint
 * for passing evidence, and gold reserved for one thing only: proof. */
export const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  inverse: "\x1b[7m",
  cyan: "\x1b[38;2;112;216;255m",
  violet: "\x1b[38;2;158;118;255m",
  green: "\x1b[38;2;88;240;178m",
  red: "\x1b[38;2;255;72;110m",
  amber: "\x1b[38;2;255;196;92m",
  slate: "\x1b[38;2;136;142;178m",
  blue: "\x1b[38;2;126;152;255m",
  pink: "\x1b[38;2;226;132;255m",
  faint: "\x1b[38;2;86;92;130m",
  warmWhite: "\x1b[38;2;238;240;252m",
  ash: "\x1b[38;2;56;62;96m",
  gold: "\x1b[38;2;255;214;110m",
  white: "\x1b[38;2;246;248;255m",
  plumBg: "\x1b[48;2;22;17;44m",
} as const;

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

export function padAnsi(value: string, width: number): string {
  const visible = visibleCells(value);
  if (visible > width) return hardTruncate(value, Math.max(0, width - 1)) + "…";
  return `${value}${" ".repeat(width - visible)}`;
}

export function bounded(value: string, max: number): string {
  if (max <= 1) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

export function wrap(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    let lineCells = 0;
    for (const word of words) {
      const wordCells = visibleCells(word);
      if (line.length > 0 && lineCells + wordCells + 1 > width) {
        lines.push(line);
        line = "";
        lineCells = 0;
      }
      if (line.length === 0) {
        line = bounded(word, width);
        lineCells = visibleCells(line);
      } else {
        line = `${line} ${word}`;
        lineCells += wordCells + 1;
      }
    }
    if (line.length > 0) lines.push(line);
  }
  return lines;
}

/** Left and right segments on one row: left-aligned, right-aligned, one row wide. */
export function justifyAnsi(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleCells(left) - visibleCells(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

export function elapsed(startedAt: number): string {
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatToolDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60_000)}m${Math.round((milliseconds % 60_000) / 1_000)}s`;
}

export function trimTo<T>(items: T[], limit: number): void {
  if (items.length > limit) items.splice(0, items.length - limit);
}

/**
 * One settled tool call as a transcript card. Failures carry their reason
 * inline; a multi-line reason (a stderr tail) is indented beneath the card.
 * Cards are bounded to the terminal width so they never wrap into each other.
 */
export function formatToolCard(options: {
  readonly status: "passed" | "failed";
  readonly title: string;
  readonly detail?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly agentId?: string | undefined;
  readonly width?: number | undefined;
}): string[] {
  const { status, title, detail, durationMs, agentId } = options;
  const width = options.width ?? 100;
  const detailBudget = Math.max(24, width - title.length - 24);
  const glyph = status === "passed" ? `${ansi.green}✓${ansi.reset}` : `${ansi.red}×${ansi.reset}`;
  const who = agentId !== undefined && agentId !== "main" ? `${ansi.pink}${agentId}${ansi.reset} ` : "";
  const duration = durationMs === undefined ? "" : ` ${ansi.faint}${formatToolDuration(durationMs)}${ansi.reset}`;
  const lines: string[] = [];
  if (status === "failed" && detail !== undefined && detail.includes("\n")) {
    const [head, ...tail] = detail.split("\n");
    lines.push(`  ${glyph} ${who}${ansi.slate}${title}${ansi.reset} ${ansi.dim}${bounded(head ?? "", detailBudget)}${ansi.reset}${duration}`);
    for (const line of tail.slice(0, 3)) {
      lines.push(`    ${ansi.red}${bounded(line, Math.max(24, width - 6))}${ansi.reset}`);
    }
    return lines;
  }
  const reason = detail === undefined ? "" : ` ${status === "failed" ? ansi.red : ansi.dim}${bounded(detail, detailBudget)}${ansi.reset}`;
  lines.push(`  ${glyph} ${who}${ansi.slate}${title}${ansi.reset}${reason}${duration}`);
  return lines;
}

/**
 * Minimal markdown for terminal chat: **bold**, `code`, headings, quotes,
 * list bullets, and fenced code blocks (rendered with a gutter, verbatim
 * content, and no raw ``` markers). Everything else passes through verbatim;
 * no HTML, no links, no surprises. splitStreamableMarkdown holds partial
 * fences and headings upstream, so complete blocks arrive here whole.
 */
export function renderMarkdownLite(text: string): string {
  let inFence = false;
  return text.split("\n").map((line) => {
    const fence = line.match(/^(\s*)```(\S*)\s*$/u);
    if (fence !== null) {
      inFence = !inFence;
      const label = fence[2] ?? "";
      return inFence
        ? `${fence[1] ?? ""}${ansi.ash}╭───${ansi.reset}${label.length === 0 ? "" : ` ${ansi.slate}${label}${ansi.reset}`}`
        : `${fence[1] ?? ""}${ansi.ash}╰───${ansi.reset}`;
    }
    if (inFence) return `${ansi.ash}│${ansi.reset} ${line}`;
    return renderInlineMarkdown(line);
  }).join("\n");
}

/** Inline markdown for one prose line; code fences are handled by the caller. */
function renderInlineMarkdown(line: string): string {
  const heading = line.match(/^#{1,4}\s+(.*)$/u);
  if (heading !== null) return `${ansi.bold}${ansi.cyan}${heading[1]}${ansi.reset}`;
  return line
    .replace(/\*\*([^*]+)\*\*/gu, `${ansi.bold}$1${ansi.reset}`)
    .replace(/`([^`]+)`/gu, `${ansi.cyan}$1${ansi.reset}`)
    .replace(/^(\s*)[-*] /u, `$1${ansi.violet}•${ansi.reset} `)
    .replace(/^(\s*)(\d{1,3})\. /u, `$1${ansi.violet}$2.${ansi.reset} `)
    .replace(/^> ?(.*)$/u, `${ansi.ash}▌${ansi.reset} ${ansi.dim}$1${ansi.reset}`);
}

/**
 * Split streamed text into the part that can be formatted and printed now, and
 * a tail to hold until more arrives.
 *
 * Markdown spans cross chunk boundaries, so emitting every chunk the moment it
 * lands prints the markers raw — the reader sees literal `**bold**`. Holding
 * back from the first unclosed marker means a span is only ever printed once it
 * is complete, which keeps the stream live without leaking syntax.
 */
export function splitStreamableMarkdown(buffer: string): { ready: string; held: string } {
  const hold = (at: number): { ready: string; held: string } => ({ ready: buffer.slice(0, at), held: buffer.slice(at) });
  let at = 0;
  while (at < buffer.length) {
    // Walk span by span. Counting markers is not enough: in "**two**" the final
    // "**" closes a span and is safe to print, while in "done *" the trailing
    // star may still be growing into one.
    const lineStart = at === 0 || buffer[at - 1] === "\n";
    if (lineStart) {
      // A fenced code block streams as one unit: emitting it early would run
      // its ``` markers and contents through the inline-code rules.
      if (buffer.startsWith("```", at)) {
        const close = buffer.indexOf("\n```", at + 3);
        if (close === -1) return hold(at);
        const closeLineEnd = buffer.indexOf("\n", close + 4);
        if (closeLineEnd === -1) return hold(at);
        at = closeLineEnd + 1;
        continue;
      }
      // Trailing backticks may still be growing into a fence marker.
      if (/^`{1,2}$/u.test(buffer.slice(at))) return hold(at);
      // A heading styles as a whole line; hold it until its newline arrives.
      // Trailing hashes may still be growing into "#### ".
      if (/^#{1,4}(?: |$)/u.test(buffer.slice(at, at + 5))) {
        const lineEnd = buffer.indexOf("\n", at);
        if (lineEnd === -1) return hold(at);
        at = lineEnd + 1;
        continue;
      }
    }
    if (buffer.startsWith("**", at)) {
      const close = buffer.indexOf("**", at + 2);
      if (close === -1) return hold(at);
      at = close + 2;
      continue;
    }
    if (buffer[at] === "`") {
      const close = buffer.indexOf("`", at + 1);
      if (close === -1) return hold(at);
      at = close + 1;
      continue;
    }
    // A lone trailing star could become the "**" of a bold span.
    if (buffer[at] === "*" && at === buffer.length - 1) return hold(at);
    at += 1;
  }
  return { ready: buffer, held: "" };
}

/** A chat message (user or agent) as wrapped transcript lines. */
export function formatChatMessage(agentId: string, message: string, width: number): string[] {
  const isUser = agentId === "you";
  const label = isUser ? "You" : agentId === "main" ? "Vanguard" : agentId;
  const color = isUser ? ansi.amber : ansi.violet;
  const glyph = isUser ? `${ansi.amber}❯${ansi.reset}` : `${color}◆${ansi.reset}`;
  const prefix = `${glyph} ${color}${ansi.bold}${label}${ansi.reset}  `;
  const indent = " ".repeat(visibleCells(`${glyph} ${label}  `));
  const capacity = Math.max(20, width - indent.length - 2);
  // Style the whole message first, then soft-wrap ANSI-aware: a span that
  // crosses a wrap boundary keeps its styling, code lines keep their
  // indentation, and blank lines keep paragraphs apart instead of collapsing.
  const rows: string[] = [];
  for (const logical of renderMarkdownLite(message.trimEnd()).split("\n")) {
    const layout = layoutStreamRows(logical, capacity, "");
    rows.push(...layout.committed);
    const tail = layout.tailSgr + layout.tail;
    rows.push(tail.includes("\x1b[") ? `${tail}\x1b[0m` : tail);
  }
  return rows.map((line, index) => `${index === 0 ? prefix : indent}${ansi.warmWhite}${line}${ansi.reset}`);
}

/** The streaming counterpart of formatChatMessage's first-line prefix. */
export function streamPrefix(agentId: string): string {
  const label = agentId === "main" ? "Vanguard" : agentId;
  return `${ansi.violet}◆${ansi.reset} ${ansi.violet}${ansi.bold}${label}${ansi.reset}  `;
}

/** A boxed approval request printed into the transcript. */
export function formatApprovalBlock(command: string, width: number): string[] {
  const inner = Math.max(30, Math.min(76, width - 8));
  const rule = "─".repeat(inner);
  const lines = [
    `  ${ansi.amber}╭─ ${ansi.bold}APPROVAL REQUIRED${ansi.reset} ${ansi.amber}${"─".repeat(Math.max(2, inner - 19))}╮${ansi.reset}`,
  ];
  for (const info of wrap("A command is outside this session's allowlist. Nothing runs until you choose.", inner - 2)) {
    lines.push(`  ${ansi.amber}│${ansi.reset} ${ansi.dim}${info}${ansi.reset}`);
  }
  for (const [index, commandLine] of wrap(command, inner - 4).slice(0, 4).entries()) {
    lines.push(`  ${ansi.amber}│${ansi.reset} ${ansi.cyan}${index === 0 ? "$" : " "}${ansi.reset} ${ansi.warmWhite}${commandLine}${ansi.reset}`);
  }
  const options = `${ansi.amber}[1]${ansi.reset} ${ansi.warmWhite}${ansi.bold}RUN ONCE${ansi.reset}   ${ansi.amber}[2]${ansi.reset} ${ansi.warmWhite}${ansi.bold}ALLOW SESSION${ansi.reset}   ${ansi.amber}[3]${ansi.reset} ${ansi.warmWhite}${ansi.bold}DENY${ansi.reset}`;
  lines.push(
    `  ${ansi.amber}│${ansi.reset} ${stripAnsi(options).length > inner - 2
      ? `${ansi.amber}[1]${ansi.reset} ${ansi.warmWhite}${ansi.bold}RUN${ansi.reset}  ${ansi.amber}[2]${ansi.reset} ${ansi.warmWhite}${ansi.bold}ALLOW${ansi.reset}  ${ansi.amber}[3]${ansi.reset} ${ansi.warmWhite}${ansi.bold}DENY${ansi.reset}`
      : options}`,
    `  ${ansi.amber}╰${rule}╯${ansi.reset}`,
  );
  return lines;
}

/** A dim single-line note (compaction, retries, session lifecycle). */
export function formatNote(text: string): string {
  return `  ${ansi.faint}·${ansi.reset} ${ansi.dim}${text}${ansi.reset}`;
}

/** The gold seal printed when independent verification accepts the result. */
export function formatVerifiedSeal(stats: string): string[] {
  return [
    `${ansi.gold}${ansi.bold}◈ VERIFIED ◈${ansi.reset}${stats.length === 0 ? "" : ` ${ansi.dim}${stats}${ansi.reset}`}`,
  ];
}
