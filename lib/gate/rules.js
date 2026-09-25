/**
 * The access gate's state machine (design 3.7). Pure: given the current
 * gate row, a signal, the current instant and the settings, it returns the
 * next gate row and the events to record. No store, no clock, no I/O —
 * the persistence and the time are injected by `lib/gate/index.js`, so the
 * rules are testable with a fixed instant and a plain object.
 *
 * States: `open` (requests flow), `cooling` (zero requests until `until_at`),
 * `probing` (exactly one request: the deals feed page 0), `stopped`
 * (zero requests until `resume()`).
 *
 * Rules (design 3.7):
 *  - B1: a Cloudflare block on any surface stops the gate for 24 h, or
 *    7 days when a B1 stop already happened in the previous 30 days.
 *  - B2: a 429/503 cools the gate; the tier is the consecutive count and
 *    the duration is the larger of `Retry-After` and the exponential base,
 *    capped at 24 h.
 *  - B3: the fifth consecutive B2 with no success in between stops the
 *    gate for 24 h.
 *  - B4: OzBargain's own 403 on the deals surface stops the gate, but
 *    `resume()` is allowed immediately.
 *  - B5: three consecutive failing deals cycles (no deals feed reached, at
 *    least one transient/transport failure) cool the gate by a multiple of
 *    the poll interval, capped.
 *
 * A probe that fails with a non-signal failure (transient/transport)
 * re-cools: after a B2 cool-off the consecutive count keeps climbing (and
 * the fifth lands on B3); after a B5 cool-off (or a manual `resume()`,
 * which seeds `rule='B5'`, `b5_tier=0`) the B5 tier climbs.
 */

/** B1: the 30-day lookback for a repeat block. Constant (design 3.7). */
const B1_LOOKBACK_DAYS = 30;
/** B2: the 24 h cap on a cool-off. Constant (design 3.7). */
const B2_CAP_MS = 24 * 60 * 60 * 1000;
/** B3: the consecutive-B2 count that stops the gate. Constant (design 3.7). */
const B3_THRESHOLD = 5;
/** B3: the minimum resume delay after a B3 stop. Constant (design 3.7). */
const B3_MIN_RESUME_MS = 24 * 60 * 60 * 1000;
/** B5: the failing-cycle count that cools the gate. Constant (design 3.7). */
const B5_THRESHOLD = 3;
/** The liveness window for a granted probe: 10 minutes after the grant,
 * a probe that was never answered (e.g. the process died mid-probe)
 * expires and the gate re-cools. */
export const PROBE_TIMEOUT_MS = 10 * 60 * 1000;

/** Settings defaults; `loadConfig` enforces the same floors (design 3.7). */
export const GATE_DEFAULTS = {
  b1MinHours: 24,
  b1RepeatDays: 7,
  b2BaseMinutes: 15,
  b5CapHours: 6,
};

/**
 * A gate row in its resting (open) state. The store seeds this on
 * migration; a missing row is read as this.
 * @returns {object} the default open gate row
 */
export function defaultGate() {
  return {
    state: 'open',
    rule: null,
    tier: 0,
    reason: null,
    since: null,
    until_at: null,
    min_resume_at: null,
    consecutive_b2: 0,
    failing_cycles: 0,
    b5_tier: 0,
    probe_used: 0,
    probe_granted_at: null,
  };
}

/**
 * The surface label used in event reasons: `deals` renders as "deals feed"
 * (the surface is the deals feed), everything else as itself.
 * @param {string} surface
 * @returns {string}
 */
function surfaceLabel(surface) {
  return surface === 'deals' ? 'deals feed' : surface;
}

/**
 * @param {string} cls the response class or failure kind
 * @param {string} surface
 * @returns {string} the short fixed reason text (design 3.7: never carries
 *   a body, URL query, cookie or header)
 */
function reasonFor(cls, surface) {
  return `${cls} on ${surfaceLabel(surface)}`;
}

/**
 * @param {number} ms
 * @returns {string} ISO-8601
 */
function iso(ms) {
  return new Date(ms).toISOString();
}

/**
 * The B2 cool-off duration: the larger of `Retry-After` (seconds, or 0)
 * and the exponential base `base × 2^(tier−1)`, capped at 24 h
 * (design 3.7).
 * @param {number} nowMs
 * @param {number|null} retryAfterSeconds
 * @param {number} tier 1-based
 * @param {number} baseMs
 * @returns {{ untilAtMs: number }}
 */
function b2Duration(nowMs, retryAfterSeconds, tier, baseMs) {
  const retryMs = Math.max(retryAfterSeconds ?? 0, 0) * 1000;
  const base = baseMs * 2 ** (tier - 1);
  const waitMs = Math.min(Math.max(retryMs, base), B2_CAP_MS);
  return { untilAtMs: nowMs + waitMs };
}

