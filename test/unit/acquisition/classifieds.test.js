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
