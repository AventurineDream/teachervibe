/**
 * <reader-nav> - left rail with three switchable views: Files, Outline, Trail.
 * Generated, vendored, and binary areas render muted; the tree is read-only.
 */

import type { App } from '../store/actions.js';
import type { AppState } from '../store/state.js';
import { prismLanguageFor } from '../sources/classify.js';
import { escapeHtml } from './dom.js';

type Tab = 'files' | 'outline' | 'trail';

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  blob: boolean;
  binary: boolean;
  generated: boolean;
}

function buildTree(paths: { path: string; binary: boolean; generated: boolean; type: string }[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: [], blob: false, binary: false, generated: false };
  const dirs = new Map<string, TreeNode>();
  dirs.set('', root);
  for (const f of paths) {
    const parts = f.path.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const parentPath = prefix;
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]!;
      if (!dirs.has(prefix)) {
        const node: TreeNode = { name: parts[i]!, path: prefix, children: [], blob: false, binary: false, generated: false };
        dirs.set(prefix, node);
        dirs.get(parentPath)!.children.push(node);
      }
    }
    if (f.type === 'blob') {
      dirs.get(prefix)!.children.push({
        name: parts[parts.length - 1]!,
        path: f.path,
        children: [],
        blob: true,
        binary: f.binary,
        generated: f.generated
      });
    }
  }
  return root;
}

interface OutlineItem {
  label: string;
  line: number;
  depth: number;
}

/** Cheap heuristic outline: Markdown headings, and top-level JS/TS-style declarations. */
export function outlineFor(path: string, text: string): OutlineItem[] {
  const lines = text.split('\n');
  const items: OutlineItem[] = [];
  const lang = prismLanguageFor(path);
  if (lang === 'markdown') {
    lines.forEach((l, i) => {
      const m = l.match(/^(#{1,6})\s+(.+)/);
      if (m) items.push({ label: m[2]!.trim(), line: i + 1, depth: m[1]!.length });
    });
    return items;
  }
  const decl = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;
  lines.forEach((l, i) => {
    const m = l.match(decl);
    if (m) items.push({ label: m[1]!, line: i + 1, depth: 1 });
  });
  return items;
}

export class ReaderNav extends HTMLElement {
  private app: App | null = null;
  private tab: Tab = 'files';
  private collapsed = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  connect(app: App): void {
    this.app = app;
    this.unsubscribe?.();
    this.unsubscribe = app.store.subscribe((s) => this.render(s));
    this.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
      if (!el || !this.app) return;
      const kind = el.dataset['nav']!;
      if (kind === 'tab') {
        this.tab = el.dataset['tab'] as Tab;
        this.render(this.app.store.get());
      } else if (kind === 'file') {
        void this.app.openFile(el.dataset['path']!, null);
        this.app.setDrawer(null);
      } else if (kind === 'dir') {
        const p = el.dataset['path']!;
        if (this.collapsed.has(p)) this.collapsed.delete(p);
        else this.collapsed.add(p);
        this.render(this.app.store.get());
      } else if (kind === 'line') {
        const line = Number(el.dataset['line']);
        this.app.selectRange(line, line);
        this.app.setDrawer(null);
      } else if (kind === 'trail') {
        void this.app.openFile(
          el.dataset['path']!,
          el.dataset['start'] ? { start: Number(el.dataset['start']), end: Number(el.dataset['end']) } : null
        );
        this.app.setDrawer(null);
      }
    });
  }

  private render(state: AppState): void {
    if (!state.snapshot) {
      this.innerHTML = `<div class="rail-empty">Open a repository to start reading.</div>`;
      return;
    }
    const tabs: [Tab, string][] = [
      ['files', 'Files'],
      ['outline', 'Outline'],
      ['trail', 'Trail']
    ];
    let html = `<div class="tabs" role="tablist">`;
    for (const [id, label] of tabs) {
      html += `<button role="tab" aria-selected="${this.tab === id}" data-nav="tab" data-tab="${id}">${label}</button>`;
    }
    html += `</div><div class="rail-body">`;
    if (this.tab === 'files') html += this.renderFiles(state);
    else if (this.tab === 'outline') html += this.renderOutline(state);
    else html += this.renderTrail(state);
    html += `</div>`;
    this.innerHTML = html;
  }

  private renderFiles(state: AppState): string {
    const root = buildTree(state.snapshot!.tree);
    if (root.children.length === 0) return `<div class="rail-empty">Empty tree.</div>`;
    const current = state.file?.record.path;
    const walk = (node: TreeNode): string => {
      let html = '';
      const sorted = [...node.children].sort((a, b) => Number(b.blob) - Number(a.blob) || a.name.localeCompare(b.name));
      for (const child of sorted) {
        if (!child.blob) {
          const closed = this.collapsed.has(child.path);
          html += `<div class="tree-dir">
            <button class="tree-row dir" data-nav="dir" data-path="${escapeHtml(child.path)}" aria-expanded="${!closed}">
              <span class="twisty">${closed ? '&#9656;' : '&#9662;'}</span> ${escapeHtml(child.name)}/
            </button>`;
          if (!closed) html += `<div class="tree-kids">${walk(child)}</div>`;
          html += `</div>`;
        } else {
          const cls = ['tree-row', 'file'];
          if (child.path === current) cls.push('current');
          if (child.generated) cls.push('muted');
          const badge = child.binary ? ' <span class="badge">binary</span>' : child.generated ? ' <span class="badge">generated</span>' : '';
          html += `<button class="${cls.join(' ')}" data-nav="file" data-path="${escapeHtml(child.path)}">${escapeHtml(child.name)}${badge}</button>`;
        }
      }
      return html;
    };
    const truncated = state.snapshot!.truncated ? `<div class="rail-note">Tree listing truncated by the host API.</div>` : '';
    return truncated + walk(root);
  }

  private renderOutline(state: AppState): string {
    if (!state.file || state.file.state !== 'text') {
      return `<div class="rail-empty">Open a text file to see its outline.</div>`;
    }
    const items = outlineFor(state.file.record.path, state.file.text!);
    if (items.length === 0) return `<div class="rail-empty">No headings or declarations found (heuristic outline).</div>`;
    return items
      .map(
        (it) =>
          `<button class="tree-row outline-item depth-${Math.min(it.depth, 6)}" data-nav="line" data-line="${it.line}">${escapeHtml(it.label)}<span class="ln-ref">:${it.line}</span></button>`
      )
      .join('');
  }

  private renderTrail(state: AppState): string {
    if (state.trail.length === 0) return `<div class="rail-empty">Files you open will appear here.</div>`;
    return [...state.trail]
      .reverse()
      .map((t) => {
        const range = t.range ? `:${t.range.start}-${t.range.end}` : '';
        return `<button class="tree-row trail-item" data-nav="trail" data-path="${escapeHtml(t.path)}"${
          t.range ? ` data-start="${t.range.start}" data-end="${t.range.end}"` : ''
        }>${escapeHtml(t.path)}<span class="ln-ref">${range}</span></button>`;
      })
      .join('');
  }
}

export function defineNav(): void {
  customElements.define('reader-nav', ReaderNav);
}
