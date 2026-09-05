import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';

/**
 * Restoring a backup (`docs/redesign5/ZADANI-OBNOVA-ZALOHY.md`).
 *
 * A backup is the one import that can reconfigure a profile and create people,
 * so it stops at a screen that says what it will do before anything is written.
 * The tests below are the spec's own list: a one-profile file says nothing about
 * profiles, a family file maps them and re-counts live, overwriting settings is
 * opt-in, and restoring the same file twice adds nothing the second time.
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
  mkdirSync('test-results', { recursive: true });
  await page.goto('/');
  await page.evaluate(async () => {
    for (const db of (await indexedDB.databases?.()) ?? []) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
    localStorage.clear();
  });
  await page.goto('/');
});

async function createProfile(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
}

async function addValue(page: Page, metric: string, value: string): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/entry';
  });
  const input = page.getByLabel('Metric', { exact: true }).first();
  await input.fill(metric);
  await input.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill(value);
  await page.getByRole('button', { name: /^Add$/ }).click();
  await page.waitForTimeout(100);
}

async function openSettings(page: Page): Promise<void> {
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.settings-view')).toBeVisible();
}

/** Export a backup and return the file's path on disk. */
async function exportBackup(page: Page, scope: 'active' | 'all' = 'active'): Promise<string> {
  await openSettings(page);
  await page.getByRole('button', { name: 'Backup (JSON)' }).click();
  if (scope === 'all') await page.locator('.settings-scope-option input[value="all"]').check();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('dialog.modal .primary').click(),
  ]);
  const path = `test-results/${download.suggestedFilename()}`;
  await download.saveAs(path);
  return path;
}

/** Drop a file on the import page through the "Backup" format card. */
async function importFile(page: Page, file: string): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/import';
  });
  await page.getByRole('button', { name: 'Specific format' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'Vitametr backup' }).click(),
  ]);
  await chooser.setFiles(file);
}

/** Walk the review screen to the end, whatever the batch size. */
async function commitReview(page: Page): Promise<void> {
  if (/#\/import-filter$/.test(page.url())) {
    await page.locator('.import-filter-segment-btn', { hasText: 'All' }).click();
    await page.locator('.import-filter-continue').click();
  }
  await expect(page.locator('.review-footer')).toBeVisible();
  await page.getByRole('button', { name: /Import selected/ }).click();
}

