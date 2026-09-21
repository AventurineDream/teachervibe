import { expect, test } from '@playwright/test';
import { installGitHubFixture, openFixtureRepo } from './fixtures.js';

test.skip(({ isMobile }) => !isMobile, 'mobile drawer layout only');

test.beforeEach(async ({ page }) => {
  await installGitHubFixture(page);
});

test('rails collapse into drawers at phone width', async ({ page }) => {
  await openFixtureRepo(page);
  // nav rail is an off-canvas drawer at this width
  await expect(page.locator('reader-app')).not.toHaveClass(/drawer-nav/);
  await page.locator('[data-action="drawer-nav"]').click();
  await expect(page.locator('reader-app')).toHaveClass(/drawer-nav/);
  await page.locator('reader-nav [data-nav="file"][data-path="src/app.ts"]').click();
  await expect(page.locator('.crumb')).toHaveText('src/app.ts');
  // drawer closed after navigation
  await expect(page.locator('reader-app')).not.toHaveClass(/drawer-nav/);
  // reading still works: gutter selection, then the inspector bottom sheet opens
  await page.locator('[data-line="5"] .gutter').click();
  await expect(page.locator('.selection-bar')).toContainText('L5-L5');
  await page.locator('[data-pane="annotate"]').click();
  await expect(page.locator('reader-app')).toHaveClass(/inspector-open/);
  await expect(page.locator('.card.draft')).toBeInViewport();
});
