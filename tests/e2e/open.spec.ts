import { expect, test } from '@playwright/test';
import { FILES, installGitHubFixture, openFixtureFile, openFixtureRepo, SHA } from './fixtures.js';

test.beforeEach(async ({ page }) => {
  await installGitHubFixture(page);
});

test('opens a public repository pinned to an exact commit', async ({ page }) => {
  await openFixtureRepo(page);
  // session pinned: commit chip shows the short SHA, URL carries repo + commit
  await expect(page.locator('[data-role="commit"]')).toContainText(`@${SHA.slice(0, 7)}`);
  await expect(page.locator('[data-role="commit"]')).toContainText('main');
  expect(page.url()).toContain(`#/gh/octo/hello/${SHA}/`);
  // default file is the README
  await expect(page.locator('.crumb')).toHaveText('README.md');
});

test('navigates the tree without any editing affordance', async ({ page }) => {
  await installGitHubFixture(page);
  await openFixtureRepo(page);
  await openFixtureFile(page, 'src/app.ts');
  await expect(page.locator('.crumb')).toHaveText('src/app.ts');
  await expect(page.locator('.code .line').first()).toBeVisible();
  expect(page.url()).toContain('src/app.ts');
  // read-only: no contenteditable, no code editor textarea
  await expect(page.locator('.code [contenteditable="true"]')).toHaveCount(0);
  await expect(page.locator('.code textarea')).toHaveCount(0);
  // generated and binary entries are marked in the tree
  await expect(page.locator('[data-nav="file"][data-path="package-lock.json"] .badge')).toHaveText('generated');
  await expect(page.locator('[data-nav="file"][data-path="assets/logo.png"] .badge')).toHaveText('binary');
});

test('outline and trail views work', async ({ page }) => {
  await installGitHubFixture(page);
  await openFixtureRepo(page);
  await openFixtureFile(page, 'src/app.ts');
  const openNav = async () => {
    if ((page.viewportSize()?.width ?? 1280) < 821 && !(await page.locator('reader-app.drawer-nav').count()))
      await page.locator('[data-action="drawer-nav"]').click();
  };
  await openNav();
  await page.getByRole('tab', { name: 'Outline' }).click();
  await expect(page.locator('[data-nav="line"]', { hasText: 'greet' })).toBeVisible();
  await openNav();
  await page.getByRole('tab', { name: 'Trail' }).click();
  await expect(page.locator('[data-nav="trail"][data-path="src/app.ts"]')).toBeVisible();
  await expect(page.locator('[data-nav="trail"][data-path="README.md"]')).toBeVisible();
});

test('distinct failure states: not-found repo and binary file', async ({ page }) => {
  await installGitHubFixture(page, { failRepoWith: 404 });
  await page.goto('/');
  await page.getByPlaceholder(/owner\/repo/i).fill('octo/hello');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('[data-role="error"]')).toContainText('not-found');
});

test('binary file shows an explicit state', async ({ page }) => {
  await installGitHubFixture(page);
  await openFixtureRepo(page);
  await openFixtureFile(page, 'assets/logo.png');
  await expect(page.locator('.pane-empty')).toContainText('Binary file');
});

test('rate limit surfaces as its own state', async ({ page }) => {
  // Cross-origin fetch only exposes CORS-listed headers; the real api.github.com
  // exposes the rate-limit headers, so the fixture must too.
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({
      status: 403,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'x-ratelimit-remaining, x-ratelimit-reset',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '2000000000'
      },
      body: '{}'
    })
  );
  await page.goto('/');
  await page.getByPlaceholder(/owner\/repo/i).fill('octo/hello');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('[data-role="error"]')).toContainText('rate-limited');
});
