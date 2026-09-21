import { describe, expect, it } from 'vitest';
import { buildReviewPacket, exportAnnotations, importAnnotations, ImportError, promptFromPacket, stableStringify } from '../../src/contracts/serialize.js';
import type { Annotation, RepositorySnapshot } from '../../src/contracts/schema.js';

function makeAnnotation(id: string, line: number): Annotation {
  return {
    id,
    schemaVersion: 1,
    type: 'question',
    status: 'open',
    body: `body ${id}`,
    quote: `line ${line}`,
    anchor: {
      repoId: 'github:octo/hello',
      commit: 'c'.repeat(40),
      path: 'src/app.ts',
      start: { line, column: 1 },
      end: { line, column: 8 },
      textHash: 'a'.repeat(64),
      contextBefore: '',
      contextAfter: ''
    },
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z'
  };
}

const snapshot: RepositorySnapshot = {
  source: { kind: 'github', owner: 'octo', repo: 'hello' },
  repoId: 'github:octo/hello',
  defaultBranch: 'main',
  commit: 'c'.repeat(40),
  tree: [],
  truncated: false
};

describe('exportAnnotations / importAnnotations', () => {
  it('round-trips annotations', () => {
    const original = [makeAnnotation('b', 5), makeAnnotation('a', 1)];
    const imported = importAnnotations(exportAnnotations(original));
    expect(imported.map((a) => a.id)).toEqual(['a', 'b']); // sorted by anchor position
    expect(imported[0]!.quote).toBe('line 1');
  });

  it('is deterministic', () => {
    const list = [makeAnnotation('b', 5), makeAnnotation('a', 1)];
    expect(exportAnnotations(list)).toBe(exportAnnotations([...list].reverse()));
  });

  it('rejects unknown schema versions loudly', () => {
    expect(() => importAnnotations(JSON.stringify({ schemaVersion: 99, annotations: [] }))).toThrow(ImportError);
    expect(() => importAnnotations('{"schemaVersion":99')).toThrow(ImportError);
  });

  it('rejects malformed anchors', () => {
    const bad = makeAnnotation('x', 1);
    (bad.anchor as { textHash: string }).textHash = 'not-a-hash';
    const json = JSON.stringify({ schemaVersion: 1, annotations: [bad] });
    expect(() => importAnnotations(json)).toThrow(/textHash/);
  });
});

describe('stableStringify', () => {
  it('sorts object keys recursively', () => {
    const a = stableStringify({ b: 1, a: { d: 2, c: 3 } });
    expect(a.indexOf('"a"')).toBeLessThan(a.indexOf('"b"'));
    expect(stableStringify({ a: 1, b: [2, { d: 4, c: 3 }] })).toBe(stableStringify({ b: [2, { c: 3, d: 4 }], a: 1 }));
  });
});

describe('buildReviewPacket', () => {
  it('emits deterministic Markdown + JSON carrying the full anchor identity', () => {
    const annotations = [makeAnnotation('a', 1), makeAnnotation('b', 5)];
    const one = buildReviewPacket({ snapshot, annotations, targetRef: 'main' });
    const two = buildReviewPacket({ snapshot, annotations, targetRef: 'main' });
    expect(one.markdown).toBe(two.markdown);
    expect(one.json).toBe(two.json);

    expect(one.markdown).toContain('# Review packet - github:octo/hello');
    expect(one.markdown).toContain(`Base commit: ${'c'.repeat(40)}`);
    expect(one.markdown).toContain('Target: main');
    expect(one.markdown).toContain('## 1. [question] src/app.ts L1-L1 (open)');
    expect(one.markdown).toContain('> line 1');
    expect(one.markdown).toContain(`sha256:${'a'.repeat(12)} id:a`);

    const parsed = JSON.parse(one.json) as { packetVersion: number; annotations: { id: string }[] };
    expect(parsed.packetVersion).toBe(1);
    expect(parsed.annotations.map((a) => a.id)).toEqual(['a', 'b']); // tray order preserved
  });

  it('keeps the human-chosen order instead of sorting', () => {
    const annotations = [makeAnnotation('b', 5), makeAnnotation('a', 1)];
    const { packet } = buildReviewPacket({ snapshot, annotations });
    expect(packet.annotations.map((a) => a.id)).toEqual(['b', 'a']);
  });

  it('marks local sources as having no commit', () => {
    const local: RepositorySnapshot = { ...snapshot, source: { kind: 'local', name: 'scratch' }, repoId: 'local:scratch', commit: null, defaultBranch: null };
    const { markdown } = buildReviewPacket({ snapshot: local, annotations: [makeAnnotation('a', 1)] });
    expect(markdown).toContain('Base commit: (local folder, no commit)');
  });
});

describe('promptFromPacket', () => {
  it('compresses a packet into a paste-ready agent prompt', () => {
    const { packet } = buildReviewPacket({ snapshot, annotations: [makeAnnotation('a', 5), makeAnnotation('b', 9)], targetRef: 'main' });
    const prompt = promptFromPacket(packet);
    expect(prompt).toContain('github:octo/hello');
    expect(prompt).toContain('Base commit: ' + 'c'.repeat(40));
    expect(prompt).toContain('Target: main');
    expect(prompt).toContain('1. [question] src/app.ts L5-L5');
    expect(prompt).toContain('> line 5');
    expect(prompt).toContain('body a');
    expect(prompt).toContain('2. [question] src/app.ts L9-L9');
    // no markdown headers, no wall-clock, deterministic
    expect(prompt).not.toContain('#');
    expect(promptFromPacket(packet)).toBe(prompt);
  });

  it('handles a local snapshot without a commit or url', () => {
    const local: RepositorySnapshot = { ...snapshot, source: { kind: 'local', name: 'scratch' }, repoId: 'local:scratch', commit: null, defaultBranch: null };
    const { packet } = buildReviewPacket({ snapshot: local, annotations: [makeAnnotation('a', 1)] });
    const prompt = promptFromPacket(packet);
    expect(prompt).toContain('Base commit: local working tree');
    expect(prompt).toContain('local:scratch');
  });
});
