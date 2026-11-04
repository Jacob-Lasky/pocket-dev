import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  RESTORED_PATHS,
  DEFAULT_MAX_DROPPED_WORDS,
  FILE_DROPPED_WORDS_FACTOR,
  CANARY,
  CANARY_HEADINGS,
  fixtureRenderer,
  githubRender,
  readGhResponse,
  renderedHeadings,
  renderReport,
  violations,
  visibleWords,
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

// The guard reads headings from GitHub's Markdown API. These tests answer it
// from responses recorded from the real API (the file's "recorded" date says
// when; re-record a missing text with DOCS_BOT_GUARD_RECORD=1), and one live
// test at the end checks the recordings still match what the API says.
const FIXTURES = path.join(__dirname, 'fixtures/docs-bot-guard-renders.json');
const render = fixtureRenderer(FIXTURES);
const hs = (text) => renderedHeadings(render(text));
const HIDES = 'hides text the page showed while the source keeps it (an HTML comment, a closed <details>): ';
const v = (oldText, newText, max = DEFAULT_MAX_DROPPED_WORDS) => violations(oldText, newText, max, render);

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
  const run = (args = ['--head', head, '--base', 'origin/main'], fixtures = FIXTURES, env = {}) => {
    const r = spawnSync(process.execPath, [GUARD, ...args, '--render-fixtures', fixtures, '--report', report], {
      cwd, env: { ...GIT_ENV, ...env }, encoding: 'utf8',
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

  // The restore is the root-cause fix and must not lean on the heading check:
  // run the #108 and #107 sequences with a renderer that reports no headings
  // in anything (the canary still answers, so the check runs and sees nothing).
  // The PR's section must still survive, through the restore and the merge alone.
  it.each([
    ['#108 (no bot edit)', null],
    ['#107 (a bot addition on the base copy)', '- claude-docs.yml keeps the markdown in sync.\n'],
  ])('%s keeps the PR\'s CLAUDE.md section with the heading check blinded', (_, line) => {
    const s = scenario({});
    if (line) s.edit('CLAUDE.md', (t) => t.replace('every (60) seconds.\n', `every (60) seconds.\n${line}`));
    const code = `
      import { guard, CANARY, fixtureRenderer } from ${JSON.stringify(pathToFileURL(GUARD).href)};
      const real = fixtureRenderer(${JSON.stringify(FIXTURES)});
      const blind = (t) => (t === CANARY ? real(t) : '<p>no headings here</p>');
      const held = guard({ base: 'origin/main', render: blind, log: () => {} });
      process.stdout.write(JSON.stringify(held));
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: s.cwd, env: GIT_ENV, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
    const want = line ? PR_CLAUDE.replace('every (60) seconds.\n', `every (60) seconds.\n${line}`) : PR_CLAUDE;
    expect(s.read('CLAUDE.md')).toBe(want);
    expect(s.read('CLAUDE.md')).toContain(PR_SECTION);
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

  // Round-1 review: every test above used the root CLAUDE.md. The action
  // restores the whole .claude/ tree, markdown in it included.
  it('returns a nested .claude markdown file to the PR head, and merges a bot edit onto it', () => {
    const skill = '.claude/skills/x/SKILL.md';
    const doc = (endpoint, extra = '') => `# Skill\n\nUse ${endpoint} endpoint.\n\n## Notes\n\nKeep it short.\n${extra}`;
    const s = scenario({ base: { [skill]: doc('base') }, pr: { [skill]: doc('PR') } });
    expect(s.read(skill)).toBe(doc('base')); // the restore brought the base back
    let r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read(skill)).toBe(doc('PR'));
    expect(r.dirty).toBe('');
    // Again with the bot adding a line to the restored base copy.
    s.write({ [skill]: doc('base', 'Run it hourly.\n') });
    r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read(skill)).toBe(doc('PR', 'Run it hourly.\n'));
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
    expect(r.report).toContain('removes, renames, demotes or folds away the heading "## Testing"');
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
    expect(r.report).toContain('removes, renames, demotes or folds away the heading "## Architecture"');
  });

  it('rejects removing a section the PR itself added', () => {
    const prReadme = `${BASE_README}\n## Added by the PR\n\nA reviewed note.\n`;
    const s = scenario({ pr: { 'README.md': prReadme } });
    s.write({ 'README.md': BASE_README });
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('README.md')).toBe(prReadme);
    expect(r.report).toContain('removes, renames, demotes or folds away the heading "## Added by the PR"');
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
    expect(v('# A\n\n## B\n', '# A\n\n## B2\n')).toEqual([
      'removes, renames, demotes or folds away the heading "## B"',
    ]);
  });

  it('ignores blank lines and allows a pure insertion', () => {
    expect(v('a\n\nb\n', 'a\nnew\nb\n')).toEqual([]);
  });

  it('counts a net-removed line inside a replacement', () => {
    expect(v('one two\nthree four\n', 'one two three four\n')[0]).toMatch(/^removes 1 line\(s\) at line 1/);
  });

  const ws = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`).join(' ');

  it('allows exactly the per-place word limit and rejects one more', () => {
    const limit = DEFAULT_MAX_DROPPED_WORDS;
    expect(v(`${ws(limit, 'a')}\n`, 'b\n')).toEqual([]);
    const over = v(`${ws(limit + 1, 'a')}\n`, 'b\n');
    expect(over).toHaveLength(1);
    expect(over[0]).toMatch(new RegExp(`^drops ${limit + 1} words at line 1 \\(limit ${limit}\\), starting "a0 a1 `));
  });

  it('caps the words dropped across the whole file, so small cuts cannot add up to a gutted section', () => {
    const per = 35; // under the per-place limit
    const doc = (n) => Array.from({ length: n }, (_, i) => `${ws(per, `p${i}w`)}\nkeep ${i}\n`).join('');
    const cut = (n) => Array.from({ length: n }, (_, i) => `short ${i}\nkeep ${i}\n`).join('');
    const fileLimit = DEFAULT_MAX_DROPPED_WORDS * FILE_DROPPED_WORDS_FACTOR;
    expect(per * 3).toBeLessThanOrEqual(fileLimit);
    expect(v(doc(3), cut(3))).toEqual([]);
    expect(v(doc(4), cut(4))).toEqual([`drops ${per * 4} words across the file (limit ${fileLimit})`]);
  });

  it('counts a long token with no spaces (a URL) as the words in it', () => {
    const url = `https://example.com/${ws(45, 's').replace(/ /g, '/')}`;
    expect(v(`See ${url}\n`, 'See the docs.\n')[0]).toMatch(/^drops 4\d words at line 1/);
  });

  it('treats a heading moved into a code fence as removed', () => {
    expect(v('## Safety\n\nNever do X.\n', '```\n## Safety\n```\n\nNever do X.\n')).toEqual([
      'removes, renames, demotes or folds away the heading "## Safety"',
    ]);
  });

  it('does not treat a "# comment" in a fenced block as a heading', () => {
    const doc = '# Doc\n\n```bash\n# start it\nnpm start\n```\n';
    expect(hs(doc)).toEqual(['# Doc']);
    expect(v(doc, doc.replace('# start it\n', '# start the server\n'))).toEqual([]);
  });

  it('recognises setext headings, and converting one to ATX is not a rename', () => {
    const setext = 'Safety\n------\n\nNever do X.\n\nTitle\n=====\n';
    expect(hs(setext)).toEqual(['## Safety', '# Title']);
    // The dropped underline still counts as a removed line (held back, the safe
    // way); what matters here is that no heading reads as renamed.
    expect(v(setext, '## Safety\n\nNever do X.\n\n# Title\n').filter((v) => v.includes('heading'))).toEqual([]);
    // Swapped for the same number of lines, so only the heading rule can see it.
    expect(v(setext, 'Some intro\nmore intro\n\nNever do X.\n\nTitle\n=====\n')).toEqual([
      'removes, renames, demotes or folds away the heading "## Safety"',
    ]);
  });

  it('does not open a fence on a backtick line whose info string has a backtick', () => {
    // CommonMark: "```lang`bad" is not a fence, so the heading after it is real.
    const doc = '```lang`bad\n## Safety\n```\n';
    expect(hs(doc)).toEqual(['## Safety']);
    expect(v(doc, doc.replace('## Safety', 'Safety prose'))).toEqual([
      'removes, renames, demotes or folds away the heading "## Safety"',
    ]);
    // A tilde fence may carry a backtick in its info string, and still hides.
    expect(hs('~~~ lang`ok\n## In code\n~~~\n')).toEqual([]);
  });

  it('reads a leading BOM as nothing and a later one as text, as GitHub does', () => {
    expect(hs('\uFEFF# Safety\n\nText\n\n\uFEFF# Not a heading\n')).toEqual(['# Safety']);
  });

  it('round-1 repros: headings a hand-written parser misread are judged as GitHub renders them', () => {
    const lost = ['removes, renames, demotes or folds away the heading "# Safety"'];
    // A lone CR ends a line, so "# Safety" is a heading of its own.
    expect(v('# Safety\rBody\n', 'Safety\rBody\n')).toEqual(lost);
    // Wrapped in an HTML comment, it is not rendered at all; only lines were added.
    expect(v('# Safety\n', '<!--\n# Safety\n-->\n')).toEqual([...lost, `${HIDES}"Safety"`]);
    // Indented four spaces after a list item, it is the item's heading, not code.
    expect(v('- Item\n\n    # Safety\n', '- Item\n\n    Safety\n')).toEqual(lost);
    // A BOM on a later line makes it prose.
    expect(v('# Safety\n', '\n\uFEFF# Safety\n')).toEqual(lost);
  });

  // Round-1 review repros (codex gpt-6-sol): text the page stops showing while
  // the source keeps every word, so no source word check can see it.
  it('holds back text hidden in an HTML comment or a closed <details>, which the source still holds', () => {
    // A section folded into a collapsed block: both headings still render.
    const guide = '# Guide\n\n## Safety\nKeep keys private.\n';
    const folded = '# Guide\n\n<details>\n<summary>Archived</summary>\n\n## Safety\nKeep keys private.\n\n</details>\n';
    expect(hs(folded)).toEqual(['# Guide', '## Safety (in a closed <details>)']);
    expect(v(guide, folded)).toEqual([
      'removes, renames, demotes or folds away the heading "## Safety"',
      `${HIDES}"Safety Keep keys private"`,
    ]);
    // Shown open, nothing is hidden; nor is new text added in a closed block.
    expect(v(guide, folded.replace('<details>', '<details open>'))).toEqual([]);
    expect(v(guide, `${guide}\n<details>\n<summary>More</summary>\n\nNew notes.\n\n</details>\n`)).toEqual([]);
    // A paragraph wrapped in a comment, and an existing comment stretched over one.
    const safety = '# Guide\n\n## Safety\nNever expose secrets.\n';
    expect(v(safety, '# Guide\n\n## Safety\n<!--\nNever expose secrets.\n-->\n')).toEqual([`${HIDES}"Never expose secrets"`]);
    expect(v('<!-- note -->\nNever expose secrets.\n', '<!-- note\nNever expose secrets. -->\n')).toEqual([`${HIDES}"Never expose secrets"`]);
    // Round-2 repro: labelling a bare URL hides nothing; the link still shows where it goes.
    expect(v('See https://example.com/docs.\n', 'See the [docs](https://example.com/docs).\n')).toEqual([]);
    // Reworded text is the word checks' business, not this one.
    expect(v('Never expose secrets.\n', 'Do not expose secrets.\n')).toEqual([]);
  });

  it('reads the words a page shows: no comments, attributes or closed <details> bodies', () => {
    const html = '<p>A <a href="https://site.example/docs" title="gone">docs</a> &amp; <code><span>foo</span><span>bar</span></code>'
      + ' <a href="#anchor">here</a> <img src="x.png" alt="Alt words"></p>\n'
      + '<!-- gone -->\n<details><summary>Shown</summary><p>folded</p><details open><summary>inner</summary><p>deep</p></details></details>\n'
      + '<details open><summary>Top</summary><p>visible</p><details><summary>nested</summary><p>closed</p></details></details>\n';
    // A link adds the words of its target its text lacks; an in-page anchor adds none.
    expect(visibleWords(html)).toEqual(['A', 'docs', 'https', 'site', 'example', 'foobar', 'here', 'Alt', 'words', 'Shown', 'Top', 'visible', 'nested']);
  });

  it('round-2 repros: a heading folded away under a summary that repeats it, and an image heading renamed', () => {
    const folded = '<details><summary>Recovery</summary>\n\n## Recovery\n\n</details>\n';
    expect(hs(folded)).toEqual(['## Recovery (in a closed <details>)']);
    expect(v('## Recovery\n', folded)).toEqual(['removes, renames, demotes or folds away the heading "## Recovery"']);
    expect(v('## Recovery\n', folded.replace('<details>', '<details open>'))).toEqual([]);
    const img = (alt) => `## ![${alt}](https://example.com/safety.png)\n`;
    expect(hs(img('Safety'))).toEqual(['## Safety']);
    expect(v(img('Safety'), img('Danger'))).toContain('removes, renames, demotes or folds away the heading "## Safety"');
  });

  it('counts headings, so losing one of two identical headings is a loss', () => {
    expect(v('## Safety\n\n## Safety\n', '## Safety\n\nSafety\n')).toEqual([
      'removes, renames, demotes or folds away the heading "## Safety"',
    ]);
  });

  it('also judges the body after front matter on its own, as GitHub\'s file view shows it', () => {
    // Read whole, the "```" in the block opens a fence that hides everything
    // after it. GitHub's file view takes the block as front matter and renders
    // "# Safety" after it, so turning it into prose loses a heading.
    const doc = '---\n```\n---\n# Safety\n\nSteps.\n';
    expect(hs(doc)).toEqual([]);
    expect(v(doc, doc.replace('# Safety', 'Safety'))).toEqual(['removes, renames, demotes or folds away the heading "# Safety"']);
  });

  it('holds the change back when the API cannot be asked, or no longer marks headings as it did', () => {
    const failing = () => { throw new Error('HTTP 403, rate limited'); };
    expect(violations('# A\n', '# A\n\nMore.\n', DEFAULT_MAX_DROPPED_WORDS, failing)).toEqual([
      'could not be checked with GitHub\'s Markdown API, so it is held back: HTTP 403, rate limited',
    ]);
    // Markup the guard cannot read would show no headings on either side and
    // pass everything; the canary turns that into a hold.
    const drifted = (text) => render(text).replace(/<(\/?)h([1-6])\b/g, '<$1div');
    expect(violations('# A\n', 'B\n', DEFAULT_MAX_DROPPED_WORDS, drifted)[0]).toMatch(
      /^could not be checked with GitHub's Markdown API, so it is held back: the API's heading markup changed/,
    );
    expect(hs(CANARY)).toEqual(CANARY_HEADINGS);
    // Round-2 repro: an empty 200 for a document with words would read as a
    // page with nothing to lose.
    const empty = (text) => (text === CANARY ? render(text) : '');
    expect(violations('# Safety\n', 'Safety\n', DEFAULT_MAX_DROPPED_WORDS, empty)[0]).toMatch(
      /^could not be checked with GitHub's Markdown API, so it is held back: an empty render of a document with words in it/,
    );
    // A document with no words may render empty.
    expect(violations('\n', '\n\n', DEFAULT_MAX_DROPPED_WORDS, empty)).toEqual([]);
  });

  it('holds back any bot change that touches, adds or removes front matter', () => {
    const reason = 'adds, removes or changes the front matter (the bot may not touch it)';
    const doc = '---\nname: thing\ndescription: Old words\n---\n\n# Body\n';
    // Even a one-word value edit in valid YAML. (Read whole, as the Markdown API
    // does, the block is a rule and a setext heading, so that is reworded too.)
    expect(v(doc, doc.replace('Old words', 'New words'))).toContain(reason);
    // Round-3 repro: repairing invalid YAML, which GitHub may render as a "title: [broken" heading.
    const broken = '---\ntitle: [broken\n---\n\nSafety steps follow.\n';
    expect(v(broken, broken.replace('[broken', 'fixed'))).toContain(reason);
    // Removing the block, adding one, and moving a line out of it.
    expect(v(doc, doc.replace(/^---\n[^]*?\n---\n/, ''))).toContain(reason);
    expect(v('# A\n\ntext\n', '---\n# A\n---\n\ntext\n')).toEqual(
      expect.arrayContaining([reason, 'removes, renames, demotes or folds away the heading "# A"']),
    );
    expect(v(doc, '---\nname: thing\n---\ndescription: Old words\n\n# Body\n')).toContain(reason);
    // A reader that only takes a bare "---" as the closer ends the block later
    // than "..." or "--- ": the freeze reaches the furthest closer, so repairing
    // YAML there (which can hide "# Safety" from GitHub's render) is held back.
    const late = '---\na: 1\n...\n--- \ntitle: [broken\n# Safety\n---\n\n# Body\n';
    expect(v(late, late.replace('[broken', 'fixed'))).toContain(reason);
    // Adding a BOM in front of the block changes it too.
    expect(v(doc, `\uFEFF${doc}`)).toContain(reason);
    // The body after unchanged front matter stays editable, as does a file without any.
    expect(v(doc, `${doc}\nMore words.\n`)).toEqual([]);
    expect(v('# Body\n', '# Body\n\nMore words.\n')).toEqual([]);
    // A CRLF-to-LF change of the same block is no change.
    expect(v(doc.replace(/\n/g, '\r\n'), doc)).toEqual([]);
  });

  it('sees a BOM-prefixed first heading, so hiding or deleting it is held back', () => {
    // Round-3 repro: GitHub renders "\uFEFF# Safety" as a heading.
    const head = '\uFEFF# Safety\n\nSafety steps follow.\n';
    const bot = '---\n# Safety\ntitle: Guide\n---\n\nSafety steps follow.\n';
    expect(v(head, bot)).toContain('removes, renames, demotes or folds away the heading "# Safety"');
    expect(v(head, 'Safety steps follow.\n')).toContain('removes, renames, demotes or folds away the heading "# Safety"');
    // A BOM on a later line is not stripped: GitHub renders that line as prose.
    expect(v('# Safety\n', '\n\uFEFF# Safety\n')).toContain('removes, renames, demotes or folds away the heading "# Safety"');
    // Nor is a BOM-prefixed "---" a closer: the bot's later "---" would close the
    // block and hide "# Safety", which the unclosed head renders.
    const unclosed = '---\n# Safety\ntitle: [\n\uFEFF---\n]\n\n';
    expect(v(unclosed, `${unclosed}---\n`)).toEqual(expect.arrayContaining([
      'adds, removes or changes the front matter (the bot may not touch it)',
      'removes, renames, demotes or folds away the heading "# Safety"',
    ]));
  });

  it('reads CRLF headings: a line-ending change passes, a deleted heading does not', () => {
    const lf = '# A\n\n## B ##\n\ntext\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(hs(crlf)).toEqual(['# A', '## B']);
    expect(v(crlf, lf)).toEqual([]);
    expect(v(crlf, crlf.replace('## B ##', 'Bee text'))).toEqual([
      'removes, renames, demotes or folds away the heading "## B"',
    ]);
  });
});

