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
