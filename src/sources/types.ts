/**
 * Source adapter boundary. Every repository host (GitHub REST, Forgejo REST,
 * local folder) normalizes into the same `RepositorySnapshot` contract, so the
 * reading surface never knows where code came from.
 *
 * Failure vocabulary (surfaced as distinct UI states per the Phase 1 acceptance
 * criteria): not-found, inaccessible, rate-limited, unsupported, network.
 */

import type {
  FileRecord,
  RepositorySnapshot,
  RepositorySource,
  SourceKind,
} from '../contracts/schema.js';

/** Why a source failed; each value maps to a distinct UI state. */
export type SourceErrorKind =
  'not-found' | 'inaccessible' | 'rate-limited' | 'unsupported' | 'network';

/** Error carrying a SourceErrorKind so callers can branch without parsing messages. */
export class SourceError extends Error {
  readonly kind: SourceErrorKind;
  constructor(kind: SourceErrorKind, message: string) {
    super(message);
    this.name = 'SourceError';
    this.kind = kind;
  }
}

/** `text` has content; `binary` is a deliberate non-error state; `unsupported` explains why a file is not shown (for example too large). */
export type FetchFileResult =
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  | { kind: 'unsupported'; reason: string };

/**
 * One repository host behind the snapshot contract, implemented by
 * createGitHubAdapter(), createForgejoAdapter() and createLocalAdapter(). Request and
 * lookup failures use SourceError; native decoding and local file-read errors may
 * propagate unchanged.
 */
export interface SourceAdapter<S extends RepositorySource = RepositorySource> {
  readonly kind: SourceKind;
  /**
   * Resolve the default branch or supplied branch/full SHA to a pinned snapshot.
   * Trees may be truncated by the host; local snapshots have commit = null and
   * omit skipped directories.
   */
  open(source: S, ref?: string): Promise<RepositorySnapshot>;
  /** Load one file's content on demand. Binary and oversized files are explicit states, not errors. */
  fetchFile(
    snapshot: RepositorySnapshot,
    record: FileRecord
  ): Promise<FetchFileResult>;
  /** Host deep link with an optional 1-based inclusive line range; null for local folders. */
  webUrl(
    snapshot: RepositorySnapshot,
    path?: string,
    range?: { start: number; end: number }
  ): string | null;
}
