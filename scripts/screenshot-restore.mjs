/**
 * Dev-only: capture the restore preview, the restore summary and the export
 * scope dialog, per language and theme.
 */
import { chromium } from '@playwright/test';
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { LANGS, STR, clearToasts, hideChrome } from './screenshot-i18n.mjs';

const PORT = 8128;
const BASE = `http://localhost:${PORT}`;

async function addValue(page, t, name, value) {
  await page.evaluate(() => {
    window.location.hash = '#/entry';
  });
  const m = page.getByLabel(t.metric, { exact: true }).first();
  await m.fill(name);
  await m.press('Enter');
  await page.getByLabel(t.value, { exact: true }).first().fill(String(value));
  await page.getByRole('button', { name: t.add }).click();
  await page.waitForTimeout(60);
}

async function wipe(page) {
  await page.evaluate(async () => {
    for (const db of (await indexedDB.databases?.()) ?? []) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
    localStorage.clear();
  });
}

async function main() {
  mkdirSync('screenshots', { recursive: true });
  const server = spawn('node', ['scripts/serve.js', 'dist', String(PORT)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch();
  try {
    for (const { lang, locale } of LANGS) {
      const t = STR[lang];
      for (const theme of ['light', 'dark']) {
        const ctx = await browser.newContext({
          viewport: { width: 1100, height: 1000 },
          colorScheme: theme,
          locale,
          deviceScaleFactor: 2,
          acceptDownloads: true,
        });
        const page = await ctx.newPage();
        await page.goto(BASE);
        await wipe(page);
        await page.goto(BASE);
        await page.getByRole('button', { name: t.createProfile }).click();
        await page.locator('.app-nav').waitFor();
        await addValue(page, t, t.glucose, 5.4);
        await addValue(page, t, t.totalCholesterol, 4.9);

        // A second profile, so the backup carries a family.
        await page.locator('.app-nav').getByRole('button', { name: t.settings }).click();
        await page.getByRole('button', { name: t.addProfile }).click();
        await page.locator('.profile-form input').first().fill(t.secondProfileName);
        await page.getByRole('button', { name: t.createAndSwitch }).click();
        await page.waitForURL(/#\/overview$/);
        await page.waitForTimeout(300);
        await addValue(page, t, t.bodyWeight, 62);

        // The export dialog, with its scope choice.
        await page.locator('.app-nav').getByRole('button', { name: t.settings }).click();
        await page.waitForTimeout(150);
        await page.getByRole('button', { name: t.exportJson }).click();
        await page.waitForTimeout(200);
        await page
          .locator('dialog.modal .modal-box')
          .screenshot({ path: `screenshots/export-scope-${lang}-${theme}.png` });

        await page.locator('.settings-scope-option input[value="all"]').check();
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          page.locator('dialog.modal .primary').click(),
        ]);
        const backup = `screenshots/.backup-${lang}.json`;
        await download.saveAs(backup);

        // A fresh device restoring that file: the preview.
        await wipe(page);
        await page.goto(BASE);
        await page.getByRole('button', { name: t.createProfile }).click();
        await page.locator('.app-nav').waitFor();
        await page.evaluate(() => {
          window.location.hash = '#/import';
        });
        await page.waitForTimeout(200);
        await page.getByRole('button', { name: t.specificFormat }).click();
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser'),
          page.locator('.format-card', { hasText: t.backupCard }).click(),
        ]);
        await chooser.setFiles(backup);
        await page.waitForTimeout(1200);
        await clearToasts(page);
        await hideChrome(page);
        await page.screenshot({
          path: `screenshots/restore-preview-${lang}-${theme}.png`,
          fullPage: true,
        });

        // …and the summary it ends on.
        await page.getByRole('button', { name: t.restoreContinue }).click();
        await page.waitForTimeout(2000);
        if (/#\/import-filter$/.test(page.url())) {
          await page.locator('.import-filter-segment-btn', { hasText: t.filterAll }).click();
          await page.locator('.import-filter-continue').click();
        }
        if (/#\/review$/.test(page.url())) {
          await page.locator('.review-footer').waitFor({ timeout: 20000 });
          await page.getByRole('button', { name: t.importSelected }).click();
          await page.waitForTimeout(1200);
        }
        await clearToasts(page);
        await hideChrome(page);
        await page.screenshot({
          path: `screenshots/restore-done-${lang}-${theme}.png`,
          fullPage: true,
        });
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  console.log('Wrote screenshots/restore-*.png + export-scope-*.png');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
