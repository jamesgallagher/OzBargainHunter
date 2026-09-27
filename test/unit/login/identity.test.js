import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChromeUserAgent, CONTEXT_OPTIONS, LAUNCH_ARGS } from '../../../lib/ozb-login/identity.js';

// The browser identity (feature card decision 6, prompt 4.5). Pure: no browser,
// no I/O. These tests pin the exact identity the login presents, and the
// absence of the flags that would betray it.

test('buildChromeUserAgent: win32 is the standard Windows Chrome UA for the major version', () => {
  const ua = buildChromeUserAgent('131', 'win32');
  assert.equal(
    ua,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  );
  assert.ok(!ua.includes('Headless'), 'never claims HeadlessChrome');
});

test('buildChromeUserAgent: darwin is the standard macOS Chrome UA', () => {
  const ua = buildChromeUserAgent('131', 'darwin');
  assert.equal(
    ua,
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  );
  assert.ok(!ua.includes('Headless'), 'never claims HeadlessChrome');
});

test('buildChromeUserAgent: any other platform is the standard Linux Chrome UA', () => {
  const ua = buildChromeUserAgent('131', 'linux');
  assert.equal(
    ua,
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  );
  assert.ok(!ua.includes('Headless'), 'never claims HeadlessChrome');
});

test('the UA is a plain Chrome UA on every platform: no Headless, no automation marker', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const ua = buildChromeUserAgent('131', platform);
    assert.ok(!/headless/i.test(ua), `${platform}: no HeadlessChrome token`);
    assert.ok(!/automation/i.test(ua), `${platform}: no automation marker`);
  }
});

test('the UA derives the full version from the major, so a Playwright upgrade cannot skew it', () => {
  assert.match(buildChromeUserAgent('120', 'linux'), /Chrome\/120\.0\.0\.0/);
  assert.match(buildChromeUserAgent('145', 'win32'), /Chrome\/145\.0\.0\.0/);
});

test('LAUNCH_ARGS is the proven set, and never the forbidden flags', () => {
  assert.deepEqual(
    [...LAUNCH_ARGS],
    [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
    ],
  );
  assert.ok(!LAUNCH_ARGS.includes('--no-sandbox'), 'never --no-sandbox');
  assert.ok(
    !LAUNCH_ARGS.some((a) => a.startsWith('--disable-blink-features')),
    'never --disable-blink-features (the automation tell)',
  );
  assert.ok(!LAUNCH_ARGS.includes('--enable-automation'), 'never --enable-automation');
});

test('CONTEXT_OPTIONS is the plain desktop identity, with no stealth affordances', () => {
  assert.equal(CONTEXT_OPTIONS.locale, 'en-AU');
  assert.equal(CONTEXT_OPTIONS.timezoneId, 'Australia/Melbourne');
  assert.deepEqual(CONTEXT_OPTIONS.viewport, { width: 1366, height: 768 });
  assert.equal(CONTEXT_OPTIONS.acceptDownloads, false);
  assert.deepEqual(CONTEXT_OPTIONS.permissions, []);
});
