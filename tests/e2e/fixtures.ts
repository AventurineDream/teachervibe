/**
 * GitHub API fixtures served through Playwright route interception, so browser
 * tests are deterministic and never touch the network or rate limits.
 * The fixture repo is octo/hello at a fixed commit.
 */

import type { Page } from '@playwright/test';

export const OWNER = 'octo';
export const REPO = 'hello';
export const SHA = 'c0ffee11c0ffee11c0ffee11c0ffee11c0ffee11';

export const FILES: Record<string, string> = {
  'README.md': ['# hello', '', 'A tiny fixture repository.', '', '## Usage', '', 'Run the thing.'].join('\n'),
  'src/app.ts': [
    'export function greet(name: string): string {',
    '  return `hello ${name}`;',
    '}',
    '',
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '',
    'const result = add(1, 2);',
    'console.log(greet("world"), result);',
    ''
  ].join('\n'),
  'src/util.ts': ['export const VERSION = 1;', ''].join('\n'),
  'styles.css': ['body { margin: 0; }', ''].join('\n')
};

const TREE = {
  tree: [
    { path: 'README.md', type: 'blob', size: FILES['README.md']!.length, sha: '1' },
    { path: 'src', type: 'tree' },
    { path: 'src/app.ts', type: 'blob', size: FILES['src/app.ts']!.length, sha: '2' },
    { path: 'src/util.ts', type: 'blob', size: FILES['src/util.ts']!.length, sha: '3' },
    { path: 'styles.css', type: 'blob', size: FILES['styles.css']!.length, sha: '4' },
    { path: 'package-lock.json', type: 'blob', size: 9000, sha: '5' },
    { path: 'assets', type: 'tree' },
    { path: 'assets/logo.png', type: 'blob', size: 4321, sha: '6' }
  ],
  truncated: false
};

export interface FixtureOptions {
  /** Make a specific path's contents endpoint fail with this status. */
  failContentsWith?: { status: number; headers?: Record<string, string> };
  /** Make the repo metadata endpoint fail with this status. */
  failRepoWith?: number;
}

export async function installGitHubFixture(page: Page, opts: FixtureOptions = {}): Promise<void> {
  await page.route('https://api.github.com/**', (route) => {
    const url = route.request().url();
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      route.fulfill({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

    if (opts.failRepoWith && url === `https://api.github.com/repos/${OWNER}/${REPO}`) {
      return json({ message: 'Not Found' }, opts.failRepoWith);
    }
    if (url === `https://api.github.com/repos/${OWNER}/${REPO}`) return json({ default_branch: 'main' });
    if (url === `https://api.github.com/repos/${OWNER}/${REPO}/branches/main`) return json({ commit: { sha: SHA } });
    if (url.startsWith(`https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${SHA}`)) return json(TREE);
    const m = url.match(new RegExp(`^https://api\\.github\\.com/repos/${OWNER}/${REPO}/contents/(.+)\\?ref=${SHA}$`));
    if (m) {
      if (opts.failContentsWith) {
        return route.fulfill({ status: opts.failContentsWith.status, headers: opts.failContentsWith.headers ?? {}, body: '{}' });
      }
      const path = decodeURIComponent(m[1]!);
      const text = FILES[path];
      if (text === undefined) return route.fulfill({ status: 404, body: '{}' });
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/plain' }, body: text });
    }
    return json({ message: `unrouted: ${url}` }, 500);
  });
}

/** Open the app and load the fixture repository through the switcher. */
export async function openFixtureRepo(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByPlaceholder(/owner\/repo/i).fill(`${OWNER}/${REPO}`);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.locator('[data-nav="file"][data-path="src/app.ts"]').waitFor();
}

/** Open a file through the tree, opening the nav drawer first at phone widths. */
export async function openFixtureFile(page: Page, path: string): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) < 821) {
    await page.locator('[data-action="drawer-nav"]').click();
  }
  await page.locator(`[data-nav="file"][data-path="${path}"]`).click();
}
