import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Terminal } from '@xterm/xterm';
import { renderTerminalText, screenCopyText, selectedTerminalText } from '../../public/js/view.js';

// ── Buffer walk: the actual bug fixes ───────────────────────────────────────
// These run a REAL xterm under the test DOM so we exercise the parsed buffer,
// not a mock — the bug lived in how the buffer round-tripped to ANSI.
function write(term, data) {
  return new Promise(res => term.write(data, res));
}

async function makeTerm(cols = 20) {
  const term = new Terminal({ cols, rows: 10, scrollback: 1000 });
  const div = document.createElement('div');
  document.body.appendChild(div);
  term.open(div);
  return term;
}


describe('renderTerminalText (buffer walk → plain text)', () => {
  it('preserves internal and leading spaces (the cursor-move bug)', async () => {
    const term = await makeTerm(40);
    await write(term, 'hello   world\r\n');
    await write(term, '    indented\r\n');
    const text = renderTerminalText(term);
    expect(text).toContain('hello   world');
    expect(text).toContain('    indented');
  });

  it('expands tabs into spaces rather than dropping them', async () => {
    const term = await makeTerm(40);
    await write(term, 'a\tb\r\n');
    const text = renderTerminalText(term);
    // a tab advances to the next 8-col stop: 'a' + 7 spaces + 'b'
    expect(text).toMatch(/^a {7}b/);
    expect(text).not.toContain(''); // no escape codes leaked to clipboard
  });

  it('trims trailing whitespace per line', async () => {
    const term = await makeTerm(40);
    await write(term, 'trailing   \r\n');
    const text = renderTerminalText(term);
    expect(text.split('\n')[0]).toBe('trailing');
  });

  it('does not crash on palette-coloured cells (no palette passed)', async () => {
    // Copy ignores colour without losing the text from coloured cells.
    const term = await makeTerm(40);
    await write(term, '\x1b[31mred\x1b[0m word\r\n');
    expect(() => renderTerminalText(term)).not.toThrow();
    expect(renderTerminalText(term).split('\n')[0]).toBe('red word');
  });

  it('rejoins soft-wrapped rows into one logical line', async () => {
    const term = await makeTerm(10);              // narrow → forces a soft wrap
    await write(term, 'abcdefghijklmnop\r\n');     // 16 chars across 10 cols
    const text = renderTerminalText(term);
    expect(text.split('\n')[0]).toBe('abcdefghijklmnop');
  });

  it('preserves wide glyphs and spaces at a soft wrap', async () => {
    const term = await makeTerm(10);
    await write(term, '界界    abcd\r\n');
    expect(renderTerminalText(term).split('\n')[0]).toBe('界界    abcd');
  });

  it('copies only the visible rows when scrolled into shell history', async () => {
    const term = await makeTerm(20);
    for (let n = 0; n < 20; n++) await write(term, `line-${n}\r\n`);
    term.scrollToTop();
    const text = renderTerminalText(term, { viewportOnly: true });
    expect(text).toContain('line-0');
    expect(text).toContain('line-9');
    expect(text).not.toContain('line-10');
    expect(text).not.toContain('line-19');
  });
});

describe('selectedTerminalText', () => {
  it('joins selected rows with one space after a drag starts inside the first row', async () => {
    const term = await makeTerm(40);
    await write(term, '    first line\r\n    second line\r\n      nested line');
    term.select(4, 0, 2 * term.cols + 13);
    expect(term.getSelection()).toBe('first line\n    second line\n      nested line');
    expect(selectedTerminalText(term)).toBe('first line second line nested line');
  });

  it('preserves spacing inside rows while omitting blank rows', async () => {
    const term = await makeTerm(40);
    await write(term, '    a  b\r\n\r\n      c  d');
    term.selectLines(0, 2);
    expect(selectedTerminalText(term)).toBe('a  b c  d');
  });

  it('keeps words continuous across soft-wrapped rows', async () => {
    const term = await makeTerm(10);
    await write(term, 'abcdefghijklmnop');
    term.selectAll();
    expect(selectedTerminalText(term)).toBe('abcdefghijklmnop');
  });

  it('leaves rectangular selection columns aligned', async () => {
    const term = await makeTerm(40);
    await write(term, '    alpha\r\n    bravo');
    term.selectLines(0, 1);
    expect(selectedTerminalText(term, { columnSelectMode: true })).toBe(term.getSelection());
  });
});

