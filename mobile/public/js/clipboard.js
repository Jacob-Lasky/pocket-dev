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
