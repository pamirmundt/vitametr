/**
 * Dev-only: capture the summary's metric picker (closed + open) and its
 * "Worth attention" box per language and theme. The seed deliberately contains
 * one metric that is out of range NOW and one that only used to be, so the
 * attention box shows both kinds of line.
 */
import { chromium } from '@playwright/test';
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { LANGS, STR, clearToasts, hideChrome } from './screenshot-i18n.mjs';

const PORT = 8126;
const BASE = `http://localhost:${PORT}`;

/** One value, optionally with the reference range its source stated. */
async function addValue(page, t, name, value, date, ref) {
  await page.evaluate(() => {
    window.location.hash = '#/entry';
  });
  const m = page.getByLabel(t.metric, { exact: true }).first();
  await m.fill(name);
  await m.press('Enter');
  if (date) await page.locator('#entry-date').fill(date);
  await page.getByLabel(t.value, { exact: true }).first().fill(String(value));
  if (ref) {
    await page.getByRole('button', { name: t.range, exact: true }).first().click();
    const inputs = page.locator('.entry-row.expanded .row-meta .field input');
    await inputs.nth(0).fill(String(ref[0]));
    await inputs.nth(1).fill(String(ref[1]));
  }
  await page.getByRole('button', { name: t.add }).click();
  await page.waitForTimeout(60);
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
          viewport: { width: 390, height: 1100 },
          colorScheme: theme,
          locale,
          deviceScaleFactor: 2,
        });
        const page = await ctx.newPage();
        await page.goto(BASE);
        await page.evaluate(async () => {
          for (const db of (await indexedDB.databases?.()) ?? []) {
            if (db.name) indexedDB.deleteDatabase(db.name);
          }
        });
        await page.goto(BASE);
        await page.getByRole('button', { name: t.createProfile }).click();
        await page.locator('.app-nav').waitFor();

        // Cholesterol used to be above its range and no longer is; TSH is above
        // it right now. The rest is plain history.
        await addValue(page, t, t.totalCholesterol, 6.9, '2024-03-02', [3.0, 5.0]);
        await addValue(page, t, t.totalCholesterol, 4.6, '2026-01-15', [3.0, 5.0]);
        await addValue(page, t, t.tsh, 7.4, '2026-01-15', [0.4, 4.0]);
        await addValue(page, t, t.glucose, 5.1, '2026-01-15', [3.9, 5.6]);
        await addValue(page, t, t.creatinine, 82, '2026-01-15');
        await addValue(page, t, t.bodyWeight, 82.5, '2026-01-15');

        // Watch one metric so the picker shows its "Watched" group.
        await page.locator('.app-nav').getByRole('button', { name: t.overview }).click();
        await page
          .locator('.metric-card-wrap')
          .filter({ has: page.locator('.metric-name', { hasText: t.tsh }) })
          .locator('.watch-star')
          .click();

        await page.locator('.overview-header').getByRole('button', { name: t.summary }).click();
        await page.locator('.report').waitFor();
        await page.waitForTimeout(150);
        await clearToasts(page);
        await hideChrome(page);

        await page.screenshot({
          path: `screenshots/summary-filter-closed-${lang}-${theme}.png`,
          fullPage: true,
        });
        await page
          .locator('.report-attention')
          .screenshot({ path: `screenshots/summary-attention-${lang}-${theme}.png` });

        await page.getByRole('button', { name: t.editSelection }).click();
        await page.locator('.report-picker--open').waitFor();
        await page.waitForTimeout(120);
        await page.screenshot({
          path: `screenshots/summary-filter-open-${lang}-${theme}.png`,
          fullPage: true,
        });
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  console.log('Wrote screenshots/summary-filter-*.png + summary-attention-*.png');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
