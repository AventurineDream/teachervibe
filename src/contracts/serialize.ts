/**
 * Versioned, deterministic serialization for annotations and review packets.
 *
 * Determinism (invariant 3): exports contain no wall-clock fields and object keys
 * are emitted in sorted order, so identical stored state produces identical bytes.
 * The caller controls annotation order; `exportAnnotations` sorts for stable backups,
 * while `buildReviewPacket` preserves the review tray's human-chosen order.
 */

import {
  ANNOTATION_SCHEMA_VERSION,
  ANNOTATION_STATUSES,
  ANNOTATION_TYPES,
  REVIEW_PACKET_VERSION,
  repoWebUrl,
  type Annotation,
  type AnnotationStatus,
  type AnnotationType,
  type RepositorySnapshot,
  type ReviewPacket
} from './schema.js';

/** JSON.stringify with recursively sorted object keys. Arrays keep their order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

interface AnnotationExportFile {
  schemaVersion: number;
  annotations: Annotation[];
}

/** Deterministic backup of a set of annotations, sorted by anchor position. */
export function exportAnnotations(annotations: Annotation[]): string {
  const sorted = [...annotations].sort((a, b) =>
    [a.anchor.repoId, a.anchor.path, a.anchor.start.line, a.id].join('').localeCompare(
      [b.anchor.repoId, b.anchor.path, b.anchor.start.line, b.id].join('')
    )
  );
  const file: AnnotationExportFile = { schemaVersion: ANNOTATION_SCHEMA_VERSION, annotations: sorted };
  return stableStringify(file);
}

export class ImportError extends Error {}

/** Parse and validate an annotation export. Unknown schema versions are rejected loudly. */
export function importAnnotations(json: string): Annotation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ImportError('not valid JSON');
  }
  const file = parsed as Partial<AnnotationExportFile>;
  if (typeof file !== 'object' || file === null) throw new ImportError('not an annotation export object');
  if (file.schemaVersion !== ANNOTATION_SCHEMA_VERSION) {
    throw new ImportError(
      `unsupported schema version ${String(file.schemaVersion)} (this build reads ${ANNOTATION_SCHEMA_VERSION})`
    );
  }
  if (!Array.isArray(file.annotations)) throw new ImportError('missing annotations array');
  return file.annotations.map((raw, i) => validateAnnotation(raw, i));
}

function validateAnnotation(raw: unknown, index: number): Annotation {
  const a = raw as Annotation;
  const where = `annotation ${index + 1}`;
  if (typeof a !== 'object' || a === null) throw new ImportError(`${where}: not an object`);
  if (typeof a.id !== 'string' || !a.id) throw new ImportError(`${where}: missing id`);
  if (!ANNOTATION_TYPES.includes(a.type)) throw new ImportError(`${where}: bad type ${String(a.type)}`);
  if (!ANNOTATION_STATUSES.includes(a.status)) throw new ImportError(`${where}: bad status ${String(a.status)}`);
  if (typeof a.body !== 'string') throw new ImportError(`${where}: body must be a string`);
  if (typeof a.quote !== 'string') throw new ImportError(`${where}: quote must be a string`);
  const anchor = a.anchor;
  if (typeof anchor !== 'object' || anchor === null) throw new ImportError(`${where}: missing anchor`);
  if (typeof anchor.repoId !== 'string' || typeof anchor.path !== 'string') {
    throw new ImportError(`${where}: anchor needs repoId and path`);
  }
  if (typeof anchor.textHash !== 'string' || !/^[0-9a-f]{64}$/.test(anchor.textHash)) {
    throw new ImportError(`${where}: anchor textHash must be a lowercase sha-256 hex string`);
  }
  for (const pos of [anchor.start, anchor.end]) {
    if (typeof pos?.line !== 'number' || typeof pos?.column !== 'number' || pos.line < 1 || pos.column < 1) {
      throw new ImportError(`${where}: anchor positions must be 1-based line/column numbers`);
    }
  }
  return {
    id: a.id,
    schemaVersion: ANNOTATION_SCHEMA_VERSION,
    type: a.type as AnnotationType,
    status: a.status as AnnotationStatus,
    body: a.body,
    quote: a.quote,
    anchor,
    createdAt: typeof a.createdAt === 'string' ? a.createdAt : '',
    updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : ''
  };
}

