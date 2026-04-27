const express  = require('express');
const http     = require('http');
const path     = require('path');
const pty      = require('node-pty');
const { exec } = require('child_process');
const { WebSocketServer } = require('ws');

const SESSION = process.env.TMUX_SESSION || 'main';
const CMD     = process.env.SHELL_CMD    || 'claude --dangerously-skip-permissions --model "opus[1m]"';
const PORT    = parseInt(process.env.PORT, 10) || 7681;

const LOOP_CMD = `bash -c 'while true; do ${CMD}; echo ; echo restarting...; sleep 1; done'`;
const TMUX_CONF_PATH = path.join(__dirname, 'tmux.conf');

function buildTmuxSpawnArgs(session, loopCmd) {
  return [
    '-u',
    '-f', TMUX_CONF_PATH,
    'new-session', '-A', '-s', session,
    loopCmd,
  ];
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/xterm',           express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
  app.use('/addon-fit',       express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
  return app;
}

module.exports = { buildTmuxSpawnArgs, createApp, TMUX_CONF_PATH };

if (require.main === module) {
  startServer();
}

function startServer() {
  const app = createApp();

  const MAX_REPLAY_BYTES = 512 * 1024;
  let replayBuffer = '';

  function appendToReplay(data) {
    replayBuffer += data;
    if (replayBuffer.length > MAX_REPLAY_BYTES * 1.5) {
      const start = replayBuffer.length - MAX_REPLAY_BYTES;
      const nlPos = replayBuffer.indexOf('\n', start);
      replayBuffer = replayBuffer.slice(nlPos >= 0 ? nlPos + 1 : start);
    }
  }

  const ptyProc = pty.spawn('tmux', buildTmuxSpawnArgs(SESSION, LOOP_CMD), {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd:  process.env.HOME || '/workspace',
    env:  { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });

  let currentCols = 120;
  let currentRows = 40;

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
      escape: '\x1b', tab: '\t', enter: '\r',
      left: '\x1b[D', right: '\x1b[C', up: '\x1b[A', down: '\x1b[B',
    };
    const seq = sequences[key];
    if (!seq) return res.status(400).json({ error: 'unknown key' });
    ptyProc.write(seq);
    res.json({ ok: true });
  });

  app.post('/tmux-kill', (req, res) => {
    const getActive = `tmux display-message -t ${SESSION} -p '#{window_id}' 2>/dev/null`;
    const countWindows = `tmux list-windows -t ${SESSION} 2>/dev/null | wc -l`;
    exec(`${getActive} && ${countWindows}`, { shell: true }, (err, stdout) => {
      const lines = stdout?.trim().split('\n') || [];
      const windowId = lines[0];
      const windowCount = parseInt(lines[1], 10) || 0;
      if (windowCount <= 1) {
        exec(`tmux new-window -t ${SESSION} cdspo; tmux kill-window -t ${windowId} 2>/dev/null || true`, { shell: true }, () => {
          res.json({ ok: true, respawned: true });
        });
      } else {
        exec(`tmux kill-window -t ${windowId} 2>/dev/null`, { shell: true }, () => {
          res.json({ ok: true, respawned: false });
        });
      }
    });
  });

  app.post('/refresh', (req, res) => {
    exec(`tmux list-clients -F '#{client_name}' | xargs -I{} tmux refresh-client -t {}`, { shell: true }, (err) => res.json({ ok: !err }));
  });

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
    if (replayBuffer.length > 0) ws.send(replayBuffer);
    ws.on('message', data => {
      const msg = data.toString();
      if (msg.startsWith('{')) {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            const newCols = Math.max(1, parsed.cols);
            const newRows = Math.max(1, parsed.rows);
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

  server.listen(PORT, '0.0.0.0', () =>
    console.log(`pocket-dev on :${PORT}  (tmux: ${SESSION}  cmd: ${CMD})`));
}
