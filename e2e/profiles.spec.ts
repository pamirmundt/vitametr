import { expect, test, type Page } from '@playwright/test';

/**
 * Several tracked people on one install.
 *
 * The feature must be invisible until a second profile exists, must swap ALL
 * the data when it does, and must never touch the environment (language,
 * appearance) or ask for the passphrase again. The last block is the one that
 * matters most in practice: an install made by the previous release has to keep
 * working, with its data intact, without the user doing anything.
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
  const metricInput = page.getByLabel('Metric', { exact: true }).first();
  await metricInput.fill(metric);
  await metricInput.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill(value);
  await page.getByRole('button', { name: /^Add$/ }).click();
  await page.waitForTimeout(100);
}

/** Settings → Profiles → "+ Add profile" → name → Create and switch. */
async function openSettings(page: Page): Promise<void> {
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.settings-view')).toBeVisible();
}

async function addSecondProfile(page: Page, name: string, inherit = true): Promise<void> {
  await openSettings(page);
  await page.getByRole('button', { name: /Add profile/ }).click();
  await page.locator('.profile-form input').first().fill(name);
  if (!inherit) await page.locator('.profile-inherit .switch').click();
  await page.getByRole('button', { name: 'Create and switch' }).click();
  await expect(page).toHaveURL(/#\/overview$/);
}

test('one profile looks exactly like before — no switcher anywhere', async ({ page }) => {
  const errors = trackErrors(page);
  await createProfile(page);

  await expect(page.locator('.profile-switcher')).toHaveCount(0);
  await openSettings(page);
  // The Profiles section is there (that is where a second one is made), but the
  // single profile cannot be deleted from it.
  await expect(page.locator('.profile-row')).toHaveCount(1);
  await expect(page.locator('.profile-row-delete')).toBeDisabled();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a second profile brings the switcher, its own data, and a toast', async ({ page }) => {
  const errors = trackErrors(page);
  await createProfile(page);
  await addValue(page, 'Glucose', '5.4');

  await addSecondProfile(page, 'Romana');

  // Switcher appears, the new profile is active and starts empty.
  await expect(page.locator('.profile-switcher')).toHaveCount(1);
  await expect(page.locator('.profile-switcher-name')).toHaveText('Romana');
  await expect(page.locator('.toast', { hasText: 'Switched to Romana' })).toBeVisible();
  await expect(page.locator('.app-content')).not.toContainText('Glucose');

  // Switching back brings the first profile's data with it.
  await page.locator('.profile-switcher-btn').click();
  await page.locator('.profile-menu-item', { hasText: 'My profile' }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  await expect(page.locator('.profile-switcher-name')).toHaveText('My profile');
  await expect(
    page.locator('.app-content button').filter({ hasText: 'Glucose' }).first(),
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('switching never asks for the password again', async ({ page }) => {
  // Onboard WITH a password: the point is that one unlock covers every profile.
  await page.getByLabel('Set a password (optional)', { exact: true }).fill('secret123');
  await page.getByLabel('Repeat passphrase', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await addSecondProfile(page, 'Romana');
  await page.locator('.profile-switcher-btn').click();
  await page.locator('.profile-menu-item', { hasText: 'My profile' }).click();

  // No lock screen in between — the key belongs to the device, not the profile.
  await expect(page.locator('.app-nav')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unlock' })).toHaveCount(0);
});

test('language and appearance survive a switch untouched', async ({ page }) => {
  await createProfile(page);
  await openSettings(page);
  await page.locator('.settings-segment-btn', { hasText: 'CS' }).click();
  await page.locator('.settings-segment-btn', { hasText: 'Tmavý' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Add a profile (labels are Czech now) and switch back and forth.
  await page.getByRole('button', { name: /Přidat profil/ }).click();
  await page.locator('.profile-form input').first().fill('Romana');
  await page.getByRole('button', { name: 'Vytvořit a přepnout' }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  // Both are device-scoped: nothing repaints, nothing re-translates.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.app-nav')).toContainText('Přehled');
});

test('the switcher disappears again when the second-to-last profile is deleted', async ({
  page,
}) => {
  await createProfile(page);
  await addSecondProfile(page, 'Romana');
  await expect(page.locator('.profile-switcher')).toHaveCount(1);

  // Deleting needs the profile to be inactive, and the name typed out.
  await page.locator('.profile-switcher-btn').click();
  await page.locator('.profile-menu-item', { hasText: 'My profile' }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  await openSettings(page);
  const romanaRow = page.locator('.profile-row').filter({ hasText: 'Romana' });
  await romanaRow.getByRole('button', { name: 'Delete' }).click();

  const confirm = page.locator('.profile-form--danger');
  await expect(confirm.getByRole('button', { name: 'Delete' })).toBeDisabled();
  await confirm.locator('input').fill('Romana');
  await confirm.getByRole('button', { name: 'Delete' }).click();

  await expect(page.locator('.profile-row')).toHaveCount(1);
  await expect(page.locator('.profile-switcher')).toHaveCount(0);
});

test('the active profile and the last profile cannot be deleted', async ({ page }) => {
  await createProfile(page);
  await addSecondProfile(page, 'Romana');
  await openSettings(page);

  // Romana is active now, so her row cannot be deleted…
  const active = page.locator('.profile-row.is-active');
  await expect(active).toContainText('Romana');
  await expect(active.getByRole('button', { name: 'Delete' })).toBeDisabled();
  // …and the other one can.
  const other = page.locator('.profile-row').filter({ hasText: 'My profile' });
  await expect(other.getByRole('button', { name: 'Delete' })).toBeEnabled();
});

test('a new profile inherits the setup but not what the other person watches', async ({
  page,
}) => {
  await createProfile(page);
  await addValue(page, 'Glucose', '5.4');
  // Watching is an opinion about a PERSON, unlike the units or the panels.
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  const glucoseCard = page
    .locator('.metric-card-wrap')
    .filter({ has: page.locator('.metric-name', { hasText: 'Glucose' }) });
  await glucoseCard.locator('.watch-star').click();
  await expect(page.locator('.overview-group-title').first()).toHaveText(/Watched/);

  await addSecondProfile(page, 'Romana');

  // The new profile starts with no watched metric of its own.
  await expect(page.locator('.overview-group-title')).toHaveCount(0);
  await expect(page.locator('.tag-chip--star')).toHaveCount(0);

  // …while the first profile keeps its star.
  await page.locator('.profile-switcher-btn').click();
  await page.locator('.profile-menu-item', { hasText: 'My profile' }).click();
  await expect(page.locator('.overview-group-title').first()).toHaveText(/Watched/);
});

test('an export filename names the profile once there is more than one', async ({ page }) => {
  await createProfile(page);
  await addValue(page, 'Glucose', '5.4');

  // One profile: the name would say nothing, so the filename does not change.
  await page.evaluate(() => {
    window.location.hash = '#/export';
  });
  await expect(page.locator('.export-view')).toBeVisible();
  const single = page.locator('input.export-filename').first();
  await expect(single).toHaveValue(/^vitametr-export-\d{4}-\d{2}-\d{2}$/);

  await addSecondProfile(page, 'Romana Víšková');
  await page.evaluate(() => {
    window.location.hash = '#/export';
  });
  await expect(page.locator('.export-view')).toBeVisible();
  // Diacritics folded, spaces collapsed to a dash — the same slug the backup uses.
  await expect(single).toHaveValue(/^vitametr-romana-viskova-export-\d{4}-\d{2}-\d{2}$/);
});

test('a review says which profile the import lands in', async ({ page }) => {
  await createProfile(page);
  await addSecondProfile(page, 'Romana');

  await page.evaluate(() => {
    window.location.hash = '#/import';
  });
  await page.getByRole('button', { name: 'Specific format' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'CSV table' }).click(),
  ]);
  await chooser.setFiles('test/fixtures/labs/cz/lab-cs-semicolon.csv');
  await expect(page.locator('.csv-mapping')).toBeVisible();
  await page.getByRole('button', { name: /Continue to review/ }).click();
  if (/#\/import-filter$/.test(page.url())) {
    await page.locator('.import-filter-segment-btn', { hasText: 'All' }).click();
    await page.locator('.import-filter-continue').click();
  }

  await expect(page.locator('.review-target')).toHaveText('Into profile: Romana');
});

// ---------------------------------------------------------------------------
// Backward compatibility: an install written by the previous release.
// ---------------------------------------------------------------------------

test('a pre-profiles install opens with its data and adopts its language', async ({ page }) => {
  const errors = trackErrors(page);

  // Write exactly what the previous release stored: one plaintext blob, key and
  // meta record, all under the fixed 'default' key, with the language and theme
  // still inside the profile's settings. The stores are CLEARED rather than the
  // database deleted — the running app holds a connection that would block a
  // delete, while a plain readwrite transaction needs no exclusivity.
  await page.evaluate(async () => {
    localStorage.clear();

    const legacy = {
      schemaVersion: 1,
      profile: { id: 'p-legacy', name: 'Milan', createdAt: '2024-01-01T00:00:00.000Z' },
      metrics: [],
      sources: [],
      measurements: [
        {
          id: 'm-1',
          profileId: 'p-legacy',
          metricId: 'builtin:glucose',
          value: 5.4,
          unit: 'mmol/L',
          takenAt: '2025-06-01',
          timePrecision: 'date',
          status: 'confirmed',
          origin: { pluginId: 'manual' },
          createdAt: '2025-06-01T00:00:00.000Z',
          modifiedAt: '2025-06-01T00:00:00.000Z',
        },
      ],
      settings: { locale: 'cs', theme: 'dark' },
    };

    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('vitametr');
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['meta', 'keys', 'blobs'], 'readwrite');
        for (const name of ['meta', 'keys', 'blobs']) tx.objectStore(name).clear();
        tx.objectStore('blobs').put(new TextEncoder().encode(JSON.stringify(legacy)), 'default');
        tx.objectStore('keys').put({ mode: 'plaintext' }, 'default');
        tx.objectStore('meta').put(
          { schemaVersion: 1, profileId: 'p-legacy', mode: 'plaintext' },
          'default',
        );
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
  });

  await page.reload();
  await expect(page.locator('.app-nav')).toBeVisible();

  // The data is there, under the name it had.
  await expect(
    page.locator('.app-content button').filter({ hasText: 'Glukóza' }).first(),
  ).toBeVisible();
  // Language and appearance were taken over from the profile — the move to
  // device scope must be invisible.
  await expect(page.locator('.app-nav')).toContainText('Přehled');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // Still a single profile, so still no switcher.
  await expect(page.locator('.profile-switcher')).toHaveCount(0);

  // The blob moved under the profile's id and the legacy record is gone.
  const layout = await page.evaluate(
    () =>
      new Promise<{ blobs: string[]; meta: string[] }>((resolve, reject) => {
        const open = indexedDB.open('vitametr');
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['blobs', 'meta'], 'readonly');
          const blobs = tx.objectStore('blobs').getAllKeys();
          const meta = tx.objectStore('meta').getAllKeys();
          tx.oncomplete = () => {
            db.close();
            resolve({ blobs: blobs.result.map(String), meta: meta.result.map(String) });
          };
          tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      }),
  );
  expect(layout.blobs).toEqual(['p-legacy']);
  expect(layout.meta).toEqual(['device']);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a migrated install keeps its data after adding a second profile', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    for (const db of (await indexedDB.databases?.()) ?? []) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
    localStorage.clear();
  });
  await page.goto('/');
  await createProfile(page);
  await addValue(page, 'Glucose', '5.4');
  // Simulate the update by reloading (the store re-reads everything from disk).
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.locator('.app-nav')).toBeVisible();

  await addSecondProfile(page, 'Romana');
  await page.waitForTimeout(600);
  await page.reload();

  // The reopened install lands on the profile that was active, and the first
  // profile's readings are still intact behind the switcher.
  await expect(page.locator('.profile-switcher-name')).toHaveText('Romana');
  await page.locator('.profile-switcher-btn').click();
  await page.locator('.profile-menu-item', { hasText: 'My profile' }).click();
  await expect(
    page.locator('.app-content button').filter({ hasText: 'Glucose' }).first(),
  ).toBeVisible();
});
