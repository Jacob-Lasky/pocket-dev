import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import {
  normalizeLayout, createLayoutStore, createLayoutApi, createMemoryLayoutStore, MAX_GROUPS, MAX_NAME_LENGTH,
  MAX_SESSION_NAME_LENGTH,
} from '../../sessionLayout.js';
import { applyAutogroup, buildPrompt, claudeClassifier } from '../../autogroup.js';
import { createApp } from '../../server.js';

const LIVE = ['main-1', 'main-2', 'main-3', 'main-4'];

describe('normalizeLayout, the one gate for PUT bodies and the file on disk', () => {
  it('turns nothing into the flat list in creation order', () => {
    expect(normalizeLayout(null, LIVE)).toEqual({ version: 1, groups: [], ungrouped: LIVE, names: {} });
  });

  it('appends sessions the layout has not seen to the END of Ungrouped, in creation order', () => {
    // That is the order the list had before groups existed, so a person who
    // never groups anything sees nothing move.
    const out = normalizeLayout({ groups: [], ungrouped: ['main-3'] }, LIVE);
    expect(out.ungrouped).toEqual(['main-3', 'main-1', 'main-2', 'main-4']);
  });

  it('drops ids that are not live, so a killed tab leaves its group', () => {
    const out = normalizeLayout({ groups: [{ id: 'g-1', name: 'dh', sessions: ['main-9', 'main-2'] }] }, LIVE);
    expect(out.groups[0].sessions).toEqual(['main-2']);
  });

  it('places each id once: the first mention wins, later ones are ignored', () => {
    const out = normalizeLayout({
      groups: [
        { id: 'g-1', name: 'a', sessions: ['main-1', 'main-1'] },
        { id: 'g-2', name: 'b', sessions: ['main-1', 'main-2'] },
      ],
      ungrouped: ['main-2', 'main-3'],
    }, LIVE);
    expect(out.groups.map((g) => g.sessions)).toEqual([['main-1'], ['main-2']]);
    expect(out.ungrouped).toEqual(['main-3', 'main-4']);
  });

  it('refuses ids outside SAFE_ID and non-string ids, for sessions and groups alike', () => {
    const out = normalizeLayout({
      groups: [
        { id: "x'; rm -rf /", name: 'evil', sessions: ['main-1'] },
        { id: 7, name: 'number', sessions: ['main-1'] },
        { id: 'g-ok', name: 'ok', sessions: ["main-1'; touch /tmp/p", { id: 'main-1' }, 'main-1'] },
      ],
    }, LIVE);
    expect(out.groups.map((g) => g.id)).toEqual(['g-ok']);
    expect(out.groups[0].sessions).toEqual(['main-1']);
  });

  it('drops a second group with the same id instead of rendering two', () => {
    const out = normalizeLayout({ groups: [{ id: 'g-1', name: 'a' }, { id: 'g-1', name: 'b' }] }, LIVE);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].name).toBe('a');
  });

  it('cleans names: control characters, runs of whitespace, length, and empty', () => {
    const out = normalizeLayout({
      groups: [
        { id: 'g-1', name: 'deep\nhive\u001b[31m   work' },
        { id: 'g-2', name: 'x'.repeat(200) },
        { id: 'g-3', name: '   ' },
        { id: 'g-4', name: { toString: () => 'object' } },
      ],
    }, LIVE);
    expect(out.groups[0].name).toBe('deep hive [31m work');
    expect(out.groups[1].name).toHaveLength(MAX_NAME_LENGTH);
    expect(out.groups[2].name).toBe('Group');
    expect(out.groups[3].name).toBe('Group');
  });

  it('keeps collapsed only when it is literally true', () => {
    const out = normalizeLayout({
      groups: [{ id: 'g-1', collapsed: true }, { id: 'g-2', collapsed: 'yes' }],
    }, LIVE);
    expect(out.groups.map((g) => g.collapsed)).toEqual([true, false]);
  });

  it('keeps names given to live sessions, cleaned, and drops the rest', () => {
    const out = normalizeLayout({ names: {
      'main-1': '  Codex\nreview  ',
      'main-2': '',                       // cleared: back to the automatic title
      'main-9': 'gone',                   // not a live session
      "x'; rm": 'evil',                   // not a SAFE_ID
      'main-3': 42,                       // not text
      'main-4': 'y'.repeat(200),
    } }, LIVE);
    expect(out.names).toEqual({ 'main-1': 'Codex review', 'main-4': 'y'.repeat(MAX_SESSION_NAME_LENGTH) });
  });

  it('refuses __proto__ as a session id, so a name cannot set the prototype', () => {
    const raw = JSON.parse('{"names":{"__proto__":"x","main-1":"ok"}}');
    const out = normalizeLayout(raw, [...LIVE, '__proto__']);
    expect(Object.keys(out.names)).toEqual(['main-1']);
    expect(Object.getPrototypeOf(out.names)).toBe(Object.prototype);
  });

  it('treats names that are not an object as no names', () => {
    for (const names of [null, 'x', ['main-1'], 3]) expect(normalizeLayout({ names }, LIVE).names).toEqual({});
  });

  it('caps the number of groups', () => {
    const groups = Array.from({ length: MAX_GROUPS + 10 }, (_, i) => ({ id: `g-${i}`, name: `${i}` }));
    expect(normalizeLayout({ groups }, LIVE).groups).toHaveLength(MAX_GROUPS);
  });

  it('survives garbage of every shape', () => {
    for (const raw of [undefined, 42, 'str', [], { groups: 'no' }, { groups: [null, 1, 'x'] }, { ungrouped: {} }]) {
      expect(normalizeLayout(raw, LIVE)).toEqual({ version: 1, groups: [], ungrouped: LIVE, names: {} });
    }
  });
});

