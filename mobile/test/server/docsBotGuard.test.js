import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RESTORED_PATHS,
  DEFAULT_MAX_DROPPED_WORDS,
  FILE_DROPPED_WORDS_FACTOR,
  headings,
  renderReport,
  violations,
} from '../../../.github/scripts/docs-bot-guard.mjs';

// The Auto-Document PR job (claude-docs.yml) deleted reviewed CLAUDE.md
// sections on #104, #107 and #108. The cause was mechanical, not the model:
// claude-code-action resets the root CLAUDE.md to the BASE branch before Claude
// runs and the job's `git add -A` committed that revert. These tests rebuild
// that exact sequence in a scratch repo (base commit, PR commit, the action's
// restore, a bot edit) and run the real guard CLI over it.

const REPO_ROOT = path.resolve(__dirname, '../../..');
const GUARD = path.join(REPO_ROOT, '.github/scripts/docs-bot-guard.mjs');
const WORKFLOW = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/claude-docs.yml'), 'utf8');

// Isolated from the caller's git config: a global hooksPath or signing setting
// must not leak into the scratch repo.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

const LONG = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');

const BASE_CLAUDE = `# proj

## Architecture

The server hosts N tmux sessions, one pty each.

## CI

- test.yml runs the suite every (60) seconds.

## Gotchas

- Do not run the PID tests against the live container.
`;

const BASE_README = `# proj

Intro paragraph.

## Usage

${LONG}

## Testing

Run pnpm test.
`;

// What the PR's own commit adds to CLAUDE.md: the section #107 lost.
const PR_SECTION = `## Supervisor resume

It also resumes the standing supervisor once per container boot, because nothing else does.
`;
const PR_CLAUDE = BASE_CLAUDE.replace('## Gotchas', `${PR_SECTION}\n## Gotchas`);

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function writeFiles(cwd, files) {
  for (const [file, content] of Object.entries(files)) {
    const p = path.join(cwd, file);
    if (content === null) {
      fs.rmSync(p, { force: true });
    } else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  }
}

// Base commit on main (published as origin/main), PR commit on top, then the
// action's restore exactly as restore-config.ts does it: snapshot the PR copy
// to .claude-pr/, delete every restored path, check it out from the base, and
// unstage.
function scenario({ base = {}, pr = {}, prExtra = () => {}, restore = true }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-guard-test-'));
  dirs.push(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  writeFiles(cwd, { 'CLAUDE.md': BASE_CLAUDE, 'README.md': BASE_README, ...base });
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(cwd, 'checkout', '-q', '-b', 'pr');
  writeFiles(cwd, { 'CLAUDE.md': PR_CLAUDE, ...pr });
  prExtra(cwd);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'pr');
  const head = git(cwd, 'rev-parse', 'HEAD').trim();
  if (restore) {
    fs.mkdirSync(path.join(cwd, '.claude-pr'));
    if (fs.existsSync(path.join(cwd, 'CLAUDE.md'))) {
      fs.copyFileSync(path.join(cwd, 'CLAUDE.md'), path.join(cwd, '.claude-pr/CLAUDE.md'));
    }
    fs.appendFileSync(path.join(cwd, '.git/info/exclude'), '/.claude-pr/\n');
    for (const p of RESTORED_PATHS) {
      fs.rmSync(path.join(cwd, p), { recursive: true, force: true });
      spawnSync('git', ['checkout', 'origin/main', '--', p], { cwd, env: GIT_ENV });
    }
    spawnSync('git', ['reset', '-q', '--', ...RESTORED_PATHS], { cwd, env: GIT_ENV });
  }
  const read = (file) => {
    const p = path.join(cwd, file);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  };
  const edit = (file, fn) => writeFiles(cwd, { [file]: fn(read(file)) });
  const report = path.join(cwd, '.git', 'held-back.md');
  const run = (args = ['--head', head, '--base', 'origin/main']) => {
    const r = spawnSync(process.execPath, [GUARD, ...args, '--report', report], {
      cwd, env: GIT_ENV, encoding: 'utf8',
    });
    return {
      ...r,
      report: fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : null,
      dirty: git(cwd, 'status', '--porcelain', '--untracked-files=all'),
      diff: git(cwd, 'diff', 'HEAD'),
    };
  };
  return { cwd, head, read, edit, run, write: (files) => writeFiles(cwd, files) };
}

