// The rendered session row, for a Claude tab and for a tab whose harness
// pocket-dev cannot read.
//
// WHY THIS IS NOT A STUB MATCHING ITS OWN SHAPE, which is the failure mode a
// row-rendering test invites: the functions under test are SLICED VERBATIM out
// of index.html and evaluated, so this exercises the shipped source rather than
// a copy of it. index.html is monolithic by design with an inline
// `<script type="module">`, so there is nothing to import; the same constraint
// is why onclick-coverage.test.js parses the file. What the test supplies is
// only the DOM container, the session objects and the imported pure modules,
// which is exactly the boundary the browser supplies.
//
// It is also the visual artifact for the provider feature. `PD_ROW_ARTIFACT=<path>`
// writes the rendered HTML out, so the two rows can be read rather than
// asserted about. One code path, so the file that gets looked at is the same
// DOM these assertions ran against.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { STATE_TEXT, rowState, isUnread, summarise, wantsUser } from '../../public/js/attention.js';
import { UNGROUPED, emptyLayout, arrange } from '../../public/js/groups.js';

const indexHtml = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');

// From the first of the row helpers to the badge section that follows them.
// Asserted rather than assumed: a rename upstream must break this loudly
// instead of silently slicing nothing.
function sliceRowRenderer() {
  const from = indexHtml.indexOf('const stateOfSession =');
  const to   = indexHtml.indexOf('// The badge is the reason to poll');
  expect(from, 'index.html has no stateOfSession wrapper to slice').toBeGreaterThan(-1);
  expect(to, 'index.html has no badge section to slice up to').toBeGreaterThan(from);
  return indexHtml.slice(from, to);
}

// index.html's own stylesheet, so what a row LOOKS like is measurable rather
// than asserted about. happy-dom resolves these selectors, which is what makes
// the colour claims below evidence instead of a reading of the source.
const styleSheet = indexHtml.slice(indexHtml.indexOf('<style>') + '<style>'.length, indexHtml.indexOf('</style>'));

// Stand the sliced renderer up against a real DOM.
function mountRenderer({ sessions, order, activeId, layout = emptyLayout(), listDrag = null, cancelListDrag = () => {} }) {
  document.head.innerHTML = `<style>${styleSheet}</style>`;
  document.body.innerHTML = '<span id="sl-count"></span><ul id="sl-rows"></ul>';
  // slRows, slCount, layout and listDrag are declared above the slice, so they
  // are injected here exactly as the browser supplies them.
  const factory = new Function(
    'document', 'sessions', 'order', 'activeId', 'slRows', 'slCount', 'layout', 'listDrag', 'cancelListDrag',
    'STATE_TEXT', 'rowState', 'isUnread', 'summarise', 'wantsUser', 'UNGROUPED', 'arrange',
    `${sliceRowRenderer()}\nreturn { renderSessionList, buildRow, dropSessionRow, slRowEls, slGroupEls };`,
  );
  return factory(
    document, sessions, order, activeId,
    document.getElementById('sl-rows'), document.getElementById('sl-count'), layout, listDrag, cancelListDrag,
    STATE_TEXT, rowState, isUnread, summarise, wantsUser, UNGROUPED, arrange,
  );
}

// index.html's OWN fold of a GET /sessions row onto a client session object,
// sliced the same way as the renderer. The four display side effects it calls
// are injected as no-ops: they are unrelated to the fold and each one reaches
// DOM this harness does not stand up.
function applyMeta(sessions, list) {
  const from = indexHtml.indexOf('function applySessionMeta(');
  const to   = indexHtml.indexOf('async function refreshSessionMeta(');
  expect(from, 'index.html has no applySessionMeta to slice').toBeGreaterThan(-1);
  expect(to, 'index.html has no refreshSessionMeta to slice up to').toBeGreaterThan(from);
  const noop = () => {};
  new Function(
    'document', 'sessions',
    'updateSessionLabel', 'updateDocumentTitle', 'updateSessionsBadge', 'renderSessionList',
    `${indexHtml.slice(from, to)}\nreturn applySessionMeta;`,
  )(document, sessions, noop, noop, noop, noop)(list);
  return sessions;
}

