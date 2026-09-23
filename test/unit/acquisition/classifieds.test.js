import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    assert.equal(r3.latched, true);
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

// --- Review round-2 M1: the screen-9 cookie setting has a consumer ---

test('M1: the stored account cookie (screen 9) is sent on the classifieds request (writer → transport header)', async () => {
  // M1: the screen-9 route writes `ozb_account_cookie`; this test proves the
  // classifieds poll is the consumer — the stored cookie is sent on the request
  // as a `Cookie` header, so a fresh cookie actually carries the session.
  const transport = createFixtureTransport({ [URL]: { status: 200, fixture: 'http/classifieds-page.html' } });
  const { client, store, clock, close } = makeAcquisition({ transport });
  store.deleteSetting('ozb_account_cookie');
  store.setSetting('ozb_account_cookie', 'session=abc123; uid=226301');
  const result = await runClassifiedsPoll({ client, store, clock, log: () => {} });
  try {
    assert.equal(result.state, 'valid');
    // The transport received exactly one request; its options carry the
    // `Cookie` header the client built from the stored cookie.
    assert.equal(transport.requestLog.length, 1);
    const headers = transport.requestLog[0].options.headers ?? {};
    assert.equal(headers.cookie, 'session=abc123; uid=226301');
  } finally {
    close();
  }
});

test('M1: with no stored cookie, the env value (OZB_ACCOUNT_COOKIE) is the fallback sent on the request', async () => {
  // M1: when the screen-9 setting is absent, the env value is the fallback.
  const transport = createFixtureTransport({ [URL]: { status: 200, fixture: 'http/classifieds-page.html' } });
  const { client, store, clock, close } = makeAcquisition({ transport });
  store.deleteSetting('ozb_account_cookie');
  const result = await runClassifiedsPoll({
    client,
    store,
    clock,
    config: { OZB_ACCOUNT_COOKIE: 'env-cookie=xyz' },
    log: () => {},
  });
  try {
    assert.equal(result.state, 'valid');
    assert.equal(transport.requestLog.length, 1);
    const headers = transport.requestLog[0].options.headers ?? {};
    assert.equal(headers.cookie, 'env-cookie=xyz');
  } finally {
    close();
  }
});

test('with neither a stored cookie nor the env value, classifieds is skipped without a request', async () => {
  // With no session configured, do not make an anonymous request to the site.
  const transport = createFixtureTransport({ [URL]: { status: 200, fixture: 'http/classifieds-page.html' } });
  const { client, store, clock, close } = makeAcquisition({ transport, config: { OZB_ACCOUNT_COOKIE: '' } });
  store.deleteSetting('ozb_account_cookie');
  const result = await runClassifiedsPoll({ client, store, clock, log: () => {} });
  try {
    assert.equal(result.state, 'not_configured');
    assert.equal(transport.requestLog.length, 0);
  } finally {
    close();
  }
});

test('an expired session is not retried until a fresh cookie is set', async () => {
  const transport = createFixtureTransport({ [URL]: { status: 403, fixture: 'http/cls403.html' } });
  const { client, store, clock, close } = makeAcquisition({ transport });
  try {
    const first = await runClassifiedsPoll({ client, store, clock, log: () => {} });
    const second = await runClassifiedsPoll({ client, store, clock, log: () => {} });
    assert.equal(first.state, 'expired');
    assert.equal(second.state, 'expired');
    assert.equal(transport.requestLog.length, 1, 'the expired session is only checked once');
  } finally {
    close();
  }
});

// --- Safe-failure: unparseable 200 bodies resolve unknown, never expired ---
// The malformed bodies are derived (or minimal synthetic) so the corpus in
// fixtures/http is never edited.

function runCapturing(routes, config = {}) {
  const transport = createFixtureTransport(routes);
  const { client, store, clock, close } = makeAcquisition({ transport, config });
  const logLines = [];
  return {
    transport,
    store,
    clock,
    close,
    run: () => runClassifiedsPoll({ client, store, clock, config, log: (line) => logLines.push(line) }),
    logLines,
  };
}

test('safe-failure: a truncated 200 resolves unknown (never expired), writes one unparseable failures row with the raw body, and logs the URL, class and parser reason', async () => {
  const full = readFileSync(new globalThis.URL('../../../fixtures/http/classifieds-page.html', import.meta.url), 'utf8');
  // Cut off the first 4000 chars: the head (with OzB_vars) is kept and the
  // closing </html> is not — the exact shape of a stream that died mid-body.
  // 4000 chars is under the store's 8KB failure-body cap, so the whole body
  // is stored and can be asserted for equality.
  const truncated = full.slice(0, 4000);
  const { run, store, logLines, close } = runCapturing({ [URL]: { status: 200, body: truncated } });
  try {
    const result = await run();
    assert.equal(result.state, 'unknown');
    assert.equal(result.uid, 0);
    assert.deepEqual(result.listings, []);
    assert.equal(result.alert, false);
    assert.equal(result.latched, false);
    // Exactly one failures row, classed unparseable, carrying the raw body.
    const failures = store.getFailures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].response_class, 'unparseable');
    assert.equal(failures[0].body, truncated);
    // The log names the URL, the class and the parser reason.
    const line = logLines.find((l) => l.includes('unparseable'));
    assert.ok(line, 'an unparseable log line must be written');
    assert.ok(line.includes(URL), 'the log must name the URL');
    assert.ok(line.includes('missing closing </html> terminator'), 'the log must carry the parser reason');
    // No session state was written or cleared.
    assert.equal(store.getSetting('classifieds_last_uid'), null);
    assert.equal(store.getSetting('classifieds_last_confirmed_at'), null);
  } finally {
    close();
  }
});

