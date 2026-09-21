/**
 * <reader-pane> - the reading surface. Read-only code document: Prism token
 * color, line numbers, line-range selection for quoting/annotation, margin
 * markers, in-file search, deep links. Selection never edits.
 */

import Prism from 'prismjs';
import 'prismjs/components/prism-markup.js';
import 'prismjs/components/prism-css.js';
import 'prismjs/components/prism-clike.js';
import 'prismjs/components/prism-javascript.js';
import 'prismjs/components/prism-jsx.js';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-tsx.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-markdown.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-yaml.js';
import 'prismjs/components/prism-rust.js';
import 'prismjs/components/prism-go.js';
import 'prismjs/components/prism-ruby.js';
import 'prismjs/components/prism-sql.js';
import 'prismjs/components/prism-toml.js';
import 'prismjs/components/prism-java.js';
import 'prismjs/components/prism-c.js';
import 'prismjs/components/prism-cpp.js';
import 'prismjs/components/prism-csharp.js';
import 'prismjs/components/prism-swift.js';
import 'prismjs/components/prism-kotlin.js';

import type { AnchorResolution } from '../contracts/anchor.js';
import type { Annotation } from '../contracts/schema.js';
import type { App } from '../store/actions.js';
import type { AppState } from '../store/state.js';
import { prismLanguageFor } from '../sources/classify.js';
import { escapeHtml, copyText, shortSha } from './dom.js';

const TYPE_GLYPHS: Record<string, string> = {
  note: 'N',
  question: '?',
  request: 'R',
  decision: 'D',
  concern: '!'
};

export class ReaderPane extends HTMLElement {
  private app: App | null = null;
  private unsubscribe: (() => void) | null = null;
  private wrap = false;
  private dragAnchor: number | null = null;
  private resolutions = new Map<string, AnchorResolution>();
  private resolutionsFor = '';