describe('docs-bot-guard: the CLAUDE.md restore', () => {
  it('#108: with no bot edit, the PR\'s CLAUDE.md comes back whole and nothing is committed', () => {
    const s = scenario({});
    expect(s.read('CLAUDE.md')).toBe(BASE_CLAUDE); // the hazard the job used to commit
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('CLAUDE.md')).toBe(PR_CLAUDE);
    expect(r.dirty).toBe('');
    expect(r.report).toBeNull();
  });

  it('#107: a bot addition made on the base copy lands on the PR\'s version, keeping the PR\'s section', () => {
    const s = scenario({});
    const line = '- claude-docs.yml keeps the markdown in sync.\n';
    s.edit('CLAUDE.md', (t) => t.replace('every (60) seconds.\n', `every (60) seconds.\n${line}`));
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('CLAUDE.md')).toBe(PR_CLAUDE.replace('every (60) seconds.\n', `every (60) seconds.\n${line}`));
    expect(r.report).toBeNull();
  });

  it('keeps a deletion the PR author made in CLAUDE.md, under a bot edit too', () => {
    const authorDoc = PR_CLAUDE.replace(/## Gotchas[\s\S]*$/, '');
    const s = scenario({ pr: { 'CLAUDE.md': authorDoc } });
    expect(s.read('CLAUDE.md')).toContain('## Gotchas'); // the restore brought it back
    s.edit('CLAUDE.md', (d) => d.replace('# proj\n', '# proj\n\nA docs-bot intro line.\n'));
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('CLAUDE.md')).toBe(authorDoc.replace('# proj\n', '# proj\n\nA docs-bot intro line.\n'));
    expect(r.report).toBeNull();
  });

  it('holds back a bot CLAUDE.md edit that collides with the PR\'s own change there', () => {
    // The PR rewrote the CI line; the bot, seeing the base copy, rewrote it differently.
    const prDoc = PR_CLAUDE.replace('(60)', '(90)');
    const s = scenario({ pr: { 'CLAUDE.md': prDoc } });
    s.edit('CLAUDE.md', (t) => t.replace('(60)', '(120)'));
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('CLAUDE.md')).toBe(prDoc);
    expect(r.dirty).toBe('');
    expect(r.report).toContain('### `CLAUDE.md`');
    expect(r.report).toContain('conflicts with what this PR changed');
    expect(r.report).toContain('(120)');
  });

  it.each([
    ['an empty', ''],
    ['a non-empty', BASE_CLAUDE],
  ])('keeps the PR\'s deletion of %s base CLAUDE.md, with or without a bot edit', (_, baseDoc) => {
    const s = scenario({ base: { 'CLAUDE.md': baseDoc }, pr: { 'CLAUDE.md': null } });
    expect(s.read('CLAUDE.md')).toBe(baseDoc); // the restore brought it back
    let r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('CLAUDE.md')).toBeNull();
    expect(r.dirty).toBe('');

    s.write({ 'CLAUDE.md': `${baseDoc}# New\n` });
    r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('CLAUDE.md')).toBeNull();
    expect(r.dirty).toBe('');
    expect(r.report).toContain('this PR deletes the file');
  });

  it('keeps the PR\'s executable bit on CLAUDE.md when the bot edits the restored base copy', () => {
    // The restore takes the base mode too; that is not the bot changing it.
    const s = scenario({ prExtra: (cwd) => fs.chmodSync(path.join(cwd, 'CLAUDE.md'), 0o755) });
    expect(fs.statSync(path.join(s.cwd, 'CLAUDE.md')).mode & 0o111).toBe(0);
    const line = '- claude-docs.yml keeps the markdown in sync.\n';
    s.edit('CLAUDE.md', (t) => t.replace('every (60) seconds.\n', `every (60) seconds.\n${line}`));
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('CLAUDE.md')).toBe(PR_CLAUDE.replace('every (60) seconds.\n', `every (60) seconds.\n${line}`));
    expect(r.diff).not.toContain('mode');
    expect(r.report).toBeNull();
  });

  it('returns restored non-markdown config to the PR head', () => {
    const s = scenario({
      base: { '.husky/pre-commit': 'base hook\n', '.claude/settings.json': '{"base":1}\n' },
      pr: { '.husky/pre-commit': 'pr hook\n', '.claude/settings.json': null, '.mcp.json': '{}\n' },
    });
    expect(s.read('.husky/pre-commit')).toBe('base hook\n');
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.dirty).toBe('');
    expect(s.read('.husky/pre-commit')).toBe('pr hook\n');
    expect(s.read('.claude/settings.json')).toBeNull();
    expect(s.read('.mcp.json')).toBe('{}\n');
  });
});

