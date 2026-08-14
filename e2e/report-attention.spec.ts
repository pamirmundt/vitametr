import { expect, test, type Page } from '@playwright/test';

/**
 * The Summary's "Worth attention" box lists BOTH what is outside its reference
 * range right now and what used to be — a value back inside its range says
 * nothing about the history that led there. Only the current ones are flagged,
 * with a word badge so a greyscale printout keeps the distinction.
 * English default locale.
 */

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    for (const db of (await indexedDB.databases?.()) ?? []) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
  });
  await page.goto('/');
});

/** One value with the reference range its "source" stated. */
async function addValueOn(
  page: Page,
  metric: string,
  value: string,
  date: string,
  ref: { low: string; high: string },
): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/entry';
  });
  const metricInput = page.getByLabel('Metric', { exact: true }).first();
  await metricInput.fill(metric);
  await metricInput.press('Enter');
  await page.locator('#entry-date').fill(date);
  await page.getByLabel('Value', { exact: true }).first().fill(value);
  // "Range" expands the row's reference-range fields (they carry no `for=`, so
  // they are addressed by position within .row-meta).
  await page.getByRole('button', { name: 'Range', exact: true }).first().click();
  const refInputs = page.locator('.entry-row.expanded .row-meta .field input');
  await refInputs.nth(0).fill(ref.low);
  await refInputs.nth(1).fill(ref.high);
  await page.getByRole('button', { name: /^Add$/ }).click();
}

/** Glucose came back inside its range; hemoglobin is still below it. */
async function seed(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  const gRef = { low: '3.9', high: '5.6' };
  await addValueOn(page, 'Glucose', '7.0', '2024-03-02', gRef);
  await addValueOn(page, 'Glucose', '6.2', '2025-04-10', gRef);
  await addValueOn(page, 'Glucose', '5.1', '2026-01-15', gRef);
  await addValueOn(page, 'Hemoglobin', '100', '2026-01-15', { low: '135', high: '175' });

  await page.evaluate(() => {
    window.location.hash = '#/report';
  });
  await expect(page.locator('.report')).toBeVisible();
}

test('past excursions are listed under their own heading, current ones first', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await seed(page);

  // The state is stated once per group, not once per line.
  const groups = page.locator('.report-attention .attn-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.first().locator('.attn-group-title')).toHaveText(
    'Latest value outside the source range',
  );
  await expect(groups.nth(1).locator('.attn-group-title')).toHaveText(
    'Previously outside the range, latest value within',
  );

  // The current group names the metric and dates the reading — "now" would be a
  // lie for a value taken months ago.
  const current = groups.first().locator('li');
  await expect(current).toHaveCount(1);
  await expect(current.locator('.attn-name')).toHaveText('Hemoglobin');
  await expect(current.locator('.attn-detail')).toContainText('1/15/2026');

  // The historical one says when and how often, and never repeats the sentence.
  const past = groups.nth(1).locator('li');
  await expect(past).toHaveCount(1);
  await expect(past.locator('.attn-name')).toHaveText('Glucose');
  await expect(past.locator('.attn-detail')).toHaveText('last on 4/10/2025 (2×)');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('an attention line still opens the metric it names', async ({ page }) => {
  await seed(page);

  await page.locator('.report-attention li', { hasText: 'Glucose' }).click();
  await expect(page).toHaveURL(/#\/metric\//);
  await expect(page.locator('.metric-title-row')).toContainText('Glucose');
});
