import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deadManState } from '../../../lib/acquire/deadman.js';

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