describe('the layout file', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-layout-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips through layout.json in the state dir', () => {
    const store = createLayoutStore({ dir });
    store.save({ version: 1, groups: [], ungrouped: ['main-1'], names: {} });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf8')).ungrouped).toEqual(['main-1']);
    expect(createLayoutStore({ dir }).load().ungrouped).toEqual(['main-1']);
  });

  it('reads a missing file as no layout, silently', () => {
    const logger = { warn: vi.fn() };
    expect(createLayoutStore({ dir, logger }).load()).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reads a corrupt file as no layout and says so once', () => {
    fs.writeFileSync(path.join(dir, 'layout.json'), '{nope');
    const logger = { warn: vi.fn() };
    expect(createLayoutStore({ dir, logger }).load()).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('disables itself on an unwritable dir instead of throwing', () => {
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    const logger = { warn: vi.fn() };
    const store = createLayoutStore({ dir: path.join(blocker, 'sub'), logger });
    expect(() => store.save({ groups: [] })).not.toThrow();
    expect(() => store.save({ groups: [] })).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('PRUNES on read and writes the pruned layout back, so a reused id starts ungrouped', () => {
    // Session ids restart from the highest restored one after a restart, so a
    // tab killed last run can hand its id to a brand new tab. startServer runs
    // prune() after restore and before any new id exists; this is that call.
    const store = createLayoutStore({ dir });
    store.save({ version: 1, groups: [{ id: 'g-1', name: 'dh', collapsed: false, sessions: ['main-1', 'main-5'] }], ungrouped: [], names: {} });
    let live = ['main-1'];
    const api = createLayoutApi({ store, liveIds: () => live });
    api.prune();
    expect(store.load().groups[0].sessions).toEqual(['main-1']);
    live = ['main-1', 'main-5'];
    expect(api.get().groups[0].sessions).toEqual(['main-1']);
    expect(api.get().ungrouped).toEqual(['main-5']);
  });

  it('keeps the revision in the file, so it only ever increases across restarts', () => {
    const store = createLayoutStore({ dir });
    const api = createLayoutApi({ store, liveIds: () => ['main-1'] });
    expect(api.put({ groups: [] }).layout.rev).toBe(1);
    expect(api.put({ groups: [] }).layout.rev).toBe(2);
    expect(createLayoutApi({ store: createLayoutStore({ dir }), liveIds: () => ['main-1'] }).get().rev).toBe(2);
  });

  it('does not rewrite a file that was already normal', () => {
    const store = { load: vi.fn(() => ({ version: 1, groups: [], ungrouped: ['main-1'], names: {}, rev: 3 })), save: vi.fn() };
    createLayoutApi({ store, liveIds: () => ['main-1'] }).get();
    expect(store.save).not.toHaveBeenCalled();
  });

  it('defaults to a memory store, so an embedder gets working groups and no disk writes', () => {
    const api = createLayoutApi({ liveIds: () => ['main-1'] });
    api.put({ groups: [{ id: 'g-1', name: 'a', sessions: ['main-1'] }] });
    expect(api.get().groups[0].sessions).toEqual(['main-1']);
    expect(createMemoryLayoutStore().file).toBeNull();
  });
});

describe('applyAutogroup, the model answer folded into a layout', () => {
  const empty = normalizeLayout(null, LIVE);

  it('places what the model grouped and leaves the rest ungrouped', () => {
    const out = applyAutogroup(empty, { groups: [{ name: 'deephive', sessions: ['main-1', 'main-3'] }] }, LIVE);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]).toMatchObject({ name: 'deephive', sessions: ['main-1', 'main-3'], collapsed: false });
    expect(out.groups[0].id).toMatch(/^g-[0-9a-f]{8}$/);
    expect(out.ungrouped).toEqual(['main-2', 'main-4']);
  });

  it('ignores ids the model invented and ids it used twice', () => {
    const out = applyAutogroup(empty, { groups: [
      { name: 'a', sessions: ['main-1', 'main-99', 'main-2'] },
      { name: 'b', sessions: ['main-2', 'main-3', 'main-4'] },
    ] }, LIVE);
    expect(out.groups.map((g) => g.sessions)).toEqual([['main-1', 'main-2'], ['main-3', 'main-4']]);
  });

  it('folds a new one-session group into Ungrouped', () => {
    const out = applyAutogroup(empty, { groups: [
      { name: 'solo', sessions: ['main-1'] },
      { name: 'pair', sessions: ['main-2', 'main-3'] },
    ] }, LIVE);
    expect(out.groups.map((g) => g.name)).toEqual(['pair']);
    expect(out.ungrouped).toEqual(['main-1', 'main-4']);
  });

  it('keeps an existing group, its id, its spelling and its collapsed state when the model reuses the name', () => {
    const prior = normalizeLayout({ groups: [{ id: 'g-keep', name: 'DeepHive', collapsed: true, sessions: ['main-4'] }] }, LIVE);
    const out = applyAutogroup(prior, { groups: [{ name: 'deephive', sessions: ['main-1'] }] }, LIVE);
    expect(out.groups).toEqual([{ id: 'g-keep', name: 'DeepHive', collapsed: true, sessions: ['main-1'] }]);
    // main-4 was grouped before and is not now, so it lands in Ungrouped.
    expect(out.ungrouped).toEqual(['main-2', 'main-3', 'main-4']);
  });

  it('merges two proposed groups that share a name', () => {
    const out = applyAutogroup(empty, { groups: [
      { name: 'dh', sessions: ['main-1', 'main-2'] },
      { name: 'DH', sessions: ['main-3'] },
    ] }, LIVE);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].sessions).toEqual(['main-1', 'main-2', 'main-3']);
  });

  it('merges same-named proposals BEFORE judging size, so two halves of a pair become one group', () => {
    const out = applyAutogroup(empty, { groups: [
      { name: 'x', sessions: ['main-1'] },
      { name: 'X', sessions: ['main-2'] },
    ] }, LIVE);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].sessions).toEqual(['main-1', 'main-2']);
  });

  it('leaves a group the model did not name alone, including an empty one made by hand', () => {
    const prior = normalizeLayout({ groups: [
      { id: 'g-hand', name: 'mine', sessions: ['main-1', 'main-2'] },
      { id: 'g-new', name: 'to fill' },
      { id: 'g-gone', name: 'old', sessions: ['main-3'] },
    ] }, LIVE);
    const out = applyAutogroup(prior, { groups: [{ name: 'dh', sessions: ['main-2', 'main-3'] }] }, LIVE);
    expect(out.groups.map((g) => [g.id, g.sessions])).toEqual([
      [expect.stringMatching(/^g-/), ['main-2', 'main-3']],
      ['g-hand', ['main-1']],        // keeps what the model did not move
      ['g-new', []],                 // empty by hand, still there to be filled
      // g-gone is dropped: the model took the only session it had.
    ]);
  });

  it('keeps the names people gave sessions, and shows them to the model in place of the title', () => {
    const prior = normalizeLayout({ names: { 'main-2': 'Billing migration' } }, LIVE);
    const out = applyAutogroup(prior, { groups: [{ name: 'dh', sessions: ['main-1', 'main-2'] }] }, LIVE);
    expect(out.names).toEqual({ 'main-2': 'Billing migration' });
    const prompt = buildPrompt([{ id: 'main-2', title: 'auto title', lastPrompt: null, provider: 'claude' }], prior);
    expect(prompt).toContain('"title":"Billing migration"');
    expect(prompt).not.toContain('auto title');
  });

  it('reads only names the layout actually holds, so an id like toString keeps its title', () => {
    const prompt = buildPrompt([{ id: 'toString', title: 'Real title', lastPrompt: null, provider: 'claude' }],
      normalizeLayout(null, ['toString']));
    expect(prompt).toContain('"title":"Real title"');
  });

  it('treats a malformed answer as "no groups" rather than throwing', () => {
    for (const bad of [null, {}, { groups: 'x' }, { groups: [{ name: 3 }, { sessions: ['main-1'] }] }]) {
      expect(applyAutogroup(empty, bad, LIVE)).toEqual(empty);
    }
  });

  it('sends the model the existing group names and clipped session text, not the transcript', () => {
    const prior = normalizeLayout({ groups: [{ id: 'g-1', name: 'deephive' }] }, LIVE);
    const prompt = buildPrompt([
      { id: 'main-1', title: 'T'.repeat(500), lastPrompt: 'P'.repeat(900), provider: 'claude', providerLabel: 'Claude' },
    ], prior);
    expect(prompt).toContain('["deephive"]');
    expect(prompt).toContain(`"title":"${'T'.repeat(120)}"`);
    expect(prompt).not.toContain('T'.repeat(121));
    expect(prompt).not.toContain('P'.repeat(301));
  });
});

