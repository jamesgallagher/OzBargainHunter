/**
 * DEV-ONLY mock transport.
 *
 * When `OZB_DEV_MOCK_TRANSPORT` is set to a truthy value (1/true/yes/on) and
 * `NODE_ENV` is not `production`, the worker substitutes this transport for
 * the real one, so a local dev worker never queries the live OzBargain site.
 * It serves the four poll URLs (deals page 0, deals page 1, the front feed,
 * and the classifieds page) from the committed HTTP fixtures and performs no
 * network I/O — it never calls `globalThis.fetch`.
 *
 * It is inert in production: the container sets `NODE_ENV=production`, so the
 * flag never takes effect there. The check is a plain environment read (no
 * I/O, no crypto), mirroring `lib/web/dev-bypass.js`.
 *
 * The four URLs are built with the same `buildDealPollUrls` the real poll
 * uses, so the mock stays in lockstep with the URLs the worker actually
 * requests. A request for any URL outside those four throws, exactly like the
 * test fixture transport: it is how a dev run proves the worker only ever
 * asks for the four expected endpoints.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDealPollUrls } from '../acquire/poll.js';

/** The set of values that enable the dev mock transport. */
const TRUTHY = /^(1|true|yes|on)$/i;

/** The fixtures directory, resolved from this module (not from `cwd`). */
const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/http');

/**
 * Whether the dev-only mock transport is active for this environment.
 * @param {object} [env] the environment map (defaults to `process.env`)
 * @returns {boolean}
 */
export function isDevMockTransport(env = process.env) {
  const flag = String(env.OZB_DEV_MOCK_TRANSPORT ?? '');
  if (!TRUTHY.test(flag)) return false;
  // Inert in production: the flag only applies outside the production runtime.
  if (String(env.NODE_ENV ?? '') === 'production') return false;
  return true;
}

/**
 * Build the dev-only mock transport. Serves the four poll URLs from the
 * committed fixtures and performs no network I/O.
 * @param {object} [config] the validated config (9.1)
 * @returns {{ fetch(url: string, options?: object): Promise<object>, requestLog: object[] }}
 */
export function createDevMockTransport(config = {}) {
  const dealUrls = buildDealPollUrls(config);
  const classifiedsUrl = config?.OZB_CLASSIFIEDS_URL ?? 'https://www.ozbargain.com.au/classified';

  // The four URLs the worker requests, mapped to their committed fixtures.
  // A 200 with no validators (no etag / last-modified): the client always
  // gets a full body and never a 304, so dev polls are deterministic.
  const routes = new Map([
    [dealUrls[0], { status: 200, fixture: 'r0.xml' }],
    [dealUrls[1], { status: 200, fixture: 'r1.xml' }],
    [dealUrls[2], { status: 200, fixture: 'feed_feed.xml' }],
    [classifiedsUrl, { status: 200, fixture: 'classifieds-page.html' }],
  ]);

  const requestLog = [];

  return {
    requestLog,
    async fetch(url, options = {}) {
      const route = routes.get(url);
      if (!route) {
        throw new Error(`DevMockTransport: no route for URL "${url}"`);
      }
      requestLog.push({ url, options });
      const body = readFileSync(resolve(FIXTURES_DIR, route.fixture), 'utf8');
      return {
        status: route.status,
        headers: {},
        body,
        bytes: Buffer.byteLength(body, 'utf8'),
      };
    },
  };
}
