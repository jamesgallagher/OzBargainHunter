/**
 * Playwright library harness for node:test. Chromium is resolved from the
 * repo-local browser directory and page-initiated non-loopback traffic is
 * aborted and recorded.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { REPO_ROOT } from './app-server.js';

export const BROWSERS_PATH = join(REPO_ROOT, '.playwright-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH;

function isLoopback(url) {
  if (!url.startsWith('http:') && !url.startsWith('https:')) return true;
  const host = new URL(url).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
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
    if (!isLoopback(url)) {
      nonLoopbackRequests.push(url);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
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
