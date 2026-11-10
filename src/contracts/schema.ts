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

/**
 * Version of the Annotation shape (invariant 3). Stamped on new annotations and on
 * backup files; importAnnotations() rejects backup files with any other value.
 */
export const ANNOTATION_SCHEMA_VERSION = 1;
/**
 * Version of the ReviewPacket shape, written as `packetVersion` to packet JSON and
 * Markdown. Packets are write-only here: nothing in the app reads one back.
 */
export const REVIEW_PACKET_VERSION = 1;

/** Repository host family; the discriminant of RepositorySource and SourceAdapter.kind. */
export type SourceKind = 'github' | 'forgejo' | 'local';

/** A repository on github.com. No host field: the adapter only talks to api.github.com. */
export interface GitHubSource {
  kind: 'github';
  owner: string;
  repo: string;
}

/**
 * A repository on a Forgejo (or other Gitea-compatible) instance. `baseUrl` is part of
 * repoId, so the same repository reached through another base URL (a hostname instead
 * of an IP, say) is a different repository and does not share annotations.
 */
export interface ForgejoSource {
  kind: 'forgejo';
  /** Base URL of the Forgejo instance, e.g. "https://git.example.com". No trailing slash. */
  baseUrl: string;
  owner: string;
  repo: string;
}

/**
 * A folder opened through the File System Access API. `name` is its whole identity:
 * two folders with the same name get the same repoId and so share annotations.
 */
export interface LocalSource {
  kind: 'local';
  /** Display name, usually the picked directory's name. */
  name: string;
}

/**
 * Where a repository lives. Carries no revision: the pinned commit is on
 * RepositorySnapshot and Anchor (invariant 1).
 */
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
export function repoWebUrl(
  source: RepositorySource,
  commit?: string | null
): string | null {
  switch (source.kind) {
    case 'github':
      return (
        `https://github.com/${source.owner}/${source.repo}` +
        (commit ? `/tree/${commit}` : '')
      );
    case 'forgejo':
      return (
        `${source.baseUrl}/${source.owner}/${source.repo}` +
        (commit ? `/src/commit/${commit}` : '')
      );
    case 'local':
      return null;
  }
}

/**
 * One entry of a snapshot's file tree. `type` uses git's names for every source:
 * `blob` is a file, `tree` a directory.
 */
export interface FileRecord {
  /** Repository-relative and '/'-separated, with no leading slash. */
  path: string;
  type: 'blob' | 'tree';
  /**
   * Size in bytes, when the source reports it. fetchFile() uses it to refuse files
   * over the 1 MB text limit without loading them.
   */
  size?: number;
  /** Git object id from the host's tree listing (not a commit SHA); absent for local folders. */
  sha?: string;
  /**
   * True when the extension marks the path as binary (isBinaryPath); contents are
   * never inspected. fetchFile() then reports `binary` without loading the file.
   */
  binary: boolean;
  /** True for generated, vendored, or lockfile content: shown muted in the tree. */
  generated: boolean;
}

/**
 * A repository opened at one revision: what SourceAdapter.open() returns and what the
 * reading surface renders.
 */
export interface RepositorySnapshot {
  source: RepositorySource;
  /** Always repoId(source); annotations are looked up by it. */
  repoId: string;
  /** Display label only; the commit is the durable reference. Null for local sources. */
  defaultBranch: string | null;
  /** Pinned commit SHA. Non-null for git sources; null only for local sources. */
  commit: string | null;
  /**
   * Files and directories, sorted by path. Git sources keep only blob and tree entries
   * (submodules are dropped); local folders leave out their skipped directories.
   */
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
  /** Exclusive: the quote stops just before this column. */
  end: TextPosition;
  /** Lowercase hex SHA-256 of the exact selected text at the pinned commit. */
  textHash: string;
  /** Up to 2 lines of text immediately before the selection (joined by \n). */
  contextBefore: string;
  /** Up to 2 lines of text immediately after the selection (joined by \n). */
  contextAfter: string;
}

/** Kind of note: shown as its tag and margin glyph and carried into review packets. */
export type AnnotationType =
  'note' | 'question' | 'request' | 'decision' | 'concern';
/**
 * Every AnnotationType, in the order the inspector lists them. Import validation
 * accepts only these, so a type missing here makes its annotations unimportable.
 */
export const ANNOTATION_TYPES: readonly AnnotationType[] = [
  'note',
  'question',
  'request',
  'decision',
  'concern',
];

/**
 * Where a note stands. New notes start `open`, and the app never changes a status on
 * its own: exporting a packet, for example, does not mark its notes `handed-off`.
 */
export type AnnotationStatus =
  'open' | 'handed-off' | 'addressed' | 'superseded';
/**
 * Every AnnotationStatus, in inspector order. Like ANNOTATION_TYPES, it is also the
 * set import validation accepts.
 */
export const ANNOTATION_STATUSES: readonly AnnotationStatus[] = [
  'open',
  'handed-off',
  'addressed',
  'superseded',
];

/**
 * A reader's note pinned to an exact text range. Stored in IndexedDB under `id`,
 * backed up by exportAnnotations(), and handed off through review packets.
 */
export interface Annotation {
  /**
   * crypto.randomUUID() at creation. Imports keep it, so importing the same backup
   * twice overwrites instead of duplicating.
   */
  id: string;
  /** ANNOTATION_SCHEMA_VERSION when written; importAnnotations() re-stamps it. */
  schemaVersion: number;
  type: AnnotationType;
  status: AnnotationStatus;
  /** The note text as typed; may be empty. */
  body: string;
  /** The exact selected text captured when the annotation was made. */
  quote: string;
  anchor: Anchor;
  /** ISO timestamps; stored data. Never emitted by export code at export time. */
  createdAt: string;
  /**
   * Re-stamped on every edit; equals createdAt until the first. Imports store '' for
   * either timestamp when the backup lacks it.
   */
  updatedAt: string;
}

/**
 * One step of the reading trail (Trail tab): a file opened or lines selected. Kept in
 * memory for the open repository only; never stored or exported.
 */
export interface ReadingTrailEntry {
  repoId: string;
  commit: string | null;
  path: string;
  /** 1-based inclusive lines; set only on `selection` entries. */
  range?: { start: number; end: number };
  kind: 'file' | 'selection';
  /** ISO timestamp of the visit. */
  visitedAt: string;
}

/**
 * The part of an Annotation a packet carries. schemaVersion and the timestamps are
 * left out, keeping wall-clock fields out of packets (invariant 3).
 */
export interface ReviewPacketAnnotation {
  id: string;
  type: AnnotationType;
  status: AnnotationStatus;
  body: string;
  quote: string;
  anchor: Anchor;
}

/**
 * The handoff artifact: built by buildReviewPacket() from the review tray, exported as
 * JSON and Markdown, and condensed into an agent prompt by promptFromPacket().
 */
export interface ReviewPacket {
  packetVersion: number;
  repo: {
    source: RepositorySource;
    repoId: string;
    /** repoWebUrl() at baseCommit; null for local folders. */
    url: string | null;
    /**
     * Commit of the snapshot being viewed (null for local folders). Each anchor keeps
     * the commit it was made at, which may differ.
     */
    baseCommit: string | null;
    /** Branch or commit the notes should be applied to, when known. */
    targetRef: string | null;
  };
  /** Ordered by the human in the review tray; order is meaningful and preserved. */
  annotations: ReviewPacketAnnotation[];
}
