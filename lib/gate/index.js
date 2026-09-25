import { apply, defaultGate, b1LookbackMs } from './rules.js';

/**
 * The persisted access gate (design 3.7). Every OzBargain request passes
 * through `check()`; every response and every failing deals cycle is fed
 * back through `recordResponse()` / `recordTransportError()` /
 * `recordDealsCycle()`. The state lives in the store's `access_gate` row
 * (one transaction per transition), so a back-off survives restarts: a
 * fresh process reading the same database file sees the same state.
 *
 * The state machine itself is pure (`rules.js`); this module adds the
 * persistence, the clock, the B1 lookback (which needs the events table)
 * and the per-event log line. Everything is synchronous: `node:sqlite`
 * and `clock.now()` are both synchronous.
 *
 * The 60 s in-request wait cap is NOT here: the gate never makes the
 * caller wait. A `rate_limited` response cools the gate instead of
 * waiting in-request, and a transient/transport failure's in-request
 * backoff is capped by the client (design 3.7).
 */

/**
 * @param {object} deps
 * @param {object} deps.store the store (needs `getGate`,
 *   `applyGateTransition`, `getGateEvents`, `countGateEvents`)
 * @param {object} deps.clock `{ now(): Date }`
 * @param {object} [deps.config] the config (for the settings and the
 *   probe URL; defaults match `loadConfig`'s)
 * @param {function} [deps.log] `(line: string) => void`
 * @returns {object} the gate API (design 4.4)
 */
