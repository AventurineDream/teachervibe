/**
 * TeacherVibe contracts - the single source of truth for every layer of the app.
 *
 * Invariants (enforced by tests, relied on by storage and export):
 *
 * 1. COMMIT PINNING. Every reading session on a git source is pinned to an exact
 *    commit SHA. Branch names are display labels only. `RepositorySnapshot.commit`
 *    is non-null for git sources (`github`, `forgejo`) and null only for `local`
 *    sources, where no durable revision exists. An `Anchor` inherits the commit of
 *    the session it was created in; an anchor with a null commit can only ever
 *    resolve against a local folder and must be treated as best-effort.
 *
 * 2. FAILED RE-ANCHORING IS EXPLICIT. When an anchor cannot be resolved against a
 *    (different) commit, the viewer reports `moved`. It never silently attaches a
 *    note to nearby code. See `resolveAnchor` in anchor.ts.
 *
 * 3. VERSIONED SERIALIZATION. Anything written to disk or exported carries an
 *    integer schema version (`ANNOTATION_SCHEMA_VERSION`, `REVIEW_PACKET_VERSION`).
 *    Imports reject unknown versions loudly. Exports are deterministic: the same
 *    stored state always produces byte-identical output (no wall-clock fields in
 *    the packet itself).
 *
 * 4. READ-ONLY READING SURFACE. `FileRecord` and file content flow toward display,
 *    selection, and hashing only. No contract here carries an edit operation.
 */

export const ANNOTATION_SCHEMA_VERSION = 1;
export const REVIEW_PACKET_VERSION = 1;

export type SourceKind = 'github' | 'forgejo' | 'local';

export interface GitHubSource {
  kind: 'github';
  owner: string;
  repo: string;
}

export interface ForgejoSource {
  kind: 'forgejo';
  /** Base URL of the Forgejo instance, e.g. "http://10.0.0.108:3000". No trailing slash. */
  baseUrl: string;
  owner: string;
  repo: string;
}

export interface LocalSource {
  kind: 'local';
  /** Display name, usually the picked directory's name. */
  name: string;
}

export type RepositorySource = GitHubSource | ForgejoSource | LocalSource;

/** Stable identity string for a repository, independent of revision. Used as the storage key. */
export function repoId(source: RepositorySource): string {
  switch (source.kind) {
    case 'github':
      return `github:${source.owner}/${source.repo}`;
    case 'forgejo':
      return `forgejo:${source.baseUrl}/${source.owner}/${source.repo}`;
    case 'local':
      return `local:${source.name}`;
  }
}

/** Canonical web URL for a source, when one exists. Local sources have none. */
export function repoWebUrl(source: RepositorySource, commit?: string | null): string | null {
  switch (source.kind) {
    case 'github':
      return `https://github.com/${source.owner}/${source.repo}` + (commit ? `/tree/${commit}` : '');
    case 'forgejo':
      return `${source.baseUrl}/${source.owner}/${source.repo}` + (commit ? `/src/commit/${commit}` : '');
    case 'local':
      return null;
  }
}

export interface FileRecord {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
  sha?: string;
  /** True when the path is known-binary by extension or the host API said so. */
  binary: boolean;
  /** True for generated, vendored, or lockfile content: shown muted in the tree. */
  generated: boolean;
}

export interface RepositorySnapshot {
  source: RepositorySource;
  repoId: string;
  /** Display label only; the commit is the durable reference. Null for local sources. */
  defaultBranch: string | null;
  /** Pinned commit SHA. Non-null for git sources; null only for local sources. */
  commit: string | null;
  tree: FileRecord[];
  /** True when the host API truncated the tree listing. */
  truncated: boolean;
}

/** 1-based line/column position. `column` is a character offset within the line. */
export interface TextPosition {
  line: number;
  column: number;
}

/**
 * A layered anchor. Layers, in order of authority:
 *   1. repoId + commit (which snapshot)
 *   2. path (+ optional symbol identity, future)
 *   3. start/end line/column at the pinned commit
 *   4. textHash of the exact selected text, plus small before/after context windows,
 *      used to re-anchor after the code moves.
 * The selected text itself lives on `Annotation.quote` and participates in re-anchoring.
 */
export interface Anchor {
  repoId: string;
  commit: string | null;
  path: string;
  symbol?: string;
  start: TextPosition;
  end: TextPosition;
  /** Lowercase hex SHA-256 of the exact selected text at the pinned commit. */
  textHash: string;
  /** Up to 2 lines of text immediately before the selection (joined by \n). */
  contextBefore: string;
  /** Up to 2 lines of text immediately after the selection (joined by \n). */
  contextAfter: string;
}

export type AnnotationType = 'note' | 'question' | 'request' | 'decision' | 'concern';
export const ANNOTATION_TYPES: readonly AnnotationType[] = ['note', 'question', 'request', 'decision', 'concern'];

export type AnnotationStatus = 'open' | 'handed-off' | 'addressed' | 'superseded';
export const ANNOTATION_STATUSES: readonly AnnotationStatus[] = ['open', 'handed-off', 'addressed', 'superseded'];

export interface Annotation {
  id: string;
  schemaVersion: number;
  type: AnnotationType;
  status: AnnotationStatus;
  body: string;
  /** The exact selected text captured when the annotation was made. */
  quote: string;
  anchor: Anchor;
  /** ISO timestamps; stored data. Never emitted by export code at export time. */
  createdAt: string;
  updatedAt: string;
}

export interface ReadingTrailEntry {
  repoId: string;
  commit: string | null;
  path: string;
  range?: { start: number; end: number };
  kind: 'file' | 'selection';
  visitedAt: string;
}

export interface ReviewPacketAnnotation {
  id: string;
  type: AnnotationType;
  status: AnnotationStatus;
  body: string;
  quote: string;
  anchor: Anchor;
}

export interface ReviewPacket {
  packetVersion: number;
  repo: {
    source: RepositorySource;
    repoId: string;
    url: string | null;
    baseCommit: string | null;
    /** Branch or commit the notes should be applied to, when known. */
    targetRef: string | null;
  };
  /** Ordered by the human in the review tray; order is meaningful and preserved. */
  annotations: ReviewPacketAnnotation[];
}
