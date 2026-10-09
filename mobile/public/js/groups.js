// Session list grouping: the pure half. Every function takes a layout and
// returns a NEW one, so index.html can keep the previous layout for Undo and a
// unit test can check each move without a DOM.
//
// A layout is { version, groups: [{ id, name, collapsed, sessions }], ungrouped }
// exactly as GET /layout serves it. The SERVER (sessionLayout.js) owns
// validation; this module only ever produces layouts that pass it unchanged,
// which test/unit/groups.test.js checks by round-tripping through the server's
// normalizeLayout. The two cannot import each other across the wire, same
// reason as attention.js and the status vocabulary.

export const UNGROUPED = '';

// Mirrors of sessionLayout.js's limits, so the browser never offers what the
// server would silently drop. test/unit/groups.test.js ties the two together.
export const MAX_GROUPS      = 50;
export const MAX_NAME_LENGTH = 40;

export function emptyLayout() {
  return { version: 1, groups: [], ungrouped: [] };
}

// Fold the live session ids into a layout for display. A session the layout
// does not mention yet (created since the last fetch, or on another device)
// goes to the END of Ungrouped in creation order, which is where the server
// puts it too, and is the order the list had before groups existed. Ids the
// layout names that no longer exist are dropped.
export function arrange(layout, ids) {
  const live   = new Set(ids);
  const placed = new Set();
  const keep = (list) => list.filter((id) => live.has(id) && !placed.has(id) && placed.add(id));
  const groups = layout.groups.map((g) => ({ ...g, sessions: keep(g.sessions) }));
  const ungrouped = keep(layout.ungrouped);
  const unplaced = ids.filter((id) => !placed.has(id));
  return { version: 1, groups, ungrouped: [...ungrouped, ...unplaced] };
}

// The order a person reads the list in, collapsed groups included: what the
// `n/m` counter and Ctrl-B cycling follow, so the keyboard and the list agree.
export function displayOrder(view) {
  return [...view.groups.flatMap((g) => g.sessions), ...view.ungrouped];
}

const withoutSession = (layout, sid) => ({
  ...layout,
  groups: layout.groups.map((g) => ({ ...g, sessions: g.sessions.filter((id) => id !== sid) })),
  ungrouped: layout.ungrouped.filter((id) => id !== sid),
});

const insertAt = (list, index, item) => {
  const i = Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, i), item, ...list.slice(i)];
};

// New groups go to the TOP: that is where the person who just pressed the
// button is looking, and where the rename field they are about to type into is.
export function addGroup(layout, id, name) {
  return { ...layout, groups: [{ id, name, collapsed: false, sessions: [] }, ...layout.groups] };
}

export function renameGroup(layout, gid, name) {
  return { ...layout, groups: layout.groups.map((g) => (g.id === gid ? { ...g, name } : g)) };
}

export function toggleGroup(layout, gid) {
  return { ...layout, groups: layout.groups.map((g) => (g.id === gid ? { ...g, collapsed: !g.collapsed } : g)) };
}

// Deleting a group never touches a session: its members move to the top of
// Ungrouped, in their order.
export function deleteGroup(layout, gid) {
  const gone = layout.groups.find((g) => g.id === gid);
  if (!gone) return layout;
  return {
    ...layout,
    groups: layout.groups.filter((g) => g.id !== gid),
    ungrouped: [...gone.sessions, ...layout.ungrouped],
  };
}

// `gid` UNGROUPED means out of every group. `index` is the position among that
// group's sessions AFTER the moved one has been taken out, which is what a
// drop position in the DOM gives you.
//
// Moving a session INTO a collapsed group opens it. Otherwise the row you just
// moved disappears on release, and a keyboard user loses focus with it, since
// the grip they were holding is no longer in the document.
export function moveSession(layout, sid, gid, index) {
  const base = withoutSession(layout, sid);
  if (gid === UNGROUPED) return { ...base, ungrouped: insertAt(base.ungrouped, index, sid) };
  if (!base.groups.some((g) => g.id === gid)) return layout;
  return {
    ...base,
    groups: base.groups.map((g) => (g.id === gid
      ? { ...g, collapsed: false, sessions: insertAt(g.sessions, index, sid) }
      : g)),
  };
}

// `index` is the position among the groups after the moved one is taken out.
export function moveGroup(layout, gid, index) {
  const moving = layout.groups.find((g) => g.id === gid);
  if (!moving) return layout;
  return { ...layout, groups: insertAt(layout.groups.filter((g) => g.id !== gid), index, moving) };
}

// Same charset the server's SAFE_ID accepts, and the same `g-` prefix its
// Autogroup uses, so a group made here and one made there look alike.
export function newGroupId(word = () => crypto.getRandomValues(new Uint32Array(1))[0]) {
  return `g-${word().toString(16).padStart(8, '0')}`;
}
