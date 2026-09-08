// Which AI harness a session runs, and what pocket-dev can therefore know about it.
//
// WHY A REGISTRY AND NOT A BOOLEAN: a provider id selects a COMMAND LINE, and
// every piece of session machinery downstream of that command line is
// Claude-shaped. Conversation resume, transcript-derived status, the
// conversation title, the unread axis, the archive-close and the Remote Control
// auto-rename are all reads of a transcript only Claude writes. Before this
// module those six lived as process-wide booleans keyed off SHELL_CMD, so
// pointing one tab at a second harness silently switched all six off for every
// tab, or (worse, see autoName) left one of them ON and aimed at a TUI that
// does not understand it.
//
// So the registry is the one place that answers both questions together: what
// do we run, and what may we then believe about it. A provider added here
// without stating its capabilities gets none of them, which is the safe way
// round.
//
// THIS MODULE IS PURE. It reads no environment. Every process-wide override
// (SHELL_CMD, PD_RESUME, PD_REMOTE_CONTROL, PD_AUTO_NAME, PD_ARCHIVE_CLOSE)
// stays in server.js beside the comment that explains it, and arrives here as
// an argument to resolveCapabilities(). sessionStore.js imports the id set from
// here to validate a roster it read off disk, and it must not acquire a
// dependency on the server's environment to do that.

// The default, and the reason is not "Claude is nicer": every existing roster
// entry predates this field, the default command has always been Claude, and
// every capability below is Claude-only. A Codex default would make the
// untouched case the degraded one.
const DEFAULT_PROVIDER = 'claude';

// THE CAPABILITY SET OF THE PROCESS-WIDE OVERRIDE, which is what a session gets
// when SHELL_CMD has replaced its command line. It is named and exported so the
// 'bytes' axis has a findable producer rather than being a value a cold reader
// has to reverse-engineer from a collapse rule.
//
// DELIBERATELY NOT A REGISTRY ENTRY, and that is not a shortcut. A registry
// entry is a SELECTABLE provider: its id passes isProvider, so POST /sessions
// would accept it and start a session whose command line exists only if
// SHELL_CMD happens to be set, and the roster could persist a tab naming it
// that has nothing to run after a restart. SHELL_CMD is an override that
// OUTRANKS the provider, not one of the things being chosen between, and the
// contract for this work says so explicitly. So it lives here, off to the side,
// where it can be named and tested without becoming choosable.
//
// unreadAxis is 'bytes' and NOT off: the override's output is the only evidence
// such a session has, and a plain shell's line output is real news. Collapsing
// it to 'none' would turn every e2e fixture's row opaque and throw away the one
// honest signal those sessions have.
const SHELL_OVERRIDE_CAPABILITIES = Object.freeze({
  resumeConversation: false,
  transcriptStatus:   false,
  transcriptTitle:    false,
  unreadAxis:         'bytes',
  archiveClose:       false,
  autoName:           false,
});

