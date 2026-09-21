/**
 * Forgejo REST adapter (Gitea-compatible /api/v1). Same snapshot contract as the
 * GitHub adapter. Token-free: works against public repositories on any reachable
 * instance, including LAN-only servers when the browser is on the same network.
 *
 * NOTE: verified only against the API contract and unit fixtures so far; the
 * reference instance (http://10.0.0.108:3000) is LAN-only and unreachable from
 * the build environment. First real run against a live Forgejo is a QA task.
 */

import { repoId, type FileRecord, type ForgejoSource, type RepositorySnapshot } from '../contracts/schema.js';
import { isBinaryPath, isGeneratedPath } from './classify.js';
import { SourceError, type FetchFileResult, type SourceAdapter } from './types.js';

const MAX_TEXT_BYTES = 1_000_000;

/** Accepts "http(s)://host[:port]/owner/repo" (optionally /src/branch/<ref>). */
export function parseForgejoSpec(input: string): ForgejoSource & { ref?: string } {
  const m = input.trim().replace(/\/+$/, '').match(/^(https?:\/\/[^/]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/src\/(?:branch|commit)\/(.+))?$/);
  if (!m) throw new SourceError('unsupported', `not a Forgejo repository URL: ${input}`);
  const spec: ForgejoSource & { ref?: string } = { kind: 'forgejo', baseUrl: m[1]!, owner: m[2]!, repo: m[3]! };
  if (m[4]) spec.ref = decodeURIComponent(m[4]);
  return spec;
}

type FetchFn = typeof fetch;

function decodeBase64Text(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function apiJson(fetchFn: FetchFn, url: string, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new SourceError('network', `could not reach the Forgejo host while loading ${what}: ${(err as Error).message}`);
  }
  if (res.ok) return res.json();
  if (res.status === 404) throw new SourceError('not-found', `${what} not found on this Forgejo host`);
  if (res.status === 401 || res.status === 403) throw new SourceError('inaccessible', `Forgejo refused access to ${what} (HTTP ${res.status})`);
  if (res.status === 429) throw new SourceError('rate-limited', `Forgejo rate-limited the request for ${what}`);
  throw new SourceError('network', `Forgejo returned HTTP ${res.status} for ${what}`);
}

export function createForgejoAdapter(fetchFn: FetchFn = fetch): SourceAdapter<ForgejoSource> {
  return {
    kind: 'forgejo',

    async open(source, ref) {
      const base = source.baseUrl;
      const repoInfo = (await apiJson(
        fetchFn,
        `${base}/api/v1/repos/${source.owner}/${source.repo}`,
        `repository ${source.owner}/${source.repo}`
      )) as { default_branch: string };
      const branch = ref ?? repoInfo.default_branch;

      let commit: string;
      if (/^[0-9a-f]{40}$/i.test(branch)) {
        commit = branch;
      } else {
        const branchInfo = (await apiJson(
          fetchFn,
          `${base}/api/v1/repos/${source.owner}/${source.repo}/branches/${encodeURIComponent(branch)}`,
          `branch ${branch}`
        )) as { commit: { id: string } };
        commit = branchInfo.commit.id;
      }

      const treeInfo = (await apiJson(
        fetchFn,
        `${base}/api/v1/repos/${source.owner}/${source.repo}/git/trees/${commit}?recursive=1`,
        `tree at ${commit.slice(0, 7)}`
      )) as { tree: Array<{ path: string; type: string; size?: number; sha?: string }>; truncated?: boolean };

      const tree: FileRecord[] = treeInfo.tree
        .filter((e) => e.type === 'blob' || e.type === 'tree')
        .map((e) => ({
          path: e.path,
          type: e.type as 'blob' | 'tree',
          ...(e.size !== undefined ? { size: e.size } : {}),
          ...(e.sha ? { sha: e.sha } : {}),
          binary: e.type === 'blob' && isBinaryPath(e.path),
          generated: isGeneratedPath(e.path)
        }))
        .sort((a, b) => a.path.localeCompare(b.path));

      return {
        source: { kind: 'forgejo', baseUrl: source.baseUrl, owner: source.owner, repo: source.repo },
        repoId: repoId(source),
        defaultBranch: repoInfo.default_branch,
        commit,
        tree,
        truncated: Boolean(treeInfo.truncated)
      };
    },

    async fetchFile(snapshot, record) {
      if (record.type !== 'blob') return { kind: 'unsupported', reason: 'not a file' };
      if (record.binary) return { kind: 'binary' };
      if (record.size !== undefined && record.size > MAX_TEXT_BYTES) {
        return { kind: 'unsupported', reason: `file is ${(record.size / 1_000_000).toFixed(1)} MB; text preview limit is 1 MB` };
      }
      const src = snapshot.source as ForgejoSource;
      const url = `${src.baseUrl}/api/v1/repos/${src.owner}/${src.repo}/contents/${record.path.split('/').map(encodeURIComponent).join('/')}?ref=${snapshot.commit}`;
      const data = (await apiJson(fetchFn, url, record.path)) as { content?: string; encoding?: string };
      if (typeof data.content !== 'string' || data.encoding !== 'base64') {
        return { kind: 'unsupported', reason: 'Forgejo did not return base64 content for this file' };
      }
      return { kind: 'text', text: decodeBase64Text(data.content) };
    },

    webUrl(snapshot, path, range) {
      const src = snapshot.source as ForgejoSource;
      const base = `${src.baseUrl}/${src.owner}/${src.repo}`;
      if (!path) return `${base}/src/commit/${snapshot.commit}`;
      let url = `${base}/src/commit/${snapshot.commit}/${path}`;
      if (range) url += `#L${range.start}-L${range.end}`;
      return url;
    }
  };
}
