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
//      If the PR itself deletes that file, the bot's edit is held back.
//   3. Every markdown change left is then compared with the PR head, and held
//      back whole if it removes or renames a heading, removes more lines than
//      it adds in any one place, deletes the file, drops more than
//      --max-dropped-words words from any one place or three times that from
//      the whole file, or is not UTF-8 text. This is what makes "the bot can
//      only add or adjust" mechanical rather than a prompt request.
// A held-back change is reverted to the PR head and written to --report as a
// PR comment carrying the bot's proposal. Non-markdown changes outside the
// restored paths are left alone for the workflow's markdown-only check to
// reject loudly. A changed markdown path that is a symlink, submodule or
// directory, a changed file mode (beyond the restore's own, which goes back
// to the PR head's), or a path that is not UTF-8 is nothing the
// bot's Edit/Write tools can produce, so the guard refuses (exit 2) rather
// than judging it. Exit 0 = the working tree now holds only allowed changes;
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
// Many small adjustments can add up to a gutted section, so the whole file has
// a budget too: this many times the per-place limit.
export const FILE_DROPPED_WORDS_FACTOR = 3;

// GitHub rejects a comment body over 65536 characters.
const MAX_REPORT_CHARS = 60000;
const MAX_PROPOSAL_CHARS = 20000;

function git(args, { input, cwd, allowStatus = [0] } = {}) {
  const r = spawnSync('git', args, { input, cwd, maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  if (!allowStatus.includes(r.status)) {
    throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  }
  return r;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

// UTF-8 text of a buffer, or null when it is not valid UTF-8 (binary, Latin-1):
// a lossy decode would map different bytes to the same U+FFFD and hide a change.
function asText(buf) {
  try {
    return utf8.decode(buf);
  } catch {
    return null;
  }
}

// NUL-delimited git output as paths. A path that is not UTF-8 cannot be decoded
// back into the name git knows it by, so it is refused rather than mangled into
// a different path that looks absent.
function zList(buf) {
  const out = [];
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0, start);
    if (end === -1) end = buf.length;
    if (end > start) {
      const name = asText(buf.subarray(start, end));
      if (name === null) {
        throw new Error(`a changed path is not UTF-8 (hex ${buf.subarray(start, end).toString('hex')}); refusing to judge it`);
      }
      out.push(name);
    }
    start = end + 1;
  }
  return out;
}

// The git mode of a path in a commit ('100644', '120000', '160000', ...), or
// null when the commit has no such entry.
function modeAt(rev, file) {
  const out = git(['ls-tree', '-z', rev, '--', file]).stdout;
  const entry = zList(out).find((e) => e.slice(e.indexOf('\t') + 1) === file);
  return entry ? entry.split(' ')[0] : null;
}

// Refuse any change to a markdown path that is not a plain text-file edit: the
// bot's Edit/Write tools cannot make one, and a text comparison cannot see it
// (a symlink and a file holding its target's name have the same bytes).
function assertPlainFile(file) {
  const mode = modeAt('HEAD', file);
  if (mode !== null && mode !== '100644' && mode !== '100755') {
    throw new Error(`${file} is a git ${mode === '120000' ? 'symlink' : `mode ${mode} entry`} at the PR head; refusing to judge a change to it`);
  }
  let st = null;
  try {
    st = fs.lstatSync(file);
  } catch {
    return;
  }
  if (!st.isFile()) {
    throw new Error(`${file} is a ${st.isSymbolicLink() ? 'symlink' : 'directory or special file'} in the working tree; refusing to judge it`);
  }
  if (mode !== null && ((st.mode & 0o111) !== 0) !== (mode === '100755')) {
    throw new Error(`${file} changed its executable bit; refusing to judge it`);
  }
}

// Give a restored regular file the PR head's executable bit. Anything that is
// not a regular file is left for assertPlainFile to refuse.
function matchHeadExecBit(file) {
  const mode = modeAt('HEAD', file);
  if (mode !== '100644' && mode !== '100755') return;
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return;
  }
  if (st.isFile()) fs.chmodSync(file, mode === '100755' ? 0o755 : 0o644);
}

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
    // Run in the scratch dir: comparing two loose files needs no repository,
    // and must not depend on the caller's cwd being a healthy one.
    const r = git(
      ['diff', '--no-index', '--no-color', '--no-ext-diff', '--text', `-U${context}`, '--', a, b],
      { cwd: dir, allowStatus: [0, 1] },
    );
    const out = r.stdout.toString('utf8');
    const at = out.indexOf('\n@@');
    return at === -1 ? '' : out.slice(at + 1);
  });
}

