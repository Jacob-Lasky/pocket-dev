import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// `.github/workflows/claude-docs.yml` is the ONE Claude surface in this repo
// where a hard-pinned model id is correct: CI wants a docs run to be
// reproducible, so it must not drift under a rerun. That is the exact opposite
// of the Dockerfile shortcuts, which must use MOVING aliases — see
// aliases.test.js, and do not "make these consistent".
//
// The pin has a coupling that is invisible in the file and broke a real edit
// on 2026-09-28: `anthropics/claude-code-action` HARD-PINS the Claude Code CLI
// it installs (CLAUDE_CODE_VERSION in its base-action/action.yml), and the CLI
// rejects a model id it predates with HTTP 400 rather than falling back. So
// bumping `--model` alone fails the docs job on every PR. Measured that day:
// build 2.1.266 answered `--model claude-opus-5-5` with
//   API Error: 400 ... version 2.1.280 or newer is required
// while the then-pinned action (v1.0.199) shipped an even older 2.1.239.
//
// Nothing else in this repo reads .github/, so without this file the coupling
// is unguarded and rots red on every PR in the repo at once.
describe('claude-docs workflow model pin', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '../../../.github/workflows/claude-docs.yml'),
    'utf8',
  );

  // Measured by reading base-action/action.yml at each tag in the
  // claude-code-action repo. To extend:
  //   git clone --filter=blob:none --no-checkout \
  //     https://github.com/anthropics/claude-code-action.git /tmp/cca && cd /tmp/cca
  //   git show <tag>:base-action/action.yml | grep -o 'CLAUDE_CODE_VERSION=[^ ]*'
  const ACTION_TAG_CLI = {
    'v1.0.199': '2.1.239',
    'v1.0.216': '2.1.261',
    'v1.0.219': '2.1.266',
    'v1.0.230': '2.1.277',
    'v1.0.231': '2.1.278',
    'v1.0.232': '2.1.280',
    'v1.0.233': '2.1.281',
    'v1.0.235': '2.1.283',
  };

  // The oldest Claude Code build that will serve each model. A model missing
  // here is a HARD FAILURE, not a pass: that is what makes this guard cover the
  // CLASS (any future model bump) rather than only the one that prompted it.
  const MODEL_MIN_CLI = {
    'claude-opus-5': '2.1.0',
    'claude-opus-5-5': '2.1.280',
    'claude-sonnet-5': '2.1.0',
    'claude-fable-5-1': '2.1.0',
  };

  const cmp = (a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };

  // Strip whole-line comments before matching, the same way codex.test.js does
  // and for the same measured reason: this workflow EXPLAINS its own pin in
  // prose that contains the literal `--model`, so a naive scan of the raw file
  // reads the sentence rather than the argument. First version of this test
  // extracted the model id "to", from "DO NOT change --model to a moving
  // alias", and reported it as an unrecorded model.
  const code = workflow
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  const modelMatch = code.match(/--model\s+(\S+)/);
  const actionMatch = code.match(
    /uses:\s*anthropics\/claude-code-action@([0-9a-f]{40})\s*#\s*(v[\d.]+)/,
  );

  it('pins a model and a SHA-pinned action with its tag recorded', () => {
    // The trailing `# vX.Y.Z` is not decoration: a bare 40-char SHA is
    // unreadable, and it is the only thing tying the pin to a version whose
    // bundled CLI anyone can look up.
    expect(modelMatch, 'no --model found in claude_args').not.toBeNull();
    expect(actionMatch, 'action must be SHA-pinned with a # vX.Y.Z comment').not.toBeNull();
  });

  it('uses a hard-pinned model id, never a moving alias', () => {
    // DO NOT "fix" this to opus[1m] to match the Dockerfile. CI determinism is
    // the whole point; the cost is a by-hand bump each release.
    const model = modelMatch[1];
    expect(model).toMatch(/^claude-[a-z]+-\d/);
    expect(model).not.toMatch(/^(opus|sonnet|haiku|fable|best|opusplan)(\[|$)/);
  });

  it('records a CLI floor for the pinned model', () => {
    const model = modelMatch[1];
    expect(
      MODEL_MIN_CLI[model],
      `No CLI floor recorded for "${model}". Measure the oldest Claude Code `
        + 'build that serves it and add it to MODEL_MIN_CLI — do not delete '
        + 'this assertion. An unrecorded model is how the coupling breaks.',
    ).toBeDefined();
  });

  it('records the bundled CLI version for the pinned action tag', () => {
    const tag = actionMatch[2];
    expect(
      ACTION_TAG_CLI[tag],
      `No bundled CLI version recorded for claude-code-action ${tag}. Read it `
        + 'from that tag\'s base-action/action.yml (recipe above) and add it to '
        + 'ACTION_TAG_CLI.',
    ).toBeDefined();
  });

  it('the pinned action ships a CLI new enough for the pinned model', () => {
    // This is the assertion the 2026-09-28 edit would have gone red on.
    const model = modelMatch[1];
    const tag = actionMatch[2];
    const bundled = ACTION_TAG_CLI[tag];
    const floor = MODEL_MIN_CLI[model];
    expect(
      cmp(bundled, floor),
      `claude-code-action ${tag} ships Claude Code ${bundled}, but ${model} `
        + `requires ${floor} or newer. The docs job would 400 on every PR. `
        + 'Bump the action SHA and the model together.',
    ).toBeGreaterThanOrEqual(0);
  });

  it('the header comment names the same action version as the pin', () => {
    // Two copies of the version number exist (header prose + the SHA comment).
    // They must agree, or the prose lies about what is pinned.
    const tag = actionMatch[2];
    expect(workflow).toContain(`claude-code-action ${tag},`);
  });
});
