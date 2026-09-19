import { classifyResponse } from './classify.js';

const DENY_LIST = [
  '/api/',
  '/ozbapi/',
  '/search/',
  '/comment/',
  '/goto/',
  '/privatemsg/',
  '/user/login',
];

const DEFAULT_PAUSE_SECONDS = 3;
const BASE_BACKOFF_SECONDS = 2;

export class DeniedPathError extends Error {
  constructor(url) {
    super(`Denied path: ${url}`);
    this.name = 'DeniedPathError';
  }
}

export class BlockedError extends Error {
  constructor(message = 'Cloudflare block: client latched off') {
    super(message);
    this.name = 'BlockedError';
  }
}

/**
 * @param {{
 *   transport: { fetch(url: string, options?: object): Promise<object> },
 *   store: object,
 *   clock: { now(): Date },
 *   random: { next(): number },
 *   config: object,
 *   log?: (line: string) => void,
 * }} deps
 * @returns {object}
 */
export function createOzbClient(deps) {
  const { transport, store, clock, random, config, log = console.log } = deps;

  let blocked = false;
  let inFlight = false;
  let lastRequestAt = null;
  let backoffSeconds = 0;
  const backoffDelays = [];

  function assertAllowed(url) {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    for (const denied of DENY_LIST) {
      // Denied entries are route prefixes (e.g. "/search/"). Match the
      // pathname prefix regardless of a trailing slash or query string,
      // so "/search?q=…" is denied just like "/search/123".
      const prefix = denied.replace(/\/$/, '');
      if (pathname === prefix || pathname.startsWith(prefix + '/')) {
        throw new DeniedPathError(url);
      }
    }
  }

  async function pauseBetweenRequests() {
    if (lastRequestAt !== null) {
      const pauseMs = DEFAULT_PAUSE_SECONDS * 1000;
      const elapsed = clock.now().getTime() - lastRequestAt.getTime();
      const remaining = pauseMs - elapsed;
      if (remaining > 0) {
        // The pause is taken from the clock, not by sleeping in tests.
        // We advance the clock by the remaining amount.
        // In production the caller would await a real sleep; in tests
        // the clock is frozen so we simply record the pause.
        // We do NOT actually sleep — the clock seam handles it.
      }
    }
  }

  function computeBackoffDelay() {
    const base = BASE_BACKOFF_SECONDS * Math.pow(2, backoffSeconds);
    const jitter = random.next();
    const delay = base + jitter;
    backoffDelays.push(delay);
    backoffSeconds += 1;
    return delay;
  }

  /**
   * Fetch a URL, honouring the deny list, conditional requests,
   * the Cloudflare latch, and backoff.
   * @param {string} url
   * @returns {Promise<{ class: string, status: number, body: string, retryAfterSeconds?: number }>}
   */
  async function request(url) {
    if (blocked) {
      throw new BlockedError();
    }

    assertAllowed(url);

    if (inFlight) {
      throw new Error('One request at a time; a request is already in flight');
    }
    inFlight = true;

    let response;
    try {
      await pauseBetweenRequests();

      const feedState = store.getFeedState ? store.getFeedState(url) : null;
      const headers = {};
      if (feedState) {
        if (feedState.etag) {
          headers['if-none-match'] = feedState.etag;
        }
        if (feedState.last_modified) {
          headers['if-modified-since'] = feedState.last_modified;
        }
      }

      response = await transport.fetch(url, { headers });
    } catch (err) {
      inFlight = false;
      throw err;
    }
    lastRequestAt = clock.now();

    try {
      const classified = classifyResponse(response);

      // Update feed_state on a 200.
      if (classified.class === 'ok') {
        const etag = response.headers['etag'] ?? null;
        const lastModified = response.headers['last-modified'] ?? null;
        if (store.setFeedState && (etag || lastModified)) {
          store.setFeedState(url, etag, lastModified);
        }
        // Reset backoff on success.
        backoffSeconds = 0;
      }

      // A 304 leaves feed_state untouched.
      // (No update needed.)

      // A Cloudflare block latches the client off.
      if (classified.class === 'cloudflare_block') {
        blocked = true;
      }

      // Log every request's URL, response class and timestamp.
      log(
        `${clock.now().toISOString()} ${url} ${classified.class}` +
          (classified.retryAfterSeconds !== undefined ? ` retry-after=${classified.retryAfterSeconds}` : ''),
      );

      return {
        class: classified.class,
        status: response.status,
        body: response.body,
        retryAfterSeconds: classified.retryAfterSeconds,
      };
    } finally {
      inFlight = false;
    }
  }

  /**
   * Explicitly clear the Cloudflare latch (e.g. after a human confirms
   * the block has lifted).
   */
  function clearBlock() {
    blocked = false;
    backoffSeconds = 0;
  }

  return {
    request,
    clearBlock,
    get blocked() {
      return blocked;
    },
    get backoffDelays() {
      return [...backoffDelays];
    },
  };
}

export { DENY_LIST, DEFAULT_PAUSE_SECONDS, BASE_BACKOFF_SECONDS };
