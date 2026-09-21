import { describe, expect, it } from 'vitest';
import { createAnchor, lineRange, resolveAnchor, selectedText, sha256Hex } from '../../src/contracts/anchor.js';

const FILE = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n');

describe('selectedText', () => {
  it('extracts whole-line ranges', () => {
    const { start, end } = lineRange(2, 4, FILE);
    expect(selectedText(FILE, start, end)).toBe('two\nthree\nfour');
  });
  it('extracts column-precise ranges', () => {
    expect(selectedText(FILE, { line: 1, column: 2 }, { line: 1, column: 4 })).toBe('ne');
  });
  it('rejects out-of-bounds ranges', () => {
    expect(() => lineRange(0, 3, FILE)).toThrow(RangeError);
    expect(() => lineRange(2, 99, FILE)).toThrow(RangeError);
    expect(() => lineRange(5, 2, FILE)).toThrow(RangeError);
  });
});

describe('createAnchor', () => {
  it('captures the hash and 2-line context windows', async () => {
    const { start, end } = lineRange(3, 4, FILE);
    const { anchor, quote } = await createAnchor({ repoId: 'github:o/r', commit: 'a'.repeat(40), path: 'f.txt', start, end, fileText: FILE });
    expect(quote).toBe('three\nfour');
    expect(anchor.textHash).toBe(await sha256Hex('three\nfour'));
    expect(anchor.contextBefore).toBe('one\ntwo');
    expect(anchor.contextAfter).toBe('five\nsix');
  });
  it('clips context at file edges', async () => {
    const { start, end } = lineRange(1, 1, FILE);
    const { anchor } = await createAnchor({ repoId: 'github:o/r', commit: null, path: 'f.txt', start, end, fileText: FILE });
    expect(anchor.contextBefore).toBe('');
    expect(anchor.contextAfter).toBe('two\nthree');
  });
});

describe('resolveAnchor', () => {
  async function anchorOn(file: string, a: number, b: number) {
    const { start, end } = lineRange(a, b, file);
    return createAnchor({ repoId: 'github:o/r', commit: 'c'.repeat(40), path: 'f.txt', start, end, fileText: file });
  }

  it('resolves exact when the range is untouched', async () => {
    const { anchor, quote } = await anchorOn(FILE, 3, 4);
    const res = await resolveAnchor(anchor, quote, FILE);
    expect(res.state).toBe('exact');
    if (res.state !== 'moved') expect(res.start.line).toBe(3);
  });

  it('relocates when the block shifted', async () => {
    const { anchor, quote } = await anchorOn(FILE, 3, 4);
    const moved = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n');
    const res = await resolveAnchor(anchor, quote, moved);
    expect(res.state).toBe('relocated');
    if (res.state === 'relocated') {
      expect(res.start.line).toBe(4);
      expect(res.end.line).toBe(5);
    }
  });

  it('reports moved when the text is gone', async () => {
    const { anchor, quote } = await anchorOn(FILE, 3, 4);
    const res = await resolveAnchor(anchor, quote, 'completely\ndifferent\nfile');
    expect(res.state).toBe('moved');
  });

  it('reports moved rather than guessing between duplicates', async () => {
    const dup = ['alpha', 'beta', 'x', 'alpha', 'beta', 'y'].join('\n');
    const { anchor, quote } = await anchorOn(dup, 1, 2);
    // same quote twice, contexts ('' / 'x') differ: anchor contextBefore is '' so candidate at line 4 has contextBefore 'beta'? no:
    // candidate at 1: before='', after='x'; candidate at 4: before='beta', after='y' -- wait, before for 4 is lines 2-3 = 'beta\nx'.
    const res = await resolveAnchor(anchor, quote, dup.replace('x', 'x'));
    // candidate at line 1 matches exact, so exact wins
    expect(res.state).toBe('exact');
    // now the original spot changed too: quote appears twice, no context winner
    const shifted = ['zz', 'alpha', 'beta', 'alpha', 'beta'].join('\n');
    const res2 = await resolveAnchor(anchor, quote, shifted);
    expect(res2.state).toBe('moved');
  });

  it('relocates when the quote survives at exactly one new position', async () => {
    const base = ['head', 'ctx-a', 'ctx-b', 'target-a', 'target-b', 'tail-a', 'tail-b', 'target-a', 'target-b', 'other'].join('\n');
    const { anchor, quote } = await anchorOn(base, 3, 4); // quote 'ctx-b\ntarget-a'
    const changed = ['head', 'gone', 'ctx-a', 'ctx-b', 'target-a', 'tail-a', 'tail-b', 'target-a', 'x'].join('\n');
    const res = await resolveAnchor(anchor, quote, changed);
    expect(res.state).toBe('relocated');
    if (res.state === 'relocated') expect(res.start.line).toBe(4);
  });

  it('relocates via context windows when the quote appears twice', async () => {
    const base = ['pre1', 'pre2', 'A', 'B', 'post1', 'post2', 'x', 'A', 'B', 'z'].join('\n');
    const { anchor, quote } = await anchorOn(base, 3, 4); // quote 'A\nB'
    const changed = ['shift', 'pre1', 'pre2', 'A', 'B', 'post1', 'post2', 'A', 'B', 'z'].join('\n');
    const res = await resolveAnchor(anchor, quote, changed);
    expect(res.state).toBe('relocated');
    if (res.state === 'relocated') {
      expect(res.start.line).toBe(4);
      expect(res.end.line).toBe(5);
    }
  });
});
