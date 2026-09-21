/**
 * <reader-inspector> - write and manage the selected annotation, browse the
 * annotations on the open file, and see the full anchor identity for each.
 * Also owns type/status filters and the moved/stale-anchor states.
 */

import { ANNOTATION_STATUSES, ANNOTATION_TYPES, type Annotation } from '../contracts/schema.js';
import type { App } from '../store/actions.js';
import type { AppState } from '../store/state.js';
import { escapeHtml, renderUnlessFocused, copyText, shortSha } from './dom.js';
import { buildHash } from './router.js';

export class ReaderInspector extends HTMLElement {
  private app: App | null = null;
  private unsubscribe: (() => void) | null = null;
  private resolutions = new Map<string, string>(); // annotation id -> human state label

  connect(app: App): void {
    this.app = app;
    this.unsubscribe?.();
    this.unsubscribe = app.store.subscribe((s) => this.render(s));
    this.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-ins]');
      if (!el || !this.app) return;
      const action = el.dataset['ins']!;
      if (action === 'save-draft') void this.saveDraft();
      else if (action === 'cancel-draft') this.app.setInspectorTarget(null);
      else if (action === 'open') this.app.openAnnotation(el.dataset['id']!);
      else if (action === 'delete') void this.app.removeAnnotation(el.dataset['id']!);
      else if (action === 'tray-add') this.app.trayAdd(el.dataset['id']!);
      else if (action === 'copy-anchor-link') void this.copyAnchorLink(el.dataset['id']!);
      else if (action === 'filter-type') this.app.toggleTypeFilter(el.dataset['value']!);
      else if (action === 'filter-status') this.app.toggleStatusFilter(el.dataset['value']!);
      else if (action === 'close') this.app.setInspectorTarget(null);
    });
    this.addEventListener('change', (e) => {
      const el = e.target as HTMLElement;
      if (!this.app) return;
      const id = el.closest<HTMLElement>('[data-id]')?.dataset['id'];
      if (!id) return;
      if (el.matches('select[data-field="type"]')) void this.app.updateAnnotation(id, { type: (el as HTMLSelectElement).value as Annotation['type'] });
      if (el.matches('select[data-field="status"]')) void this.app.updateAnnotation(id, { status: (el as HTMLSelectElement).value as Annotation['status'] });
    });
    this.addEventListener('focusout', (e) => {
      const el = e.target as HTMLElement;
      if (!this.app || !el.matches('textarea[data-field="body"]')) return;
      const id = el.closest<HTMLElement>('[data-id]')?.dataset['id'];
      if (!id) return;
      const existing = this.app.store.get().annotations.find((a) => a.id === id);
      const value = (el as HTMLTextAreaElement).value;
      if (existing && existing.body !== value) void this.app.updateAnnotation(id, { body: value });
    });
  }

  private async saveDraft(): Promise<void> {
    const type = this.querySelector<HTMLSelectElement>('[data-draft="type"]')!.value as Annotation['type'];
    const body = this.querySelector<HTMLTextAreaElement>('[data-draft="body"]')!.value;
    await this.app!.saveDraft(type, body);
  }

  private async copyAnchorLink(id: string): Promise<void> {
    const state = this.app!.store.get();
    const a = state.annotations.find((x) => x.id === id);
    if (!a || !state.snapshot) return;
    const hash = buildHash({
      source: state.snapshot.source,
      commit: a.anchor.commit,
      path: a.anchor.path,
      range: { start: a.anchor.start.line, end: a.anchor.end.line }
    });
    const ok = await copyText(`${location.origin}${location.pathname}${hash}`);
    this.app!.setStatus(ok ? 'Anchor link copied.' : 'Copy failed.');
  }

  private async refreshResolutions(state: AppState): Promise<void> {
    if (!this.app || state.file?.state !== 'text') return;
    const res = await this.app.recheckAnchorsForCurrentFile();
    const next = new Map<string, string>();
    for (const [id, r] of res) {
      if (r.state === 'exact') next.set(id, 'exact');
      else if (r.state === 'relocated') next.set(id, `relocated to L${r.start.line}-L${r.end.line}`);
      else next.set(id, `moved - ${r.reason}`);
    }
    const changed = next.size !== this.resolutions.size || [...next].some(([k, v]) => this.resolutions.get(k) !== v);
    this.resolutions = next;
    if (changed) this.render(this.app.store.get());
  }

  private render(state: AppState): void {
    if (!state.snapshot) {
      this.innerHTML = `<div class="inspector-empty">Annotations appear here.</div>`;
      return;
    }
    if (state.file?.state === 'text') void this.refreshResolutions(state);

    const filters = `<div class="filters">
      <div>${ANNOTATION_TYPES.map((t) => `<button class="chip ${state.typeFilter.has(t) ? 'on' : ''}" data-ins="filter-type" data-value="${t}">${t}</button>`).join('')}</div>
      <div>${ANNOTATION_STATUSES.map((s) => `<button class="chip ${state.statusFilter.has(s) ? 'on' : ''}" data-ins="filter-status" data-value="${s}">${s}</button>`).join('')}</div>
    </div>`;

    let target = '';
    if (state.inspectorTarget === 'draft' && state.selection) {
      target = this.renderDraft(state);
    } else if (state.inspectorTarget) {
      const a = state.annotations.find((x) => x.id === state.inspectorTarget);
      if (a) target = this.renderAnnotation(state, a, true);
    }

    const fileAnnotations = state.file
      ? state.annotations.filter(
          (a) =>
            a.anchor.path === state.file!.record.path &&
            (state.typeFilter.size === 0 || state.typeFilter.has(a.type)) &&
            (state.statusFilter.size === 0 || state.statusFilter.has(a.status))
        )
      : [];

    const list = fileAnnotations.length
      ? fileAnnotations.map((a) => this.renderAnnotation(state, a, false)).join('')
      : `<div class="inspector-empty">No annotations on this file yet. Select lines, then "annotate".</div>`;

    this.classList.toggle('drafting', state.inspectorTarget === 'draft');
    renderUnlessFocused(this, `${filters}${target}<h3 class="list-head">On this file (${fileAnnotations.length})</h3>${list}`);
  }

  private renderDraft(state: AppState): string {
    const sel = state.selection!;
    return `<div class="card draft" data-id="draft">
      <div class="card-head"><strong>New annotation</strong> <span class="anchor-tag">${escapeHtml(state.file!.record.path)} L${sel.start}-L${sel.end}</span>
        <button data-ins="cancel-draft" title="Cancel">&#10005;</button></div>
      <label>Type
        <select data-draft="type">${ANNOTATION_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
      </label>
      <textarea data-draft="body" rows="4" placeholder="Note, question, request, or decision..." autofocus></textarea>
      <button class="primary" data-ins="save-draft">Save annotation</button>
    </div>`;
  }

  private renderAnnotation(state: AppState, a: Annotation, expanded: boolean): string {
    const inTray = state.tray.includes(a.id);
    const stale = a.anchor.commit !== state.snapshot!.commit;
    const resolution = this.resolutions.get(a.id);
    const stateChips = [
      stale ? `<span class="chip warn" title="Created at ${shortSha(a.anchor.commit)}, viewing ${shortSha(state.snapshot!.commit)}">stale revision</span>` : '',
      resolution && resolution !== 'exact' ? `<span class="chip ${resolution.startsWith('moved') ? 'bad' : 'warn'}">${escapeHtml(resolution)}</span>` : ''
    ].join('');
    const quote = a.quote.split('\n').slice(0, expanded ? 100 : 4).map((q) => `> ${q}`).join('\n');
    return `<div class="card ${expanded ? 'expanded' : ''}" data-id="${a.id}">
      <div class="card-head">
        <span class="type-tag type-${a.type}">${a.type}</span>
        <span class="anchor-tag">${escapeHtml(a.anchor.path)} L${a.anchor.start.line}-L${a.anchor.end.line}</span>
        ${stateChips}
        ${expanded ? `<button data-ins="close" title="Close">&#10005;</button>` : `<button data-ins="open" data-id="${a.id}" title="Open">&#8599;</button>`}
      </div>
      <pre class="quote">${escapeHtml(quote)}</pre>
      ${
        expanded
          ? `<label>Type <select data-field="type">${ANNOTATION_TYPES.map((t) => `<option value="${t}" ${t === a.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
             <label>Status <select data-field="status">${ANNOTATION_STATUSES.map((s) => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
             <textarea data-field="body" rows="4">${escapeHtml(a.body)}</textarea>
             <details class="anchor-details"><summary>Anchor identity</summary>
               <dl>
                 <dt>repository</dt><dd>${escapeHtml(a.anchor.repoId)}</dd>
                 <dt>commit</dt><dd>${escapeHtml(a.anchor.commit ?? 'local (no commit)')}</dd>
                 <dt>path</dt><dd>${escapeHtml(a.anchor.path)}</dd>
                 <dt>range</dt><dd>${a.anchor.start.line}:${a.anchor.start.column} - ${a.anchor.end.line}:${a.anchor.end.column}</dd>
                 <dt>sha256</dt><dd><code>${escapeHtml(a.anchor.textHash.slice(0, 20))}...</code></dd>
                 <dt>id</dt><dd><code>${a.id}</code></dd>
               </dl>
             </details>
             <div class="card-actions">
               <button data-ins="copy-anchor-link" data-id="${a.id}">copy anchor link</button>
               <button data-ins="tray-add" data-id="${a.id}" ${inTray ? 'disabled' : ''}>${inTray ? 'in review tray' : 'add to review tray'}</button>
               <button class="danger" data-ins="delete" data-id="${a.id}">delete</button>
             </div>`
          : `<div class="card-body">${escapeHtml(a.body.slice(0, 140))}${a.body.length > 140 ? '...' : ''}</div>
             <div class="card-foot"><span class="status-tag">${a.status}</span></div>`
      }
    </div>`;
  }
}

export function defineInspector(): void {
  customElements.define('reader-inspector', ReaderInspector);
}
