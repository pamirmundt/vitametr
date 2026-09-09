import { expect, test, type Page } from '@playwright/test';

/**
 * Czech result sheets do not agree on column order. This one — the layout of
 * several laboratory systems — prints the evaluation bar BETWEEN the value and
 * the reference range, the unit AFTER the range, and closes every row with the
 * one-letter sample type. Read with the other order in mind, each row yields
 * the upper reference bound instead of the printed result, the range is lost,
 * and a row ending in `S` or `G` gets seconds or grams for a unit. Nothing about
 * that fails loudly, which is exactly why the sheet has an end-to-end fixture.
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

async function toReview(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = '#/import';
  });
  await page.getByRole('button', { name: 'Specific format' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'Lab PDF' }).click(),
  ]);
  await chooser.setFiles('test/fixtures/labs/cz/lab-cs-unit-last.pdf');
  await expect(page).toHaveURL(/#\/(review|import-filter)$/, { timeout: 20000 });
  if (page.url().includes('import-filter')) {
    await page.locator('.import-filter-continue').click();
  }
  await expect(page).toHaveURL(/#\/review$/);
}

test('the printed result is read, not the reference bound standing behind it', async ({ page }) => {
  const errors = trackErrors(page);
  await toReview(page);

  const leukocytes = page.locator('.review-item').filter({ hasText: 'Leukocytes' }).first();
  await expect(leukocytes).toBeVisible();
  await expect(leukocytes).toContainText('6.2');
  // 10 is the upper reference bound — the number the old column order landed on.
  await expect(leukocytes).not.toContainText('10 10');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the sample-type column is not mistaken for a unit', async ({ page }) => {
  const errors = trackErrors(page);
  await toReview(page);

  // "325 … µmol/l S": with S read as seconds the row lost its metric, its unit
  // and its value in one go.
  const uricAcid = page.locator('.review-item').filter({ hasText: 'Uric acid' }).first();
  await expect(uricAcid).toBeVisible();
  await expect(uricAcid).toContainText('325');
  await expect(uricAcid).toContainText('µmol/l');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the qualifiers a lab appends to a name do not hide the analyte', async ({ page }) => {
  const errors = trackErrors(page);
  await toReview(page);

  const items = page.locator('.review-item');
  // "Neutrofily - relativně" is the share metric; "- abs.počet" is the count.
  // They are separate metrics and both must land on their own.
  await expect(items.filter({ hasText: 'Neutrophils — absolute count' })).toHaveCount(1);
  await expect(items.filter({ hasText: /Neutrophils(?! — absolute)/ }).first()).toContainText('55');
  // "Glukóza v plazmě" names the tube, not a different analyte.
  await expect(items.filter({ hasText: 'Glucose' }).first()).toContainText('5.13');
  // "Non-HDL cholesterol - výp" is marked as computed by the lab.
  await expect(items.filter({ hasText: 'Non-HDL cholesterol' })).toHaveCount(1);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a urine row marked only by the sample column reaches the urine metric', async ({ page }) => {
  const errors = trackErrors(page);
  await toReview(page);

  // The dipstick row says "Glukóza … U": the material column is the only thing
  // that makes it urine, and a urine glucose is not a blood glucose.
  const urine = page.locator('.review-item').filter({ hasText: 'Glucose, urine' });
  await expect(urine).toHaveCount(1);
  await expect(urine).toContainText('negativní');

  expect(errors, errors.join('\n')).toEqual([]);
});
