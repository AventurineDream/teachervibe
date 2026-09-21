/**
 * Local folder adapter (File System Access API). Chromium-only in Phase 1;
 * browsers without showDirectoryPicker get an explicit `unsupported` state.
 *
 * Commit pinning invariant: a local folder has no durable revision, so the
 * snapshot's commit is null and every anchor created here is best-effort.
 * The directory handle itself cannot survive a browser restart; a reopened
 * session asks for the folder again.
 */

import { repoId, type FileRecord, type LocalSource, type RepositorySnapshot } from '../contracts/schema.js';
import { isBinaryPath, isGeneratedPath } from './classify.js';
import { SourceError, type FetchFileResult, type SourceAdapter } from './types.js';

const MAX_TEXT_BYTES = 1_000_000;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target']);

export function localFoldersSupported(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export function createLocalAdapter(handle: FileSystemDirectoryHandle): SourceAdapter<LocalSource> & { pickAndOpen(): Promise<RepositorySnapshot> } {
  const files = new Map<string, FileSystemFileHandle>();

  async function walk(dir: FileSystemDirectoryHandle, prefix: string, tree: FileRecord[]): Promise<void> {
    for await (const entry of dir as unknown as AsyncIterable<FileSystemHandle>) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        tree.push({ path, type: 'tree', binary: false, generated: isGeneratedPath(path + '/') });
        await walk(entry as FileSystemDirectoryHandle, path, tree);
      } else {
        const fileHandle = entry as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        tree.push({
          path,
          type: 'blob',
          size: file.size,
          binary: isBinaryPath(path),
          generated: isGeneratedPath(path)
        });
        files.set(path, fileHandle);
      }
    }
  }

  const adapter = {
    kind: 'local' as const,

    async open(source: LocalSource): Promise<RepositorySnapshot> {
      files.clear();
      const tree: FileRecord[] = [];
      try {
        await walk(handle, '', tree);
      } catch (err) {
        throw new SourceError('inaccessible', `could not read the folder: ${(err as Error).message}`);
      }
      tree.sort((a, b) => a.path.localeCompare(b.path));
      return {
        source,
        repoId: repoId(source),
        defaultBranch: null,
        commit: null,
        tree,
        truncated: false
      };
    },

    async fetchFile(_snapshot: RepositorySnapshot, record: FileRecord): Promise<FetchFileResult> {
      if (record.type !== 'blob') return { kind: 'unsupported', reason: 'not a file' };
      if (record.binary) return { kind: 'binary' };
      if (record.size !== undefined && record.size > MAX_TEXT_BYTES) {
        return { kind: 'unsupported', reason: `file is ${(record.size / 1_000_000).toFixed(1)} MB; text preview limit is 1 MB` };
      }
      const fileHandle = files.get(record.path);
      if (!fileHandle) throw new SourceError('not-found', `${record.path} is not in the picked folder`);
      return { kind: 'text', text: await (await fileHandle.getFile()).text() };
    },

    webUrl() {
      return null;
    },

    async pickAndOpen(): Promise<RepositorySnapshot> {
      return adapter.open({ kind: 'local', name: handle.name });
    }
  };

  return adapter;
}

/** Prompt for a directory. Resolves to null when the user cancels. */
export async function pickLocalFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!localFoldersSupported()) {
    throw new SourceError('unsupported', 'this browser cannot open local folders (File System Access API missing)');
  }
  try {
    return await (globalThis as unknown as { showDirectoryPicker(): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null;
    throw new SourceError('inaccessible', `folder access was refused: ${(err as Error).message}`);
  }
}
