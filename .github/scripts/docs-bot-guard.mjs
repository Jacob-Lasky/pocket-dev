#!/usr/bin/env node
// Trusted post-step of the Auto-Document PR workflow (claude-docs.yml): it
// decides which of the docs bot's working-tree edits may be committed onto the
// PR branch. Run from the repository root after the Claude step and before
// anything is staged:
//
//   node docs-bot-guard.mjs --head <PR head sha> --base <origin/base ref> \
//     --report <file> [--max-dropped-words 40]
//
// WHY IT EXISTS. claude-code-action, on a pull_request event, resets every path
// in RESTORED_PATHS (the root CLAUDE.md among them) to the BASE branch before
// Claude starts, because the PR head's copy is untrusted CLI config. It leaves
// that revert unstaged and its own source warns that a caller who stages files
// "must exclude these, or they will commit the revert back onto the PR author's
// branch". The workflow used to `git add -A`, so on #104, #107 and #108 the
// docs commit replaced the PR's CLAUDE.md with main's, deleting the sections
// the PR had just added. It was first blamed on the model ignoring its prompt;
// the bot's CLAUDE.md was byte-identical to main's, plus at most one line.
//
// WHAT IT DOES, for every path that differs from the PR head:
//   1. A restored path the bot did not edit (still equal to the base version,
//      or not markdown, which the bot cannot write) goes back to the PR head.
//   2. A restored markdown file the bot DID edit was edited starting from the
//      base version, so the bot's change is 3-way merged onto the PR head's
//      version (merge base: the base version). A conflict holds it back.
//   3. Every markdown change left is then compared with the PR head, and held
//      back whole if it removes or renames a heading, removes more lines than
//      it adds in any one place, deletes the file, or drops more than
//      --max-dropped-words words from any one place. This is what makes "the
//      bot can only add or adjust" mechanical rather than a prompt request.
// A held-back change is reverted to the PR head and written to --report as a
// PR comment carrying the bot's proposal. Non-markdown changes outside the
// restored paths are left alone for the workflow's markdown-only check to
// reject loudly. Exit 0 = the working tree now holds only allowed changes;
// anything else = do not commit.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// claude-code-action's SENSITIVE_PATHS (src/github/operations/restore-config.ts)
// at the SHA pinned in claude-docs.yml. When that SHA moves, re-read the list;
// docsBotGuard.test.js fails until the new tag is recorded.
export const RESTORED_PATHS = [
  '.claude',
  '.mcp.json',
  '.claude.json',
  '.gitmodules',
  '.ripgreprc',
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.husky',
];

export const DEFAULT_MAX_DROPPED_WORDS = 40;

// GitHub rejects a comment body over 65536 characters.
const MAX_REPORT_CHARS = 60000;
const MAX_PROPOSAL_CHARS = 20000;