  connect(app: App): void {
    this.app = app;
    this.unsubscribe?.();
    this.unsubscribe = app.store.subscribe((s) => this.render(s));
    this.tabIndex = 0;

    this.addEventListener('mousedown', (e) => {
      // Interactive elements (margin markers, buttons) handle their own clicks;
      // a selection change here would re-render and swallow the click.
      if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
      const ln = (e.target as HTMLElement).closest<HTMLElement>('[data-line]');
      if (!ln || !this.app) return;
      const line = Number(ln.dataset['line']);
      const sel = this.app.store.get().selection;
      if (e.shiftKey && sel) {
        this.app.selectRange(sel.start, line);
      } else {
        this.app.selectRange(line, line);
        this.dragAnchor = line;
      }
      e.preventDefault();
    });
    this.addEventListener('mouseover', (e) => {
      // Require a held button: re-renders replace the DOM under a stationary
      // pointer, which fires mouseover without a real drag.
      if (this.dragAnchor === null || !this.app || !(e.buttons & 1)) return;
      const ln = (e.target as HTMLElement).closest<HTMLElement>('[data-line]');
      if (!ln) return;
      this.app.selectRange(this.dragAnchor, Number(ln.dataset['line']), { updateHash: false });
    });
    window.addEventListener('mouseup', () => {
      if (this.dragAnchor !== null && this.app) {
        const sel = this.app.store.get().selection;
        this.dragAnchor = null;
        if (sel) this.app.selectRange(sel.start, sel.end);
      }
    });
    this.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-pane]');
      if (!el || !this.app) return;
      const action = el.dataset['pane'];
      if (action === 'wrap') {
        this.wrap = !this.wrap;
        this.render(this.app.store.get());
      } else if (action === 'copy-link') {
        void copyText(location.href).then((ok) => this.app?.setStatus(ok ? 'Deep link copied.' : 'Copy failed.'));
      } else if (action === 'annotate') {
        this.app.beginDraft();
      } else if (action === 'clear') {
        this.app.clearSelection();
      } else if (action === 'marker') {
        this.app.openAnnotation(el.dataset['id']!);
      } else if (action === 'search-next') {
        this.jumpToMatch(1);
      } else if (action === 'search-prev') {
        this.jumpToMatch(-1);
      }
    });
    this.addEventListener('input', (e) => {
      const input = (e.target as HTMLElement).closest<HTMLInputElement>('[data-search]');
      if (input) this.app?.setSearch(input.value);
    });
    this.addEventListener('keydown', (e) => {
      if (!this.app) return;
      if ((e.target as HTMLElement).tagName === 'INPUT') {
        if (e.key === 'Enter') this.jumpToMatch(e.shiftKey ? -1 : 1);
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      const sel = this.app.store.get().selection;
      const lineCount = this.lineCount();
      const k = e.key.toLowerCase(); // Shift+J reports e.key as 'J'
      if (k === 'j' || e.key === 'ArrowDown' || k === 'k' || e.key === 'ArrowUp') {
        const delta = k === 'j' || e.key === 'ArrowDown' ? 1 : -1;
        const base = sel ? (e.shiftKey ? sel.end : sel.start) : delta > 0 ? 0 : lineCount + 1;
        const next = Math.min(lineCount, Math.max(1, base + delta));
        if (e.shiftKey && sel) this.app.selectRange(sel.start, next);
        else this.app.selectRange(next, next);
        this.scrollToLine(next);
        e.preventDefault();
      } else if (e.key === 'a' && sel) {
        this.app.beginDraft();
        e.preventDefault();
      } else if (e.key === 'Escape') {
        this.app.clearSelection();
      } else if (e.key === '/') {
        this.querySelector<HTMLInputElement>('[data-search]')?.focus();
        e.preventDefault();
      }
    });
  }

  private lineCount(): number {
    const f = this.app?.store.get().file;
    return f?.state === 'text' ? f.text!.split('\n').length : 0;
  }

  private matchLines(): number[] {
    const state = this.app!.store.get();
    const q = state.searchQuery.trim().toLowerCase();
    if (!q || state.file?.state !== 'text') return [];
    const out: number[] = [];
    state.file.text!.split('\n').forEach((l, i) => {
      if (l.toLowerCase().includes(q)) out.push(i + 1);
    });
    return out;
  }

  private jumpToMatch(dir: 1 | -1): void {
    const matches = this.matchLines();
    if (matches.length === 0 || !this.app) return;
    const sel = this.app.store.get().selection;
    const cur = sel?.start ?? 0;
    const next = dir === 1 ? matches.find((m) => m > cur) ?? matches[0]! : [...matches].reverse().find((m) => m < cur) ?? matches[matches.length - 1]!;
    this.app.selectRange(next, next);
    this.scrollToLine(next);
  }

  private scrollToLine(line: number): void {
    this.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' });
  }

  private annotationsForFile(state: AppState): Annotation[] {
    if (!state.file) return [];
    return state.annotations.filter(
      (a) =>
        a.anchor.path === state.file!.record.path &&
        (state.typeFilter.size === 0 || state.typeFilter.has(a.type)) &&
        (state.statusFilter.size === 0 || state.statusFilter.has(a.status))
    );
  }

  private async refreshResolutions(state: AppState): Promise<void> {
    if (!this.app || state.file?.state !== 'text') return;
    const key = `${state.snapshot?.commit}:${state.file.record.path}:${state.file.text!.length}:${state.annotations.length}`;
    if (key === this.resolutionsFor) return;
    this.resolutionsFor = key;
    this.resolutions = await this.app.recheckAnchorsForCurrentFile();
    this.render(this.app.store.get());
  }

  private render(state: AppState): void {
    // Re-rendering rebuilds the search input; preserve focus and caret across renders.
    const active = document.activeElement as HTMLInputElement | null;
    const searchFocused = active?.matches?.('[data-search]') && this.contains(active);
    const caret = searchFocused ? active!.selectionStart : null;
    this.renderInner(state);
    if (searchFocused) {
      const input = this.querySelector<HTMLInputElement>('[data-search]');
      if (input) {
        input.focus();
        if (caret !== null) input.setSelectionRange(caret, caret);
      }
    }
  }

  private renderInner(state: AppState): void {
    if (!state.snapshot) {
      this.innerHTML = `<div class="pane-empty">
        <p>This is a reading surface for repositories. Open one to start.</p>
        <ul>
          <li>Paste <code>owner/repo</code> or a GitHub URL above</li>
          <li>Paste a Forgejo repository URL</li>
          <li>Or open a local folder</li>
        </ul>
        <p class="fine">Sessions pin to an exact commit. Annotations stay in this browser until you export them.</p>
      </div>`;
      this.resolutionsFor = '';
      return;
    }
    const file = state.file;
    let body = '';
    if (!file) {
      body = `<div class="pane-empty">No readable text files in this repository.</div>`;
    } else if (file.state === 'loading') {
      body = `<div class="pane-empty">Loading ${escapeHtml(file.record.path)}...</div>`;
    } else if (file.state === 'binary') {
      body = `<div class="pane-empty"><p><strong>Binary file.</strong> ${escapeHtml(file.record.path)} cannot be displayed as text.</p></div>`;
    } else if (file.state === 'unsupported') {
      body = `<div class="pane-empty"><p><strong>Unsupported file.</strong> ${escapeHtml(file.reason ?? '')}</p></div>`;
    } else if (file.state === 'error') {
      body = `<div class="pane-empty"><p><strong>Could not load file.</strong> ${escapeHtml(file.reason ?? '')}</p></div>`;
    } else {
      void this.refreshResolutions(state);
      body = this.renderCode(state, file.text!);
    }

    const hostLink = file && this.app ? hostUrl(this.app, state, file.record.path) : null;
    this.innerHTML = `
      <div class="pane-head">
        <span class="crumb">${file ? escapeHtml(file.record.path) : ''}</span>
        ${file?.record.generated ? '<span class="badge">generated</span>' : ''}
        ${file ? `<span class="commit-tag">@${shortSha(state.snapshot.commit)}</span>` : ''}
        <span class="spacer"></span>
        <input type="search" data-search placeholder="Search in file  (/)" value="${escapeHtml(state.searchQuery)}" aria-label="Search in file">
        <button data-pane="search-prev" title="Previous match">&#8593;</button>
        <button data-pane="search-next" title="Next match">&#8595;</button>
        <button data-pane="wrap" aria-pressed="${this.wrap}" title="Toggle line wrap">${this.wrap ? 'unwrap' : 'wrap'}</button>
        ${hostLink ? `<a class="btn-link" href="${escapeHtml(hostLink)}" target="_blank" rel="noreferrer">view on host</a>` : ''}
        <button data-pane="copy-link" title="Copy deep link to this view">copy link</button>
      </div>
      ${state.selection ? `<div class="selection-bar">
        L${state.selection.start}-L${state.selection.end} selected
        <button data-pane="annotate">annotate</button>
        <button data-pane="clear">clear</button>
      </div>` : `<div class="selection-bar" hidden></div>`}
      <div class="code-scroll ${this.wrap ? 'wrap' : ''}">${body}</div>
    `;
    const sel = state.selection;
    if (sel) this.scrollToLine(sel.start);
  }

  private renderCode(state: AppState, text: string): string {
    const path = state.file!.record.path;
    const lang = prismLanguageFor(path);
    const lines = text.split('\n');
    const matches = new Set(this.matchLines());
    const sel = state.selection;
    const byLine = new Map<number, Annotation[]>();
    for (const a of this.annotationsForFile(state)) {
      const res = this.resolutions.get(a.id);
      if (res && res.state === 'moved') continue; // moved anchors surface in the inspector, not guessed onto nearby code
      const startLine = res && res.state !== 'exact' ? res.start.line : a.anchor.start.line;
      const endLine = res && res.state !== 'exact' ? res.end.line : a.anchor.end.line;
      for (let l = startLine; l <= endLine; l++) {
        const list = byLine.get(l) ?? [];
        list.push(a);
        byLine.set(l, list);
      }
    }

    let highlighted: string[];
    const grammar = lang ? Prism.languages[lang] : undefined;
    if (grammar && lang) {
      const full = Prism.highlight(text, grammar, lang).split('\n');
      highlighted = full;
    } else {
      highlighted = lines.map(escapeHtml);
    }

    let html = '<div class="code" role="document" aria-label="File contents">';
    lines.forEach((_, i) => {
      const n = i + 1;
      const cls = ['line'];
      if (sel && n >= sel.start && n <= sel.end) cls.push('selected');
      if (matches.has(n)) cls.push('match');
      const markers = byLine.get(n) ?? [];
      const markerHtml = markers
        .slice(0, 3)
        .map((a) => {
          const stale = a.anchor.commit !== state.snapshot!.commit ? ' stale' : '';
          const res = this.resolutions.get(a.id);
          const relocated = res?.state === 'relocated' ? ' relocated' : '';
          return `<button class="marker type-${a.type}${stale}${relocated}" data-pane="marker" data-id="${a.id}" title="${escapeHtml(a.type)}: ${escapeHtml(a.body.slice(0, 80))}">${TYPE_GLYPHS[a.type] ?? 'N'}</button>`;
        })
        .join('');
      html += `<div class="${cls.join(' ')}" data-line="${n}"><span class="gutter"><span class="ln">${n}</span><span class="marks">${markerHtml}</span></span><span class="lc">${highlighted[i] || ' '}</span></div>`;
    });
    html += '</div>';
    return html;
  }
}

function hostUrl(app: App, state: AppState, path: string): string | null {
  const snapshot = state.snapshot;
  if (!snapshot) return null;
  const s = snapshot.source;
  if (s.kind === 'github') {
    return `https://github.com/${s.owner}/${s.repo}/blob/${snapshot.commit}/${path}`;
  }
  if (s.kind === 'forgejo') {
    return `${s.baseUrl}/${s.owner}/${s.repo}/src/commit/${snapshot.commit}/${path}`;
  }
  return null;
}

export function definePane(): void {
  customElements.define('reader-pane', ReaderPane);
}
