// Copy from xterm's parsed NORMAL buffer, never from serialized ANSI.
// Cursor addressing and tabs become real spaces here. Do not restore the old
// serialize/ansi_up path, which silently discarded cursor-positioned gaps.

// Walk rows into logical lines, rejoining xterm's own soft wraps. Each line
// keeps its first and last buffer row so copy can inspect the row layout.
function readLines(buffer, start, end) {
  const lines = [];
  let current = null;
  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y);
    const wraps = y + 1 < end && buffer.getLine(y + 1)?.isWrapped;
    current ??= { text: '', first: y };
    current.text += line?.translateToString(!wraps) || '';
    if (!wraps) {
      lines.push({ ...current, text: current.text.replace(/[ \t]+$/, ''), last: y });
      current = null;
    }
  }
  return lines;
}

export function renderTerminalText(term, { viewportOnly = false } = {}) {
  const buffer = term?.buffer?.normal;
  if (!buffer) return '';
  const start = viewportOnly ? buffer.viewportY : 0;
  const end = viewportOnly ? Math.min(buffer.length, start + term.rows) : buffer.length;
  return readLines(buffer, start, end).map(line => line.text).join('\n');
}

// TUI coders (Claude's Ink renderer) wrap a long line themselves: every row is
// cursor-positioned, so xterm never marks the continuation `isWrapped`, and the
// continuation row carries the app's indent. A token longer than its box (a
// URL, a hash, a path) is broken mid-character at the right edge, and may start
// on the previous row with only a character or two left. Measured live at 100
// cols on 2026-10-12: assistant text reaches the last column, the prompt echo
// stops one short, and both indent the continuation by two.
//
// So a hard row break is a split token, joined with NO space, only when the
// upper row reaches the right edge AND the two touching tokens together are
// wider than either row could hold. Word-wrapped prose fails the width test:
// its words are short, and each fit the row it landed on. DO NOT drop the width
// test and join on the edge alone, because prose rows end flush at the edge
// often enough to glue ordinary words together. One case is ambiguous by
// construction and resolves as a join: a single word exactly one row wide,
// followed by another word, looks identical to a split token.
//
// Everything is measured in CELLS, not string length, so a wide glyph counts
// as the two columns it occupies.
const RIGHT_EDGE_SLACK = 2;
function inkSpan(row, cols) {
  // The second half of a wide glyph is a width-0 cell, and belongs to its token.
  const blank = x => {
    const cell = row.getCell(x);
    return !cell || (cell.getWidth() !== 0 && !cell.getChars().trim());
  };
  let first = 0;
  while (first < cols && blank(first)) first++;
  if (first === cols) return null;
  let last = cols - 1;
  while (blank(last)) last--;
  let tail = last;
  while (tail > first && !blank(tail - 1)) tail--;
  let head = first;
  while (head < last && !blank(head + 1)) head++;
  return { first, last, tail: last - tail + 1, head: head - first + 1 };
}

function splitsToken(buffer, cols, upperRow, lowerRow) {
  const upperLine = buffer.getLine(upperRow);
  const lowerLine = buffer.getLine(lowerRow);
  const upper = upperLine && inkSpan(upperLine, cols);
  const lower = lowerLine && inkSpan(lowerLine, cols);
  if (!upper || !lower || upper.last < cols - RIGHT_EDGE_SLACK) return false;
  return upper.tail + lower.head > Math.min(upper.last - upper.first + 1, cols - lower.first);
}

// Terminal rows carry layout whitespace that makes pasted prose look jagged.
// Keep spacing within each row, join rows with one space, and rejoin a token
// the app split across rows with nothing.
function joinCopyLines(term, buffer, lines) {
  let out = '';
  let previous = null;
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) { previous = null; continue; }
    if (out) out += previous && splitsToken(buffer, term.cols, previous.last, line.first) ? '' : ' ';
    out += text;
    previous = line;
  }
  return out;
}

export function selectedTerminalText(term, { columnSelectMode = false } = {}) {
  const text = term?.getSelection() || '';
  // A rectangular selection needs its row breaks to keep columns aligned.
  if (columnSelectMode) return text;
  const buffer = term.buffer.active;
  const range = term.getSelectionPosition();
  // getSelection joins xterm soft wraps the same way readLines does, so its
  // lines map onto buffer rows by skipping wrapped continuations.
  let y = range ? range.start.y : 0;
  const lines = text.split('\n').map(lineText => {
    const first = y;
    while (buffer.getLine(y + 1)?.isWrapped) y++;
    return { text: lineText, first, last: y++ };
  });
  return joinCopyLines(term, buffer, lines);
}

// The Copy button uses the same one-line prose format when nothing is selected.
export function screenCopyText(term) {
  const buffer = term?.buffer?.normal;
  if (!buffer) return '';
  const start = buffer.viewportY;
  return joinCopyLines(term, buffer, readLines(buffer, start, Math.min(buffer.length, start + term.rows)));
}
