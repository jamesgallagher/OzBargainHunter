#!/usr/bin/env node
/**
 * The fixture server (card 5, design 10.4). It serves the captured corpus as
 * though it were OzBargain, so the integration suite and the CI smoke test can
 * point the application at a *real* HTTP endpoint on loopback instead of at the
 * live site.
 *
 * It is deliberately a real server rather than a stub transport: the smoke test
 * runs the built image against it, so the application's own HTTP client, its
 * `If-None-Match` handling and its 304 classification are all exercised, not
 * bypassed.
 *
 * Behaviour:
 *
 * - **Three poll URLs.** `/deals/feed?page=0`, `/deals/feed?page=1` and
 *   `/feed`, mapped to the corpus timeline in `fixtures/README.md` §2.
 * - **The timeline advances on successive requests.** Each URL has an ordered
 *   list of fixture files; the Nth request for a URL serves the Nth entry,
 *   clamped at the last one. So poll 1 gets `r0.xml` / `r1.xml` /
 *   `feed_feed.xml`, poll 2 gets `cmp_deals.xml` / `r1.xml` / `cmp_front.xml`
 *   and poll 3 gets the poll-2 bodies again.
 * - **A real conditional request.** Every 200 carries a strong `ETag` derived
 *   from the bytes served. When the client's `If-None-Match` matches the version
 *   it is about to be served, the server answers `304` with no body — so the
 *   repeated-feed polls in the corpus produce genuine 304s rather than a status
 *   code the app is told to expect.
 * - **It records every request** (URL, status, and whether it carried
 *   `If-None-Match`), which is what lets a test assert that a poll cycle is
 *   exactly three requests in order and never `page=2`.
 * - **It listens on loopback only** (`127.0.0.1`), which is also the only host
 *   the network guard permits, so a test can use it while the guard is armed.
 *
 * Any other path, and any `page` beyond the two-page cap, is recorded and
 * answered with OzBargain's own styled error body rather than a feed, so a build
 * that over-fetches fails loudly instead of silently succeeding.
 *
 * Usage as a script:
 *
 *     node scripts/fixture-server.mjs [--port 0] [--host 127.0.0.1]
 *
 * It prints the origin it bound to on stdout and stays up until SIGTERM/SIGINT.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** The corpus root. Fixture names below are relative to it. */
export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** The path the deals feed is requested at (`?page=0` / `?page=1`). */
export const DEALS_PATH = '/deals/feed';
/** The path the front-page feed is requested at. */
export const FRONT_PATH = '/feed';
/** The path the classifieds page is requested at. */
export const CLASSIFIEDS_PATH = '/classified';

/** The two-page cap (design 3.3 / D41): page 0 and page 1, never page 2. */
export const MAX_PAGE = 1;

/**
 * The poll timeline, keyed by URL. Each entry is the ordered list of fixture
 * files that URL serves; the last entry repeats forever, which is what makes
 * the third poll a set of three 304s (the same bytes, so the same ETag).
 */
export const TIMELINE = Object.freeze({
  [`${DEALS_PATH}?page=0`]: ['http/r0.xml', 'http/cmp_deals.xml', 'http/cmp_deals.xml'],
  [`${DEALS_PATH}?page=1`]: ['http/r1.xml', 'http/r1.xml'],
  [FRONT_PATH]: ['http/feed_feed.xml', 'http/cmp_front.xml', 'http/cmp_front.xml'],
  [CLASSIFIEDS_PATH]: ['http/classifieds-page.html'],
});

/** The body served for a path the corpus does not supply — OzBargain's own styled 500. */
const PAGE_LIMIT_BODY = 'http/pg11.xml';

/**
 * The ETag for a body: a strong validator derived from the exact bytes served,
 * so two requests for the same fixture agree and a changed fixture does not.
 * @param {string} body
 * @returns {string}
 */
export function etagFor(body) {
  return `"${createHash('sha1').update(body).digest('hex')}"`;
}

/**
 * Resolve a request URL to the timeline key it belongs to, plus the page it
 * asked for (or null). Exported so a test can assert the mapping directly.
 * @param {string} requestUrl the request target (path + query)
 * @returns {{ key: string|null, page: number|null }}
 */
