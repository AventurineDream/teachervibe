/**
 * GitHub REST adapter. Token-free by design (Phase 1 boundary: public repositories
 * need no backend credentials). Unauthenticated requests share GitHub's 60/hr per-IP
 * rate limit; when it bites, the adapter reports a distinct `rate-limited` state.
 *
 * `fetchFn` is injectable so unit tests run without a network.
 */

import { repoId, type FileRecord, type GitHubSource, type RepositorySnapshot } from '../contracts/schema.js';
import { isBinaryPath, isGeneratedPath } from './classify.js';
import { SourceError, type FetchFileResult, type SourceAdapter } from './types.js';

const API = 'https://api.github.com';
const MAX_TEXT_BYTES = 1_000_000;

export interface GitHubSpec extends GitHubSource {
  /** Optional branch/tag/SHA from a pasted /tree/<ref> URL. */
  ref?: string;
}

/**
 * Accepts "owner/repo", "https://github.com/owner/repo", optional trailing .git,
 * and /tree/<ref> URLs. Throws SourceError('unsupported') on anything else.
 */
export function parseGitHubSpec(input: string): GitHubSpec {
  const trimmed = input.trim().replace(/\/+$/, '');
  const short = trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (short) return { kind: 'github', owner: short[1]!, repo: stripGit(short[2]!) };
  const url = trimmed.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/(.+))?$/);
  if (url) {
    const spec: GitHubSpec = { kind: 'github', owner: url[1]!, repo: url[2]! };
    if (url[3]) spec.ref = decodeURIComponent(url[3]);
    return spec;
  }
  throw new SourceError('unsupported', `not a GitHub repository: ${input}`);
}

function stripGit(repo: string): string {
  return repo.endsWith('.git') ? repo.slice(0, -4) : repo;
}

type FetchFn = typeof fetch;

async function apiJson(fetchFn: FetchFn, url: string, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Accept: 'application/vnd.github+json' } });
  } catch (err) {
    throw new SourceError('network', `could not reach GitHub while loading ${what}: ${(err as Error).message}`);
  }
  if (res.ok) return res.json();
  if (res.status === 404) throw new SourceError('not-found', `${what} not found (private repositories need a future authenticated adapter)`);
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = res.headers.get('x-ratelimit-reset');
    const when = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : 'later';
    throw new SourceError('rate-limited', `GitHub API rate limit reached; unauthenticated access resets at ${when}`);
  }
  if (res.status === 401 || res.status === 403) throw new SourceError('inaccessible', `GitHub refused access to ${what} (HTTP ${res.status})`);
  throw new SourceError('network', `GitHub returned HTTP ${res.status} for ${what}`);
}

export function createGitHubAdapter(fetchFn: FetchFn = fetch): SourceAdapter<GitHubSource> {
  return {
    kind: 'github',

    async open(source, ref) {
      const repoInfo = (await apiJson(
        fetchFn,
        `${API}/repos/${source.owner}/${source.repo}`,
        `repository ${source.owner}/${source.repo}`
      )) as { default_branch: string };
      const branch = ref ?? repoInfo.default_branch;

      let commit: string;
      if (/^[0-9a-f]{40}$/i.test(branch)) {
        commit = branch; // already a full SHA
      } else {
        const branchInfo = (await apiJson(
          fetchFn,
          `${API}/repos/${source.owner}/${source.repo}/branches/${encodeURIComponent(branch)}`,
          `branch ${branch}`
        )) as { commit: { sha: string } };
        commit = branchInfo.commit.sha;
      }

      const treeInfo = (await apiJson(
        fetchFn,
        `${API}/repos/${source.owner}/${source.repo}/git/trees/${commit}?recursive=1`,
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
        source: { kind: 'github', owner: source.owner, repo: source.repo },
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
      const url = `${API}/repos/${snapshot.repoId.slice('github:'.length)}/contents/${record.path.split('/').map(encodeURIComponent).join('/')}?ref=${snapshot.commit}`;
      let res: Response;
      try {
        res = await fetchFn(url, { headers: { Accept: 'application/vnd.github.raw' } });
      } catch (err) {
        throw new SourceError('network', `could not reach GitHub while loading ${record.path}: ${(err as Error).message}`);
      }
      if (res.status === 404) throw new SourceError('not-found', `${record.path} not found at this commit`);
      if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
        throw new SourceError('rate-limited', 'GitHub API rate limit reached while loading the file');
      }
      if (!res.ok) throw new SourceError('network', `GitHub returned HTTP ${res.status} for ${record.path}`);
      return { kind: 'text', text: await res.text() };
    },

    webUrl(snapshot, path, range) {
      const base = `https://github.com/${snapshot.repoId.slice('github:'.length)}`;
      if (!path) return `${base}/tree/${snapshot.commit}`;
      let url = `${base}/blob/${snapshot.commit}/${path}`;
      if (range) url += `#L${range.start}-L${range.end}`;
      return url;
    }
  };
}
