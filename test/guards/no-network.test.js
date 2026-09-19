import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

test('the guard blocks any non-loopback host, not just OzBargain (predicate, not a hard-coded URL)', async () => {
  // A host the suite never names must also be blocked — the predicate is
  // "is this loopback", so a narrowed *.ozbargain.com.au check would let
  // this through (ENOTFOUND) and this test would fail.
  await assert.rejects(
    () => globalThis.fetch('https://nonexistent-host.invalid/'),
    (err) => {
      assert.ok(err instanceof NetworkBlockedError, `expected NetworkBlockedError, got ${err.name}: ${err.message}`);
      return true;
    },
  );
});

test('a fetch of a URL object for a non-loopback host is blocked (URL input handled)', async () => {
  await assert.rejects(
    () => globalThis.fetch(new URL('https://www.ozbargain.com.au/deals/feed')),
    (err) => {
      assert.ok(err instanceof NetworkBlockedError, `expected NetworkBlockedError, got ${err.name}: ${err.message}`);
      return true;
    },
  );
});

test('http.request with an options object for a non-loopback host is blocked', async () => {
  await assert.rejects(
    new Promise((resolve, reject) => {
      const req = http.request({ hostname: 'nonexistent-host.invalid', port: 443, path: '/' }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    }),
    (err) => {
      assert.ok(err instanceof NetworkBlockedError, `expected NetworkBlockedError, got ${err.name}: ${err.message}`);
      return true;
    },
  );
});

test('a 127.0.0.1 request to a real server on an ephemeral port is permitted (returns 200)', async () => {
  // A real server on loopback: the carve-out that card 5's integration
  // tests depend on. We assert a 200, not merely "not a NetworkBlockedError".
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const response = await globalThis.fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a localhost request to a real server on an ephemeral port is permitted (returns 200)', async () => {
  // Bind with no host so the server listens on every interface: "localhost"
  // resolves to a single address family (IPv4 or IPv6) that may differ from
  // what fetch dials, so a host-pinned listen would ECONNREFUSED. Listening
  // on all interfaces makes the carve-out test address-family-agnostic.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await globalThis.fetch(`http://localhost:${port}/`);
    assert.equal(response.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