// The bot's change from one version to another as a diff for the report, or ''
// when either side is not text.
function diffOrNote(from, to) {
  const a = from === null ? '' : asText(from);
  const b = asText(to);
  return a === null || b === null ? '' : diffText(a, b, 3);
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

// Words are runs of letters and digits, so a long URL, path or table row with
// no spaces counts as the many words it is, not as one.
const words = (lines) => lines.join(' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
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

// The headings of a markdown text, each normalised to ATX form ("## Title"),
// so converting a setext heading to ATX is not a rename. Lines inside fenced
// code blocks are not headings (a "# comment" in a bash block is code), and
// neither is a line indented four spaces. CRLF is read as LF: a JS `.` does
// not match \r, so without that a CRLF file has no headings at all and
// deleting one would go unseen. A YAML front-matter block (a first line of
// "---" closed by "---" or "..."), as SKILL.md files carry, is metadata: its
// "key: value" line before the closing "---" is not a setext heading. Hiding a
// heading by wrapping it in front matter still fails, because the bot's version
// is read the same way and the heading counts as removed.
export function headings(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let fence = null;
  let start = 0;
  if (/^---[ \t]*$/.test(lines[0] ?? '')) {
    const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(l));
    // Only YAML-shaped lines inside ("key:", indented, "- item"), so a page
    // that merely opens with a "---" rule keeps its "# Title" a heading.
    const yamlish = (l) => l.trim() === '' || /^([A-Za-z0-9_.-]+[ \t]*:|[ \t]|- )/.test(l);
    if (end !== -1 && lines.slice(1, end).every(yamlish)) start = end + 1;
  }
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    // A backtick fence's info string cannot contain a backtick (CommonMark):
    // "```js`x" is inline code, not a fence that would hide the lines after it.
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = open[1];
      continue;
    }
    const atx = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/);
    if (atx) {
      out.push(`${atx[1]} ${(atx[2] ?? '').trim()}`.trimEnd());
      continue;
    }
    const underline = lines[i + 1]?.match(/^ {0,3}(=+|-+)[ \t]*$/);
    if (underline && line.trim() !== '' && !/^ {4}/.test(line)) {
      out.push(`${underline[1][0] === '=' ? '#' : '##'} ${line.trim()}`);
      i += 1;
    }
  }
  return out;
}

