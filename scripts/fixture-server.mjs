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
 * @returns {object} the server handle
 */
export function createFixtureServer({
  timeline = TIMELINE,
  host = '127.0.0.1',
  port = 0,
  log = null,
} = {}) {
  /** Every request served, in order. */
  let requests = [];
  /** Per-URL request counters; the timeline index is the count, clamped. */
  const counters = new Map();
  /** Per-URL ETag of the version most recently served (for diagnostics). */
  const served = new Map();

  function fixtureBody(name) {
    return readFileSync(`${FIXTURES_DIR}${name}`, 'utf8');
  }

  function contentTypeFor(name) {
    if (name.endsWith('.html')) return 'text/html; charset=utf-8';
    return 'application/rss+xml; charset=utf-8';
  }

  function handle(req, res) {
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
    },
  });
  const server = await startFixtureServer({
    host: values.host,
    port: Number.parseInt(values.port, 10),
    log: (line) => console.log(line),
  });
  console.log(`fixture server listening on ${server.origin}`);
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