// Real-frame regression: a captured Claude TUI "trust this folder?" prompt,
// which positions every word with CHA (\x1b[NG, absolute column) and NO literal
// spaces. This is the exact failure mode the old serialize()+ansi_up path lost
// (it dropped the cursor-move codes, running words together). cat can't produce
// this (see CLAUDE.md "Test gap: cat doesn't exercise alt-screen"), so this
// fixture closes that gap.
describe('real Claude frame (closes the cat/alt-screen test gap)', () => {
  let frameBytes;
  beforeEach(() => {
    // vitest runs with cwd at the package root (mobile/). Pass raw bytes as a
    // Uint8Array so xterm decodes UTF-8 itself (matches the production WS path,
    // which writes binary frames as Uint8Array).
    const b64 = readFileSync('test/e2e/fixtures/claude-trust-frame.b64', 'utf8');
    frameBytes = new Uint8Array(Buffer.from(b64, 'base64'));
  });

  it('reconstructs CHA-positioned words with real spaces', async () => {
    const term = await makeTerm(110);
    await write(term, frameBytes);
    const text = renderTerminalText(term);
    // Old path produced "Quicksafetycheck:Isthis"; the fix restores the spaces.
    expect(text).toContain('Quick safety check: Is this a project you created');
    expect(text).toContain('1. Yes, I trust this folder');
    expect(text).not.toContain('\x1b'); // no escape codes leaked
  });

});

// A TUI coder paints each row with cursor addressing, so xterm never marks its
// own line wraps. Rows here are placed the same way, at 1-based row r col c.
const at = (r, c, text) => `\x1b[${r};${c}H${text}`;
const URL = 'https://keycloak.example.com/auth?client_id=vault&code_challenge=zxQxHOCWUEiHFeHCwlK2Mi68&state=st_hgjN0llrL2z0';

// Paint `text` from (row, col) and wrap it at `width` columns the way Claude
// does: continuation rows indented by `indent`.
function paintWrapped(row, col, text, { width, indent = 2 }) {
  let out = at(row, col, text.slice(0, width - col + 1));
  let rest = text.slice(width - col + 1);
  const span = width - indent;
  while (rest) {
    row++;
    out += at(row, indent + 1, rest.slice(0, span));
    rest = rest.slice(span);
  }
  return out;
}

