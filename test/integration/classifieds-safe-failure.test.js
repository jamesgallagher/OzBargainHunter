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
import { startFixtureServer, CLASSIFIEDS_PATH } from '../../scripts/fixture-server.mjs';
import { openTempStore, runClassifiedsFetch, POLL_1_AT } from '../support/integration.js';

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
  const result = await runClassifiedsFetch({
    store,
    config: server.appConfig(),
    pollAt: POLL_1_AT,
    log: (line) => logLines.push(line),
  });
  return { result, logLines };
}

/**
 * A temp store with classifieds polling enabled and a fake session cookie set.
 * The production default is disabled + unconfigured (the gate makes zero
 * requests); these loopback scenarios exist to exercise a *real* classifieds
 * fetch, so the intended state is set explicitly here rather than in the
 * shared `openTempStore` helper (which would also flip the default-exercising
 * tests). The default-disabled and enabled-without-credentials contracts are
 * covered separately by the unit tests, which assert zero requests.
 */
function classifiedsTempStore() {
  const temp = openTempStore();
  temp.store.setSetting('classifieds_enabled', '1');
  temp.store.setSetting('ozb_account_cookie', 'test-session=authenticated');
  return temp;
}

test('loopback: a repeated malformed 200 is fetched as 200, not hidden behind a 304 (the real-socket proof)', async () => {
  // The same unparseable body served twice. The first 200 carries a real
  // ETag; the client caches it; the unparseable branch clears it; the second
  // request goes out without If-None-Match, so the real server answers a full
  // 200 rather than a 304.
  const bad = 'not html at all';
  const server = await startClassifiedsServer([{ body: bad }, { body: bad }]);
  const temp = classifiedsTempStore();
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
  const temp = classifiedsTempStore();
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
  const temp = classifiedsTempStore();
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
