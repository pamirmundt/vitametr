/**
 * Dev-only: capture the two review states that decide on NUMBERS — suggestions
 * carrying their evidence, and a row whose unit the lab never stated — per
 * language and theme. Run: node scripts/screenshot-review-evidence.mjs
 *
 * The first shot needs a profile with history, so it imports a seed CSV before
 * the row that has to be matched against it.
 */

import { chromium } from '@playwright/test';
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { LANGS, STR, clearToasts, hideChrome } from './screenshot-i18n.mjs';

const PORT = 8126;
const BASE = `http://localhost:${PORT}`;

/** Drive one CSV through the dropzone and the column-mapping screen to review. */
async function importCsv(page, t, fixture) {
  await page.goto(`${BASE}#/import`);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.import-dropzone').click(),
  ]);
  await chooser.setFiles(fixture);
  await page.locator('.csv-mapping').waitFor();
  await page.getByRole('button', { name: t.continueReview }).click();
  await page.locator('.review-list').waitFor();
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
          viewport: { width: 420, height: 900 },
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

        // 1) Seed the history, then bring in the row only the history can match.
        await importCsv(page, t, 'test/fixtures/labs/cz/lab-cs-history-seed.csv');
        await page.getByRole('button', { name: t.importSelected }).click();
        await page.locator('.app-nav').waitFor();
        await importCsv(page, t, 'test/fixtures/labs/cz/lab-cs-code-only.csv');
        await page.locator('.review-suggest-card').first().waitFor();
        await page.waitForTimeout(150);
        await clearToasts(page);
        await hideChrome(page);
        await page.screenshot({
          path: `screenshots/review-evidence-${lang}-${theme}.png`,
          fullPage: true,
        });

        // 2) The same sheet BEFORE any hematocrit history exists: both options
        // fall back to what they would mean in the other unit.
        await page.goto(`${BASE}#/import`);
        const [freshChooser] = await Promise.all([
          page.waitForEvent('filechooser'),
          page.locator('.import-dropzone').click(),
        ]);
        await freshChooser.setFiles('test/fixtures/labs/cz/lab-cs-nclp.pdf');
        await page.locator('.import-filter-continue').waitFor({ timeout: 30000 });
        await page.locator('.import-filter-continue').click();
        const fresh = page.locator('.review-item--needs-unit').first();
        await fresh.waitFor();
        await fresh.scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        await clearToasts(page);
        await hideChrome(page);
        await fresh.screenshot({ path: `screenshots/review-unit-nohistory-${lang}-${theme}.png` });

        // 3) Seed two hematocrit readings so the unit chooser can show the user
        // his OWN range converted into each candidate unit — that comparison is
        // what actually decides between 0.451 L/L and 0.451 %.
        await importCsv(page, t, 'test/fixtures/labs/cz/lab-cs-hct-seed.csv');
        await page.getByRole('button', { name: t.importSelected }).click();
        await page.waitForURL(/#\/overview$/);

        // 4) The same sheet again, now with history behind the metric.
        await page.goto(`${BASE}#/import`);
        const [pdfChooser] = await Promise.all([
          page.waitForEvent('filechooser'),
          page.locator('.import-dropzone').click(),
        ]);
        await pdfChooser.setFiles('test/fixtures/labs/cz/lab-cs-nclp.pdf');
        await page.locator('.import-filter-continue').waitFor({ timeout: 30000 });
        await page.locator('.import-filter-continue').click();
        const blocked = page.locator('.review-item--needs-unit').first();
        await blocked.waitFor();
        await blocked.scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        await clearToasts(page);
        await hideChrome(page);
        // Full-page here would be a metre of resolved rows; the state is local.
        await blocked.screenshot({ path: `screenshots/review-unit-missing-${lang}-${theme}.png` });

        // 5) …and the same row once the choice is made: picked option loud, the
        // other one stepped back, the row's open decision closed.
        const picked = page.locator('.review-item--needs-unit').first();
        await picked.locator('.review-unit-option').first().click();
        const settled = page.locator('.review-item').filter({ has: page.locator('.review-unit-option[aria-checked="true"]') }).first();
        await page.waitForTimeout(150);
        await settled.screenshot({ path: `screenshots/review-unit-picked-${lang}-${theme}.png` });

        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  console.log('Wrote screenshots/review-evidence-*.png and review-unit-missing-*.png');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
