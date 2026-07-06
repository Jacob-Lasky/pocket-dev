// pocket-dev surface toggle.
//
// Live is the ONE primary terminal surface on every device now (it is
// touch-scrollable on mobile — see scroll.js). The former "View" mode is
// retired as a co-equal mode: there is no browser-side scrollback for a TUI
// coder to read (the buffer holds only the current frame — measured), so a
// separate always-on reading pane could never show the back-and-forth history
// it implied. What survives is an opt-in "Select" overlay: a selectable,
// copyable render of the CURRENT screen, for grabbing text that a
// mouse-tracking TUI otherwise steals from touch selection in Live.
//
// Default is always 'live'. We deliberately no longer switch mobile to the
// overlay on a coarse pointer.

export function detectDefaultMode() {
  return 'live';
}

export function applyMode(mode, { body, livePane, viewPane, selectBtn }) {
  body.dataset.mode = mode;
  if (mode === 'select') {
    // Keep the live pane mounted but offscreen so xterm.js stays sized and the
    // WebSocket keeps streaming into the buffer underneath the overlay.
    livePane.style.display = '';
    livePane.style.visibility = 'hidden';
    viewPane.style.display = '';
    selectBtn && selectBtn.classList.add('active');
  } else {
    livePane.style.display = '';
    livePane.style.visibility = '';
    viewPane.style.display = 'none';
    selectBtn && selectBtn.classList.remove('active');
  }
}
