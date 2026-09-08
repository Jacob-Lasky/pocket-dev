import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PROVIDER, PROVIDERS, PROVIDER_IDS,
  isProvider, labelFor, commandFor, resolveCapabilities, statusTracked,
} from '../../providers.js';
import { SAFE_PROVIDER } from '../../safeId.js';

// The registry is the one place that answers "what do we run" and "what may we
// then believe about it" together. Splitting those answers is what shipped six
// process-wide booleans keyed off SHELL_CMD, so a second harness in one tab
// switched all six off for every tab.

describe('the provider id set', () => {
  it('is closed, and every member passes the cheap pre-check', () => {
    // Membership is the real gate. The regex is what keeps a hostile value out
    // of the object lookup and the log line in front of it, so it has to be
    // satisfied by every id we actually ship.
    expect(PROVIDER_IDS).toEqual(['claude', 'codex']);
    for (const id of PROVIDER_IDS) expect(SAFE_PROVIDER.test(id)).toBe(true);
  });

  it('defaults to claude, so the untouched case is the capable one', () => {
    // Every roster entry predates the field, DEFAULT_CMD has always been Claude,
    // and every capability below is Claude-only: a Codex default would make the
    // default tab the degraded one.
    expect(DEFAULT_PROVIDER).toBe('claude');
    expect(isProvider(DEFAULT_PROVIDER)).toBe(true);
  });

  it('rejects anything that is not a member, rather than defaulting through', () => {
    for (const bad of ['CLAUDE', 'claude ', 'cursor', '', '../claude', 'claude;rm -rf /', null, undefined, 42, {}]) {
      expect(isProvider(bad), `${String(bad)} must not be a provider`).toBe(false);
    }
  });

  it('refuses to build a command or a capability set for an unknown id', () => {
    // A provider id selects a command line, so a typo must be an error and not
    // a silently different harness.
    expect(() => commandFor('cursor')).toThrow(/unknown provider/);
    expect(() => resolveCapabilities('cursor')).toThrow(/unknown provider/);
  });

  it('names every provider for display, from the server side of the wire', () => {
    expect(labelFor('claude')).toBe('Claude');
    expect(labelFor('codex')).toBe('Codex');
  });
});

describe('the command line a provider selects', () => {
  it('runs Claude with the flags pocket-dev has always run it with', () => {
    expect(commandFor('claude')).toContain('claude --dangerously-skip-permissions');
    expect(commandFor('claude')).toContain('--model "opus[1m]"');
  });

  it('keeps Claude-only Remote Control syntax inside the Claude entry', () => {
    // The regression this guards is a Codex tab dying on an unrecognised flag:
    // Codex spells its equivalent `remote-control` / `pair`. Left process-wide,
    // RC_ARGS reached every command line.
    expect(commandFor('claude')).toContain('--rc --remote-control-session-name-prefix pocket-dev');
    expect(commandFor('codex')).not.toContain('--rc');
    expect(commandFor('codex')).not.toContain('remote-control');
  });

  it('drops Remote Control for every provider when the process says off', () => {
    expect(commandFor('claude', { remoteControl: false })).not.toContain('--rc');
    expect(commandFor('claude', { remoteControl: false })).toContain('claude --dangerously-skip-permissions');
  });

  it('runs codex, and does NOT pass a flag the interactive CLI rejects', () => {
    // Measured against codex-cli 0.151.0: --skip-git-repo-check exists on
    // `codex exec` ONLY, so passing it to the TUI stops the tab starting.
    // Passing -m would fight the model seeded into ~/.codex/config.toml.
    const cmd = commandFor('codex');
    expect(cmd).toMatch(/^codex\b/);
    expect(cmd).not.toContain('--skip-git-repo-check');
    expect(cmd).not.toMatch(/(^|\s)-m(\s|$)/);
    expect(cmd).not.toContain('--model');
    // The inner alt-screen is load-bearing for the terminal (invariant 1), and
    // this flag turns it off.
    expect(cmd).not.toContain('--no-alt-screen');
  });

  it('never asks a consultant for read-only and then hands it write access', () => {
    // CLAUDE.md's rule is about a `codex` WRAPPER ON PATH, because
    // --dangerously-bypass-approvals-and-sandbox OUTRANKS an explicit
    // `-s read-only`. This registry shadows nothing on PATH, so /second-opinion
    // still resolves /usr/local/bin/codex and keeps its sandbox. What must stay
    // true is that the bypass is confined to the interactive session command and
    // never paired with a sandbox flag that it would silently overrule.
    expect(commandFor('codex')).not.toContain('-s read-only');
    expect(commandFor('codex')).not.toContain('--sandbox');
  });
});