const PROVIDERS = new Map([
  ['claude', {
    label:   'Claude',
    command: 'claude --dangerously-skip-permissions --model "opus[1m]"',
    // CLAUDE-ONLY FLAG SYNTAX, which is why it lives in this entry and not in a
    // process-wide constant any more. Codex spells its equivalent
    // `codex remote-control` / `pair`, so a Codex session handed these would die
    // on an unrecognised flag before painting a single frame.
    //
    // Keep it in FRONT of another flag when it is appended: --rc takes an
    // OPTIONAL session name, so at the end of the string it swallows whatever
    // pd-claude-session appends. And DO NOT write `-rc` with one dash, which
    // Commander splits into `-r c`, i.e. `--resume c`.
    remoteControlArgs: ' --rc --remote-control-session-name-prefix pocket-dev',
    capabilities: {
      resumeConversation: true,
      transcriptStatus:   true,
      transcriptTitle:    true,
      unreadAxis:         'turns',
      archiveClose:       true,
      autoName:           true,
    },
  }],

  ['codex', {
    label: 'Codex',
    // THE BYPASS FLAG IS DELIBERATE AND IS NOT THE WRAPPER THE REPO FORBIDS.
    // CLAUDE.md's rule is that no `codex` WRAPPER may exist on PATH carrying
    // --dangerously-bypass-approvals-and-sandbox, because that flag outranks an
    // explicit `-s read-only` and would hand every /second-opinion consult write
    // access to the tree it is reviewing while the consult still asked for
    // read-only. This is a command line pocket-dev builds for one interactive
    // session; it shadows nothing on PATH, so `codex exec -s read-only` from
    // inside a session resolves to /usr/local/bin/codex exactly as before and
    // the consult keeps its sandbox. The constraint that comment protects is
    // therefore satisfied, which is the only reason this is allowed to differ.
    //
    // What it buys: parity with the Claude tab, which already runs
    // --dangerously-skip-permissions. A tab that stops for an approval on every
    // command is unusable from a phone, which is the entire product. The
    // container is the sandbox here, and it is a real one: this image runs
    // seccomp=unconfined with the docker socket mounted, so the flag's own
    // "intended solely for externally sandboxed environments" is met.
    //
    // NO -m, and the reason is NOT that something else pins the model. Nothing
    // does: PR #55 removed the ~/.codex/config.toml seed, on the argument that
    // interactive codex is rare in this container and /second-opinion pins `-m`
    // itself. This feature is what makes interactive codex a first-class case
    // here, so that premise no longer holds and is worth saying out loud.
    //
    // -m IS PINNED, and the comment this replaces argued the opposite. That
    // argument was that codex has no moving `latest` alias, so inheriting the
    // account default TRACKS latest while a pin freezes. The premise is true
    // and the conclusion was still wrong, because the default is not the thing
    // the owner asked for. Measured 2026-09-08: the account default is
    // `gpt-6-astra`, the standing preference is the newest Sol, and
    // `gpt-6-sol` DOES NOT EXIST -- it returns the same 400 as a deliberately
    // bogus model id, while `gpt-6-astra` returns "requires a newer version of
    // Codex". So the newest Sol is 5.6, inheriting gives you a different model
    // family, and there is no alias that means "newest Sol".
    //
    // DO NOT drop this flag back to "track the default" without re-reading
    // ~/.claude/skills/second-opinion/SKILL.md <model_choice>, which carries
    // the must-fail-control recipe for checking whether a newer Sol has
    // shipped. The banner ECHOES any -m string without validating it, so
    // `-m sol` and `-m gpt-sol` both print a plausible banner and neither is a
    // model; a banner is not proof.
    //
    // It stays visible where a downgrade would be noticed: the interactive
    // banner names the model, in the one place a tab's user is already looking.
    //
    // NO --skip-git-repo-check: measured against codex-cli 0.151.0, that flag
    // exists on `codex exec` ONLY and is not accepted by the interactive TUI, so
    // adding it here would stop the tab starting at all. The interactive trust
    // gate is answerable in the TUI, which is the right place for a tab a human
    // is sitting in.
    command: 'codex --dangerously-bypass-approvals-and-sandbox -m gpt-5.6-sol',
    remoteControlArgs: null,
    // EVERY CAPABILITY OFF, and that is a statement about the data, not a
    // preference. All six are reads of Claude's `<uuid>.jsonl`, which Codex does
    // not write. Deliberately NOT filled in from Codex's own rollout files:
    // `codex migrate-rollouts` exists to move "legacy local sessions to
    // paginated thread history", so that format already carries a deprecation.
    // If a real status layer is ever wanted it comes from ACP as a second
    // session kind; see issue #53 and the /acp skill.
    capabilities: {
      resumeConversation: false,
      transcriptStatus:   false,
      transcriptTitle:    false,
      // PROVISIONAL VALUE, SETTLED ENUM. That a Codex tab tracks no unread is
      // under review and may become 'bytes'; that the axis is an ENUM of
      // 'turns' | 'bytes' | 'none' is not. A boolean here is how the
      // false-summons bug survives: 'none' and 'bytes' both read as "no
      // transcript", and only one of them may light the attention badge.
      unreadAxis:         'none',
      archiveClose:       false,
      // THIS ONE IS A SAFETY GATE, NOT A FEATURE FLAG. maybeAutoName writes
      // `/rename <title>\r` INTO THE PTY, so left on for a Codex tab pocket-dev
      // would be typing a Claude slash command into Codex's TUI. It is inert
      // today only because meta.title is always null for a session with no
      // transcript, so it returns at its first condition. That is protection by
      // accident of the data path, not by a gate. This is the gate.
      autoName:           false,
    },
  }],
]);

