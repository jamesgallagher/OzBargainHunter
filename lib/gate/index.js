import { apply, b1LookbackMs, PROBE_TIMEOUT_MS } from './rules.js';

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
 * @param {object} deps.store the store (needs `mutateGate`,
 *   `getGateEvents`, `countGateEvents`)
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
   * Apply the lazy transitions to a gate row (no write). The caller runs
   * this inside `withTransition`, so the read and the write are one
   * transaction. `cooling_expired` fires when the instant is at or past
   * `until_at`; it is idempotent (the machine no-ops a gate that is
   * already probing), so two reads after `until_at` write exactly one
   * event. `probe_expired` fires 10 minutes after the probe was granted
   * (a probe that was never answered, e.g. the process died mid-probe);
   * it is idempotent the same way — the machine no-ops a gate that is
   * no longer probing with the probe used, so two reads after the
   * expiry write exactly one event.
   * @param {object} gate the gate row
   * @param {number} nowMs the current instant
   * @returns {{ gate: object, events: object[] }} the effective row and
   *   the lazy events (empty when no lazy transition fired)
   */
  function applyLazy(gate, nowMs) {
    if (gate.state === 'cooling' && gate.until_at && nowMs >= Date.parse(gate.until_at)) {
      const { gate: next, events, changed } = apply(gate, { kind: 'cooling_expired' }, nowMs, settings);
      if (changed) return { gate: next, events };
    }
    if (
      gate.state === 'probing' &&
      gate.probe_used === 1 &&
      gate.probe_granted_at &&
      nowMs >= Date.parse(gate.probe_granted_at) + PROBE_TIMEOUT_MS
    ) {
      const { gate: next, events, changed } = apply(gate, { kind: 'probe_expired' }, nowMs, settings);
      if (changed) return { gate: next, events };
    }
    return { gate, events: [] };
  }

  /**
   * Run one gate transition through `store.mutateGate` (one transaction:
   * read, compute, write). `fn` receives the current row and returns
   * `{ gate, events }` or `null` for no change. The per-event log lines
   * are written only after the transaction commits, so no I/O happens
   * inside the transaction.
   * @param {(row: object) => { gate: object, events: object[] } | null} fn
   * @returns {object} the resulting gate row
   */
  function withTransition(fn) {
    let events = null;
    const row = store.mutateGate((gate) => {
      const result = fn(gate);
      if (result === null) return null;
      events = result.events;
      return result;
    });
    if (events) for (const event of events) logEvent(event);
    return row;
  }

  /**
   * Read the gate row, applying the lazy transitions in one transaction.
   * @returns {object} the current gate row
   */
  function read() {
    const nowMs = clock.now().getTime();
    return withTransition((gate) => {
      const { gate: next, events } = applyLazy(gate, nowMs);
      if (events.length === 0) return null;
      return { gate: next, events };
    });
  }

  /**
   * Gate a request (design 4.4). Open: allowed. Probing: allowed only for
   * the probe URL, once — the grant decision and the probe consumption
   * are one transaction, so a concurrent check on another connection
   * cannot also be granted; `probe_used` is set to 1 in the same
   * transaction that lets the probe through, so a restart between the
   * check and the request cannot replay the probe; `probe_granted_at`
   * is stamped in that same transaction, so the 10-minute liveness
   * window starts at the grant. Closed (cooling / stopped): not allowed.
   * @param {string} url
   * @returns {{ allowed: boolean, state: string, probe: boolean }}
   */
  function check(url) {
    const now = clock.now();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    let verdict;
    withTransition((gate) => {
      const { gate: current, events } = applyLazy(gate, nowMs);
      if (current.state === 'open') {
        verdict = { allowed: true, state: 'open', probe: false };
        return events.length > 0 ? { gate: current, events } : null;
      }
      if (current.state === 'probing') {
        // Decided from the row inside the transaction: the probe is
        // consumed the moment it is granted (design 3.7: "once"), and
        // the grant instant is recorded so an unanswered probe expires
        // after 10 minutes.
        const allowed = !current.probe_used && url === probeUrl;
        if (allowed) {
          verdict = { allowed: true, state: 'probing', probe: true };
          return { gate: { ...current, probe_used: 1, probe_granted_at: nowIso }, events };
        }
        verdict = { allowed: false, state: 'probing', probe: false };
        return events.length > 0 ? { gate: current, events } : null;
      }
      verdict = { allowed: false, state: current.state, probe: false };
      return events.length > 0 ? { gate: current, events } : null;
    });
    return verdict;
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
    withTransition((gate) => {
      const { gate: current, events: lazyEvents } = applyLazy(gate, nowMs);
      const signal = { kind: cls, surface, retryAfterSeconds };
      if (cls === 'cloudflare_block') {
        const sinceIso = new Date(nowMs - b1LookbackMs()).toISOString();
        signal.recentB1Count = store.countGateEvents({ rule: 'B1', toState: 'stopped', sinceIso });
      }
      const { gate: next, events, changed } = apply(current, signal, nowMs, settings);
      if (!changed) return lazyEvents.length > 0 ? { gate: current, events: lazyEvents } : null;
      return { gate: next, events: [...lazyEvents, ...events] };
    });
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
    withTransition((gate) => {
      const { gate: current, events: lazyEvents } = applyLazy(gate, nowMs);
      const { gate: next, events, changed } = apply(
        current,
        { kind: 'deals_cycle', reachedDealsFeed, transientFailures },
        nowMs,
        settings,
      );
      if (!changed) return lazyEvents.length > 0 ? { gate: current, events: lazyEvents } : null;
      return { gate: next, events: [...lazyEvents, ...events] };
    });
  }

  /**
   * The manual resume (design 4.4). Allowed only from `stopped`, and not
   * before `min_resume_at`. The validation and the transition are one
   * transaction, so a concurrent resume on another connection cannot
   * also resume: it sees the committed state and is refused.
   * @returns {{ ok: true } | { ok: false, reason: 'not_stopped'|'too_early', minResumeAt?: string }}
   */
  function resume() {
    const nowMs = clock.now().getTime();
    let result;
    withTransition((row) => {
      const { gate: current, events: lazyEvents } = applyLazy(row, nowMs);
      if (current.state !== 'stopped') {
        result = { ok: false, reason: 'not_stopped' };
        return lazyEvents.length > 0 ? { gate: current, events: lazyEvents } : null;
      }
      if (current.min_resume_at && nowMs < Date.parse(current.min_resume_at)) {
        result = { ok: false, reason: 'too_early', minResumeAt: current.min_resume_at };
        return lazyEvents.length > 0 ? { gate: current, events: lazyEvents } : null;
      }
      const { gate: next, events, changed } = apply(current, { kind: 'resume' }, nowMs, settings);
      if (!changed) {
        result = { ok: false, reason: 'not_stopped' };
        return lazyEvents.length > 0 ? { gate: current, events: lazyEvents } : null;
      }
      result = { ok: true };
      return { gate: next, events: [...lazyEvents, ...events] };
    });
    return result;
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