/**
 * Assemble the handoff artifact. `annotations` arrive in review-tray order; that
 * order is part of the packet and is preserved in both Markdown and JSON.
 */
export function buildReviewPacket(input: {
  snapshot: RepositorySnapshot;
  annotations: Annotation[];
  targetRef?: string | null;
}): { packet: ReviewPacket; json: string; markdown: string } {
  const { snapshot, annotations } = input;
  const packet: ReviewPacket = {
    packetVersion: REVIEW_PACKET_VERSION,
    repo: {
      source: snapshot.source,
      repoId: snapshot.repoId,
      url: repoWebUrl(snapshot.source, snapshot.commit),
      baseCommit: snapshot.commit,
      targetRef: input.targetRef?.trim() ? input.targetRef.trim() : null
    },
    annotations: annotations.map((a) => ({
      id: a.id,
      type: a.type,
      status: a.status,
      body: a.body,
      quote: a.quote,
      anchor: a.anchor
    }))
  };
  return { packet, json: stableStringify(packet), markdown: packetMarkdown(packet) };
}


/**
 * Compress a review packet into a ready-to-paste agent prompt (pillar 3 of the
 * product direction: one-button export). Deliberately plain and compact: repo
 * identity, ground rules, then numbered notes with their quoted anchors.
 * Deterministic - no wall-clock fields.
 */
export function promptFromPacket(packet: ReviewPacket): string {
  const { repo } = packet;
  const lines: string[] = [];
  lines.push(`You are working in the repository ${repo.repoId}${repo.url ? ` (${repo.url})` : ''}.`);
  lines.push(`Base commit: ${repo.baseCommit ?? 'local working tree'}. Target: ${repo.targetRef ?? 'the next commit'}.`);
  lines.push(
    'Apply each numbered review note below. Every note quotes the exact code it refers to; use the quote to locate the spot even if line numbers drifted. Make only the change each note asks for, keep unrelated code untouched, and reply with a short summary of what you changed per note.'
  );
  lines.push('');
  packet.annotations.forEach((a, i) => {
    const at = a.anchor;
    lines.push(`${i + 1}. [${a.type}] ${at.path} L${at.start.line}-L${at.end.line}`);
    for (const q of a.quote.split('\n')) lines.push(`> ${q}`);
    if (a.body.trim()) lines.push(a.body.trim());
    lines.push('');
  });
  return lines.join('\n').trimEnd() + '\n';
}

function packetMarkdown(packet: ReviewPacket): string {
  const { repo } = packet;
  const lines: string[] = [];
  lines.push(`# Review packet - ${repo.repoId}`);
  lines.push('');
  if (repo.url) lines.push(`- Repository: ${repo.url}`);
  lines.push(`- Base commit: ${repo.baseCommit ?? '(local folder, no commit)'}`);
  lines.push(`- Target: ${repo.targetRef ?? 'next commit'}`);
  lines.push(`- Packet version: ${packet.packetVersion}`);
  lines.push(`- Notes: ${packet.annotations.length}`);
  lines.push('');
  packet.annotations.forEach((a, i) => {
    const at = a.anchor;
    const range = `L${at.start.line}-L${at.end.line}`;
    lines.push(`## ${i + 1}. [${a.type}] ${at.path} ${range} (${a.status})`);
    lines.push('');
    for (const q of a.quote.split('\n')) lines.push(`> ${q}`);
    lines.push('');
    if (a.body.trim()) {
      lines.push(a.body.trim());
      lines.push('');
    }
    lines.push(
      `Anchor: ${at.repoId} @ ${at.commit ?? 'local'} ${at.path} ${at.start.line}:${at.start.column}-${at.end.line}:${at.end.column} sha256:${at.textHash.slice(0, 12)} id:${a.id}`
    );
    lines.push('');
  });
  return lines.join('\n');
}
