import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trimTrailingWhitespace, clipboardWrite } from '../../public/js/clipboard.js';

describe('trimTrailingWhitespace', () => {
  it('strips trailing spaces and tabs per line', () => {
    expect(trimTrailingWhitespace('hello   \nworld\t\nfoo')).toBe('hello\nworld\nfoo');
  });

  it('preserves intentional internal whitespace', () => {
    expect(trimTrailingWhitespace('a  b\nc   d')).toBe('a  b\nc   d');
  });

  it('preserves leading whitespace (indentation)', () => {
    expect(trimTrailingWhitespace('    indented   \n  also  ')).toBe('    indented\n  also');
  });

  it('handles empty input', () => {
    expect(trimTrailingWhitespace('')).toBe('');
  });
});

describe('clipboardWrite', () => {
  let originalClipboard;
  beforeEach(() => { originalClipboard = navigator.clipboard; });
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
  });

  function setClipboard(value) {
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
  }

  it('uses navigator.clipboard.writeText when available; resolves true', async () => {
    const writeText = vi.fn().mockResolvedValue();
    setClipboard({ writeText });
    const ok = await clipboardWrite('hello   \nworld');
    expect(writeText).toHaveBeenCalledWith('hello\nworld');
    expect(ok).toBe(true);
  });

  it('falls back to execCopy when navigator.clipboard is undefined', async () => {
    setClipboard(undefined);
    const execCopy = vi.fn(() => true);
    const ok = await clipboardWrite('text  ', { execCopy });
    expect(execCopy).toHaveBeenCalledWith('text');
    expect(ok).toBe(true);
  });

  it('falls back to execCopy when navigator.clipboard.writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
    setClipboard({ writeText });
    const execCopy = vi.fn(() => true);
    const ok = await clipboardWrite('text', { execCopy });
    expect(writeText).toHaveBeenCalled();
    expect(execCopy).toHaveBeenCalledWith('text');
    expect(ok).toBe(true);
  });

  it('returns false when both paths fail', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('nope'));
    setClipboard({ writeText });
    const execCopy = vi.fn(() => false);
    const ok = await clipboardWrite('text', { execCopy });
    expect(ok).toBe(false);
  });
});
