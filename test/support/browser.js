/**
 * Playwright library harness for node:test. Chromium is resolved from the
 * repo-local browser directory. Page-initiated non-loopback traffic is aborted
 * and recorded; the known `local.adguard.org` AdGuard injection is neutralized
 * (answered with an empty script) so it neither logs a console error nor is
 * recorded, while every other non-loopback host is still blocked and recorded.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { REPO_ROOT } from './app-server.js';

export const BROWSERS_PATH = join(REPO_ROOT, '.playwright-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH;

function isLoopback(url) {
  if (!url.startsWith('http:') && !url.startsWith('https:')) return true;
  const host = new URL(url).hostname;
  return (
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]'
  );
}

/**
 * `local.adguard.org` is the system-level AdGuard ad-blocker's magic hostname.
 * AdGuard injects it into every browser on the machine, and
 * `--disable-extensions` cannot stop it (it is not a profile extension). It is
 * NOT a loopback host, so it is deliberately not classified as one; instead the
 * route guard neutralizes it explicitly. The app under test never calls it.
 */
function isAdguardNoise(url) {
  if (!url.startsWith('http:') && !url.startsWith('https:')) return false;
  return new URL(url).hostname === 'local.adguard.org';
}

/** Launch the pinned headless Chromium. */
export async function launchBrowser() {
  const { chromium } = await import('playwright');
  return chromium.launch({
    headless: true,
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
}

/** Create an authenticated context with a loopback-only route guard. */
export async function newAuthedContext(browser, { token, origin }) {
  const nonLoopbackRequests = [];
  const context = await browser.newContext({
    baseURL: origin,
    extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': token },
  });
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (isLoopback(url)) {
      await route.continue();
      return;
    }
    if (isAdguardNoise(url)) {
      // Neutralize the known AdGuard injection: answer with an empty script so
      // no `ERR_BLOCKED_BY_CLIENT` console error is logged and the request is
      // not recorded as a non-loopback violation.
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
      return;
    }
    nonLoopbackRequests.push(url);
    await route.abort('blockedbyclient');
  });
  return { context, nonLoopbackRequests };
}

/** Collect browser console errors and uncaught page exceptions. */
export function collectPageErrors(page) {
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error?.stack ?? error?.message ?? String(error)));
  return {
    consoleErrors,
    pageErrors,
    assertNone() {
      assert.deepEqual(consoleErrors, [], `browser console errors:\n${consoleErrors.join('\n')}`);
      assert.deepEqual(pageErrors, [], `browser page errors:\n${pageErrors.join('\n')}`);
    },
  };
}
