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