describe('docs-bot-guard: only additions and in-place adjustments', () => {
  it('rejects a bot edit that deletes a base section, and reports it', () => {
    const s = scenario({});
    s.edit('README.md', (t) => t.replace(/## Testing[\s\S]*$/, ''));
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('README.md')).toBe(BASE_README);
    expect(r.dirty).toBe('');
    expect(r.report).toContain('### `README.md`');
    expect(r.report).toContain('removes or renames the heading "## Testing"');
    expect(r.report).toContain('-Run pnpm test.');
    expect(r.stdout).toContain('::warning::docs bot change to README.md held back');
  });

  it('rejects a bot edit to the base copy of CLAUDE.md that deletes a section', () => {
    const s = scenario({});
    s.edit('CLAUDE.md', (t) => t.replace(/## Architecture\n\n.*\n\n/, ''));
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('CLAUDE.md')).toBe(PR_CLAUDE);
    expect(r.dirty).toBe('');
    expect(r.report).toContain('removes or renames the heading "## Architecture"');
  });

  it('rejects removing a section the PR itself added', () => {
    const prReadme = `${BASE_README}\n## Added by the PR\n\nA reviewed note.\n`;
    const s = scenario({ pr: { 'README.md': prReadme } });
    s.write({ 'README.md': BASE_README });
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('README.md')).toBe(prReadme);
    expect(r.report).toContain('removes or renames the heading "## Added by the PR"');
  });

  it('keeps the PR\'s CLAUDE.md even if the action did not restore it and the bot cut a section', () => {
    // Without a restore the bot edits the PR's copy, and the merge sees its cut
    // collide with the PR's own insertion. Either way the PR's text survives.
    const s = scenario({ restore: false });
    s.edit('CLAUDE.md', (t) => t.replace(PR_SECTION, ''));
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('CLAUDE.md')).toBe(PR_CLAUDE);
    expect(r.dirty).toBe('');
    expect(r.report).toContain('### `CLAUDE.md`');
  });

  it('applies an ordinary bot edit to CLAUDE.md even if the action did not restore it', () => {
    const s = scenario({ restore: false });
    s.edit('CLAUDE.md', (t) => t.replace('one pty each.', 'one pty each, all in one browser tab.'));
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('CLAUDE.md')).toBe(PR_CLAUDE.replace('one pty each.', 'one pty each, all in one browser tab.'));
    expect(r.report).toBeNull();
  });

  it('allows a bot edit that only adds', () => {
    const s = scenario({});
    const added = BASE_README.replace('## Testing', 'A new note about the docs job.\n\n## Testing');
    s.write({ 'README.md': `${added}\n## New section\n\nMore text.\n` });
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('README.md')).toBe(`${added}\n## New section\n\nMore text.\n`);
    expect(r.report).toBeNull();
    expect(r.dirty).toBe(' M README.md\n');
  });

  it('allows adjusting a stale fact inside a long line', () => {
    const s = scenario({});
    s.edit('README.md', (t) => t.replace('word57 word58', 'word57 (now 120) word58').replace('word3 ', 'WORD3 '));
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('README.md')).toContain('word57 (now 120) word58');
    expect(r.report).toBeNull();
  });

  it('rejects gutting a long paragraph even though no line disappears', () => {
    const s = scenario({});
    s.edit('README.md', (t) => t.replace(LONG, 'A short summary of usage.'));
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('README.md')).toBe(BASE_README);
    expect(r.report).toMatch(/drops 120 words at line 7 \(limit 40\)/);
  });

  it('rejects deleting a markdown file, and allows creating one', () => {
    const s = scenario({});
    s.write({ 'README.md': null, 'docs/new.md': '# New\n' });
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('README.md')).toBe(BASE_README);
    expect(s.read('docs/new.md')).toBe('# New\n');
    expect(r.report).toContain('deletes the file');
  });

  it('holds back a change to a markdown file that is not UTF-8, which a text compare cannot see', () => {
    // 0x80 and 0x81 both decode to U+FFFD, so a lossy compare calls them equal.
    const before = Buffer.from([0x23, 0x20, 0x80, 0x0a]);
    const s = scenario({ pr: { 'docs/bin.md': before } });
    s.write({ 'docs/bin.md': Buffer.from([0x23, 0x20, 0x81, 0x0a]) });
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(s.cwd, 'docs/bin.md')).equals(before)).toBe(true);
    expect(r.dirty).toBe('');
    expect(r.report).toContain('is not UTF-8 text');
  });

  it('leaves a non-markdown change outside the restored paths for the workflow to reject', () => {
    const s = scenario({});
    s.write({ 'mobile/server.js': 'oops\n' });
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.dirty).toContain('mobile/server.js');
  });
});

