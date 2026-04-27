import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ViewRenderer } from '../../public/js/view.js';

class FakeAnsiUp {
  ansi_to_html(s) {
    // Strip ANSI escape codes; return plain text wrapped in a span for sanity.
    const stripped = s.replace(/\x1b\[[0-9;]*m/g, '');
    return `<span>${stripped.replace(/</g, '&lt;')}</span>`;
  }
}

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
    renderer = new ViewRenderer({ scrollEl: scroll, contentEl: content, ansiUp: new FakeAnsiUp() });
  });

  it('renders plain text into contentEl', () => {
    renderer.update('hello world');
    expect(content.innerHTML).toContain('hello world');
  });

  it('strips ANSI escape codes via ansiUp', () => {
    renderer.update('\x1b[31mred\x1b[0m');
    expect(content.textContent).toBe('red');
  });

  it('replaces content on each update (not appends)', () => {
    renderer.update('first');
    renderer.update('second');
    expect(content.textContent).not.toContain('first');
    expect(content.textContent).toBe('second');
  });

  it('handles empty input without throwing', () => {
    expect(() => renderer.update('')).not.toThrow();
    expect(content.textContent).toBe('');
  });

  it('escapes HTML so embedded markup does not execute', () => {
    renderer.update('<script>x</script>');
    // FakeAnsiUp escapes; real ansi_up also escapes by default.
    expect(content.innerHTML).not.toContain('<script>');
  });

  it('auto-scrolls to bottom on update when previously at bottom', () => {
    // Make content tall so scrollHeight > clientHeight
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 100 });
    scroll.scrollTop = 900; // at bottom (within sticky threshold)
    renderer.update('x'.repeat(5000));
    expect(scroll.scrollTop).toBe(scroll.scrollHeight - scroll.clientHeight);
  });

  it('does NOT auto-scroll when user has scrolled up', () => {
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 100 });
    scroll.scrollTop = 200; // not at bottom (well above threshold)
    renderer.update('x'.repeat(5000));
    expect(scroll.scrollTop).toBe(200);
  });
});
