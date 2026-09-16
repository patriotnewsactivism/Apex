/** Copy text to the clipboard, falling back where the async API is unavailable.
 *
 *  `navigator.clipboard` needs a secure context and a user gesture, and is
 *  absent or rejects outright in a plain-http LAN preview and some in-app
 *  browsers — exactly the places an operator is when they are trying to grab a
 *  log off their phone. The hidden-textarea path still works there. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through
  }
  const el = document.createElement('textarea');
  el.value = text;
  el.style.position = 'fixed';
  el.style.opacity = '0';
  document.body.appendChild(el);
  el.select();
  try {
    document.execCommand('copy');
  } finally {
    el.remove();
  }
}

/** Save text as a downloaded file. */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** `2026-09-06T00-45-12` — safe in a filename on every platform. */
export function fileStamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
