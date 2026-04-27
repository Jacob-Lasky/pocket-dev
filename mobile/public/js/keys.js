// Keyboard shortcut handler for xterm.js.
//
// Mounted via term.attachCustomKeyEventHandler(callback) so it runs BEFORE
// xterm.js's own key handling. Returning false prevents xterm.js from
// processing the event (so we can suppress SIGINT, etc.). Returning true
// lets xterm.js handle normally.
//
// Bindings (matches Windows Terminal default behavior):
//   Ctrl+C        → copy selection if one exists, otherwise fall through
//                   to xterm.js (sends \x03 / SIGINT). This is the standard
//                   selection-aware copy that real terminals use.
//   Ctrl+Shift+C  → always intercept; copy if selection, else no-op.
//                   Never sends SIGINT.
//
// All other keys pass through unchanged.

export function maybeInterceptCopyKey(e, { hasSelection, copy }) {
  if (e.type !== 'keydown') return true;
  const isC = e.key && e.key.toLowerCase() === 'c';
  if (!isC || !e.ctrlKey) return true;

  // Ctrl+Shift+C — always intercept; copy iff selection.
  if (e.shiftKey) {
    if (hasSelection()) copy();
    return false;
  }

  // Ctrl+C — intercept only when there's a selection (selection-aware copy);
  // otherwise let xterm.js send SIGINT.
  if (hasSelection()) {
    copy();
    return false;
  }
  return true;
}