/**
 * The B5 cool-off duration: `pollInterval × 2^b5_tier`, capped (design 3.7).
 * @param {number} nowMs
 * @param {number} b5Tier
 * @param {number} pollIntervalMs
 * @param {number} capMs
 * @returns {{ untilAtMs: number }}
 */
function b5Duration(nowMs, b5Tier, pollIntervalMs, capMs) {
  const waitMs = Math.min(pollIntervalMs * 2 ** b5Tier, capMs);
  return { untilAtMs: nowMs + waitMs };
}

/**
 * Apply one signal to the gate.
 *
 * @param {object} gate the current gate row
 * @param {object} signal
 *   `{ kind, surface?, retryAfterSeconds?, recentB1Count?, reachedDealsFeed?, transientFailures? }`
 *   where `kind` is one of `cloudflare_block`, `rate_limited`,
 *   `permission_denied`, `transient`, `transport_error`, `deals_cycle`,
 *   `ok`, `not_modified`, `unparseable`, `not_found`, `cooling_expired`,
 *   `probe_expired`, `resume`.
 * @param {number} nowMs the current instant
 * @param {object} settings `{ b1MinHours, b1RepeatDays, b2BaseMinutes,
 *   b5CapHours, pollIntervalMs }`
 * @returns {{ gate: object, events: object[], changed: boolean }} the next
 *   gate row, the events to record (each becomes one `gate_events` row),
 *   and whether anything changed (a no-op signal leaves the gate and the
 *   events untouched, so the caller can skip the write)
 */
