import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Fixture transport — the substitute every test uses.
 * Maps an exact URL string to a response descriptor. A request for a URL
 * the map does not contain throws. That is deliberate: it is how later
 * cards prove the poller never asks for page 2.
 *
 * @param {Record<string, object>} routes
 *   Each value: { status, headers?, body?, fixture? }
 *   `body` is a string; `fixture` is a path under fixtures/.
 * @returns {{ fetch(url: string, options?: object): Promise<object>, calls: number, requestLog: object[] }}
 */
export function createFixtureTransport(routes) {
  let calls = 0;
  const requestLog = [];

  return {
    get calls() {
      return calls;
    },
    requestLog,
    async fetch(url, options = {}) {
      calls += 1;
      // Record the URL, the options, and (after the route is resolved) the
      // status the route serves. Recording the status is what makes a
      // mid-cycle 304 observable: `poll_state` holds a single class (the
      // last one), so the only place a per-URL 304 can be asserted is here.
      const entry = { url, options };
      requestLog.push(entry);

      const route = routes[url];
      if (!route) {
        throw new Error(`FixtureTransport: no route for URL "${url}"`);
      }
      entry.status = route.status;

      let body = '';
      if (route.body !== undefined) {
        body = route.body;
      } else if (route.fixture !== undefined) {
        const fixturePath = resolve('fixtures', route.fixture);
        body = readFileSync(fixturePath, 'utf8');
      }

      const headers = {};
      for (const [key, value] of Object.entries(route.headers ?? {})) {
        headers[key.toLowerCase()] = value;
      }

      return {
        status: route.status,
        headers,
        body,
        bytes: Buffer.byteLength(body, 'utf8'),
      };
    },
  };
}