test('a one-profile backup says nothing about profiles', async ({ page }) => {
  const errors = trackErrors(page);
  await createProfile(page);
  await addValue(page, 'Glucose', '5.4');
  const backup = await exportBackup(page);

  await importFile(page, backup);
  await expect(page).toHaveURL(/#\/restore$/);

  // Two numbers only: how much, and over what period.
  const stats = page.locator('.restore-stat');
  await expect(stats).toHaveCount(2);
  await expect(stats.first()).toContainText('readings to restore');
  await expect(page.locator('.restore-profiles')).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('nothing is written until it is confirmed', async ({ page }) => {
  await createProfile(page);
  await addValue(page, 'Glucose', '5.4');
  const backup = await exportBackup(page);

  await importFile(page, backup);
  await expect(page).toHaveURL(/#\/restore$/);
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Back on Import, with the profile untouched — no second reading, no profile.
  await expect(page).toHaveURL(/#\/import$/);
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await expect(page.locator('.metric-card-wrap')).toHaveCount(1);
});

test('restoring the same backup twice adds nothing the second time', async ({ page }) => {
  await createProfile(page);
  await addValue(page, 'Glucose', '5.4');
  const backup = await exportBackup(page);

  await importFile(page, backup);
  await page.getByRole('button', { name: /Continue to review/ }).click();
  await commitReview(page);
  await expect(page).toHaveURL(/#\/restore-done$/);
  // Everything it holds is already stored, so it is all duplicates.
  await expect(page.locator('.restore-done-value')).toHaveText('0 readings');
  await expect(page.locator('.restore-done-lines')).toContainText('Skipped as duplicate 1');
});

test('a family backup maps its profiles and recounts as the mapping changes', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await createProfile(page);
  await addValue(page, 'Glucose', '5.4');
  // A second profile, so the file carries two people.
  await openSettings(page);
  await page.getByRole('button', { name: /Add profile/ }).click();
  await page.locator('.profile-form input').first().fill('Romana');
  await page.getByRole('button', { name: 'Create and switch' }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  await addValue(page, 'Body weight', '62');

  const backup = await exportBackup(page, 'all');

  // A fresh device: wipe and start over, then restore.
  await page.evaluate(async () => {
    for (const db of (await indexedDB.databases?.()) ?? []) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
    localStorage.clear();
  });
  await page.goto('/');
  await createProfile(page);
  await importFile(page, backup);
  await expect(page).toHaveURL(/#\/restore$/);

  await expect(page.locator('.restore-profile-row')).toHaveCount(2);
  const newCount = page.locator('.restore-stat').filter({ hasText: 'new profiles' });
  // The file's unnamed profile is this device's unnamed profile — same person,
  // restored into itself. Only Romana is someone the device does not have yet.
  await expect(newCount.locator('.restore-stat-value')).toHaveText('1');

  // Redirect that one to a new profile instead: the count follows immediately.
  const unnamed = page.locator('.restore-target').last();
  await unnamed.selectOption('new');
  await expect(newCount.locator('.restore-stat-value')).toHaveText('2');

  // …and skipping it takes it back out of the count.
  await unnamed.selectOption('skip');
  await expect(newCount.locator('.restore-stat-value')).toHaveText('1');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a family backup restores both people, setup included', async ({ page }) => {
  await createProfile(page);
  await addValue(page, 'Glucose', '5.4');
  await openSettings(page);
  // A preference worth carrying: US units.
  await page.locator('.settings-segment-btn', { hasText: 'US' }).click();
  await page.getByRole('button', { name: /Add profile/ }).click();
  await page.locator('.profile-form input').first().fill('Romana');
  await page.getByRole('button', { name: 'Create and switch' }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  await addValue(page, 'Body weight', '62');
  const backup = await exportBackup(page, 'all');

  await page.evaluate(async () => {
    for (const db of (await indexedDB.databases?.()) ?? []) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
    localStorage.clear();
  });
  await page.goto('/');
  await createProfile(page);
  await importFile(page, backup);
  await page.getByRole('button', { name: /Continue to review/ }).click();
  await commitReview(page);
  await expect(page).toHaveURL(/#\/restore-done$/);

  await expect(page.locator('.restore-done-lines')).toContainText('New profiles');
  await expect(page.locator('.restore-done-lines')).toContainText('restored into');

  // Both people are on the device, and the setup came back with them.
  await page.getByRole('button', { name: /Go to overview/ }).click();
  await expect(page.locator('.profile-switcher-btn')).toBeVisible();
  await page.locator('.profile-switcher-btn').click();
  await expect(page.locator('.profile-menu-item')).toHaveCount(2);
});

test('overwriting a used profile\'s settings is opt-in and renames the button', async ({
  page,
}) => {
  await createProfile(page);
  await addValue(page, 'Glucose', '5.4');
  const backup = await exportBackup(page);
  // Make the profile "used" in a way the backup would overwrite.
  await openSettings(page);
  await page.locator('.settings-segment-btn', { hasText: 'US' }).click();

  await importFile(page, backup);
  await expect(page).toHaveURL(/#\/restore$/);

  const box = page.locator('.restore-overwrite input');
  await expect(box).toHaveCount(1);
  await expect(box).not.toBeChecked();
  await expect(page.locator('.restore-overwrite-detail')).toContainText('preferences');
  await expect(page.getByRole('button', { name: 'Continue to review' })).toBeVisible();

  await box.check();
  await expect(page.getByRole('button', { name: 'Overwrite settings and continue' })).toBeVisible();
});

test('a backup from a newer app version is refused in words', async ({ page }) => {
  await createProfile(page);
  // Written by a build that speaks a schema this one does not.
  const future = 'test-results/future-backup.json';
  writeFileSync(
    future,
    JSON.stringify({
      format: 'vitametr-backup',
      backupVersion: 1,
      schemaVersion: 99,
      profile: { id: 'p', name: 'Future', createdAt: '2030-01-01' },
      metrics: [],
      sources: [],
      measurements: [],
      settings: {},
    }),
  );

  await importFile(page, future);

  await expect(page.locator('.toast')).toContainText('newer app version');
  await expect(page).not.toHaveURL(/#\/restore$/);
});
