import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyResponse } from '../../../lib/http/classify.js';

function readFixture(path) {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
}

test('fixtures/http/r0.xml at 200 gives ok', () => {
  const body = readFixture('fixtures/http/r0.xml');
  const result = classifyResponse({ status: 200, headers: {}, body });
  assert.equal(result.class, 'ok');
});

test('an empty body at 304 gives not_modified', () => {
  const result = classifyResponse({ status: 304, headers: {}, body: '' });
  assert.equal(result.class, 'not_modified');
});

test('cloudflare-1010.txt at 403 with server: cloudflare gives cloudflare_block and not permission_denied', () => {
  const body = readFixture('fixtures/http/derived/cloudflare-1010.txt');
  const result = classifyResponse({ status: 403, headers: { server: 'cloudflare' }, body });
  assert.equal(result.class, 'cloudflare_block');
  assert.notEqual(result.class, 'permission_denied');
});

test('cls403.html at 403 gives permission_denied and not cloudflare_block', () => {
  const body = readFixture('fixtures/http/cls403.html');
  const result = classifyResponse({ status: 403, headers: {}, body });
  assert.equal(result.class, 'permission_denied');
  assert.notEqual(result.class, 'cloudflare_block');
});

test('feed_classifieds_feed.xml at 404 gives not_found', () => {
  const body = readFixture('fixtures/http/feed_classifieds_feed.xml');
  const result = classifyResponse({ status: 404, headers: {}, body });
  assert.equal(result.class, 'not_found');
});

test('pg11.xml at 500 gives transient', () => {
  const body = readFixture('fixtures/http/pg11.xml');
  const result = classifyResponse({ status: 500, headers: {}, body });
  assert.equal(result.class, 'transient');
});

test('a 429 carrying Retry-After: 120 gives rate_limited with 120 surfaced', () => {
  const result = classifyResponse({ status: 429, headers: { 'retry-after': '120' }, body: '' });
  assert.equal(result.class, 'rate_limited');
  assert.equal(result.retryAfterSeconds, 120);
});

test('a 503 without Retry-After gives rate_limited with no retryAfterSeconds', () => {
  const result = classifyResponse({ status: 503, headers: {}, body: '' });
  assert.equal(result.class, 'rate_limited');
  assert.equal(result.retryAfterSeconds, undefined);
});
