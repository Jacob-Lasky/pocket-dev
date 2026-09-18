const { spawn } = require('node:child_process');

const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;

function stop(child) {
  try { child.stdin.end(); } catch {}
  try { child.kill('SIGTERM'); } catch {}
}

// Run a bounded sequence of requests against one initialized Codex App Server.
// stderr stays ignored because an upstream diagnostic may contain the thread id
// supplied in a request, and none of pocket-dev's helpers may expose that id.
function withCodexAppServer({ clientInfo, timeoutMs }, task) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--stdio'], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const pending = new Map();
    let buffer = '';
    let nextRequestId = 1;
    let settled = false;

    const timeout = setTimeout(() => finish(new Error('timeout')), timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stop(child);
      for (const waiter of pending.values()) waiter.reject(error || new Error('closed'));
      pending.clear();
      if (error) reject(error);
      else resolve(result);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function request(method, params) {
      if (settled) return Promise.reject(new Error('app-server closed'));
      const id = nextRequestId++;
      return new Promise((requestResolve, requestReject) => {
        pending.set(id, { resolve: requestResolve, reject: requestReject });
        try {
          send({ method, id, params });
        } catch (error) {
          pending.delete(id);
          requestReject(error);
        }
      });
    }

    function receive(message) {
      if (!Number.isInteger(message?.id)) return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error('app-server error'));
      else waiter.resolve(message.result);
    }

    child.once('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.once('exit', () => {
      if (!settled) finish(new Error('app-server exited'));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (settled) return;
      buffer += chunk;

      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) {
          finish(new Error('protocol line too large'));
          return;
        }
        try {
          receive(JSON.parse(line));
        } catch (error) {
          finish(error);
          return;
        }
        if (settled) return;
      }
      if (Buffer.byteLength(buffer) > MAX_PROTOCOL_LINE_BYTES) {
        finish(new Error('protocol line too large'));
      }
    });

    void (async () => {
      await request('initialize', {
        clientInfo,
        capabilities: { experimentalApi: true },
      });
      send({ method: 'initialized', params: {} });
      finish(null, await task(request));
    })().catch(error => finish(error));
  });
}

module.exports = { withCodexAppServer };
