/**
 * In-memory stand-in for a File System Access directory handle, shared by the unit
 * tests that exercise local-folder code. Files and folders are plain maps so a test
 * can edit content or add entries after open() to check what the app re-reads.
 * Only the members the app uses are implemented: async iteration, getFile(), name, kind.
 */

export interface FakeFile {
  kind: 'file';
  name: string;
  content: string;
  getFile(): Promise<{ size: number; text(): Promise<string> }>;
}

export interface FakeDir {
  kind: 'directory';
  name: string;
  children: Map<string, FakeNode>;
  [Symbol.asyncIterator](): AsyncIterator<FakeNode>;
}

export type FakeNode = FakeFile | FakeDir;

/** A file whose size is the UTF-8 byte length of its current content. */
export function file(name: string, content: string): FakeFile {
  const node: FakeFile = {
    kind: 'file',
    name,
    content,
    getFile: async () => ({
      size: new TextEncoder().encode(node.content).byteLength,
      text: async () => node.content,
    }),
  };
  return node;
}

/** A folder holding `entries`, keyed by their names. */
export function dir(name: string, entries: FakeNode[]): FakeDir {
  const children = new Map(entries.map((e) => [e.name, e]));
  return {
    kind: 'directory',
    name,
    children,
    async *[Symbol.asyncIterator]() {
      yield* children.values();
    },
  };
}

/** Views a fake folder as the handle that pickLocalFolder() would return. */
export function folderHandle(d: FakeDir): FileSystemDirectoryHandle {
  return d as unknown as FileSystemDirectoryHandle;
}
