const express = require('express');
const { execFile } = require('child_process');
const { createProxyMiddleware } = require('http-proxy-middleware');
const http = require('http');
const path = require('path');

const app = express();
const SESSION = process.env.TMUX_SESSION || 'claude';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/send', (req, res) => {
  const { text } = req.body;
  if (typeof text !== 'string' || !text.length) {
    return res.status(400).json({ error: 'text required' });
  }
  // -l sends text literally so tmux doesn't interpret characters as key names.
  // Two calls: text first, then Enter, so they're sequenced correctly.
  execFile('tmux', ['send-keys', '-t', SESSION, '-l', text], (errText) => {
    if (errText) {
      console.error('tmux send-keys (text) error:', errText.message);
      return res.status(500).json({ error: errText.message });
    }
    execFile('tmux', ['send-keys', '-t', SESSION, 'Enter'], (err) => {
      if (err) {
        console.error('tmux send-keys (Enter) error:', err.message);
        return res.status(500).json({ error: err.message });
      }
      res.json({ ok: true });
    });
  });
});

app.post('/key', (req, res) => {
  const { key } = req.body;

  // Support any ctrl-<letter> combo dynamically (e.g. ctrl-c, ctrl-b, ctrl-l)
  let keys;
  const ctrlMatch = key.match(/^ctrl-([a-z])$/);
  if (ctrlMatch) {
    keys = [`C-${ctrlMatch[1]}`];
  } else {
    keys = {
      'escape': ['Escape'],
      'tab':    ['Tab'],
      'left':   ['Left'],
      'right':  ['Right'],
      'up':     ['Up'],
      'down':   ['Down'],
    }[key];
  }

  if (!keys) return res.status(400).json({ error: 'unknown key' });
  execFile('tmux', ['send-keys', '-t', SESSION, ...keys], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// Proxy /ttyd (HTTP + WebSocket) to the internal ttyd process
const ttydProxy = createProxyMiddleware({
  target: 'http://localhost:7682',
  changeOrigin: true,
  ws: true,
});

app.use('/ttyd', ttydProxy);

const server = http.createServer(app);
server.on('upgrade', ttydProxy.upgrade);

server.listen(7681, '0.0.0.0', () => {
  console.log(`Mobile bridge on :7681 (tmux session: ${SESSION})`);
});
