import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { insertRules, openTempStore } from '../support/integration.js';
import { startJwksServer } from '../support/jwks.js';
import { ensureBuild, startAppServer } from '../support/app-server.js';
import { collectPageErrors, launchBrowser, newAuthedContext } from '../support/browser.js';

const TEAM_DOMAIN = 'responsive.cloudflareaccess.com';
const AUDIENCE = 'responsive-audience';
const CSRF_SECRET = 'responsive-csrf-secret-with-enough-entropy';

describe('integration: responsive themed UI', () => {
  let jwks;
  let temp;
  let app;
  let browser;
  let token;

  before(async () => {
    jwks = await startJwksServer({ kid: 'responsive' });
    temp = openTempStore('ozb-ui-responsive-');
    const now = new Date().toISOString();
    insertRules(temp.store, [{ id: 1, type: 'match', parameters: { term: 'responsive router' }, cooldown_seconds: 0, created_at: now, modified_at: now }]);
    await ensureBuild();
    app = await startAppServer({ env: {
      OZB_DB_PATH: temp.dbPath,
      OZB_SNAPSHOT_PATH: join(temp.dir, 'snapshot.db'),
      OZB_CSRF_SECRET: CSRF_SECRET,
      OZB_HEALTHCHECK_SECRET: 'responsive-health',
      CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      CF_ACCESS_AUD: AUDIENCE,
      CF_JWKS_URL: jwks.url,
    } });
    token = await jwks.sign({ email: 'responsive@example.com' }, {
      aud: AUDIENCE,
      iss: `https://${TEAM_DOMAIN}`,
      exp: '2h',
    });
    browser = await launchBrowser();
  });

  after(async () => {
    await browser?.close();
    await app?.stop();
    temp?.close();
    await jwks?.close();
  });

  it('loads the authored design system and authenticated local logo', async () => {
    const { context, nonLoopbackRequests } = await newAuthedContext(browser, { token, origin: app.origin });
    try {
      const page = await context.newPage();
      const errors = collectPageErrors(page);
      assert.equal((await page.goto('/')).status(), 200);
      const style = await page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        card: getComputedStyle(document.querySelector('.stat-card')).backgroundColor,
        font: getComputedStyle(document.body).fontFamily,
        css: [...document.styleSheets].some((sheet) => sheet.href?.includes('/_next/static/css/')),
      }));
      assert.notEqual(style.body, 'rgba(0, 0, 0, 0)');
      assert.notEqual(style.body, style.card);
      assert.match(style.font, /system-ui/);
      assert.equal(style.css, true);
      assert.equal((await context.request.get('/logo.svg')).status(), 200);
      assert.deepEqual(nonLoopbackRequests, []);
      errors.assertNone();
    } finally {
      await context.close();
    }
    const unauthenticated = await browser.newContext({ baseURL: app.origin });
    try {
      assert.notEqual((await unauthenticated.request.get('/logo.svg')).status(), 200);
    } finally {
      await unauthenticated.close();
    }
  });

  for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1440, height: 900 }]) {
    for (const theme of ['light', 'dark']) {
      it(`${viewport.width}x${viewport.height} ${theme} has no overflow and reachable controls`, async () => {
        const context = await browser.newContext({
          baseURL: app.origin,
          viewport,
          extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': token },
        });
        await context.addInitScript((choice) => localStorage.setItem('ozb-theme', choice), theme);
        try {
          const page = await context.newPage();
          assert.equal((await page.goto('/rules')).status(), 200);
          const layout = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            theme: document.documentElement.dataset.theme,
            tabs: document.querySelectorAll('nav[aria-label="Primary"] a').length,
            active: document.querySelector('nav[aria-label="Primary"] a[aria-current="page"]')?.textContent,
            h1: document.querySelector('h1')?.getBoundingClientRect().toJSON(),
            smallTargets: [...document.querySelectorAll('button, a.tab, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea, summary')]
              .filter((element) => element.getClientRects().length)
              .map((element) => ({ text: element.textContent || element.getAttribute('name'), box: element.getBoundingClientRect().toJSON() }))
              .filter(({ box }) => box.width < 44 || box.height < 44),
            rowDisplay: getComputedStyle(document.querySelector('table.rules tbody tr')).display,
            labels: [...document.querySelectorAll('table.rules td')].every((cell) => cell.dataset.label),
          }));
          assert.ok(layout.overflow <= 0, `horizontal overflow: ${layout.overflow}`);
          assert.equal(layout.theme, theme);
          assert.equal(layout.tabs, 4);
          assert.equal(layout.active, 'Rules');
          assert.ok(layout.h1.x >= 0 && layout.h1.x + layout.h1.width <= viewport.width);
          assert.deepEqual(layout.smallTargets, []);
          if (viewport.width < 720) {
            assert.equal(layout.rowDisplay, 'block');
            assert.equal(layout.labels, true);
          } else {
            assert.equal(layout.rowDisplay, 'table-row');
          }
        } finally {
          await context.close();
        }
      });
    }
  }

  it('theme preference resolves before paint and system follows the OS', async () => {
    const context = await browser.newContext({
      baseURL: app.origin,
      colorScheme: 'dark',
      extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': token },
    });
    try {
      const page = await context.newPage();
      await page.goto('/');
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      const control = page.locator('.theme-control');
      assert.match(await control.getAttribute('aria-label'), /system/i);
      await control.click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
      assert.equal(await page.evaluate(() => localStorage.getItem('ozb-theme')), 'light');
      await page.reload();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
      await control.click();
      await control.click();
      assert.equal(await page.locator('html').getAttribute('data-theme-preference'), 'system');
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    } finally {
      await context.close();
    }
  });

  it('one-tap mute redirects into the themed rule controls', async () => {
    const { context } = await newAuthedContext(browser, { token, origin: app.origin });
    try {
      const response = await context.request.get('/rules/1/mute', { maxRedirects: 0 });
      assert.equal(response.status(), 303);
      assert.match(response.headers().location, /\/rules\/1\?notice=muted$/);
      const page = await context.newPage();
      await page.goto('/rules/1?notice=muted');
      assert.equal(await page.locator('nav[aria-label="Primary"] a[aria-current="page"]').textContent(), 'Rules');
      for (const label of ['Undo', 'Snooze 24 hours', 'Snooze 7 days']) {
        await page.getByRole('button', { name: label }).waitFor();
      }
    } finally {
      await context.close();
    }
  });
});