// Why a change from oldText to newText is not a pure add-or-adjust. Empty
// array = allowed. A CRLF-to-LF change passes: headings() reads both as LF, and
// each re-ended line is one removed and one added line with the same words.
export function violations(oldText, newText, maxDroppedWords = DEFAULT_MAX_DROPPED_WORDS) {
  const found = [];
  const after = countBy(headings(newText));
  for (const [h, n] of countBy(headings(oldText))) {
    if ((after.get(h) ?? 0) < n) found.push(`removes or renames the heading ${preview(h)}`);
  }
  let droppedInFile = 0;
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
    droppedInFile += dropped;
  }
  const fileLimit = maxDroppedWords * FILE_DROPPED_WORDS_FACTOR;
  if (droppedInFile > fileLimit) {
    found.push(`drops ${droppedInFile} words across the file (limit ${fileLimit})`);
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
    ], { cwd: dir, maxBuffer: 1 << 30 });
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
      // The action's restore also took the base branch's file mode, so a PR
      // that changed this file's executable bit would otherwise read as the
      // bot changing it. The bot cannot set modes; the PR head's mode is kept.
      matchHeadExecBit(file);
      assertPlainFile(file);
      if (head === null && baseBlob !== null) {
        // The PR deletes this file; the bot edited the copy the action restored.
        held.push({
          file,
          reasons: ['this PR deletes the file; the bot edited the copy restored from the base branch'],
          proposal: work === null ? '' : diffOrNote(baseBlob, work),
        });
        resetToHead(file, head);
        continue;
      }
      if (work !== null && [head, baseBlob, work].some((b) => b !== null && asText(b) === null)) {
        held.push({ file, reasons: ['is not UTF-8 text, so the guard cannot judge it'], proposal: '' });
        resetToHead(file, head);
        continue;
      }
      if (work !== null) {
        const { clean, merged } = merge3(head ?? Buffer.alloc(0), baseBlob ?? Buffer.alloc(0), work);
        if (!clean) {
          held.push({
            file,
            reasons: ['conflicts with what this PR changed in the same place'],
            proposal: diffOrNote(baseBlob, work),
          });
          resetToHead(file, head);
          continue;
        }
        fs.writeFileSync(file, merged);
        work = merged;
        log(`${file}: bot edit merged onto the PR head's version`);
      }
    }

    if (!md) continue; // non-markdown: the workflow's markdown-only check rejects it
    assertPlainFile(file);
    const headText = head === null ? '' : asText(head);
    const workText = work === null ? null : asText(work);
    let reasons;
    if (headText === null || (work !== null && workText === null)) {
      reasons = ['is not UTF-8 text, so the guard cannot judge it'];
    } else if (head === null) {
      continue; // a new markdown file: a pure addition
    } else if (work === null) {
      reasons = ['deletes the file'];
    } else {
      reasons = violations(headText, workText, maxDroppedWords);
    }
    if (reasons.length > 0) {
      held.push({
        file,
        reasons,
        proposal: headText !== null && workText !== null ? diffText(headText, workText, 3) : '',
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
      + `It allows additions and in-place adjustments only: no removed headings, no net-removed lines, at most ${maxDroppedWords} dropped words in one place and ${maxDroppedWords * FILE_DROPPED_WORDS_FACTOR} in one file. `
      + 'Nothing below is on the branch. Apply any of it by hand if it is right.',
  ];
  const intro = parts.join('\n');
  // Every held file and its reasons must reach the comment, so the proposals
  // give way first: the largest per-proposal limit whose RENDERED body fits is
  // found by measuring, not estimated, because a proposal's fence grows with
  // the longest backtick run inside it. Rendered length only grows with the
  // limit, so a binary search finds it. Only if the files and reasons alone do
  // not fit are the reasons cut down, and only past that is the body sliced.
  const render = (reasonCap, limit) => [intro, ...held.map((h) => renderHeld(h, reasonCap, limit))].join('\n');
  for (const reasonCap of [20, 3, 1]) {
    if (render(reasonCap, 0).length > MAX_REPORT_CHARS) continue;
    let lo = 0;
    let hi = MAX_PROPOSAL_CHARS;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (render(reasonCap, mid).length <= MAX_REPORT_CHARS) lo = mid;
      else hi = mid - 1;
    }
    return `${render(reasonCap, lo)}\n`;
  }
  const body = render(1, 0);
  return `${body.slice(0, MAX_REPORT_CHARS)}\n\n... (report truncated; every held file is named in the workflow log)\n`;
}

// Markdown code span around text that may itself contain backticks.
function codeSpan(text) {
  const ticks = '`'.repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  return ticks.length > 1 ? `${ticks} ${text} ${ticks}` : `\`${text}\``;
}

// One held file's section: its name, up to reasonCap reasons, and the bot's
// proposal cut to limit characters (limit 0 leaves the proposal out).
function renderHeld(h, reasonCap, limit) {
  const reasons = h.reasons.slice(0, reasonCap).map((r) => `- ${r}`);
  if (h.reasons.length > reasonCap) reasons.push(`- ... and ${h.reasons.length - reasonCap} more (see the workflow log)`);
  const lines = ['', `### ${codeSpan(h.file)}`, '', ...reasons];
  if (h.proposal && limit === 0) {
    lines.push('', '_The bot\'s proposed change is too long for this comment._');
  } else if (h.proposal) {
    const proposal = h.proposal.length > limit ? `${h.proposal.slice(0, limit)}\n... (truncated)` : h.proposal;
    const fence = '`'.repeat(Math.max(3, ...[...proposal.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    lines.push('', '<details><summary>The bot\'s proposed change</summary>', '', `${fence}diff`, proposal.trimEnd(), fence, '', '</details>');
  }
  return lines.join('\n');
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