export function resolveKey(requestUrl) {
  const url = new URL(requestUrl, 'http://127.0.0.1');
  if (url.pathname === DEALS_PATH) {
    const raw = url.searchParams.get('page') ?? '0';
    const page = Number.parseInt(raw, 10);
    // An unparseable page is treated as page 0 (the corpus has no such case;
    // the app always composes an integer).
    const normalised = Number.isNaN(page) ? 0 : page;
    return { key: `${DEALS_PATH}?page=${normalised}`, page: normalised };
  }
  if (url.pathname === FRONT_PATH) return { key: FRONT_PATH, page: null };
  if (url.pathname === CLASSIFIEDS_PATH) return { key: CLASSIFIEDS_PATH, page: null };
  return { key: null, page: null };
}

/**
 * Create (but do not start) the fixture server.
 *
 * @param {object} [options]
 * @param {Record<string, (string | { body?: string, status?: number, contentType?: string, fixture?: string })[]>} [options.timeline] the per-URL
 *   fixture lists; each entry is a fixture file name (the corpus behaviour) or
 *   an inline descriptor so a test can serve arbitrary content over a real
 *   socket. Defaults to `TIMELINE`.
 * @param {string} [options.host] the bind address; `127.0.0.1` only by default
 * @param {number} [options.port] the port; 0 asks the OS for a free one
 * @param {(line: string) => void} [options.log] a request log sink
 * @param {{ username: string, password: string, uid?: number, scenario?: string, sessionCookieValue?: string }|null} [options.login]
 *   when present, the login routes (`/user/login` GET/POST, `/user/<uid>`,
 *   `/search/node`, `/classified`) are served by the login model instead of
 *   the timeline; when absent, behaviour is byte-for-byte unchanged.
 *   `scenario` is one of `ok`, `validation_error`, `challenge_login_page`,
 *   `challenge_submit`, `challenge_classified`, `rate_limit_login_page`,
 *   `server_error_submit`, `not_entitled`, `hang_submit`, `no_session_cookie`,
 *   `slow_redirect`, `no_content_submit`, `stuck_after_redirect`, `flood`,
 *   `classified_anonymous`, `classified_vars_rewritten`, `classified_vars_scoped`.
 * @returns {object} the server handle
 */
