import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Terminal } from '@xterm/xterm';
import {
  ViewRenderer,
  buildPalette,
  renderTerminalHtml,
  renderTerminalText,
  cleanCopyText,
} from '../../public/js/view.js';

// ── ViewRenderer: now just sticky-bottom scroll + innerHTML swap ────────────
function makeContainer() {
  const scroll = document.createElement('div');
  scroll.style.cssText = 'height:100px;overflow-y:auto';
  const content = document.createElement('div');
  scroll.appendChild(content);
  document.body.appendChild(scroll);
  return { scroll, content };
}

describe('ViewRenderer', () => {
  let scroll, content, renderer;
  beforeEach(() => {
    document.body.innerHTML = '';
    ({ scroll, content } = makeContainer());
    renderer = new ViewRenderer({ scrollEl: scroll, contentEl: content });
  });

  it('inserts ready HTML into contentEl', () => {
    renderer.update('<span>hello world</span>');
    expect(content.innerHTML).toBe('<span>hello world</span>');
    expect(content.textContent).toBe('hello world');
  });

  it('replaces content on each update (not appends)', () => {
    renderer.update('first');
    renderer.update('second');
    expect(content.textContent).toBe('second');
  });

  it('handles empty input without throwing', () => {
    expect(() => renderer.update('')).not.toThrow();
    expect(content.textContent).toBe('');
  });

  it('auto-scrolls to bottom when previously at bottom', () => {
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 100 });
    scroll.scrollTop = 900;
    renderer.update('x'.repeat(5000));
    expect(scroll.scrollTop).toBe(scroll.scrollHeight - scroll.clientHeight);
  });

  it('does NOT auto-scroll when the user has scrolled up', () => {
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 100 });
    scroll.scrollTop = 200;
    renderer.update('x'.repeat(5000));
    expect(scroll.scrollTop).toBe(200);
  });
});

// ── buildPalette ─────────────────────────────────────────────────────────────
describe('buildPalette', () => {
  const theme = {
    black: '#000', red: '#f00', green: '#0f0', yellow: '#ff0',
    blue: '#00f', magenta: '#f0f', cyan: '#0ff', white: '#fff',
    brightBlack: '#111', brightRed: '#f11', brightGreen: '#1f1', brightYellow: '#ff1',
    brightBlue: '#11f', brightMagenta: '#f1f', brightCyan: '#1ff', brightWhite: '#eee',
  };

  it('uses the theme for indices 0-15 and the xterm cube above', () => {
    const p = buildPalette(theme);
    expect(p).toHaveLength(256);
    expect(p[0]).toBe('#000');
    expect(p[15]).toBe('#eee');
    expect(p[16]).toBe('#000000');   // cube origin
    expect(p[231]).toBe('#ffffff');  // cube max
    expect(p[232]).toBe('#080808');  // first grey
    expect(p[255]).toBe('#eeeeee');  // last grey
  });
});

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

const palette = buildPalette({
  black: '#000000', red: '#ff0000', green: '#00ff00', yellow: '#ffff00',
  blue: '#0000ff', magenta: '#ff00ff', cyan: '#00ffff', white: '#ffffff',
  brightBlack: '#555555', brightRed: '#ff5555', brightGreen: '#55ff55', brightYellow: '#ffff55',
  brightBlue: '#5555ff', brightMagenta: '#ff55ff', brightCyan: '#55ffff', brightWhite: '#ffffff',
});

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
    // renderTerminalText discards colour, so it calls logicalLines with no
    // palette. A palette-indexed colour (\x1b[31m) must not blow up the cell
    // colour lookup. Regression guard for the undefined-palette crash.
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
});

describe('renderTerminalHtml (buffer walk → coloured HTML)', () => {
  it('preserves spaces as literal text', async () => {
    const term = await makeTerm(40);
    await write(term, 'a   b\r\n');
    const html = renderTerminalHtml(term, { palette });
    expect(html).toContain('a   b');
  });

  it('escapes HTML metacharacters', async () => {
    const term = await makeTerm(40);
    await write(term, '<script>&\r\n');
    const html = renderTerminalHtml(term, { palette });
    expect(html).toContain('&lt;script&gt;&amp;');
    expect(html).not.toContain('<script>');
  });

  it('emits a coloured span for SGR foreground colour', async () => {
    const term = await makeTerm(40);
    await write(term, '\x1b[31mred\x1b[0m plain\r\n');
    const html = renderTerminalHtml(term, { palette });
    expect(html).toMatch(/<span style="[^"]*color:[^"]*">red<\/span>/);
    expect(html).toContain('plain');
  });

  it('renders bold as font-weight', async () => {
    const term = await makeTerm(40);
    await write(term, '\x1b[1mBOLD\x1b[0m\r\n');
    const html = renderTerminalHtml(term, { palette });
    expect(html).toMatch(/font-weight:bold[^>]*>BOLD/);
  });

  it('wraps each logical line in a .vrow block', async () => {
    const term = await makeTerm(40);
    await write(term, 'line one\r\nline two\r\n');
    const html = renderTerminalHtml(term, { palette });
    expect(html).toContain('<div class="vrow">line one</div>');
    expect(html).toContain('<div class="vrow">line two</div>');
    // blank trailing rows get a <br> so they occupy a line
    expect(html).toContain('<div class="vrow"><br></div>');
    // no stray newlines between blocks (would render as extra blank lines)
    expect(html).not.toContain('</div>\n');
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

  it('preserves the banner colour in HTML output', async () => {
    const term = await makeTerm(110);
    await write(term, frameBytes);
    const html = renderTerminalHtml(term, { palette });
    // The amber rule/header is truecolor #ffc107 -> rgb(255,193,7).
    expect(html).toMatch(/color:#ffc107/i);
    expect(html).toContain('Quick safety check: Is this');
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
