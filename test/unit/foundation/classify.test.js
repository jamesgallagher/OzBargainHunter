import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyResponse } from '../../../lib/http/classify.js';

function readFixture(path) {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
}

// The real captured headers of the 403 page (cls403.html): OzBargain sits
// behind Cloudflare on every response, so they carry `server: cloudflare`.
// This is the shape that must classify as permission_denied.
function clsHeaders() {
  return {
    date: 'Sat, 19 Sep 2026 06:18:47 GMT',
    'content-type': 'text/html; charset=utf-8',
    server: 'cloudflare',
    vary: 'Accept-Encoding',
    'set-cookie': 'PHPSESSID=30tf4n9k8hh38tle15o2ev7e4g; expires=Fri, 18 Dec 2026 06:18:47 GMT; Max-Age=7776000; path=/; secure; HttpOnly',
    'last-modified': 'Sat, 19 Sep 2026 06:18:47 GMT',
    'cache-control': 'no-store, no-cache, must-revalidate',
    'cf-cache-status': 'DYNAMIC',
    'cf-ray': 'a3d6799fdb882bdf-MEL',
  };
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
  const result = classifyResponse({ status: 403, headers: clsHeaders(), body });
  assert.equal(result.class, 'cloudflare_block');
  assert.notEqual(result.class, 'permission_denied');
});

test('cls403.html at 403 with its real headers (server: cloudflare) gives permission_denied and not cloudflare_block', () => {
  const body = readFixture('fixtures/http/cls403.html');
  const result = classifyResponse({ status: 403, headers: clsHeaders(), body });
  assert.equal(result.class, 'permission_denied');
  assert.notEqual(result.class, 'cloudflare_block');
});

test('cls403.html at 403 with empty headers gives permission_denied (header is not the signal)', () => {
  const body = readFixture('fixtures/http/cls403.html');
  const result = classifyResponse({ status: 403, headers: {}, body });
  assert.equal(result.class, 'permission_denied');
});

test('a 403 with the "Just a moment..." challenge body gives cloudflare_block even without the server header', () => {
  const result = classifyResponse({
    status: 403,
    headers: {},
    body: '<html><head><title>Just a moment...</title></head></html>',
  });
  assert.equal(result.class, 'cloudflare_block');
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

test('a response with missing headers does not throw', () => {
  const result = classifyResponse({ status: 403, body: readFixture('fixtures/http/cls403.html') });
  assert.equal(result.class, 'permission_denied');
});