describe('docs-bot-guard: GitHub\'s Markdown API', () => {
  // `gh api --include` output captured from the real API on 2026-11-04
  // (headers trimmed). gh prints the status line with LF and the rest with CRLF.
  const ok = {
    status: 0,
    stdout: 'HTTP/2.0 200 OK\nContent-Type: text/html;charset=utf-8\r\nX-Ratelimit-Remaining: 4999\r\n\r\n'
      + '<div class="markdown-heading"><h1 class="heading-element">Safety</h1><a id="user-content-safety" class="anchor" aria-label="Permalink: Safety" href="#safety"><span aria-hidden="true" class="octicon octicon-link"></span></a></div>\n<p>Text</p>\n',
    stderr: '',
  };
  const badRequest = {
    status: 1,
    stdout: 'HTTP/2.0 400 Bad Request\nContent-Type: application/json; charset=utf-8\r\nX-Ratelimit-Remaining: 4976\r\n\r\n'
      + '{"message":"Invalid rendering mode","documentation_url":"https://docs.github.com/v3/markdown/","status":"400"}',
    stderr: 'gh: Invalid rendering mode (HTTP 400)\n',
  };

  it('reads the HTML of a 200, and holds on anything else with the reason', () => {
    expect(renderedHeadings(readGhResponse(ok))).toEqual(['# Safety']);
    expect(() => readGhResponse(badRequest)).toThrow(/^GitHub's Markdown API answered HTTP 400 \(gh exit 1\): gh: Invalid rendering mode/);
    // A rate limit, in the shape GitHub documents (403 or 429, remaining 0).
    const limited = {
      status: 1,
      stdout: 'HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\r\n\r\n{"message":"API rate limit exceeded"}',
      stderr: 'gh: API rate limit exceeded (HTTP 403)\n',
    };
    expect(() => readGhResponse(limited)).toThrow(/HTTP 403, rate limited/);
    expect(() => readGhResponse({ ...ok, status: 0, stdout: ok.stdout.replace('200 OK', '202 Accepted') })).toThrow(/HTTP 202/);
    // gh missing, killed by the timeout, or exiting non-zero with a 200 line.
    expect(() => readGhResponse({ error: new Error('spawnSync gh ENOENT'), status: null, stdout: '' })).toThrow(/gh api did not run: spawnSync gh ENOENT/);
    expect(() => readGhResponse({ ...ok, status: 1 })).toThrow(/HTTP 200 \(gh exit 1\)/);
    expect(() => readGhResponse({ status: 0, stdout: '', stderr: '' })).toThrow(/HTTP with no status line/);
    // Round-1 review repro: a 200 whose body is not HTML would read as a page
    // with no headings and no words, and pass anything.
    const json = { ...ok, stdout: 'HTTP/2.0 200 OK\nContent-Type: application/json\r\n\r\n{"message":"render unavailable"}' };
    expect(() => readGhResponse(json)).toThrow(/HTTP 200, not as HTML \(gh exit 0\): \{"message":"render unavailable"\}/);
    expect(() => readGhResponse({ ...ok, stdout: ok.stdout.replace(/Content-Type[^\r]*\r\n/, '') })).toThrow(/not as HTML/);
  });

  it('holds a bot edit back, through the CLI, when no render can be had', () => {
    const s = scenario({});
    s.edit('README.md', (t) => t.replace('Intro paragraph.', 'Intro paragraph, adjusted.'));
    const empty = path.join(s.cwd, '.git', 'no-renders.json');
    fs.writeFileSync(empty, '{"renders":{}}\n');
    const r = s.run(undefined, empty, { DOCS_BOT_GUARD_RECORD: '0' });
    expect(r.status, r.stderr).toBe(0);
    expect(s.read('README.md')).toBe(BASE_README);
    expect(r.dirty).toBe('');
    expect(r.report).toContain('could not be checked with GitHub\'s Markdown API, so it is held back');
  });

  // Runs in CI (CI=true, with GH_TOKEN from test.yml) and wherever
  // DOCS_BOT_GUARD_LIVE=1. In CI a missing token or network fails it rather
  // than skipping: this is the only check that the recordings are still true.
  const live = process.env.CI === 'true' || process.env.DOCS_BOT_GUARD_LIVE === '1';
  it.runIf(live)('the live API still renders the recorded texts the same way', () => {
    const { renders } = JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));
    const texts = [
      CANARY, '# Safety\rBody\n', '<!--\n# Safety\n-->\n', '- Item\n\n    # Safety\n', '\n\uFEFF# Safety\n', '---\n```\n---\n# Safety\n\nSteps.\n',
      '# Guide\n\n<details>\n<summary>Archived</summary>\n\n## Safety\nKeep keys private.\n\n</details>\n',
      '# Guide\n\n## Safety\n<!--\nNever expose secrets.\n-->\n',
      '<details><summary>Recovery</summary>\n\n## Recovery\n\n</details>\n', '## ![Safety](https://example.com/safety.png)\n',
      'See the [docs](https://example.com/docs).\n',
    ];
    for (const text of texts) {
      expect(Object.values(renders).some((r) => r.text === text), `recorded: ${JSON.stringify(text)}`).toBe(true);
      const html = githubRender(text);
      expect(renderedHeadings(html), JSON.stringify(text)).toEqual(hs(text));
      expect(visibleWords(html), JSON.stringify(text)).toEqual(visibleWords(render(text)));
    }
  }, 60_000);
});

describe('docs-bot-guard: the PR comment', () => {
  it('names every held file and stays under GitHub\'s comment limit, however big the proposals', () => {
    const held = Array.from({ length: 5 }, (_, i) => ({
      file: `docs/f${i}.md`,
      reasons: ['removes, renames, demotes or folds away the heading "## X"'],
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
      reasons: Array.from({ length: 2000 }, (_, j) => `removes, renames, demotes or folds away the heading "## Heading ${j}"`),
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

  it('runs the guard against the live API with the step\'s token, never against recordings', () => {
    const step = code.slice(code.indexOf('- name: Guard and validate'));
    expect(step).toMatch(/\n\s+GH_TOKEN: \$\{\{ github\.token \}\}\n/);
    expect(code).not.toContain('--render-fixtures');
    expect(code).not.toContain('DOCS_BOT_GUARD_RECORD');
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
