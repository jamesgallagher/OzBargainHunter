import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkBlockedError } from '../support/no-network.js';

test('the sentinel is set (guard is loaded)', () => {
  assert.equal(globalThis.__NETWORK_GUARD_SENTINEL__, 'no-network');
});

test('a fetch of https://www.ozbargain.com.au/deals/feed rejects with NetworkBlockedError', async () => {
  await assert.rejects(
    () => globalThis.fetch('https://www.ozbargain.com.au/deals/feed'),
    (err) => {
      assert.ok(err instanceof NetworkBlockedError, `expected NetworkBlockedError, got ${err.name}`);
      return true;
    },
  );
});

test('a 127.0.0.1 request is permitted (does not throw NetworkBlockedError)', async () => {
  // We expect the fetch to fail with a connection error (nothing listening),
  // but NOT with a NetworkBlockedError.
  try {
    await globalThis.fetch('http://127.0.0.1:1/');
    // If it somehow succeeded, that is fine too.
  } catch (err) {
    assert.ok(
      !(err instanceof NetworkBlockedError),
      `127.0.0.1 should be permitted, but got NetworkBlockedError: ${err.message}`,
    );
  }
});
