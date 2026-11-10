/**
 * Actions: the only writers of app state. Components call these; these call
 * adapters and IndexedDB, then commit through the Store.
 *
 * main.ts creates the one App, connects <reader-app> to it, and starts init().
 * Navigation is URL-first: user navigation writes location.hash (formats in
 * ui/router.ts), and hash changes from elsewhere (deep links, back/forward) arrive
 * through applyRoute(). Opened routes are also saved in IndexedDB (kv `lastRoute`)
 * so a reload without a hash reopens the last one, except for local folders.
 *
 * Side effects: IndexedDB writes, location.hash, and network or disk reads through
 * the source adapters. Failures to open a repository land in state
 * (`phase: 'error'`) instead of rejecting; file load failures land in `state.file`.
 */

import {
  createAnchor,
  lineRange,
  resolveAnchor,
  type AnchorResolution,
} from '../contracts/anchor.js';
import {
  exportAnnotations,
  importAnnotations,
  buildReviewPacket,
  promptFromPacket,
} from '../contracts/serialize.js';
import {
  ANNOTATION_SCHEMA_VERSION,
  repoId,
  type Annotation,
  type AnnotationType,
  type FileRecord,
  type RepositorySnapshot,
} from '../contracts/schema.js';
import { createGitHubAdapter, parseGitHubSpec } from '../sources/github.js';
import { createForgejoAdapter, parseForgejoSpec } from '../sources/forgejo.js';
import {
  createLocalAdapter,
  localFoldersSupported,
  pickLocalFolder,
} from '../sources/local.js';
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
  deleteAnnotation,
} from './db.js';
import { pushTrail, Store } from './state.js';
import { buildHash, parseHash, snapshotKey, type Route } from '../ui/router.js';

/**
 * The page's controller. UI elements read `store` and call these methods; nothing else
 * writes the store. init() must resolve before anything that opens repositories or
 * touches annotations runs, since those use the database it opens.
 */
export class App {
  /** App state: elements subscribe to it and read it; only App methods write it. */
  readonly store = new Store();
  /** Set by init(); undefined until then despite the `!`. */
  private db!: IDBDatabase;
  /**
   * Adapters by key: 'gh' and 'fj' (one each, shared by every repository of that
   * kind) or `local:<folder name>`. adapt() and adapterFor() must agree on the keys.
   */
  private adapters = new Map<string, SourceAdapter>();
  /** Picked folders by name, in memory only: after a reload, local links need a new pick. */
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
  /**
   * Bumped by every navigation. openFile() drops a successful load that finishes
   * after a newer navigation started (the request itself is not cancelled).
   */
  private navSeq = 0;

  /**
   * Opens IndexedDB, starts applying external hash changes, then shows the route in
   * the current hash or, when it has none that parses, the last saved non-local route
   * (else the idle start screen). Call once, since each call adds another hashchange
   * listener.
   * Rejects if opening IndexedDB or reading the saved route fails.
   */
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

