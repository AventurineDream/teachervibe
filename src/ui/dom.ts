/** Small DOM helpers shared by components. */

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
  const active = el.getRootNode() instanceof Document ? document.activeElement : null;
  if (active && el.contains(active) && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.tagName === 'SELECT')) {
    return;
  }
  el.innerHTML = html;
}

export function download(filename: string, content: string, type = 'text/plain'): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function shortSha(commit: string | null): string {
  return commit ? commit.slice(0, 7) : 'local';
}