describe('docs-bot-guard: refuses to judge against the wrong commits', () => {
  it('exits non-zero, touching nothing, when HEAD is not the PR head', () => {
    const s = scenario({});
    const base = git(s.cwd, 'rev-parse', 'origin/main').trim();
    const r = s.run(['--head', base, '--base', 'origin/main']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not the PR head');
    expect(s.read('CLAUDE.md')).toBe(BASE_CLAUDE);
  });

  it('exits non-zero when the base ref does not resolve', () => {
    const s = scenario({});
    const r = s.run(['--head', s.head, '--base', 'origin/nope']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('does not resolve');
  });
});

// Changes the bot's Edit/Write tools cannot make, and a text comparison cannot
// judge: the guard fails the job (exit 2) so nothing is committed.
describe('docs-bot-guard: refuses changes that are not plain text edits', () => {
  const linkScenario = () => scenario({
    pr: { 'docs/target.md': '# Target\n' },
    prExtra: (cwd) => fs.symlinkSync('target.md', path.join(cwd, 'docs/ref.md')),
  });

  it('a symlink replaced by a file holding its target\'s name (same bytes)', () => {
    const s = linkScenario();
    fs.rmSync(path.join(s.cwd, 'docs/ref.md'));
    fs.writeFileSync(path.join(s.cwd, 'docs/ref.md'), 'target.md');
    const r = s.run();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('docs/ref.md is a git symlink');
  });

  it('a new markdown symlink', () => {
    const s = scenario({});
    fs.symlinkSync('../README.md', path.join(s.cwd, 'docs-link.md'));
    const r = s.run();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('docs-link.md is a symlink in the working tree');
  });

  it('a changed executable bit', () => {
    const s = scenario({});
    fs.chmodSync(path.join(s.cwd, 'README.md'), 0o755);
    const r = s.run();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('README.md changed its executable bit');
  });

  it('a deleted markdown file whose path is not UTF-8', () => {
    // Decoded lossily, docs/\xff.md becomes docs/�.md, a path that exists
    // nowhere, so the deletion read as "a new file" and was let through.
    const raw = (cwd) => Buffer.concat([Buffer.from(`${cwd}/docs/`), Buffer.from([0xff]), Buffer.from('.md')]);
    const s = scenario({
      prExtra: (cwd) => {
        fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true });
        fs.writeFileSync(raw(cwd), '# Odd name\n');
      },
    });
    fs.rmSync(raw(s.cwd));
    const r = s.run();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('is not UTF-8');
    expect(fs.existsSync(raw(s.cwd))).toBe(false); // untouched; nothing judged
  });
});