test('safe-failure: an empty 200 resolves unknown, not expired', async () => {
  const { run, store, close } = runCapturing({ [URL]: { status: 200, body: '' } });
  try {
    const result = await run();
    assert.equal(result.state, 'unknown');
    assert.equal(result.uid, 0);
    assert.equal(result.alert, false);
    assert.equal(result.latched, false);
    assert.equal(store.getFailures().length, 1);
    assert.equal(store.getFailures()[0].response_class, 'unparseable');
  } finally {
    close();
  }
});

test('safe-failure: a whitespace-only 200 resolves unknown, not expired', async () => {
  const ws = [' ', ' ', '\n', '\t', ' ', ' '].join('');
  const { run, close } = runCapturing({ [URL]: { status: 200, body: ws } });
  try {
    const result = await run();
    assert.equal(result.state, 'unknown');
    assert.equal(result.alert, false);
    assert.equal(result.latched, false);
  } finally {
    close();
  }
});

test('safe-failure: a JSON (non-HTML) 200 resolves unknown, not expired', async () => {
  const json = JSON.stringify({ error: 'rate limited', retry: 60 });
  const { run, store, close } = runCapturing({ [URL]: { status: 200, body: json } });
  try {
    const result = await run();
    assert.equal(result.state, 'unknown');
    assert.equal(result.uid, 0);
    assert.equal(result.alert, false);
    assert.equal(result.latched, false);
    assert.equal(store.getFailures().length, 1);
    assert.equal(store.getFailures()[0].response_class, 'unparseable');
  } finally {
    close();
  }
});

test('safe-failure: an unparseable 200 does not write or clear classifieds_last_uid / classifieds_last_confirmed_at', async () => {
  // Seed both settings, then feed a malformed 200: the unparseable branch
  // must leave both exactly as they were (no write, no clear).
  const { run, store, close } = runCapturing({ [URL]: { status: 200, body: 'not html at all' } });
  try {
    store.setSetting('classifieds_last_uid', '226301');
    store.setSetting('classifieds_last_confirmed_at', '2026-09-19T07:30:00Z');
    const result = await run();
    assert.equal(result.state, 'unknown');
    assert.equal(store.getSetting('classifieds_last_uid'), '226301');
    assert.equal(store.getSetting('classifieds_last_confirmed_at'), '2026-09-19T07:30:00Z');
  } finally {
    close();
  }
});

test('safe-failure: a repeated malformed 200 is fetched as 200, not hidden behind a 304 (validators cleared)', async () => {
  // The 200 carries an ETag (so the client caches a validator), but the body
  // is unparseable. The first poll must clear the cached validator, so the
  // second poll goes out without If-None-Match — a real server would then
  // answer 200 with a full body instead of 304.
  const { transport, run, store, close } = runCapturing({
    [URL]: { status: 200, body: 'not html at all', headers: { etag: '"bad-etag"' } },
  });
  try {
    const first = await run();
    assert.equal(first.state, 'unknown');
    // The validator was cached by the 200 and then cleared by the
    // unparseable branch.
    const state = store.getFeedState(URL);
    assert.equal(state.etag, null, 'the cached etag must be cleared');
    const second = await run();
    assert.equal(second.state, 'unknown', 'the repeated bad body is still unparseable, not resolved from a 304');
    const secondCall = transport.requestLog[1];
    assert.equal(secondCall.options.headers['if-none-match'], undefined, 'the second request must not carry If-None-Match');
    // One failures row per unparseable 200: two polls, two rows.
    assert.equal(store.getFailures().length, 2);
  } finally {
    close();
  }
});

test('safe-failure: a valid 200 retains its validators (unchanged behavior)', async () => {
  const { transport, run, store, close } = runCapturing({
    [URL]: { status: 200, fixture: 'http/classifieds-page.html', headers: { etag: '"valid-etag"' } },
  });
  try {
    const first = await run();
    assert.equal(first.state, 'valid');
    assert.equal(first.uid, 226301);
    const state = store.getFeedState(URL);
    assert.equal(state.etag, '"valid-etag"', 'a valid 200 must keep its validator');
    const second = await run();
    assert.equal(second.state, 'valid');
    const secondCall = transport.requestLog[1];
    assert.equal(secondCall.options.headers['if-none-match'], '"valid-etag"', 'the second request must carry If-None-Match');
  } finally {
    close();
  }
});

