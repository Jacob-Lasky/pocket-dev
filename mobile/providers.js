// Which AI harness a session runs, and what pocket-dev can therefore know about it.
//
// WHY A REGISTRY AND NOT A BOOLEAN: a provider id selects a COMMAND LINE, and
// most session machinery downstream of that command line is provider-shaped.
// Both providers can resume, but they learn the conversation id differently.
// Transcript-derived status, titles, archive-close and Remote Control
// auto-rename are reads of a transcript only Claude writes. Before this
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
// the default command has always been Claude. A Codex default would make the
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

const SHELL_OVERRIDE_INPUT = Object.freeze({
  submitSequence: '\r',
  submitDelayMs:  0,
});

const CLAUDE_INPUT = SHELL_OVERRIDE_INPUT;
const CODEX_INPUT = Object.freeze({
  // Codex enables the Kitty keyboard protocol. Its TUI therefore expects
  // Enter as CSI 13 u when pocket-dev submits text outside xterm's own key
  // encoder; a carriage return only inserts the prompt and leaves it idle.
  submitSequence: '\x1b[13u',
  // Codex treats a whole composer payload as a paste burst. If Enter follows
  // in the same burst it stays in the composer, so let that detection settle
  // before submitting. Measured live against Codex 0.154.0 on 2026-09-11.
  submitDelayMs:  100,
});

// Both Codex credential routes speak the same TUI and use the same supported
// SessionStart hook. What differs is the account behind the command: the
// Deepgram API profile can use the API model catalog, while bare Codex carries
// the ChatGPT login and its connected apps. Keep the session capabilities one
// value so adding an account route cannot quietly change what pocket-dev
// believes about that TUI.
const CODEX_CAPABILITIES = Object.freeze({
  resumeConversation: true,
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
});

const PROVIDERS = new Map([
  ['claude', {
    label:   'Claude',
    pickerLabel: 'Claude',
    sessionKind: 'claude',
    input: CLAUDE_INPUT,
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
    label: 'Codex (Deepgram)',
    pickerLabel: 'Codex DG',
    sessionKind: 'codex',
    input: CODEX_INPUT,
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
    // The model pin belongs on this per-session command line. PR #55 removed
    // the base config seed because both personal and API runs share that file.
    //
    // codex-dg, NOT bare codex: these tabs bill Deepgram's API account by
    // decision, 2026-09-08. `codex-dg` is the documented single entry point for
    // that path (it injects DEEPGRAM_OPENAI_API_KEY from
    // ~/.codex/deepgram-openai.env and layers ~/.codex/deepgram.config.toml,
    // which sets model_provider). Bare `codex` uses the ChatGPT OAuth seat
    // instead, which is a different account and a different bill.
    //
    // IT ALSO DECIDES WHICH MODELS EXIST, and that is not obvious. Model
    // availability is per-ACCOUNT, measured with a bogus id as the control:
    //
    //   on the ChatGPT seat   sol 400 "not supported"   astra 400   terra OK (default)
    //   on the Deepgram API   sol OK                    astra OK    terra OK
    //   bogus id, both paths  400 / "does not exist"  (so the control is live)
    //
    // So `-m gpt-5.6-sol` is only correct BECAUSE this line runs through
    // codex-dg. An earlier version pinned Sol on bare `codex` and 400d every
    // tab within the hour, on a seat that has no Sol. The pin and the wrapper
    // are ONE decision: change either and re-run the probe in
    // ~/.claude/skills/second-opinion/SKILL.md <model_choice> before believing
    // the result. A candidate returning the same error as a bogus id does not
    // exist on that account.
    //
    // codex-dg REFUSES -c/--config/-p/--profile (exit 2) because those outrank
    // the profile and would silently move billing back. It passes everything
    // else through, so the bypass flag and -m arrive intact.
    //
    // THE DEPENDENCY IS OUTSIDE THE IMAGE, state it rather than discover it:
    // ~/bin/codex-dg and the key file live in the home BIND MOUNT, provisioned
    // by ~/.claude/skills/second-opinion/codex-dg/install.sh, deliberately not
    // in this repo and not in the image so the key never reaches GitHub. A
    // Codex tab therefore fails closed on a host that has never been
    // provisioned. That is the intended failure: a missing key must stop the
    // tab, not silently run it on the wrong account.
    //
    // NO --skip-git-repo-check: measured against codex-cli 0.151.0, that flag
    // exists on `codex exec` ONLY and is not accepted by the interactive TUI, so
    // adding it here would stop the tab starting at all. The interactive trust
    // gate is answerable in the TUI, which is the right place for a tab a human
    // is sitting in.
    command: 'codex-dg --dangerously-bypass-approvals-and-sandbox -m gpt-5.6-sol',
    remoteControlArgs: null,
    // Resume is supported through Codex's SessionStart hook and explicit
    // `codex resume SESSION_ID`. The user-facing transcript capabilities stay
    // off because they need continuous metadata that Codex does not expose to
    // this terminal session. Restore separately reads one supported persisted
    // turn status through App Server. Do not infer either from Codex's legacy
    // rollout files, which are not a stable integration boundary.
    capabilities: CODEX_CAPABILITIES,
  }],

  ['codex-chatgpt', {
    label: 'Codex (ChatGPT)',
    pickerLabel: 'Codex GPT',
    sessionKind: 'codex',
    input: CODEX_INPUT,
    // Bare Codex uses the persisted ChatGPT login in ~/.codex/auth.json. That
    // identity is also where OpenAI's connected apps live, so this is the
    // route for Slack, Notion and other account apps. Do not send it through
    // codex-dg: that wrapper deliberately replaces the ChatGPT identity with
    // the Deepgram API profile, where account apps are unavailable.
    //
    // There is no model pin here on purpose. App availability is evaluated by
    // the ChatGPT account and model, and the account default was live-verified
    // with both Slack and Notion on 2026-09-11. The Deepgram route keeps the
    // explicit Sol pin above for the separate billing/model decision it owns.
    command: 'codex --dangerously-bypass-approvals-and-sandbox',
    remoteControlArgs: null,
    capabilities: CODEX_CAPABILITIES,
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

function sessionKindFor(id) {
  const entry = PROVIDERS.get(id);
  if (!entry) throw new Error(`unknown provider: ${id}`);
  return entry.sessionKind;
}

function resolveInput(id, { shellOverride = false } = {}) {
  const entry = PROVIDERS.get(id);
  if (!entry) throw new Error(`unknown provider: ${id}`);
  return shellOverride ? SHELL_OVERRIDE_INPUT : entry.input;
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
  const canResume = caps.resumeConversation && resume;

  return Object.freeze({
    resumeConversation: canResume,
    transcriptStatus:   caps.transcriptStatus && canResume,
    transcriptTitle:    caps.transcriptTitle  && canResume,
    unreadAxis:         canResume ? caps.unreadAxis
                      : caps.unreadAxis === 'none' ? 'none'
                      : 'bytes',
    archiveClose:       caps.archiveClose && canResume && archiveClose,
    autoName:           caps.autoName && canResume && remoteControl && autoName,
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
  SHELL_OVERRIDE_INPUT,
  PROVIDERS,
  PROVIDER_IDS,
  isProvider,
  labelFor,
  sessionKindFor,
  resolveInput,
  commandFor,
  resolveCapabilities,
  statusTracked,
};
