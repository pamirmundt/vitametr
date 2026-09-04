/**
 * Dev-only: capture the profile switcher (closed, open, phone) and
 * Settings → Profiles per language and theme.
 */
import { chromium } from '@playwright/test';
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { LANGS, STR, clearToasts, hideChrome } from './screenshot-i18n.mjs';

const PORT = 8127;
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

async function seed(page, t) {
  await page.getByRole('button', { name: t.createProfile }).click();
  await page.locator('.app-nav').waitFor();
  await addValue(page, t, t.glucose, 5.4);
  await addValue(page, t, t.totalCholesterol, 4.9);

  // A second profile turns the switcher on.
  await page.locator('.app-nav').getByRole('button', { name: t.settings }).click();
  await page.getByRole('button', { name: t.addProfile }).click();
  await page.locator('.profile-form input').first().fill(t.secondProfileName);
  await page.getByRole('button', { name: t.createAndSwitch }).click();
  // The switch re-renders the whole shell; wait for it to settle before typing.
  await page.waitForURL(/#\/overview$/);
  await page.waitForTimeout(300);
  await addValue(page, t, t.bodyWeight, 62);
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
        // Desktop: closed switcher, open menu, Settings → Profiles.
        const ctx = await browser.newContext({
          viewport: { width: 1200, height: 900 },
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
          localStorage.clear();
        });
        await page.goto(BASE);
        await seed(page, t);
        await page.waitForTimeout(150);
        await clearToasts(page);

        await page.screenshot({ path: `screenshots/profile-switcher-closed-${lang}-${theme}.png` });
        await page.locator('.profile-switcher-btn').click();
        await page.waitForTimeout(150);
        await page.screenshot({ path: `screenshots/profile-switcher-open-${lang}-${theme}.png` });
        await page.keyboard.press('Escape');

        await page.locator('.app-nav').getByRole('button', { name: t.settings }).click();
        await page.waitForTimeout(150);
        await clearToasts(page);
        await hideChrome(page);
        await page
          .locator('.settings-group')
          .filter({ hasText: t.profilesSection })
          .first()
          .screenshot({ path: `screenshots/settings-profiles-${lang}-${theme}.png` });
        await ctx.close();

        // Phone: avatar-only button and the menu as a bottom sheet.
        const mobile = await browser.newContext({
          viewport: { width: 390, height: 844 },
          colorScheme: theme,
          locale,
          deviceScaleFactor: 2,
        });
        const mpage = await mobile.newPage();
        await mpage.goto(BASE);
        await mpage.evaluate(async () => {
          for (const db of (await indexedDB.databases?.()) ?? []) {
            if (db.name) indexedDB.deleteDatabase(db.name);
          }
          localStorage.clear();
        });
        await mpage.goto(BASE);
        await seed(mpage, t);
        await mpage.waitForTimeout(150);
        await clearToasts(mpage);
        await mpage.locator('.profile-switcher-btn').click();
        await mpage.waitForTimeout(200);
        await mpage.screenshot({ path: `screenshots/profile-switcher-mobile-${lang}-${theme}.png` });
        await mobile.close();
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  console.log('Wrote screenshots/profile-switcher-*.png + settings-profiles-*.png');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