// A row exactly as GET /sessions describes it, folded onto the client's session
// object BY index.html's own applySessionMeta, so the wire-to-row path under
// test is the shipped one end to end.
function sessionFrom(row, { id }) {
  const sessions = new Map([[id, { id }]]);
  applyMeta(sessions, [{ ...row, id }]);
  return sessions.get(id);
}

const CLAUDE_ROW = {
  id: 'main-2', title: 'Provider per session', lastPrompt: 'read the comments first',
  status: 'idle', unread: true, lastOutputAt: 0,
  provider: 'claude', providerLabel: 'Claude', statusTracked: true,
};

const CODEX_ROW = {
  id: 'main-3', title: null, lastPrompt: null,
  status: 'unknown', unread: false, lastOutputAt: 0,
  provider: 'codex', providerLabel: 'Codex', statusTracked: false,
};

let rows;

beforeEach(() => {
  const sessions = new Map([
    ['main-2', sessionFrom(CLAUDE_ROW, { id: 'main-2' })],
    ['main-3', sessionFrom(CODEX_ROW,  { id: 'main-3' })],
  ]);
  const renderer = mountRenderer({ sessions, order: ['main-2', 'main-3'], activeId: 'main-1' });
  renderer.renderSessionList();
  rows = [...document.querySelectorAll('.sl-row')];

  const out = process.env.PD_ROW_ARTIFACT;
  if (out) {
    const styled = rows.map((r) => {
      const status = r.querySelector('.sl-status');
      const dot    = r.querySelector('.sl-dot');
      return [
        r.outerHTML,
        `  <!-- computed: status colour ${getComputedStyle(status).color}`
        + `, status dot ${getComputedStyle(status.querySelector('.d')).backgroundColor}`
        + `, unread dot ${getComputedStyle(dot).visibility || 'painted'} -->`,
      ].join('\n');
    });
    fs.writeFileSync(out, `${document.getElementById('sl-count').outerHTML}\n${styled.join('\n')}\n`);
  }
});

describe('a Claude row', () => {
  it('is titled by its conversation and sits on the attention axis', () => {
    const row = rows[0];
    expect(row.querySelector('.sl-title').textContent).toBe('Provider per session');
    expect(row.querySelector('.sl-status').dataset.state).toBe('waiting');
    expect(row.querySelector('.sl-status span:last-child').textContent).toBe('Waiting on you');
    expect(row.querySelector('.sl-prev').textContent).toBe('read the comments first');
    // The unread dot is present and visible; the CSS hides it on false.
    expect(row.dataset.unread).toBe('true');
  });
});

