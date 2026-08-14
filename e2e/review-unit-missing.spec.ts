import { expect, test, type Page } from '@playwright/test';

/**
 * Czech lab sheets state some results with no unit at all ("B_Hematokrit
 * 0,451"). When the metric admits several units the app must not guess — 0,451
 * L/L and 0,451 % differ a hundredfold — so the row reaches review in a state
 * that blocks the import until the user says which unit the value is in.
 *
 * Fixture: the synthetic national-convention result sheet, which carries three
 * such rows (hematocrit and two white-cell ratios).
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
  await chooser.setFiles('test/fixtures/labs/cz/lab-cs-nclp.pdf');
  // A batch this size goes through the "What to import" filter first; keep it all.
  await expect(page).toHaveURL(/#\/import-filter$/, { timeout: 20000 });
  await page.locator('.import-filter-continue').click();
  await expect(page).toHaveURL(/#\/review$/);
}

test('a unitless row blocks its own import until the unit is chosen', async ({ page }) => {
  const errors = trackErrors(page);
  await toReview(page);

  const blocked = page.locator('.review-item--needs-unit');
  await expect(blocked.first()).toBeVisible();
  const blockedCount = await blocked.count();
  expect(blockedCount).toBeGreaterThan(0);

  // The footer says how many rows the bulk action will leave behind.
  await expect(page.locator('.review-awaiting-unit')).toContainText('waiting for');

  const hematocrit = page.locator('.review-item--needs-unit').filter({ hasText: 'Hematocrit' });
  await expect(hematocrit).toBeVisible();
  // No accept/reject toggle while the value has no unit — it cannot be imported.
  await expect(hematocrit.locator('.review-decision')).toHaveCount(0);

  // One option per candidate unit, each showing what the value would actually
  // mean — the contrast between the readings IS the decision.
  const options = hematocrit.locator('.review-unit-option');
  await expect(options).toHaveCount(2);
  // The SAME number read in each candidate unit — that is the actual question
  // ("is this 0.451 L/L or 0.451 %"), not a conversion of one into the other.
  await expect(options.filter({ hasText: '0.451 L/L' })).toHaveCount(1);
  await expect(options.filter({ hasText: '0.451 %' })).toHaveCount(1);
  // A closed set with exactly one right answer: radios, not toggles.
  await expect(hematocrit.locator('[role="radiogroup"]')).toHaveCount(1);
  await expect(options.first()).toHaveAttribute('role', 'radio');
  // This profile has no hematocrit history, so both options fall back to what
  // they would mean elsewhere — symmetrically, never one filled and one empty.
  await expect(options.nth(0).locator('.review-unit-history')).toContainText('=');
  await expect(options.nth(1).locator('.review-unit-history')).toContainText('=');
  // The canonical unit leads the candidates (a fact about the catalog).
  await expect(options.first()).toContainText('0.451 l/l');

  const before = Number(await page.locator('.review-count').innerText());

  await options.filter({ hasText: '0.451 L/L' }).click();

  // The row settles: it leaves the blocked state, gains its accept/reject toggle
  // and joins the import count.
  await expect(page.locator('.review-item--needs-unit')).toHaveCount(blockedCount - 1);
  await expect(
    page.locator('.review-item').filter({ hasText: 'Hematocrit' }).locator('.review-decision'),
  ).toBeVisible();
  await expect(page.locator('.review-count')).toHaveText(String(before + 1));

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the chosen unit is what gets stored, and a misclick is one tap from fixed', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await toReview(page);

  const hematocrit = page.locator('.review-item--needs-unit').filter({ hasText: 'Hematocrit' });
  const row = page.locator('.review-item').filter({ hasText: 'Hematocrit' });
  const options = row.locator('.review-unit-option');

  // Pick the wrong one first: the chooser stays on the row, so switching to the
  // other option is one tap. There is no way back to "nothing chosen" — the set
  // is closed and one of them is true.
  await options.filter({ hasText: '0.451 %' }).click();
  await expect(options.filter({ hasText: '0.451 %' })).toHaveAttribute('aria-checked', 'true');
  await options.filter({ hasText: '0.451 L/L' }).click();
  await expect(options.filter({ hasText: '0.451 L/L' })).toHaveAttribute('aria-checked', 'true');
  await expect(options.filter({ hasText: '0.451 %' })).toHaveAttribute('aria-checked', 'false');

  // Nothing is missing any more: the badge, its sentence and the warn edge all
  // go, and the row joins the import like any other accepted one.
  await expect(hematocrit).toHaveCount(0);
  await expect(row.locator('.review-unit-missing')).toHaveCount(0);
  await expect(row.locator('.review-unit-hint')).toHaveCount(0);
  await expect(row.locator('.review-decision')).toBeVisible();

  // The measurement carries the chosen unit.
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  await page.locator('.app-content button').filter({ hasText: 'Hematocrit' }).first().click();
  await expect(page.locator('.app-content')).toContainText('0.451');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('three candidate units get one conversion each, never a matrix', async ({ page }) => {
  const errors = trackErrors(page);
  await toReview(page);

  // Folate admits nmol/L, µg/L and ng/mL; the sheet states its value unitless.
  const folate = page.locator('.review-item--needs-unit').filter({ hasText: 'Folate' });
  const options = folate.locator('.review-unit-option');
  await expect(options).toHaveCount(3);

  for (let i = 0; i < 3; i += 1) {
    const hint = options.nth(i).locator('.review-unit-history');
    await expect(hint).toContainText('=');
    // Exactly one conversion per option: three candidates, three lines, not nine.
    expect((await hint.innerText()).match(/=/g)).toHaveLength(1);
  }

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the footer takes you to the first row that is still waiting', async ({ page }) => {
  const errors = trackErrors(page);
  await toReview(page);

  // "3 rows are waiting" is a riddle in a long list unless it comes with a way there.
  await page.getByRole('button', { name: 'Go to the first' }).click();

  const focused = page.locator('.review-unit-option:focus');
  await expect(focused).toHaveCount(1);
  // It is the FIRST blocked row's chooser, not just any.
  const firstBlockedOption = page
    .locator('.review-item--needs-unit')
    .first()
    .locator('.review-unit-option')
    .first();
  await expect(firstBlockedOption).toBeFocused();

  // Arrow keys move within the group and settle the row (radiogroup semantics).
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.review-unit-option[aria-checked="true"]')).toHaveCount(1);

  expect(errors, errors.join('\n')).toEqual([]);
});
