import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RESTORED_PATHS,
  DEFAULT_MAX_DROPPED_WORDS,
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
function scenario({ base = {}, pr = {}, restore = true }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-guard-test-'));
  dirs.push(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  writeFiles(cwd, { 'CLAUDE.md': BASE_CLAUDE, 'README.md': BASE_README, ...base });
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(cwd, 'checkout', '-q', '-b', 'pr');
  writeFiles(cwd, { 'CLAUDE.md': PR_CLAUDE, ...pr });
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'pr');
  const head = git(cwd, 'rev-parse', 'HEAD').trim();
  if (restore) {
    fs.mkdirSync(path.join(cwd, '.claude-pr'));
    fs.copyFileSync(path.join(cwd, 'CLAUDE.md'), path.join(cwd, '.claude-pr/CLAUDE.md'));
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