describe('a row whose harness writes no transcript', () => {
  it('is named for what it IS, rather than left as a bare id', () => {
    // The highest-value line in the feature. Without it the tab reads `main-3`
    // and is indistinguishable from a Claude tab that has not named itself yet.
    expect(rows[1].querySelector('.sl-title').textContent).toBe('Codex · main-3');
  });

  it('says it has no status instead of picking one', () => {
    expect(rows[1].querySelector('.sl-status').dataset.state).toBe('opaque');
    expect(rows[1].querySelector('.sl-status span:last-child').textContent).toBe('Status not tracked');
  });

  it('carries no unread dot, so it never reads as a summons', () => {
    // This is the defect the feature would otherwise have shipped: falling
    // through to the unread axis makes a session that is THINKING say "Waiting
    // on you" and light the attention badge.
    expect(rows[1].dataset.unread).toBe('false');
    expect(rows[1].querySelector('.sl-status').dataset.state).not.toBe('waiting');
    // Measured against index.html's own stylesheet, not inferred from the
    // attribute: the dot is actually not painted.
    expect(getComputedStyle(rows[1].querySelector('.sl-dot')).visibility).toBe('hidden');
    // Asserted as "not hidden" rather than "visible": nothing sets visibility
    // on an unread row, so the computed value is the empty string rather than
    // the initial keyword. The claim being made is that the hiding rule did not
    // match, which is exactly what that expresses.
    expect(getComputedStyle(rows[0].querySelector('.sl-dot')).visibility).not.toBe('hidden');
  });

  it('is grey, and specifically NOT an error colour', () => {
    // Running a harness pocket-dev cannot read is a SUPPORTED configuration and
    // not a fault, so a red row would send the user hunting for a break that is
    // not there. Also distinguishable from 'read', because "done, and you saw
    // it" and "there is nothing to know" are different facts.
    const opaque  = rows[1].querySelector('.sl-status');
    const claude  = rows[0].querySelector('.sl-status');
    expect(getComputedStyle(opaque).color).toBe('#6e7681');
    expect(getComputedStyle(opaque.querySelector('.d')).backgroundColor).toBe('#484f58');
    // The palette's reds are #ff7b72 and #ffa198; the greens that mean "act"
    // are #3fb950 and #56d364. It must be none of them.
    for (const loud of ['#ff7b72', '#ffa198', '#3fb950', '#56d364', '#d29922']) {
      expect(getComputedStyle(opaque).color).not.toBe(loud);
      expect(getComputedStyle(opaque.querySelector('.d')).backgroundColor).not.toBe(loud);
    }
    // And the Claude row still gets the colour that means act, so this did not
    // grey out the whole list.
    expect(getComputedStyle(claude).color).toBe('#3fb950');
  });

  it('keeps its relative time, the one live signal it does have', () => {
    // lastOutputAt comes from raw pty data and needs no transcript, so it is
    // real for such a session even though nothing else on the row is.
    const withTime = new Map([['main-3', sessionFrom({ ...CODEX_ROW, lastOutputAt: Date.now() - 90_000 }, { id: 'main-3' })]]);
    const renderer = mountRenderer({ sessions: withTime, order: ['main-3'], activeId: 'main-1' });
    renderer.renderSessionList();
    expect(document.querySelector('.sl-meta span').textContent).toBe('1m');
  });

  it('is announced to a screen reader by the same name the row shows', () => {
    expect(rows[1].getAttribute('aria-label')).toBe('Codex · main-3. Status not tracked.');
  });
});

describe('the list header over a mixed set of tabs', () => {
  it('counts the opaque tab as a session and as neither needy nor working', () => {
    expect(document.getElementById('sl-count').textContent).toBe('2 sessions · 1 needs you');
  });
});

describe('the fold from the wire onto a row', () => {
  it('passes statusTracked through UNCOERCED, so an absent field is not opaque', () => {
    // `=== false` in attention.js is what reads this, and it is strict so that
    // a row from a server which does not send the field behaves exactly as it
    // did before providers existed. Coercing to a boolean here would turn
    // undefined into false and make every such row opaque.
    const sessions = new Map([['main-1', { id: 'main-1' }]]);
    applyMeta(sessions, [{ id: 'main-1', status: 'idle', unread: true }]);
    expect(sessions.get('main-1').statusTracked).toBeUndefined();
    expect(rowState(sessions.get('main-1'), 'other')).toBe('waiting');
  });

  it('keeps false as false, which is the whole signal', () => {
    const sessions = new Map([['main-1', { id: 'main-1' }]]);
    applyMeta(sessions, [{ id: 'main-1', status: 'unknown', unread: true, statusTracked: false }]);
    expect(sessions.get('main-1').statusTracked).toBe(false);
    expect(rowState(sessions.get('main-1'), 'other')).toBe('opaque');
  });

  it('carries the provider and its server-supplied label', () => {
    const sessions = new Map([['main-1', { id: 'main-1' }]]);
    applyMeta(sessions, [{ id: 'main-1', provider: 'codex', providerLabel: 'Codex' }]);
    expect(sessions.get('main-1')).toMatchObject({ provider: 'codex', providerLabel: 'Codex' });
  });
});

