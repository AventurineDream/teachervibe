import { describe, expect, it } from 'vitest';
import { createGitHubAdapter, parseGitHubSpec } from '../../src/sources/github.js';
import { SourceError } from '../../src/sources/types.js';

describe('parseGitHubSpec', () => {
  it('accepts owner/repo shorthand', () => {
    expect(parseGitHubSpec('octo/hello')).toEqual({ kind: 'github', owner: 'octo', repo: 'hello' });
  });
  it('accepts full URLs and strips .git', () => {
    expect(parseGitHubSpec('https://github.com/octo/hello.git')).toEqual({ kind: 'github', owner: 'octo', repo: 'hello' });
    expect(parseGitHubSpec('https://github.com/octo/hello/')).toEqual({ kind: 'github', owner: 'octo', repo: 'hello' });
  });
  it('captures a /tree/<ref> pin', () => {
    expect(parseGitHubSpec('https://github.com/octo/hello/tree/feature/x').ref).toBe('feature/x');
  });
  it('rejects non-GitHub input as unsupported', () => {
    expect(() => parseGitHubSpec('just some words')).toThrow(SourceError);
    expect(() => parseGitHubSpec('http://10.0.0.108:3000/a/b')).toThrow(SourceError);
  });
});

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...init.headers } });
}

function fakeFetch(routes: Record<string, Response | (() => Response)>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
    for (const [prefix, res] of ordered) {
      if (url.startsWith(prefix)) return typeof res === 'function' ? res() : res.clone();
    }
    return jsonResponse({ message: 'unrouted' }, { status: 500 });
  }) as typeof fetch;
}

const SHA = 'c'.repeat(40);
const TREE = {
  tree: [
    { path: 'src', type: 'tree' },
    { path: 'src/app.ts', type: 'blob', size: 42, sha: '1' },
    { path: 'package-lock.json', type: 'blob', size: 9000, sha: '2' },
    { path: 'logo.png', type: 'blob', size: 500, sha: '3' }
  ],
  truncated: false
};

function standardRoutes() {
  return {
    'https://api.github.com/repos/octo/hello/branches/main': jsonResponse({ commit: { sha: SHA } }),
    [`https://api.github.com/repos/octo/hello/git/trees/${SHA}`]: jsonResponse(TREE),
    'https://api.github.com/repos/octo/hello': jsonResponse({ default_branch: 'main' })
  };
}

describe('github adapter', () => {
  it('resolves default branch to a pinned commit and classifies the tree', async () => {
    const adapter = createGitHubAdapter(fakeFetch(standardRoutes()));
    const snapshot = await adapter.open({ kind: 'github', owner: 'octo', repo: 'hello' });
    expect(snapshot.commit).toBe(SHA);
    expect(snapshot.repoId).toBe('github:octo/hello');
    const lock = snapshot.tree.find((f) => f.path === 'package-lock.json')!;
    expect(lock.generated).toBe(true);
    expect(snapshot.tree.find((f) => f.path === 'logo.png')!.binary).toBe(true);
    expect(snapshot.tree.find((f) => f.path === 'src/app.ts')!.binary).toBe(false);
  });

  it('maps 404 to not-found', async () => {
    const adapter = createGitHubAdapter(fakeFetch({ 'https://api.github.com/': jsonResponse({}, { status: 404 }) }));
    await expect(adapter.open({ kind: 'github', owner: 'octo', repo: 'missing' })).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('maps an exhausted rate limit to rate-limited', async () => {
    const adapter = createGitHubAdapter(
      fakeFetch({ 'https://api.github.com/': jsonResponse({}, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' } }) })
    );
    await expect(adapter.open({ kind: 'github', owner: 'octo', repo: 'hello' })).rejects.toMatchObject({ kind: 'rate-limited' });
  });

  it('fetches file text at the pinned commit', async () => {
    const adapter = createGitHubAdapter(
      fakeFetch({
        ...standardRoutes(),
        [`https://api.github.com/repos/octo/hello/contents/src/app.ts?ref=${SHA}`]: new Response('const x = 1;\n', { status: 200 })
      })
    );
    const snapshot = await adapter.open({ kind: 'github', owner: 'octo', repo: 'hello' });
    const record = snapshot.tree.find((f) => f.path === 'src/app.ts')!;
    const result = await adapter.fetchFile(snapshot, record);
    expect(result).toEqual({ kind: 'text', text: 'const x = 1;\n' });
  });

  it('short-circuits binary and oversized files without fetching', async () => {
    let calls = 0;
    const counting = (async (...args: Parameters<typeof fetch>) => {
      calls++;
      return fakeFetch(standardRoutes())(...args);
    }) as typeof fetch;
    const adapter = createGitHubAdapter(counting);
    const snapshot = await adapter.open({ kind: 'github', owner: 'octo', repo: 'hello' });
    calls = 0;
    const binary = await adapter.fetchFile(snapshot, snapshot.tree.find((f) => f.path === 'logo.png')!);
    expect(binary.kind).toBe('binary');
    const huge = await adapter.fetchFile(snapshot, { path: 'big.txt', type: 'blob', size: 5_000_000, binary: false, generated: false });
    expect(huge.kind).toBe('unsupported');
    expect(calls).toBe(0);
  });

  it('skips branch resolution when the ref is already a full SHA', async () => {
    let branchCalled = false;
    const routes = standardRoutes();
    const tracking = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/branches/')) branchCalled = true;
      return fakeFetch(routes)(input);
    }) as typeof fetch;
    const adapter = createGitHubAdapter(tracking);
    const snapshot = await adapter.open({ kind: 'github', owner: 'octo', repo: 'hello' }, SHA);
    expect(branchCalled).toBe(false);
    expect(snapshot.commit).toBe(SHA);
  });
});
