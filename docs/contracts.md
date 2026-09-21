# Contracts and invariants

The schemas live in `src/contracts/schema.ts` as versioned TypeScript types.
This document is the human-readable statement of the invariants the rest of the
app - and every future adapter - must preserve.

## 1. Commit pinning

Every reading session on a git source is pinned to an exact commit SHA.
`RepositorySnapshot.commit` is non-null for `github` and `forgejo` sources.
Branch names are display labels only; a pasted `/tree/<branch>` URL is resolved
to its SHA at open time. `local` sources have no durable revision: their commit
is null and every anchor created against them is best-effort.

`Anchor.commit` is the session's pinned commit at creation time. Comparing an
annotation's anchor commit to the viewed commit is how the viewer knows a note
may be stale.

## 2. Failed re-anchoring is explicit

Anchors are layered: repo identity + commit, then path, then start/end
line/column, then a SHA-256 hash of the exact selected text plus two-line
before/after context windows. `resolveAnchor` (src/contracts/anchor.ts) resolves
an anchor against new file text in order:

1. `exact` - the text at the stored range still hashes identically.
2. `relocated` - the quoted text appears at exactly one unambiguous position
   (a single occurrence, or a unique context-window winner).
3. `moved` - the text is gone or ambiguous. The viewer surfaces this state and
   never guesses a nearby range.

## 3. Versioned, deterministic serialization

- `ANNOTATION_SCHEMA_VERSION` stamps annotation exports; unknown versions are
  rejected loudly, never coerced.
- `REVIEW_PACKET_VERSION` stamps review packets.
- Exports contain no wall-clock fields and use recursively sorted object keys:
  identical stored state produces byte-identical output.
- Review packet annotation order is the human-chosen review-tray order; it is
  meaningful and preserved in both Markdown and JSON.

## 4. Read-only reading surface

Contracts carry display, selection, hashing, and export operations only. There
is no edit operation anywhere in `src/contracts/`; handoff happens through the
exported packet, which another agent or tool acts on.

## Storage

Browser-local IndexedDB (`reader-store`, DB version 1): `annotations` (keyPath
`id`, index `byRepo` on `anchor.repoId`) and `kv` session state. Reading-trail
entries are session-scoped and kept in memory. Nothing leaves the browser except
explicit exports.
