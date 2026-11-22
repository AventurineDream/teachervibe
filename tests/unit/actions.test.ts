/**
 * Unit tests for App actions (src/store/actions.ts) against a real App with fake
 * IndexedDB, a fake local folder and stubbed `window`/`location`. Each test checks what
 * the store and the stored backup show after an action, the same things the UI reads.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/store/actions.js';
import { openDb } from '../../src/store/db.js';
import { ImportError } from '../../src/contracts/serialize.js';
import {
  dir,
  file,
  folderHandle,
  type FakeDir,
  type FakeFile,
} from './support/fake-folder.js';

const README = 'Project notes\nsecond line\nthird line\n';
const APP_TS =
  'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n';

let folderCounter = 0;

/** A fresh folder name per test, so annotations from one test never leak into another. */
function makeFolder(): { name: string; root: FakeDir } {
  folderCounter += 1;
  const name = `folder-${folderCounter}`;
  const root = dir(name, [
    file('README.md', README),
    dir('src', [file('app.ts', APP_TS)]),
  ]);
  return { name, root };
}

/** Opens `root` through the picker path, as the header's "Open folder" button does. */
async function openFolder(app: App, root: FakeDir): Promise<void> {
  vi.stubGlobal('showDirectoryPicker', async () => folderHandle(root));
  await app.openLocal();
}

/** Parses the backup the app would write, so tests read what is persisted. */
async function storedAnnotations(app: App) {
  const backup = JSON.parse(await app.exportBackup()) as {
    annotations: { id: string; body: string; status: string }[];
  };
  return backup.annotations;
}

/**
 * Empties the annotation and kv stores so each test starts from no notes. The
 * database is shared by the whole file, and exportBackup() reads every repository.
 */