export function apply(gate, signal, nowMs, settings) {
  const s = { ...GATE_DEFAULTS, ...settings };
  const at = iso(nowMs);

  /**
   * Record a state change: the `since` anchor moves to now, and one event
   * is written (design 3.7: every state change is exactly one event; a tier
   * escalation that stays in `cooling` is a state change too, with
   * from_state = to_state = cooling).
   */
  function transition(next, eventRule, eventTier, eventReason, eventUntilAt, eventMinResumeAt) {
    const from = gate.state;
    const g = {
      ...gate,
      ...next,
      since: at,
      until_at: eventUntilAt ?? null,
      min_resume_at: eventMinResumeAt ?? null,
    };
    const event = {
      at,
      from_state: from,
      to_state: g.state,
      rule: eventRule ?? null,
      tier: eventTier ?? null,
      reason: eventReason ?? null,
      until_at: g.until_at,
      min_resume_at: g.min_resume_at,
    };
    return { gate: g, events: [event], changed: true };
  }

  function noop() {
    return { gate, events: [], changed: false };
  }

  switch (signal.kind) {
    // B1: a Cloudflare block stops the gate. The duration is 24 h, or the
    // repeat duration when a B1 stop already happened in the lookback
    // window (the count is passed in by the caller, which reads the events
    // table — the machine itself has no store).
    case 'cloudflare_block': {
      const repeat = (signal.recentB1Count ?? 0) > 0;
      const minResumeAt = iso(
        nowMs + (repeat ? s.b1RepeatDays * 24 * 60 * 60 * 1000 : s.b1MinHours * 60 * 60 * 1000),
      );
      return transition(
        { state: 'stopped', rule: 'B1', tier: 0, reason: reasonFor('cloudflare_block', signal.surface) },
        'B1',
        0,
        reasonFor('cloudflare_block', signal.surface),
        null,
        minResumeAt,
      );
    }

    // B2: a 429/503 cools the gate (or stops it on the fifth consecutive
    // one, B3). The count climbs on every rate_limited signal with no
    // success in between — including a probe that comes back 429.
    case 'rate_limited': {
      const consecutive = gate.consecutive_b2 + 1;
      if (consecutive >= B3_THRESHOLD) {
        const minResumeAt = iso(nowMs + B3_MIN_RESUME_MS);
        return transition(
          { state: 'stopped', rule: 'B3', tier: 0, reason: reasonFor('rate_limited', signal.surface) },
          'B3',
          0,
          reasonFor('rate_limited', signal.surface),
          null,
          minResumeAt,
        );
      }
      const { untilAtMs } = b2Duration(
        nowMs,
        signal.retryAfterSeconds,
        consecutive,
        s.b2BaseMinutes * 60 * 1000,
      );
      const untilAt = iso(untilAtMs);
      return transition(
        {
          state: 'cooling',
          rule: 'B2',
          tier: consecutive,
          reason: reasonFor('rate_limited', signal.surface),
          consecutive_b2: consecutive,
        },
        'B2',
        consecutive,
        reasonFor('rate_limited', signal.surface),
        untilAt,
        null,
      );
    }

    // B4: OzBargain's own 403 stops the gate — but only on the deals
    // surface. A classifieds 403 is the expired-session path (the session
    // latch handles it) and is not a gate signal. `resume()` is allowed
    // immediately: min_resume_at is now.
    case 'permission_denied': {
      if (signal.surface !== 'deals') return noop();
      const minResumeAt = iso(nowMs);
      return transition(
        { state: 'stopped', rule: 'B4', tier: 0, reason: reasonFor('permission_denied', signal.surface) },
        'B4',
        0,
        reasonFor('permission_denied', signal.surface),
        null,
        minResumeAt,
      );
    }

    // B5: a failing deals cycle (no deals feed reached, at least one
    // transient/transport failure) counts up while the gate is open; the
    // third cools it. The signal acts ONLY while open: while cooling,
    // probing or stopped the poller does not run a full cycle, so counting
    // here would double-count the probe's re-cool. A cycle that reached
    // the deals feed resets the counters (no event).
    case 'deals_cycle': {
      if (gate.state !== 'open') return noop();
      if (signal.reachedDealsFeed) {
        if (gate.failing_cycles === 0) return noop();
        return {
          gate: { ...gate, failing_cycles: 0, b5_tier: 0 },
          events: [],
          changed: true,
        };
      }
      if ((signal.transientFailures ?? 0) < 1) return noop();
      const failing = gate.failing_cycles + 1;
      if (failing < B5_THRESHOLD) {
        return { gate: { ...gate, failing_cycles: failing }, events: [], changed: true };
      }
      const { untilAtMs } = b5Duration(
        nowMs,
        1,
        s.pollIntervalMs,
        s.b5CapHours * 60 * 60 * 1000,
      );
      const untilAt = iso(untilAtMs);
      return transition(
        {
          state: 'cooling',
          rule: 'B5',
          tier: 1,
          reason: 'failing deals cycles',
          failing_cycles: failing,
          b5_tier: 1,
        },
        'B5',
        1,
        'failing deals cycles',
        untilAt,
        null,
      );
    }

    // A success (or 304) resets the consecutive-B2 count. While open the
    // count is already 0 (a rate_limited signal always leaves `open`), so
    // this is a no-op there; it matters only as the open transition of a
    // probe (below). No event: a counter-only change writes nothing.
    case 'ok':
    case 'not_modified': {
      if (gate.state === 'open') {
        if (gate.consecutive_b2 === 0) return noop();
        return { gate: { ...gate, consecutive_b2: 0 }, events: [], changed: true };
      }
      if (gate.state === 'probing') {
        return openFromProbe(signal.kind, signal.surface);
      }
      return noop();
    }

    // 200-unparseable and 404 are not gate signals while open; a probe
    // that comes back with either ends the cycle and reopens (design 3.7:
    // the probe's job is to test reachability, and a reachable-but-empty
    // or reachable-but-weird feed proves the site answers).
    case 'unparseable':
    case 'not_found': {
      if (gate.state === 'probing') {
        return openFromProbe(signal.kind, signal.surface);
      }
      return noop();
    }

    // A non-signal failure (timeout/connection error) does nothing while
    // open (B5 counts cycles, not individual failures) or while
    // cooling/stopped (no requests go out). In probing it re-cools: after
    // a B2 cool-off the consecutive count climbs (the fifth lands on B3);
    // after a B5 cool-off — or a manual resume, which seeds rule='B5',
    // b5_tier=0 — the B5 tier climbs.
    case 'transient':
    case 'transport_error': {
      if (gate.state !== 'probing') return noop();
      if (gate.rule === 'B2') {
        const consecutive = gate.consecutive_b2 + 1;
        if (consecutive >= B3_THRESHOLD) {
          const minResumeAt = iso(nowMs + B3_MIN_RESUME_MS);
          return transition(
            {
              state: 'stopped',
              rule: 'B3',
              tier: 0,
              reason: reasonFor(signal.kind, signal.surface),
              consecutive_b2: consecutive,
            },
            'B3',
            0,
            reasonFor(signal.kind, signal.surface),
            null,
            minResumeAt,
          );
        }
        const { untilAtMs } = b2Duration(
          nowMs,
          null,
          consecutive,
          s.b2BaseMinutes * 60 * 1000,
        );
        const untilAt = iso(untilAtMs);
        return transition(
          {
            state: 'cooling',
            rule: 'B2',
            tier: consecutive,
            reason: reasonFor(signal.kind, signal.surface),
            consecutive_b2: consecutive,
          },
          'B2',
          consecutive,
          reasonFor(signal.kind, signal.surface),
          untilAt,
          null,
        );
      }
      // rule 'B5' (a B5 cool-off, or a manual resume that seeded it).
      const b5Tier = gate.b5_tier + 1;
      const { untilAtMs } = b5Duration(
        nowMs,
        b5Tier,
        s.pollIntervalMs,
        s.b5CapHours * 60 * 60 * 1000,
      );
      const untilAt = iso(untilAtMs);
      return transition(
        {
          state: 'cooling',
          rule: 'B5',
          tier: b5Tier,
          reason: reasonFor(signal.kind, signal.surface),
          b5_tier: b5Tier,
        },
        'B5',
        b5Tier,
        reasonFor(signal.kind, signal.surface),
        untilAt,
        null,
      );
    }

    // The 10-minute liveness window for a granted probe: the probe was
    // granted but never answered (e.g. the process died mid-probe).
    // Behaves exactly like a non-signal failure in probing (after a B2
    // cool-off the count climbs, the fifth lands on B3; after a B5
    // cool-off or a manual resume the B5 tier climbs), with the fixed
    // reason text `probe expired`.
    case 'probe_expired': {
      if (gate.state !== 'probing' || gate.probe_used !== 1) return noop();
      if (gate.rule === 'B2') {
        const consecutive = gate.consecutive_b2 + 1;
        if (consecutive >= B3_THRESHOLD) {
          const minResumeAt = iso(nowMs + B3_MIN_RESUME_MS);
          return transition(
            {
              state: 'stopped',
              rule: 'B3',
              tier: 0,
              reason: 'probe expired',
              consecutive_b2: consecutive,
            },
            'B3',
            0,
            'probe expired',
            null,
            minResumeAt,
          );
        }
        const { untilAtMs } = b2Duration(
          nowMs,
          null,
          consecutive,
          s.b2BaseMinutes * 60 * 1000,
        );
        const untilAt = iso(untilAtMs);
        return transition(
          {
            state: 'cooling',
            rule: 'B2',
            tier: consecutive,
            reason: 'probe expired',
            consecutive_b2: consecutive,
          },
          'B2',
          consecutive,
          'probe expired',
          untilAt,
          null,
        );
      }
      // rule 'B5' (a B5 cool-off, or a manual resume that seeded it).
      const b5Tier = gate.b5_tier + 1;
      const { untilAtMs } = b5Duration(
        nowMs,
        b5Tier,
        s.pollIntervalMs,
        s.b5CapHours * 60 * 60 * 1000,
      );
      const untilAt = iso(untilAtMs);
      return transition(
        {
          state: 'cooling',
          rule: 'B5',
          tier: b5Tier,
          reason: 'probe expired',
          b5_tier: b5Tier,
        },
        'B5',
        b5Tier,
        'probe expired',
        untilAt,
        null,
      );
    }

    // The lazy cooling→probing transition, fired by the caller when the
    // current instant is at or past `until_at`. Idempotent: a gate that is
    // already probing is left untouched (no second event), so two reads
    // after `until_at` write exactly one event.
    case 'cooling_expired': {
      if (gate.state !== 'cooling') return noop();
      return transition(
        { state: 'probing', probe_used: 0, probe_granted_at: null },
        gate.rule,
        gate.tier,
        gate.reason,
        null,
        null,
      );
    }

    // The manual resume (B1/B3/B4 stops). The caller validates the state
    // and the min-resume instant; the machine performs the transition.
    // The counters start from zero: a 429 probe then starts B2 at tier 1,
    // and a failed probe lands on "B5 tier 1" via the b5_tier climb.
    case 'resume': {
      if (gate.state !== 'stopped') return noop();
      return transition(
        {
          state: 'probing',
          rule: 'B5',
          tier: 0,
          reason: 'manual resume',
          consecutive_b2: 0,
          failing_cycles: 0,
          b5_tier: 0,
          probe_used: 0,
          probe_granted_at: null,
        },
        null,
        null,
        'manual resume',
        null,
        null,
      );
    }

    default:
      throw new Error(`apply: unknown signal kind "${signal.kind}"`);
  }

  /**
   * A probe that proves the site answers: the gate reopens and ALL the
   * counters reset (one state change, one event).
   */
  function openFromProbe(cls, surface) {
    return transition(
      {
        state: 'open',
        rule: null,
        tier: 0,
        reason: null,
        consecutive_b2: 0,
        failing_cycles: 0,
        b5_tier: 0,
        probe_used: 0,
      },
      null,
      null,
      reasonFor(cls, surface),
      null,
      null,
    );
  }
}

/**
 * @param {object} settings the settings (floors enforced by `loadConfig`)
 * @returns {number} the B1 lookback window, in ms
 */
export function b1LookbackMs(settings = {}) {
  return B1_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
}

export { B1_LOOKBACK_DAYS, B2_CAP_MS, B3_THRESHOLD, B3_MIN_RESUME_MS, B5_THRESHOLD };