describe('docs-bot-guard: violations()', () => {
  it('treats a renamed heading as a removal', () => {
    expect(violations('# A\n\n## B\n', '# A\n\n## B2\n')).toEqual([
      'removes or renames the heading "## B"',
    ]);
  });

  it('ignores blank lines and allows a pure insertion', () => {
    expect(violations('a\n\nb\n', 'a\nnew\nb\n')).toEqual([]);
  });

  it('counts a net-removed line inside a replacement', () => {
    expect(violations('one two\nthree four\n', 'one two three four\n')[0]).toMatch(/^removes 1 line\(s\) at line 1/);
  });

  const ws = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`).join(' ');

  it('allows exactly the per-place word limit and rejects one more', () => {
    const limit = DEFAULT_MAX_DROPPED_WORDS;
    expect(violations(`${ws(limit, 'a')}\n`, 'b\n')).toEqual([]);
    const over = violations(`${ws(limit + 1, 'a')}\n`, 'b\n');
    expect(over).toHaveLength(1);
    expect(over[0]).toMatch(new RegExp(`^drops ${limit + 1} words at line 1 \\(limit ${limit}\\), starting "a0 a1 `));
  });

  it('caps the words dropped across the whole file, so small cuts cannot add up to a gutted section', () => {
    const per = 35; // under the per-place limit
    const doc = (n) => Array.from({ length: n }, (_, i) => `${ws(per, `p${i}w`)}\nkeep ${i}\n`).join('');
    const cut = (n) => Array.from({ length: n }, (_, i) => `short ${i}\nkeep ${i}\n`).join('');
    const fileLimit = DEFAULT_MAX_DROPPED_WORDS * FILE_DROPPED_WORDS_FACTOR;
    expect(per * 3).toBeLessThanOrEqual(fileLimit);
    expect(violations(doc(3), cut(3))).toEqual([]);
    expect(violations(doc(4), cut(4))).toEqual([`drops ${per * 4} words across the file (limit ${fileLimit})`]);
  });

  it('counts a long token with no spaces (a URL) as the words in it', () => {
    const url = `https://example.com/${ws(45, 's').replace(/ /g, '/')}`;
    expect(violations(`See ${url}\n`, 'See the docs.\n')[0]).toMatch(/^drops 4\d words at line 1/);
  });

  it('treats a heading moved into a code fence as removed', () => {
    expect(violations('## Safety\n\nNever do X.\n', '```\n## Safety\n```\n\nNever do X.\n')).toEqual([
      'removes or renames the heading "## Safety"',
    ]);
  });

  it('does not treat a "# comment" in a fenced block as a heading', () => {
    const doc = '# Doc\n\n```bash\n# start it\nnpm start\n```\n';
    expect(headings(doc)).toEqual(['# Doc']);
    expect(violations(doc, doc.replace('# start it\n', '# start the server\n'))).toEqual([]);
  });

  it('recognises setext headings, and converting one to ATX is not a rename', () => {
    const setext = 'Safety\n------\n\nNever do X.\n\nTitle\n=====\n';
    expect(headings(setext)).toEqual(['## Safety', '# Title']);
    // The dropped underline still counts as a removed line (held back, the safe
    // way); what matters here is that no heading reads as renamed.
    expect(violations(setext, '## Safety\n\nNever do X.\n\n# Title\n').filter((v) => v.includes('heading'))).toEqual([]);
    // Swapped for the same number of lines, so only the heading rule can see it.
    expect(violations(setext, 'Some intro\nmore intro\n\nNever do X.\n\nTitle\n=====\n')).toEqual([
      'removes or renames the heading "## Safety"',
    ]);
  });

  it('does not open a fence on a backtick line whose info string has a backtick', () => {
    // CommonMark: "```lang`bad" is not a fence, so the heading after it is real.
    const doc = '```lang`bad\n## Safety\n```\n';
    expect(headings(doc)).toEqual(['## Safety']);
    expect(violations(doc, doc.replace('## Safety', 'Safety prose'))).toEqual([
      'removes or renames the heading "## Safety"',
    ]);
    // A tilde fence may carry a backtick in its info string, and still hides.
    expect(headings('~~~ lang`ok\n## In code\n~~~\n')).toEqual([]);
  });

  it('reads YAML front matter as metadata, not a setext heading', () => {
    const doc = '---\nname: thing\ndescription: Old words\n---\n\n# Body\n';
    expect(headings(doc)).toEqual(['# Body']);
    expect(violations(doc, doc.replace('Old words', 'New words'))).toEqual([]);
    // A page that opens with a rule keeps headings outside YAML-shaped lines.
    expect(headings('---\nSome prose\n---\n# Title\n')).toEqual(['## Some prose', '# Title']);
    // A "# x" line in the block is kept, tagged, because the guard cannot tell
    // a YAML comment from a heading GitHub renders when the YAML is invalid.
    expect(headings('---\n# Title\n---\n')).toEqual(['[front matter] # Title']);
    // Wrapping headings in a fake front-matter block does not hide removing them.
    expect(violations('# A\n\nx: 1\n', '---\nx: 1\n---\n\nx: 1\n')).toContain('removes or renames the heading "# A"');
    expect(violations('# A\n\ntext\n', '---\n# A\n---\n\ntext\n')).toContain('removes or renames the heading "# A"');
  });

  it('treats front matter with a "#" line as front matter, and protects the "#" line', () => {
    const doc = '---\n# yaml note\ntitle: X\n---\n# Body\n';
    expect(headings(doc)).toEqual(['[front matter] # yaml note', '# Body']);
    // Invalid YAML: GitHub shows "# Safety" as a heading, so the bot may not drop it.
    const broken = '---\n# Safety\ntitle: [broken\n---\n\nSafety steps follow.\n';
    expect(violations(broken, broken.replace('# Safety', 'revised text'))).toContain(
      'removes or renames the heading "[front matter] # Safety"',
    );
  });

  it('holds back any change to front matter that has a "#" line, since that can flip it to rendering', () => {
    // Repairing the YAML turns a rendered "# Safety" heading into a hidden comment,
    // with every line count and heading key unchanged.
    const broken = '---\n# Safety\ntitle: [broken\n---\n\nSafety steps follow.\n';
    const reason = 'changes a front-matter block that has a "#" line (GitHub renders it as a heading when the YAML is invalid)';
    expect(violations(broken, broken.replace('title: [broken', 'title: fixed'))).toEqual([reason]);
    // Even a value edit in valid front matter with a YAML comment: a false hold, the safe direction.
    const doc = '---\n# yaml note\ntitle: X\n---\n# Body\n';
    expect(violations(doc, doc.replace('title: X', 'title: Y'))).toEqual([reason]);
    // Breaking the block so it stops being front matter is held back too.
    expect(violations(doc, doc.replace('title: X', 'Some prose'))).toContain(reason);
    // Front matter without a "#" line stays freely editable, and so does the body.
    const plain = '---\ntitle: X\n---\n# Body\n';
    expect(violations(plain, plain.replace('title: X', 'title: Y'))).toEqual([]);
    expect(violations(doc, `${doc}\nMore words.\n`)).toEqual([]);
    // A CRLF-to-LF change of the same block is no change.
    expect(violations(doc.replace(/\n/g, '\r\n'), doc)).toEqual([]);
  });

  it('cannot match a front-matter tag against a real heading of the same text', () => {
    // GitHub renders the head's heading; in valid YAML the bot's "# Safety" is a comment.
    const head = '# Safety (in front matter)\n\nSafety steps follow.\n';
    const bot = '---\n# Safety\ntitle: Guide\n---\n\nSafety steps follow.\n';
    expect(violations(head, bot)).toContain('removes or renames the heading "# Safety (in front matter)"');
    const head2 = '# [front matter] # Safety\n\nSafety steps follow.\n';
    expect(violations(head2, bot)).toContain('removes or renames the heading "# [front matter] # Safety"');
  });

  it('reads CRLF headings: a line-ending change passes, a deleted heading does not', () => {
    const lf = '# A\n\n## B ##\n\ntext\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(headings(crlf)).toEqual(['# A', '## B']);
    expect(violations(crlf, lf)).toEqual([]);
    expect(violations(crlf, crlf.replace('## B ##', 'Bee text'))).toEqual([
      'removes or renames the heading "## B"',
    ]);
  });
});

