// pocket-dev mode toggle
// Picks default ('live' for fine pointer/desktop, 'view' for coarse/mobile)
// and applies a mode to the DOM. Live pane stays mounted but visibility-hidden
// in view mode so xterm.js retains its sizing and the WebSocket pipe keeps
// streaming into the buffer.

export function detectDefaultMode({ matchMedia = window.matchMedia.bind(window) } = {}) {
  return matchMedia('(pointer: coarse)').matches ? 'view' : 'live';
}

export function applyMode(mode, { body, livePane, viewPane, liveBtn, viewBtn }) {
  body.dataset.mode = mode;
  if (mode === 'live') {
    livePane.style.display = '';
    livePane.style.visibility = '';
    viewPane.style.display = 'none';
    liveBtn.classList.add('active');
    viewBtn.classList.remove('active');
  } else {
    // view mode: keep live pane mounted but hidden
    livePane.style.display = '';
    livePane.style.visibility = 'hidden';
    viewPane.style.display = '';
    liveBtn.classList.remove('active');
    viewBtn.classList.add('active');
  }
}