  /**
   * Open whatever the switcher input describes: GitHub shorthand/URL or Forgejo URL.
   * Any http(s) URL that does not contain `github.com` is parsed as Forgejo; blank
   * input is ignored. Never rejects: parse and load failures become `phase: 'error'`.
   * @param input - Switcher text; surrounding whitespace is ignored.
   */
  async openFromInput(input: string): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) return;
    try {
      if (/^https?:\/\//.test(trimmed) && !/github\.com/.test(trimmed)) {
        const spec = parseForgejoSpec(trimmed);
        await this.openGitLike(
          this.adapt('fj', () => createForgejoAdapter()),
          spec,
          spec.ref
        );
      } else {
        const spec = parseGitHubSpec(trimmed);
        await this.openGitLike(
          this.adapt('gh', () => createGitHubAdapter()),
          spec,
          spec.ref
        );
      }
    } catch (err) {
      this.failOpen(err);
    }
  }

  /**
   * Asks for a folder and opens it as a `local` snapshot (commit null) at its default
   * file. Call from a user gesture: the browser refuses the picker otherwise.
   * Cancelling changes nothing; failures, including an unsupported browser, become
   * `phase: 'error'`. The handle is kept in memory only, so after a reload its links
   * ask for the folder again.
   */
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

  /** Whether this browser can open local folders; the header disables "Open folder" when it cannot. */
  localFoldersSupported(): boolean {
    return localFoldersSupported();
  }

  /** The adapter cached under `key`, created with `make` on first use. */
  private adapt(key: string, make: () => SourceAdapter): SourceAdapter {
    let a = this.adapters.get(key);
    if (!a) {
      a = make();
      this.adapters.set(key, a);
    }
    return a;
  }

  private async openGitLike(
    adapter: SourceAdapter,
    spec: Parameters<SourceAdapter['open']>[0],
    ref?: string
  ): Promise<void> {
    this.store.patch({
      phase: 'opening',
      error: null,
      statusMessage: 'Opening repository...',
    });
    const snapshot = await adapter.open(spec, ref);
    this.snapshots.set(snapshotKeyOf(snapshot), snapshot);
    await this.enterSnapshot(snapshot, null, null);
  }

  /** Shows `err` as the open error; anything other than a SourceError is reported as `network`. */
  private failOpen(err: unknown): void {
    const se = err as SourceError;
    const kind = se instanceof SourceError ? se.kind : 'network';
    this.store.patch({
      phase: 'error',
      error: { kind, message: (err as Error).message },
      statusMessage: null,
    });
  }

  /** Central entry: snapshot known, land on a path (or the default file) and range. */
  private async enterSnapshot(
    snapshot: RepositorySnapshot,
    path: string | null,
    range: { start: number; end: number } | null
  ): Promise<void> {
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
      statusMessage: null,
    });
    await kvSet(
      this.db,
      'lastRoute',
      buildHash({
        source: snapshot.source,
        commit: snapshot.commit,
        path: target,
        range,
      })
    );
    if (target) {
      await this.openFile(target, range, { updateHash: true });
    } else {
      this.navigate({
        source: snapshot.source,
        commit: snapshot.commit,
        path: null,
        range: null,
      });
    }
  }

  /**
   * Reopens the route saved in kv `lastRoute` unless it is a local folder (its handle
   * does not survive a reload); otherwise shows the idle start screen.
   */
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

  /**
   * Apply a parsed URL (initial load, hashchange, deep link).
   * Reuses the open or a cached snapshot when repository and commit match; otherwise
   * opens the source with the route's commit as the ref, so a link with a full SHA
   * reopens exactly that commit. A local folder resolves only while its handle from
   * openLocal() is in memory. Leaves location.hash alone. Never rejects: failures
   * become `phase: 'error'`.
   * @param route - Parsed source, pinned commit, path and optional inclusive line range.
   */
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
                error: {
                  kind: 'inaccessible',
                  message:
                    'Local folders cannot be restored from a link; pick the folder again.',
                },
              });
              return;
            }
            snapshot = await this.adapt(`local:${route.source.name}`, () =>
              createLocalAdapter(handle)
            ).open(route.source);
          } else if (route.source.kind === 'github') {
            this.store.patch({ phase: 'opening', error: null });
            snapshot = await this.adapt('gh', () => createGitHubAdapter()).open(
              route.source,
              route.commit ?? undefined
            );
          } else {
            this.store.patch({ phase: 'opening', error: null });
            snapshot = await this.adapt('fj', () =>
              createForgejoAdapter()
            ).open(route.source, route.commit ?? undefined);
          }
          this.snapshots.set(snapshotKeyOf(snapshot), snapshot);
        }
        const annotations = await listAnnotations(this.db, snapshot.repoId);
        this.store.patch({
          phase: 'ready',
          snapshot,
          annotations,
          error: null,
          trail: [],
          selection: null,
        });
        await kvSet(
          this.db,
          'lastRoute',
          buildHash({ ...route, path: route.path })
        );
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

  /**
   * Writes `route` to location.hash as a self-initiated change (its hashchange is
   * ignored) and bumps navSeq. Skips the write when the hash is already current.
   */
  private navigate(route: Route): void {
    const hash = buildHash(route);
    this.navSeq++;
    if (hash === location.hash) return; // no hashchange will fire
    this.ownHash = hash;
    location.hash = hash;
  }

  // ---- reading ---------------------------------------------------------------

  /**
   * Loads `path` from the open snapshot into `state.file` (`text`, `binary`,
   * `unsupported` or `error`), clearing the selection and in-file search, then selects
   * `range` (1-based, inclusive lines) if text loaded. Records a trail entry and,
   * unless `opts.updateHash` is false, writes the route to location.hash and kv
   * `lastRoute`. A path that is not a file in the tree only gets an `error` view;
   * nothing else changes. A successful result arriving after a newer navigation is
   * discarded; a failed one still shows its error. No-op without a snapshot.
   * @param path - Repository-relative file path in the current snapshot's tree.
   * @param range - 1-based inclusive lines to select after loading text; null selects none.
   * @param opts - `updateHash: false` suppresses URL and last-route persistence.
   * @throws {SourceError} If no adapter is registered for the open snapshot.
   */
  async openFile(
    path: string,
    range: { start: number; end: number } | null,
    opts: { updateHash: boolean } = { updateHash: true }
  ): Promise<void> {
    const state = this.store.get();
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const record = snapshot.tree.find(
      (f) => f.path === path && f.type === 'blob'
    );
    if (!record) {
      this.store.patch({
        file: {
          record: stubRecord(path),
          state: 'error',
          reason: 'not in the tree at this commit',
        },
      });
      return;
    }
    this.store.patch({
      file: { record, state: 'loading' },
      selection: null,
      searchQuery: '',
    });
    const adapter = this.adapterFor(snapshot);
    const seq = this.navSeq;
    try {
      const result = await adapter.fetchFile(snapshot, record);
      // A newer navigation (deep link, back/forward, another click) supersedes
      // this load; dropping it keeps the newer route's file and hash intact.
      if (seq !== this.navSeq) return;
      if (result.kind === 'text') {
        this.store.patch({
          file: { record, state: 'text', text: result.text },
        });
      } else if (result.kind === 'binary') {
        this.store.patch({ file: { record, state: 'binary' } });
      } else {
        this.store.patch({
          file: { record, state: 'unsupported', reason: result.reason },
        });
      }
    } catch (err) {
      const se = err as SourceError;
      this.store.patch({
        file: {
          record,
          state: 'error',
          reason:
            se instanceof SourceError
              ? `${se.kind}: ${se.message}`
              : (err as Error).message,
        },
      });
    }
    const now = new Date().toISOString();
    this.store.patch({
      trail: pushTrail(this.store.get(), {
        repoId: snapshot.repoId,
        commit: snapshot.commit,
        path,
        kind: 'file',
        visitedAt: now,
      }),
    });
    if (range)
      this.selectRange(range.start, range.end, {
        updateHash: false,
        fromTrail: true,
      });
    if (opts.updateHash) {
      this.navigate({
        source: snapshot.source,
        commit: snapshot.commit,
        path,
        range,
      });
      void kvSet(
        this.db,
        'lastRoute',
        buildHash({
          source: snapshot.source,
          commit: snapshot.commit,
          path,
          range,
        })
      );
    }
  }

  /**
   * The adapter for `snapshot`'s source, found by the keys adapt() caches under.
   * Throws SourceError `network` when none is registered.
   */
  private adapterFor(snapshot: RepositorySnapshot): SourceAdapter {
    const key =
      snapshot.source.kind === 'github'
        ? 'gh'
        : snapshot.source.kind === 'forgejo'
          ? 'fj'
          : `local:${(snapshot.source as { name: string }).name}`;
    const adapter = this.adapters.get(key);
    if (!adapter)
      throw new SourceError(
        'network',
        'source adapter is gone; reopen the repository'
      );
    return adapter;
  }

  /**
   * Selects lines `start`..`end` (1-based, inclusive, either order) in the open text
   * file; a no-op for any other file state. The lower bound is raised to 1 and the
   * upper capped at the last line.
   * @param start - First requested line, 1-based; may be later than `end`.
   * @param end - Last requested line, 1-based; may be earlier than `start`.
   * @param opts - `updateHash: false` leaves location.hash alone (used while
   *   dragging); `fromTrail: true` skips the trail entry (openFile() records its own).
   */
  selectRange(
    start: number,
    end: number,
    opts: { updateHash?: boolean; fromTrail?: boolean } = {}
  ): void {
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
          visitedAt: new Date().toISOString(),
        }),
      });
    }
    if (opts.updateHash !== false) {
      this.navigate({
        source: state.snapshot.source,
        commit: state.snapshot.commit,
        path: state.file.record.path,
        range: { start: s, end: e },
      });
    }
  }

  /** Clears the selection and drops the range from location.hash; the file stays open. */
  clearSelection(): void {
    const state = this.store.get();
    this.store.patch({ selection: null });
    if (state.snapshot && state.file) {
      this.navigate({
        source: state.snapshot.source,
        commit: state.snapshot.commit,
        path: state.file.record.path,
        range: null,
      });
    }
  }

  // ---- annotations ------------------------------------------------------------

  /** Opens the inspector's new-annotation form for the selected lines; ignored without a selection. */
  beginDraft(): void {
    if (!this.store.get().selection) return;
    this.store.patch({ inspectorTarget: 'draft' });
  }

  /**
   * Creates an `open` annotation of `type` on the selected lines and stores it in
   * IndexedDB. The anchor spans whole lines and is pinned to the snapshot's commit
   * (null for local folders). State changes only after the write succeeds; the new
   * annotation then opens in the inspector. A no-op without a text file and selection.
   * @param type - Note category displayed by the inspector and exported in packets.
   * @param body - the note text, stored as typed (may be empty).
   * @throws {Error} If anchor hashing or the IndexedDB write fails; no state is committed.
   */
  async saveDraft(type: AnnotationType, body: string): Promise<void> {
    const state = this.store.get();
    const { snapshot, file, selection } = state;
    if (!snapshot || !file || file.state !== 'text' || !selection) return;
    const { start, end } = lineRange(
      selection.start,
      selection.end,
      file.text!
    );
    const { anchor, quote } = await createAnchor({
      repoId: snapshot.repoId,
      commit: snapshot.commit,
      path: file.record.path,
      start,
      end,
      fileText: file.text!,
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
      updatedAt: now,
    };
    await putAnnotation(this.db, annotation);
    this.store.patch({
      annotations: [...state.annotations, annotation],
      inspectorTarget: annotation.id,
      statusMessage: 'Annotation saved locally.',
    });
  }

  /**
   * Applies `patch` to annotation `id` as stored in IndexedDB (not as held in state),
   * stamps `updatedAt`, and writes it back; anchor and quote never change. Ignored
   * when `id` is not stored.
   * @throws {Error} If the IndexedDB read or write fails; no state update is applied.
   */
  async updateAnnotation(
    id: string,
    patch: Partial<Pick<Annotation, 'type' | 'status' | 'body'>>
  ): Promise<void> {
    const existing = await getAnnotation(this.db, id);
    if (!existing) return;
    const next: Annotation = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await putAnnotation(this.db, next);
    this.store.patch({
      annotations: this.store
        .get()
        .annotations.map((a) => (a.id === id ? next : a)),
    });
  }

  /**
   * Deletes annotation `id` from IndexedDB, then from state, the review tray and the
   * inspector. Rejects on a database failure before changing state.
   */
  async removeAnnotation(id: string): Promise<void> {
    await deleteAnnotation(this.db, id);
    const state = this.store.get();
    this.store.patch({
      annotations: state.annotations.filter((a) => a.id !== id),
      tray: state.tray.filter((t) => t !== id),
      inspectorTarget:
        state.inspectorTarget === id ? null : state.inspectorTarget,
    });
  }

  /**
   * Shows annotation `id` in the inspector and selects its lines, opening its file
   * first if another is showing. Uses the anchor's stored lines, not where
   * resolveAnchor() would relocate them. Ignored for ids not loaded for this repository.
   */
  openAnnotation(id: string): void {
    const a = this.store.get().annotations.find((x) => x.id === id);
    if (!a) return;
    this.store.patch({ inspectorTarget: id });
    const state = this.store.get();
    if (state.file?.record.path !== a.anchor.path) {
      void this.openFile(a.anchor.path, {
        start: a.anchor.start.line,
        end: a.anchor.end.line,
      });
    } else {
      this.selectRange(a.anchor.start.line, a.anchor.end.line);
    }
  }

  /**
   * Re-resolve every annotation for the open file against its current text.
   * Keyed by annotation id; empty unless a text file is showing. Filters do not apply.
   */
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

  /** Appends annotation `id` to the end of the review tray unless it is already there. */
  trayAdd(id: string): void {
    const { tray } = this.store.get();
    if (!tray.includes(id)) this.store.patch({ tray: [...tray, id] });
  }

  /** Takes `id` out of the review tray; the annotation itself is kept. */
  trayRemove(id: string): void {
    this.store.patch({ tray: this.store.get().tray.filter((t) => t !== id) });
  }

  /**
   * Swaps `id` with its neighbour: -1 moves it earlier, 1 later. Ignored at either end
   * or when `id` is not in the tray.
   */
  trayMove(id: string, delta: -1 | 1): void {
    const tray = [...this.store.get().tray];
    const i = tray.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= tray.length) return;
    [tray[i], tray[j]] = [tray[j]!, tray[i]!];
    this.store.patch({ tray });
  }

  /**
   * Builds the review packet from the tray, in tray order, and returns its JSON,
   * Markdown and agent prompt; null without an open snapshot. Tray ids whose
   * annotation is not loaded, such as notes added while another repository was open,
   * are skipped. Changes no state.
   * @param targetRef - branch or commit the notes are for; blank becomes null in the packet.
   */
  packet(
    targetRef?: string
  ): { json: string; markdown: string; prompt: string } | null {
    const state = this.store.get();
    if (!state.snapshot) return null;
    const ordered = state.tray
      .map((id) => state.annotations.find((a) => a.id === id))
      .filter((a): a is Annotation => Boolean(a));
    const built = buildReviewPacket({
      snapshot: state.snapshot,
      annotations: ordered,
      targetRef: targetRef ?? null,
    });
    return {
      json: built.json,
      markdown: built.markdown,
      prompt: promptFromPacket(built.packet),
    };
  }

  // ---- backup import/export -----------------------------------------------------

  /**
   * Every stored annotation, across all repositories, as a deterministic backup
   * (exportAnnotations()). Rejects if the IndexedDB read fails; changes no state.
   */
  async exportBackup(): Promise<string> {
    return exportAnnotations(await listAllAnnotations(this.db));
  }

  /**
   * Validates a backup and upserts all of it into IndexedDB in one transaction
   * (existing ids are overwritten), reloads the open repository's annotations, and
   * reports the count in the status line. Resolves with that count.
   * @param json - backup file contents, as written by exportBackup().
   * @throws {ImportError} for an invalid backup, before anything is written.
   * @throws {Error} If the transaction or subsequent reload fails. A reload failure
   *   does not undo annotations already committed by the transaction.
   */
  async importBackup(json: string): Promise<number> {
    const annotations = importAnnotations(json);
    const count = await importAnnotationBatch(this.db, annotations);
    const state = this.store.get();
    if (state.snapshot) {
      this.store.patch({
        annotations: await listAnnotations(this.db, state.snapshot.repoId),
      });
    }
    this.store.patch({ statusMessage: `Imported ${count} annotation(s).` });
    return count;
  }

  // ---- small UI setters -----------------------------------------------------------

  /** Sets the in-file search query that the pane highlights; openFile() resets it. */
  setSearch(query: string): void {
    this.store.patch({ searchQuery: query });
  }

  /**
   * Adds `type` to the annotation type filter, or removes it if present. An empty
   * filter shows every type (pane markers and inspector list; the tray ignores it).
   */
  toggleTypeFilter(type: string): void {
    const next = new Set(this.store.get().typeFilter);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    this.store.patch({ typeFilter: next });
  }

  /** Same as toggleTypeFilter(), for annotation statuses. */
  toggleStatusFilter(status: string): void {
    const next = new Set(this.store.get().statusFilter);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    this.store.patch({ statusFilter: next });
  }

  /** Opens the navigation or review-tray drawer (one at a time); null closes it. */
  setDrawer(drawer: 'nav' | 'tray' | null): void {
    this.store.patch({ drawer });
  }

  /**
   * Shows annotation `target` in the inspector, or the new-annotation form for
   * 'draft' (drawn only while lines are selected); null closes the inspector.
   */
  setInspectorTarget(target: string | null): void {
    this.store.patch({ inspectorTarget: target });
  }

  /**
   * Shows `message` in the status line until it is replaced; null falls back to
   * "Opening repository..." while opening and to nothing otherwise.
   */
  setStatus(message: string | null): void {
    this.store.patch({ statusMessage: message });
  }
}

/**
 * Cache key for `snapshot`. Must match snapshotKey() in ui/router.ts for routes to the
 * same repository and commit, or applyRoute() would refetch instead of reusing it.
 */
function snapshotKeyOf(snapshot: RepositorySnapshot): string {
  return `${snapshot.repoId}@${snapshot.commit ?? ''}`;
}

/** Stand-in record so a path missing from the tree can still show an error view. */
function stubRecord(path: string): FileRecord {
  return { path, type: 'blob', binary: false, generated: false };
}

/**
 * File to show when none is requested: the first README-named file in tree order at
 * any depth (not necessarily the root one: `docs/README.md` sorts before
 * `README.md`), else the first file. Binary and generated files never qualify; null
 * when nothing does.
 */
function defaultPath(snapshot: RepositorySnapshot): string | null {
  const blobs = snapshot.tree.filter(
    (f) => f.type === 'blob' && !f.binary && !f.generated
  );
  const readme = blobs.find((f) => /(^|\/)readme(\.\w+)?$/i.test(f.path));
  return (readme ?? blobs[0])?.path ?? null;
}
