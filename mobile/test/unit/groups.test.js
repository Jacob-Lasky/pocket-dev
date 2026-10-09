import { describe, it, expect } from 'vitest';
import {
  UNGROUPED, emptyLayout, arrange, displayOrder, addGroup, renameGroup, toggleGroup,
  deleteGroup, moveSession, moveGroup, newGroupId, MAX_GROUPS, MAX_NAME_LENGTH,
  MAX_SESSION_NAME_LENGTH, renameSession, sessionName, cleanSessionName,
} from '../../public/js/groups.js';
import * as server from '../../sessionLayout.js';

const { normalizeLayout } = server;

const IDS = ['main-1', 'main-2', 'main-3', 'main-4'];

const sample = () => arrange({
  version: 1,
  groups: [
    { id: 'g-a', name: 'deephive', collapsed: false, sessions: ['main-2', 'main-1'] },
    { id: 'g-b', name: 'tower', collapsed: true, sessions: ['main-4'] },
  ],
  ungrouped: [],
}, IDS);

describe('arrange', () => {
  it('is the flat creation-order list when nothing is grouped', () => {
    expect(arrange(emptyLayout(), IDS)).toEqual({ version: 1, groups: [], ungrouped: IDS, names: {} });
  });

  it('appends a session the layout has not seen to the end of Ungrouped', () => {
    expect(sample().ungrouped).toEqual(['main-3']);
  });

  it('drops sessions that are gone', () => {
    expect(arrange(sample(), ['main-1', 'main-3']).groups.map((g) => g.sessions)).toEqual([['main-1'], []]);
  });

  it('agrees with the server about every layout it produces', () => {
    // The client and the server each fold live ids into a layout. They cannot
    // share code across the wire, so this is what keeps them from drifting.
    // One case carries names, live and dead: an arrange() that dropped names
    // would erase every saved one on the next drag, and only a named case can
    // see that.
    const named = { ...sample(), names: { 'main-2': 'Billing', 'main-9': 'gone' } };
    for (const raw of [emptyLayout(), sample(), named, { version: 1, groups: [], ungrouped: ['main-4', 'main-9'], names: {} }]) {
      expect(arrange(raw, IDS)).toEqual(normalizeLayout(raw, IDS));
    }
  });
});

describe('displayOrder', () => {
  it('reads groups top to bottom, collapsed ones included, then Ungrouped', () => {
    expect(displayOrder(sample())).toEqual(['main-2', 'main-1', 'main-4', 'main-3']);
  });
});