describe('a token the app split across rows', () => {
  it('rejoins a URL wrapped to the last column (assistant text)', async () => {
    const term = await makeTerm(40);
    await write(term, paintWrapped(1, 1, `● Sign in: ${URL}`, { width: 40 }));
    term.selectAll();
    expect(term.getSelection()).toContain('\n');
    expect(selectedTerminalText(term)).toBe(`● Sign in: ${URL}`);
  });

  it('rejoins a URL wrapped one column short of the edge (prompt echo)', async () => {
    const term = await makeTerm(40);
    await write(term, paintWrapped(1, 3, URL, { width: 39 }));
    term.selectAll();
    expect(selectedTerminalText(term)).toBe(URL);
  });

  it('rejoins a URL when the selection starts and ends inside it', async () => {
    const term = await makeTerm(40);
    await write(term, paintWrapped(1, 1, `● Sign in: ${URL}`, { width: 40 }));
    term.select(11, 0, 2 * term.cols - 11 + 10);
    expect(selectedTerminalText(term)).toBe(URL.slice(0, 29 + 38 + 8));
  });

  it('rejoins a URL that started with one or two characters left on the row', async () => {
    const term = await makeTerm(40);
    for (const left of [1, 2]) {
      const lead = `${'p'.repeat(39 - left)} `;
      await write(term, '\x1b[2J' + paintWrapped(1, 1, `${lead}${URL}`, { width: 40 }));
      term.selectAll();
      expect(selectedTerminalText(term)).toBe(`${lead}${URL}`);
    }
  });

  it('measures wide glyphs in columns at the edge and in the width test', async () => {
    const term = await makeTerm(12);
    // 'abc ' then four wide glyphs fill the row; four more continue it.
    await write(term, at(1, 1, 'abc 界界界界') + at(2, 3, '界界界界'));
    term.selectAll();
    expect(selectedTerminalText(term)).toBe('abc 界界界界界界界界');
    // Ending one column short of the edge still counts as reaching it.
    await write(term, '\x1b[2J' + at(1, 1, 'ab 界界界界') + at(2, 3, '界界界界'));
    expect(term.buffer.active.getLine(0).translateToString(true)).toBe('ab 界界界界');
    term.selectAll();
    expect(selectedTerminalText(term)).toBe('ab 界界界界界界界界');
  });

  it('keeps the space between prose words when a row ends flush at the edge', async () => {
    const term = await makeTerm(40);
    const full = 'the quick brown fox jumps over the lazy';
    await write(term, at(1, 1, `${full}s`) + at(2, 3, 'dog and more words'));
    expect(term.buffer.active.getLine(0).translateToString(true)).toHaveLength(40);
    term.selectAll();
    expect(selectedTerminalText(term)).toBe(`${full}s dog and more words`);
  });

  it('keeps the space between short rows that stop before the edge', async () => {
    const term = await makeTerm(40);
    await write(term, at(1, 3, 'single') + at(2, 3, 'tokens'));
    term.selectAll();
    expect(selectedTerminalText(term)).toBe('single tokens');
  });

  it('does not join across a blank row', async () => {
    const term = await makeTerm(40);
    await write(term, at(1, 1, 'x'.repeat(40)) + at(3, 3, 'yyyy'));
    term.selectAll();
    expect(selectedTerminalText(term)).toBe(`${'x'.repeat(40)} yyyy`);
  });

  it('keeps rectangular selections untouched', async () => {
    const term = await makeTerm(40);
    await write(term, paintWrapped(1, 1, URL, { width: 40 }));
    term.selectAll();
    expect(selectedTerminalText(term, { columnSelectMode: true })).toBe(term.getSelection());
  });
});

describe('screenCopyText (the Copy button with nothing selected)', () => {
  it('joins rows as prose without terminal indentation', async () => {
    const term = await makeTerm(40);
    await write(term, '    first line\r\n    second line\r\n      nested line');
    expect(screenCopyText(term)).toBe('first line second line nested line');
  });

  it('omits blank rows and keeps spacing inside rows', async () => {
    const term = await makeTerm(40);
    await write(term, '\r\n\r\na   b\r\n\r\n\r\n  c\td\r\n\r\n');
    expect(screenCopyText(term)).toBe('a   b c     d');
  });

  it('rejoins a split URL the same way a selection does', async () => {
    const term = await makeTerm(40);
    await write(term, paintWrapped(2, 1, `● Sign in: ${URL}`, { width: 40 }) + at(6, 1, '❯ next prompt'));
    expect(screenCopyText(term)).toBe(`● Sign in: ${URL} ❯ next prompt`);
  });

  it('copies only the visible rows', async () => {
    const term = await makeTerm(20);
    for (let n = 0; n < 20; n++) await write(term, `line-${n}\r\n`);
    term.scrollToTop();
    const text = screenCopyText(term);
    expect(text).toContain('line-0');
    expect(text).not.toContain('line-10');
  });
});
