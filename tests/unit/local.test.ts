/**
 * Unit tests for the local-folder adapter. Uses an in-memory fake of the File System
 * Access directory handles, so the tests exercise the tree walk, reads and error
 * kinds that the app sees, without a browser picker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalAdapter,
  localFoldersSupported,
  pickLocalFolder,
} from '../../src/sources/local.js';
import { SourceError } from '../../src/sources/types.js';
import type { LocalSource } from '../../src/contracts/schema.js';
import {
  dir,
  file,
  folderHandle as asHandle,
  type FakeDir,
  type FakeFile,
} from './support/fake-folder.js';

const source: LocalSource = { kind: 'local', name: 'notes' };

function sample(): FakeDir {
  return dir('notes', [
    file('README.md', '# Notes\nhello\n'),
    dir('src', [file('app.ts', 'export const x = 1;\n')]),
    dir('node_modules', [file('left-pad.js', 'module.exports = 1;\n')]),
    dir('.git', [file('HEAD', 'ref: refs/heads/main\n')]),
    file('logo.png', 'not really a png'),
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createLocalAdapter.open', () => {
  it('lists files and folders sorted by path, with sizes and flags', async () => {
    const adapter = createLocalAdapter(asHandle(sample()));
    const snap = await adapter.open(source);

    expect(snap.repoId).toBe('local:notes');
    expect(snap.commit).toBeNull();
    expect(snap.defaultBranch).toBeNull();
    expect(snap.truncated).toBe(false);
    expect(snap.tree.map((r) => r.path)).toEqual([
      'logo.png',
      'README.md',
      'src',
      'src/app.ts',
    ]);
    const app = snap.tree.find((r) => r.path === 'src/app.ts');
    expect(app).toMatchObject({
      type: 'blob',
      binary: false,
      generated: false,
    });
    expect(app?.size).toBe(
      new TextEncoder().encode('export const x = 1;\n').length
    );
    expect(snap.tree.find((r) => r.path === 'src')).toMatchObject({
      type: 'tree',
    });
    expect(snap.tree.find((r) => r.path === 'logo.png')?.binary).toBe(true);
  });

  it('skips well-known generated folders at any depth', async () => {
    const root = dir('notes', [
      dir('pkg', [dir('node_modules', [file('a.js', '1')]), file('b.ts', '2')]),
      dir('dist', [file('bundle.js', '3')]),
    ]);
    const snap = await createLocalAdapter(asHandle(root)).open(source);
    expect(snap.tree.map((r) => r.path)).toEqual(['pkg', 'pkg/b.ts']);
  });

  it('marks lockfile-style generated paths without hiding them', async () => {
    const root = dir('notes', [file('package-lock.json', '{}')]);
    const snap = await createLocalAdapter(asHandle(root)).open(source);
    expect(snap.tree).toHaveLength(1);
    expect(snap.tree[0]?.generated).toBe(true);
  });

  it('reports an unreadable entry as an inaccessible SourceError', async () => {
    const broken: FakeDir = dir('notes', []);
    broken[Symbol.asyncIterator] = () => ({
      next: async () => {
        throw new Error('permission denied');
      },
    });
    const err = await createLocalAdapter(asHandle(broken))
      .open(source)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).kind).toBe('inaccessible');
    expect((err as SourceError).message).toContain('permission denied');
  });
});

describe('createLocalAdapter.fetchFile', () => {
  it('returns the current text, so edits made after open() are shown', async () => {
    const root = sample();
    const adapter = createLocalAdapter(asHandle(root));
    const snap = await adapter.open(source);
    const record = snap.tree.find((r) => r.path === 'README.md')!;

    const before = await adapter.fetchFile(snap, record);
    expect(before).toEqual({ kind: 'text', text: '# Notes\nhello\n' });

    (root.children.get('README.md') as FakeFile).content = '# Notes\nedited\n';
    const after = await adapter.fetchFile(snap, record);
    expect(after).toEqual({ kind: 'text', text: '# Notes\nedited\n' });
  });

  it('returns binary without reading binary content', async () => {
    const reads = vi.fn();
    const png = file('logo.png', 'x');
    png.getFile = async () => {
      reads();
      return { size: 1, text: async () => 'x' };
    };
    const adapter = createLocalAdapter(asHandle(dir('notes', [png])));
    const snap = await adapter.open(source);
    reads.mockClear(); // open() also reads each file's size; only fetchFile's read counts here
    const result = await adapter.fetchFile(snap, snap.tree[0]!);
    expect(result).toEqual({ kind: 'binary' });
    expect(reads).not.toHaveBeenCalled();
  });

  it('refuses text over 1,000,000 bytes using the size from open()', async () => {
    const big = file('big.txt', 'a'.repeat(1_000_001));
    const adapter = createLocalAdapter(asHandle(dir('notes', [big])));
    const snap = await adapter.open(source);
    const result = await adapter.fetchFile(snap, snap.tree[0]!);
    expect(result.kind).toBe('unsupported');
    if (result.kind === 'unsupported') {
      expect(result.reason).toContain('text preview limit is 1 MB');
    }
  });

  it('throws not-found for a file that the last open() did not list', async () => {
    const root = sample();
    const adapter = createLocalAdapter(asHandle(root));
    const snap = await adapter.open(source);

    root.children.set('new.md', file('new.md', 'added later'));
    const record = {
      path: 'new.md',
      type: 'blob' as const,
      binary: false,
      generated: false,
    };
    const err = await adapter.fetchFile(snap, record).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).kind).toBe('not-found');

    await adapter.open(source);
    await expect(adapter.fetchFile(snap, record)).resolves.toEqual({
      kind: 'text',
      text: 'added later',
    });
  });

  it('returns unsupported for a folder record', async () => {
    const adapter = createLocalAdapter(asHandle(sample()));
    const snap = await adapter.open(source);
    const folder = snap.tree.find((r) => r.type === 'tree')!;
    await expect(adapter.fetchFile(snap, folder)).resolves.toEqual({
      kind: 'unsupported',
      reason: 'not a file',
    });
  });
});

describe('createLocalAdapter.pickAndOpen and webUrl', () => {
  it('opens the picked folder under its own name and has no web URL', async () => {
    const adapter = createLocalAdapter(asHandle(sample()));
    const snap = await adapter.pickAndOpen();
    expect(snap.source).toEqual({ kind: 'local', name: 'notes' });
    expect(snap.repoId).toBe('local:notes');
    expect(adapter.webUrl(snap, 'README.md')).toBeNull();
  });
});

describe('local folder picker', () => {
  it('reports unsupported when showDirectoryPicker is missing', async () => {
    expect(localFoldersSupported()).toBe(false);
    const err = await pickLocalFolder().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).kind).toBe('unsupported');
  });

  it('resolves to null when the user cancels the picker', async () => {
    vi.stubGlobal('showDirectoryPicker', async () => {
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    });
    expect(localFoldersSupported()).toBe(true);
    await expect(pickLocalFolder()).resolves.toBeNull();
  });

  it('returns the picked handle', async () => {
    const handle = asHandle(sample());
    vi.stubGlobal('showDirectoryPicker', async () => handle);
    await expect(pickLocalFolder()).resolves.toBe(handle);
  });

  it('wraps other picker failures as inaccessible', async () => {
    vi.stubGlobal('showDirectoryPicker', async () => {
      throw Object.assign(new Error('needs a user gesture'), {
        name: 'SecurityError',
      });
    });
    const err = await pickLocalFolder().catch((e: unknown) => e);
    expect((err as SourceError).kind).toBe('inaccessible');
    expect((err as SourceError).message).toContain('needs a user gesture');
  });
});
