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

  it('refuses an empty write rather than clobbering the clipboard', async () => {
    // `writeText('')` RESOLVES, so an empty copy is indistinguishable from a
    // successful one: the clipboard is silently replaced with nothing and the
    // Copy button flashes its success tick. Returning false without writing
    // leaves whatever the user had copied intact and flashes the failure mark.
    const writeText = vi.fn().mockResolvedValue();
    const execCopy = vi.fn().mockReturnValue(true);
    setClipboard({ writeText });
    expect(await clipboardWrite('', { execCopy })).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(execCopy).not.toHaveBeenCalled();
  });

  it('refuses a whitespace-only write, which trims to empty', async () => {
    // A screen of spaces trims to '' here, and there was nothing to copy, so the
    // same rule applies. Guarding on the TRIMMED value, not the argument.
    const writeText = vi.fn().mockResolvedValue();
    const execCopy = vi.fn().mockReturnValue(true);
    setClipboard({ writeText });
    expect(await clipboardWrite('   \n\t\n  ', { execCopy })).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(execCopy).not.toHaveBeenCalled();
  });

  it('does not refuse a write whose only content is a newline-separated blank line', async () => {
    // The guard is "nothing to copy", not "contains a blank line". A real screen
    // with a blank line in the middle must still copy.
    const writeText = vi.fn().mockResolvedValue();
    setClipboard({ writeText });
    expect(await clipboardWrite('a\n\nb')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('a\n\nb');
  });

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