export function createGate({ store, clock, config = {}, log = () => {} }) {
  const settings = {
    b1MinHours: config.OZB_GATE_B1_MIN_HOURS ?? 24,
    b1RepeatDays: config.OZB_GATE_B1_REPEAT_DAYS ?? 7,
    b2BaseMinutes: config.OZB_GATE_B2_BASE_MINUTES ?? 15,
    b5CapHours: config.OZB_GATE_B5_CAP_HOURS ?? 6,
    pollIntervalMs: (config.OZB_POLL_INTERVAL_SECONDS ?? 300) * 1000,
  };

  // The probe is the deals feed page 0, built exactly like the poller
  // builds it (design 3.7: "the deals feed page 0 URL, once").
  const probeUrl = (() => {
    const u = new URL(config.OZB_DEALS_FEED_URL ?? 'https://www.ozbargain.com.au/deals/feed');
    u.searchParams.set('page', '0');
    return u.toString();
  })();

  /**
   * The one log line per event, e.g.
   * `2026-09-25T04:00:00.000Z gate open→cooling B2 tier 1 until 2026-09-25T04:15:00.000Z (rate_limited on deals feed)`.
   * The reason is short fixed text (class + surface); it never carries a
   * body, URL query, cookie or header (design 3.7).
   */
  function logEvent(event) {
    const parts = [event.at, `gate ${event.from_state}→${event.to_state}`];
    if (event.rule) parts.push(event.rule);
    if (event.tier !== null && event.tier !== undefined) parts.push(`tier ${event.tier}`);
    if (event.until_at) parts.push(`until ${event.until_at}`);
    if (event.min_resume_at) parts.push(`min_resume_at ${event.min_resume_at}`);
    if (event.reason) parts.push(`(${event.reason})`);
    log(parts.join(' '));
  }

  /**
   * Read the gate row, applying the lazy `cooling` → `probing`
   * transition when the instant is at or past `until_at`. The transition
   * is idempotent (the machine no-ops a gate that is already probing),
   * so two reads after `until_at` write exactly one event.
   * @returns {object} the current gate row
   */
  function read() {
    const gate = store.getGate() ?? defaultGate();
    if (gate.state === 'cooling' && gate.until_at && clock.now().getTime() >= Date.parse(gate.until_at)) {
      const { gate: next, events, changed } = apply(gate, { kind: 'cooling_expired' }, clock.now().getTime(), settings);
      if (changed) {
        store.applyGateTransition(next, events);
        for (const event of events) logEvent(event);
        return next;
      }
    }
    return gate;
  }

  /**
   * Gate a request (design 4.4). Open: allowed. Probing: allowed only for
   * the probe URL, once — `probe_used` is set to 1 in the same
   * transaction that lets the probe through, so a restart between the
   * check and the request cannot replay the probe. Closed (cooling /
   * stopped): not allowed.
   * @param {string} url
   * @returns {{ allowed: boolean, state: string, probe: boolean }}
   */
  function check(url) {
    const gate = read();
    if (gate.state === 'open') {
      return { allowed: true, state: 'open', probe: false };
    }
    if (gate.state === 'probing') {
      const allowed = url === probeUrl && !gate.probe_used;
      if (allowed) {
        // Same transaction as the check: the probe is consumed the moment
        // it is granted (design 3.7: "once").
        store.applyGateTransition({ ...gate, probe_used: 1 }, []);
      }
      return { allowed, state: 'probing', probe: allowed };
    }
    return { allowed: false, state: gate.state, probe: false };
  }

  /** @returns {boolean} true only while the gate is open (false in probing) */
  function isOpen() {
    return read().state === 'open';
  }

  /** @returns {'open'|'probe'|'closed'} the mode for the pollers */
  function mode() {
    const state = read().state;
    if (state === 'open') return 'open';
    if (state === 'probing') return 'probe';
    return 'closed';
  }

  /**
   * Feed a classified response back into the gate (design 4.4). The class
   * maps straight onto a signal kind; `cloudflare_block` carries the B1
   * lookback count, which needs the events table (the pure machine has
   * no store). A no-op signal is not written (no event, no write).
   * @param {object} r
   * @param {string} r.class the response class
   * @param {string} r.surface 'deals' or 'classifieds'
   * @param {number} [r.retryAfterSeconds]
   */
  function recordResponse({ class: cls, surface, retryAfterSeconds }) {
    const nowMs = clock.now().getTime();
    const signal = { kind: cls, surface, retryAfterSeconds };
    if (cls === 'cloudflare_block') {
      const sinceIso = new Date(nowMs - b1LookbackMs(settings)).toISOString();
      signal.recentB1Count = store.countGateEvents({ rule: 'B1', toState: 'stopped', sinceIso });
    }
    const { gate, events, changed } = apply(read(), signal, nowMs, settings);
    if (changed) {
      store.applyGateTransition(gate, events);
      for (const event of events) logEvent(event);
    }
  }

  /**
   * Feed a transport failure (timeout/connection error) back into the
   * gate (design 4.4).
   * @param {object} r
   * @param {string} r.surface
   */
  function recordTransportError({ surface }) {
    recordResponse({ class: 'transport_error', surface });
  }

  /**
   * Feed the outcome of a deals cycle back into the gate (design 4.4).
   * @param {object} r
   * @param {boolean} r.reachedDealsFeed
   * @param {number} r.transientFailures
   */
  function recordDealsCycle({ reachedDealsFeed, transientFailures }) {
    const nowMs = clock.now().getTime();
    const { gate, events, changed } = apply(
      read(),
      { kind: 'deals_cycle', reachedDealsFeed, transientFailures },
      nowMs,
      settings,
    );
    if (changed) {
      store.applyGateTransition(gate, events);
      for (const event of events) logEvent(event);
    }
  }

  /**
   * The manual resume (design 4.4). Allowed only from `stopped`, and not
   * before `min_resume_at`.
   * @returns {{ ok: true } | { ok: false, reason: 'not_stopped'|'too_early', minResumeAt?: string }}
   */
  function resume() {
    const gate = read();
    if (gate.state !== 'stopped') {
      return { ok: false, reason: 'not_stopped' };
    }
    if (gate.min_resume_at && clock.now().getTime() < Date.parse(gate.min_resume_at)) {
      return { ok: false, reason: 'too_early', minResumeAt: gate.min_resume_at };
    }
    const { gate: next, events, changed } = apply(gate, { kind: 'resume' }, clock.now().getTime(), settings);
    if (changed) {
      store.applyGateTransition(next, events);
      for (const event of events) logEvent(event);
    }
    return { ok: true };
  }

  /**
   * @param {object} [params]
   * @param {number} [params.limit=10]
   * @returns {object[]} the most recent gate events, newest first
   */
  function events({ limit = 10 } = {}) {
    return store.getGateEvents({ limit });
  }

  return { read, check, isOpen, mode, recordResponse, recordTransportError, recordDealsCycle, resume, events, probeUrl };
}