function git(args, { input, allowStatus = [0] } = {}) {
  const r = spawnSync('git', args, { input, maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  if (!allowStatus.includes(r.status)) {
    throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  }
  return r;
}

const zList = (buf) => buf.toString('utf8').split('\0').filter(Boolean);

function blobAt(rev, file) {
  const r = spawnSync('git', ['cat-file', 'blob', `${rev}:${file}`], { maxBuffer: 1 << 30 });
  return r.status === 0 ? r.stdout : null;
}

function readWork(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() ? fs.readFileSync(file) : null;
  } catch {
    return null;
  }
}

const same = (a, b) => (a === null || b === null ? a === b : a.equals(b));
const isMarkdown = (file) => file.endsWith('.md');
const isRestored = (file) => RESTORED_PATHS.some((p) => file === p || file.startsWith(`${p}/`));

function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-guard-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Unified diff body (from the first @@) between two texts, or '' when equal.
function diffText(oldText, newText, context) {
  return withTemp((dir) => {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    fs.writeFileSync(a, oldText);
    fs.writeFileSync(b, newText);
    const r = git(
      ['diff', '--no-index', '--no-color', '--no-ext-diff', '--text', `-U${context}`, '--', a, b],
      { allowStatus: [0, 1] },
    );
    const out = r.stdout.toString('utf8');
    const at = out.indexOf('\n@@');
    return at === -1 ? '' : out.slice(at + 1);
  });
}

function hunks(oldText, newText) {
  const result = [];
  let cur = null;
  for (const line of diffText(oldText, newText, 0).split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (m) {
      cur = { oldLine: Number(m[1]), removed: [], added: [] };
      result.push(cur);
    } else if (cur && line.startsWith('-')) {
      cur.removed.push(line.slice(1));
    } else if (cur && line.startsWith('+')) {
      cur.added.push(line.slice(1));
    }
  }
  return result;
}

const words = (lines) => lines.join(' ').split(/\s+/).filter(Boolean);
const nonBlank = (lines) => lines.filter((l) => l.trim() !== '');
const preview = (line) => {
  const t = line.trim();
  return JSON.stringify(t.length > 90 ? `${t.slice(0, 90)}...` : t);
};

function countBy(items) {
  const m = new Map();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return m;
}

// Why a change from oldText to newText is not a pure add-or-adjust. Empty
// array = allowed.
export function violations(oldText, newText, maxDroppedWords = DEFAULT_MAX_DROPPED_WORDS) {
  const found = [];
  const headings = (text) => text.split('\n').filter((l) => /^#{1,6}(\s|$)/.test(l));
  const after = countBy(headings(newText));
  for (const [h, n] of countBy(headings(oldText))) {
    if ((after.get(h) ?? 0) < n) found.push(`removes or renames the heading ${preview(h)}`);
  }
  for (const h of hunks(oldText, newText)) {
    const removed = nonBlank(h.removed);
    const added = nonBlank(h.added);
    if (removed.length > added.length) {
      found.push(
        `removes ${removed.length - added.length} line(s) at line ${h.oldLine}, starting ${preview(removed[0])}`,
      );
    }
    const left = countBy(words(added));
    let dropped = 0;
    for (const w of words(removed)) {
      const n = left.get(w) ?? 0;
      if (n > 0) left.set(w, n - 1);
      else dropped += 1;
    }
    if (dropped > maxDroppedWords) {
      found.push(`drops ${dropped} words at line ${h.oldLine} (limit ${maxDroppedWords}), starting ${preview(removed[0] ?? '')}`);
    }
  }
  return found;
}

function merge3(ours, base, theirs) {
  return withTemp((dir) => {
    const files = { ours, base, theirs };
    for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), buf);
    const r = spawnSync('git', [
      'merge-file', '-p', '-L', 'pr-head', '-L', 'base', '-L', 'docs-bot',
      path.join(dir, 'ours'), path.join(dir, 'base'), path.join(dir, 'theirs'),
    ], { maxBuffer: 1 << 30 });
    if (r.error) throw r.error;
    // Exit status is the number of conflicts; a negative (here >127) is an error.
    if (r.status > 127) throw new Error(`git merge-file failed: ${r.stderr}`);
    return { clean: r.status === 0, merged: r.stdout };
  });
}

function resetToHead(file, head) {
  if (head === null) {
    fs.rmSync(file, { force: true });
  } else {
    git(['checkout', 'HEAD', '--', file]);
  }
}

