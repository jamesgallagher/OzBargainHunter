import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  readAttempts,
  writeAttempts,
  checkLoginAllowed,
  loginLockView,
} from '../../../lib/web/login-throttle.js';

// A fixed "now" (2026-09-19T07:30:00Z) and a helper that builds an attempt
// entry `secondsAgo` before `now`. The functions are pure, so every
// boundary is pinned without sleeping (prompt 7).
const NOW = new Date('2026-09-19T07:30:00.000Z');
const NOW_MS = NOW.getTime();
const MIN = 60 * 1000;
const H = 60 * MIN;

function entry(secondsAgo, outcome = 'bad_credentials') {
  return { at: new Date(NOW_MS - secondsAgo * 1000).toISOString(), outcome };
}

describe('readAttempts: degrades to [] (or drops malformed entries), never throws', () => {
  test('null, undefined, a non-string scalar, and a non-array JSON value all read as []', () => {
    assert.deepEqual(readAttempts(null), []);
    assert.deepEqual(readAttempts(undefined), []);
    assert.deepEqual(readAttempts(42), []);
    assert.deepEqual(readAttempts('{"not":"an array"}'), []);
  });

  test('an unparsable string reads as []', () => {
    assert.deepEqual(readAttempts('not json at all'), []);
  });

  test('malformed entries are dropped, valid ones survive', () => {
    const raw = JSON.stringify([
      entry(10, 'pending'),
      { at: 'not-a-date', outcome: 'pending' },
      { at: entry(20).at, outcome: 42 },
      null,
      'just a string',
      entry(30, 'bad_credentials'),
    ]);
    const read = readAttempts(raw);
    assert.equal(read.length, 2);
    assert.deepEqual(read[0], entry(10, 'pending'));
    assert.deepEqual(read[1], entry(30, 'bad_credentials'));
  });
});

describe('writeAttempts: prunes strictly older than 24 hours, sorts oldest first', () => {
  test('an entry exactly 24 hours old is kept; strictly older is pruned', () => {
    const list = [
      entry(31 * 60), // 31 minutes ago
      { at: new Date(NOW_MS - 24 * H).toISOString(), outcome: 'bad_credentials' }, // exactly 24h
      { at: new Date(NOW_MS - 24 * H - 1000).toISOString(), outcome: 'bad_credentials' }, // 24h + 1s
    ];
    const written = JSON.parse(writeAttempts(list, NOW));
    assert.equal(written.length, 2);
    assert.equal(written[0].at, list[1].at, 'the exactly-24h-old entry survives');
  });

  test('the output is sorted oldest first', () => {
    const list = [entry(10), entry(100), entry(50)];
    const written = JSON.parse(writeAttempts(list, NOW));
    assert.deepEqual(
      written.map((e) => e.at),
      [entry(100).at, entry(50).at, entry(10).at],
    );
  });
});

describe('checkLoginAllowed: the short-term 30-second gap', () => {
  test('a most-recent attempt 29 seconds old is throttled; retryAt is last + 30s', () => {
    const verdict = checkLoginAllowed([entry(29)], NOW);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'throttled');
    assert.equal(verdict.retryAt, new Date(NOW_MS - 29 * 1000 + 30 * 1000).toISOString());
  });

  test('a most-recent attempt exactly 30 seconds old is allowed (the gap is strict)', () => {
    assert.deepEqual(checkLoginAllowed([entry(30)], NOW), { ok: true });
  });
});

describe('checkLoginAllowed: the 15-minute window', () => {
  test('two attempts in the last 15 minutes are allowed; three refuse', () => {
    assert.deepEqual(checkLoginAllowed([entry(100), entry(200)], NOW), { ok: true });
    const verdict = checkLoginAllowed([entry(100), entry(200), entry(300)], NOW);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'throttled');
    assert.equal(verdict.retryAt, new Date(NOW_MS - 300 * 1000 + 15 * MIN).toISOString());
  });

  test('an attempt exactly 15 minutes old is not in the window', () => {
    assert.deepEqual(checkLoginAllowed([entry(900), entry(900), entry(15 * 60)], NOW), { ok: true });
  });

  test('the 30-second rule wins over the 15-minute rule when both apply', () => {
    const verdict = checkLoginAllowed([entry(1000), entry(2000), entry(3000), entry(10)], NOW);
    assert.equal(verdict.reason, 'throttled');
    assert.equal(verdict.retryAt, new Date(NOW_MS - 10 * 1000 + 30 * 1000).toISOString());
  });
});

