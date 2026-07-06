import { describe, it, expect } from 'vitest';
import { scanMouseState, wheelSequence, wheelStepsFromDelta } from '../../public/js/scroll.js';

describe('scanMouseState', () => {
  it('defaults to no tracking, no sgr', () => {
    expect(scanMouseState('')).toEqual({ track: false, sgr: false, tail: '' });
    expect(scanMouseState('plain text with no escapes')).toEqual({ track: false, sgr: false, tail: '' });
  });

  it('turns tracking on for 1000/1002/1003 enable', () => {
    expect(scanMouseState('\x1b[?1000h').track).toBe(true);
    expect(scanMouseState('\x1b[?1002h').track).toBe(true);
    expect(scanMouseState('\x1b[?1003h').track).toBe(true);
  });

  it('turns tracking off on disable', () => {
    const on = scanMouseState('\x1b[?1000h');
    expect(scanMouseState('\x1b[?1000l', on).track).toBe(false);
  });

  it('tracks SGR (1006) encoding separately from tracking', () => {
    const s = scanMouseState('\x1b[?1006h');
    expect(s.sgr).toBe(true);
    expect(s.track).toBe(false); // 1006 alone is encoding, not a track request
  });

  it('last toggle in a chunk wins (mirrors Claude flipping modes)', () => {
    // enable, disable, re-enable within one chunk → ends enabled (matches the
    // real capture whose final idle state was ?1000h ?1002h ?1003h ?1006h)
    const chunk = '\x1b[?1000h\x1b[?1006h\x1b[?1006l\x1b[?1000l\x1b[?1006h\x1b[?1000h';
    expect(scanMouseState(chunk)).toMatchObject({ track: true, sgr: true });
  });

  it('carries prior state across chunks', () => {
    let s = scanMouseState('\x1b[?1000h\x1b[?1006h');
    expect(s).toMatchObject({ track: true, sgr: true });
    s = scanMouseState('no escapes here', s);
    expect(s).toMatchObject({ track: true, sgr: true, tail: '' });
  });

  it('reassembles a DECSET toggle split across a chunk boundary', () => {
    // `\x1b[?1000h` arrives as `\x1b[?100` + `0h`. Without tail-carry both
    // halves miss the regex and tracking never turns on.
    let s = scanMouseState('output\x1b[?100');
    expect(s.track).toBe(false);
    expect(s.tail).toBe('\x1b[?100');
    s = scanMouseState('0h more output', s);
    expect(s.track).toBe(true);
    expect(s.tail).toBe('');
  });

  it('does not carry a completed sequence as tail', () => {
    expect(scanMouseState('\x1b[?1000h').tail).toBe('');
  });

  it('does not grow the tail on an unrelated trailing ESC run', () => {
    // A trailing colour SGR that is not a private-mode set: carried briefly,
    // then dropped once terminated, and never turns tracking on.
    let s = scanMouseState('text\x1b[31');
    expect(s.tail).toBe('\x1b[31');
    s = scanMouseState('mred', s);
    expect(s).toMatchObject({ track: false, sgr: false, tail: '' });
  });
});

describe('wheelSequence', () => {
  it('emits SGR up/down that a mouse-tracking app understands', () => {
    // Verified live: `\x1b[<64;..M` scrolled Claude's transcript.
    expect(wheelSequence('up',   { col: 60, row: 20, sgr: true })).toBe('\x1b[<64;60;20M');
    expect(wheelSequence('down', { col: 60, row: 20, sgr: true })).toBe('\x1b[<65;60;20M');
  });

  it('defaults to SGR and cell 1;1', () => {
    expect(wheelSequence('up')).toBe('\x1b[<64;1;1M');
  });

  it('emits legacy X10 form when sgr is off', () => {
    // ESC [ M then btn+32, col+32, row+32 as bytes.
    expect(wheelSequence('up', { col: 1, row: 1, sgr: false }))
      .toBe(`\x1b[M${String.fromCharCode(96)}${String.fromCharCode(33)}${String.fromCharCode(33)}`);
    expect(wheelSequence('down', { col: 1, row: 1, sgr: false }))
      .toBe(`\x1b[M${String.fromCharCode(97)}${String.fromCharCode(33)}${String.fromCharCode(33)}`);
  });
});

describe('wheelStepsFromDelta', () => {
  it('emits no step below the threshold and carries the remainder', () => {
    expect(wheelStepsFromDelta(10, 24)).toEqual({ steps: 0, dir: 'up', rest: 10 });
  });

  it('drag DOWN (positive) is wheel UP (reveal older content)', () => {
    expect(wheelStepsFromDelta(50, 24)).toEqual({ steps: 2, dir: 'up', rest: 2 });
  });

  it('drag UP (negative) is wheel DOWN', () => {
    expect(wheelStepsFromDelta(-50, 24)).toEqual({ steps: 2, dir: 'down', rest: -2 });
  });

  it('is safe with a zero/invalid step size', () => {
    expect(wheelStepsFromDelta(100, 0)).toEqual({ steps: 0, dir: 'up', rest: 100 });
  });
});
