// pocket-dev mobile touch-scroll for Live mode.
//
// WHY this exists (measured, not assumed): a full-screen TUI coder (Claude Code,
// vim, htop) runs in its own INNER alt-screen and keeps its OWN scrollback. Our
// tmux.conf strips the OUTER smcup, so xterm.js never enters an alt buffer and
// tmux repaints the coder's frame in place via cursor addressing — the browser
// terminal therefore holds ONLY the current screen (xterm buffer.length == rows,
// baseY 0, zero scrollback). The back-and-forth transcript is NOT in any browser
// buffer; it lives inside the coder, reachable only by telling the coder to
// scroll. The coder scrolls on mouse-wheel events (Claude enables SGR mouse
// tracking, DECSET 1000/1002/1003/1006). On desktop the physical wheel is
// forwarded to the coder and it scrolls; on mobile there is no wheel and xterm
// does not synthesize one from a touch-drag, so scrolling is dead. This module
// turns a one-finger vertical drag into the exact wheel events desktop sends.
//
// A plain shell (no mouse tracking) is the opposite case: its output DOES land
// in xterm's real scrollback, so a drag there must scroll xterm locally, NOT
// emit wheel bytes (the shell would read them as literal `[<64;..M` garbage).
// scanMouseState tracks which case we are in from the output byte stream.

// DECSET/DECRST codes that mean "the app wants mouse events" (any of these on =
// forward the wheel to the app). 1006 = SGR encoding, tracked separately so we
// emit the matching wheel sequence.
const MOUSE_TRACK_CODES = new Set([1000, 1002, 1003]);

// Fold one chunk of terminal output into the running mouse state. `state` is
// { track, sgr, tail }. We scan every `?<code>h|l` toggle in emission order so
// the LAST one in the chunk wins (Claude flips modes several times as its UI
// changes; the final state governs the idle prompt). Pure — returns a new obj.
//
// `tail` carries a DECSET sequence that was split across the chunk boundary
// (e.g. `\x1b[?100` | `0h`) into the next call, so a toggle isn't silently
// lost — xterm.js buffers partial sequences the same way for its own parser.
export function scanMouseState(chunk, state = { track: false, sgr: false, tail: '' }) {
  let { track, sgr } = state;
  const buf = (state.tail || '') + chunk;
  const re = /\x1b\[\?(\d+)(h|l)/g;
  let m, consumed = 0;
  while ((m = re.exec(buf)) !== null) {
    const code = parseInt(m[1], 10);
    const on = m[2] === 'h';
    if (MOUSE_TRACK_CODES.has(code)) track = on;
    else if (code === 1006) sgr = on;
    consumed = re.lastIndex;
  }
  // If the buffer ends with a plausibly-incomplete private-mode sequence that
  // starts AFTER the last full match, hold it for next time. The shape guard
  // (ESC, optional `[`, optional `?`, digits/semicolons — no terminator) and
  // the length cap keep a stray ESC in the data stream from growing the tail.
  let tail = '';
  const esc = buf.lastIndexOf('\x1b');
  if (esc >= consumed) {
    const candidate = buf.slice(esc);
    if (candidate.length <= 16 && /^\x1b(\[\??[\d;]*)?$/.test(candidate)) tail = candidate;
  }
  return { track, sgr, tail };
}

// Build a wheel event for the pty.
//   SGR form (1006 on):  ESC [ < btn ; col ; row M      (btn 64=up, 65=down)
//   Legacy X10 form:     ESC [ M  <btn+32> <col+32> <row+32>
// col/row are 1-based cell coords; the coder ignores exact position for wheel
// but a valid in-bounds cell keeps well-behaved apps happy.
export function wheelSequence(dir, { col = 1, row = 1, sgr = true } = {}) {
  const btn = dir === 'down' ? 65 : 64;
  if (sgr) return `\x1b[<${btn};${col};${row}M`;
  return `\x1b[M${String.fromCharCode(btn + 32)}${String.fromCharCode(col + 32)}${String.fromCharCode(row + 32)}`;
}

// Convert an accumulated drag distance (px) into a whole number of wheel steps,
// returning the leftover px to carry into the next sample so slow drags still
// scroll smoothly. `acc` is the signed running total since the last emit;
// positive = finger moved DOWN the screen. Natural touch scrolling: dragging
// DOWN reveals OLDER content, i.e. wheel UP. Returns { steps, dir, rest }.
export function wheelStepsFromDelta(acc, stepPx) {
  if (!stepPx || stepPx <= 0) return { steps: 0, dir: 'up', rest: acc };
  const steps = Math.trunc(acc / stepPx);
  const rest = acc - steps * stepPx;
  return { steps: Math.abs(steps), dir: steps >= 0 ? 'up' : 'down', rest };
}