describe('claudeClassifier, the real headless call', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-classify-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A stand-in binary that records its argv and stdin, then prints `reply`
  // (as JSON, or verbatim when it is a string).
  function stub(reply, { exit = 0, sleep = 0 } = {}) {
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, [
      '#!/bin/bash',
      `printf '%s\\n' "$@" > '${dir}/argv'`,
      `cat > '${dir}/stdin'`,
      sleep ? `sleep ${sleep}` : '',
      `printf '%s' '${(typeof reply === 'string' ? reply : JSON.stringify(reply)).replace(/'/g, "'\\''")}'`,
      `exit ${exit}`,
    ].join('\n'), { mode: 0o755 });
    return bin;
  }

  it('asks for structured output with no tools and no saved session, and passes the prompt on stdin', async () => {
    const bin = stub({ is_error: false, structured_output: { groups: [{ name: 'a', sessions: ['main-1'] }] } });
    const out = await claudeClassifier('PROMPT-TEXT', { bin });
    expect(out).toEqual({ groups: [{ name: 'a', sessions: ['main-1'] }] });
    const argv = fs.readFileSync(path.join(dir, 'argv'), 'utf8').split('\n');
    for (const flag of ['-p', '--no-session-persistence', '--strict-mcp-config', '--json-schema']) expect(argv).toContain(flag);
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('json');
    // The prompt carries session titles; argv is world-readable in ps.
    expect(argv.join(' ')).not.toContain('PROMPT-TEXT');
    expect(fs.readFileSync(path.join(dir, 'stdin'), 'utf8')).toBe('PROMPT-TEXT');
  });

  it('rejects an error result, a missing structured_output, non-JSON, and a failed exit', async () => {
    await expect(claudeClassifier('p', { bin: stub({ is_error: true, structured_output: { groups: [] } }) })).rejects.toThrow(/no groups/);
    await expect(claudeClassifier('p', { bin: stub({ is_error: false, result: 'text' }) })).rejects.toThrow(/no groups/);
    await expect(claudeClassifier('p', { bin: stub('not json at all') })).rejects.toThrow(/malformed/);
    await expect(claudeClassifier('p', { bin: stub({}, { exit: 3 }) })).rejects.toThrow(/autogroup failed/);
  });

  it('survives the CLI exiting before it reads a large prompt, instead of crashing the server', async () => {
    // A prompt bigger than the pipe buffer, written to a process that is
    // already gone, fails with EPIPE. Unhandled, that error kills node.
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await expect(claudeClassifier('x'.repeat(2_000_000), { bin })).rejects.toThrow(/autogroup failed/);
  });

  it('gives up after its timeout', async () => {
    await expect(claudeClassifier('p', { bin: stub({}, { sleep: 5 }), timeoutMs: 200 })).rejects.toThrow(/timed out/);
  });
});

