/** Small DOM helpers shared by components. */

/** Escapes `& < > " '` for safe interpolation into HTML text and attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Replace a component's innerHTML unless focus is inside it (typing in the
 * inspector must never be interrupted by a re-render).
 */
export function renderUnlessFocused(el: HTMLElement, html: string): void {
  const active =
    el.getRootNode() instanceof Document ? document.activeElement : null;
  if (
    active &&
    el.contains(active) &&
    (active.tagName === 'TEXTAREA' ||
      active.tagName === 'INPUT' ||
      active.tagName === 'SELECT')
  ) {
    return;
  }
  el.innerHTML = html;
}

/** Downloads `content` as a file via a temporary object URL (revoked after 5 s). */
export function download(
  filename: string,
  content: string,
  type = 'text/plain'
): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Copies to the clipboard; resolves false (never throws) when the clipboard API is unavailable or denied. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** First 7 characters of a commit SHA, or 'local' for local folders (null commit). */
export function shortSha(commit: string | null): string {
  return commit ? commit.slice(0, 7) : 'local';
}