describe('capabilities: what pocket-dev is allowed to believe', () => {
  it('gives Claude all six, because Claude is what writes the transcript', () => {
    expect(resolveCapabilities('claude')).toEqual({
      resumeConversation: true,
      transcriptStatus:   true,
      transcriptTitle:    true,
      unreadAxis:         'turns',
      archiveClose:       true,
      autoName:           true,
    });
  });

  it('gives Codex none, and gates autoName in particular', () => {
    const caps = resolveCapabilities('codex');
    expect(caps.resumeConversation).toBe(false);
    expect(caps.transcriptStatus).toBe(false);
    expect(caps.transcriptTitle).toBe(false);
    expect(caps.archiveClose).toBe(false);
    // The safety one. maybeAutoName writes `/rename ...` into the pty, so this
    // being on means pocket-dev types a Claude slash command into Codex's TUI.
    // It is inert today only because meta.title is null for a session with no
    // transcript, which is protection by accident of the data path.
    expect(caps.autoName).toBe(false);
  });

  it('declares autoName off in the ENTRY, not just off by consequence', () => {
    // Asserted against the registry as well as the resolved set, because the
    // resolved one cannot see this: resolveCapabilities gates autoName on there
    // being a transcript, and Codex has none, so a registry entry that said
    // `autoName: true` would resolve to false anyway and the safety gate would
    // read as present while being absent. That is the same accidental
    // protection this gate exists to replace, one layer up. The DECLARATION is
    // what a future provider with a transcript would inherit.
    expect(PROVIDERS.get('codex').capabilities.autoName).toBe(false);
    expect(PROVIDERS.get('claude').capabilities.autoName).toBe(true);
  });

  it('models the unread axis as an enum, never as a boolean', () => {
    // 'none' and 'bytes' both mean "no transcript" and only one of them may
    // light the attention badge. Collapsed to a boolean, a thinking Codex tab
    // counts its own repaint frames and reports "Waiting on you".
    expect(resolveCapabilities('claude').unreadAxis).toBe('turns');
    expect(resolveCapabilities('codex').unreadAxis).toBe('none');
    for (const id of PROVIDER_IDS) {
      expect(['turns', 'bytes', 'none']).toContain(resolveCapabilities(id).unreadAxis);
    }
  });

  it('collapses everything when SHELL_CMD replaces the command line', () => {
    // Today's behaviour restated per provider: nothing may be believed about a
    // program pocket-dev did not choose. The axis falls back to bytes, which is
    // what a plain shell under the e2e fixture has always had.
    for (const id of PROVIDER_IDS) {
      const caps = resolveCapabilities(id, { shellOverride: true });
      expect(caps.resumeConversation).toBe(false);
      expect(caps.transcriptStatus).toBe(false);
      expect(caps.transcriptTitle).toBe(false);
      expect(caps.archiveClose).toBe(false);
      expect(caps.autoName).toBe(false);
      expect(caps.unreadAxis).toBe('bytes');
    }
  });

  it('turns the whole conversation layer off for PD_RESUME=0, axis included', () => {
    const caps = resolveCapabilities('claude', { resume: false });
    expect(caps.resumeConversation).toBe(false);
    expect(caps.transcriptStatus).toBe(false);
    expect(caps.transcriptTitle).toBe(false);
    expect(caps.archiveClose).toBe(false);
    // No transcript means no title means nothing to rename to, so the rename
    // cannot fire; saying so is better than leaving it nominally on and inert.
    expect(caps.autoName).toBe(false);
    // Raw output is the only evidence left, exactly as for a plain shell.
    expect(caps.unreadAxis).toBe('bytes');
  });

  it('keeps a no-axis provider at none under every override', () => {
    // Replacing a provider's command line does not give it a transcript, and it
    // does not make its frames worth counting either.
    expect(resolveCapabilities('codex', { resume: false }).unreadAxis).toBe('none');
  });

  it('honours the two per-feature knobs without touching the rest', () => {
    const noName = resolveCapabilities('claude', { autoName: false });
    expect(noName.autoName).toBe(false);
    expect(noName.resumeConversation).toBe(true);
    expect(noName.archiveClose).toBe(true);

    const noArchive = resolveCapabilities('claude', { archiveClose: false });
    expect(noArchive.archiveClose).toBe(false);
    expect(noArchive.autoName).toBe(true);

    const noRc = resolveCapabilities('claude', { remoteControl: false });
    expect(noRc.autoName).toBe(false);
    expect(noRc.resumeConversation).toBe(true);
  });

  it('hands out a frozen set, so one session cannot edit another one answer', () => {
    const caps = resolveCapabilities('claude');
    expect(Object.isFrozen(caps)).toBe(true);
  });
});

describe('statusTracked: whether the four attention states mean anything', () => {
  it('is true for Claude, and stays true for a plain shell', () => {
    // A shell has no conversation and still says something real with its line
    // output, so its row keeps the unread axis and stays honest.
    expect(statusTracked(resolveCapabilities('claude'))).toBe(true);
    expect(statusTracked(resolveCapabilities('claude', { shellOverride: true }))).toBe(true);
    expect(statusTracked(resolveCapabilities('claude', { resume: false }))).toBe(true);
  });

  it('is false for a provider with no transcript AND no meaningful output', () => {
    // This is the flag the fifth row state hangs off. Without it a Codex tab
    // mid-thought reports "Waiting on you", the strongest signal the UI has,
    // fired by a session doing the opposite of needing the user.
    expect(statusTracked(resolveCapabilities('codex'))).toBe(false);
  });
});
