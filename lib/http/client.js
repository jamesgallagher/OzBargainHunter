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
 *   clock: { now(): Date, advance(ms: number): Promise<void> },
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

  // The pause between requests is taken from the clock (the wait seam), not
  // by sleeping in tests: clock.advance() moves a fixed clock forward and a
  // system clock by a real sleep.
  async function pauseBetweenRequests() {
    if (lastRequestAt === null) return; // first request: no pause yet
    const pauseMs = DEFAULT_PAUSE_SECONDS * 1000;
    const elapsed = clock.now().getTime() - lastRequestAt.getTime();
    const remaining = pauseMs - elapsed;
    if (remaining > 0) {
      await clock.advance(remaining);
    }
  }

  // Exponential backoff with jitter drawn from the injected random. The base
  // component doubles each consecutive failure (2, 4, 8, …); the jitter is in
  // [0, 1), so the delivered sequence is strictly increasing.
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
   * @param {{ cookie?: string }} [options] request options; `cookie` is sent
   *   as the `Cookie` header when present (M1: the classifieds poll sends the
   *   stored account cookie here).
   * @returns {Promise<{ class: string, status: number, body: string, retryAfterSeconds?: number }>}
   */
  async function request(url, options = {}) {
    if (blocked) {
      throw new BlockedError();
    }

    assertAllowed(url);

    if (inFlight) {
      throw new Error('One request at a time; a request is already in flight');
    }
    inFlight = true;

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
      // M1: a supplied cookie is sent on the request. This is the consumer for
      // the screen-9 account-cookie setting: the classifieds poll passes the
      // stored cookie here so the request actually carries the session.
      if (options.cookie) {
        headers['cookie'] = options.cookie;
      }

      let response;
      try {
        response = await transport.fetch(url, { headers });
      } catch (err) {
        // A failure below the HTTP layer — a timeout, connection error or
        // TLS error (design 3.5's "Timeout / connection error" class). This
        // is not a classifyResponse input, so the post-response wait block
        // never runs for it; back off here instead (design 3.3: "all other
        // failures back off exponentially with jitter"). Log the failure,
        // then rethrow so the caller sees the transport error.
        const delay = computeBackoffDelay();
        await clock.advance(delay * 1000);
        log(`${clock.now().toISOString()} ${url} transport_error ${err?.message ?? err}`);
        throw err;
      }

      const classified = classifyResponse(response);

      // Update feed_state on a 200; reset the backoff on success.
      if (classified.class === 'ok') {
        const etag = response.headers?.['etag'] ?? null;
        const lastModified = response.headers?.['last-modified'] ?? null;
        if (store.setFeedState && (etag || lastModified)) {
          store.setFeedState(url, etag, lastModified);
        }
        backoffSeconds = 0;
      }

      // A Cloudflare block latches the client off. It is never treated as
      // transient and is not retried — the caller clears it explicitly.
      if (classified.class === 'cloudflare_block') {
        blocked = true;
      }

      // Post-response wait, taken from the clock (the wait seam).
      //  - 429/503: honour Retry-After when present; otherwise back off.
      //  - transient (5xx / timeout): exponential backoff with jitter.
      //  - 403 (permission_denied / cloudflare_block): never retried quickly
      //    (design 3.3 / 3.6) — no backoff here.
      if (classified.class === 'rate_limited') {
        if (classified.retryAfterSeconds !== undefined) {
          // Clamp to >= 0: a negative Retry-After must not rewind the clock.
          const waitSeconds = Math.max(0, classified.retryAfterSeconds);
          await clock.advance(waitSeconds * 1000);
        } else {
          await clock.advance(computeBackoffDelay() * 1000);
        }
      } else if (classified.class === 'transient') {
        await clock.advance(computeBackoffDelay() * 1000);
      }

      // A 304 leaves feed_state untouched (no update needed).

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
      // Stamp the pause anchor on EVERY path (clean 200, transport rejection,
      // and a post-response throw) so the next request's inter-request pause
      // is never lost. Stamping in the finally — after the post-response
      // wait has already advanced the clock — means the anchor is the instant
      // this request finished, so the pause is measured from the end of the
      // prior request, not from before its backoff.
      lastRequestAt = clock.now();
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

  /**
   * Drop the cached conditional-request validators (ETag / Last-Modified) for
   * one URL, so the next request for it goes out without `If-None-Match` /
   * `If-Modified-Since` and is answered 200 with a full body instead of 304.
   *
   * The unparseable-200 path calls this: a body we could not parse must not
   * be "confirmed" by a validator, because the next poll's 304 would then
   * resolve the session from the last *known* uid and hide the repeated bad
   * body behind the 304. Valid 200s keep their validators untouched.
   *
   * Uses the existing nullable `feed_state` storage (both columns are
   * nullable; a row with null validators is equivalent to no row — the
   * request builder skips a null etag/last-modified), so no schema or new
   * store method is needed.
   * @param {string} url
   */
  function forgetValidators(url) {
    if (store.setFeedState) {
      store.setFeedState(url, null, null);
    }
  }

  return {
    request,
    clearBlock,
    forgetValidators,
    get blocked() {
      return blocked;
    },
    get backoffDelays() {
      return [...backoffDelays];
    },
  };
}

export { DENY_LIST, DEFAULT_PAUSE_SECONDS, BASE_BACKOFF_SECONDS };
