import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  apply,
  defaultGate,
  effectiveGate,
  GATE_DEFAULTS,
  b1LookbackMs,
  PROBE_TIMEOUT_MS,
} from '../../../lib/gate/rules.js';

// A fixed instant so the pure machine is deterministic (design 3.7: no
// Date.now() in lib/; the clock is injected by the caller).
const NOW = Date.parse('2026-09-25T04:00:00.000Z');
const NOW_ISO = '2026-09-25T04:00:00.000Z';

// The settings the test drives with: the defaults, with a 5-minute poll
// interval (the config floor).
const SETTINGS = {
  b1MinHours: 24,
  b1RepeatDays: 7,
  b2BaseMinutes: 15,
  b5CapHours: 6,
  pollIntervalMs: 300000,
};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Apply a signal at the fixed instant with the fixed settings. */
function step(gate, signal) {
  return apply(gate, signal, NOW, SETTINGS);
}

describe('gate rules: the pure state machine (3.7)', () => {
  test('defaultGate is the resting open row', () => {
    assert.deepEqual(defaultGate(), {
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
    });
  });

  test('GATE_DEFAULTS match the config floors', () => {
    assert.deepEqual(GATE_DEFAULTS, { b1MinHours: 24, b1RepeatDays: 7, b2BaseMinutes: 15, b5CapHours: 6 });
  });

  test('b1LookbackMs is the 30-day window', () => {
    assert.equal(b1LookbackMs(SETTINGS), 30 * DAY);
  });

  describe('B1: a Cloudflare block stops the gate', () => {
    test('a block on any surface stops the gate for 24 h', () => {
      const { gate, events, changed } = step(defaultGate(), { kind: 'cloudflare_block', surface: 'deals' });
      assert.equal(changed, true);
      assert.equal(gate.state, 'stopped');
      assert.equal(gate.rule, 'B1');
      assert.equal(gate.tier, 0);
      assert.equal(gate.until_at, null);
      assert.equal(gate.min_resume_at, new Date(NOW + DAY).toISOString());
      assert.equal(gate.since, NOW_ISO);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0], {
        at: NOW_ISO,
        from_state: 'open',
        to_state: 'stopped',
        rule: 'B1',
        tier: 0,
        reason: 'cloudflare_block on deals feed',
        until_at: null,
        min_resume_at: new Date(NOW + DAY).toISOString(),
      });
    });

    test('a block on the classifieds surface stops the gate too', () => {
      const { gate } = step(defaultGate(), { kind: 'cloudflare_block', surface: 'classifieds' });
      assert.equal(gate.state, 'stopped');
      assert.equal(gate.rule, 'B1');
      assert.equal(gate.reason, 'cloudflare_block on classifieds');
    });

    test('a prior B1 stop in the lookback window extends the stop to 7 days', () => {
      const { gate } = step(defaultGate(), { kind: 'cloudflare_block', surface: 'deals', recentB1Count: 1 });
      assert.equal(gate.state, 'stopped');
      assert.equal(gate.min_resume_at, new Date(NOW + 7 * DAY).toISOString());
    });

    test('no recent B1 stop keeps the 24 h stop', () => {
      const { gate } = step(defaultGate(), { kind: 'cloudflare_block', surface: 'deals', recentB1Count: 0 });
      assert.equal(gate.min_resume_at, new Date(NOW + DAY).toISOString());
    });
  });

  describe('B2: a 429/503 cools the gate', () => {
    test('a 429 with a short Retry-After cools for the 15-minute floor', () => {
      const { gate, events } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals', retryAfterSeconds: 60 });
      assert.equal(gate.state, 'cooling');
      assert.equal(gate.rule, 'B2');
      assert.equal(gate.tier, 1);
      assert.equal(gate.consecutive_b2, 1);
      assert.equal(gate.until_at, new Date(NOW + 15 * MIN).toISOString());
      assert.equal(gate.min_resume_at, null);
      assert.equal(events.length, 1);
      assert.equal(events[0].to_state, 'cooling');
    });

    test('a 429 with a long Retry-After cools for Retry-After (2 h)', () => {
      const { gate } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals', retryAfterSeconds: 7200 });
      assert.equal(gate.until_at, new Date(NOW + 2 * HOUR).toISOString());
    });

    test('a 429 with a very long Retry-After is capped at 24 h', () => {
      const { gate } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals', retryAfterSeconds: 200000 });
      assert.equal(gate.until_at, new Date(NOW + DAY).toISOString());
    });

    test('a 429 without Retry-After cools for the 15-minute floor', () => {
      const { gate } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals' });
      assert.equal(gate.until_at, new Date(NOW + 15 * MIN).toISOString());
    });

    test('consecutive 429s climb the ladder: 15m, 30m, 1h, 2h', () => {
      // First 429: tier 1, 15 minutes.
      let { gate } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals', retryAfterSeconds: 60 });
      assert.equal(gate.until_at, new Date(NOW + 15 * MIN).toISOString());

      // The cool-off expires: the lazy transition to probing.
      ({ gate } = step(gate, { kind: 'cooling_expired' }));
      assert.equal(gate.state, 'probing');
      assert.equal(gate.probe_used, 0);

      // The probe comes back 429: tier 2, 30 minutes.
      ({ gate } = step(gate, { kind: 'rate_limited', surface: 'deals', retryAfterSeconds: 60 }));
      assert.equal(gate.state, 'cooling');
      assert.equal(gate.tier, 2);
      assert.equal(gate.consecutive_b2, 2);
      assert.equal(gate.until_at, new Date(NOW + 30 * MIN).toISOString());

      // Tier 3: 1 hour.
      ({ gate } = step(gate, { kind: 'cooling_expired' }));
      ({ gate } = step(gate, { kind: 'rate_limited', surface: 'deals', retryAfterSeconds: 60 }));
      assert.equal(gate.tier, 3);
      assert.equal(gate.until_at, new Date(NOW + HOUR).toISOString());

      // Tier 4: 2 hours.
      ({ gate } = step(gate, { kind: 'cooling_expired' }));
      ({ gate } = step(gate, { kind: 'rate_limited', surface: 'deals', retryAfterSeconds: 60 }));
      assert.equal(gate.tier, 4);
      assert.equal(gate.until_at, new Date(NOW + 2 * HOUR).toISOString());
    });

    test('the fifth consecutive 429 stops the gate (B3) for 24 h', () => {
      // Build up to four consecutive 429s.
      let { gate } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals' });
      for (let i = 0; i < 3; i += 1) {
        ({ gate } = step(gate, { kind: 'cooling_expired' }));
        ({ gate } = step(gate, { kind: 'rate_limited', surface: 'deals' }));
      }
      assert.equal(gate.consecutive_b2, 4);

      // The fifth: B3, stopped, min_resume_at = now + 24 h.
      ({ gate } = step(gate, { kind: 'cooling_expired' }));
      const { gate: stopped, events } = step(gate, { kind: 'rate_limited', surface: 'deals' });
      assert.equal(stopped.state, 'stopped');
      assert.equal(stopped.rule, 'B3');
      assert.equal(stopped.min_resume_at, new Date(NOW + DAY).toISOString());
      assert.equal(events.length, 1);
      assert.equal(events[0].rule, 'B3');
      assert.equal(events[0].from_state, 'probing');
      assert.equal(events[0].to_state, 'stopped');
    });

    test('a 429 while cooling escalates the tier without leaving cooling', () => {
      const { gate: cooling } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals', retryAfterSeconds: 60 });
      const { gate, events } = step(cooling, { kind: 'rate_limited', surface: 'deals', retryAfterSeconds: 60 });
      assert.equal(gate.state, 'cooling');
      assert.equal(gate.tier, 2);
      assert.equal(gate.consecutive_b2, 2);
      assert.equal(gate.until_at, new Date(NOW + 30 * MIN).toISOString());
      assert.equal(events.length, 1);
      assert.equal(events[0].from_state, 'cooling');
      assert.equal(events[0].to_state, 'cooling');
      assert.equal(events[0].rule, 'B2');
    });
  });

  describe('B4: a 403 stops the gate, but only on the deals surface', () => {
    test('a 403 on the deals surface stops the gate; resume is allowed immediately', () => {
      const { gate } = step(defaultGate(), { kind: 'permission_denied', surface: 'deals' });
      assert.equal(gate.state, 'stopped');
      assert.equal(gate.rule, 'B4');
      assert.equal(gate.min_resume_at, NOW_ISO);
    });

    test('a 403 on the classifieds surface is not a gate signal', () => {
      const { gate, events, changed } = step(defaultGate(), { kind: 'permission_denied', surface: 'classifieds' });
      assert.equal(changed, false);
      assert.equal(events.length, 0);
      assert.equal(gate.state, 'open');
      assert.deepEqual(gate, defaultGate());
    });
  });

  describe('B5: failing deals cycles cool the gate', () => {
    test('two failing cycles keep the gate open (counter only, no event)', () => {
      let { gate, events } = step(defaultGate(), { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 1 });
      assert.equal(gate.state, 'open');
      assert.equal(gate.failing_cycles, 1);
      assert.equal(events.length, 0);

      ({ gate, events } = step(gate, { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 2 }));
      assert.equal(gate.state, 'open');
      assert.equal(gate.failing_cycles, 2);
      assert.equal(events.length, 0);
    });

    test('the third failing cycle cools for 2 × the poll interval (600 s)', () => {
      let { gate } = step(defaultGate(), { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 1 });
      ({ gate } = step(gate, { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 1 }));
      const { gate: cooling, events } = step(gate, { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 1 });
      assert.equal(cooling.state, 'cooling');
      assert.equal(cooling.rule, 'B5');
      assert.equal(cooling.tier, 1);
      assert.equal(cooling.b5_tier, 1);
      assert.equal(cooling.until_at, new Date(NOW + 2 * 300000).toISOString());
      assert.equal(events.length, 1);
      assert.equal(events[0].reason, 'failing deals cycles');
    });

    test('a deals_cycle while cooling is a no-op (no double-count)', () => {
      const { gate: cooling } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals' });
      const { gate, events, changed } = step(cooling, { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 1 });
      assert.equal(changed, false);
      assert.equal(events.length, 0);
      assert.equal(gate.failing_cycles, 0);
    });

    test('a cycle that reached the deals feed resets the counters (no event)', () => {
      let { gate } = step(defaultGate(), { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 1 });
      ({ gate } = step(gate, { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 1 }));
      assert.equal(gate.failing_cycles, 2);
      const { gate: reset, events, changed } = step(gate, { kind: 'deals_cycle', reachedDealsFeed: true, transientFailures: 0 });
      assert.equal(reset.failing_cycles, 0);
      assert.equal(reset.b5_tier, 0);
      assert.equal(events.length, 0);
      assert.equal(changed, true);
    });

    test('a cycle with no transient failures does not count', () => {
      const { gate, events, changed } = step(defaultGate(), { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 0 });
      assert.equal(changed, false);
      assert.equal(events.length, 0);
      assert.equal(gate.failing_cycles, 0);
    });

    test('a failed probe after a B5 cool-off re-cools at the next tier (4×, then 8×)', () => {
      // Build up to the B5 cool-off.
      let { gate } = step(defaultGate(), { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 1 });
      ({ gate } = step(gate, { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 1 }));
      ({ gate } = step(gate, { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 1 }));
      assert.equal(gate.state, 'cooling');
      assert.equal(gate.b5_tier, 1);

      // The probe fails with a transient: b5_tier 2, 4 × interval (1200 s).
      ({ gate } = step(gate, { kind: 'cooling_expired' }));
      ({ gate } = step(gate, { kind: 'transient', surface: 'deals' }));
      assert.equal(gate.state, 'cooling');
      assert.equal(gate.rule, 'B5');
      assert.equal(gate.b5_tier, 2);
      assert.equal(gate.until_at, new Date(NOW + 4 * 300000).toISOString());

      // The next failed probe: b5_tier 3, 8 × interval (2400 s).
      ({ gate } = step(gate, { kind: 'cooling_expired' }));
      ({ gate } = step(gate, { kind: 'transport_error', surface: 'deals' }));
      assert.equal(gate.b5_tier, 3);
      assert.equal(gate.until_at, new Date(NOW + 8 * 300000).toISOString());
    });

    test('the B5 re-cool is capped at 6 h', () => {
      // Build up to the B5 cool-off, then fail the probe until the cap.
      let { gate } = step(defaultGate(), { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 1 });
      ({ gate } = step(gate, { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 1 }));
      ({ gate } = step(gate, { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 1 }));
      for (let i = 0; i < 6; i += 1) {
        ({ gate } = step(gate, { kind: 'cooling_expired' }));
        ({ gate } = step(gate, { kind: 'transient', surface: 'deals' }));
      }
      // b5_tier is now 7: 2^7 × 300000 = 38.4M ms, above the 6 h cap.
      assert.equal(gate.b5_tier, 7);
      assert.equal(gate.until_at, new Date(NOW + 6 * HOUR).toISOString());
    });
  });

  describe('resets and probe results', () => {
    test('a success while open with no consecutive 429s is a no-op', () => {
      const { gate, events, changed } = step(defaultGate(), { kind: 'ok', surface: 'deals' });
      assert.equal(changed, false);
      assert.equal(events.length, 0);
    });

    test('a successful probe reopens the gate and resets all counters (one event)', () => {
      const { gate: cooling } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals' });
      const { gate: probing } = step(cooling, { kind: 'cooling_expired' });
      assert.equal(probing.state, 'probing');
      assert.equal(probing.consecutive_b2, 1);
      const { gate: open, events } = step(probing, { kind: 'ok', surface: 'deals' });
      assert.equal(open.state, 'open');
      assert.equal(open.rule, null);
      assert.equal(open.tier, 0);
      assert.equal(open.consecutive_b2, 0);
      assert.equal(open.failing_cycles, 0);
      assert.equal(open.b5_tier, 0);
      assert.equal(open.probe_used, 0);
      assert.equal(open.until_at, null);
      assert.equal(open.min_resume_at, null);
      assert.equal(events.length, 1);
      assert.equal(events[0].from_state, 'probing');
      assert.equal(events[0].to_state, 'open');
      assert.equal(events[0].reason, 'ok on deals feed');
    });

    test('a 304 probe reopens the gate too', () => {
      const { gate: cooling } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals' });
      const { gate: probing } = step(cooling, { kind: 'cooling_expired' });
      const { gate: open } = step(probing, { kind: 'not_modified', surface: 'deals' });
      assert.equal(open.state, 'open');
      assert.equal(open.consecutive_b2, 0);
    });

    test('an unparseable or not_found probe reopens the gate (reachability is proven)', () => {
      for (const kind of ['unparseable', 'not_found']) {
        const { gate: cooling } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals' });
        const { gate: probing } = step(cooling, { kind: 'cooling_expired' });
        const { gate: open } = step(probing, { kind: kind, surface: 'deals' });
        assert.equal(open.state, 'open', `${kind} probe reopens`);
        assert.equal(open.consecutive_b2, 0, `${kind} probe resets the counters`);
      }
    });

    test('unparseable / not_found while open are no-ops', () => {
      for (const kind of ['unparseable', 'not_found']) {
        const { gate, events, changed } = step(defaultGate(), { kind: kind, surface: 'deals' });
        assert.equal(changed, false, `${kind} while open is a no-op`);
        assert.equal(events.length, 0, `${kind} while open writes nothing`);
      }
    });

    test('transient / transport_error while open, cooling or stopped are no-ops', () => {
      const { gate: cooling } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals' });
      const { gate: stopped } = step(defaultGate(), { kind: 'cloudflare_block', surface: 'deals' });
      for (const kind of ['transient', 'transport_error']) {
        for (const [label, g] of [['open', defaultGate()], ['cooling', cooling], ['stopped', stopped]]) {
          const { events, changed } = step(g, { kind: kind, surface: 'deals' });
          assert.equal(changed, false, `${kind} while ${label} is a no-op`);
          assert.equal(events.length, 0, `${kind} while ${label} writes nothing`);
        }
      }
    });

    test('a failed probe after a B2 cool-off climbs the consecutive count (the fifth lands on B3)', () => {
      // Build up to three consecutive 429s (tier 3).
      let { gate } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals' });
      ({ gate } = step(gate, { kind: 'cooling_expired' }));
      ({ gate } = step(gate, { kind: 'rate_limited', surface: 'deals' }));
      ({ gate } = step(gate, { kind: 'cooling_expired' }));
      ({ gate } = step(gate, { kind: 'rate_limited', surface: 'deals' }));
      assert.equal(gate.consecutive_b2, 3);

      // The probe fails with a transient: the fourth, re-cools at 2 h.
      ({ gate } = step(gate, { kind: 'cooling_expired' }));
      ({ gate } = step(gate, { kind: 'transient', surface: 'deals' }));
      assert.equal(gate.state, 'cooling');
      assert.equal(gate.rule, 'B2');
      assert.equal(gate.consecutive_b2, 4);
      assert.equal(gate.until_at, new Date(NOW + 2 * HOUR).toISOString());

      // The next failed probe: the fifth, B3.
      ({ gate } = step(gate, { kind: 'cooling_expired' }));
      ({ gate } = step(gate, { kind: 'transport_error', surface: 'deals' }));
      assert.equal(gate.state, 'stopped');
      assert.equal(gate.rule, 'B3');
      assert.equal(gate.min_resume_at, new Date(NOW + DAY).toISOString());
    });
  });

  describe('the lazy cooling→probing transition', () => {
    test('cooling_expired moves a cooling gate to probing (probe_used 0, one event)', () => {
      const { gate: cooling } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals', retryAfterSeconds: 60 });
      const { gate, events } = step(cooling, { kind: 'cooling_expired' });
      assert.equal(gate.state, 'probing');
      assert.equal(gate.probe_used, 0);
      assert.equal(gate.probe_granted_at, null);
      assert.equal(gate.until_at, null);
      assert.equal(gate.min_resume_at, null);
      assert.equal(events.length, 1);
      // The event carries the gate's rule/tier/reason.
      assert.equal(events[0].rule, 'B2');
      assert.equal(events[0].tier, 1);
      assert.equal(events[0].reason, 'rate_limited on deals feed');
    });

    test('cooling_expired is idempotent: a gate already probing is untouched', () => {
      const { gate: cooling } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals' });
      const { gate: probing } = step(cooling, { kind: 'cooling_expired' });
      const { gate, events, changed } = step(probing, { kind: 'cooling_expired' });
      assert.equal(changed, false);
      assert.equal(events.length, 0);
      assert.equal(gate.state, 'probing');
      assert.deepEqual(gate, probing);
    });

    test('cooling_expired while open or stopped is a no-op', () => {
      for (const g of [defaultGate(), step(defaultGate(), { kind: 'cloudflare_block', surface: 'deals' }).gate]) {
        const { events, changed } = step(g, { kind: 'cooling_expired' });
        assert.equal(changed, false);
        assert.equal(events.length, 0);
      }
    });
  });

  describe('the 10-minute probe liveness window (probe_expired)', () => {
    test('PROBE_TIMEOUT_MS is 10 minutes', () => {
      assert.equal(PROBE_TIMEOUT_MS, 10 * MIN);
    });

    test('an unanswered probe after a B2 cool-off re-cools at the next tier (1 h at tier 3)', () => {
      // Build up to two consecutive 429s (tier 2).
      let { gate } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals' });
      ({ gate } = step(gate, { kind: 'cooling_expired' }));
      ({ gate } = step(gate, { kind: 'rate_limited', surface: 'deals' }));
      assert.equal(gate.state, 'cooling');
      assert.equal(gate.tier, 2);
      assert.equal(gate.consecutive_b2, 2);

      // The cool-off expires: probing, and the probe is granted (used, stamped).
      ({ gate } = step(gate, { kind: 'cooling_expired' }));
      assert.equal(gate.state, 'probing');
      const granted = { ...gate, probe_used: 1, probe_granted_at: NOW_ISO };

      // The probe is never answered: the third consecutive, re-cools at 1 h.
      const { gate: next, events, changed } = step(granted, { kind: 'probe_expired' });
      assert.equal(changed, true);
      assert.equal(next.state, 'cooling');
      assert.equal(next.rule, 'B2');
      assert.equal(next.tier, 3);
      assert.equal(next.consecutive_b2, 3);
      assert.equal(next.until_at, new Date(NOW + HOUR).toISOString());
      assert.equal(next.min_resume_at, null);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0], {
        at: NOW_ISO,
        from_state: 'probing',
        to_state: 'cooling',
        rule: 'B2',
        tier: 3,
        reason: 'probe expired',
        until_at: new Date(NOW + HOUR).toISOString(),
        min_resume_at: null,
      });
    });

    test('an unanswered fifth probe stops the gate (B3)', () => {
      // Build up to four consecutive 429s.
      let { gate } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals' });
      for (let i = 0; i < 3; i += 1) {
        ({ gate } = step(gate, { kind: 'cooling_expired' }));
        ({ gate } = step(gate, { kind: 'rate_limited', surface: 'deals' }));
      }
      assert.equal(gate.consecutive_b2, 4);

      ({ gate } = step(gate, { kind: 'cooling_expired' }));
      const granted = { ...gate, probe_used: 1, probe_granted_at: NOW_ISO };
      const { gate: next, events } = step(granted, { kind: 'probe_expired' });
      assert.equal(next.state, 'stopped');
      assert.equal(next.rule, 'B3');
      assert.equal(next.consecutive_b2, 5);
      assert.equal(next.min_resume_at, new Date(NOW + DAY).toISOString());
      assert.equal(events.length, 1);
      assert.equal(events[0].from_state, 'probing');
      assert.equal(events[0].to_state, 'stopped');
      assert.equal(events[0].rule, 'B3');
      assert.equal(events[0].reason, 'probe expired');
    });

    test('an unanswered probe after a B5 cool-off re-cools at the next tier (4×)', () => {
      // Build up to the B5 cool-off (tier 1).
      let { gate } = step(defaultGate(), { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 1 });
      ({ gate } = step(gate, { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 1 }));
      ({ gate } = step(gate, { kind: 'deals_cycle', reachedDealsFeed: false, transientFailures: 1 }));
      assert.equal(gate.state, 'cooling');
      assert.equal(gate.b5_tier, 1);

      ({ gate } = step(gate, { kind: 'cooling_expired' }));
      const granted = { ...gate, probe_used: 1, probe_granted_at: NOW_ISO };
      const { gate: next, events } = step(granted, { kind: 'probe_expired' });
      assert.equal(next.state, 'cooling');
      assert.equal(next.rule, 'B5');
      assert.equal(next.b5_tier, 2);
      assert.equal(next.until_at, new Date(NOW + 4 * 300000).toISOString());
      assert.equal(events.length, 1);
      assert.equal(events[0].reason, 'probe expired');
    });

    test('an unanswered probe after a manual resume lands on B5 tier 1', () => {
      const { gate: stopped } = step(defaultGate(), { kind: 'cloudflare_block', surface: 'deals' });
      const { gate: probing } = step(stopped, { kind: 'resume' });
      const granted = { ...probing, probe_used: 1, probe_granted_at: NOW_ISO };
      const { gate: next } = step(granted, { kind: 'probe_expired' });
      assert.equal(next.state, 'cooling');
      assert.equal(next.rule, 'B5');
      assert.equal(next.b5_tier, 1);
      assert.equal(next.until_at, new Date(NOW + 2 * 300000).toISOString());
    });

    test('probe_expired is a no-op when the probe was not granted (probe_used 0)', () => {
      const { gate: cooling } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals' });
      const { gate: probing } = step(cooling, { kind: 'cooling_expired' });
      assert.equal(probing.probe_used, 0);
      const { gate, events, changed } = step(probing, { kind: 'probe_expired' });
      assert.equal(changed, false);
      assert.equal(events.length, 0);
      assert.deepEqual(gate, probing);
    });

    test('probe_expired is a no-op when the gate is not probing', () => {
      const { gate: cooling } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals' });
      const { gate: stopped } = step(defaultGate(), { kind: 'cloudflare_block', surface: 'deals' });
      for (const [label, g] of [['open', defaultGate()], ['cooling', cooling], ['stopped', stopped]]) {
        const granted = { ...g, probe_used: 1, probe_granted_at: NOW_ISO };
        const { events, changed } = step(granted, { kind: 'probe_expired' });
        assert.equal(changed, false, `probe_expired while ${label} is a no-op`);
        assert.equal(events.length, 0, `probe_expired while ${label} writes nothing`);
      }
    });
  });

  describe('effectiveGate: the lazy transitions, in memory, without writing', () => {
    test('a cooling gate whose until_at has passed is reported as probing', () => {
      const row = {
        ...defaultGate(),
        state: 'cooling',
        rule: 'B5',
        tier: 1,
        until_at: '2026-09-25T03:59:00.000Z',
      };
      const g = effectiveGate(row, NOW);
      assert.equal(g.state, 'probing');
      assert.equal(row.state, 'cooling', 'the input row is left untouched');
    });

    test('a cooling gate whose until_at is in the future stays cooling', () => {
      const row = {
        ...defaultGate(),
        state: 'cooling',
        rule: 'B2',
        tier: 1,
        until_at: '2026-09-25T04:15:00.000Z',
      };
      assert.equal(effectiveGate(row, NOW).state, 'cooling');
    });

    test('a granted probe past the 10-minute window is reported as cooling', () => {
      const row = {
        ...defaultGate(),
        state: 'probing',
        rule: 'B5',
        tier: 1,
        probe_used: 1,
        probe_granted_at: '2026-09-25T03:49:00.000Z',
      };
      assert.equal(effectiveGate(row, NOW).state, 'cooling');
    });

    test('a granted probe inside the 10-minute window stays probing', () => {
      const row = {
        ...defaultGate(),
        state: 'probing',
        rule: 'B5',
        tier: 1,
        probe_used: 1,
        probe_granted_at: '2026-09-25T03:55:00.000Z',
      };
      assert.equal(effectiveGate(row, NOW).state, 'probing');
    });

    test('an open or stopped gate is unchanged', () => {
      assert.equal(effectiveGate(defaultGate(), NOW).state, 'open');
      const stopped = { ...defaultGate(), state: 'stopped', rule: 'B1' };
      assert.equal(effectiveGate(stopped, NOW).state, 'stopped');
    });
  });

  describe('the manual resume', () => {
    test('resume moves a stopped gate to probing with zeroed counters', () => {
      const { gate: stopped } = step(defaultGate(), { kind: 'cloudflare_block', surface: 'deals' });
      const { gate, events } = step(stopped, { kind: 'resume' });
      assert.equal(gate.state, 'probing');
      assert.equal(gate.rule, 'B5');
      assert.equal(gate.tier, 0);
      assert.equal(gate.reason, 'manual resume');
      assert.equal(gate.consecutive_b2, 0);
      assert.equal(gate.failing_cycles, 0);
      assert.equal(gate.b5_tier, 0);
      assert.equal(gate.probe_used, 0);
      assert.equal(gate.probe_granted_at, null);
      assert.equal(gate.until_at, null);
      assert.equal(gate.min_resume_at, null);
      assert.equal(events.length, 1);
      assert.equal(events[0].from_state, 'stopped');
      assert.equal(events[0].to_state, 'probing');
    });

    test('resume while open is a no-op', () => {
      const { events, changed } = step(defaultGate(), { kind: 'resume' });
      assert.equal(changed, false);
      assert.equal(events.length, 0);
    });

    test('a failed probe after a manual resume lands on B5 tier 1', () => {
      const { gate: stopped } = step(defaultGate(), { kind: 'cloudflare_block', surface: 'deals' });
      const { gate: probing } = step(stopped, { kind: 'resume' });
      const { gate } = step(probing, { kind: 'transient', surface: 'deals' });
      assert.equal(gate.state, 'cooling');
      assert.equal(gate.rule, 'B5');
      assert.equal(gate.b5_tier, 1);
      assert.equal(gate.until_at, new Date(NOW + 2 * 300000).toISOString());
    });
  });

  describe('reason hygiene and unknown signals', () => {
    test('reasons are short fixed text: class + surface label', () => {
      const { gate } = step(defaultGate(), { kind: 'rate_limited', surface: 'deals' });
      assert.equal(gate.reason, 'rate_limited on deals feed');
      const { gate: cls } = step(defaultGate(), { kind: 'cloudflare_block', surface: 'classifieds' });
      assert.equal(cls.reason, 'cloudflare_block on classifieds');
    });

    test('an unknown signal kind throws', () => {
      assert.throws(() => step(defaultGate(), { kind: 'bogus' }), /apply: unknown signal kind "bogus"/);
    });
  });
});
