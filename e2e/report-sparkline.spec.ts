import { expect, test, type Page } from '@playwright/test';

/**
 * Trend traces in the Summary / print report: a full-width row under the
 * metric's own row (there is no width left for a column), a checkbox that turns
 * them off for the printed sheet, its own persisted setting — deliberately not
 * the Overview's — and the same single shared time axis, drawn once per table.
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

async function seed(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await addValueOn(page, 'Glucose', '90', '2020-01-15');
  await addValueOn(page, 'Glucose', '95', '2023-01-15');
  await addValueOn(page, 'Glucose', '99', '2026-01-15');
  await addValueOn(page, 'Hemoglobin', '140', '2025-06-01');
  await addValueOn(page, 'Hemoglobin', '145', '2026-01-15');
  await page.evaluate(() => {
    window.location.hash = '#/report';
  });
  await expect(page.locator('.report')).toBeVisible();
}

test('traces are a full-width row under the metric, switchable off for print', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);

  // Traces are on by default ("Out of range"), but nothing here qualifies — no
  // metric is watched or ever outside its range — so no row draws one yet.
  await expect(page.locator('.report-spark-check input')).toBeChecked();
  await expect(page.locator('tr.report-spark-row')).toHaveCount(0);

  await page.locator('.report-spark-toggle').getByRole('button', { name: 'All' }).click();

  const traceRows = page.locator('tr.report-spark-row');
  await expect(traceRows).toHaveCount(2);
  // Each spans the whole table, and sits directly under its metric's row.
  const colspans = await traceRows.locator('td').evaluateAll((els) =>
    els.map((e) => (e as HTMLTableCellElement).colSpan),
  );
  const headerCells = await page.locator('.report-section tr th').count();
  expect(new Set(colspans).size).toBe(1);
  expect(colspans[0]).toBe(headerCells);

  // Unticking the checkbox is the print opt-out: no trace survives it.
  await page.locator('.report-spark-check input').uncheck();
  await expect(page.locator('tr.report-spark-row')).toHaveCount(0);
  await expect(page.locator('svg.metric-spark-svg')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('the summary has its own trace setting and one shared axis per table', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);
  await page.locator('.report-spark-toggle').getByRole('button', { name: 'All' }).click();

  // One axis per table that drew, all carrying the same marks.
  const table = page.locator('.report-scroll table').first();
  const axisRow = table.locator('tr.report-spark-axis-row');
  await expect(axisRow).toHaveCount(1);
  const labels = await axisRow.locator('.metric-spark-tick').allTextContents();
  expect(labels.length).toBeGreaterThan(1);
  // Every trace in the table repeats exactly those marks as gridlines.
  const gridPerTrace = await table
    .locator('tr.report-spark-row')
    .evaluateAll((rows) => rows.map((r) => r.querySelectorAll('.metric-spark-grid').length));
  expect(gridPerTrace.every((n) => n === labels.length)).toBe(true);

  // The setting is the report's own: the Overview keeps its default (nothing).
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.locator('tr.report-spark-row')).toHaveCount(2);
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.locator('.overview-row-spark')).toHaveCount(0);

  expect(errors).toEqual([]);
});