describe('docs-bot-guard: the PR comment', () => {
  it('names every held file and stays under GitHub\'s comment limit, however big the proposals', () => {
    const held = Array.from({ length: 5 }, (_, i) => ({
      file: `docs/f${i}.md`,
      reasons: ['removes or renames the heading "## X"'],
      proposal: `@@ -1 +1 @@\n${'-x\n'.repeat(15000)}`,
    }));
    const body = renderReport(held);
    expect(body.length).toBeLessThanOrEqual(65536);
    for (const h of held) expect(body).toContain(`### \`${h.file}\``);
    expect(body).not.toContain('report truncated');
  });

  it('keeps every file when a proposal\'s backtick runs make its fence huge', () => {
    // A fixed per-file allowance missed the fence, which grows with the longest
    // backtick run, and the fifth file fell off the end of the comment.
    const bt = '`';
    const held = Array.from({ length: 5 }, (_, i) => ({
      file: `docs/f${i}.md`,
      reasons: [`reason for ${i}`],
      proposal: i === 0 ? `@@ -1 +1 @@\n-${bt.repeat(10000)}` : 'x'.repeat(30000),
    }));
    const body = renderReport(held);
    expect(body.length).toBeLessThanOrEqual(65536);
    for (const h of held) {
      expect(body).toContain(`### \`${h.file}\``);
      expect(body).toContain(`- ${h.reasons[0]}`);
    }
    expect(body).not.toContain('report truncated');
  });

  it('keeps every proposal whole when the whole report fits, even with no room to spare', () => {
    // Rendered length is not monotone in the proposal limit: a proposal that
    // fits whole loses its "... (truncated)" suffix. A plain binary search
    // over the limit therefore truncated proposals in a report that fit.
    const held = (c) => [20000, 20000, c].map((n, i) => ({
      file: `docs/f${i}.md`, reasons: [`reason ${i}`], proposal: 'x'.repeat(n),
    }));
    // Overhead of an untruncated report, measured on small proposals of known size.
    const small = [10, 10, 10].map((n, i) => ({ file: `docs/f${i}.md`, reasons: [`reason ${i}`], proposal: 'x'.repeat(n) }));
    const overhead = renderReport(small).length - 1 - 30;
    const c = 60000 - overhead - 40000;
    expect(c).toBeLessThan(20000);
    const body = renderReport(held(c));
    expect(body.length - 1).toBe(60000);
    expect(body).not.toContain('(truncated)');
    expect(body).toContain(`\n${'x'.repeat(c)}\n`);
    expect(body.split('x'.repeat(20000)).length - 1).toBe(2);
  });

  it('cuts a file\'s long reason list before it drops a file', () => {
    const held = Array.from({ length: 5 }, (_, i) => ({
      file: `docs/f${i}.md`,
      reasons: Array.from({ length: 2000 }, (_, j) => `removes or renames the heading "## Heading ${j}"`),
      proposal: 'x'.repeat(30000),
    }));
    const body = renderReport(held);
    expect(body.length).toBeLessThanOrEqual(65536);
    for (const h of held) expect(body).toContain(`### \`${h.file}\``);
    expect(body).toMatch(/- \.\.\. and \d+ more \(see the workflow log\)/);
    expect(body).not.toContain('report truncated');
  });

  it('names a file whose path holds a backtick in a code span that survives it', () => {
    const body = renderReport([{ file: 'docs/a`b.md', reasons: ['deletes the file'], proposal: '' }]);
    expect(body).toContain('### `` docs/a`b.md ``');
  });
});

