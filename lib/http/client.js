import { classifyResponse } from './classify.js';
import { createGate } from '../gate/index.js';

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
// The 60 s in-request wait cap (design 3.7): a transient/transport failure
// waits at most this long in-request; anything longer is the gate's job
// (it cools the whole app instead).
const MAX_IN_REQUEST_WAIT_MS = 60_000;
// The backoff exponent is clamped so the base (2 × 2^n) can never outrun
// the cap: at n = 5 the base is 64 s, and with the jitter in [0, 1) the
// delivered delay is clamped to 60 s.
const MAX_BACKOFF_EXPONENT = 5;

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
 *   gate?: object,
 * }} deps
 * @returns {object}
 */
export function createOzbClient(deps) {
  const { transport, store, clock, random, config, log = console.log } = deps;

  // The persisted access gate (design 3.7). Every request passes through
  // `gate.check()`; every response is fed back through
  // `gate.recordResponse()`. When the caller (the worker) builds one gate
  // and shares it across the deal and classifieds polls, that gate is used
  // here; a caller that does not supply a gate (the acquisition test
  // fixture) gets one over the same store, so the discipline holds either
  // way and the state survives restarts.
  const gate = deps.gate ?? createGate({ store, clock, config, log });

  let lastRequestAt = null;
  let backoffSeconds = 0;
  const backoffDelays = [];
  // One request at a time, serialized: a request that arrives while another is
  // in flight waits for it to finish, then proceeds (never two in flight).
  // The client is shared by the deal and classifieds polls, which can fire at
  // the same instant; queueing (rather than rejecting) is what keeps both
  // polls from starving each other.
  let chain = Promise.resolve();

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
    // loadConfig sets the override only when NODE_ENV is test.
    const pauseMs = config?.OZB_REQUEST_PAUSE_MS_TEST_OVERRIDE ?? DEFAULT_PAUSE_SECONDS * 1000;
    const elapsed = clock.now().getTime() - lastRequestAt.getTime();
    const remaining = pauseMs - elapsed;
    if (remaining > 0) {
      await clock.advance(remaining);
    }
  }

  // Exponential backoff with jitter drawn from the injected random. The base
  // component doubles each consecutive failure (2, 4, 8, …) up to the
  // exponent clamp; the jitter is in [0, 1), so the delivered sequence is
  // strictly increasing until it hits the 60 s in-request cap (design 3.7),
  // and the CAPPED delay is what gets recorded.
  function computeBackoffDelay() {
    const base = BASE_BACKOFF_SECONDS * Math.pow(2, Math.min(backoffSeconds, MAX_BACKOFF_EXPONENT));
    const jitter = random.next();
    let delay = base + jitter;
    if (delay > MAX_IN_REQUEST_WAIT_MS / 1000) {
      delay = MAX_IN_REQUEST_WAIT_MS / 1000;
    }
    backoffDelays.push(delay);
    backoffSeconds += 1;
    return delay;
  }

  /**
   * Fetch a URL, honouring the deny list, the persisted access gate,
   * conditional requests, and the capped in-request backoff. Requests are
   * serialized: a request that arrives while another is in flight waits for
   * it to finish, then proceeds — never two in flight, and a concurrent
   * caller is queued rather than rejected (the client is shared by the deal
   * and classifieds polls, which can fire at the same instant).
   * @param {string} url
   * @param {{ cookie?: string, surface?: string }} [options] request options;
   *   `cookie` is sent as the `Cookie` header when present (M1: the
   *   classifieds poll sends the stored account cookie here); `surface` is
   *   the gate's surface label ('deals' / 'classifieds').
   * @returns {Promise<{ class: string, status: number, body: string, retryAfterSeconds?: number }>}
   */
  async function request(url, options = {}) {
    assertAllowed(url);
    // The access gate (design 3.7): a closed gate (cooling / stopped)
    // refuses every request; probing allows exactly the probe URL, once.
    // A refused request throws before queuing and never reaches the
    // transport. `gateState` marks a gate refusal so the caller (the
    // poller) can tell it apart from a Cloudflare block that actually
    // happened on a request.
    const verdict = gate.check(url);
    if (!verdict.allowed) {
      const err = new BlockedError();
      err.gateState = verdict.state;
      throw err;
    }
    // Serialize: run only after the previous request has settled. The chain is
    // kept alive across throws so a rejected request cannot wedge every later
    // one.
    const run = chain.then(() => executeRequest(url, options));
    chain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * The body of a request, run while it holds the single in-flight slot.
   * @param {string} url
   * @param {{ cookie?: string, surface?: string }} [options]
   */
  async function executeRequest(url, options = {}) {
    // Re-check the gate: the state may have changed while this request was
    // queued behind an in-flight request. We deliberately do NOT re-run
    // `gate.check()` here: the fast path already consumed the probe
    // (probe_used = 1) when it granted it, and check() would then refuse
    // the probe request itself. The probe case is safe to let through —
    // either this request's own fast path consumed the probe, or the fast
    // path saw the gate open and a lazy transition since left probe_used =
    // 0, in which case this request is the probe.
    const st = gate.read().state;
    if (st === 'cooling' || st === 'stopped' || (st === 'probing' && url !== gate.probeUrl)) {
      const err = new BlockedError();
      err.gateState = st;
      throw err;
    }

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
        // never runs for it; back off here instead — capped at 60 s
        // in-request (design 3.7), then recorded into the gate (a failing
        // deals cycle is what eventually cools the app). Log the failure,
        // then rethrow so the caller sees the transport error.
        const delay = computeBackoffDelay();
        await clock.advance(delay * 1000);
        gate.recordTransportError({ surface: options.surface ?? 'deals' });
        log(`${clock.now().toISOString()} ${url} transport_error ${err?.message ?? err}`);
        throw err;
      }

      const classified = classifyResponse(response);

      // Feed the response class into the gate before any post-200 work, so
      // an ok is recorded even if the feed_state write below throws.
      gate.recordResponse({
        class: classified.class,
        surface: options.surface ?? 'deals',
        retryAfterSeconds: classified.retryAfterSeconds,
      });

      // Update feed_state on a 200; reset the backoff on success.
      if (classified.class === 'ok') {
        const etag = response.headers?.['etag'] ?? null;
        const lastModified = response.headers?.['last-modified'] ?? null;
        if (store.setFeedState && (etag || lastModified)) {
          store.setFeedState(url, etag, lastModified);
        }
        backoffSeconds = 0;
      }

      // In-request wait, taken from the clock (the wait seam).
      //  - transient (5xx / timeout): capped exponential backoff with
      //    jitter (design 3.7: at most 60 s in-request; longer waits are
      //    the gate's job).
      //  - rate_limited (429/503): NO in-request wait — the gate cools
      //    instead (design 3.7); Retry-After is fed to the gate, not
      //    awaited here.
      //  - 403 (permission_denied / cloudflare_block): never retried quickly
      //    (design 3.3 / 3.6) — no backoff here.
      if (classified.class === 'transient') {
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
    }
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
    forgetValidators,
    get blocked() {
      // The gate, not a latch: closed (cooling / stopped) reads as blocked;
      // probing also reads as blocked (only the probe URL is allowed).
      return !gate.isOpen();
    },
    get backoffDelays() {
      return [...backoffDelays];
    },
  };
}

export { DENY_LIST, DEFAULT_PAUSE_SECONDS, BASE_BACKOFF_SECONDS, MAX_IN_REQUEST_WAIT_MS };
