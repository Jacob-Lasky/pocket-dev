// pocket-dev View mode renderer
//
// View mode is the "reading / select / copy" surface. It renders the ACTIVE
// session's MAIN-buffer scrollback (never the alt buffer — that's the live TUI,
// shown in Live mode) as wrapped, selectable HTML.
//
// WHY we walk the buffer directly instead of round-tripping through ANSI:
// `@xterm/addon-serialize`'s `serialize()` reproduces gap/tab/never-written
// cells as cursor-movement CSI codes (e.g. a tab becomes `\x1b[7C` = "cursor
// forward 7"), NOT as literal spaces. The old renderer fed that through
// `ansi_up`, which only understands SGR (color) codes and silently DROPS every
// cursor-movement code — so `a\x1b[7Cb` rendered as `ab` and all the spaces
// vanished (newlines survived because they were real `\r\n`). DO NOT reintroduce
// a serialize()->ansi_up path; it loses spaces. Reading the parsed buffer gives
// real spaces (empty cell -> ' ') and lets us rejoin soft-wrapped rows so the
// reader reflows to the viewport width instead of the host PTY width.

const STICKY_BOTTOM_THRESHOLD_PX = 50;

// Standard xterm 256-colour palette indices 16-255 (6x6x6 cube + 24 greys).
// Indices 0-15 come from the live terminal theme so View matches Live.
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function hex2(n) {
  return n.toString(16).padStart(2, '0');
}

function rgbHex(num) {
  return `#${hex2((num >> 16) & 0xff)}${hex2((num >> 8) & 0xff)}${hex2(num & 0xff)}`;
}

// Build a 256-entry CSS-colour palette. `theme` supplies the 16 base colours
// (matching termTheme() in index.html); 16-255 are the canonical xterm cube.
export function buildPalette(theme = {}) {
  const p = [
    theme.black, theme.red, theme.green, theme.yellow,
    theme.blue, theme.magenta, theme.cyan, theme.white,
    theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow,
    theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite,
  ];
  for (let i = 0; i < 216; i++) {
    const r = CUBE_LEVELS[Math.floor(i / 36) % 6];
    const g = CUBE_LEVELS[Math.floor(i / 6) % 6];
    const b = CUBE_LEVELS[i % 6];
    p.push(`#${hex2(r)}${hex2(g)}${hex2(b)}`);
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    p.push(`#${hex2(v)}${hex2(v)}${hex2(v)}`);
  }
  return p;
}

// `palette` is optional: the plain-text path (renderTerminalText) walks cells
// without one, so palette lookups must no-op rather than dereference undefined.
function fgCss(cell, palette) {
  if (cell.isFgDefault()) return null;
  if (cell.isFgRGB()) return rgbHex(cell.getFgColor());
  if (cell.isFgPalette()) return (palette && palette[cell.getFgColor()]) || null;
  return null;
}

function bgCss(cell, palette) {
  if (cell.isBgDefault()) return null;
  if (cell.isBgRGB()) return rgbHex(cell.getBgColor());
  if (cell.isBgPalette()) return (palette && palette[cell.getBgColor()]) || null;
  return null;
}

// Snapshot a cell's display-relevant attributes into a plain object. We copy
// out immediately because the xterm cell holder is reused across getCell calls.
function snapshotCell(cell, palette) {
  return {
    ch:        cell.getChars() === '' ? ' ' : cell.getChars(),
    fg:        fgCss(cell, palette),
    bg:        bgCss(cell, palette),
    bold:      cell.isBold() !== 0,
    dim:       cell.isDim() !== 0,
    italic:    cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    strike:    cell.isStrikethrough() !== 0,
    overline:  cell.isOverline() !== 0,
    inverse:   cell.isInverse() !== 0,
    invisible: cell.isInvisible() !== 0,
  };
}

// Walk the active session's NORMAL buffer (honours the excludeAltBuffer
// contract) and yield one array of cell snapshots per LOGICAL line — soft-wrap
// continuation rows (line.isWrapped) are merged into the row they continue, so
// the reader reflows naturally instead of inheriting the host PTY width.
function* logicalLines(term, palette) {
  const buf = term && term.buffer && term.buffer.normal;
  if (!buf) return;
  const holder = buf.getNullCell();
  const len = buf.length;
  let cur = [];
  for (let y = 0; y < len; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const cols = line.length;
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x, holder);
      if (!cell) continue;
      if (cell.getWidth() === 0) continue; // trailing half of a wide glyph
      cur.push(snapshotCell(cell, palette));
    }
    const next = y + 1 < len ? buf.getLine(y + 1) : null;
    if (next && next.isWrapped) continue; // continuation -> same logical line
    yield cur;
    cur = [];
  }
  if (cur.length) yield cur;
}