export function createFixtureServer({
  timeline = TIMELINE,
  host = '127.0.0.1',
  port = 0,
  log = null,
  login = null,
} = {}) {
  /** Every request served, in order. */
  let requests = [];
  /** Per-URL request counters; the timeline index is the count, clamped. */
  const counters = new Map();
  /** Per-URL ETag of the version most recently served (for diagnostics). */
  const served = new Map();

  // --- The login model (prompt 4.11). Active only when `login` is present. ---
  /** Login sessions, keyed by session id (the `PHPSESSID` value). */
  const loginSessions = new Map();
  /** Seed for the deterministic session ids. */
  let loginIdCounter = 0;

  /** A fresh synthetic session id (never a real credential). */
  function randomLoginId() {
    loginIdCounter += 1;
    return createHash('sha256').update(`fixture-login-${loginIdCounter}-${Date.now()}`).digest('hex');
  }

  /** Parse a `Cookie` header into a name/value map. */
  function parseCookies(header) {
    const out = {};
    for (const part of String(header ?? '').split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return out;
  }

  /** Parse a `application/x-www-form-urlencoded` body into a name/value map. */
  function parseUrlEncoded(body) {
    const out = {};
    for (const [key, value] of new URLSearchParams(String(body ?? ''))) {
      out[key] = value;
    }
    return out;
  }

  /**
   * Collect a request body (the login POST is the only body this server reads).
   * Rejects if the connection closes before the body is complete (the
   * `hang_submit` scenario, where the browser is closed by the hard timeout
   * while the POST is still pending) so a pending read never hangs the handler.
   */
  function readBody(req, res) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
      req.on('error', (err) => finish(reject, err));
      res.on('close', () => finish(reject, new Error('request closed before body complete')));
    });
  }

  /** The login session a request refers to, or null. */
  function resolveLoginSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    // The `no_session_cookie` scenario issues the logged-in session under a
    // differently named cookie (`SSESS_fixture`), which the fixture honours
    // too: a request without either cookie is anonymous, whatever happened
    // server-side.
    const sid = cookies.PHPSESSID ?? cookies.SSESS_fixture;
    if (sid && loginSessions.has(sid)) return loginSessions.get(sid);
    return null;
  }

  /**
   * Record a login request: method, path without query, status, scenario, and
   * a `reason` when it is a decoy submit. The POST body is never recorded.
   * `hadSession` records whether the request carried a session cookie (a
   * boolean — never the value).
   */
  function recordLogin(req, status, reason = null) {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const cookies = parseCookies(req.headers.cookie);
    const entry = {
      method: req.method,
      url: pathname,
      status,
      at: new Date().toISOString(),
      scenario: login.scenario ?? 'ok',
      hadSession: Boolean(cookies.PHPSESSID || cookies.SSESS_fixture),
    };
    if (reason) entry.reason = reason;
    requests.push(entry);
    log?.(`${entry.at} ${req.method} ${pathname} ${status} login:${entry.scenario}${reason ? ` (${reason})` : ''}`);
  }

  /** A Cloudflare challenge: 403 with the 17-byte `error code: 1010` body. */
  function respondChallenge(req, res, status) {
    recordLogin(req, status);
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(fixtureBody('http/derived/cloudflare-1010.txt'));
  }

  /** A failed login: the form page again with a `.messages.error` block. */
  function serveLoginError(req, res, kind) {
    const message =
      kind === 'validation'
        ? 'Validation error, please try again. If this error persists, please contact the site administrator.'
        : kind === 'flood'
          ? 'Sorry, there have been more than 5 failed login attempts for this account. It is temporarily blocked.'
          : 'Sorry. Unrecognised username or password.';
    recordLogin(req, 200);
    const html = fixtureBody('http/derived/user-login.html')
      .replaceAll('{{FORM_TOKEN}}', '')
      .replaceAll('{{MESSAGES}}', `<div class="messages error">${message}</div>`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  /** `GET /user/login`: the form, a challenge, or a redirect when logged in. */
  async function loginGetLoginPage(req, res) {
    const scenario = login.scenario ?? 'ok';
    if (scenario === 'challenge_login_page') return respondChallenge(req, res, 403);
    if (scenario === 'rate_limit_login_page') {
      recordLogin(req, 429);
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '120' });
      res.end('rate limited');
      return;
    }
    const session = resolveLoginSession(req);
    if (session && session.loggedIn) {
      // The `slow_redirect` scenario delays the logged-in redirect, so a
      // client that does not wait for the resulting document to commit reads
      // the uid from the old login document (a false `login_failed`).
      if (login.scenario === 'slow_redirect') {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (login.scenario === 'stuck_after_redirect') {
        // The redirect target never answers: the document never commits, so
        // the module's 15 s commit limit must end the attempt before the
        // hard timeout.
        recordLogin(req, 0);
        return;
      }
      recordLogin(req, 302);
      res.writeHead(302, { Location: `/user/${session.uid}` });
      res.end();
      return;
    }
    // No valid logged-in session: an anonymous one, created or reused.
    const cookies = parseCookies(req.headers.cookie);
    const known = cookies.PHPSESSID && loginSessions.has(cookies.PHPSESSID);
    let sid;
    let formToken;
    if (known) {
      sid = cookies.PHPSESSID;
      formToken = loginSessions.get(sid).formToken;
    } else {
      sid = randomLoginId();
      formToken = `fixture-form-token-${sid}`;
      loginSessions.set(sid, { loggedIn: false, uid: 0, formToken });
    }
    recordLogin(req, 200);
    const html = fixtureBody('http/derived/user-login.html')
      .replaceAll('{{FORM_TOKEN}}', formToken)
      .replaceAll('{{MESSAGES}}', '');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': `PHPSESSID=${sid}; Max-Age=7776000; Path=/; HttpOnly`,
    });
    res.end(html);
  }

  /** `POST /user/login`: the scenarios, the decoy, the token, the credentials. */
  async function loginPostLogin(req, res) {
    const scenario = login.scenario ?? 'ok';
    if (scenario === 'challenge_submit') return respondChallenge(req, res, 403);
    if (scenario === 'hang_submit') {
      // The POST never answers; the hard timeout is what ends the attempt.
      recordLogin(req, 0);
      return;
    }
    if (scenario === 'no_content_submit') {
      // A POST that commits no new document: 204 with no body. The module
      // must classify it at once (transient, post=204) without waiting for a
      // document that will never commit.
      recordLogin(req, 204);
      res.writeHead(204);
      res.end();
      return;
    }
    if (scenario === 'server_error_submit') {
      recordLogin(req, 500);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('internal error');
      return;
    }
    if (scenario === 'flood') {
      // Drupal's flood control: after too many failed attempts the account is
      // temporarily blocked, and the POST answers 200 with the form re-rendered
      // and a `.messages.error` carrying the flood text.
      return serveLoginError(req, res, 'flood');
    }
    const fields = parseUrlEncoded(await readBody(req, res));
    const session = resolveLoginSession(req);
    // The decoy: an `op` other than `Log in` is the search form's submit.
    if (fields.op && fields.op !== 'Log in') {
      recordLogin(req, 302, 'decoy-submit');
      res.writeHead(302, { Location: '/search/node' });
      res.end();
      return;
    }
    const tokenOk =
      scenario !== 'validation_error' &&
      Boolean(session) &&
      fields['edit[form_token]'] === session.formToken;
    if (!tokenOk) return serveLoginError(req, res, 'validation');
    if (fields['edit[name]'] !== login.username || fields['edit[pass]'] !== login.password) {
      return serveLoginError(req, res, 'credentials');
    }
    const uid = login.uid ?? 226301;
    if (scenario === 'no_session_cookie') {
      // Success, but the `PHPSESSID` is not re-issued and the anonymous one
      // is cleared: the logged-in session is issued under a differently
      // named cookie (`SSESS_fixture`), which the fixture honours but the
      // module's `PHPSESSID`-only selection does not — so the page loads
      // and the cookie check (not the page) is what fails.
      if (session) {
        const cookies = parseCookies(req.headers.cookie);
        if (cookies.PHPSESSID) loginSessions.delete(cookies.PHPSESSID);
      }
      const sid = randomLoginId();
      loginSessions.set(sid, { loggedIn: true, uid, formToken: '' });
      recordLogin(req, 302);
      res.writeHead(302, {
        Location: '/user/login',
        'Set-Cookie': ['PHPSESSID=deleted; Max-Age=0; Path=/', `SSESS_fixture=${sid}; Path=/`],
      });
      res.end();
      return;
    }
    // Success: a new `PHPSESSID` (the session id is the cookie value, so the
    // browser's later requests resolve the stored session), plus the cookies
    // the live site sets on a successful login.
    const cookieValue = login.sessionCookieValue ?? randomLoginId();
    if (session) {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies.PHPSESSID) loginSessions.delete(cookies.PHPSESSID);
    }
    loginSessions.set(cookieValue, { loggedIn: true, uid, formToken: '' });
    recordLogin(req, 302);
    res.writeHead(302, {
      Location: '/user/login',
      'Set-Cookie': [
        `PHPSESSID=${cookieValue}; Max-Age=7776000; Path=/; HttpOnly`,
        'ozbuserhash=fixture-ozbuserhash; Path=/user',
        '_ga=GA1.1.test; Path=/',
        '__cf_bm=fixture-cf-bm; Path=/',
      ],
    });
    res.end();
  }

  /** `GET /user/<uid>`: the profile page when logged in, a 403 otherwise. */
  function loginGetProfile(req, res) {
    const session = resolveLoginSession(req);
    if (session && session.loggedIn) {
      recordLogin(req, 200);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fixtureBody('http/derived/user-profile.html'));
      return;
    }
    recordLogin(req, 403);
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fixtureBody('http/cls403.html'));
  }

  /** `GET /search/node`: a short search-results page (a decoy click, visible). */
  function loginGetSearch(req, res) {
    recordLogin(req, 200);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Search results | OzBargain</title></head><body><h2>Search results</h2><p>No results.</p></body></html>',
    );
  }

  /** `GET /classified`: the timeline page when logged in, a 403 otherwise. */
  function loginGetClassified(req, res) {
    const scenario = login.scenario ?? 'ok';
    if (scenario === 'challenge_classified') return respondChallenge(req, res, 403);
    const session = resolveLoginSession(req);
    if (scenario === 'not_entitled' || !session || !session.loggedIn) {
      recordLogin(req, 403);
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fixtureBody('http/cls403.html'));
      return;
    }
    recordLogin(req, 200);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (scenario === 'classified_anonymous') {
      // A good login, but /classified answers the anonymous page (uid 0):
      // the browser's session was not honoured on this request.
      res.end(fixtureBody('http/derived/classifieds-page-anon.html'));
      return;
    }
    if (scenario === 'classified_vars_rewritten') {
      // The logged-in page, plus a later inline script that rewrites the
      // runtime uid to a string (the script source keeps the integer).
      res.end(
        fixtureBody('http/classifieds-page.html') +
          '\n<script>OzB_vars.uid = String(OzB_vars.uid);</script>',
      );
      return;
    }
    if (scenario === 'classified_vars_scoped') {
      // The logged-in page with the session object declared `const`, so it
      // is a global lexical binding and not a `globalThis` property.
      res.end(fixtureBody('http/classifieds-page.html').replace('OzB_vars=', 'const OzB_vars=', 1));
      return;
    }
    res.end(fixtureBody('http/classifieds-page.html'));
  }

  /**
   * Dispatch a login route (async only for the POST body read). A handler
   * failure is answered 500 so a test never hangs on a broken fixture.
   */
  async function handleLoginRoute(req, res, route) {
    try {
      switch (route) {
        case 'login-page':
          await loginGetLoginPage(req, res);
          break;
        case 'login-submit':
          await loginPostLogin(req, res);
          break;
        case 'profile':
          loginGetProfile(req, res);
          break;
        case 'search':
          loginGetSearch(req, res);
          break;
        case 'classified':
          loginGetClassified(req, res);
          break;
      }
    } catch {
      recordLogin(req, 500);
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('fixture login error');
      } catch {
        // The response may already be sent (the hang scenario).
      }
    }
  }

  /**
   * Match a request to a login route, or null. Only called when `login` is
   * present; the non-login behaviour is untouched.
   */
  function matchLoginRoute(req) {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && pathname === '/user/login') return 'login-page';
    if (req.method === 'POST' && pathname === '/user/login') return 'login-submit';
    if (req.method === 'GET' && /^\/user\/\d+$/.test(pathname)) return 'profile';
    if (req.method === 'GET' && pathname === '/search/node') return 'search';
    if (req.method === 'GET' && pathname === '/classified') return 'classified';
    return null;
  }

  function fixtureBody(name) {
    return readFileSync(`${FIXTURES_DIR}${name}`, 'utf8');
  }

  function contentTypeFor(name) {
    if (name.endsWith('.html')) return 'text/html; charset=utf-8';
    return 'application/rss+xml; charset=utf-8';
  }

  function handle(req, res) {
    // The login model (prompt 4.11): active only when `login` is present. When
    // absent, `matchLoginRoute` is never called and behaviour is byte-for-byte
    // unchanged. `handle` stays synchronous so the non-login path is untouched.
    if (login) {
      const route = matchLoginRoute(req);
      if (route !== null) {
        void handleLoginRoute(req, res, route);
        return;
      }
    }
    const { key, page } = resolveKey(req.url);
    const ifNoneMatch = req.headers['if-none-match'] ?? null;
    const entry = {
      method: req.method,
      url: req.url,
      key,
      page,
      ifNoneMatch,
      at: new Date().toISOString(),
    };

    // Anything the corpus does not supply: a path off the map, or a page past
    // the two-page cap. Recorded (so a test can assert it never happens on a
    // normal run) and answered with a body that is not a feed. The cap is
    // tested first: "asked for page 2" is a more specific fact than "that URL
    // is not on the map".
    const list = key ? timeline[key] : null;
    const beyondCap = page !== null && page > MAX_PAGE;
    const offMap = beyondCap || !list;
    if (offMap) {
      const body = fixtureBody(PAGE_LIMIT_BODY);
      entry.status = 500;
      entry.fixture = PAGE_LIMIT_BODY;
      entry.reason = beyondCap ? 'page-beyond-cap' : 'unmapped-path';
      requests.push(entry);
      log?.(`${entry.at} ${req.url} 500 ${entry.reason}`);
      res.writeHead(500, { 'Content-Type': contentTypeFor(PAGE_LIMIT_BODY) });
      res.end(body);
      return;
    }

    const index = Math.min(counters.get(key) ?? 0, list.length - 1);
    counters.set(key, (counters.get(key) ?? 0) + 1);
    // A timeline entry is either a fixture file name (the corpus behaviour) or
    // an inline descriptor `{ body, status?, contentType?, fixture? }` so a test
    // can serve arbitrary (malformed) content over a real socket without adding
    // files to the corpus.
    const item = list[index];
    let name;
    let body;
    let contentType;
    let status = 200;
    if (typeof item === 'string') {
      name = item;
      body = fixtureBody(name);
      contentType = contentTypeFor(name);
    } else {
      name = item.fixture ?? 'inline';
      body = item.body ?? '';
      contentType = item.contentType ?? 'text/html; charset=utf-8';
      if (item.status !== undefined) status = item.status;
    }
    const etag = etagFor(body);
    entry.fixture = name;
    entry.index = index;

    // A real conditional request: the client echoes the ETag it stored, and a
    // match is answered 304 with no body and no re-serialisation. (Only a
    // 200-class entry is eligible for a 304; an inline non-200 is served as-is.)
    if (ifNoneMatch && ifNoneMatch === etag && status === 200) {
      entry.status = 304;
      requests.push(entry);
      log?.(`${entry.at} ${req.url} 304 (${name})`);
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }

    entry.status = status;
    served.set(key, etag);
    requests.push(entry);
    log?.(`${entry.at} ${req.url} ${status} (${name})`);
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(body, 'utf8'),
      ETag: etag,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  }

  const server = createServer(handle);

  // Track live connections so close() can destroy them. Node's http.Server.close()
  // waits for every open connection to end, and the application's fetch (undici)
  // keeps its keep-alive connection open after the response — so without this,
  // close() hangs forever and the test process never exits.
  const liveConnections = new Set();
  server.on('connection', (socket) => {
    liveConnections.add(socket);
    socket.on('close', () => liveConnections.delete(socket));
  });

  return {
    /** The requests served so far (a copy). */
    get requests() {
      return [...requests];
    },
    /** The bind origin, once started. */
    origin: null,
    /** The bound port, once started. */
    port: null,
    /** The address the server bound to, once started. */
    host: null,
    /** The ETag most recently served per URL key (diagnostics). */
    get servedEtags() {
      return Object.fromEntries(served);
    },
    /**
     * Start listening. Resolves with the origin.
     * @returns {Promise<string>}
     */
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      this.host = address.address;
      this.port = address.port;
      this.origin = `http://${address.address}:${address.port}`;
      return this.origin;
    },
    /**
     * Forget the request log and rewind the timeline. A test that wants to
     * replay poll 1 from scratch calls this rather than restarting the server
     * (the port is already known to the application under test).
     */
    reset() {
      requests = [];
      counters.clear();
      served.clear();
      loginSessions.clear();
      loginIdCounter = 0;
    },
    /**
     * The config a caller points the application at.
     * @returns {{ OZB_DEALS_FEED_URL: string, OZB_FRONT_FEED_URL: string, OZB_CLASSIFIEDS_URL: string }}
     */
    appConfig() {
      if (!this.origin) throw new Error('fixture server: call start() before appConfig()');
      return {
        OZB_DEALS_FEED_URL: `${this.origin}${DEALS_PATH}`,
        OZB_FRONT_FEED_URL: `${this.origin}${FRONT_PATH}`,
        OZB_CLASSIFIEDS_URL: `${this.origin}${CLASSIFIEDS_PATH}`,
      };
    },
    /**
     * The requests the application made for one poll cycle, in order: deals
     * page 0, deals page 1, the front page. Used by the cycle assertions.
     * @param {number} cycle 1-based cycle number
     * @returns {object[]}
     */
    cycleRequests(cycle) {
      return requests.slice((cycle - 1) * 3, cycle * 3);
    },
    /** Stop listening. Destroys live connections first (the application's
     *  keep-alive socket) so the close does not hang. */
    async close() {
      if (!server.listening) return;
      for (const socket of liveConnections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Start a fixture server and return it (convenience for tests).
 * @param {object} [options] passed to `createFixtureServer`
 * @returns {Promise<object>} the started server
 */
export async function startFixtureServer(options = {}) {
  const server = createFixtureServer(options);
  await server.start();
  return server;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '0' },
      host: { type: 'string', default: '127.0.0.1' },
      login: { type: 'boolean', default: false },
    },
  });
  const server = await startFixtureServer({
    host: values.host,
    port: Number.parseInt(values.port, 10),
    log: (line) => console.log(line),
    login: values.login ? { username: 'dev', password: 'dev-password' } : null,
  });
  console.log(`fixture server listening on ${server.origin}`);
  if (values.login) {
    console.log('  login enabled: username=dev password=dev-password');
  }
  console.log(`  OZB_DEALS_FEED_URL=${server.appConfig().OZB_DEALS_FEED_URL}`);
  console.log(`  OZB_FRONT_FEED_URL=${server.appConfig().OZB_FRONT_FEED_URL}`);
  console.log(`  OZB_CLASSIFIEDS_URL=${server.appConfig().OZB_CLASSIFIEDS_URL}`);
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