export function guard({ base, maxDroppedWords = DEFAULT_MAX_DROPPED_WORDS, log = console.log }) {
  if (git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { allowStatus: [0, 1] }).status !== 0) {
    throw new Error(`base ref ${base} does not resolve; refusing to judge the bot's edits without it`);
  }
  const changed = [...new Set([
    ...zList(git(['diff', '--name-only', '-z', '--no-renames', 'HEAD', '--']).stdout),
    ...zList(git(['ls-files', '--others', '--exclude-standard', '-z']).stdout),
  ])].sort();

  const held = [];
  for (const file of changed) {
    const head = blobAt('HEAD', file);
    const baseBlob = blobAt(base, file);
    let work = readWork(file);
    const md = isMarkdown(file);

    if (isRestored(file)) {
      if (!md || same(work, baseBlob)) {
        // The action's restore, untouched by the bot (or a path the bot cannot
        // write). A restored path missing from RESTORED_PATHS still cannot slip
        // through: it falls to the check below and is held back.
        log(`${file}: returned to the PR head (reset by the action, not edited by the bot)`);
        resetToHead(file, head);
        continue;
      }
      if (work !== null) {
        const { clean, merged } = merge3(head ?? Buffer.alloc(0), baseBlob ?? Buffer.alloc(0), work);
        if (!clean) {
          held.push({
            file,
            reasons: ['conflicts with what this PR changed in the same place'],
            proposal: diffText(baseBlob?.toString('utf8') ?? '', work.toString('utf8'), 3),
          });
          resetToHead(file, head);
          continue;
        }
        fs.writeFileSync(file, merged);
        work = merged;
        log(`${file}: bot edit merged onto the PR head's version`);
      }
    }

    if (!md || head === null) continue; // non-markdown: the workflow rejects it; new file: pure addition
    const reasons = work === null
      ? ['deletes the file']
      : violations(head.toString('utf8'), work.toString('utf8'), maxDroppedWords);
    if (reasons.length > 0) {
      held.push({
        file,
        reasons,
        proposal: work === null ? '' : diffText(head.toString('utf8'), work.toString('utf8'), 3),
      });
      resetToHead(file, head);
    }
  }
  for (const h of held) log(`::warning::docs bot change to ${h.file} held back: ${h.reasons.join('; ')}`);
  return held;
}

export function renderReport(held, maxDroppedWords = DEFAULT_MAX_DROPPED_WORDS) {
  const parts = [
    '## Auto-Document PR held back some documentation changes',
    '',
    'The docs bot proposed edits that would remove documentation this PR\'s head already has, '
      + 'so `.github/scripts/docs-bot-guard.mjs` reverted them instead of committing. '
      + `It allows additions and in-place adjustments only: no removed headings, no net-removed lines, at most ${maxDroppedWords} dropped words in one place. `
      + 'Nothing below is on the branch. Apply any of it by hand if it is right.',
  ];
  for (const h of held) {
    let proposal = h.proposal;
    if (proposal.length > MAX_PROPOSAL_CHARS) proposal = `${proposal.slice(0, MAX_PROPOSAL_CHARS)}\n... (truncated)`;
    const ticks = Math.max(3, ...[...proposal.matchAll(/`+/g)].map((m) => m[0].length + 1));
    const fence = '`'.repeat(ticks);
    parts.push('', `### \`${h.file}\``, '', ...h.reasons.map((r) => `- ${r}`));
    if (proposal) {
      parts.push('', '<details><summary>The bot\'s proposed change</summary>', '', `${fence}diff`, proposal.trimEnd(), fence, '', '</details>');
    }
  }
  let body = parts.join('\n');
  if (body.length > MAX_REPORT_CHARS) body = `${body.slice(0, MAX_REPORT_CHARS)}\n\n... (report truncated; see the workflow log)`;
  return `${body}\n`;
}

function parseArgs(argv) {
  const opts = { maxDroppedWords: DEFAULT_MAX_DROPPED_WORDS };
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (v === undefined) throw new Error(`missing value for ${k}`);
    if (k === '--head') opts.head = v;
    else if (k === '--base') opts.base = v;
    else if (k === '--report') opts.report = v;
    else if (k === '--max-dropped-words') opts.maxDroppedWords = Number(v);
    else throw new Error(`unknown argument ${k}`);
  }
  if (!opts.head || !opts.base || !opts.report) throw new Error('--head, --base and --report are required');
  if (!Number.isInteger(opts.maxDroppedWords) || opts.maxDroppedWords < 0) throw new Error('--max-dropped-words must be a non-negative integer');
  return opts;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const head = git(['rev-parse', 'HEAD']).stdout.toString('utf8').trim();
    if (head !== git(['rev-parse', `${opts.head}^{commit}`]).stdout.toString('utf8').trim()) {
      throw new Error(`HEAD is ${head}, not the PR head ${opts.head}; refusing to judge edits against the wrong commit`);
    }
    const held = guard(opts);
    fs.rmSync(opts.report, { force: true });
    if (held.length > 0) fs.writeFileSync(opts.report, renderReport(held, opts.maxDroppedWords));
  } catch (err) {
    console.error(`::error::docs-bot-guard: ${err.message}`);
    process.exit(2);
  }
}
