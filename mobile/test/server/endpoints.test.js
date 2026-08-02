import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../server.js';

describe('express endpoints (static + assets)', () => {
  const app = createApp();

  it('GET /history returns 404 (endpoint removed)', async () => {
    const res = await request(app).get('/history');
    expect(res.status).toBe(404);
  });

  it('GET / returns the index.html', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('pocket-dev');
  });

  it('serves xterm.js static assets', async () => {
    const res = await request(app).get('/xterm/lib/xterm.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
  });

  it('serves @xterm/addon-fit', async () => {
    const res = await request(app).get('/addon-fit/lib/addon-fit.js');
    expect(res.status).toBe(200);
  });

  it('/sessions endpoints absent when no sessionsApi is injected', async () => {
    const res = await request(app).get('/sessions');
    expect(res.status).toBe(404);
  });
});

// Build a stub sessionsApi that records calls. Lets us test the express
// wiring without standing up real ptys/tmux.
function stubSessionsApi() {
  const fakeSession = (id) => ({
    id, cols: 120, rows: 40,
    pty: { write: vi.fn() },
  });
  const sessions = new Map();
  let seq = 1;
  return {
    create:  vi.fn(() => {
      const s = fakeSession(`sess-${seq++}`);
      sessions.set(s.id, s);
      return s;
    }),
    destroy: vi.fn((id, cb) => {
      const had = sessions.delete(id);
      cb && cb(had);
    }),
    get:  vi.fn((id) => sessions.get(id)),
    list: vi.fn(() => [...sessions.values()].map(s => ({ id: s.id, cols: s.cols, rows: s.rows }))),
    // GET /sessions serves describe(), not list(): the browser needs each
    // session's title and state, and list() stays cheap for the roster write.
    describe: vi.fn(() => [...sessions.values()].map(s => ({
      id: s.id, cols: s.cols, rows: s.rows, title: null, lastPrompt: null,
      status: 'unknown', unread: false, lastOutputAt: 0,
    }))),
    markViewed: vi.fn((id) => sessions.has(id)),
    // Part of the route contract: /send and /key report the keystroke so the
    // Remote Control auto-rename knows not to type over someone mid-message.
    noteInput: vi.fn((state) => { state.lastInputAt = 1; }),
    attachWs: vi.fn(),
    _internalSessions: sessions, // not used by routes; exposed for assertions
  };
}

