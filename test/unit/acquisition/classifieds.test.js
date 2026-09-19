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