test('safe-failure: a genuine uid-0 page still expires (the fail-closed behavior is preserved)', async () => {
  const { run, close } = runCapturing({ [URL]: { status: 200, fixture: 'http/derived/classifieds-page-anon.html' } });
  try {
    const result = await run();
    assert.equal(result.state, 'expired');
    assert.equal(result.uid, 0);
    assert.equal(result.alert, true);
    assert.equal(result.latched, true);
  } finally {
    close();
  }
});

// --- Review round-1 (Abhishek, pinned fb688f3): a fabricated session death ---
// The parser's gates were token checks and extractUid defaulted an absent or
// malformed uid to 0, so these two classes of 200 resolved `expired` — an
// alert, a latch and `classifieds_last_uid=0` written on no evidence. Both
// must resolve `unknown` (transient: no alert, no latch, no session writes).

test('safe-failure: a non-HTML 200 that merely quotes the OzB_vars and </html> tokens resolves unknown, not expired', async () => {
  const quoted = JSON.stringify({
    error: 'bad gateway',
    upstream: 'OzB_vars = {"site_name":"OzBargain","adstype":"FUSE"}; </html>',
  });
  // The 200 carries an ETag, so the client caches a validator for the URL: the
  // unparseable branch must drop it, or the repeat would be answered 304 and
  // the bad body would never be seen again.
  const { run, store, logLines, close } = runCapturing({
    [URL]: { status: 200, body: quoted, headers: { etag: '"bad-etag"' } },
  });
  try {
    store.setSetting('classifieds_last_uid', '226301');
    store.setSetting('classifieds_last_confirmed_at', '2026-09-19T07:30:00Z');
    const result = await run();
    assert.equal(result.state, 'unknown');
    assert.equal(result.uid, 0);
    assert.deepEqual(result.listings, []);
    assert.equal(result.alert, false, 'a bad body must not raise a session-expiry alert');
    assert.equal(result.latched, false, 'a bad body must not latch polling off');
    // Exactly one failures row, classed unparseable, carrying the raw body.
    const failures = store.getFailures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].response_class, 'unparseable');
    assert.equal(failures[0].body, quoted);
    const line = logLines.find((l) => l.includes('unparseable'));
    assert.ok(line && line.includes(URL) && line.includes('missing OzB_vars'), 'the log names the URL, class and reason');
    // No session state was written or cleared.
    assert.equal(store.getSetting('classifieds_last_uid'), '226301');
    assert.equal(store.getSetting('classifieds_last_confirmed_at'), '2026-09-19T07:30:00Z');
    // The unusable validator for the URL is dropped, so the repeat is a 200.
    const feed = store.getFeedState(URL);
    assert.ok(feed !== null && feed.etag === null, 'the cached validator must be cleared');
  } finally {
    close();
  }
});

test('safe-failure: a complete page with no readable uid (absent, quoted or null) resolves unknown, not expired', async () => {
  const full = readFileSync(new globalThis.URL('../../../fixtures/http/classifieds-page.html', import.meta.url), 'utf8');
  // Derived by rewriting only the uid field of the complete fixture: the page
  // is otherwise complete and parses 25 listings, so nothing but the uid field
  // distinguishes these bodies from a valid page.
  const cases = [
    ['absent', full.replace('"uid":226301,', '')],
    ['quoted string', full.replace('"uid":226301,', '"uid":"226301",')],
    ['null', full.replace('"uid":226301,', '"uid":null,')],
  ];
  for (const [what, body] of cases) {
    assert.notEqual(body, full, `${what}: the derived body must differ from the fixture`);
    const { run, store, close } = runCapturing({ [URL]: { status: 200, body } });
    try {
      store.setSetting('classifieds_last_uid', '226301');
      store.setSetting('classifieds_last_confirmed_at', '2026-09-19T07:30:00Z');
      const result = await run();
      assert.equal(result.state, 'unknown', `${what}: a uid-less page must never resolve as a session state`);
      assert.equal(result.alert, false, `${what}: no expiry alert`);
      assert.equal(result.latched, false, `${what}: no latch`);
      const failures = store.getFailures();
      assert.equal(failures.length, 1, `${what}: exactly one failures row`);
      assert.equal(failures[0].response_class, 'unparseable', `${what}: classed unparseable`);
      assert.equal(store.getSetting('classifieds_last_uid'), '226301', `${what}: the persisted uid is untouched`);
      assert.equal(
        store.getSetting('classifieds_last_confirmed_at'),
        '2026-09-19T07:30:00Z',
        `${what}: the confirmation instant is untouched`,
      );
    } finally {
      close();
    }
  }
});