describe('session-aware endpoints', () => {
  it('GET /sessions returns empty list initially', async () => {
    const sessionsApi = stubSessionsApi();
    const app = createApp({ sessionsApi });
    const res = await request(app).get('/sessions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('GET /sessions serves describe(), so rows carry a title and a state', async () => {
    // Regression guard for the route contract: serving list() here would give
    // the browser ids with no way to label or triage them.
    const sessionsApi = stubSessionsApi();
    const app = createApp({ sessionsApi });
    await request(app).post('/sessions');
    const res = await request(app).get('/sessions');
    expect(res.status).toBe(200);
    expect(sessionsApi.describe).toHaveBeenCalled();
    expect(res.body[0]).toMatchObject({
      title: null, lastPrompt: null, status: 'unknown', unread: false,
    });
  });

  it('POST /sessions creates a session and returns its id', async () => {
    const sessionsApi = stubSessionsApi();
    const app = createApp({ sessionsApi });
    const res = await request(app).post('/sessions');
    expect(res.status).toBe(200);
    expect(res.body.id).toMatch(/^sess-\d+$/);
    expect(sessionsApi.create).toHaveBeenCalledOnce();

    const list = await request(app).get('/sessions');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(res.body.id);
  });

  it('DELETE /sessions/:id removes the session', async () => {
    const sessionsApi = stubSessionsApi();
    const app = createApp({ sessionsApi });
    const { body: created } = await request(app).post('/sessions');
    const res = await request(app).delete(`/sessions/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(sessionsApi.destroy).toHaveBeenCalledWith(created.id, expect.any(Function));
  });

  it('DELETE /sessions/:id rejects unsafe ids', async () => {
    const sessionsApi = stubSessionsApi();
    const app = createApp({ sessionsApi });
    const res = await request(app).delete('/sessions/foo;bar');
    expect(res.status).toBe(400);
  });

  it('POST /send writes text + carriage return to the session pty', async () => {
    const sessionsApi = stubSessionsApi();
    const app = createApp({ sessionsApi });
    const { body: created } = await request(app).post('/sessions');
    const res = await request(app)
      .post('/send')
      .send({ session: created.id, text: 'hello' });
    expect(res.status).toBe(200);
    const pty = sessionsApi._internalSessions.get(created.id).pty;
    expect(pty.write).toHaveBeenNthCalledWith(1, 'hello');
    expect(pty.write).toHaveBeenNthCalledWith(2, '\r');
  });

  it('POST /send rejects missing session', async () => {
    const sessionsApi = stubSessionsApi();
    const app = createApp({ sessionsApi });
    const res = await request(app)
      .post('/send')
      .send({ session: 'nope-such', text: 'x' });
    expect(res.status).toBe(404);
  });

  it('POST /send rejects missing text', async () => {
    const sessionsApi = stubSessionsApi();
    const app = createApp({ sessionsApi });
    const { body: created } = await request(app).post('/sessions');
    const res = await request(app).post('/send').send({ session: created.id });
    expect(res.status).toBe(400);
  });

  it('POST /key writes special sequences', async () => {
    const sessionsApi = stubSessionsApi();
    const app = createApp({ sessionsApi });
    const { body: created } = await request(app).post('/sessions');
    const pty = sessionsApi._internalSessions.get(created.id).pty;

    await request(app).post('/key').send({ session: created.id, key: 'escape' });
    expect(pty.write).toHaveBeenCalledWith('\x1b');

    await request(app).post('/key').send({ session: created.id, key: 'up' });
    expect(pty.write).toHaveBeenCalledWith('\x1b[A');

    await request(app).post('/key').send({ session: created.id, key: 'ctrl-c' });
    expect(pty.write).toHaveBeenCalledWith('\x03');
  });

  it('reports input on /send and /key, so the auto-rename does not type over you', async () => {
    // Both routes are a human at a keyboard. If either stops reporting, the
    // Remote Control rename can land in the middle of a message being composed
    // from the phone or the on-screen key row, and nothing else would notice.
    const sessionsApi = stubSessionsApi();
    const app = createApp({ sessionsApi });
    const { body: created } = await request(app).post('/sessions');
    const state = sessionsApi._internalSessions.get(created.id);

    await request(app).post('/send').send({ session: created.id, text: 'hello' });
    expect(sessionsApi.noteInput).toHaveBeenCalledWith(state);

    sessionsApi.noteInput.mockClear();
    await request(app).post('/key').send({ session: created.id, key: 'escape' });
    expect(sessionsApi.noteInput).toHaveBeenCalledWith(state);

    // The ctrl- branch returns early, so it needs its own check.
    sessionsApi.noteInput.mockClear();
    await request(app).post('/key').send({ session: created.id, key: 'ctrl-c' });
    expect(sessionsApi.noteInput).toHaveBeenCalledWith(state);

    // A rejected key is not input: nothing reached the pty.
    sessionsApi.noteInput.mockClear();
    await request(app).post('/key').send({ session: created.id, key: 'banana' });
    expect(sessionsApi.noteInput).not.toHaveBeenCalled();
  });

  it('POST /key rejects unknown keys', async () => {
    const sessionsApi = stubSessionsApi();
    const app = createApp({ sessionsApi });
    const { body: created } = await request(app).post('/sessions');
    const res = await request(app)
      .post('/key')
      .send({ session: created.id, key: 'banana' });
    expect(res.status).toBe(400);
  });

  it('POST /viewed records that a session was read', async () => {
    // Read/unread is server-side so it holds across devices: reading on the
    // phone has to clear it on the desktop too.
    const sessionsApi = stubSessionsApi();
    const app = createApp({ sessionsApi });
    const { body: created } = await request(app).post('/sessions');
    const res = await request(app).post('/viewed').send({ session: created.id });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(sessionsApi.markViewed).toHaveBeenCalledWith(created.id);
  });

  it('POST /viewed requires a valid session (400 if missing, 404 if unknown)', async () => {
    const sessionsApi = stubSessionsApi();
    const app = createApp({ sessionsApi });
    expect((await request(app).post('/viewed').send({})).status).toBe(400);
    expect((await request(app).post('/viewed').send({ session: 'nope-such' })).status).toBe(404);
  });

  it('POST /refresh requires a valid session (400 if missing, 404 if unknown)', async () => {
    const sessionsApi = stubSessionsApi();
    const app = createApp({ sessionsApi });

    const missing = await request(app).post('/refresh').send({});
    expect(missing.status).toBe(400);

    const unknown = await request(app).post('/refresh').send({ session: 'nope-such' });
    expect(unknown.status).toBe(404);
  });

  it('rejects session ids with shell metacharacters across endpoints', async () => {
    const sessionsApi = stubSessionsApi();
    const app = createApp({ sessionsApi });
    const evil = "x';rm -rf /;'";
    for (const path of ['/send', '/key', '/refresh', '/viewed']) {
      const body = path === '/send' ? { session: evil, text: 'x' }
                 : path === '/key'  ? { session: evil, key: 'enter' }
                 :                    { session: evil };
      const res = await request(app).post(path).send(body);
      expect(res.status, `${path} should 400 on unsafe id`).toBe(400);
    }
  });
});
