# AGENTS.md

The rules for this repository live in [`CLAUDE.md`](./CLAUDE.md). Read that file
and follow it before doing anything else.

<!--
WHY THIS FILE IS A POINTER AND NOT A COPY.

Claude Code reads CLAUDE.md and does NOT read AGENTS.md, even when AGENTS.md is
the only instruction file present. Codex reads AGENTS.md and does not read
CLAUDE.md. Two harnesses, two filenames, and neither one reads the other's.

Keeping two full copies of the rules would mean two bodies drifting apart, and
catching that drift needs a check that then also has to be maintained. A one
line pointer cannot drift. The number of FILES does not go down, one per
harness is unavoidable; what goes down is the number of BODIES.

The pointer is load bearing rather than decorative, and it was measured before
being relied on. On codex-cli 0.153.0, 2026-09-08, with a prompt that never
mentioned the rules at all: a rule placed inline in AGENTS.md was obeyed, a
rule placed behind a pointer made the model read the pointed to file first and
then obey it, and an identical rule file that nothing referenced was ignored
with no search. Both controls clean, so the positive result is not a model
guessing what the asker wanted.

DO NOT let this file accumulate rules of its own. The moment it says something
CLAUDE.md does not, a Codex consult and a Claude session are running on
different instructions, which is the failure this repo added the file to avoid.
-->