describe('claude-docs workflow wiring for the guard', () => {
  const code = WORKFLOW.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  it('copies the guard out before Claude runs and runs that copy before anything is staged', () => {
    const copy = code.indexOf('cp .github/scripts/docs-bot-guard.mjs "$RUNNER_TEMP/docs-bot-guard.mjs"');
    const claude = code.indexOf('uses: anthropics/claude-code-action@');
    const runGuard = code.indexOf('node "$RUNNER_TEMP/docs-bot-guard.mjs"');
    const stage = code.indexOf('git add -A');
    expect(copy).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(claude);
    expect(runGuard).toBeGreaterThan(claude);
    expect(runGuard).toBeLessThan(stage);
    expect(code).toMatch(/--head "\$START_SHA" --base "origin\/\$BASE_REF"/);
  });

  it('tells the bot the same word limit the guard enforces', () => {
    const prompt = WORKFLOW.slice(WORKFLOW.indexOf('prompt: |'));
    expect(prompt).toContain(`more than ${DEFAULT_MAX_DROPPED_WORDS} words`);
    expect(prompt).toContain(`more than ${DEFAULT_MAX_DROPPED_WORDS * FILE_DROPPED_WORDS_FACTOR} words in the file`);
  });

  // The guard must know every path the action resets. Read the list from
  // src/github/operations/restore-config.ts (SENSITIVE_PATHS) at the pinned
  // tag and record it here; an unrecorded tag fails rather than passes.
  const ACTION_TAG_RESTORED = {
    'v1.0.235': ['.claude', '.mcp.json', '.claude.json', '.gitmodules', '.ripgreprc', 'CLAUDE.md', 'CLAUDE.local.md', '.husky'],
  };

  it('knows the restored paths of the pinned claude-code-action', () => {
    const tag = code.match(/uses:\s*anthropics\/claude-code-action@[0-9a-f]{40}\s*#\s*(v[\d.]+)/)?.[1];
    expect(tag).toBeDefined();
    expect(
      ACTION_TAG_RESTORED[tag],
      `No restored-path list recorded for claude-code-action ${tag}. Read SENSITIVE_PATHS `
        + 'from that tag and add it here and to RESTORED_PATHS in docs-bot-guard.mjs.',
    ).toBeDefined();
    expect(RESTORED_PATHS).toEqual(ACTION_TAG_RESTORED[tag]);
  });
});
