import { describe, it, expect, vi } from 'vitest';
import { maybeInterceptCopyKey } from '../../public/js/keys.js';

function ev(overrides) {
  return { type: 'keydown', ctrlKey: false, shiftKey: false, key: '', ...overrides };
}

describe('maybeInterceptCopyKey', () => {
  describe('Ctrl+Shift+C', () => {
    it('intercepts and copies when selection exists', () => {
      const copy = vi.fn();
      const r = maybeInterceptCopyKey(
        ev({ ctrlKey: true, shiftKey: true, key: 'c' }),
        { hasSelection: () => true, copy },
      );
      expect(r).toBe(false);
      expect(copy).toHaveBeenCalledOnce();
    });

    it('intercepts but does not copy when no selection — never SIGINT', () => {
      const copy = vi.fn();
      const r = maybeInterceptCopyKey(
        ev({ ctrlKey: true, shiftKey: true, key: 'c' }),
        { hasSelection: () => false, copy },
      );
      expect(r).toBe(false);
      expect(copy).not.toHaveBeenCalled();
    });

    it('handles uppercase C (from Shift modifier)', () => {
      const copy = vi.fn();
      const r = maybeInterceptCopyKey(
        ev({ ctrlKey: true, shiftKey: true, key: 'C' }),
        { hasSelection: () => true, copy },
      );
      expect(r).toBe(false);
      expect(copy).toHaveBeenCalledOnce();
    });
  });

  describe('Ctrl+C (no Shift) — selection-aware', () => {
    it('copies and intercepts when selection exists', () => {
      const copy = vi.fn();
      const r = maybeInterceptCopyKey(
        ev({ ctrlKey: true, key: 'c' }),
        { hasSelection: () => true, copy },
      );
      expect(r).toBe(false);
      expect(copy).toHaveBeenCalledOnce();
    });

    it('falls through to xterm (SIGINT) when no selection', () => {
      const copy = vi.fn();
      const r = maybeInterceptCopyKey(
        ev({ ctrlKey: true, key: 'c' }),
        { hasSelection: () => false, copy },
      );
      expect(r).toBe(true);
      expect(copy).not.toHaveBeenCalled();
    });
  });

  describe('non-matching keys', () => {
    it('lets Ctrl+A pass through', () => {
      const copy = vi.fn();
      const r = maybeInterceptCopyKey(
        ev({ ctrlKey: true, key: 'a' }),
        { hasSelection: () => true, copy },
      );
      expect(r).toBe(true);
      expect(copy).not.toHaveBeenCalled();
    });

    it('lets plain c (no ctrl) pass through', () => {
      const copy = vi.fn();
      const r = maybeInterceptCopyKey(
        ev({ key: 'c' }),
        { hasSelection: () => true, copy },
      );
      expect(r).toBe(true);
      expect(copy).not.toHaveBeenCalled();
    });

    it('lets keyup events pass through (we only act on keydown)', () => {
      const copy = vi.fn();
      const r = maybeInterceptCopyKey(
        ev({ type: 'keyup', ctrlKey: true, key: 'c' }),
        { hasSelection: () => true, copy },
      );
      expect(r).toBe(true);
      expect(copy).not.toHaveBeenCalled();
    });
  });
});