describe('edits', () => {
  // Every edit must produce something the server accepts unchanged, or the
  // optimistic render and the saved answer would disagree and the row would
  // jump when the PUT came back.
  const accepted = (layout) => expect(normalizeLayout(layout, IDS)).toEqual(layout);

  it('moves a session within its group', () => {
    const out = moveSession(sample(), 'main-1', 'g-a', 0);
    expect(out.groups[0].sessions).toEqual(['main-1', 'main-2']);
    accepted(out);
  });

  it('moves a session into another group, and out to Ungrouped', () => {
    const into = moveSession(sample(), 'main-3', 'g-b', 1);
    expect(into.groups[1].sessions).toEqual(['main-4', 'main-3']);
    expect(into.ungrouped).toEqual([]);
    accepted(into);
    const out = moveSession(into, 'main-2', UNGROUPED, 0);
    expect(out.groups[0].sessions).toEqual(['main-1']);
    expect(out.ungrouped).toEqual(['main-2']);
    accepted(out);
  });

  it('opens a collapsed group when a session moves into it, so the row does not vanish', () => {
    const out = moveSession(sample(), 'main-3', 'g-b', 0);
    expect(out.groups[1]).toMatchObject({ collapsed: false, sessions: ['main-3', 'main-4'] });
    // Moving one OUT of a collapsed group leaves it collapsed.
    expect(moveSession(sample(), 'main-4', UNGROUPED, 0).groups[1].collapsed).toBe(true);
  });

  it('clamps an index past the end', () => {
    expect(moveSession(sample(), 'main-3', 'g-a', 99).groups[0].sessions).toEqual(['main-2', 'main-1', 'main-3']);
  });

  it('leaves the layout alone for a group that does not exist', () => {
    const before = sample();
    expect(moveSession(before, 'main-3', 'g-gone', 0)).toBe(before);
    expect(moveGroup(before, 'g-gone', 0)).toBe(before);
    expect(deleteGroup(before, 'g-gone')).toBe(before);
  });

  it('reorders groups', () => {
    const out = moveGroup(sample(), 'g-b', 0);
    expect(out.groups.map((g) => g.id)).toEqual(['g-b', 'g-a']);
    accepted(out);
  });

  it('adds a new group at the top, empty and open', () => {
    const out = addGroup(sample(), 'g-new', 'New group');
    expect(out.groups[0]).toEqual({ id: 'g-new', name: 'New group', collapsed: false, sessions: [] });
    accepted(out);
  });

  it('renames and toggles', () => {
    const out = toggleGroup(renameGroup(sample(), 'g-b', 'homelab'), 'g-b');
    expect(out.groups[1]).toMatchObject({ name: 'homelab', collapsed: false });
    accepted(out);
  });

  it('removing a group keeps every session, moving them to the top of Ungrouped', () => {
    const out = deleteGroup(sample(), 'g-a');
    expect(out.groups.map((g) => g.id)).toEqual(['g-b']);
    expect(out.ungrouped).toEqual(['main-2', 'main-1', 'main-3']);
    accepted(out);
  });

  it('names a session, and an empty name clears it back to automatic', () => {
    const named = renameSession(sample(), 'main-4', '  Codex review ');
    expect(sessionName(named, 'main-4')).toBe('Codex review');
    accepted(named);
    const cleared = renameSession(named, 'main-4', '   ');
    expect(sessionName(cleared, 'main-4')).toBeUndefined();
    accepted(cleared);
  });

  it('cleans a name exactly as the server will, so the optimistic render never changes on save', () => {
    const raw = `  a\tb\n${'x'.repeat(200)}`;
    const out = renameSession(sample(), 'main-1', raw);
    expect(sessionName(out, 'main-1')).toBe(cleanSessionName(raw));
    expect(sessionName(out, 'main-1')).toHaveLength(MAX_SESSION_NAME_LENGTH);
    accepted(out);
  });

  it('drops the name of a session that is gone, as the server does', () => {
    const named = renameSession(sample(), 'main-4', 'x');
    expect(arrange(named, ['main-1']).names).toEqual({});
    expect(arrange(named, ['main-1'])).toEqual(normalizeLayout(named, ['main-1']));
  });

  it('never mutates the layout it was given, which Undo depends on', () => {
    const before = sample();
    const frozen = JSON.stringify(before);
    moveSession(before, 'main-3', 'g-a', 0);
    moveGroup(before, 'g-b', 0);
    deleteGroup(before, 'g-a');
    toggleGroup(before, 'g-a');
    renameSession(before, 'main-1', 'x');
    expect(JSON.stringify(before)).toBe(frozen);
  });
});

describe('limits shared with the server', () => {
  it('match sessionLayout.js, so the browser never offers what the server drops', () => {
    expect(MAX_GROUPS).toBe(server.MAX_GROUPS);
    expect(MAX_NAME_LENGTH).toBe(server.MAX_NAME_LENGTH);
    expect(MAX_SESSION_NAME_LENGTH).toBe(server.MAX_SESSION_NAME_LENGTH);
  });
});

describe('newGroupId', () => {
  it('is a SAFE_ID the server keeps, padded to eight hex digits', () => {
    expect(newGroupId(() => 0xabc)).toBe('g-00000abc');
    expect(newGroupId()).toMatch(/^g-[0-9a-f]{8}$/);
  });
});
