import { describe, it, expect, beforeEach } from 'vitest';
import { detectDefaultMode, applyMode } from '../../public/js/mode.js';

describe('detectDefaultMode', () => {
  it('always defaults to "live" — Live is the one primary surface now', () => {
    expect(detectDefaultMode()).toBe('live');
  });
});

describe('applyMode', () => {
  let body, livePane, viewPane, selectBtn;
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="live-pane"></div>
      <div id="view-pane"></div>
      <button id="mode-select"></button>
    `;
    body = document.body;
    livePane = document.getElementById('live-pane');
    viewPane = document.getElementById('view-pane');
    selectBtn = document.getElementById('mode-select');
  });

  it('sets data-mode "live" and hides the select overlay', () => {
    applyMode('live', { body, livePane, viewPane, selectBtn });
    expect(body.dataset.mode).toBe('live');
    expect(viewPane.style.display).toBe('none');
    expect(livePane.style.display).not.toBe('none');
    expect(livePane.style.visibility).not.toBe('hidden');
    expect(selectBtn.classList.contains('active')).toBe(false);
  });

  it('sets data-mode "select" and hides the live pane via visibility', () => {
    applyMode('select', { body, livePane, viewPane, selectBtn });
    expect(body.dataset.mode).toBe('select');
    // Live stays mounted but offscreen so xterm.js stays sized — visibility, not display.
    expect(livePane.style.visibility).toBe('hidden');
    expect(viewPane.style.display).not.toBe('none');
    expect(selectBtn.classList.contains('active')).toBe(true);
  });

  it('does not throw when selectBtn is absent', () => {
    expect(() => applyMode('select', { body, livePane, viewPane, selectBtn: null })).not.toThrow();
    expect(body.dataset.mode).toBe('select');
  });
});
