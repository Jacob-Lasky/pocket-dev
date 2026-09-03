// pocket-dev clipboard helper
// Exports a single async writer that strips trailing whitespace per line
// and falls back to document.execCommand('copy') on HTTP where
// navigator.clipboard is unavailable.

export function trimTrailingWhitespace(text) {
  return text.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');
}

function defaultExecCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  document.body.removeChild(ta);
  return ok;
}

export async function clipboardWrite(text, { execCopy = defaultExecCopy } = {}) {
  const clean = trimTrailingWhitespace(text);
  // REFUSE an empty write instead of performing one. `writeText('')` RESOLVES,
  // so an empty copy is indistinguishable from a successful one: the clipboard
  // is silently replaced with nothing and `copyAllOutput` flashes the success
  // tick, which is the worst possible report of "I threw away what you had".
  // Returning false makes the button flash the failure mark and leaves whatever
  // the user had copied intact.
  //
  // Found from a CI failure that read `Expected substring: "clipboard-test-marker"
  // / Received string: ""` while the write had already been asserted to resolve.
  // Tested on the TRIMMED-ALL value, not on `clean`. trimTrailingWhitespace only
  // strips each line's tail, so a screen of blanks becomes '\n\n' and is truthy:
  // guarding on `clean` alone would still clobber the clipboard, just with junk
  // instead of nothing. What gets written is still `clean`, so indentation and
  // interior blank lines survive.
  if (!clean.trim()) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(clean);
      return true;
    } catch {
      return execCopy(clean);
    }
  }
  return execCopy(clean);
}
