/**
 * Hash routing. URLs carry repository, pinned revision, path, and line range so
 * any view can be restored from a link. Hash-based because the app is served as
 * static files with no rewrite rules (lilbox, tailnet, Pages mirrors).
 *
 *   #/gh/<owner>/<repo>/<commit>/<path...>[?L=a-b]
 *   #/fj/<enc(baseUrl)>/<owner>/<repo>/<commit>/<path...>[?L=a-b]
 *   #/local/<enc(name)>/<path...>[?L=a-b]
 */

import { repoId, type RepositorySource } from '../contracts/schema.js';

/** A restorable view. `commit` is null for local folders; `range` is a 1-based inclusive line range. */
export interface Route {
  source: RepositorySource;
  commit: string | null;
  path: string | null;
  range: { start: number; end: number } | null;
}

const seg = encodeURIComponent;
const un = decodeURIComponent;

/** Serializes a Route to the hash formats in the file header; path segments are percent-encoded individually. */
export function buildHash(route: Route): string {
  let base: string;
  const s = route.source;
  switch (s.kind) {
    case 'github':
      base = `#/gh/${seg(s.owner)}/${seg(s.repo)}/${seg(route.commit ?? '')}`;
      break;
    case 'forgejo':
      base = `#/fj/${seg(s.baseUrl)}/${seg(s.owner)}/${seg(s.repo)}/${seg(route.commit ?? '')}`;
      break;
    case 'local':
      base = `#/local/${seg(s.name)}`;
      break;
  }
  if (route.path) base += '/' + route.path.split('/').map(seg).join('/');
  if (route.range) base += `?L=${route.range.start}-${route.range.end}`;
  return base;
}

/** Parses a hash produced by buildHash(); the leading `#` is optional. Returns null when it is empty or not a recognized route. */
export function parseHash(hash: string): Route | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const [pathPart, queryPart] = raw.split('?');
  const parts = (pathPart ?? '').split('/').filter(Boolean).map(un);
  if (parts.length === 0) return null;

  let source: RepositorySource;
  let commit: string | null = null;
  let rest: string[];
  const kind = parts[0];
  if (kind === 'gh' && parts.length >= 4) {
    source = { kind: 'github', owner: parts[1]!, repo: parts[2]! };
    commit = parts[3] || null;
    rest = parts.slice(4);
  } else if (kind === 'fj' && parts.length >= 5) {
    source = {
      kind: 'forgejo',
      baseUrl: parts[1]!,
      owner: parts[2]!,
      repo: parts[3]!,
    };
    commit = parts[4] || null;
    rest = parts.slice(5);
  } else if (kind === 'local' && parts.length >= 2) {
    source = { kind: 'local', name: parts[1]! };
    rest = parts.slice(2);
  } else {
    return null;
  }

  let range: Route['range'] = null;
  const m = queryPart?.match(/^L=(\d+)-(\d+)$/);
  if (m) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (start >= 1 && end >= start) range = { start, end };
  }
  return { source, commit, path: rest.length ? rest.join('/') : null, range };
}

/** Fingerprint used to decide whether a route change needs a new snapshot. */
export function snapshotKey(route: Route): string {
  return `${repoId(route.source)}@${route.commit ?? ''}`;
}
