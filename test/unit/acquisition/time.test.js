import { test } from 'node:test';
import assert from 'node:assert/strict';
import { melbourneToUtc, formatMelbourne, resolveRelativeAge, rfc822ToUtc } from '../../../lib/time.js';

// FIXTURE_NOW (2026-09-19T06:20:00Z) is 16:20 AEST (+10:00), so a 16:20
// wall time on 19 Sep 2026 is the AEST case.
test('melbourneToUtc: AEST (19 Sep 2026 16:20 -> 06:20Z)', () => {
  assert.equal(melbourneToUtc(19, 9, 2026, 16, 20), '2026-09-19T06:20:00Z');
});

test('melbourneToUtc: an absolute stamp 18/09/2026 18:23 AEST -> 08:23Z', () => {
  // Listing 975621's absolute stamp (fixtures/README.md section 1).
  assert.equal(melbourneToUtc(18, 9, 2026, 18, 23), '2026-09-18T08:23:00Z');
});

test('melbourneToUtc: the AEDT case (18 Jan 2023 09:33 AEDT -> 22:33Z the previous day)', () => {
  // Listing 751807, the pinned Freebie from January 2023 (raw stamp
  // "18/01/2023 - 09:33"). January is AEDT (+11:00), so a fixed +10:00
  // offset would get it wrong by an hour.
  assert.equal(melbourneToUtc(18, 1, 2023, 9, 33), '2023-01-17T22:33:00Z');
});

test('melbourneToUtc: a summer midnight edge (1 Jan 2023 00:30 AEDT -> 13:30Z 31 Dec 2022)', () => {
  // Crossing the date boundary under AEDT.
  assert.equal(melbourneToUtc(1, 1, 2023, 0, 30), '2022-12-31T13:30:00Z');
});

// `formatMelbourne` is the display-side counterpart: it shifts a stored UTC
// instant to the Melbourne wall clock. The exact date/time layout is
// locale-dependent, so the assertions check the wall-clock hour/minute (in
// either 12- or 24-hour form) rather than the full string.
test('formatMelbourne: shifts a UTC instant to the Melbourne wall time (AEST)', () => {
  // 2026-09-19T06:20:00Z is 16:20 AEST (+10:00) — 4:20 pm. The displayed
  // hour must be the Melbourne wall clock, not the UTC 06:20.
  assert.match(formatMelbourne('2026-09-19T06:20:00Z'), /4:20|16:20/);
});

test('formatMelbourne: is daylight-saving aware (AEDT)', () => {
  // 2023-01-17T22:33:00Z is 9:33 am AEDT (+11:00) on 18 Jan 2023. A fixed
  // +10:00 offset would render 8:33; the AEDT wall clock is 9:33.
  assert.match(formatMelbourne('2023-01-17T22:33:00Z'), /9:33/);
});

test('formatMelbourne: passes through the "never" sentinel verbatim', () => {
  assert.equal(formatMelbourne('never'), 'never');
});

test('formatMelbourne: passes through an empty value', () => {
  assert.equal(formatMelbourne(''), '');
});

test('formatMelbourne: passes through an unparseable value verbatim', () => {
  assert.equal(formatMelbourne('not a date'), 'not a date');
});

const NOW = '2026-09-19T06:20:00Z';

test('resolveRelativeAge: 1 hour 41 min ago', () => {
  assert.equal(resolveRelativeAge('1 hour 41 min ago', NOW), '2026-09-19T04:39:00Z');
});

test('resolveRelativeAge: 21 hours 38 min ago', () => {
  assert.equal(resolveRelativeAge('21 hours 38 min ago', NOW), '2026-09-18T08:42:00Z');
});

test('resolveRelativeAge: day and week forms', () => {
  assert.equal(resolveRelativeAge('2 days 3 hours ago', NOW), '2026-09-17T03:20:00Z');
  assert.equal(resolveRelativeAge('1 week 2 days ago', NOW), '2026-09-10T06:20:00Z');
});

test('resolveRelativeAge: without the trailing "ago"', () => {
  assert.equal(resolveRelativeAge('45 min', NOW), '2026-09-19T05:35:00Z');
});

test('rfc822ToUtc: the feed pubDate format (+1000)', () => {
  // 19 Sep 2026 17:25:16 +1000 -> 07:25:16Z.
  assert.equal(rfc822ToUtc('Sat, 19 Sep 2026 17:25:16 +1000'), '2026-09-19T07:25:16Z');
});

test('rfc822ToUtc: a negative offset', () => {
  // 19 Sep 2026 02:00:00 -0500 -> 07:00:00Z.
  assert.equal(rfc822ToUtc('Sat, 19 Sep 2026 02:00:00 -0500'), '2026-09-19T07:00:00Z');
});

test('rfc822ToUtc: rejects an unrecognised date', () => {
  assert.throws(() => rfc822ToUtc('not a date'));
});
