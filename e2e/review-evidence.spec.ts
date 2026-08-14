import { expect, test, type Page } from '@playwright/test';

/**
 * Suggestion cards carry EVIDENCE, not just a name: the unit the series is in
 * and — once the profile has history — the source-stated reference range and the
 * last reading. That history is also the third matching signal, so a row whose
 * name means nothing ("XQ-114") can still be paired with the analyte the user
 * already tracks from another lab.
 *
 * Fixtures: a first CSV that seeds uric acid (202–417 µmol/l), then a second CSV
 * whose only row is a lab-internal code with the same unit and range.
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

/** Drive one CSV fixture through the mapping screen to the review screen. */
async function importCsv(page: Page, fixture: string): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/import';
  });
  await page.getByRole('button', { name: 'Specific format' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'CSV table' }).click(),
  ]);
  await chooser.setFiles(fixture);
  await expect(page).toHaveURL(/#\/import-csv$/);
  await expect(page.locator('.csv-mapping')).toBeVisible();
  await page.getByRole('button', { name: /Continue to review/ }).click();
  await expect(page).toHaveURL(/#\/review$/);
}

test('a code-only row is matched onto the analyte the profile already tracks', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // 1) Seed the history: uric acid and glucose from one lab.
  await importCsv(page, 'test/fixtures/labs/cz/lab-cs-history-seed.csv');
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  // 2) A second lab sends the same analyte under an internal code.
  await importCsv(page, 'test/fixtures/labs/cz/lab-cs-code-only.csv');

  const card = page.locator('.review-item--unresolved');
  await expect(card).toBeVisible();
  const cards = card.locator('.review-suggest-card');

  // The winning suggestion is uric acid — nothing in the name "XQ-114" could have
  // produced it, only the profile's own history could.
  const first = cards.first();
  await expect(first).toContainText('Uric acid');

  // It shows its evidence: the unit, the range the source stated, and the last
  // reading the profile holds.
  await expect(first).toContainText('µmol/l');
  await expect(first).toContainText('range 202–417');
  await expect(first).toContainText('last 310');
  // …and where that reading came from, so two labs are told apart.
  await expect(first).toContainText('City Lab');

  // Two candidates side by side, never a scrolled-away third: the rest drop to
  // compact rows. Both columns span the same five evidence rows, which is what
  // puts "range" beside "range".
  await expect(cards).toHaveCount(2);
  const grid = card.locator('.review-suggest-cards');
  await expect(grid).toHaveCSS('overflow-x', 'visible');
  const [top, second] = await grid.locator('.review-suggest-card').all();
  const boxA = await top.locator('.review-suggest-evidence').nth(1).boundingBox();
  const boxB = await second.locator('.review-suggest-evidence').nth(1).boundingBox();
  expect(Math.abs((boxA?.y ?? 0) - (boxB?.y ?? 0))).toBeLessThan(2);

  // A third candidate is worth one tap, not a third of the width.
  await expect(card.locator('.review-suggest-row')).toHaveCount(1);

  // One tap resolves the row, and it imports onto the SAME series.
  await first.click();
  await expect(page.locator('.review-item--unresolved')).toHaveCount(0);
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('on a fresh profile the same card degrades to name and unit only', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // No seeding this time: the unknown code arrives with nothing to match against.
  await importCsv(page, 'test/fixtures/labs/cz/lab-cs-code-only.csv');

  const card = page.locator('.review-item--unresolved');
  await expect(card).toBeVisible();
  const cards = card.locator('.review-suggest-card');
  await expect(cards.first()).toBeVisible();
  // Suggestions still appear (the unit carries a signal), but none shows numbers
  // the profile does not have.
  await expect(cards.first()).not.toContainText('range');
  await expect(cards.first()).not.toContainText('last');
  // With nothing to show on them, the history rows are not reserved at all — the
  // cards are short, not tall and empty.
  await expect(card.locator('.review-suggest-cards')).toHaveAttribute(
    'style',
    /--evidence-rows: *2/,
  );
  await expect(cards.first().locator('.review-suggest-evidence')).toHaveCount(1);

  expect(errors, errors.join('\n')).toEqual([]);
});