// Drop trailing blank cells from a logical line (matches a terminal's trailing-
// whitespace trim). Coloured trailing blocks (bg / inverse) are kept.
function trimTrailing(cells) {
  let end = cells.length;
  while (end > 0) {
    const c = cells[end - 1];
    if (c.ch === ' ' && !c.bg && !c.inverse) end--;
    else break;
  }
  return end === cells.length ? cells : cells.slice(0, end);
}

const THEME_FALLBACK = { foreground: '#e6edf3', background: '#0d1117' };

function styleString(c, theme) {
  let fg = c.fg;
  let bg = c.bg;
  if (c.inverse) {
    const nf = bg || theme.background;
    const nb = fg || theme.foreground;
    fg = nf;
    bg = nb;
  }
  const parts = [];
  if (fg) parts.push(`color:${fg}`);
  if (bg) parts.push(`background-color:${bg}`);
  if (c.bold) parts.push('font-weight:bold');
  if (c.dim) parts.push('opacity:0.6');
  if (c.italic) parts.push('font-style:italic');
  if (c.underline && c.overline) parts.push('text-decoration:underline overline');
  else if (c.underline) parts.push('text-decoration:underline');
  else if (c.overline) parts.push('text-decoration:overline');
  else if (c.strike) parts.push('text-decoration:line-through');
  if (c.invisible) parts.push('visibility:hidden');
  return parts.join(';');
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, ch => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
}

// Render the active session's scrollback as styled HTML. Consecutive cells with
// identical style collapse into one <span>; unstyled runs emit as bare escaped
// text. Each LOGICAL line is wrapped in its own `<div class="vrow">` block so
// the copy path can test each line's on-screen position (visible-window copy)
// and so blank lines occupy a row. Within a row, white-space:pre-wrap (inherited
// from #view-content) preserves runs of spaces verbatim and reflows long lines.
export function renderTerminalHtml(term, { palette, theme = THEME_FALLBACK } = {}) {
  const rows = [];
  for (const rawCells of logicalLines(term, palette)) {
    const cells = trimTrailing(rawCells);
    let out = '';
    let runStyle = null;
    let runText = '';
    const flush = () => {
      if (runText === '') return;
      const esc = escapeHtml(runText);
      out += runStyle ? `<span style="${runStyle}">${esc}</span>` : esc;
      runText = '';
    };
    for (const c of cells) {
      const style = styleString(c, theme);
      if (style !== runStyle) { flush(); runStyle = style; }
      runText += c.ch;
    }
    flush();
    // Empty rows need a <br> or they collapse to zero height.
    rows.push(out === '' ? '<div class="vrow"><br></div>' : `<div class="vrow">${out}</div>`);
  }
  return rows.join('');
}

// Normalise copied text: strip CRs, trim trailing whitespace per line, collapse
// runs of blank lines to a single blank, and drop leading/trailing blanks. This
// is the "just the text, correct spacing, no junk" cleanup for the Copy button.
export function cleanCopyText(text) {
  const lines = text.replace(/\r/g, '').split('\n').map(l => l.replace(/[ \t]+$/, ''));
  const out = [];
  let blank = false;
  for (const l of lines) {
    if (l === '') {
      if (!blank) out.push('');
      blank = true;
    } else {
      out.push(l);
      blank = false;
    }
  }
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

// Plain-text form of the same scrollback, for clipboard copy. Real spaces, no
// escape codes — unlike the old path which left cursor-move CSI codes in the
// clipboard after stripping only SGR sequences.
export function renderTerminalText(term) {
  const lines = [];
  for (const rawCells of logicalLines(term, undefined)) {
    lines.push(trimTrailing(rawCells).map(c => c.ch).join(''));
  }
  return lines.join('\n');
}

export class ViewRenderer {
  constructor({ scrollEl, contentEl }) {
    this.scrollEl = scrollEl;
    this.contentEl = contentEl;
  }

  isAtBottom() {
    const { scrollTop, scrollHeight, clientHeight } = this.scrollEl;
    return scrollHeight - (scrollTop + clientHeight) <= STICKY_BOTTOM_THRESHOLD_PX;
  }

  scrollToBottom() {
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight - this.scrollEl.clientHeight;
  }

  // `html` is ready-to-insert markup (see renderTerminalHtml). The renderer owns
  // only the sticky-bottom scroll behaviour.
  update(html) {
    const wasAtBottom = this.isAtBottom();
    this.contentEl.innerHTML = html;
    if (wasAtBottom) this.scrollToBottom();
  }
}
