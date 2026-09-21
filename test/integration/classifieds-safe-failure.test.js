/**
 * The classifieds safe-failure behaviour, end to end over a real socket (the
 * loopback integration regression for the production fix).
 *
 * This is the integration counterpart to the unit coverage: the real
 * `runClassifiedsPoll` talks over a real socket to the fixture server (the
 * real transport, the real HTTP client, so the conditional requests and the
 * validator cache are real), against the real store on a temporary database.
 *
 * The point of the loopback test is the one thing a stub transport cannot
 * prove: that a repeated malformed 200 is fetched as a 200 rather than hidden
 * behind a 304. The first 200 carries a real `ETag`; the client caches it;
 * the unparseable branch clears it; the second request therefore goes out
 * *without* `If-None-Match`, so the real server answers a full 200 instead of
 * a 304. The server's request log records whether each request carried
 * `If-None-Match` and the status it answered, which is exactly what the
 * assertions read.
 *
 * The malformed bodies are served inline (the fixture server now accepts an
 * inline descriptor as a timeline entry) so the corpus in `fixtures/http` is
 * never edited.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startFixtureServer, CLASSIFIEDS_PATH } from '../../scripts/fixture-server.mjs';
import { openTempStore, runClassifiedsCycle, POLL_1_AT } from '../support/integration.js';

/** The complete page, read from the corpus (never edited). */
function readCompletePage() {
  return readFileSync(new URL('../../fixtures/http/classifieds-page.html', import.meta.url), 'utf8');
}

/**
 * Start a fixture server whose only timeline entry is the classifieds URL,
 * serving the given sequence of entries (fixture names or inline descriptors).
 * The caller closes it.
 * @param {(string | { body?: string, status?: number })[]} entries
 * @returns {Promise<object>} the started server
 */
async function startClassifiedsServer(entries) {
  return startFixtureServer({ timeline: { [CLASSIFIEDS_PATH]: entries } });
}

/**
 * Run one classifieds cycle against a server, capturing the log lines.
 * @param {object} server
 * @param {object} store
 * @returns {Promise<{ result: object, logLines: string[] }>}
 */
async function cycle(server, store) {
  const logLines = [];
  const result = await runClassifiedsCycle({
    store,
    config: server.appConfig(),
    pollAt: POLL_1_AT,
    log: (line) => logLines.push(line),
  });
  return { result, logLines };
}

test('loopback: a truncated 200 resolves unknown (never expired), writes one unparseable failures row, and logs the URL, class and reason', async () => {
  const full = readCompletePage();
  // Cut the complete page mid-stream: the head (with OzB_vars) is kept, the
  // closing </html> is not — the shape of a stream that died mid-body.
  const truncated = full.slice(0, 4000);
  const server = await startClassifiedsServer([{ body: truncated }]);
  const temp = openTempStore();
  try {
    const { result, logLines } = await cycle(server, temp.store);
    assert.equal(result.state, 'unknown');
    assert.equal(result.uid, 0);
    assert.deepEqual(result.listings, []);
    assert.equal(result.alert, false);
    assert.equal(result.latched, false);
    // One unparseable failures row, carrying the raw body.
    const failures = temp.store.getFailures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].response_class, 'unparseable');
    assert.ok(failures[0].body.length > 0, 'the stored body is non-empty');
    // The log names the URL, the class and the parser reason.
    const line = logLines.find((l) => l.includes('unparseable'));
    assert.ok(line, 'an unparseable log line must be written');
    assert.ok(line.includes(CLASSIFIEDS_PATH), 'the log must name the URL');
    assert.ok(line.includes('missing closing </html> terminator'), 'the log must carry the parser reason');
    // No session state was written.
    assert.equal(temp.store.getSetting('classifieds_last_uid'), null);
    assert.equal(temp.store.getSetting('classifieds_last_confirmed_at'), null);
  } finally {
    temp.close();
    await server.close();
  }
});

test('loopback: an empty 200 and a whitespace-only 200 resolve unknown, not expired', async () => {
  const server = await startClassifiedsServer([{ body: '' }, { body: '   \n\t  ' }]);
  const temp = openTempStore();
  try {
    const { result: empty } = await cycle(server, temp.store);
    assert.equal(empty.state, 'unknown');
    assert.equal(empty.uid, 0);
    assert.equal(empty.alert, false);
    assert.equal(empty.latched, false);
    assert.equal(temp.store.getFailures().length, 1);
    assert.equal(temp.store.getFailures()[0].response_class, 'unparseable');

    const { result: ws } = await cycle(server, temp.store);
    assert.equal(ws.state, 'unknown');
    assert.equal(ws.alert, false);
    assert.equal(ws.latched, false);
  } finally {
    temp.close();
    await server.close();
  }
});

test('loopback: a JSON (non-HTML) 200 resolves unknown, not expired', async () => {
  const json = JSON.stringify({ error: 'rate limited', retry: 60 });
  const server = await startClassifiedsServer([{ body: json }]);
  const temp = openTempStore();
  try {
    const { result } = await cycle(server, temp.store);
    assert.equal(result.state, 'unknown');
    assert.equal(result.uid, 0);
    assert.equal(result.alert, false);
    assert.equal(result.latched, false);
    assert.equal(temp.store.getFailures().length, 1);
    assert.equal(temp.store.getFailures()[0].response_class, 'unparseable');
  } finally {
    temp.close();
    await server.close();
  }
});

