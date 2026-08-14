import { expect, test, type Page } from '@playwright/test';

/**
 * Row trend traces — the second line under a list row, and the ONE time axis
 * every row of a screen is drawn against.
 *
 * Covers: the trace is a list-only affordance (no toggle over the tiles); the
 * default mode draws only the rows worth a second look; "All" draws every
 * numeric row and "Hidden" none; every trace of the list shares one domain, so
 * a metric measured over part of it starts part-way across while a metric
 * spanning the whole period fills the width; the axis strip is rendered once per
 * list and its marks line up with the faint gridlines repeated inside each
 * trace; the choice persists across a reload; the summary carries the same
 * information as text for assistive tech. English default locale.
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

/**
 * Two metrics with deliberately different histories:
 *  - Glucose spans 2020 → 2026 (the full extent of the data),
 *  - Hemoglobin only 2025 → 2026 (the last fifth of it).
 * On a shared axis the second trace must start far to the right of the first.
 */
async function seed(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await addValueOn(page, 'Glucose', '90', '2020-01-15');
  await addValueOn(page, 'Glucose', '95', '2023-01-15');
  await addValueOn(page, 'Glucose', '99', '2026-01-15');
  await addValueOn(page, 'Hemoglobin', '140', '2025-06-01');
  await addValueOn(page, 'Hemoglobin', '145', '2026-01-15');
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
}

/** Switch to the list layout, where the traces live. */
async function openList(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'List view' }).click();
}

test('the trace mode is a list-only control and draws a trace per numeric row', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await seed(page);

  // Tiles: no trace control at all.
  await expect(page.locator('.overview-spark-control')).toBeHidden();

  await openList(page);
  await expect(page.locator('.overview-spark-control')).toBeVisible();

  // Default ("Out of range"): neither metric is watched or out of range here,
  // so the list stays exactly as it was.
  await expect(page.locator('.overview-row-spark')).toHaveCount(0);

  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.locator('.overview-row-spark')).toHaveCount(2);
  await expect(page.locator('.overview-row-spark svg')).toHaveCount(2);

  await page.getByRole('button', { name: 'Hidden', exact: true }).click();
  await expect(page.locator('.overview-row-spark')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('every trace of the list shares one time axis', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);
  await openList(page);
  await page.getByRole('button', { name: 'All', exact: true }).click();

  const glucose = page.locator('.overview-row').filter({ hasText: 'Glucose' });
  const hemoglobin = page.locator('.overview-row').filter({ hasText: 'Hemoglobin' });

  const wide = await glucose.locator('.metric-spark-line').boundingBox();
  const narrow = await hemoglobin.locator('.metric-spark-line').boundingBox();
  expect(wide).not.toBeNull();
  expect(narrow).not.toBeNull();

  // Glucose spans the whole period; Hemoglobin only its tail. On a shared axis
  // the short series starts well to the right and ends alongside the long one.
  expect(narrow!.x).toBeGreaterThan(wide!.x + wide!.width / 2);
  expect(Math.abs(narrow!.x + narrow!.width - (wide!.x + wide!.width))).toBeLessThan(6);

  // Each list card closes with the axis, and they all carry the SAME marks —
  // one domain, repeated where the traces are, never a per-row axis.
  const axes = page.locator('.metric-spark-axis');
  await expect(axes).toHaveCount(await page.locator('.overview-list').count());
  const perAxis = await axes.evaluateAll((els) =>
    els.map((e) => [...e.querySelectorAll('.metric-spark-tick')].map((t) => t.textContent).join('|')),
  );
  expect(new Set(perAxis).size).toBe(1);

  const ticks = axes.first().locator('.metric-spark-tick');
  expect(await ticks.count()).toBeGreaterThan(1);
  const labels = await ticks.allTextContents();
  // Years only, over a span this long — and ascending.
  const years = labels.map((l) => Number(l));
  expect(years.every((y) => y >= 2019 && y <= 2027)).toBe(true);
  expect([...years].sort((a, b) => a - b)).toEqual(years);

  const gridCount = await glucose.locator('.metric-spark-grid').count();
  expect(gridCount).toBe(labels.length);

  // A mark sits under the gridline it names (same nominal box, so within a px).
  const tickBox = await ticks.first().boundingBox();
  const gridBox = await glucose.locator('.metric-spark-grid').first().boundingBox();
  expect(Math.abs(tickBox!.x + tickBox!.width / 2 - (gridBox!.x + gridBox!.width / 2))).toBeLessThan(
    12,
  );

  expect(errors).toEqual([]);
});

test('the trace mode survives a reload, and the trace is readable as text', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);
  await openList(page);
  await page.getByRole('button', { name: 'All', exact: true }).click();

  const summary = page
    .locator('.overview-row')
    .filter({ hasText: 'Glucose' })
    .locator('.overview-row-spark .visually-hidden');
  // The sentence names the row's OWN span (not the shared axis), the number of
  // readings and the latest value — everything the picture shows.
  await expect(summary).toContainText('2020');
  await expect(summary).toContainText('3');

  // The choice is written to IndexedDB asynchronously; give that a beat before
  // pulling the rug, so the reload tests persistence rather than a race.
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.locator('.overview-row-spark')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  expect(errors).toEqual([]);
});
