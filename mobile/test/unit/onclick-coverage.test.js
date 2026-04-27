// Guards against the exact bug class that almost shipped on this branch:
// when index.html's `<script>` was converted to `<script type="module">`, all
// function declarations became module-scoped — every HTML inline `onclick="X(..)"`
// silently broke (ReferenceError) because the browser evaluates onclick against
// the global scope. The fix exposes those functions on `window`. This test
// asserts every onclick name has a matching window-exposure so a future rename
// or a new onclick handler can't sneak through without one.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const indexHtml  = fs.readFileSync(path.resolve(__dirname, '../../public/index.html'), 'utf8');

function extractOnclickFunctionNames(html) {
  // Match onclick="name(" or onclick="name (" — capture the bare identifier before the paren.
  const re = /onclick\s*=\s*"([A-Za-z_$][\w$]*)\s*\(/g;
  const names = new Set();
  let m;
  while ((m = re.exec(html)) !== null) names.add(m[1]);
  return names;
}

function extractWindowExposedNames(html) {
  const exposed = new Set();
  // Pattern A: `window.X = ...` (direct assignment)
  for (const m of html.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) exposed.add(m[1]);
  // Pattern B: `Object.assign(window, { a, b, c, ... })` — capture identifier list inside the braces.
  const blockMatch = html.match(/Object\.assign\s*\(\s*window\s*,\s*\{([\s\S]*?)\}\s*\)/);
  if (blockMatch) {
    for (const m of blockMatch[1].matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) exposed.add(m[1]);
  }
  return exposed;
}

describe('HTML inline onclick handlers', () => {
  const onclickNames = extractOnclickFunctionNames(indexHtml);
  const exposedNames = extractWindowExposedNames(indexHtml);

  it('extracts at least one onclick handler (sanity)', () => {
    expect(onclickNames.size).toBeGreaterThan(0);
  });

  it('extracts at least one window-exposed name (sanity)', () => {
    expect(exposedNames.size).toBeGreaterThan(0);
  });

  it('every onclick="X(" function is exposed on window', () => {
    const missing = [...onclickNames].filter(n => !exposedNames.has(n));
    expect(missing, `Functions referenced in HTML onclick but not exposed on window: ${missing.join(', ')}`).toEqual([]);
  });
});