async function clearStores(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(['annotations', 'kv'], 'readwrite');
    t.objectStore('annotations').clear();
    t.objectStore('kv').clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

let app: App;

beforeEach(async () => {
  vi.stubGlobal('window', { addEventListener: () => {} });
  vi.stubGlobal('location', { hash: '' });
  await clearStores();
  app = new App();
  await app.init();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('opening a local folder', () => {
  it('shows the default README as text with no selection', async () => {
    const { root } = makeFolder();
    await openFolder(app, root);

    const state = app.store.get();
    expect(state.phase).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.file?.record.path).toBe('README.md');
    expect(state.file?.state).toBe('text');
    expect(state.file?.text).toBe(README);
    expect(state.selection).toBeNull();
  });

  it('reports a path that is not in the tree as an error view', async () => {
    const { root } = makeFolder();
    await openFolder(app, root);

    await app.openFile('missing.md', null);

    expect(app.store.get().file).toMatchObject({
      state: 'error',
      reason: 'not in the tree at this commit',
    });
  });

  it('shows the folder as a restore-required error from a link after a reload', async () => {
    await app.applyRoute({
      source: { kind: 'local', name: 'never-picked' },
      commit: null,
      path: 'README.md',
      range: null,
    });

    expect(app.store.get().phase).toBe('error');
    expect(app.store.get().error?.kind).toBe('inaccessible');
    expect(app.store.get().error?.message).toContain('pick the folder again');
  });
});

describe('selecting lines', () => {
  it('clamps a selection to the file and orders reversed bounds', async () => {
    const { root } = makeFolder();
    await openFolder(app, root);

    app.selectRange(3, 1);
    expect(app.store.get().selection).toEqual({ start: 1, end: 3 });

    // selectRange counts lines with split('\n'), so the trailing newline is one more line.
    app.selectRange(0, 99);
    expect(app.store.get().selection).toEqual({
      start: 1,
      end: README.split('\n').length,
    });
  });

  it('ignores a selection when no text file is open', () => {
    app.selectRange(1, 2);
    expect(app.store.get().selection).toBeNull();
  });
});

describe('annotations', () => {
  it('saves a draft on the selected lines and persists it', async () => {
    const { root } = makeFolder();
    await openFolder(app, root);
    await app.openFile('src/app.ts', null);
    app.selectRange(2, 2);

    await app.saveDraft('question', 'why is b exported?');

    const state = app.store.get();
    expect(state.annotations).toHaveLength(1);
    const [note] = state.annotations;
    expect(note).toMatchObject({
      type: 'question',
      status: 'open',
      body: 'why is b exported?',
      quote: 'export const b = 2;',
    });
    expect(note?.anchor).toMatchObject({
      path: 'src/app.ts',
      start: { line: 2 },
      end: { line: 2 },
      commit: null,
    });
    expect(state.inspectorTarget).toBe(note?.id);
    expect(state.statusMessage).toBe('Annotation saved locally.');
    expect(await storedAnnotations(app)).toEqual([
      expect.objectContaining({ id: note?.id, body: 'why is b exported?' }),
    ]);
  });

  it('does nothing to stored notes without a selection', async () => {
    const { root } = makeFolder();
    await openFolder(app, root);

    await app.saveDraft('request', 'no lines chosen');

    expect(app.store.get().annotations).toEqual([]);
  });

  it('updates body and status but keeps the anchor and quote', async () => {
    const { root } = makeFolder();
    await openFolder(app, root);
    await app.openFile('src/app.ts', null);
    app.selectRange(1, 1);
    await app.saveDraft('concern', 'first draft');
    const original = app.store.get().annotations[0]!;

    await app.updateAnnotation(original.id, {
      body: 'revised',
      status: 'addressed',
    });

    const updated = app.store.get().annotations[0]!;
    expect(updated).toMatchObject({
      id: original.id,
      body: 'revised',
      status: 'addressed',
      type: 'concern',
    });
    expect(updated.anchor).toEqual(original.anchor);
    expect(updated.quote).toBe(original.quote);
    expect(await storedAnnotations(app)).toEqual([
      expect.objectContaining({ body: 'revised', status: 'addressed' }),
    ]);
  });

  it('removes a note from state, the tray and the inspector', async () => {
    const { root } = makeFolder();
    await openFolder(app, root);
    await app.openFile('src/app.ts', null);
    app.selectRange(3, 3);
    await app.saveDraft('note', 'nice');
    const id = app.store.get().annotations[0]!.id;
    app.trayAdd(id);

    await app.removeAnnotation(id);

    const state = app.store.get();
    expect(state.annotations).toEqual([]);
    expect(state.tray).toEqual([]);
    expect(state.inspectorTarget).toBeNull();
    expect(await storedAnnotations(app)).toEqual([]);
  });

  it("opens another file and selects a note's stored lines", async () => {
    const { root } = makeFolder();
    await openFolder(app, root);
    await app.openFile('src/app.ts', null);
    app.selectRange(2, 3);
    await app.saveDraft('question', 'two lines');
    const id = app.store.get().annotations[0]!.id;
    await app.openFile('README.md', null);

    app.openAnnotation(id);
    await vi.waitFor(() => expect(app.store.get().file?.state).toBe('text'));

    expect(app.store.get().selection).toEqual({ start: 2, end: 3 });
    expect(app.store.get().inspectorTarget).toBe(id);
  });

  it('flags a note as moved when its quoted text no longer appears', async () => {
    const { root } = makeFolder();
    await openFolder(app, root);
    await app.openFile('src/app.ts', null);
    app.selectRange(2, 2);
    await app.saveDraft('question', 'anchored to b');

    // Edit the file in place: the adapter keeps the handle it saw at open().
    const edited = (root.children.get('src') as FakeDir).children.get(
      'app.ts'
    ) as FakeFile;
    edited.content = 'export const a = 1;\nexport const z = 9;\n';
    await app.openFile('src/app.ts', null);

    const id = app.store.get().annotations[0]!.id;
    const resolutions = await app.recheckAnchorsForCurrentFile();
    expect(resolutions.get(id)?.state).toBe('moved');
  });
});

describe('review tray and packet', () => {
  it('keeps tray entries unique and reorders them within bounds', async () => {
    const { root } = makeFolder();
    await openFolder(app, root);
    await app.openFile('src/app.ts', null);
    for (const [line, body] of [
      [1, 'one'],
      [2, 'two'],
      [3, 'three'],
    ] as const) {
      app.selectRange(line, line);
      await app.saveDraft('question', body);
    }
    const [a, b, c] = app.store.get().annotations.map((n) => n.id);

    app.trayAdd(a!);
    app.trayAdd(b!);
    app.trayAdd(a!);
    app.trayAdd(c!);
    expect(app.store.get().tray).toEqual([a, b, c]);

    app.trayMove(a!, -1);
    expect(app.store.get().tray).toEqual([a, b, c]);
    app.trayMove(c!, 1);
    expect(app.store.get().tray).toEqual([a, b, c]);
    app.trayMove(c!, -1);
    expect(app.store.get().tray).toEqual([a, c, b]);

    app.trayRemove(c!);
    expect(app.store.get().tray).toEqual([a, b]);
    expect(app.store.get().annotations).toHaveLength(3);
  });

  it('builds the handoff packet in tray order and skips unknown ids', async () => {
    const { root } = makeFolder();
    await openFolder(app, root);
    await app.openFile('src/app.ts', null);
    app.selectRange(1, 1);
    await app.saveDraft('question', 'first note');
    app.selectRange(2, 2);
    await app.saveDraft('concern', 'second note');
    const [first, second] = app.store.get().annotations.map((n) => n.id);

    app.trayAdd(second!);
    app.trayAdd(first!);
    app.trayAdd('not-loaded');
    const packet = app.packet('  main  ');

    expect(packet).not.toBeNull();
    expect(packet!.markdown.indexOf('second note')).toBeLessThan(
      packet!.markdown.indexOf('first note')
    );
    expect(packet!.markdown).not.toContain('not-loaded');
    expect(packet!.prompt).toContain('first note');
    expect(JSON.parse(packet!.json).repo.targetRef).toBe('main');
  });

  it('returns no packet without an open repository', () => {
    expect(app.packet()).toBeNull();
  });
});

describe('backup export and import', () => {
  it('round-trips notes through the backup file', async () => {
    const { root } = makeFolder();
    await openFolder(app, root);
    await app.openFile('src/app.ts', null);
    app.selectRange(1, 1);
    await app.saveDraft('question', 'keep me');
    const backup = await app.exportBackup();
    const id = app.store.get().annotations[0]!.id;
    await app.removeAnnotation(id);

    const count = await app.importBackup(backup);

    expect(count).toBe(1);
    expect(app.store.get().annotations.map((n) => n.body)).toEqual(['keep me']);
    expect(app.store.get().statusMessage).toBe('Imported 1 annotation(s).');
  });

  it('rejects an invalid backup before storing anything', async () => {
    const { root } = makeFolder();
    await openFolder(app, root);
    await app.openFile('src/app.ts', null);
    app.selectRange(1, 1);
    await app.saveDraft('question', 'existing');
    const before = await storedAnnotations(app);

    await expect(
      app.importBackup('{"schemaVersion":999}')
    ).rejects.toBeInstanceOf(ImportError);

    expect(await storedAnnotations(app)).toEqual(before);
  });
});
