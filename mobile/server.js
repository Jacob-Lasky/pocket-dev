const express  = require('express');
const http     = require('http');
const path     = require('path');
const pty      = require('node-pty');
const { exec } = require('child_process');
const { WebSocketServer } = require('ws');

const app     = express();
const SESSION = process.env.TMUX_SESSION || 'main';
const CMD     = process.env.SHELL_CMD    || 'claude --dangerously-skip-permissions --model claude-opus-4-6';

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/xterm',     express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));

// ── Server-side output ring buffer ────────────────────────────────────────────
// Keeps recent PTY output so new clients can replay it instead of needing
// the resize-pulse hack (which caused artifacts on other connected clients).
const MAX_REPLAY_BYTES = 512 * 1024; // 512 KB
let replayBuffer = '';

function appendToReplay(data) {
  replayBuffer += data;
  if (replayBuffer.length > MAX_REPLAY_BYTES * 1.5) {
    // Trim to MAX_REPLAY_BYTES, cutting at a line boundary when possible
    const start = replayBuffer.length - MAX_REPLAY_BYTES;
    const nlPos = replayBuffer.indexOf('\n', start);
    replayBuffer = replayBuffer.slice(nlPos >= 0 ? nlPos + 1 : start);
  }
}

// ── PTY (tmux → claude) ───────────────────────────────────────────────────────
// Wrap CMD in a restart loop so Claude relaunches automatically on exit
const LOOP_CMD = `bash -c 'while true; do ${CMD}; echo ; echo restarting...; sleep 1; done'`;

// Start with reasonable defaults — first client will resize to match
const ptyProc = pty.spawn('tmux', ['-u', 'new-session', '-A', '-s', SESSION, LOOP_CMD], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd:  process.env.HOME || '/workspace',
  env:  { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
});

// Track current PTY dimensions to avoid redundant resizes
let currentCols = 120;
let currentRows = 40;

// ── Toolbar REST endpoints (write directly to PTY) ────────────────────────────
app.post('/send', (req, res) => {
  const { text } = req.body;
  if (typeof text !== 'string' || !text.length)
    return res.status(400).json({ error: 'text required' });
  ptyProc.write(text);
  ptyProc.write('\r');
  res.json({ ok: true });
});

app.post('/key', (req, res) => {
  const { key } = req.body;

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

app.get('/history', (req, res) => {
  exec(`tmux capture-pane -t ${SESSION} -S - -p -J`, { shell: true, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return res.status(500).send(stderr || err.message);
    res.type('text/plain').send(stdout);
  });
});

// ── WebSocket terminal I/O ────────────────────────────────────────────────────
const server  = http.createServer(app);
const wss     = new WebSocketServer({ noServer: true });
const clients = new Set();

ptyProc.onData(data => {
  appendToReplay(data);
  for (const ws of clients)
    if (ws.readyState === 1) ws.send(data);
});

wss.on('connection', ws => {
  clients.add(ws);

  // Replay buffered output so the new client sees recent history
  // instead of a blank screen. No resize pulse needed.
  if (replayBuffer.length > 0) {
    ws.send(replayBuffer);
  }

  ws.on('message', data => {
    const msg = data.toString();
    if (msg.startsWith('{')) {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          const newCols = Math.max(1, parsed.cols);
          const newRows = Math.max(1, parsed.rows);
          // Only resize if dimensions actually changed
          if (newCols !== currentCols || newRows !== currentRows) {
            currentCols = newCols;
            currentRows = newRows;
            ptyProc.resize(newCols, newRows);
          }
        }
      } catch {}
    } else {
      ptyProc.write(msg);
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
