import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifySession } from '../../../lib/acquire/session.js';
import { parseClassifiedsPage } from '../../../lib/parse/classifieds.js';

const FIXTURE_NOW = '2026-09-19T06:20:00Z';

function readFixture(path) {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
}

test('valid: a non-zero uid and a 200 (the authenticated page)', () => {
  const html = readFixture('fixtures/http/classifieds-page.html');
  const { uid } = parseClassifiedsPage(html, { now: FIXTURE_NOW });
  assert.equal(uid, 226301);
  const { state } = classifySession({ class: 'ok', uid });
  assert.equal(state, 'valid');
});

test('expired: uid 0 even though the status was 200 (the anon page)', () => {
  const html = readFixture('fixtures/http/derived/classifieds-page-anon.html');
  const { uid } = parseClassifiedsPage(html, { now: FIXTURE_NOW });
  assert.equal(uid, 0);
  const { state } = classifySession({ class: 'ok', uid });
  assert.equal(state, 'expired');
});

test('expired: the application permission-denial page (cls403.html at 403)', () => {
  // A 403 carrying OzBargain's own styled HTML is a permission denial, not a
  // Cloudflare block. On /classified that means the session is invalid.
  const { state } = classifySession({ class: 'permission_denied', uid: 0 });
  assert.equal(state, 'expired');
});

test('cloudflare_block: the 17-byte "error code: 1010" body at 403', () => {
  // The Cloudflare block class outranks uid: it stops all requests, not just
  // classifieds.
  const { state } = classifySession({ class: 'cloudflare_block', uid: 0 });
  assert.equal(state, 'cloudflare_block');
});

test('expired: a 200 with uid 0 is expired even without a denial page', () => {
  const { state } = classifySession({ class: 'ok', uid: 0 });
  assert.equal(state, 'expired');
});

test('valid: a non-zero uid is valid regardless of a stale 304', () => {
  // A 304 on /classified means the page did not change; the session is as it
  // was. A non-zero uid (read from the last 200) keeps it valid.
  const { state } = classifySession({ class: 'not_modified', uid: 226301 });
  assert.equal(state, 'valid');
});
