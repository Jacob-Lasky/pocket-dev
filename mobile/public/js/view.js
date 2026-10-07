// Copy from xterm's parsed NORMAL buffer, never from serialized ANSI.
// Cursor addressing and tabs become real spaces here. Do not restore the old
// serialize/ansi_up path, which silently discarded cursor-positioned gaps.
export function renderTerminalText(term, { viewportOnly = false } = {}) {
  const buffer = term?.buffer?.normal;
  if (!buffer) return '';
  const start = viewportOnly ? buffer.viewportY : 0;
  const end = viewportOnly ? Math.min(buffer.length, start + term.rows) : buffer.length;
  const lines = [];
  let current = '';
  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y);
    const wraps = y + 1 < end && buffer.getLine(y + 1)?.isWrapped;
    current += line?.translateToString(!wraps) || '';
    if (!wraps) { lines.push(current.replace(/[ \t]+$/, '')); current = ''; }
  }
  return lines.join('\n');
}

// Terminal rows carry layout whitespace that makes pasted prose look jagged.
// Keep spacing within each row, but join nonblank rows with one space.
function flattenCopyText(text) {
  return text.split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean).join(' ');
}

export function selectedTerminalText(term, { columnSelectMode = false } = {}) {
  const text = term?.getSelection() || '';
  // A rectangular selection needs its row breaks to keep columns aligned.
  if (columnSelectMode) return text;
  return flattenCopyText(text);
}

// The Copy button uses the same one-line prose format when nothing is selected.
export function cleanCopyText(text) {
  return flattenCopyText(text);
}
