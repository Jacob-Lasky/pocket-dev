const express  = require('express');
const http     = require('http');
const path     = require('path');
const pty      = require('node-pty');
const { exec } = require('child_process');
const { WebSocketServer } = require('ws');

const app     = express();
const SESSION = process.env.TMUX_SESSION || 'main';
const CMD     = process.env.SHELL_CMD    || 'claude --dangerously-skip-permissions';

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/xterm',     express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));

// ── PTY (tmux → claude) ───────────────────────────────────────────────────────
// Wrap CMD in a restart loop so Claude relaunches automatically on exit
const LOOP_CMD = `bash -c 'while true; do ${CMD}; echo ""; echo "restarting..."; sleep 1; done'`;
const ptyProc = pty.spawn('tmux', ['-u', 'new-session', '-A', '-s', SESSION, LOOP_CMD], {
  name: 'xterm-256color',
  cols: 220,
  rows: 50,
  cwd:  process.env.HOME || '/workspace',
  env:  { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
});

// ── Toolbar REST endpoints (write directly to PTY) ────────────────────────────
app.post('/send', (req, res) => {
  const { text } = req.body;
  if (typeof text !== 'string' || !text.length)
    return res.status(400).json({ error: 'text required' });
  // Two separate writes mirrors the old tmux send-keys -l fix:
  // write text first, then carriage return, so they are sequenced correctly.
  ptyProc.write(text);
  ptyProc.write('\r');
  res.json({ ok: true });
});

app.post('/key', (req, res) => {
  const { key } = req.body;

  // Ctrl+letter → control character (e.g. ctrl-c → \x03)
  const ctrlMatch = key.match(/^ctrl-([a-z])$/);
  if (ctrlMatch) {
    ptyProc.write(String.fromCharCode(ctrlMatch[1].charCodeAt(0) - 96));
    return res.json({ ok: true });
  }

  const sequences = {
    escape: '\x1b',
    tab:    '\t',
    enter:  '\r',
    left:   '\x1b[D',
    right:  '\x1b[C',
    up:     '\x1b[A',
    down:   '\x1b[B',
  };

  const seq = sequences[key];
  if (!seq) return res.status(400).json({ error: 'unknown key' });
  ptyProc.write(seq);
  res.json({ ok: true });
});

app.post('/refresh', (req, res) => {
  exec(`tmux list-clients -F '#{client_name}' | xargs -I{} tmux refresh-client -t {}`, { shell: true }, (err) => res.json({ ok: !err }));
});

// ── WebSocket terminal I/O ────────────────────────────────────────────────────
const server  = http.createServer(app);
const wss     = new WebSocketServer({ noServer: true });
const clients = new Set();

ptyProc.onData(data => {
  for (const ws of clients)
    if (ws.readyState === 1) ws.send(data);
});

wss.on('connection', ws => {
  clients.add(ws);

  ws.on('message', data => {
    const msg = data.toString();
    try {
      const { type, cols, rows } = JSON.parse(msg);
      if (type === 'resize' && cols && rows)
        ptyProc.resize(Math.max(1, cols), Math.max(1, rows));
    } catch {
      ptyProc.write(msg);   // raw xterm.js keyboard input
    }
  });

  ws.on('close', () => clients.delete(ws));
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws')
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

server.listen(7681, '0.0.0.0', () =>
  console.log(`pocket-dev on :7681  (tmux: ${SESSION}  cmd: ${CMD})`));
