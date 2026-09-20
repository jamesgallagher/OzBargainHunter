import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
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

test('http.request with an options object for a loopback host is permitted over a real server (positive direction)', async () => {
  // Positive-direction loopback assertion for the options-object branch of
  // wrapRequest: a self-consistent { hostname: '127.0.0.1' } must reach a
  // real server. If the options-object branch were dropped, this would throw
  // NetworkBlockedError and the suite would say nothing (round-1's own
  // repro then fails silently).
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a [::1] request over real IPv6 to a real server is permitted (returns 200)', async (t) => {
  // Positive-direction loopback assertion for the IPv6 bracket strip:
  // "[::1]" normalises to "::1", which is an allowed host, so a real
  // IPv6 server on loopback must be reachable. Skipped if the host has no
  // IPv6 loopback (the carve-out is address-family-agnostic).
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok6');
  });
  const listening = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '::1', resolve);
  }).catch((err) => {
    // No IPv6 loopback on this host: server.listen(0, '::1') rejects with
    // EADDRNOTAVAIL. Skip rather than fail (the carve-out is
    // address-family-agnostic).
    server.removeAllListeners('error');
    return { skipped: true, reason: err?.code ?? 'EADDRNOTAVAIL' };
  });
  if (listening?.skipped) {
    t.skip(`no IPv6 loopback (${listening.reason})`);
    return;
  }
  const { port } = server.address();

  try {
    const response = await globalThis.fetch(`http://[::1]:${port}/`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok6');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a self-contradictory options object is blocked in BOTH directions (fail-closed)', async () => {
  // The guard must block if ANY present candidate (hostname, host, and the
  // port-form's second positional argument) normalises to a non-loopback
  // host. node's net/tls dial `host` when both are present, so trusting
  // `hostname` first would fail open on { hostname: loopback, host: LAN }.
  // The mirror { hostname: LAN, host: loopback } must also be blocked
  // (hostname is present and non-loopback). We use a non-loopback host the
  // suite never names so the predicate (not a hard-coded URL) is what blocks.
  const LAN = '172.17.0.5'; // a non-loopback IPv4 literal; any non-loopback works

  // Direction 1: hostname is loopback, host is non-loopback (node dials host).
  await assert.rejects(
    new Promise((resolve, reject) => {
      const req = net.connect({ hostname: '127.0.0.1', host: LAN, port: 1 });
      req.on('error', reject);
      req.on('connect', resolve);
    }),
    (err) => {
      assert.ok(err instanceof NetworkBlockedError, `expected NetworkBlockedError, got ${err.name}: ${err.message}`);
      return true;
    },
  );

  // Direction 2 (mirror): hostname is non-loopback, host is loopback.
  await assert.rejects(
    new Promise((resolve, reject) => {
      const req = net.connect({ hostname: LAN, host: '127.0.0.1', port: 1 });
      req.on('error', reject);
      req.on('connect', resolve);
    }),
    (err) => {
      assert.ok(err instanceof NetworkBlockedError, `expected NetworkBlockedError, got ${err.name}: ${err.message}`);
      return true;
    },
  );
});

test('a direct Socket.prototype.connect(port, host) for a non-loopback host is blocked (port-form candidate)', async (t) => {
  // node normalises the net.connect(port, host) / createConnection forms into
  // an options object, so only the DIRECT Socket.prototype.connect(port, host)
  // shape relies on the guard's port-form branch (the host is the second
  // positional argument, args[1]). Without that branch, this call dials
  // (ECONNREFUSED) instead of blocking. A real ephemeral port is used so the
  // loopback control actually connects; the non-loopback address is read from
  // os.networkInterfaces() (not hard-coded). Skipped if the host has no
  // non-loopback IPv4 (a loopback-only sandbox has no non-loopback address to
  // dial, so the test cannot run — the same environment-dependency the IPv6
  // test handles nine lines above).
  const interfaces = os.networkInterfaces();
  let nonLoopback = null;
  for (const name of Object.keys(interfaces)) {
    for (const entry of interfaces[name] ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        nonLoopback = entry.address;
        break;
      }
    }
    if (nonLoopback) break;
  }
  if (!nonLoopback) {
    t.skip('no non-loopback IPv4');
    return;
  }

  const server = net.createServer((s) => s.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    // Control: the matching loopback port-form dials.
    await new Promise((resolve, reject) => {
      const s = new net.Socket();
      s.on('error', reject);
      s.on('connect', () => { s.destroy(); resolve(); });
      s.connect(port, '127.0.0.1');
    });

    // The non-loopback port-form must be blocked (not dialled).
    await assert.rejects(
      new Promise((resolve, reject) => {
        const s = new net.Socket();
        s.on('error', reject);
        s.on('connect', () => { s.destroy(); resolve(); });
        s.connect(port, nonLoopback);
      }),
      (err) => {
        assert.ok(err instanceof NetworkBlockedError, `expected NetworkBlockedError, got ${err.name}: ${err.message}`);
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a direct Socket.prototype.connect(port, host, cb) for a non-loopback host is blocked (3-arg port-form candidate)', async () => {
  // The 3-positional-argument port form: s.connect(port, host, cb). node
  // normalises this into an options object for the underlying dial, but the
  // DIRECT Socket.prototype.connect shape relies on the guard's port-form
  // branch reading the second positional argument (args[1]) as the host; the
  // third argument is the connect callback.
  //
  // The guard throws inside the wrapper BEFORE originalConnect.apply, so the
  // non-loopback address is never dialled and need not be routable — a
  // reserved literal (203.0.113.9, TEST-NET-2) satisfies the block assertion
  // on any host, including a loopback-only sandbox. No skip is needed for the
  // block direction. The real ephemeral server is still required for the
  // 127.0.0.1 control (the 3-arg loopback form must actually connect).
  const server = net.createServer((s) => s.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    // Control: the matching loopback 3-arg port-form dials.
    await new Promise((resolve, reject) => {
      const s = new net.Socket();
      s.on('error', reject);
      s.on('connect', () => { s.destroy(); resolve(); });
      s.connect(port, '127.0.0.1', () => { /* connect callback */ });
    });

    // The non-loopback 3-arg port-form must be blocked (not dialled).
    await assert.rejects(
      new Promise((resolve, reject) => {
        const s = new net.Socket();
        s.on('error', reject);
        s.on('connect', () => { s.destroy(); resolve(); });
        s.connect(port, '203.0.113.9', () => { /* connect callback */ });
      }),
      (err) => {
        assert.ok(err instanceof NetworkBlockedError, `expected NetworkBlockedError, got ${err.name}: ${err.message}`);
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a dns.lookup of a non-loopback host is blocked (dns.lookup wrapper pinned)', () => {
  // The guard's fifth wrapped shape: dns.lookup. The wrapper throws
  // NetworkBlockedError synchronously (BEFORE originalLookup is called), so a
  // non-loopback hostname never reaches the resolver. We assert the sync throw
  // (assert.throws, not assert.rejects): the wrapper runs the host check before
  // invoking the original, so the rejection is a thrown error at the call site.
  // A reserved literal (203.0.113.9, TEST-NET-2) need not be routable — the
  // wrapper blocks before any dial — so no skip is needed for the block
  // direction.
  assert.throws(
    () => dns.lookup('203.0.113.9', () => {}),
    (err) => {
      assert.ok(err instanceof NetworkBlockedError, `expected NetworkBlockedError, got ${err.name}: ${err.message}`);
      return true;
    },
  );
});

test('a dns.lookup of 127.0.0.1 is permitted (real loopback lookup, positive direction)', async () => {
  // Positive-direction loopback control for the dns.lookup wrapper: a real
  // loopback lookup must resolve (not throw NetworkBlockedError). If the
  // wrapper were deleted, this control would still pass (the original lookup
  // resolves 127.0.0.1) — so the control is what the block test's kill proof
  // relies on: deleting the wrapper lets the non-loopback block test through
  // (it resolves instead of throwing), while this control is unaffected.
  const { address } = await new Promise((resolve, reject) => {
    dns.lookup('127.0.0.1', (err, addr) => (err ? reject(err) : resolve({ address: addr })));
  });
  assert.equal(address, '127.0.0.1');
});

test('a fetch of a Request object for a non-loopback host is blocked (Request input handled)', async () => {
  // The fetch wrapper's Request-object branch: `input.url ?? input.href ??
  // String(input)`. The shipped `new URL(...)` shape is tested above; this pins
  // the `new Request(...)` shape. A Request exposes .url (not .href), so the
  // wrapper must read input.url to resolve the host. If the Request branch were
  // dropped, String(new Request(...)) is "[object Request]" — hostFromUrl
  // returns null — and the guard would block even loopback Requests (fail-
  // closed). So the block direction is pinned here, and the loopback control
  // below is the kill proof: dropping the branch makes the control fail.
  await assert.rejects(
    () => globalThis.fetch(new Request('https://www.ozbargain.com.au/deals/feed')),
    (err) => {
      assert.ok(err instanceof NetworkBlockedError, `expected NetworkBlockedError, got ${err.name}: ${err.message}`);
      return true;
    },
  );
});

test('a fetch of a Request object for a loopback host is permitted over a real server (positive direction)', async () => {
  // Positive-direction loopback control for the fetch Request branch: a real
  // Request for 127.0.0.1 must reach a real server. This is the kill proof for
  // the Request branch — if `input.url ?? input.href ??` were dropped,
  // String(new Request(...)) is "[object Request]", hostFromUrl returns null,
  // and the guard would throw NetworkBlockedError here (fail-closed), so this
  // test would fail while the non-loopback block test still passes.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const response = await globalThis.fetch(new Request(`http://127.0.0.1:${port}/`));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
