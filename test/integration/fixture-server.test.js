/**
 * The fixture server's own contract (card 5, design 10.4). Everything the
 * integration suite depends on is asserted here directly, so a change to the
 * server cannot quietly weaken the three-poll test: the timeline order, the
 * real conditional request, the two-page cap and the loopback-only bind.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CLASSIFIEDS_PATH,
  DEALS_PATH,
  FIXTURES_DIR,
  FRONT_PATH,
  FREEBIES_PATH,
  createFixtureServer,
  etagFor,
  resolveKey,
  startFixtureServer,
  TIMELINE,
} from '../../scripts/fixture-server.mjs';

describe('integration: the fixture server', () => {
  let fx;

  before(async () => {
    fx = await startFixtureServer();
  });

  after(async () => {
    await fx.close();
  });

  it('binds loopback only', () => {
    assert.equal(fx.host, '127.0.0.1');
    assert.match(fx.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('maps the four poll URLs to the corpus timeline (fixtures/README.md §2)', async () => {
    assert.deepEqual(TIMELINE[`${DEALS_PATH}?page=0`], ['http/r0.xml', 'http/cmp_deals.xml', 'http/cmp_deals.xml']);
    assert.deepEqual(TIMELINE[`${DEALS_PATH}?page=1`], ['http/r1.xml', 'http/r1.xml']);
    assert.deepEqual(TIMELINE[FRONT_PATH], ['http/feed_feed.xml', 'http/cmp_front.xml', 'http/cmp_front.xml']);
    assert.deepEqual(TIMELINE[FREEBIES_PATH], ['http/freebies_feed.xml']);
    assert.deepEqual(TIMELINE[CLASSIFIEDS_PATH], ['http/classifieds-page.html']);
  });

  it('serves the corpus bytes with a strong ETag and an XML content type', async () => {
    const res = await fetch(`${fx.origin}${DEALS_PATH}?page=0`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /xml/);
    const body = await res.text();
    assert.equal(body, readFileSync(`${FIXTURES_DIR}http/r0.xml`, 'utf8'));
    assert.equal(res.headers.get('etag'), etagFor(body));
    assert.equal(fx.requests[0].fixture, 'http/r0.xml');
  });

  it('advances through the timeline on successive requests', async () => {
    // The page-0 timeline is r0 → cmp_deals → cmp_deals.
    const second = await fetch(`${fx.origin}${DEALS_PATH}?page=0`);
    assert.equal(second.status, 200);
    assert.equal((await second.text()).length, readFileSync(`${FIXTURES_DIR}http/cmp_deals.xml`, 'utf8').length);
    assert.equal(fx.requests[1].fixture, 'http/cmp_deals.xml');
    assert.equal(fx.requests[1].index, 1);
  });

  it('honours If-None-Match with a real 304 and an empty body', async () => {
    // A dedicated server with a single-entry page-0 timeline, so this assertion
    // is independent of whether the preceding tests advanced the shared server's
    // timeline (under a `--test-name-pattern` filter they are skipped, leaving
    // the shared counter at 0). A single entry clamps at its only fixture, so
    // two successive requests serve the same bytes and therefore the same ETag
    // — which is what makes the conditional request a real 304.
    const local = createFixtureServer({
      timeline: { [`${DEALS_PATH}?page=0`]: ['http/r0.xml'] },
    });
    await local.start();
    try {
      const first = await fetch(`${local.origin}${DEALS_PATH}?page=0`);
      const etag = first.headers.get('etag');
      await first.text();
      const conditional = await fetch(`${local.origin}${DEALS_PATH}?page=0`, {
        headers: { 'if-none-match': etag },
      });
      assert.equal(conditional.status, 304);
      assert.equal(await conditional.text(), '');
      assert.equal(conditional.headers.get('etag'), etag, 'the validator is repeated on the 304');
      // The stored ETag is what makes the third poll a 304: same fixture, same
      // bytes, same validator.
      assert.equal(local.requests.at(-1).status, 304);
      assert.equal(local.requests.at(-1).ifNoneMatch, etag);
    } finally {
      await local.close();
    }
  });

  it('still answers 200 when the client presents a stale validator', async () => {
    const res = await fetch(`${fx.origin}${DEALS_PATH}?page=0`, {
      headers: { 'if-none-match': '"stale-etag"' },
    });
    assert.equal(res.status, 200, 'a validator we do not serve is not a match');
    await res.text();
  });

  it('serves the classifieds page', async () => {
    const res = await fetch(`${fx.origin}${CLASSIFIEDS_PATH}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /html/);
    assert.match(await res.text(), /OzB_vars/);
  });

  it('refuses a page past the two-page cap, and records that it was asked', async () => {
    const before = fx.requests.length;
    const res = await fetch(`${fx.origin}${DEALS_PATH}?page=2`);
    assert.equal(res.status, 500, 'page 2 is not a feed');
    assert.ok(!(await res.text()).includes('<item>'), 'and not parseable as one');
    assert.equal(fx.requests.length, before + 1);
    assert.equal(fx.requests.at(-1).reason, 'page-beyond-cap');
    assert.equal(fx.requests.at(-1).page, 2);
  });

  it('answers an unmapped path with a body that is not a feed', async () => {
    const res = await fetch(`${fx.origin}/deals/feed?page=0&extra=1`);
    // The key ignores other query params, so this is still page 0 — the app
    // composes `page` as its own param, and nothing else is added.
    assert.equal(res.status, 200);
    await res.text();
    const other = await fetch(`${fx.origin}/nope`);
    assert.equal(other.status, 500);
    await other.text();
  });

  it('records every request with its URL, status and validator', async () => {
    for (const entry of fx.requests) {
      assert.equal(typeof entry.url, 'string');
      assert.ok([200, 304, 500].includes(entry.status));
      assert.equal(typeof entry.at, 'string');
    }
  });

  it('resolves keys the way the application composes URLs', () => {
    assert.deepEqual(resolveKey(`${DEALS_PATH}?page=0`), { key: `${DEALS_PATH}?page=0`, page: 0 });
    assert.deepEqual(resolveKey(`${DEALS_PATH}?page=1`), { key: `${DEALS_PATH}?page=1`, page: 1 });
    assert.deepEqual(resolveKey(FRONT_PATH), { key: FRONT_PATH, page: null });
    assert.deepEqual(resolveKey(FREEBIES_PATH), { key: FREEBIES_PATH, page: null });
    assert.deepEqual(resolveKey(CLASSIFIEDS_PATH), { key: CLASSIFIEDS_PATH, page: null });
    // No page param at all is page 0, which is how the first request of a
    // cycle looks if a caller forgets the query.
    assert.equal(resolveKey(DEALS_PATH).page, 0);
    assert.deepEqual(resolveKey('/anything-else'), { key: null, page: null });
    assert.deepEqual(resolveKey('/deals/feed/extra?page=1'), { key: null, page: null });
  });

  it('reset() rewinds the timeline and the log, so a run can be replayed', async () => {
    const server = createFixtureServer();
    await server.start();
    try {
      const first = await fetch(`${server.origin}${DEALS_PATH}?page=0`);
      await first.text();
      assert.equal(server.requests.length, 1);
      server.reset();
      assert.equal(server.requests.length, 0);
      const firstAgain = await fetch(`${server.origin}${DEALS_PATH}?page=0`);
      await firstAgain.text();
      assert.equal(server.requests[0].fixture, 'http/r0.xml', 'back to the start of the timeline');
    } finally {
      await server.close();
    }
  });
});

describe('integration: the fixture server login routes (prompt 4.11)', () => {
  const SENTINEL_USER = 'SENTINEL_USER_5d1c';
  const SENTINEL_PASS = 'SENTINEL_PASS_8e2f';
  const SENTINEL_COOKIE = 'SENTINEL_COOKIE_3a9b';

  /**
   * A dedicated server with a login model, driven over a real socket. Each
   * scenario gets its own server (sessions are per-server), and `close()`
   * destroys live connections, so a hung POST cannot hang the teardown.
   */
  async function withLoginServer(login, fn) {
    const server = createFixtureServer({ login });
    await server.start();
    try {
      await fn(server);
    } finally {
      await server.close();
    }
  }

  /** The `PHPSESSID` value a `Set-Cookie` header carries. */
  function sessionId(setCookieHeader) {
    return setCookieHeader.split(';')[0].slice('PHPSESSID='.length);
  }

  it('with `login` absent, behaviour is unchanged: the login routes are unmapped and /classified is the timeline page', async () => {
    const server = createFixtureServer();
    await server.start();
    try {
      const res = await fetch(`${server.origin}/user/login`);
      assert.equal(res.status, 500, 'the login route is not on the timeline');
      await res.text();
      const entry = server.requests.at(-1);
      assert.equal(entry.reason, 'unmapped-path');
      assert.equal(entry.fixture, 'http/pg11.xml');
      assert.equal('scenario' in entry, false, 'no login entry is recorded');

      const classified = await fetch(`${server.origin}${CLASSIFIEDS_PATH}`);
      assert.equal(classified.status, 200);
      assert.match(await classified.text(), /OzB_vars/);
    } finally {
      await server.close();
    }
  });

  it('ok: the whole login flow over a real socket', async () => {
    await withLoginServer(
      { username: SENTINEL_USER, password: SENTINEL_PASS, sessionCookieValue: SENTINEL_COOKIE },
      async (server) => {
        // 1. The form: a fresh anonymous session with a token.
        const page = await fetch(`${server.origin}/user/login`);
        assert.equal(page.status, 200);
        const setCookies = page.headers.getSetCookie();
        assert.equal(setCookies.length, 1);
        assert.match(setCookies[0], /^PHPSESSID=[0-9a-f]{64}; Max-Age=7776000; Path=\/; HttpOnly$/);
        const sid = sessionId(setCookies[0]);
        const html = await page.text();
        assert.match(html, /id="user_login"/);
        assert.match(html, /id="edit-name"/);
        assert.match(html, new RegExp('value="fixture-form-token-' + sid + '"'));

        // 2. The POST: correct credentials and token.
        const post = await fetch(`${server.origin}/user/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `PHPSESSID=${sid}` },
          body: new URLSearchParams({
            'edit[name]': SENTINEL_USER,
            'edit[pass]': SENTINEL_PASS,
            'edit[form_token]': `fixture-form-token-${sid}`,
            'edit[form_id]': 'user_login',
            op: 'Log in',
          }),
          redirect: 'manual',
        });
        assert.equal(post.status, 302);
        assert.equal(post.headers.get('location'), '/user/login');
        const postCookies = post.headers.getSetCookie();
        assert.equal(postCookies.length, 4);
        assert.equal(postCookies[0], `PHPSESSID=${SENTINEL_COOKIE}; Max-Age=7776000; Path=/; HttpOnly`);
        assert.match(postCookies[1], /^ozbuserhash=/);
        assert.match(postCookies[2], /^_ga=/);
        assert.match(postCookies[3], /^__cf_bm=/);
        await post.text();

        // 3. The redirect: a logged-in session goes to the profile.
        const redirect = await fetch(`${server.origin}/user/login`, { headers: { cookie: `PHPSESSID=${SENTINEL_COOKIE}` }, redirect: 'manual' });
        assert.equal(redirect.status, 302);
        assert.equal(redirect.headers.get('location'), '/user/226301');
        await redirect.text();

        // 4. The profile page.
        const profile = await fetch(`${server.origin}/user/226301`, { headers: { cookie: `PHPSESSID=${SENTINEL_COOKIE}` } });
        assert.equal(profile.status, 200);
        assert.match(await profile.text(), /My Profile/);

        // 5. The classifieds page.
        const classified = await fetch(`${server.origin}/classified`, { headers: { cookie: `PHPSESSID=${SENTINEL_COOKIE}` } });
        assert.equal(classified.status, 200);
        assert.match(await classified.text(), /OzB_vars/);

        // 6. The decoy search page.
        const search = await fetch(`${server.origin}/search/node`);
        assert.equal(search.status, 200);
        assert.match(await search.text(), /No results\./);

        // The decoy submit: an `op` other than `Log in` is the search form.
        const decoy = await fetch(`${server.origin}/user/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `PHPSESSID=${SENTINEL_COOKIE}` },
          body: new URLSearchParams({ op: 'Search' }),
          redirect: 'manual',
        });
        assert.equal(decoy.status, 302);
        assert.equal(decoy.headers.get('location'), '/search/node');
        await decoy.text();

        // The recorded entries: method, path without query, status, scenario —
        // never the body.
        const entries = server.requests.filter((e) => e.scenario !== undefined);
        assert.deepEqual(
          entries.map((e) => [e.method, e.url, e.status]),
          [
            ['GET', '/user/login', 200],
            ['POST', '/user/login', 302],
            ['GET', '/user/login', 302],
            ['GET', '/user/226301', 200],
            ['GET', '/classified', 200],
            ['GET', '/search/node', 200],
            ['POST', '/user/login', 302],
          ],
        );
        assert.equal(entries.at(-1).reason, 'decoy-submit');
        for (const entry of entries) {
          assert.equal(entry.scenario, 'ok');
          assert.equal(typeof entry.at, 'string');
          assert.equal('body' in entry, false, 'the POST body is never recorded');
        }
      },
    );
  });

  it('validation_error: the token check fails even for a valid session', async () => {
    await withLoginServer({ username: SENTINEL_USER, password: SENTINEL_PASS, scenario: 'validation_error' }, async (server) => {
      const page = await fetch(`${server.origin}/user/login`);
      assert.equal(page.status, 200);
      const sid = sessionId(page.headers.getSetCookie()[0]);
      await page.text();
      const post = await fetch(`${server.origin}/user/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `PHPSESSID=${sid}` },
        body: new URLSearchParams({
          'edit[name]': SENTINEL_USER,
          'edit[pass]': SENTINEL_PASS,
          'edit[form_token]': `fixture-form-token-${sid}`,
          op: 'Log in',
        }),
        redirect: 'manual',
      });
      assert.equal(post.status, 200, 'a failed login re-serves the form page');
      const body = await post.text();
      assert.match(body, /class="messages error"/);
      assert.match(body, /Validation error, please try again\. If this error persists, please contact the site administrator\./);
      assert.equal(server.requests.at(-1).status, 200);
    });
  });

  it('a credential mismatch under `ok` is the credentials error, not a redirect', async () => {
    await withLoginServer({ username: SENTINEL_USER, password: SENTINEL_PASS }, async (server) => {
      const page = await fetch(`${server.origin}/user/login`);
      const sid = sessionId(page.headers.getSetCookie()[0]);
      await page.text();
      const post = await fetch(`${server.origin}/user/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `PHPSESSID=${sid}` },
        body: new URLSearchParams({
          'edit[name]': SENTINEL_USER,
          'edit[pass]': 'a-wrong-password',
          'edit[form_token]': `fixture-form-token-${sid}`,
          op: 'Log in',
        }),
      });
      assert.equal(post.status, 200);
      const body = await post.text();
      assert.match(body, /class="messages error"/);
      assert.match(body, /Sorry\. Unrecognised username or password\./);
    });
  });

  it('challenge_login_page: a 403 with the exact challenge body', async () => {
    await withLoginServer({ username: SENTINEL_USER, password: SENTINEL_PASS, scenario: 'challenge_login_page' }, async (server) => {
      const res = await fetch(`${server.origin}/user/login`);
      assert.equal(res.status, 403);
      assert.match(res.headers.get('content-type'), /^text\/plain/);
      assert.equal(await res.text(), 'error code: 1010\n');
      assert.equal(server.requests.at(-1).status, 403);
    });
  });

  it('challenge_submit: the submit is a 403 with the exact challenge body', async () => {
    await withLoginServer({ username: SENTINEL_USER, password: SENTINEL_PASS, scenario: 'challenge_submit' }, async (server) => {
      const res = await fetch(`${server.origin}/user/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ 'edit[name]': SENTINEL_USER, 'edit[pass]': SENTINEL_PASS, op: 'Log in' }),
      });
      assert.equal(res.status, 403);
      assert.match(res.headers.get('content-type'), /^text\/plain/);
      assert.equal(await res.text(), 'error code: 1010\n');
      assert.equal(server.requests.at(-1).status, 403);
    });
  });

  it('challenge_classified: /classified is a 403 with the exact challenge body', async () => {
    await withLoginServer({ username: SENTINEL_USER, password: SENTINEL_PASS, scenario: 'challenge_classified' }, async (server) => {
      const res = await fetch(`${server.origin}/classified`);
      assert.equal(res.status, 403);
      assert.match(res.headers.get('content-type'), /^text\/plain/);
      assert.equal(await res.text(), 'error code: 1010\n');
      assert.equal(server.requests.at(-1).status, 403);
    });
  });

  it('rate_limit_login_page: a 429 with Retry-After: 120', async () => {
    await withLoginServer({ username: SENTINEL_USER, password: SENTINEL_PASS, scenario: 'rate_limit_login_page' }, async (server) => {
      const res = await fetch(`${server.origin}/user/login`);
      assert.equal(res.status, 429);
      assert.equal(res.headers.get('retry-after'), '120');
      assert.equal(await res.text(), 'rate limited');
      assert.equal(server.requests.at(-1).status, 429);
    });
  });

  it('server_error_submit: the submit is a 500', async () => {
    await withLoginServer({ username: SENTINEL_USER, password: SENTINEL_PASS, scenario: 'server_error_submit' }, async (server) => {
      const res = await fetch(`${server.origin}/user/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ 'edit[name]': SENTINEL_USER, 'edit[pass]': SENTINEL_PASS, op: 'Log in' }),
      });
      assert.equal(res.status, 500);
      assert.equal(await res.text(), 'internal error');
      assert.equal(server.requests.at(-1).status, 500);
    });
  });

  it('not_entitled: the login succeeds, then /classified is a marker-less 403', async () => {
    await withLoginServer({ username: SENTINEL_USER, password: SENTINEL_PASS, scenario: 'not_entitled' }, async (server) => {
      const page = await fetch(`${server.origin}/user/login`);
      const sid = sessionId(page.headers.getSetCookie()[0]);
      await page.text();
      const post = await fetch(`${server.origin}/user/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `PHPSESSID=${sid}` },
        body: new URLSearchParams({
          'edit[name]': SENTINEL_USER,
          'edit[pass]': SENTINEL_PASS,
          'edit[form_token]': `fixture-form-token-${sid}`,
          op: 'Log in',
        }),
        redirect: 'manual',
      });
      assert.equal(post.status, 302, 'the login itself succeeds');
      const cookie = post.headers.getSetCookie()[0].split(';')[0].slice('PHPSESSID='.length);
      await post.text();
      const classified = await fetch(`${server.origin}/classified`, { headers: { cookie: `PHPSESSID=${cookie}` } });
      assert.equal(classified.status, 403);
      const body = await classified.text();
      assert.match(body, /403 Access Denied/);
      assert.ok(!body.includes('error code: 1010'), 'no challenge markers');
    });
  });

  it('hang_submit: the POST never answers; the client aborts and close() does not hang', async () => {
    await withLoginServer({ username: SENTINEL_USER, password: SENTINEL_PASS, scenario: 'hang_submit' }, async (server) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        await assert.rejects(
          fetch(`${server.origin}/user/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ 'edit[name]': SENTINEL_USER, 'edit[pass]': SENTINEL_PASS, op: 'Log in' }),
            signal: controller.signal,
          }),
        );
      } finally {
        clearTimeout(timer);
      }
      assert.equal(server.requests.at(-1).status, 0, 'the hung POST is recorded as unanswered');
    });
  });

  it('no_session_cookie: the success clears the cookie and issues the session under a different name', async () => {
    await withLoginServer({ username: SENTINEL_USER, password: SENTINEL_PASS, scenario: 'no_session_cookie' }, async (server) => {
      const page = await fetch(`${server.origin}/user/login`);
      const sid = sessionId(page.headers.getSetCookie()[0]);
      await page.text();
      const post = await fetch(`${server.origin}/user/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `PHPSESSID=${sid}` },
        body: new URLSearchParams({
          'edit[name]': SENTINEL_USER,
          'edit[pass]': SENTINEL_PASS,
          'edit[form_token]': `fixture-form-token-${sid}`,
          op: 'Log in',
        }),
        redirect: 'manual',
      });
      assert.equal(post.status, 302);
      assert.equal(post.headers.get('location'), '/user/login');
      const cookies = post.headers.getSetCookie();
      assert.equal(cookies.length, 2);
      assert.equal(cookies[0], 'PHPSESSID=deleted; Max-Age=0; Path=/');
      assert.match(cookies[1], /^SSESS_fixture=[0-9a-f]{64}; Path=\/$/);
      const fixtureSid = cookies[1].split(';')[0].slice('SSESS_fixture='.length);
      await post.text();
      // Without a cookie the request is anonymous: the profile is a 403.
      const anonymous = await fetch(`${server.origin}/user/226301`);
      assert.equal(anonymous.status, 403);
      await anonymous.text();
      // The differently named cookie resolves the logged-in session.
      const profile = await fetch(`${server.origin}/user/226301`, { headers: { cookie: `SSESS_fixture=${fixtureSid}` } });
      assert.equal(profile.status, 200);
      assert.match(await profile.text(), /My Profile/);
    });
  });

  it('ok: a cookieless /classified is a 403; the issued PHPSESSID serves the page', async () => {
    await withLoginServer({ username: SENTINEL_USER, password: SENTINEL_PASS, sessionCookieValue: SENTINEL_COOKIE }, async (server) => {
      const page = await fetch(`${server.origin}/user/login`);
      const sid = sessionId(page.headers.getSetCookie()[0]);
      await page.text();
      const post = await fetch(`${server.origin}/user/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `PHPSESSID=${sid}` },
        body: new URLSearchParams({
          'edit[name]': SENTINEL_USER,
          'edit[pass]': SENTINEL_PASS,
          'edit[form_token]': `fixture-form-token-${sid}`,
          op: 'Log in',
        }),
        redirect: 'manual',
      });
      assert.equal(post.status, 302);
      await post.text();
      const anonymous = await fetch(`${server.origin}/classified`);
      assert.equal(anonymous.status, 403, 'without a cookie the request is anonymous');
      const body = await anonymous.text();
      assert.match(body, /403 Access Denied/);
      const withCookie = await fetch(`${server.origin}/classified`, { headers: { cookie: `PHPSESSID=${SENTINEL_COOKIE}` } });
      assert.equal(withCookie.status, 200);
      assert.match(await withCookie.text(), /OzB_vars/);
    });
  });
});