describe('the /layout routes', () => {
  function fakeSessions(ids = ['main-1', 'main-2', 'main-3']) {
    return {
      list: () => ids.map((id) => ({ id })),
      describe: () => ids.map((id) => ({ id, title: `t-${id}`, lastPrompt: null, provider: 'claude', providerLabel: 'Claude' })),
    };
  }

  it('serves the flat layout before anything was saved', async () => {
    const app = createApp({ sessionsApi: fakeSessions() });
    const res = await request(app).get('/layout');
    expect(res.body).toEqual({ version: 1, groups: [], ungrouped: ['main-1', 'main-2', 'main-3'], names: {}, rev: 0 });
  });

  it('saves a PUT and answers with the normalised version', async () => {
    const app = createApp({ sessionsApi: fakeSessions() });
    const put = await request(app).put('/layout').send({
      groups: [{ id: 'g-1', name: 'dh', sessions: ['main-3', 'nope'] }], ungrouped: ['main-2'],
    });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ version: 1, groups: [{ id: 'g-1', name: 'dh', collapsed: false, sessions: ['main-3'] }], ungrouped: ['main-2', 'main-1'], names: {}, rev: 1 });
    expect((await request(app).get('/layout')).body).toEqual(put.body);
  });

  it('refuses a body that is not a layout object', async () => {
    const app = createApp({ sessionsApi: fakeSessions() });
    expect((await request(app).put('/layout').send([1, 2])).status).toBe(400);
    expect((await request(app).put('/layout').set('Content-Type', 'application/json').send('"x"')).status).toBe(400);
  });

  it('autogroups through the injected classifier and saves the result', async () => {
    const classify = vi.fn(async () => ({ groups: [{ name: 'dh', sessions: ['main-1', 'main-3'] }] }));
    const app = createApp({ sessionsApi: fakeSessions(), classify });
    const res = await request(app).post('/layout/autogroup');
    expect(res.status).toBe(200);
    expect(res.body.groups[0]).toMatchObject({ name: 'dh', sessions: ['main-1', 'main-3'] });
    expect(classify.mock.calls[0][0]).toContain('"title":"t-main-2"');
    // `previous` is what it was applied to, for the browser's Undo.
    expect(res.body.previous).toEqual({ version: 1, groups: [], ungrouped: ['main-1', 'main-2', 'main-3'], names: {}, rev: 0 });
    const { previous, ...saved } = res.body;
    expect((await request(app).get('/layout')).body).toEqual(saved);
  });

  it('reports a classifier failure as 502 and leaves the layout alone', async () => {
    const app = createApp({ sessionsApi: fakeSessions(), classify: async () => { throw new Error('autogroup timed out'); } });
    const before = (await request(app).put('/layout').send({ groups: [{ id: 'g-1', name: 'x', sessions: ['main-1'] }] })).body;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).post('/layout/autogroup');
    warn.mockRestore();
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('autogroup timed out');
    expect((await request(app).get('/layout')).body).toEqual(before);
  });

  it('runs one autogroup at a time', async () => {
    let release;
    const classify = vi.fn(() => new Promise((resolve) => { release = () => resolve({ groups: [] }); }));
    const app = createApp({ sessionsApi: fakeSessions(), classify });
    const first = request(app).post('/layout/autogroup').then((r) => r);
    await vi.waitFor(() => expect(classify).toHaveBeenCalled());
    expect((await request(app).post('/layout/autogroup')).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });

  it('refuses an edit made against a revision another device has since replaced', async () => {
    const app = createApp({ sessionsApi: fakeSessions() });
    const a = (await request(app).put('/layout').send({ groups: [{ id: 'g-a', name: 'a', sessions: ['main-1'] }], baseRev: 0 })).body;
    expect(a.rev).toBe(1);
    // A second device still on revision 0 renames something.
    const stale = await request(app).put('/layout').send({ groups: [{ id: 'g-b', name: 'b' }], baseRev: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.layout).toEqual(a);
    expect((await request(app).get('/layout')).body).toEqual(a);
    // Made against the current revision, it saves.
    expect((await request(app).put('/layout').send({ groups: [], baseRev: 1 })).body.rev).toBe(2);
    // A client that sends no revision at all still saves, last write wins.
    expect((await request(app).put('/layout').send({ groups: [] })).status).toBe(200);
    expect((await request(app).put('/layout').send({ groups: [], baseRev: 'x' })).status).toBe(400);
  });

  it('says so when the save did not reach the disk, rather than answering 200', async () => {
    const store = { load: () => null, save: () => false };
    const sessionsApi = fakeSessions();
    const layoutApi = createLayoutApi({ store, liveIds: () => sessionsApi.list().map((x) => x.id) });
    const app = createApp({ sessionsApi, layoutApi });
    const res = await request(app).put('/layout').send({ groups: [{ id: 'g-1', name: 'x', sessions: ['main-1'] }] });
    expect(res.status).toBe(503);
    expect(res.body.layout.groups).toEqual([]);
  });

  it('is absent with no sessionsApi, like every other session route', async () => {
    expect((await request(createApp()).get('/layout')).status).toBe(404);
  });
});
