const fs   = require('fs');
const path = require('path');
const { SAFE_ID } = require('./safeId');

// How the session list is arranged: named groups, their order, the order of
// sessions inside each, and the order of the sessions in no group at all.
//
// It lives on the SERVER for the same reason unread does: an arrangement made
// on the phone must be the arrangement on the desktop. It is display order
// only. Nothing here touches status, unread, restore or the roster, and a
// missing or broken layout file degrades to the flat list pocket-dev had
// before groups existed. Every failure is non-fatal, same contract as
// sessionStore.js.
//
// The layout is UNTRUSTED on both of its ways in: a PUT body from any browser,
// and a file read back off disk. normalizeLayout() is the single gate for
// both, so the two cannot drift. Ids are SAFE_ID-checked, because session ids
// end up in tmux command lines elsewhere and group ids end up in DOM data
// attributes; names are plain text, capped, and the client only ever renders
// them with textContent.

const LAYOUT_VERSION  = 1;
const MAX_GROUPS      = 50;
const MAX_NAME_LENGTH = 40;
// A session name is longer than a group name because it replaces a
// conversation title, and those run to a short sentence.
const MAX_SESSION_NAME_LENGTH = 80;

// Strip control characters and collapse whitespace, so a name cannot carry a
// newline into a one-line header or an escape into a log line.
function cleanName(name, max = MAX_NAME_LENGTH) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// `liveIds` is the server's current session ids in creation order. The result
// names each live id exactly once: ids that are gone (killed, archived, lost
// in a recreate) are dropped, and live ids the layout does not mention yet are
// appended to the END of the ungrouped section in creation order. That is the
// order the list had before groups existed, so someone who never groups
// anything sees no change at all.
function normalizeLayout(raw, liveIds) {
  const live    = new Set(liveIds);
  const placed  = new Set();
  const take = (ids) => {
    const out = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id !== 'string' || !SAFE_ID.test(id) || !live.has(id) || placed.has(id)) continue;
      placed.add(id);
      out.push(id);
    }
    return out;
  };

  const groups   = [];
  const groupIds = new Set();
  for (const g of Array.isArray(raw?.groups) ? raw.groups : []) {
    if (groups.length >= MAX_GROUPS) break;
    const id = g && g.id;
    if (typeof id !== 'string' || !SAFE_ID.test(id) || groupIds.has(id)) continue;
    groupIds.add(id);
    groups.push({
      id,
      name:      cleanName(g.name) || 'Group',
      collapsed: g.collapsed === true,
      sessions:  take(g.sessions),
    });
  }
  const ungrouped = take(raw?.ungrouped);
  const unplaced  = liveIds.filter((id) => !placed.has(id));

  // Names a person gave sessions, by session id. Same rules as everything
  // else here: live SAFE_ID keys only, cleaned text, and an empty name is no
  // name, which is how clearing one returns the session to its automatic
  // title. Pruned with the ids, so a reused id never inherits a dead tab's
  // name. `__proto__` passes SAFE_ID (underscores are allowed) and assigning
  // it on a plain object would set the prototype instead of a key, so it is
  // refused by name even though no live session can carry it today.
  const names = {};
  const rawNames = raw?.names;
  if (rawNames && typeof rawNames === 'object' && !Array.isArray(rawNames)) {
    for (const id of Object.keys(rawNames)) {
      if (!SAFE_ID.test(id) || !live.has(id) || id === '__proto__') continue;
      const name = cleanName(rawNames[id], MAX_SESSION_NAME_LENGTH);
      if (name) names[id] = name;
    }
  }
  return { version: LAYOUT_VERSION, groups, ungrouped: [...ungrouped, ...unplaced], names };
}

// Same equality the client cares about: would rendering these two differ.
function sameLayout(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Holds the layout for the life of the process and touches no disk: the
// default for createApp so tests and other embedders get working grouping with
// no filesystem side effects. startServer() wires the file-backed store.
function createMemoryLayoutStore() {
  let saved = null;
  return {
    file: null,
    load: () => (saved ? JSON.parse(saved) : null),
    save: (layout) => { saved = JSON.stringify(layout); return true; },
  };
}

function createLayoutStore({ dir, logger = console } = {}) {
  const file    = path.join(dir, 'layout.json');
  const tmpFile = `${file}.tmp`;
  let disabled  = false;

  function disable(err, action) {
    if (disabled) return;
    disabled = true;
    logger.warn(`layout store disabled (${action} failed under ${dir}: ${err.message}). Session groups will not persist.`);
  }

  // Returns the raw parsed file, or null. Validation is normalizeLayout's job,
  // because it needs the live ids and the store does not have them.
  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') disable(err, 'read');
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch {
      logger.warn(`layout store: ${file} is not valid JSON, starting ungrouped`);
      return null;
    }
  }

  // Returns whether the layout reached the disk, so a PUT can say it did not
  // rather than answering 200 for a group that vanishes on the next read.
  function save(layout) {
    if (disabled) return false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Write-then-rename so a crash mid-write keeps the previous layout.
      fs.writeFileSync(tmpFile, JSON.stringify(layout));
      fs.renameSync(tmpFile, file);
      return true;
    } catch (err) {
      disable(err, 'write');
      return false;
    }
  }

  return { file, load, save };
}

// The single owner of the layout at runtime. `liveIds` is a function because
// the session set changes underneath it.
//
// Every read normalises against the live sessions and WRITES BACK when that
// dropped anything. That write-back is what makes id reuse safe: session ids
// restart from the highest restored one after a container restart, so a killed
// `main-5` can be handed out again, and without pruning the new tab would
// silently inherit the dead one's group. prune() runs once at boot, after
// restore and before the first new id can be minted, which closes the window.
//
// `rev` counts saved edits and is stored in the file, so it keeps increasing
// across restarts. It is what lets an edit be refused instead of clobbering a
// newer one: a PUT names the revision it was made from (`baseRev`), and if
// another device saved in between, the PUT gets a conflict and the current
// layout rather than silently restoring the state it started from. It also
// lets a browser tell an old GET answer from a new one. Pruning does not bump
// it: a prune changes no arrangement anyone made.
function createLayoutApi({ store = createMemoryLayoutStore(), liveIds }) {
  function get() {
    const raw  = store.load();
    const rev  = Number.isSafeInteger(raw?.rev) && raw.rev >= 0 ? raw.rev : 0;
    const next = { ...normalizeLayout(raw, liveIds()), rev };
    if (raw && !sameLayout(raw, next)) store.save(next);
    return next;
  }

  // -> { status: 'saved' | 'conflict' | 'unsaved', layout }. On anything but
  // 'saved', `layout` is what the server actually holds.
  function put(raw, baseRev) {
    const current = get();
    if (baseRev !== undefined && baseRev !== current.rev) return { status: 'conflict', layout: current };
    const next = { ...normalizeLayout(raw, liveIds()), rev: current.rev + 1 };
    return store.save(next) ? { status: 'saved', layout: next } : { status: 'unsaved', layout: current };
  }

  return { get, put, prune: get };
}

module.exports = {
  LAYOUT_VERSION, MAX_GROUPS, MAX_NAME_LENGTH, MAX_SESSION_NAME_LENGTH,
  cleanName, normalizeLayout, createLayoutStore, createMemoryLayoutStore, createLayoutApi,
};
