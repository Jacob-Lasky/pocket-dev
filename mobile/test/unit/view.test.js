import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Terminal } from '@xterm/xterm';
import { renderTerminalText, cleanCopyText } from '../../public/js/view.js';

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

describe('cleanCopyText', () => {
  it('strips CRs and trailing whitespace per line', () => {
    expect(cleanCopyText('a   \r\nb\t\r\n')).toBe('a\nb');
  });

  it('collapses runs of blank lines to a single blank', () => {
    expect(cleanCopyText('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('drops leading and trailing blank lines', () => {
    expect(cleanCopyText('\n\nhello\n\n\n')).toBe('hello');
  });

  it('preserves internal spacing', () => {
    expect(cleanCopyText('a   b   c')).toBe('a   b   c');
  });
});
