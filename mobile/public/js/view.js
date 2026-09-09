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
