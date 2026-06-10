const express  = require('express');
const http     = require('http');
const path     = require('path');
const pty      = require('node-pty');
const { exec, execFile } = require('child_process');
const { WebSocketServer } = require('ws');

const SESSION_BASE = process.env.TMUX_SESSION || 'main';
const CMD          = process.env.SHELL_CMD    || 'claude --dangerously-skip-permissions --model "opus[1m]"';
const PORT         = parseInt(process.env.PORT, 10) || 7681;
const MAX_REPLAY_BYTES = 512 * 1024;

const LOOP_CMD       = `bash -c 'while true; do ${CMD}; echo ; echo restarting...; sleep 1; done'`;
const TMUX_CONF_PATH = path.join(__dirname, 'tmux.conf');

// tmux session names + the URL/body params we accept must match this charset.
// Lets us interpolate ids into shell strings without sanitization gymnastics.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function buildTmuxSpawnArgs(session, loopCmd) {
  return [
    '-u',
    '-f', TMUX_CONF_PATH,
    'new-session', '-A', '-s', session,
    loopCmd,
  ];
}

function createApp({ sessionsApi } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/xterm',           express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
  app.use('/addon-fit',       express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));

  if (sessionsApi) {
    // Validate body.session against SAFE_ID and resolve to state — or short-circuit
    // with the right 400/404 if missing/unknown. Attaches `req.session` for the handler.
    function requireSession(req, res, next) {
      const session = req.body && req.body.session;
      if (!session || !SAFE_ID.test(session))
        return res.status(400).json({ error: 'session required' });
      const state = sessionsApi.get(session);
      if (!state) return res.status(404).json({ error: 'session not found' });
      req.session = state;
      next();
    }

    app.get('/sessions', (req, res) => {
      res.json(sessionsApi.list());
    });

    app.post('/sessions', (req, res) => {
      const state = sessionsApi.create();
      res.json({ id: state.id });
    });

    app.delete('/sessions/:id', (req, res) => {
      if (!SAFE_ID.test(req.params.id))
        return res.status(400).json({ error: 'invalid session id' });
      sessionsApi.destroy(req.params.id, (ok) => res.json({ ok }));
    });

    app.post('/send', requireSession, (req, res) => {
      const { text } = req.body;
      if (typeof text !== 'string' || !text.length)
        return res.status(400).json({ error: 'text required' });
      req.session.pty.write(text);
      req.session.pty.write('\r');
      res.json({ ok: true });
    });

    app.post('/key', requireSession, (req, res) => {
      const { key } = req.body;
      const ctrlMatch = key && key.match(/^ctrl-([a-z])$/);
      if (ctrlMatch) {
        req.session.pty.write(String.fromCharCode(ctrlMatch[1].charCodeAt(0) - 96));
        return res.json({ ok: true });
      }
      const sequences = {
        escape: '\x1b', tab: '\t', enter: '\r',
        left: '\x1b[D', right: '\x1b[C', up: '\x1b[A', down: '\x1b[B',
      };
      const seq = sequences[key];
      if (!seq) return res.status(400).json({ error: 'unknown key' });
      req.session.pty.write(seq);
      res.json({ ok: true });
    });

    app.post('/refresh', requireSession, (req, res) => {
      // tmux refresh-client targets clients, not sessions. List clients of
      // this session, then refresh each. SAFE_ID guard in requireSession
      // guarantees no shell metacharacters in `req.session.id`.
      exec(
        `tmux list-clients -t '${req.session.id}' -F '#{client_name}' | xargs -r -I{} tmux refresh-client -t {}`,
        { shell: '/bin/bash' },
        (err) => res.json({ ok: !err }),
      );
    });
  }

  return app;
}

function createSessionsApi() {
  const sessions = new Map();
  let nextSeq = 1;

  function nextSessionId() {
    return `${SESSION_BASE}-${nextSeq++}`;
  }

  function appendToReplay(state, data) {
    state.replayBuffer += data;
    if (state.replayBuffer.length > MAX_REPLAY_BYTES * 1.5) {
      const start = state.replayBuffer.length - MAX_REPLAY_BYTES;
      const nlPos = state.replayBuffer.indexOf('\n', start);
      state.replayBuffer = state.replayBuffer.slice(nlPos >= 0 ? nlPos + 1 : start);
    }
  }

  function create(id = nextSessionId()) {
    if (sessions.has(id)) return sessions.get(id);
    const ptyProc = pty.spawn('tmux', buildTmuxSpawnArgs(id, LOOP_CMD), {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd:  process.env.HOME || '/workspace',
      env:  { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });

    const state = {
      id,
      pty: ptyProc,
      replayBuffer: '',
      clients: new Set(),
      cols: 120,
      rows: 40,
    };

    ptyProc.onData(data => {
      appendToReplay(state, data);
      for (const ws of state.clients) {
        if (ws.readyState === 1) ws.send(data);
      }
    });

    ptyProc.onExit(() => {
      // PTY died (e.g. tmux session killed externally). Drop state and close clients.
      sessions.delete(id);
      for (const ws of state.clients) {
        try { ws.close(); } catch {}
      }
    });

    sessions.set(id, state);
    return state;
  }

  function destroy(id, cb) {
    const state = sessions.get(id);
    if (!state) return cb && cb(false);
    // Remove from map first so concurrent attachWs/list calls don't pick up a dying session.
    sessions.delete(id);
    for (const ws of state.clients) {
      try { ws.close(); } catch {}
    }
    // Kill the tmux session (the pty is just the client; tmux server persists otherwise).
    execFile('tmux', ['kill-session', '-t', id], () => {
      try { state.pty.kill(); } catch {}
      if (cb) cb(true);
    });
  }

  function get(id) {
    return sessions.get(id);
  }

  function list() {
    return [...sessions.values()].map(s => ({ id: s.id, cols: s.cols, rows: s.rows }));
  }

  function attachWs(ws, sessionId) {
    const state = sessions.get(sessionId);
    if (!state) {
      try { ws.close(4404, 'session not found'); } catch {}
      return;
    }
    state.clients.add(ws);
    if (state.replayBuffer.length > 0) ws.send(state.replayBuffer);

    ws.on('message', data => {
      const msg = data.toString();
      if (msg.startsWith('{')) {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            const newCols = Math.max(1, parsed.cols);
            const newRows = Math.max(1, parsed.rows);
            if (newCols !== state.cols || newRows !== state.rows) {
              state.cols = newCols;
              state.rows = newRows;
              state.pty.resize(newCols, newRows);
            }
          }
        } catch {}
      } else {
        state.pty.write(msg);
      }
    });

    ws.on('close', () => state.clients.delete(ws));
  }

  return { create, destroy, get, list, attachWs };
}

module.exports = { buildTmuxSpawnArgs, createApp, createSessionsApi, TMUX_CONF_PATH, SAFE_ID };

if (require.main === module) {
  startServer();
}

function startServer() {
  const sessionsApi = createSessionsApi();
  const app         = createApp({ sessionsApi });
  const server      = http.createServer(app);
  const wss         = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get('session');
    if (!sessionId || !SAFE_ID.test(sessionId)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => sessionsApi.attachWs(ws, sessionId));
  });

  server.listen(PORT, '0.0.0.0', () =>
    console.log(`pocket-dev on :${PORT}  (base session: ${SESSION_BASE}  cmd: ${CMD})`));
}
