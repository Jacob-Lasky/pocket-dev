// Test-only entrypoint: boots ONLY the express static-serving layer (no PTY,
// no WebSocket, no tmux). Used by render.spec.js to verify index.html loads,
// imports resolve, and the toolbar renders without depending on a real Claude
// session. The page's WebSocket connection will fail (there's no ws server)
// and that's expected — we test that the static UI is correct independently.

const { createApp } = require('../../server.js');

const port = parseInt(process.env.PORT, 10) || 0;
const app  = createApp();
const srv  = app.listen(port, '0.0.0.0', () => {
  // Match the format pdServer fixture watches for; differentiating "static"
  // is just for log-greppability.
  console.log(`pocket-dev static on :${srv.address().port}`);
});
