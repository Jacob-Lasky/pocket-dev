# Pocket-dev interface decision

Decision, 2026-09-09: improve the existing terminal first. Remove the Select
screen, let ordinary desktop drags select text, and add long-press selection,
selection handles, a multiline composer and per-session drafts on phones.
Keep the same tmux sessions and provider launch commands.

## Evidence checked on 2026-09-09

- The current checkout already has separate Claude and Codex providers. The
  session roster, resume behavior, server access and billing configuration are
  existing investments. No session migration is necessary for these UI changes.
- Deterministic reproduction: an ordinary drag over `MOUSE-APP-READY` selected
  an empty string. The same gesture passed when routed through xterm's existing
  forced-selection behavior. The prior copy test invoked `selectAll()` and did
  not exercise a pointer gesture.
- Diagnosis determined on this date: pocket-dev delegates pointer ownership to
  terminal applications without distinguishing text-selection drags from app
  clicks. Phone editing also uses a single-line field that clears before the
  server acknowledges the message.
- [xterm's public API](https://xtermjs.org/docs/api/terminal/classes/terminal/)
  provides selection, buffer access and selection-change events. The installed
  5.5.0 source confirms forced selection uses Shift on Linux/Windows and Option
  on macOS. Selection uses those existing behaviors and public APIs.
- npm reports xterm 6.0.0 as latest stable. Its
  [release notes](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0)
  describe a changed viewport and scrollbar implementation. It does not add a
  ready-made touch-selection UI. Upgrading that subsystem would enlarge this
  change without providing the requested interaction.
- npm reports ACP SDK 1.4.0, Claude adapter 0.75.1 and Codex adapter 1.10.0.
  [Protocol releases](https://github.com/agentclientprotocol/agent-client-protocol/releases)
  still include stable v1 and schema v2 alpha. The
  [session setup contract](https://agentclientprotocol.com/protocol/v1/session-setup)
  makes session loading capability-dependent. ACP is a credible foundation for
  a separate chat session kind; it is not a selectable renderer for a running TUI.

## Alternatives and why they were not selected for this change

- A custom ACP chat frontend requires conversation rendering, approvals,
  reconnect/replay, session recovery and provider-capability UI. It has the
  largest ongoing maintenance responsibility of the options considered.
- [HAPI](https://hapi.run/docs/guide/faq) offers a self-hosted web/PWA client and
  runner. Its [agent documentation](https://hapi.run/docs/guide/agents) and
  [Codex remote launcher](https://github.com/tiann/hapi/blob/main/cli/src/codex/codexRemoteLauncher.ts)
  confirm a structured app-server implementation. Adoption still moves session
  ownership to its hub/runner. Local import also has a
  [transcript scanner](https://github.com/tiann/hapi/blob/main/cli/src/codex/utils/codexSessionScanner.ts).
  It is the strongest candidate for a separate chat pilot if a better terminal
  remains uncomfortable on the phone.
- [Happy](https://github.com/slopus/happy) supplies web and native phone apps.
  Its README explicitly describes restarting a session in remote mode during
  handoff. That is a lifecycle change, not a drop-in replacement for this UI.
- [Happier](https://github.com/happier-dev/happier) supports multiple providers
  and self-hosting, but still labels itself alpha preview. It does not reduce
  the migration surface enough to beat a local terminal improvement here.
- Separate vendor phone apps remain useful, but do not satisfy the request to
  improve copying and phone use in pocket-dev itself.

## What would change the decision

If reading a narrow TUI remains the primary frustration after selection and
composition work well, trial HAPI beside pocket-dev with disposable sessions.
Verify the actual phone, account/billing configuration, reconnect and restart
recovery before moving daily sessions. A custom ACP frontend becomes justified
only if maintained clients cannot meet those requirements.

The chosen change preserves session ownership and adds no dependencies. The
composer negotiates bracketed paste with the server; reconnects also need an
replay boundary to prevent old handshakes becoming prompt text.
That protocol uses one documented xterm 5.5 internal input-provenance hook,
covered by browser tests. A chat migration would additionally require retaining
the old launch path and verifying conversation recovery.
