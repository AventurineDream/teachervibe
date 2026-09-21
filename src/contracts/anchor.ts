/**
 * Anchor creation and re-anchoring. Pure functions over file text; no I/O.
 *
 * Re-anchor contract (invariant 2 in schema.ts):
 *  - `exact`: the text at the stored range still hashes to the stored hash.
 *  - `relocated`: the exact quoted text was found at exactly one unambiguous new
 *    position (preferring a candidate whose context windows still match).
 *  - `moved`: zero candidates, or several candidates with no context winner.
 *    The viewer must surface this state and must never guess a nearby range.
 */

import type { Anchor, TextPosition } from './schema.js';

export const CONTEXT_LINES = 2;

export function linesOf(text: string): string[] {
  return text.split('\n');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Extract the exact text covered by a 1-based, column-exclusive range. Throws RangeError if out of bounds. */
export function selectedText(text: string, start: TextPosition, end: TextPosition): string {
  const lines = linesOf(text);
  if (start.line < 1 || end.line > lines.length || start.line > end.line) {
    throw new RangeError(`range ${start.line}-${end.line} outside ${lines.length} lines`);
  }
  const startLine = lines[start.line - 1]!;
  const endLine = lines[end.line - 1]!;
  if (start.column < 1 || end.column < 1 || start.column > startLine.length + 1 || end.column > endLine.length + 1) {
    throw new RangeError('column outside line');
  }
  if (start.line === end.line) return startLine.slice(start.column - 1, end.column - 1);
  const parts: string[] = [startLine.slice(start.column - 1)];
  for (let l = start.line + 1; l < end.line; l++) parts.push(lines[l - 1]!);
  parts.push(endLine.slice(0, end.column - 1));
  return parts.join('\n');
}

/** A whole-line range selection, the common case for annotation. */
export function lineRange(startLine: number, endLine: number, fileText: string): { start: TextPosition; end: TextPosition } {
  const lines = linesOf(fileText);
  if (startLine < 1 || endLine > lines.length || startLine > endLine) {
    throw new RangeError(`line range ${startLine}-${endLine} outside ${lines.length} lines`);
  }
  return {
    start: { line: startLine, column: 1 },
    end: { line: endLine, column: lines[endLine - 1]!.length + 1 }
  };
}

export async function createAnchor(input: {
  repoId: string;
  commit: string | null;
  path: string;
  start: TextPosition;
  end: TextPosition;
  fileText: string;
  symbol?: string;
}): Promise<{ anchor: Anchor; quote: string }> {
  const lines = linesOf(input.fileText);
  const quote = selectedText(input.fileText, input.start, input.end);
  const contextBefore = lines.slice(Math.max(0, input.start.line - 1 - CONTEXT_LINES), input.start.line - 1).join('\n');
  const contextAfter = lines.slice(input.end.line, input.end.line + CONTEXT_LINES).join('\n');
  const anchor: Anchor = {
    repoId: input.repoId,
    commit: input.commit,
    path: input.path,
    ...(input.symbol ? { symbol: input.symbol } : {}),
    start: input.start,
    end: input.end,
    textHash: await sha256Hex(quote),
    contextBefore,
    contextAfter
  };
  return { anchor, quote };
}

export type AnchorResolution =
  | { state: 'exact'; start: TextPosition; end: TextPosition }
  | { state: 'relocated'; start: TextPosition; end: TextPosition }
  | { state: 'moved'; reason: string };

/** Find every line-aligned occurrence of `quoteLines` inside `lines`. */
function findCandidates(lines: string[], quoteLines: string[]): number[] {
  const candidates: number[] = [];
  if (quoteLines.length === 0 || quoteLines.length > lines.length) return candidates;
  for (let i = 0; i + quoteLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < quoteLines.length; j++) {
      if (lines[i + j] !== quoteLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) candidates.push(i); // 0-based index of first line
  }
  return candidates;
}

function contextScore(lines: string[], firstLineIdx: number, quoteLen: number, anchor: Anchor): number {
  let score = 0;
  if (anchor.contextBefore) {
    const before = lines.slice(Math.max(0, firstLineIdx - CONTEXT_LINES), firstLineIdx).join('\n');
    if (before === anchor.contextBefore) score += 1;
  }
  if (anchor.contextAfter) {
    const after = lines.slice(firstLineIdx + quoteLen, firstLineIdx + quoteLen + CONTEXT_LINES).join('\n');
    if (after === anchor.contextAfter) score += 1;
  }
  return score;
}

export async function resolveAnchor(anchor: Anchor, quote: string, fileText: string): Promise<AnchorResolution> {
  // 1. Exact: text at the stored range still matches the stored hash.
  try {
    const current = selectedText(fileText, anchor.start, anchor.end);
    if ((await sha256Hex(current)) === anchor.textHash) {
      return { state: 'exact', start: anchor.start, end: anchor.end };
    }
  } catch {
    // Stored range no longer exists in this file at all; fall through to search.
  }

  // 2. Relocated: search for the quoted text. Line-aligned matching only in Phase 1:
  //    column-precise fuzzy matching earns its keep with Tree-sitter later.
  const lines = linesOf(fileText);
  const quoteLines = linesOf(quote);
  const candidates = findCandidates(lines, quoteLines);
  if (candidates.length === 0) {
    return { state: 'moved', reason: 'the quoted text no longer exists in this file' };
  }

  const lastLine = (idx: number) => ({
    start: { line: idx + 1, column: 1 },
    end: { line: idx + quoteLines.length, column: lines[idx + quoteLines.length - 1]!.length + 1 }
  });

  if (candidates.length === 1) {
    return { state: 'relocated', ...lastLine(candidates[0]!) };
  }

  // Several candidates: only a unique context-window winner relocates; anything else is moved.
  const scored = candidates
    .map((idx) => ({ idx, score: contextScore(lines, idx, quoteLines.length, anchor) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  if (best.score > 0 && (scored.length === 1 || scored[1]!.score < best.score)) {
    return { state: 'relocated', ...lastLine(best.idx) };
  }
  return { state: 'moved', reason: `the quoted text appears ${candidates.length} times with no context match to disambiguate` };
}
