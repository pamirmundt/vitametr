import { expect, test, type Page } from '@playwright/test';

/**
 * The Summary's metric picker: a closed one-liner by default, presets that SET
 * the selection, a search box that only narrows the list, an empty selection that
 * blocks printing, and a choice that survives both a reload and a period change.
 * Never part of the printed sheet. English default locale.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    for (const db of (await indexedDB.databases?.()) ?? []) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
  });
  await page.goto('/');
});

async function addValueOn(page: Page, metric: string, value: string, date: string): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/entry';
  });
  const metricInput = page.getByLabel('Metric', { exact: true }).first();
  await metricInput.fill(metric);
  await metricInput.press('Enter');
  await page.locator('#entry-date').fill(date);
  await page.getByLabel('Value', { exact: true }).first().fill(value);
  await page.getByRole('button', { name: /^Add$/ }).click();
}

async function openReport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/report';
  });
  await expect(page.locator('.report')).toBeVisible();
}

/** Three metrics, one of them watched, so every preset stands for something. */
async function seed(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await addValueOn(page, 'Glucose', '5.2', '2025-03-10');
  await addValueOn(page, 'Glucose', '5.4', '2026-01-15');
  await addValueOn(page, 'Hemoglobin', '145', '2026-01-15');
  await addValueOn(page, 'Lymphocytes', '30', '2026-01-15');

  await page.evaluate(() => {
    window.location.hash = '#/';
  });
  const glucoseCard = page
    .locator('.metric-card-wrap')
    .filter({ has: page.locator('.metric-name', { hasText: 'Glucose' }) });
  await glucoseCard.locator('.watch-star').click();
  await expect(page.locator('.overview-group-title').first()).toHaveText(/Watched/);

  await openReport(page);
}

async function openPicker(page: Page): Promise<void> {
  await page.locator('.report-picker-edit').click();
  await expect(page.locator('.report-picker--open')).toBeVisible();
}

test('the picker starts closed and says what is shown', async ({ page }) => {
  await seed(page);

  await expect(page.locator('.report-picker--closed')).toBeVisible();
  await expect(page.locator('.report-picker--open')).toHaveCount(0);
  // Everything is selected on a first visit.
  await expect(page.locator('.report-picker-count')).toHaveText('Metrics shown 3 of 3');
});

test('"Watched" picks exactly the watched metric', async ({ page }) => {
  await seed(page);
  await openPicker(page);

  await page.locator('.report-picker-chip', { hasText: 'Watched' }).first().click();

  // One selection entry, shown twice: under "Watched" and under its own panel.
  const checked = page.locator('.report-picker-item.is-on');
  await expect(checked).toHaveCount(2);
  expect(new Set(await checked.locator('.report-picker-name').allInnerTexts())).toEqual(
    new Set(['Glucose']),
  );
  await expect(page.locator('.report-picker-head .report-picker-count')).toHaveText(
    'Metrics shown 1 of 3',
  );
  // And the body follows the selection, not the whole catalog.
  await expect(page.locator('.report-section')).toContainText('Glucose');
  await expect(page.locator('.report-section')).not.toContainText('Hemoglobin');
  await expect(page.locator('.report-section')).not.toContainText('Lymphocytes');
});

test('search narrows the list and opens the matching group, without deselecting', async ({
  page,
}) => {
  await seed(page);
  await openPicker(page);

  const search = page.locator('.report-picker-search');
  await search.fill('lym');

  const items = page.locator('.report-picker-item');
  await expect(items).toHaveCount(1);
  await expect(items).toContainText('Lymphocytes');
  // Its group is open, not collapsed behind a heading.
  await expect(page.locator('.report-picker-list')).toBeVisible();
  await expect(page.locator('.report-picker-group-toggle')).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  // The list narrowed; the selection did not.
  await expect(page.locator('.report-picker-head .report-picker-count')).toHaveText(
    'Metrics shown 3 of 3',
  );

  await search.fill('zzz');
  await expect(page.locator('.report-picker-item')).toHaveCount(0);
  await expect(page.locator('.report-picker--open')).toContainText('No metric matches the search.');
});

test('"None" empties the selection, disables printing and says why', async ({ page }) => {
  await seed(page);
  await openPicker(page);

  await page.locator('.report-picker-chip--none').click();

  await expect(page.locator('.report-picker-item.is-on')).toHaveCount(0);
  await expect(page.locator('.report-picker-warn')).toBeVisible();
  await expect(page.getByRole('button', { name: /Print/ })).toBeDisabled();
  await expect(page.locator('.report-section')).toHaveCount(0);
});

test('the picker is screen-only — the printed sheet has no filter', async ({ page }) => {
  await seed(page);
  await expect(page.locator('.report-picker--closed')).toBeVisible();

  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.report-picker-host')).toBeHidden();
  await expect(page.locator('.report-section')).toBeVisible();
});

test('the selection survives a reload and a period change', async ({ page }) => {
  await seed(page);
  await openPicker(page);

  await page.locator('.report-picker-chip', { hasText: 'Watched' }).first().click();
  await expect(page.locator('.report-picker-head .report-picker-count')).toHaveText(
    'Metrics shown 1 of 3',
  );

  // Switching to the "as of" mode re-derives the picker's facts but must leave
  // the selection alone.
  await page.getByRole('button', { name: 'As of date', exact: true }).click();
  await expect(page.locator('.report-picker-count').first()).toContainText('1 of 3');

  // Give the IndexedDB write a moment to flush before dropping the page.
  await page.waitForTimeout(600);
  await page.reload();
  await openReport(page);
  await expect(page.locator('.report-picker-count').first()).toHaveText('Metrics shown 1 of 3');
  await expect(page.locator('.report-section')).toContainText('Glucose');
  await expect(page.locator('.report-section')).not.toContainText('Hemoglobin');
});