describe('checkLoginAllowed: the B6 lock (outranks the throttle)', () => {
  test('one validation_error in 24 hours is allowed; two lock', () => {
    assert.deepEqual(checkLoginAllowed([entry(1000, 'validation_error')], NOW), { ok: true });
    const verdict = checkLoginAllowed([entry(1000, 'validation_error'), entry(2000, 'validation_error')], NOW);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'locked');
    // The lock lasts until the threshold-reaching attempt + 24h.
    assert.equal(verdict.retryAt, new Date(NOW_MS - 1000 * 1000 + 24 * H).toISOString());
  });

  test('four bad_credentials in 24 hours is allowed; five locks', () => {
    assert.deepEqual(checkLoginAllowed([entry(1000), entry(2000), entry(3000), entry(4000)], NOW), { ok: true });
    const verdict = checkLoginAllowed([entry(1000), entry(2000), entry(3000), entry(4000), entry(5000)], NOW);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'locked');
    assert.equal(verdict.retryAt, new Date(NOW_MS - 1000 * 1000 + 24 * H).toISOString());
  });

  test('two attempts exactly 24 hours apart are not in the same span', () => {
    // 24h + 1s before now, so the recent attempt (1000s before now) sits
    // exactly 24h from it: the end-exclusive span excludes it.
    const far = { at: new Date(NOW_MS - 24 * H - 1000 * 1000).toISOString(), outcome: 'validation_error' };
    assert.deepEqual(checkLoginAllowed([far, entry(1000, 'validation_error')], NOW), { ok: true });
  });

  test('B6 outranks the throttle: a locked verdict wins over a fresh attempt', () => {
    const verdict = checkLoginAllowed(
      [entry(1000, 'validation_error'), entry(2000, 'validation_error'), entry(10)],
      NOW,
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'locked');
  });

  test('pending (and other outcomes) count for the throttle but not for B6', () => {
    const verdict = checkLoginAllowed(
      [entry(100, 'pending'), entry(200, 'pending'), entry(300, 'pending')],
      NOW,
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'throttled', 'three pending attempts hit the 15-minute rule');
    assert.deepEqual(
      checkLoginAllowed([entry(100, 'pending'), entry(200, 'pending')], NOW),
      { ok: true },
      'pending never triggers B6',
    );
  });

  test('the lock expires at the threshold-reaching attempt + 24h', () => {
    // The second validation_error was 25h ago: its +24h end is 1h ago.
    const first = { at: new Date(NOW_MS - 26 * H).toISOString(), outcome: 'validation_error' };
    const second = { at: new Date(NOW_MS - 25 * H).toISOString(), outcome: 'validation_error' };
    assert.deepEqual(checkLoginAllowed([first, second], NOW), { ok: true });
  });
});

describe('loginLockView: the UI projection', () => {
  test('a B6-locked view reports locked with the lock end; the throttle is independent', () => {
    const view = loginLockView(
      [entry(1000, 'validation_error'), entry(2000, 'validation_error')],
      NOW,
    );
    assert.equal(view.locked, true);
    assert.equal(view.lockedUntil, new Date(NOW_MS - 1000 * 1000 + 24 * H).toISOString());
    assert.equal(view.throttledUntil, null, 'the 30s/15min rules are not in effect here');
  });

  test('a throttled view reports throttledUntil without a lock', () => {
    const view = loginLockView([entry(10)], NOW);
    assert.equal(view.locked, false);
    assert.equal(view.lockedUntil, null, 'no lock even if a candidate existed and expired');
    assert.equal(view.throttledUntil, new Date(NOW_MS - 10 * 1000 + 30 * 1000).toISOString());
  });

  test('an idle view is all clear', () => {
    assert.deepEqual(loginLockView([], NOW), { locked: false, lockedUntil: null, throttledUntil: null });
  });
});