describe('the SessionState a row is rendered from', () => {
  // Source-level, for the reason tmuxConf.test.js and dgvpn.test.js are: the
  // constructor builds a real xterm Terminal, so standing one up here would
  // mean stubbing the library this test is not about. What matters is only the
  // initialiser, and it is readable.
  const ctor = indexHtml.slice(
    indexHtml.indexOf('class SessionState {'),
    indexHtml.indexOf('this.connect();'),
  );

  it('initialises the provider fields alongside the ones they sit with', () => {
    // Every other field the poll fills is initialised here, so a new one that
    // is not looks like an oversight to the next reader even though undefined
    // happens to be correct.
    expect(ctor, 'no SessionState constructor found to read').toBeTruthy();
    expect(ctor).toMatch(/this\.provider\s*=/);
    expect(ctor).toMatch(/this\.providerLabel\s*=/);
    expect(ctor).toMatch(/this\.statusTracked\s*=/);
  });

  it('does NOT seed statusTracked to false, which would open every pane opaque', () => {
    // attention.js reads it with `=== false`, so false is a real answer and not
    // an empty one. Seeded false, every pane including every Claude pane would
    // render "Status not tracked" until its first poll landed.
    expect(ctor).not.toMatch(/this\.statusTracked\s*=\s*false/);
    expect(ctor).toMatch(/this\.statusTracked\s*=\s*undefined/);
  });
});

describe('a Claude tab with no title yet', () => {
  it('keeps the existing fallback rather than gaining a provider prefix', () => {
    // Regression guard: the prefix is keyed off statusTracked, not off a
    // missing title, so a brand new Claude tab must be untouched. e2e's
    // session-list.spec.js pins 'Current session' for exactly this row.
    const fresh = new Map([['main-1', sessionFrom({ ...CLAUDE_ROW, title: null }, { id: 'main-1' })]]);
    const renderer = mountRenderer({ sessions: fresh, order: ['main-1'], activeId: 'main-1' });
    renderer.renderSessionList();
    expect(document.querySelector('.sl-title').textContent).toBe('Current session');
  });
});

