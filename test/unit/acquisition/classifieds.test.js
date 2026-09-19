import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClassifiedsPoll } from '../../../lib/acquire/classifieds.js';
import { createFixtureTransport } from '../../support/fixtureTransport.js';
import { makeAcquisition } from '../../support/acquisition.js';

const URL = 'https://www.ozbargain.com.au/classified';

async function run(routes) {
  const transport = createFixtureTransport(routes);
  const { client, store, clock, close } = makeAcquisition({ transport });
  try {
    const result = await runClassifiedsPoll({ client, store, clock, log: () => {} });
    return { transport, result };
  } finally {
    close();
  }
}

test('valid: the authenticated page parses 25 listings and reports uid 226301', async () => {
  const { result } = await run({ [URL]: { status: 200, fixture: 'http/classifieds-page.html' } });
  assert.equal(result.state, 'valid');
  assert.equal(result.uid, 226301);
  assert.equal(result.listings.length, 25);
  assert.equal(result.alert, false);
  assert.equal(result.latched, false);
});

test('expired: the anon page (uid 0) latches off and raises an alert', async () => {
  const { result } = await run({ [URL]: { status: 200, fixture: 'http/derived/classifieds-page-anon.html' } });
  assert.equal(result.state, 'expired');
  assert.equal(result.uid, 0);
  assert.equal(result.listings.length, 0);
  assert.equal(result.alert, true);
  assert.equal(result.latched, true);
});

test('expired: the application permission-denial page (403, cls403.html)', async () => {
  const { result } = await run({ [URL]: { status: 403, fixture: 'http/cls403.html' } });
  assert.equal(result.state, 'expired');
  assert.equal(result.alert, true);
  assert.equal(result.latched, true);
});

test('cloudflare_block: the 17-byte body at 403 stops all requests', async () => {
  const { result } = await run({ [URL]: { status: 403, fixture: 'http/derived/cloudflare-1010.txt' } });
  assert.equal(result.state, 'cloudflare_block');
  assert.equal(result.alert, true);
  assert.equal(result.latched, true);
});

// --- Review round-1 required tests: the non-200 classes must not latch ---

test('304 after a valid 200: the session is resolved from the persisted uid and never latches', async () => {
  const transport1 = createFixtureTransport({ [URL]: { status: 200, fixture: 'http/classifieds-page.html' } });
  const { client: c1, store, clock, close } = makeAcquisition({ transport: transport1 });
  const r1 = await runClassifiedsPoll({ client: c1, store, clock, log: () => {} });
  assert.equal(r1.state, 'valid');
  assert.equal(r1.uid, 226301);
  await clock.advance(5 * 60 * 1000);
  const transport2 = createFixtureTransport({ [URL]: { status: 304, fixture: 'http/classifieds-page.html' } });
  const { client: c2 } = makeAcquisition({ transport: transport2 });
  // The 304 has an empty body; the session is resolved from the last known
  // uid (persisted by the 200). It stays valid and never latches.
  const r2 = await runClassifiedsPoll({ client: c2, store, clock, log: () => {} });
  try {
    assert.equal(r2.state, 'valid');
    assert.equal(r2.uid, 226301);
    assert.equal(r2.alert, false);
    assert.equal(r2.latched, false);
  } finally {
    close();
  }
});

test('500 (transient): the session is unknown, never latches, never alerts', async () => {
  const { result } = await run({ [URL]: { status: 500, body: 'server error' } });
  assert.equal(result.state, 'unknown');
  assert.equal(result.alert, false);
  assert.equal(result.latched, false);
});

test('429 (rate_limited): the session is unknown, never latches, never alerts', async () => {
  const { result } = await run({ [URL]: { status: 429, body: 'slow down' } });
  assert.equal(result.state, 'unknown');
  assert.equal(result.alert, false);
  assert.equal(result.latched, false);
});

// --- Review round-2 required tests ---

test('Minor 1: an expired 200 (uid 0) invalidates the persisted uid, so a later 304 resolves to expired, not valid', async () => {
  const transport1 = createFixtureTransport({ [URL]: { status: 200, fixture: 'http/classifieds-page.html' } });
  const { client: c1, store, clock, close } = makeAcquisition({ transport: transport1 });
  const r1 = await runClassifiedsPoll({ client: c1, store, clock, log: () => {} });
  assert.equal(r1.state, 'valid');
  assert.equal(r1.uid, 226301);
  await clock.advance(5 * 60 * 1000);
  // The session expires: the anon page (uid 0) latches off and must
  // invalidate the persisted last uid (round-2 Minor 1).
  const transport2 = createFixtureTransport({ [URL]: { status: 200, fixture: 'http/derived/classifieds-page-anon.html' } });
  const { client: c2 } = makeAcquisition({ transport: transport2 });
  const r2 = await runClassifiedsPoll({ client: c2, store, clock, log: () => {} });
  assert.equal(r2.state, 'expired');
  await clock.advance(5 * 60 * 1000);
  // A 304 after the expiry must resolve to expired (the persisted uid was
  // invalidated to 0), not valid from a stale value.
  const transport3 = createFixtureTransport({ [URL]: { status: 304, fixture: 'http/classifieds-page.html' } });
  const { client: c3 } = makeAcquisition({ transport: transport3 });
  const r3 = await runClassifiedsPoll({ client: c3, store, clock, log: () => {} });
  try {
    assert.equal(r3.state, 'expired');
    assert.equal(r3.latched, false);
  } finally {
    close();
  }
});

test('Minor 2: a 304 on a cold store (no last uid known) resolves to unchanged, not expired', async () => {
  const { result } = await run({ [URL]: { status: 304, fixture: 'http/classifieds-page.html' } });
  // The round-2 bug resolved a cold-store 304 to expired (it parsed the
  // missing setting as 0); it must be unchanged so the caller keeps its
  // previous state.
  assert.equal(result.state, 'unchanged');
  assert.equal(result.alert, false);
  assert.equal(result.latched, false);
});

// --- Review round-3 follow-up (t_f80dae1b): a corrupt last-uid setting ---

test('a corrupt (non-numeric) classifieds_last_uid setting on a 304 resolves to unchanged, not valid', async () => {
  // A corrupt setting (e.g. a stray non-numeric string) would otherwise parse
  // to NaN and, without the guard, read a dead session as `valid` on a later
  // 304. The read treats a non-numeric setting as "no last uid known", so the
  // 304 resolves to `unchanged` (the caller keeps its previous state).
  const transport = createFixtureTransport({ [URL]: { status: 304, fixture: 'http/classifieds-page.html' } });
  const { client, store, clock, close } = makeAcquisition({ transport });
  store.setSetting('classifieds_last_uid', 'corrupt-not-a-number');
  const result = await runClassifiedsPoll({ client, store, clock, log: () => {} });
  try {
    assert.equal(result.state, 'unchanged');
    assert.equal(result.uid, 0);
    assert.equal(result.alert, false);
    assert.equal(result.latched, false);
  } finally {
    close();
  }
});
