import { expect, test, type Page } from '@playwright/test';
import { installGitHubFixture, openFixtureFile, openFixtureRepo } from './fixtures.js';

test.beforeEach(async ({ page }) => {
  await installGitHubFixture(page);
  await openFixtureRepo(page);
  await openFixtureFile(page, 'src/app.ts');
  await expect(page.locator('.crumb')).toHaveText('src/app.ts');
});

async function selectLines(page: Page, start: number, end: number) {
  await page.locator(`[data-line="${start}"] .gutter`).click();
  await page.locator(`[data-line="${end}"] .gutter`).click({ modifiers: ['Shift'] });
  await expect(page.locator('.selection-bar')).toContainText(`L${start}-L${end} selected`);
}

test('a line-range annotation survives reload with its exact quoted context', async ({ page }) => {
  await selectLines(page, 5, 6);
  await page.locator('[data-pane="annotate"]').click();
  await page.locator('[data-draft="type"]').selectOption('question');
  await page.locator('[data-draft="body"]').fill('why is add exported?');
  await page.locator('[data-ins="save-draft"]').click();

  // inspector shows the card with full anchor identity
  const card = page.locator('.card.expanded');
  await expect(card).toContainText('why is add exported?');
  await expect(card.locator('.quote')).toContainText('export function add');
  await card.locator('.anchor-details summary').click();
  await expect(card.locator('.anchor-details')).toContainText('github:octo/hello');
  await expect(card.locator('.anchor-details')).toContainText('5:1 - 6:16');

  // reload: annotation persists, quote intact
  await page.reload();
  await expect(page.locator('.crumb')).toHaveText('src/app.ts');
  await expect(page.locator('.card', { hasText: 'why is add exported?' })).toBeVisible();
  await expect(page.locator('.card .quote').first()).toContainText('return a + b;');

  // margin markers render beside the anchored lines
  await expect(page.locator('[data-line="5"] .marker')).toBeVisible();
  await expect(page.locator('[data-line="6"] .marker')).toBeVisible();
  await expect(page.locator('[data-line="7"] .marker')).toHaveCount(0);
});

test('deep links restore file and range; back/forward follows the reading trail', async ({ page }) => {
  await selectLines(page, 1, 2);
  const deepLink = page.url();
  expect(deepLink).toContain('?L=1-2');

  // navigate elsewhere, then land on the deep link fresh
  await openFixtureFile(page, 'styles.css');
  await expect(page.locator('.crumb')).toHaveText('styles.css');
  await page.goto(deepLink);
  await expect(page.locator('.crumb')).toHaveText('src/app.ts');
  await expect(page.locator('.selection-bar')).toContainText('L1-L2 selected');

  // back returns to styles.css (trail order, no reset)
  await page.goBack();
  await expect(page.locator('.crumb')).toHaveText('styles.css');
});

test('in-file search finds and jumps between matches', async ({ page }) => {
  await page.locator('[data-search]').fill('add');
  // match lines: 5 (export function add), 9 (const result = add)
  await page.locator('[data-search]').press('Enter');
  await expect(page.locator('.selection-bar')).toContainText('L5-L5');
  await page.locator('[data-search]').press('Enter');
  await expect(page.locator('.selection-bar')).toContainText('L9-L9');
  await page.locator('[data-search]').press('Shift+Enter');
  await expect(page.locator('.selection-bar')).toContainText('L5-L5');
});

test('keyboard navigation: j/k move, shift extends, a annotates', async ({ page }) => {
  await page.locator('reader-pane').press('j');
  await expect(page.locator('.selection-bar')).toContainText('L1-L1');
  await page.locator('reader-pane').press('j');
  await expect(page.locator('.selection-bar')).toContainText('L2-L2');
  await page.locator('reader-pane').press('Shift+J');
  await expect(page.locator('.selection-bar')).toContainText('L2-L3');
  await page.locator('reader-pane').press('a');
  await expect(page.locator('.card.draft')).toBeVisible();
});


test('selecting with the mouse leaves a available to start a draft', async ({ page }) => {
  await page.locator('[data-line="5"] .gutter').click();
  await page.locator('[data-line="6"] .gutter').click({ modifiers: ['Shift'] });
  await expect(page.locator('.selection-bar')).toContainText('L5-L6 selected');
  await expect(page.locator('reader-pane')).toBeFocused();
  await page.keyboard.press('a');
  await expect(page.locator('.card.draft')).toBeVisible();
});

test('clicking a line or marker does not jump the reading position', async ({ page }) => {
  await openFixtureFile(page, 'long.md');
  const scroll = page.locator('.code-scroll');
  await scroll.evaluate((el) => { el.scrollTop = 1300; });
  const before = await scroll.evaluate((el) => el.scrollTop);
  await page.locator('[data-line="70"] .gutter').click();
  expect(await scroll.evaluate((el) => el.scrollTop)).toBeCloseTo(before, 0);
  await page.keyboard.press('a');
  await page.locator('[data-draft="body"]').fill('Check this line');
  await page.locator('[data-ins="save-draft"]').click();
  await page.locator('[data-line="70"] .marker').click();
  expect(await scroll.evaluate((el) => el.scrollTop)).toBeCloseTo(before, 0);
});

test('review tray remains pinned while reading a long file', async ({ page }) => {
  await openFixtureFile(page, 'long.md');
  const tray = page.locator('reader-tray');
  if ((page.viewportSize()?.width ?? 1280) < 821) {
    await page.locator('[data-action="drawer-tray"]').click();
  }
  const initial = await tray.boundingBox();
  const scroll = page.locator('.code-scroll');
  await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const after = await tray.boundingBox();
  expect(initial).not.toBeNull();
  expect(after).not.toBeNull();
  expect(after!.y).toBeCloseTo(initial!.y, 0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(900);
});