describe('the list with groups', () => {
  const ids = ['main-1', 'main-2', 'main-3'];
  const make = () => new Map(ids.map((id) => [id, sessionFrom({ ...CLAUDE_ROW, title: `t ${id}`, unread: id === 'main-3' }, { id })]));
  const grouped = (collapsed) => ({
    version: 1,
    groups: [{ id: 'g-a', name: 'deephive', collapsed, sessions: ['main-3', 'main-1'] }],
    ungrouped: ['main-2'],
  });
  const shape = () => [...document.getElementById('sl-rows').children]
    .map((el) => (el.classList.contains('sl-group') ? `[${el.querySelector('.sl-group-name').textContent}]` : el.dataset.sessionId));

  it('has no headers at all until a group exists, so an ungrouped list is unchanged', () => {
    mountRenderer({ sessions: make(), order: ids, activeId: 'main-1' }).renderSessionList();
    expect(shape()).toEqual(['main-1', 'main-2', 'main-3']);
  });

  it('puts each group under its header, in layout order, with Ungrouped last', () => {
    mountRenderer({ sessions: make(), order: ids, activeId: 'main-1', layout: grouped(false) }).renderSessionList();
    expect(shape()).toEqual(['[deephive]', 'main-3', 'main-1', '[Ungrouped]', 'main-2']);
    expect(document.querySelector('[data-group-id="g-a"] .sl-group-count').textContent).toBe('2');
  });

  it('hides a collapsed group\'s rows but keeps its news on the header', () => {
    mountRenderer({ sessions: make(), order: ids, activeId: 'main-1', layout: grouped(true) }).renderSessionList();
    expect(shape()).toEqual(['[deephive]', '[Ungrouped]', 'main-2']);
    // main-3 inside it is unread, so the header carries the green dot.
    expect(document.querySelector('[data-group-id="g-a"] .sl-group-dot').hidden).toBe(false);
    expect(document.querySelector('[data-group-id="g-a"] .sl-group-toggle').getAttribute('aria-expanded')).toBe('false');
    // The summary still counts every session, hidden or not.
    expect(document.getElementById('sl-count').textContent).toMatch(/^3 sessions/);
  });

  it('gives Ungrouped no grip, rename or remove: it is where sessions go, not a group', () => {
    mountRenderer({ sessions: make(), order: ids, activeId: 'main-1', layout: grouped(false) }).renderSessionList();
    const rest = document.querySelector('[data-group-id=""]');
    expect(rest.querySelector('.sl-grip').classList.contains('sl-grip-none')).toBe(true);
    expect(rest.querySelectorAll('.sl-group-btn')).toHaveLength(0);
    expect(document.querySelectorAll('[data-group-id="g-a"] .sl-group-btn')).toHaveLength(2);
  });

  it('puts the grip BESIDE the row button, never inside it', () => {
    // Interactive content inside a <button> is invalid and the button takes its
    // events, so a grip in there could never start a drag.
    mountRenderer({ sessions: make(), order: ids, activeId: 'main-1' }).renderSessionList();
    for (const row of document.querySelectorAll('.sl-row')) {
      expect(row.querySelector('.sl-grip')).toBeNull();
      expect([...row.parentElement.children].some((c) => c.classList.contains('sl-grip'))).toBe(true);
    }
  });

  it('reuses every row and header across renders, regrouping included', () => {
    // The click guard from session-list-click.spec.js, extended to groups: a
    // node rebuilt under a press never receives the click. The layout object
    // is MUTATED between renders, because the renderer closes over that one
    // binding exactly as index.html's does; the second render is a genuine
    // regroup (a row changes group and order, a group collapses and reopens).
    const sessions = make();
    const layout = grouped(false);
    const r = mountRenderer({ sessions, order: ids, activeId: 'main-1', layout });
    r.renderSessionList();
    const key = (el) => el.dataset.sessionId ?? el.dataset.groupId;
    const before = new Map([...document.querySelectorAll('#sl-rows > *')].map((el) => [key(el), el]));

    layout.groups = [{ id: 'g-a', name: 'deephive', collapsed: false, sessions: ['main-2', 'main-1'] }];
    layout.ungrouped = ['main-3'];
    r.renderSessionList();
    expect(shape()).toEqual(['[deephive]', 'main-2', 'main-1', '[Ungrouped]', 'main-3']);
    for (const el of document.querySelectorAll('#sl-rows > *')) expect(before.get(key(el))).toBe(el);

    layout.groups = [{ ...layout.groups[0], collapsed: true }];
    r.renderSessionList();
    layout.groups = [{ ...layout.groups[0], collapsed: false }];
    r.renderSessionList();
    for (const el of document.querySelectorAll('#sl-rows > *')) expect(before.get(key(el))).toBe(el);
  });

  it('ends a drag whose row or header is removed, instead of letting the next move re-insert it', () => {
    const cancel = vi.fn();
    const drag = { el: null };   // truthy: a drag is in progress
    const layout = grouped(false);
    const r = mountRenderer({ sessions: make(), order: ids, activeId: 'main-1', layout, listDrag: drag, cancelListDrag: cancel });
    r.renderSessionList();

    drag.el = r.slRowEls.get('main-1').item;
    r.dropSessionRow('main-3');               // some other row: the drag goes on
    expect(cancel).not.toHaveBeenCalled();
    r.dropSessionRow('main-1');               // the dragged row
    expect(cancel).toHaveBeenCalledTimes(1);

    // A group removed on another device while its header is in the air.
    drag.el = r.slGroupEls.get('g-a').head;
    layout.groups = [];
    r.renderSessionList();
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('does not place anything while a drag is in progress', () => {
    // The drag moves these same nodes; a background session's output
    // re-rendering mid-drag must not yank one out from under the pointer.
    const r = mountRenderer({ sessions: make(), order: ids, activeId: 'main-1', listDrag: { kind: 'session' } });
    const rowsEl = document.getElementById('sl-rows');
    r.renderSessionList();
    expect(rowsEl.children).toHaveLength(0);
    // Text still lands: the summary is written either way.
    expect(document.getElementById('sl-count').textContent).toMatch(/^3 sessions/);
  });
});
