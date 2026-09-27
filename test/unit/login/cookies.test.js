import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSessionCookies } from '../../../lib/ozb-login/cookies.js';

// Session-cookie selection (prompt 4.7). Pure: the cookie list the browser
// reports for the classifieds URL is reduced to the header the app presents
// on later polls, plus the session's expiry. `nowMs` is injected.

// A fixed instant, so the expiry arithmetic is pinned rather than drifting.
const NOW = Date.parse('2026-09-19T07:30:00Z');
const NOW_S = NOW / 1000;

test('drops Cloudflare and analytics cookies, keeps the session and the hash', () => {
  const result = selectSessionCookies(
    [
      { name: 'PHPSESSID', value: 'abc123', expires: NOW_S + 7776000 },
      { name: 'ozbuserhash', value: 'hash123' },
      { name: '_ga', value: 'GA1.1.test', expires: NOW_S + 31536000 },
      { name: '_gid', value: 'GID.test' },
      { name: '__cf_bm', value: 'fixture-cf-bm', expires: NOW_S + 3600 },
      { name: 'cf_clearance', value: 'cf123' },
    ],
    NOW,
  );
  assert.equal(result.hasSession, true);
  assert.equal(result.header, 'PHPSESSID=abc123; ozbuserhash=hash123');
  assert.deepEqual(result.keptNames, ['PHPSESSID', 'ozbuserhash']);
  assert.deepEqual(result.droppedNames, ['_ga', '_gid', '__cf_bm', 'cf_clearance']);
});

test('drops cookies whose expiry is in the past, and keeps the rest', () => {
  const result = selectSessionCookies(
    [
      { name: 'PHPSESSID', value: 'abc123', expires: NOW_S + 7776000 },
      { name: 'stale', value: 'old', expires: NOW_S - 1 },
    ],
    NOW,
  );
  assert.equal(result.hasSession, true);
  assert.equal(result.header, 'PHPSESSID=abc123');
  assert.deepEqual(result.droppedNames, ['stale']);
});

test('a session cookie (expires -1 or absent) is never treated as expired', () => {
  const result = selectSessionCookies(
    [
      { name: 'PHPSESSID', value: 'abc123', expires: -1 },
      { name: 'ozbuserhash', value: 'hash123' },
    ],
    NOW,
  );
  assert.equal(result.hasSession, true);
  assert.equal(result.header, 'PHPSESSID=abc123; ozbuserhash=hash123');
  assert.deepEqual(result.droppedNames, []);
});

test('expiresAt is the PHPSESSID expiry when it has one (not the earliest kept)', () => {
  const sessionExpiry = NOW_S + 7776000;
  const result = selectSessionCookies(
    [
      { name: 'PHPSESSID', value: 'abc123', expires: sessionExpiry },
      { name: 'ozbuserhash', value: 'hash123', expires: NOW_S + 3600 },
    ],
    NOW,
  );
  assert.equal(result.expiresAt, new Date(sessionExpiry * 1000).toISOString());
});

test('expiresAt is the earliest kept expiry when PHPSESSID has none', () => {
  const result = selectSessionCookies(
    [
      { name: 'ozbuserhash', value: 'hash123', expires: NOW_S + 3600 },
      { name: 'other', value: 'x', expires: NOW_S + 7200 },
    ],
    NOW,
  );
  assert.equal(result.hasSession, false);
  assert.equal(result.expiresAt, new Date((NOW_S + 3600) * 1000).toISOString());
});

test('expiresAt is null when nothing kept has an expiry', () => {
  const result = selectSessionCookies(
    [
      { name: 'PHPSESSID', value: 'abc123', expires: -1 },
      { name: 'ozbuserhash', value: 'hash123' },
    ],
    NOW,
  );
  assert.equal(result.expiresAt, null);
});

test('the header preserves the given cookie order', () => {
  const result = selectSessionCookies(
    [
      { name: 'second', value: 'b', expires: -1 },
      { name: 'PHPSESSID', value: 'a', expires: -1 },
      { name: 'third', value: 'c' },
    ],
    NOW,
  );
  assert.equal(result.header, 'second=b; PHPSESSID=a; third=c');
});

test('hasSession is false when PHPSESSID is absent', () => {
  const result = selectSessionCookies([{ name: 'ozbuserhash', value: 'hash123' }], NOW);
  assert.equal(result.hasSession, false);
  assert.equal(result.header, 'ozbuserhash=hash123');
});

test('keptNames and droppedNames are names only — no value ever appears in them', () => {
  const result = selectSessionCookies(
    [
      { name: 'PHPSESSID', value: 'SECRET-VALUE-1', expires: -1 },
      { name: '_ga', value: 'SECRET-VALUE-2' },
    ],
    NOW,
  );
  const json = JSON.stringify({ keptNames: result.keptNames, droppedNames: result.droppedNames });
  assert.ok(!json.includes('SECRET-VALUE-1'), 'no kept value in the name lists');
  assert.ok(!json.includes('SECRET-VALUE-2'), 'no dropped value in the name lists');
});

test('the fixture server\'s success cookie set reduces to the session header', () => {
  // The exact set the fixture server sets on a successful login: the session
  // cookie (90 days), the hash, and the two trackers it plants alongside.
  const result = selectSessionCookies(
    [
      { name: 'PHPSESSID', value: 'fixture-session', expires: NOW_S + 7776000 },
      { name: 'ozbuserhash', value: 'fixture-ozbuserhash' },
      { name: '_ga', value: 'GA1.1.test', expires: NOW_S + 31536000 },
      { name: '__cf_bm', value: 'fixture-cf-bm', expires: NOW_S + 3600 },
    ],
    NOW,
  );
  assert.equal(result.hasSession, true);
  assert.equal(result.header, 'PHPSESSID=fixture-session; ozbuserhash=fixture-ozbuserhash');
  assert.deepEqual(result.droppedNames, ['_ga', '__cf_bm']);
});
