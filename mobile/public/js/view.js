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

// Remove only the margin shared by the selected lines. The first line of a
// drag may start inside a row, while later lines include their full left edge.
// Keep spacing within lines and indentation relative to that shared margin.
function removeSharedMargin(lines, { firstLinePartial = false } = {}) {
  if (lines.length < 2) return lines;
  const start = firstLinePartial ? 1 : 0;
  const content = lines.slice(start).filter(line => /\S/.test(line));
  if (!content.length) return lines;
  const margin = Math.min(...content.map(line => /^[ \t]*/.exec(line)[0].length));
  if (!margin) return lines;
  return lines.map((line, index) => index < start ? line : line.slice(margin));
}

export function selectedTerminalText(term, { columnSelectMode = false } = {}) {
  const text = term?.getSelection() || '';
  // A rectangular selection uses leading spaces to keep its columns aligned.
  if (columnSelectMode) return text;
  const position = term?.getSelectionPosition();
  const firstLinePartial = position?.start.x > 0 && position.start.y < position.end.y;
  return removeSharedMargin(text.split('\n'), { firstLinePartial }).join('\n');
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
  return removeSharedMargin(out).join('\n');
}