const PROVIDER_IDS = [...PROVIDERS.keys()];

function isProvider(id) {
  return typeof id === 'string' && PROVIDERS.has(id);
}

function labelFor(id) {
  const entry = PROVIDERS.get(id);
  return entry ? entry.label : id;
}

// The command line for a provider. `remoteControl` is process-wide (one account
// bridges every tab or none does), so it arrives as an option rather than
// living in the entry; which FLAGS express it is per-provider, which is the
// whole point of remoteControlArgs.
function commandFor(id, { remoteControl = true } = {}) {
  const entry = PROVIDERS.get(id);
  if (!entry) throw new Error(`unknown provider: ${id}`);
  const rc = remoteControl && entry.remoteControlArgs ? entry.remoteControlArgs : '';
  return `${entry.command}${rc}`;
}

// What we are allowed to believe about a session of this provider, once the
// process-wide overrides have had their say.
//
// TWO THINGS OUTRANK THE PROVIDER, and both are today's behaviour restated
// rather than anything new:
//
//   shellOverride  SHELL_CMD is set, so the command line is not the provider's
//                  at all (the e2e fixture runs `cat`). Nothing may be believed
//                  about a program we did not choose, so every capability goes
//                  off. It stays PROCESS-WIDE on purpose: two per-session
//                  command sources is how you get a tab whose command line
//                  nobody can predict.
//   resume         PD_RESUME=0 turns the conversation machinery off outright.
//                  The command is still the provider's, so it still runs its
//                  own harness, just without the launcher and the transcript.
//
// The unread axis is the one that does NOT simply go off, and getting that
// wrong is the whole defect this enum exists to prevent:
//
//   'turns'  the transcript decides, one count per finished turn.
//   'bytes'  there is no transcript, so raw output is the only evidence that
//            anything happened. Correct for a plain shell and for today's
//            SHELL_CMD sessions, whose line output is real news.
//   'none'   there is no transcript AND output is not evidence of anything a
//            human needs. A TUI coder paints while it thinks, so counting its
//            frames reports a session doing the opposite of needing you.
//
// A provider whose degraded axis is 'none' keeps it under every override:
// replacing its command line does not give it a transcript.
function resolveCapabilities(id, {
  shellOverride = false,
  resume        = true,
  remoteControl = true,
  autoName      = true,
  archiveClose  = true,
} = {}) {
  const entry = PROVIDERS.get(id);
  if (!entry) throw new Error(`unknown provider: ${id}`);
  if (shellOverride) return SHELL_OVERRIDE_CAPABILITIES;

  const caps = entry.capabilities;
  // One gate, because it is one question: is there a transcript to read? The
  // launcher is what binds a session to a conversation, so resume off means no
  // uuid, which means no status, no title and no archive notice either.
  const transcript = caps.resumeConversation && resume;

  return Object.freeze({
    resumeConversation: transcript,
    transcriptStatus:   caps.transcriptStatus && transcript,
    transcriptTitle:    caps.transcriptTitle  && transcript,
    unreadAxis:         transcript ? caps.unreadAxis
                      : caps.unreadAxis === 'none' ? 'none'
                      : 'bytes',
    archiveClose:       caps.archiveClose && transcript && archiveClose,
    autoName:           caps.autoName && transcript && remoteControl && autoName,
  });
}

// Does this session have ANY axis on which the four attention states mean
// something? The wire field is called statusTracked because that is the
// question the row is asking, but the answer is broader than the transcript: a
// plain shell has no conversation and still says something real with its
// output, so it keeps the unread axis and its row stays honest. A provider with
// neither has nothing, and 'asking' / 'working' / 'waiting' / 'read' are all
// claims about a conversation nobody can read.
//
// This is what the browser turns into the fifth row state. It is sent from the
// server rather than derived client-side from the provider id, because a
// capability table duplicated across a JSON boundary is exactly the drift
// test/unit/statusContract.test.js exists to stop.
function statusTracked(caps) {
  return caps.transcriptStatus || caps.unreadAxis === 'bytes';
}

module.exports = {
  DEFAULT_PROVIDER,
  SHELL_OVERRIDE_CAPABILITIES,
  PROVIDERS,
  PROVIDER_IDS,
  isProvider,
  labelFor,
  commandFor,
  resolveCapabilities,
  statusTracked,
};
