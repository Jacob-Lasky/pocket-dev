import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level guards for the Codex CLI install. Same rationale as
// dgvpn.test.js / aliases.test.js / tmuxConf.test.js: nothing in the cat-based
// E2E suite can exercise codex (it needs a real OpenAI account and a round trip
// to their API), so the invariants that break silently are asserted against the
// Dockerfile instead.
//
// Every one of these fails QUIETLY if broken: a codex under $HOME simply is not
// there after the mount lands, a stale ~/bin copy shadows the image's forever,
// and a pinned version keeps working while it rots. The /second-opinion skill
// stops with "codex is missing" in the first case, which at least names itself,
// but the other two present as codex working and being wrong or old.
describe('Codex CLI install', () => {
  const root = path.resolve(__dirname, '../../..');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const template = fs.readFileSync(path.join(root, 'pocket-dev.xml'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const extraParams = (template.match(/<ExtraParams>([^<]*)<\/ExtraParams>/) || [])[1] || '';

  // The WHOLE RUN block, not just the line naming the package. A backslash
  // continuation is one shell command spread over several lines, so a per-line
  // assertion here would be vacuous against exactly the edit it exists to catch:
  // `npm install -g \` on one line and `--prefix /home/claude/bin` on the next.
  const installBlock = dockerfile.match(
    /^RUN npm install -g (?:.*\\\n)*.*@openai\/codex(?:.*\\\n)*.*$/m,
  );

  it('installs @openai/codex globally', () => {
    expect(installBlock).not.toBeNull();
  });

  it('installs into the image prefix, never into the home mount', () => {
    // /home/claude ships EMPTY and is a bind mount at runtime, so an image-owned
    // binary written under it is masked and gone. ~/bin is worse than useless
    // here: it is earlier on PATH than /usr/local/bin, so a copy left there
    // would shadow the image's own on every future update.
    expect(installBlock[0]).not.toMatch(/--prefix|--location=?\s*user/);
    expect(installBlock[0]).not.toMatch(/\/home\/claude|\$\{?HOME\}?/);
    expect(dockerfile).not.toMatch(
      /(?:cp|mv|ln)\b[^\n]*\bcodex\b[^\n]*(?:\/home\/claude|\$\{?HOME\}?)/,
    );
  });

  it('takes the current release rather than a pinned version', () => {
    // Same call as `claude` (install.sh) and `gh` (apt stable): each build takes
    // what is current. DO NOT pin to a version here — that freezes the tool at
    // whatever was newest the day the line was written, and the /second-opinion
    // skill's measured CLI traps are re-verified per major, not per build.
    expect(installBlock[0]).not.toMatch(/@openai\/codex@/);
  });

  it('records the resolved version in the build log', () => {
    // Unpinned means the Dockerfile cannot say what shipped, so the build has to.
    expect(installBlock[0]).toMatch(/codex --version/);
  });

  it('installs bubblewrap, which the read-only sandbox uses', () => {
    // /second-opinion passes `-s read-only` on every consult. Codex bundles its
    // own bwrap and falls back to it, so dropping this package does not break
    // the sandbox: it makes every run print "could not find bubblewrap on PATH",
    // which reads exactly like the sandbox failing to engage and gets
    // re-diagnosed from scratch by whoever sees it next.
    expect(dockerfile).toMatch(/^\s+bubblewrap \\$/m);
  });

  it('the template disables seccomp, without which codex exec review LIES', () => {
    // Docker's default seccomp profile denies unprivileged unshare(CLONE_NEWUSER),
    // so bwrap cannot build a namespace, so any codex mode that EXECs a command to
    // gather its own material dies before reading a byte. It then reports "No
    // findings were identified" and buries the abort in the second clause, which a
    // skimming reader records as a clean review that never ran.
    //
    // Measured 2026-08-15: Tower's kernel allows namespaces; only this knob works.
    // apparmor=unconfined is not the blocker, and SYS_ADMIN clears unshare but then
    // fails on pivot_root, so it is more privilege for less function.
    // Anchor to end-of-token, not \b. `\b` is a boundary between a word and a
    // NON-word character, so `seccomp=unconfined.json` satisfies it: the `d.`
    // junction IS a word boundary. That names a real profile file and is not
    // unconfined at all. `(?!\S)` is the assertion actually wanted, "nothing but
    // whitespace or end-of-string follows". Caught by mutation after the \b
    // version was already written and believed; `--memory=16GiBusted` and
    // `--group-add 2810` genuinely do fail on \b, which is what made the gap easy
    // to miss: two of the three cases passed, so the rule looked sound.
    expect(extraParams).toMatch(/--security-opt\s+seccomp=unconfined(?!\S)/);
    expect(extraParams).not.toMatch(/--privileged(?!\S)|--cap-add[= ]SYS_ADMIN(?!\S)/);
  });

  it('the repo template still carries the params the live container runs with', () => {
    // The repo copy and the Tower copy are supposed to say the same thing, and this
    // one had already drifted: the repo declared only --group-add 281 while Tower ran
    // --memory=16G and --cap-add=SYS_PTRACE too. A template that under-declares is
    // worse than no template, because a rebuild FROM it silently drops the memory cap
    // on a host running Jake's production containers.
    expect(extraParams).toMatch(/--group-add\s+281\b/);
    expect(extraParams).toMatch(/--memory=16G\b/);
    expect(extraParams).toMatch(/--cap-add=SYS_PTRACE\b/);
  });

  it('docker-compose declares the same runtime params as the template', () => {
    // README calls compose a mirror of the UnRAID template, so a param that lives
    // in only one of them makes that sentence false. This was ALREADY false before
    // the seccomp change: compose carried group_add and neither the memory cap nor
    // SYS_PTRACE, so the documented local deployment ran uncapped and reproduced
    // the exact codex review abort this change exists to remove, with every guard
    // green. A source guard that reads one file and a doc that claims two agree is
    // how that survives.
    expect(compose).toMatch(/security_opt:/);
    expect(compose).toMatch(/seccomp:unconfined(?!\S)/);
    expect(compose).toMatch(/cap_add:/);
    expect(compose).toMatch(/SYS_PTRACE\b/);
    expect(compose).toMatch(/mem_limit:\s*16g\b/);
  });

  it('installs BEFORE the mobile/ copy (build-cache ordering)', () => {
    // The download is ~300 MB of Rust binary. Below `COPY mobile/`, every edit
    // to the server would re-fetch all of it; above, it stays cached until the
    // apt layers above it change.
    const codexIdx = dockerfile.indexOf('@openai/codex');
    const copyIdx = dockerfile.indexOf('COPY mobile/');
    expect(codexIdx).toBeGreaterThanOrEqual(0);
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    expect(codexIdx).toBeLessThan(copyIdx);
  });
});