test('loopback: a repeated malformed 200 is fetched as 200, not hidden behind a 304 (the real-socket proof)', async () => {
  // The same unparseable body served twice. The first 200 carries a real
  // ETag; the client caches it; the unparseable branch clears it; the second
  // request goes out without If-None-Match, so the real server answers a full
  // 200 rather than a 304.
  const bad = 'not html at all';
  const server = await startClassifiedsServer([{ body: bad }, { body: bad }]);
  const temp = openTempStore();
  try {
    const first = await cycle(server, temp.store);
    assert.equal(first.result.state, 'unknown');
    // The validator was cached by the first 200 and then cleared.
    const feed = temp.store.getFeedState(server.appConfig().OZB_CLASSIFIEDS_URL);
    assert.equal(feed.etag, null, 'the cached etag must be cleared');

    const second = await cycle(server, temp.store);
    assert.equal(second.result.state, 'unknown', 'the repeated bad body is still unparseable, not resolved from a 304');
    // The real-socket proof: the second request carried no If-None-Match, so
    // the server answered 200, not 304.
    const requests = server.requests;
    assert.equal(requests.length, 2, 'two requests, one per poll');
    assert.equal(requests[1].ifNoneMatch, null, 'the second request must not carry If-None-Match');
    assert.equal(requests[1].status, 200, 'the server answered 200, not 304');
    // One failures row per unparseable 200: two polls, two rows.
    assert.equal(temp.store.getFailures().length, 2);
  } finally {
    temp.close();
    await server.close();
  }
});

test('loopback: a valid 200 parses 25 listings, reports uid 226301, and retains its validators', async () => {
  const server = await startClassifiedsServer(['http/classifieds-page.html']);
  const temp = openTempStore();
  try {
    const { result } = await cycle(server, temp.store);
    assert.equal(result.state, 'valid');
    assert.equal(result.uid, 226301);
    assert.equal(result.listings.length, 25);
    assert.equal(result.alert, false);
    assert.equal(result.latched, false);
    // A valid 200 keeps its validator (the real server's ETag was cached).
    const feed = temp.store.getFeedState(server.appConfig().OZB_CLASSIFIEDS_URL);
    assert.ok(feed.etag, 'a valid 200 must keep its validator');
  } finally {
    temp.close();
    await server.close();
  }
});

test('loopback: a 304 after a valid 200 resolves from the persisted uid and never latches', async () => {
  // The same complete page served twice: the first 200 caches the uid and the
  // validator; the second request carries the real ETag, so the real server
  // answers 304, and the client resolves the session from the last known uid.
  const server = await startClassifiedsServer(['http/classifieds-page.html', 'http/classifieds-page.html']);
  const temp = openTempStore();
  try {
    const first = await cycle(server, temp.store);
    assert.equal(first.result.state, 'valid');
    assert.equal(first.result.uid, 226301);

    const second = await cycle(server, temp.store);
    assert.equal(second.result.state, 'valid');
    assert.equal(second.result.uid, 226301, 'resolved from the persisted uid');
    assert.equal(second.result.alert, false);
    assert.equal(second.result.latched, false, 'a 304 never latches');
    // The real-socket proof: the second request carried the ETag, so the real
    // server answered 304.
    const requests = server.requests;
    assert.equal(requests.length, 2);
    assert.ok(requests[1].ifNoneMatch, 'the second request carried the cached ETag');
    assert.equal(requests[1].status, 304, 'the server answered a real 304');
  } finally {
    temp.close();
    await server.close();
  }
});

test('loopback: a genuine uid-0 (anonymous) page still expires (the fail-closed behaviour is preserved)', async () => {
  const server = await startClassifiedsServer(['http/derived/classifieds-page-anon.html']);
  const temp = openTempStore();
  try {
    const { result } = await cycle(server, temp.store);
    assert.equal(result.state, 'expired');
    assert.equal(result.uid, 0);
    assert.equal(result.alert, true);
    assert.equal(result.latched, true);
    // The persisted last uid is invalidated to 0.
    assert.equal(temp.store.getSetting('classifieds_last_uid'), '0');
  } finally {
    temp.close();
    await server.close();
  }
});

test('loopback: the existing non-OK controls (500, 429) resolve unknown, never latch, never alert', async () => {
  const server = await startClassifiedsServer([{ body: 'server error', status: 500 }, { body: 'slow down', status: 429 }]);
  const temp = openTempStore();
  try {
    const { result: err500 } = await cycle(server, temp.store);
    assert.equal(err500.state, 'unknown');
    assert.equal(err500.alert, false);
    assert.equal(err500.latched, false);

    const { result: err429 } = await cycle(server, temp.store);
    assert.equal(err429.state, 'unknown');
    assert.equal(err429.alert, false);
    assert.equal(err429.latched, false);
  } finally {
    temp.close();
    await server.close();
  }
});
