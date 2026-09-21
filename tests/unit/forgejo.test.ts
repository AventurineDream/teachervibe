import { describe, expect, it } from 'vitest';
import { createForgejoAdapter, parseForgejoSpec } from '../../src/sources/forgejo.js';
import { SourceError } from '../../src/sources/types.js';

describe('parseForgejoSpec', () => {
  it('parses instance URL + owner + repo', () => {
    expect(parseForgejoSpec('http://10.0.0.108:3000/aven/lightwell')).toEqual({
      kind: 'forgejo',
      baseUrl: 'http://10.0.0.108:3000',
      owner: 'aven',
      repo: 'lightwell'
    });
  });
  it('captures a branch pin', () => {
    expect(parseForgejoSpec('https://git.example.com/o/r/src/branch/dev').ref).toBe('dev');
  });
  it('rejects non-URLs', () => {
    expect(() => parseForgejoSpec('octo/hello')).toThrow(SourceError);
  });
});

const SHA = 'd'.repeat(40);

function fakeFetch(routes: Record<string, Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
    for (const [prefix, res] of ordered) {
      if (url.startsWith(prefix)) return res.clone();
    }
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
}

const routes = {
  'http://f.local/api/v1/repos/aven/app/branches/main': new Response(JSON.stringify({ commit: { id: SHA } })),
  [`http://f.local/api/v1/repos/aven/app/git/trees/${SHA}`]: new Response(
    JSON.stringify({ tree: [{ path: 'a.txt', type: 'blob', size: 12, sha: '9' }], truncated: false })
  ),
  'http://f.local/api/v1/repos/aven/app': new Response(JSON.stringify({ default_branch: 'main' })),
  [`http://f.local/api/v1/repos/aven/app/contents/a.txt?ref=${SHA}`]: new Response(
    JSON.stringify({ content: btoa('hello forgejo'), encoding: 'base64' })
  )
};

describe('forgejo adapter', () => {
  it('opens, pins, and reads files through the Gitea-shaped API', async () => {
    const adapter = createForgejoAdapter(fakeFetch(routes));
    const snapshot = await adapter.open({ kind: 'forgejo', baseUrl: 'http://f.local', owner: 'aven', repo: 'app' });
    expect(snapshot.commit).toBe(SHA);
    expect(snapshot.repoId).toBe('forgejo:http://f.local/aven/app');
    const record = snapshot.tree.find((f) => f.path === 'a.txt')!;
    const result = await adapter.fetchFile(snapshot, record);
    expect(result).toEqual({ kind: 'text', text: 'hello forgejo' });
    expect(adapter.webUrl(snapshot, 'a.txt')).toBe(`http://f.local/aven/app/src/commit/${SHA}/a.txt`);
  });
});
