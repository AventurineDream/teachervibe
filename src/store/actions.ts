/**
 * Actions: the only writers of app state. Components call these; these call
 * adapters and IndexedDB, then commit through the Store.
 */

import { createAnchor, lineRange, resolveAnchor, type AnchorResolution } from '../contracts/anchor.js';
import { exportAnnotations, importAnnotations, buildReviewPacket, promptFromPacket } from '../contracts/serialize.js';
import {
  ANNOTATION_SCHEMA_VERSION,
  repoId,
  type Annotation,
  type AnnotationType,
  type FileRecord,
  type RepositorySnapshot
} from '../contracts/schema.js';
import { createGitHubAdapter, parseGitHubSpec } from '../sources/github.js';
import { createForgejoAdapter, parseForgejoSpec } from '../sources/forgejo.js';
import { createLocalAdapter, localFoldersSupported, pickLocalFolder } from '../sources/local.js';
import type { SourceAdapter } from '../sources/types.js';
import { SourceError } from '../sources/types.js';
import {
  getAnnotation,
  importAnnotationBatch,
  kvGet,
  kvSet,
  listAllAnnotations,
  listAnnotations,
  openDb,
  putAnnotation,
  deleteAnnotation
} from './db.js';
import { pushTrail, Store } from './state.js';
import { buildHash, parseHash, snapshotKey, type Route } from '../ui/router.js';

export class App {
  readonly store = new Store();
  private db!: IDBDatabase;
  private adapters = new Map<string, SourceAdapter>();
  private localHandles = new Map<string, FileSystemDirectoryHandle>();
  /** Snapshot cache key -> snapshot, so back/forward does not refetch trees. */
  private snapshots = new Map<string, RepositorySnapshot>();
  /**
   * Hash of the most recent self-initiated navigation. HashChangeEvent.newURL
   * identifies which change fired; ours are consumed, external ones (deep
   * links, back/forward) apply. A boolean flag raced: a self-navigation's
   * event and an external event interleave in the same task queue.
   */
  private ownHash: string | null = null;
  /** Bumped by every navigation; stale in-flight file loads abort. */
  private navSeq = 0;

  async init(): Promise<void> {
    this.db = await openDb();
    window.addEventListener('hashchange', (e) => {
      const hash = new URL((e as HashChangeEvent).newURL).hash;
      if (this.ownHash !== null && hash === this.ownHash) {
        this.ownHash = null;
        return;
      }
      this.ownHash = null;
      const route = parseHash(location.hash);
      if (route) void this.applyRoute(route);
    });
    const route = parseHash(location.hash);
    if (route) {
      await this.applyRoute(route);
    } else {
      await this.restoreLastSession();
    }
  }

  // ---- opening repositories -------------------------------------------------

