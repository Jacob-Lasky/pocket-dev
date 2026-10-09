const crypto = require('crypto');
const os     = require('os');
const { execFile } = require('child_process');
const { cleanName, normalizeLayout } = require('./sessionLayout');

// Autogroup: ask a small model to sort the open sessions into named groups by
// what each conversation is about, then fold its answer into the layout.
//
// The model sees only what the session list already shows a person: each
// session's id, conversation title, last prompt and provider. Never the
// transcript, never the terminal. Those strings already went to the same
// provider when the conversations ran, so this sends nothing new off the box.
//
// The model's answer is UNTRUSTED. applyAutogroup() keeps only ids that are
// live and unplaced, cleans every name through the same gate as a PUT, and the
// whole result goes through normalizeLayout() on the way out, so a hallucinated
// id, a duplicate, or a hostile name cannot reach the layout file.

const TITLE_LIMIT  = 120;
const PROMPT_LIMIT = 300;
const TIMEOUT_MS   = 90_000;

const SYSTEM_PROMPT = [
  'You organise a developer\'s open terminal chat sessions into named groups.',
  'Group by project or topic, so related work sits together.',
  'Reply only through the structured output.',
].join(' ');

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:     { type: 'string' },
          sessions: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'sessions'],
      },
    },
  },
  required: ['groups'],
};

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : null);

// `rows` are describe() rows. Existing group names go in so a rerun keeps the
// user's vocabulary instead of renaming "deephive" to "DeepHive work".
function buildPrompt(rows, layout) {
  const sessions = rows.map((r) => ({
    id:         r.id,
    title:      clip(r.title, TITLE_LIMIT),
    lastPrompt: clip(r.lastPrompt, PROMPT_LIMIT),
    provider:   r.providerLabel || r.provider || null,
  }));
  return [
    'Sort these sessions into groups.',
    'Rules:',
    '- Name each group with 1 to 3 words, preferably the project or repo name (for example "deephive" or "pocket-dev").',
    '- Reuse an existing group name when it fits. Existing groups: ' + JSON.stringify(layout.groups.map((g) => g.name)) + '.',
    '- Every session id appears at most once. Only use ids from the list.',
    '- Leave out a session whose topic is unclear or that would be alone in its group, unless it fits an existing group.',
    '- Prefer a few broad groups over many narrow ones.',
    '',
    'Sessions:',
    JSON.stringify(sessions),
  ].join('\n');
}

function newGroupId() {
  return `g-${crypto.randomBytes(4).toString('hex')}`;
}

// Turns the model's answer into a layout, in three steps that must stay in
// this order:
//
// 1. Collect the proposals BY NAME (case-insensitive), so two proposals that
//    share a name merge before anything is judged on size. Judging each one
//    alone threw away two one-session halves of what is really a pair.
// 2. Keep a proposed group with at least two sessions, or any size if it
//    names an existing group. A new one-session group goes to Ungrouped: such
//    groups are the clutter this feature exists to remove. A reused name keeps
//    the existing group's id, spelling and collapsed state.
// 3. Keep every existing group the model did not name, holding whatever of its
//    sessions the model left alone. Autogroup moves what it has an opinion
//    about and nothing else, so a group made by hand (including one made while
//    the model was thinking, and an empty one waiting to be filled) survives.
//    One is dropped only when the model took every session it had.
function applyAutogroup(layout, result, liveIds) {
  const live     = new Set(liveIds);
  const placed   = new Set();
  const existing = new Map(layout.groups.map((g) => [g.name.toLowerCase(), g]));

  const proposals = new Map();   // lowercased name -> { name, ids }
  for (const proposed of Array.isArray(result?.groups) ? result.groups : []) {
    const name = cleanName(proposed?.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!proposals.has(key)) proposals.set(key, { name, ids: [] });
    const into = proposals.get(key).ids;
    for (const id of Array.isArray(proposed.sessions) ? proposed.sessions : []) {
      if (typeof id === 'string' && live.has(id) && !placed.has(id)) { placed.add(id); into.push(id); }
    }
  }

  const groups    = [];
  const displaced = [];   // members of a reused group that the model put elsewhere or nowhere
  for (const [key, { name, ids }] of proposals) {
    const prior = existing.get(key);
    if (!ids.length || (ids.length < 2 && !prior)) {
      for (const id of ids) placed.delete(id);
      continue;
    }
    if (prior) displaced.push(...prior.sessions.filter((id) => !ids.includes(id)));
    groups.push(prior
      ? { ...prior, sessions: ids }
      : { id: newGroupId(), name, collapsed: false, sessions: ids });
  }

  for (const g of layout.groups) {
    if (groups.some((kept) => kept.id === g.id)) continue;
    const left = g.sessions.filter((id) => !placed.has(id));
    if (left.length || !g.sessions.length) groups.push({ ...g, sessions: left });
  }

  // Ungrouped keeps its order; sessions displaced from a reused group follow.
  const leftovers = [...layout.ungrouped, ...displaced].filter((id) => !placed.has(id));
  return normalizeLayout({ groups, ungrouped: leftovers }, liveIds);
}

// The real classifier: one headless Claude call. No tools, no MCP servers, no
// saved session, and the default system prompt replaced, so the call is a pure
// text-in, JSON-out request that cannot act on anything. Run from the OS temp
// dir so no project instructions are picked up from a checkout.
//
// The prompt goes on STDIN, not argv: session titles are user content and argv
// is visible to every process on the box.
function claudeClassifier(prompt, { timeoutMs = TIMEOUT_MS, bin = 'claude' } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, [
      '-p',
      '--model', 'haiku',
      '--tools', '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--system-prompt', SYSTEM_PROMPT,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(RESULT_SCHEMA),
    ], { cwd: os.tmpdir(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(err.killed ? 'autogroup timed out' : `autogroup failed: ${err.message.split('\n')[0]}`));
      let parsed;
      try { parsed = JSON.parse(stdout); } catch { return reject(new Error('autogroup returned malformed output')); }
      if (parsed.is_error || !parsed.structured_output) return reject(new Error('autogroup returned no groups'));
      resolve(parsed.structured_output);
    });
    // If the CLI exits before reading a prompt bigger than the pipe buffer,
    // the write fails with EPIPE. Unhandled, that error event kills the whole
    // server; handled, the exit callback above reports the failure as a 502.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

module.exports = { buildPrompt, applyAutogroup, claudeClassifier, newGroupId, RESULT_SCHEMA, SYSTEM_PROMPT };
