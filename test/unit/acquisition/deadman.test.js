import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deadManState } from '../../../lib/acquire/deadman.js';
import { openStore } from '../../../lib/store/index.js';
import { fixedClock } from '../../../lib/clock.js';

const SUCCESS = '2026-09-19T07:00:00Z';

// The first notification is due once 30 minutes have passed since the last
// success (and none has been sent yet).
test('due at 30 minutes, not due at 29', () => {
  assert.equal(deadManState({ lastSuccessAt: SUCCESS, now: '2026-09-19T07:30:00Z', lastNotificationAt: null }).due, true);
  assert.equal(deadManState({ lastSuccessAt: SUCCESS, now: '2026-09-19T07:29:00Z', lastNotificationAt: null }).due, false);
});

test('the first notification is the 30min step', () => {
  const r = deadManState({ lastSuccessAt: SUCCESS, now: '2026-09-19T08:00:00Z', lastNotificationAt: null });
  assert.equal(r.due, true);
  assert.equal(r.step, '30min');
});

// After the 30-minute one has been sent, the next is due 2 hours after it.
test('then the 2-hour step, measured from the last notification', () => {
  const lastNotif = '2026-09-19T07:30:00Z'; // the 30min one, sent at +30min
  assert.equal(deadManState({ lastSuccessAt: SUCCESS, now: '2026-09-19T09:30:00Z', lastNotificationAt: lastNotif, step: '30min' }).due, true);
  assert.equal(deadManState({ lastSuccessAt: SUCCESS, now: '2026-09-19T09:29:00Z', lastNotificationAt: lastNotif, step: '30min' }).due, false);
});

test('then the 6-hour step', () => {
  const lastNotif = '2026-09-19T09:30:00Z'; // the 2h one
  assert.equal(deadManState({ lastSuccessAt: SUCCESS, now: '2026-09-19T15:30:00Z', lastNotificationAt: lastNotif, step: '2h' }).due, true);
  assert.equal(deadManState({ lastSuccessAt: SUCCESS, now: '2026-09-19T15:29:00Z', lastNotificationAt: lastNotif, step: '2h' }).due, false);
});

test('then the daily step, and it repeats daily', () => {
  const lastNotif = '2026-09-19T15:30:00Z'; // the 6h one
  assert.equal(deadManState({ lastSuccessAt: SUCCESS, now: '2026-09-20T15:30:00Z', lastNotificationAt: lastNotif, step: '6h' }).due, true);
  assert.equal(deadManState({ lastSuccessAt: SUCCESS, now: '2026-09-20T15:29:00Z', lastNotificationAt: lastNotif, step: '6h' }).due, false);
  // A daily notification, once sent, repeats every 24 hours.
  const dailyNotif = '2026-09-20T15:30:00Z';
  assert.equal(deadManState({ lastSuccessAt: SUCCESS, now: '2026-09-21T15:30:00Z', lastNotificationAt: dailyNotif, step: 'daily' }).due, true);
  assert.equal(deadManState({ lastSuccessAt: SUCCESS, now: '2026-09-21T15:29:00Z', lastNotificationAt: dailyNotif, step: 'daily' }).due, false);
});

test('not due before the 30-minute mark, even with a prior notification', () => {
  // A prior notification 1 hour ago on the 2h step: not yet due.
  assert.equal(deadManState({ lastSuccessAt: SUCCESS, now: '2026-09-19T08:30:00Z', lastNotificationAt: '2026-09-19T07:30:00Z', step: '30min' }).due, false);
});

// Minor 10: a recovered poller must not read as due. If a successful poll
// lands after the last notification, the dead-man resets — the next
// notification is not due regardless of how long it has been since the last one.
test('a recovery after the last notification resets the dead-man (not due)', () => {
  // A notification was sent at 06:04 (30min step). A successful poll landed at
  // 08:04 — after it. Even a full 2-hour interval has now passed since the
  // notification, but the poller is healthy, so nothing is due.
  const r = deadManState({
    lastSuccessAt: '2026-09-19T08:04:00Z',
    now: '2026-09-19T08:05:00Z',
    lastNotificationAt: '2026-09-19T06:04:00Z',
    step: '30min',
  });
  assert.equal(r.due, false);
  assert.equal(r.step, 'none');
});

test('a recovery does not suppress a still-failing window', () => {
  // The last success (07:00) is *before* the last notification (08:04), so the
  // poller is still failing; the 2-hour interval has passed, so it is due.
  assert.equal(
    deadManState({
      lastSuccessAt: '2026-09-19T07:00:00Z',
      now: '2026-09-19T10:05:00Z',
      lastNotificationAt: '2026-09-19T08:04:00Z',
      step: '30min',
    }).due,
    true,
  );
});

test('a null lastSuccessAt (never succeeded) is due immediately', () => {
  const r = deadManState({ lastSuccessAt: null, now: '2026-09-19T08:00:00Z', lastNotificationAt: null });
  assert.equal(r.due, true);
  assert.equal(r.step, '30min');
});

// Review round-1 required test: the retained failure body is truncated at the
// byte boundary (design 3.7) so a sustained failure mode cannot grow the
// `failures` table without bound.
test('a failure body larger than the cap is truncated at the byte cap (8192) without splitting a codepoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-trunc-'));
  const clock = fixedClock('2026-09-19T07:30:00Z');
  const store = openStore({ path: join(dir, 'test.db'), clock });
  try {
    // A body whose byte 8192 lands *inside* a 3-byte UTF-8 sequence: 8190
    // ASCII 'x' (bytes 0-8189) then one '中' (bytes 8190-8192, E4 B8 AD).
    // Total 8193 bytes, so the truncation path fires. A naive
    // subarray(0, 8192).toString() would decode the dangling partial
    // sequence (E4 B8) as U+FFFD; the fix must trim it back to a valid
    // UTF-8 prefix.
    const big = 'x'.repeat(8190) + '中';
    store.insertFailure({ failed_at: '2026-09-19T07:30:00Z', response_class: 'transient', body: big });
    const row = store.getFailures()[0];
    // Truncated to at most the byte cap (the trailing codepoint is dropped,
    // so the result is 8190 bytes, not 8192).
    assert.ok(Buffer.byteLength(row.body, 'utf8') <= 8192);
    // The retained body is a prefix of the original (no reordering).
    assert.ok(row.body.startsWith('x'.repeat(8180)));
    // A multi-byte codepoint is never split mid-sequence: no U+FFFD is
    // introduced, and the stored body is valid UTF-8 (round-trips through
    // Buffer without replacement).
    assert.ok(!row.body.includes('\uFFFD'));
    assert.equal(Buffer.from(row.body, 'utf8').toString('utf8'), row.body);
    // The straddling '中' was dropped whole, not half-decoded: the body is
    // exactly the 8190 ASCII prefix.
    assert.equal(row.body, 'x'.repeat(8190));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