  /** Open whatever the switcher input describes: GitHub shorthand/URL or Forgejo URL. */
  async openFromInput(input: string): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) return;
    try {
      if (/^https?:\/\//.test(trimmed) && !/github\.com/.test(trimmed)) {
        const spec = parseForgejoSpec(trimmed);
        await this.openGitLike(this.adapt('fj', () => createForgejoAdapter()), spec, spec.ref);
      } else {
        const spec = parseGitHubSpec(trimmed);
        await this.openGitLike(this.adapt('gh', () => createGitHubAdapter()), spec, spec.ref);
      }
    } catch (err) {
      this.failOpen(err);
    }
  }

  async openLocal(): Promise<void> {
    try {
      const handle = await pickLocalFolder();
      if (!handle) return;
      const adapter = createLocalAdapter(handle);
      this.localHandles.set(handle.name, handle);
      this.adapters.set(`local:${handle.name}`, adapter);
      const snapshot = await adapter.pickAndOpen();
      await this.enterSnapshot(snapshot, null, null);
    } catch (err) {
      this.failOpen(err);
    }
  }

  localFoldersSupported(): boolean {
    return localFoldersSupported();
  }

  private adapt(key: string, make: () => SourceAdapter): SourceAdapter {
    let a = this.adapters.get(key);
    if (!a) {
      a = make();
      this.adapters.set(key, a);
    }
    return a;
  }

  private async openGitLike(adapter: SourceAdapter, spec: Parameters<SourceAdapter['open']>[0], ref?: string): Promise<void> {
    this.store.patch({ phase: 'opening', error: null, statusMessage: 'Opening repository...' });
    const snapshot = await adapter.open(spec, ref);
    this.snapshots.set(snapshotKeyOf(snapshot), snapshot);
    await this.enterSnapshot(snapshot, null, null);
  }

  private failOpen(err: unknown): void {
    const se = err as SourceError;
    const kind = se instanceof SourceError ? se.kind : 'network';
    this.store.patch({
      phase: 'error',
      error: { kind, message: (err as Error).message },
      statusMessage: null
    });
  }

  /** Central entry: snapshot known, land on a path (or the default file) and range. */
  private async enterSnapshot(snapshot: RepositorySnapshot, path: string | null, range: { start: number; end: number } | null): Promise<void> {
    const annotations = await listAnnotations(this.db, snapshot.repoId);
    const target = path ?? defaultPath(snapshot);
    this.store.patch({
      phase: 'ready',
      error: null,
      snapshot,
      annotations,
      selection: null,
      trail: [],
      inspectorTarget: null,
      statusMessage: null
    });
    await kvSet(this.db, 'lastRoute', buildHash({ source: snapshot.source, commit: snapshot.commit, path: target, range }));
    if (target) {
      await this.openFile(target, range, { updateHash: true });
    } else {
      this.navigate({ source: snapshot.source, commit: snapshot.commit, path: null, range: null });
    }
  }

  private async restoreLastSession(): Promise<void> {
    const last = await kvGet<string>(this.db, 'lastRoute');
    if (last) {
      const route = parseHash(last);
      if (route && route.source.kind !== 'local') {
        await this.applyRoute(route);
        return;
      }
    }
    this.store.patch({ phase: 'idle' });
  }

  /** Apply a parsed URL (initial load, hashchange, deep link). */
  async applyRoute(route: Route): Promise<void> {
    this.navSeq++;
    try {
      const key = snapshotKey(route);
      const state = this.store.get();
      const currentKey = state.snapshot ? snapshotKeyOf(state.snapshot) : null;

      if (currentKey !== key) {
        let snapshot = this.snapshots.get(key);
        if (!snapshot) {
          if (route.source.kind === 'local') {
            const handle = this.localHandles.get(route.source.name);
            if (!handle) {
              this.store.patch({
                phase: 'error',
                error: { kind: 'inaccessible', message: 'Local folders cannot be restored from a link; pick the folder again.' }
              });
              return;
            }
            snapshot = await this.adapt(`local:${route.source.name}`, () => createLocalAdapter(handle)).open(route.source);
          } else if (route.source.kind === 'github') {
            this.store.patch({ phase: 'opening', error: null });
            snapshot = await this.adapt('gh', () => createGitHubAdapter()).open(route.source, route.commit ?? undefined);
          } else {
            this.store.patch({ phase: 'opening', error: null });
            snapshot = await this.adapt('fj', () => createForgejoAdapter()).open(route.source, route.commit ?? undefined);
          }
          this.snapshots.set(snapshotKeyOf(snapshot), snapshot);
        }
        const annotations = await listAnnotations(this.db, snapshot.repoId);
        this.store.patch({ phase: 'ready', snapshot, annotations, error: null, trail: [], selection: null });
        await kvSet(this.db, 'lastRoute', buildHash({ ...route, path: route.path }));
      }

      if (route.path) {
        await this.openFile(route.path, route.range, { updateHash: false });
      } else {
        this.store.patch({ file: null, selection: null });
      }
    } catch (err) {
      this.failOpen(err);
    }
  }

  private navigate(route: Route): void {
    const hash = buildHash(route);
    this.navSeq++;
    if (hash === location.hash) return; // no hashchange will fire
    this.ownHash = hash;
    location.hash = hash;
  }

  // ---- reading ---------------------------------------------------------------

  async openFile(path: string, range: { start: number; end: number } | null, opts: { updateHash: boolean } = { updateHash: true }): Promise<void> {
    const state = this.store.get();
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const record = snapshot.tree.find((f) => f.path === path && f.type === 'blob');
    if (!record) {
      this.store.patch({ file: { record: stubRecord(path), state: 'error', reason: 'not in the tree at this commit' } });
      return;
    }
    this.store.patch({ file: { record, state: 'loading' }, selection: null, searchQuery: '' });
    const adapter = this.adapterFor(snapshot);
    const seq = this.navSeq;
    try {
      const result = await adapter.fetchFile(snapshot, record);
      // A newer navigation (deep link, back/forward, another click) supersedes
      // this load; dropping it keeps the newer route's file and hash intact.
      if (seq !== this.navSeq) return;
      if (result.kind === 'text') {
        this.store.patch({ file: { record, state: 'text', text: result.text } });
      } else if (result.kind === 'binary') {
        this.store.patch({ file: { record, state: 'binary' } });
      } else {
        this.store.patch({ file: { record, state: 'unsupported', reason: result.reason } });
      }
    } catch (err) {
      const se = err as SourceError;
      this.store.patch({
        file: { record, state: 'error', reason: se instanceof SourceError ? `${se.kind}: ${se.message}` : (err as Error).message }
      });
    }
    const now = new Date().toISOString();
    this.store.patch({
      trail: pushTrail(this.store.get(), {
        repoId: snapshot.repoId,
        commit: snapshot.commit,
        path,
        kind: 'file',
        visitedAt: now
      })
    });
    if (range) this.selectRange(range.start, range.end, { updateHash: false, fromTrail: true });
    if (opts.updateHash) {
      this.navigate({ source: snapshot.source, commit: snapshot.commit, path, range });
      void kvSet(this.db, 'lastRoute', buildHash({ source: snapshot.source, commit: snapshot.commit, path, range }));
    }
  }

  private adapterFor(snapshot: RepositorySnapshot): SourceAdapter {
    const key =
      snapshot.source.kind === 'github' ? 'gh' : snapshot.source.kind === 'forgejo' ? 'fj' : `local:${(snapshot.source as { name: string }).name}`;
    const adapter = this.adapters.get(key);
    if (!adapter) throw new SourceError('network', 'source adapter is gone; reopen the repository');
    return adapter;
  }

  selectRange(start: number, end: number, opts: { updateHash?: boolean; fromTrail?: boolean } = {}): void {
    const state = this.store.get();
    if (!state.snapshot || !state.file || state.file.state !== 'text') return;
    const lineCount = state.file.text!.split('\n').length;
    const s = Math.max(1, Math.min(start, end));
    const e = Math.min(lineCount, Math.max(start, end));
    this.store.patch({ selection: { start: s, end: e } });
    if (!opts.fromTrail) {
      this.store.patch({
        trail: pushTrail(this.store.get(), {
          repoId: state.snapshot.repoId,
          commit: state.snapshot.commit,
          path: state.file.record.path,
          range: { start: s, end: e },
          kind: 'selection',
          visitedAt: new Date().toISOString()
        })
      });
    }
    if (opts.updateHash !== false) {
      this.navigate({ source: state.snapshot.source, commit: state.snapshot.commit, path: state.file.record.path, range: { start: s, end: e } });
    }
  }

  clearSelection(): void {
    const state = this.store.get();
    this.store.patch({ selection: null });
    if (state.snapshot && state.file) {
      this.navigate({ source: state.snapshot.source, commit: state.snapshot.commit, path: state.file.record.path, range: null });
    }
  }

  // ---- annotations ------------------------------------------------------------

  beginDraft(): void {
    if (!this.store.get().selection) return;
    this.store.patch({ inspectorTarget: 'draft' });
  }

  async saveDraft(type: AnnotationType, body: string): Promise<void> {
    const state = this.store.get();
    const { snapshot, file, selection } = state;
    if (!snapshot || !file || file.state !== 'text' || !selection) return;
    const { start, end } = lineRange(selection.start, selection.end, file.text!);
    const { anchor, quote } = await createAnchor({
      repoId: snapshot.repoId,
      commit: snapshot.commit,
      path: file.record.path,
      start,
      end,
      fileText: file.text!
    });
    const now = new Date().toISOString();
    const annotation: Annotation = {
      id: crypto.randomUUID(),
      schemaVersion: ANNOTATION_SCHEMA_VERSION,
      type,
      status: 'open',
      body,
      quote,
      anchor,
      createdAt: now,
      updatedAt: now
    };
    await putAnnotation(this.db, annotation);
    this.store.patch({
      annotations: [...state.annotations, annotation],
      inspectorTarget: annotation.id,
      statusMessage: 'Annotation saved locally.'
    });
  }

  async updateAnnotation(id: string, patch: Partial<Pick<Annotation, 'type' | 'status' | 'body'>>): Promise<void> {
    const existing = await getAnnotation(this.db, id);
    if (!existing) return;
    const next: Annotation = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    await putAnnotation(this.db, next);
    this.store.patch({
      annotations: this.store.get().annotations.map((a) => (a.id === id ? next : a))
    });
  }

  async removeAnnotation(id: string): Promise<void> {
    await deleteAnnotation(this.db, id);
    const state = this.store.get();
    this.store.patch({
      annotations: state.annotations.filter((a) => a.id !== id),
      tray: state.tray.filter((t) => t !== id),
      inspectorTarget: state.inspectorTarget === id ? null : state.inspectorTarget
    });
  }

  openAnnotation(id: string): void {
    const a = this.store.get().annotations.find((x) => x.id === id);
    if (!a) return;
    this.store.patch({ inspectorTarget: id });
    const state = this.store.get();
    if (state.file?.record.path !== a.anchor.path) {
      void this.openFile(a.anchor.path, { start: a.anchor.start.line, end: a.anchor.end.line });
    } else {
      this.selectRange(a.anchor.start.line, a.anchor.end.line);
    }
  }

  /** Re-resolve every annotation for the open file against its current text. */
  async recheckAnchorsForCurrentFile(): Promise<Map<string, AnchorResolution>> {
    const state = this.store.get();
    const out = new Map<string, AnchorResolution>();
    if (!state.file || state.file.state !== 'text') return out;
    for (const a of state.annotations) {
      if (a.anchor.path !== state.file.record.path) continue;
      out.set(a.id, await resolveAnchor(a.anchor, a.quote, state.file.text!));
    }
    return out;
  }

  // ---- review tray / handoff ----------------------------------------------------

  trayAdd(id: string): void {
    const { tray } = this.store.get();
    if (!tray.includes(id)) this.store.patch({ tray: [...tray, id] });
  }

  trayRemove(id: string): void {
    this.store.patch({ tray: this.store.get().tray.filter((t) => t !== id) });
  }

  trayMove(id: string, delta: -1 | 1): void {
    const tray = [...this.store.get().tray];
    const i = tray.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= tray.length) return;
    [tray[i], tray[j]] = [tray[j]!, tray[i]!];
    this.store.patch({ tray });
  }

  packet(targetRef?: string): { json: string; markdown: string; prompt: string } | null {
    const state = this.store.get();
    if (!state.snapshot) return null;
    const ordered = state.tray
      .map((id) => state.annotations.find((a) => a.id === id))
      .filter((a): a is Annotation => Boolean(a));
    const built = buildReviewPacket({ snapshot: state.snapshot, annotations: ordered, targetRef: targetRef ?? null });
    return { json: built.json, markdown: built.markdown, prompt: promptFromPacket(built.packet) };
  }

  // ---- backup import/export -----------------------------------------------------

  async exportBackup(): Promise<string> {
    return exportAnnotations(await listAllAnnotations(this.db));
  }

  async importBackup(json: string): Promise<number> {
    const annotations = importAnnotations(json);
    const count = await importAnnotationBatch(this.db, annotations);
    const state = this.store.get();
    if (state.snapshot) {
      this.store.patch({ annotations: await listAnnotations(this.db, state.snapshot.repoId) });
    }
    this.store.patch({ statusMessage: `Imported ${count} annotation(s).` });
    return count;
  }

  // ---- small UI setters -----------------------------------------------------------

  setSearch(query: string): void {
    this.store.patch({ searchQuery: query });
  }

  toggleTypeFilter(type: string): void {
    const next = new Set(this.store.get().typeFilter);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    this.store.patch({ typeFilter: next });
  }

  toggleStatusFilter(status: string): void {
    const next = new Set(this.store.get().statusFilter);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    this.store.patch({ statusFilter: next });
  }

  setDrawer(drawer: 'nav' | 'tray' | null): void {
    this.store.patch({ drawer });
  }

  setInspectorTarget(target: string | null): void {
    this.store.patch({ inspectorTarget: target });
  }

  setStatus(message: string | null): void {
    this.store.patch({ statusMessage: message });
  }
}

function snapshotKeyOf(snapshot: RepositorySnapshot): string {
  return `${snapshot.repoId}@${snapshot.commit ?? ''}`;
}

function stubRecord(path: string): FileRecord {
  return { path, type: 'blob', binary: false, generated: false };
}

function defaultPath(snapshot: RepositorySnapshot): string | null {
  const blobs = snapshot.tree.filter((f) => f.type === 'blob' && !f.binary && !f.generated);
  const readme = blobs.find((f) => /(^|\/)readme(\.\w+)?$/i.test(f.path));
  return (readme ?? blobs[0])?.path ?? null;
}
