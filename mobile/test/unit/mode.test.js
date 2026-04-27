import { describe, it, expect, beforeEach, vi } from 'vitest';
import { detectDefaultMode, applyMode } from '../../public/js/mode.js';

describe('detectDefaultMode', () => {
  it('returns "view" when pointer is coarse (mobile/touch)', () => {
    const matchMedia = vi.fn(q => ({ matches: q === '(pointer: coarse)' }));
    expect(detectDefaultMode({ matchMedia })).toBe('view');
  });

  it('returns "live" when pointer is fine (desktop)', () => {
    const matchMedia = vi.fn(() => ({ matches: false }));
    expect(detectDefaultMode({ matchMedia })).toBe('live');
  });
});

describe('applyMode', () => {
  let body, livePane, viewPane, liveBtn, viewBtn;
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="live-pane"></div>
      <div id="view-pane"></div>
      <button id="mode-live"></button>
      <button id="mode-view"></button>
    `;
    body = document.body;
    livePane = document.getElementById('live-pane');
    viewPane = document.getElementById('view-pane');
    liveBtn = document.getElementById('mode-live');
    viewBtn = document.getElementById('mode-view');
  });

  it('sets data-mode on body to "live" and hides view pane', () => {
    applyMode('live', { body, livePane, viewPane, liveBtn, viewBtn });
    expect(body.dataset.mode).toBe('live');
    expect(viewPane.style.display).toBe('none');
    expect(livePane.style.display).not.toBe('none');
  });

  it('sets data-mode on body to "view" and hides live pane via visibility', () => {
    applyMode('view', { body, livePane, viewPane, liveBtn, viewBtn });
    expect(body.dataset.mode).toBe('view');
    // Live stays visible/mounted but offscreen so xterm.js stays sized; we use `visibility: hidden` not `display: none`.
    expect(livePane.style.visibility).toBe('hidden');
    expect(viewPane.style.display).not.toBe('none');
  });

  it('toggles active class on the matching button', () => {
    applyMode('live', { body, livePane, viewPane, liveBtn, viewBtn });
    expect(liveBtn.classList.contains('active')).toBe(true);
    expect(viewBtn.classList.contains('active')).toBe(false);

    applyMode('view', { body, livePane, viewPane, liveBtn, viewBtn });
    expect(liveBtn.classList.contains('active')).toBe(false);
    expect(viewBtn.classList.contains('active')).toBe(true);
  });
});
