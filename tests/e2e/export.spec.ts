import { expect, test, type Page } from '@playwright/test';
import { installGitHubFixture, openFixtureFile, openFixtureRepo, SHA } from './fixtures.js';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  await installGitHubFixture(page);
  await openFixtureRepo(page);
  await openFixtureFile(page, 'src/app.ts');
});

async function annotate(page: Page, start: number, end: number, body: string) {
  await page.locator(`[data-line="${start}"] .gutter`).click();
  await page.locator(`[data-line="${end}"] .gutter`).click({ modifiers: ['Shift'] });
  await page.locator('[data-pane="annotate"]').click();
  await page.locator('[data-draft="body"]').fill(body);
  await page.locator('[data-ins="save-draft"]').click();
  await expect(page.locator('.card.expanded')).toContainText(body);
  await page.locator('[data-ins="close"]').click();
}


/** Phone widths: the inspector sheet opens from a margin marker; the tray is a drawer. */
async function addToTray(page: Page, body: string, line: number): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) < 821) {
    await page.locator(`[data-line="${line}"] [data-pane="marker"]`).first().click();
    await expect(page.locator('.card.expanded')).toContainText(body);
    await page.locator('.card.expanded [data-ins="tray-add"]').click();
    await page.locator('[data-ins="close"]').click();
  } else {
    await page.locator('.card', { hasText: body }).locator('[data-ins="open"]').click();
    await page.locator('.card.expanded [data-ins="tray-add"]').click();
    await page.locator('[data-ins="close"]').click();
  }
}

async function openTray(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) < 821) await page.locator('[data-action="drawer-tray"]').click();
}

test('review tray exports deterministic Markdown and JSON', async ({ page }) => {
  await annotate(page, 1, 2, 'first note');
  await annotate(page, 5, 7, 'second note');
  await addToTray(page, 'first note', 1);
  await addToTray(page, 'second note', 5);
  await openTray(page);

  await expect(page.locator('.tray-head .count')).toHaveText('2');

  // preview shows the packet shape
  await page.locator('[data-tray="preview"]').click();
  const preview = page.locator('.packet-preview');
  await expect(preview).toContainText('# Review packet - github:octo/hello');
  await expect(preview).toContainText(`Base commit: ${SHA}`);
  await expect(preview).toContainText('## 1. [note] src/app.ts L1-L2 (open)');
  await expect(preview).toContainText('> export function greet');

  // JSON download parses and preserves tray order
  const dl1 = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-tray="export-json"]').click()
  ]);
  const path1 = await dl1[0].path();
  const json1 = await readFile(path1!, 'utf8');
  const packet = JSON.parse(json1) as {
    packetVersion: number;
    repo: { baseCommit: string; repoId: string };
    annotations: { body: string; quote: string; anchor: { path: string } }[];
  };
  expect(packet.packetVersion).toBe(1);
  expect(packet.repo.baseCommit).toBe(SHA);
  expect(packet.repo.repoId).toBe('github:octo/hello');
  expect(packet.annotations.map((a) => a.body)).toEqual(['first note', 'second note']);
  expect(packet.annotations[0]!.quote).toContain('greet');
  expect(packet.annotations[0]!.anchor.path).toBe('src/app.ts');

  // deterministic: a second export is byte-identical
  const dl2 = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-tray="export-json"]').click()
  ]);
  const json2 = await readFile((await dl2[0].path())!, 'utf8');
  expect(json2).toBe(json1);

  // Markdown download too
  const dl3 = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-tray="export-md"]').click()
  ]);
  const md = await readFile((await dl3[0].path())!, 'utf8');
  expect(md).toContain('Target: next commit');
  expect(md).toContain('Anchor: github:octo/hello @');
});

test('tray ordering controls packet order', async ({ page }) => {
  await annotate(page, 1, 1, 'alpha');
  await annotate(page, 5, 5, 'beta');
  await addToTray(page, 'alpha', 1);
  await addToTray(page, 'beta', 5);
  await openTray(page);
  // move beta above alpha
  await page.locator('.tray-item', { hasText: 'L5-L5' }).locator('[data-tray="up"]').click();
  const dl = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-tray="export-json"]').click()
  ]);
  const packet = JSON.parse(await readFile((await dl[0].path())!, 'utf8')) as { annotations: { body: string }[] };
  expect(packet.annotations.map((a) => a.body)).toEqual(['beta', 'alpha']);
});
