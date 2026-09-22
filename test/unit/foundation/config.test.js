import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../../lib/config.js';

test('loadConfig returns defaults when env is empty', () => {
  const config = loadConfig({});
  assert.equal(config.OZB_DEALS_FEED_URL, 'https://www.ozbargain.com.au/deals/feed');
  assert.equal(config.OZB_FRONT_FEED_URL, 'https://www.ozbargain.com.au/feed');
  assert.equal(config.OZB_CLASSIFIEDS_URL, 'https://www.ozbargain.com.au/classified');
  assert.match(config.OZB_USER_AGENT, /^OzBargainHunter\/\d+\.\d+\.\d+ \(\+https:\/\/ozb\.gallagherhome\.au\)$/);
  assert.equal(config.OZB_POLL_INTERVAL_SECONDS, 300);
  assert.equal(config.OZB_CLASSIFIEDS_INTERVAL_SECONDS, 3600);
  assert.equal(config.OZB_DB_PATH, '/data/ozbargain.db');
  assert.equal(config.OZB_SNAPSHOT_PATH, '/data/ozbargain-snapshot.db');
  assert.equal(config.OZB_ICON_ROUTE_PUBLIC, false);
});

test('loadConfig returns a frozen object', () => {
  const config = loadConfig({});
  assert.throws(() => {
    config.OZB_DB_PATH = '/tmp/other.db';
  });
});

test('loadConfig rejects OZB_POLL_INTERVAL_SECONDS below 300', () => {
  assert.throws(
    () => loadConfig({ OZB_POLL_INTERVAL_SECONDS: '299' }),
    /at least 300/,
  );
});

test('loadConfig accepts OZB_POLL_INTERVAL_SECONDS exactly 300', () => {
  const config = loadConfig({ OZB_POLL_INTERVAL_SECONDS: '300' });
  assert.equal(config.OZB_POLL_INTERVAL_SECONDS, 300);
});

test('loadConfig rejects a non-integer poll interval', () => {
  assert.throws(() => loadConfig({ OZB_POLL_INTERVAL_SECONDS: 'abc' }), /must be an integer/);
});

test('loadConfig rejects an invalid URL', () => {
  assert.throws(() => loadConfig({ OZB_DEALS_FEED_URL: 'not-a-url' }), /must be a valid URL/);
});

test('loadConfig rejects a non-http URL', () => {
  assert.throws(() => loadConfig({ OZB_DEALS_FEED_URL: 'ftp://example.com/feed' }), /must use http\(s\)/);
});

test('loadConfig reads explicit env values', () => {
  const config = loadConfig({
    OZB_DEALS_FEED_URL: 'https://example.com/feed',
    OZB_POLL_INTERVAL_SECONDS: '600',
    OZB_ICON_ROUTE_PUBLIC: 'true',
  });
  assert.equal(config.OZB_DEALS_FEED_URL, 'https://example.com/feed');
  assert.equal(config.OZB_POLL_INTERVAL_SECONDS, 600);
  assert.equal(config.OZB_ICON_ROUTE_PUBLIC, true);
});

test('loadConfig rejects an invalid boolean', () => {
  assert.throws(() => loadConfig({ OZB_ICON_ROUTE_PUBLIC: 'maybe' }), /must be "true" or "false"/);
});

// D7: the two application-generated secrets are normalized (surrounding
// whitespace stripped) at the config boundary. Synthetic test-only values only;
// the failure messages never interpolate the secret content.
test('loadConfig trims surrounding whitespace from the two app-generated secrets (D7)', () => {
  const config = loadConfig({
    OZB_HEALTHCHECK_SECRET: '  healthcheck-secret\t\n',
    OZB_CSRF_SECRET: '\n csrf-secret \t',
  });
  assert.equal(config.OZB_HEALTHCHECK_SECRET, 'healthcheck-secret');
  assert.equal(config.OZB_CSRF_SECRET, 'csrf-secret');
});

test('loadConfig leaves the two app-generated secrets unchanged when unpadded (D7)', () => {
  const config = loadConfig({
    OZB_HEALTHCHECK_SECRET: 'healthcheck-secret',
    OZB_CSRF_SECRET: 'csrf-secret',
  });
  assert.equal(config.OZB_HEALTHCHECK_SECRET, 'healthcheck-secret');
  assert.equal(config.OZB_CSRF_SECRET, 'csrf-secret');
});

test('loadConfig normalizes whitespace-only secrets to empty (fail closed, D7)', () => {
  const config = loadConfig({
    OZB_HEALTHCHECK_SECRET: '   \t\n',
    OZB_CSRF_SECRET: '',
  });
  assert.equal(config.OZB_HEALTHCHECK_SECRET, '');
  assert.equal(config.OZB_CSRF_SECRET, '');
});

test('loadConfig does not trim the provider-owned opaque credentials (D7)', () => {
  // OZB_ACCOUNT_COOKIE may contain cookie syntax; EMAIL_SMTP_PASS is a
  // provider-defined password; MATRIX_ACCESS_TOKEN / NTfy_TOKEN are opaque.
  // Their contract is byte-exact: the application must not strip their bytes.
  const config = loadConfig({
    OZB_ACCOUNT_COOKIE: '  leading-space-cookie',
    EMAIL_SMTP_PASS: '  provider-password',
    MATRIX_ACCESS_TOKEN: '  opaque-token',
    NTfy_TOKEN: '  ntfy-token',
  });
  assert.equal(config.OZB_ACCOUNT_COOKIE, '  leading-space-cookie');
  assert.equal(config.EMAIL_SMTP_PASS, '  provider-password');
  assert.equal(config.MATRIX_ACCESS_TOKEN, '  opaque-token');
  assert.equal(config.NTfy_TOKEN, '  ntfy-token');
});
