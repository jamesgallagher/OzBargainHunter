/**
 * The access gate end-to-end (design 3.7, acceptance G2–G7, G11 and the
 * concurrency trap): the real client, the real deal and classifieds
 * pollers and the persisted gate over a real store, driven by a fixed
 * clock and a fixture transport. The pure machine is covered in
 * gate-rules.test.js; the store's gate persistence in gate-store.test.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from '../../../lib/store/index.js';
import { createGate } from '../../../lib/gate/index.js';
import { createOzbClient } from '../../../lib/http/client.js';
import { runDealPoll, buildDealPollUrls } from '../../../lib/acquire/poll.js';
import { runClassifiedsPoll } from '../../../lib/acquire/classifieds.js';
import { fixedClock } from '../../../lib/clock.js';
import { seededRandom } from '../../../lib/random.js';
import { createFixtureTransport } from '../../support/fixtureTransport.js';

const P0 = 'https://www.ozbargain.com.au/deals/feed?page=0';
const P1 = 'https://www.ozbargain.com.au/deals/feed?page=1';
const FRONT = 'https://www.ozbargain.com.au/feed';
const CLS = 'https://www.ozbargain.com.au/classified';

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

// A Cloudflare block response: 403 + a body marker (classification is
// body-based, never the server header — design 3.5).
const CF_BLOCK = { status: 403, body: 'error code: 1010' };

/**
 * A fixed clock that records every advance (the G7 wait seam): wraps
 * fixedClock so the test can assert on every wait the client took.
 * @param {string} iso
 * @returns {{ advances: number[], now(): Date, advance(ms: number): Promise<void> }}
 */
function spyClock(iso) {
  const base = fixedClock(iso);
  const advances = [];
  return {
    advances,
    now: () => base.now(),
    advance(ms) {
      advances.push(ms);
      return base.advance(ms);
    },
  };
}

/**
 * A fresh environment: a temp store, a fixed (or supplied) clock, a
 * fixture transport (its routes object is exposed so a test can mutate a
 * route in place between calls — the fixture reads it fresh on every
 * fetch), one gate shared by the client, and a log collector.
 */
function makeEnv({ clockIso = '2026-09-25T04:00:00Z', config = {}, routes = {}, clock } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-gate-poll-'));
  const dbPath = join(dir, 'test.db');
  const theClock = clock ?? fixedClock(clockIso);
  const store = openStore({ path: dbPath, clock: theClock });
  const logLines = [];
  const log = (line) => logLines.push(line);
  const transport = createFixtureTransport(routes);
  const gate = createGate({ store, clock: theClock, config, log });
  const client = createOzbClient({ transport, store, clock: theClock, random: seededRandom(1), config, log, gate });
  return {
    dir,
    dbPath,
    store,
    clock: theClock,
    config,
    routes,
    transport,
    gate,
    client,
    log,
    logLines,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Seed a past B1 stop event in the events table without changing the
 * (open) gate row: the B1 lookback counts events, not the row.
 * @param {object} store
 * @param {object} clock
 * @param {number} daysAgo
 */
function seedPastB1(store, clock, daysAgo) {
  const at = new Date(clock.now().getTime() - daysAgo * DAY).toISOString();
  const minResumeAt = new Date(clock.now().getTime() - daysAgo * DAY + DAY).toISOString();
  store.applyGateTransition(store.getGate(), [
    {
      at,
      from_state: 'open',
      to_state: 'stopped',
      rule: 'B1',
      tier: 0,
      reason: 'cloudflare_block on deals feed',
      until_at: null,
      min_resume_at: minResumeAt,
    },
  ]);
}

describe('gate: end-to-end (design 3.7)', () => {
  test('G2: a Cloudflare block stops the gate for 24 h (7 days after a prior B1 within 30 days)', async () => {
    // 24 h: no prior B1.
    {
      const env = makeEnv({});
      try {
        env.routes[FRONT] = CF_BLOCK;
        const res = await env.client.request(FRONT, { surface: 'deals' });
        assert.equal(res.class, 'cloudflare_block');
        const g = env.store.getGate();
        assert.equal(g.state, 'stopped');
        assert.equal(g.rule, 'B1');
        assert.equal(g.min_resume_at, new Date(env.clock.now().getTime() + DAY).toISOString());
      } finally {
        env.close();
      }
    }
    // 7 days: a prior B1 stop 10 days earlier (within the 30-day lookback).
    {
      const env = makeEnv({});
      try {
        seedPastB1(env.store, env.clock, 10);
        env.routes[FRONT] = CF_BLOCK;
        await env.client.request(FRONT, { surface: 'deals' });
        const g = env.store.getGate();
        assert.equal(g.state, 'stopped');
        assert.equal(g.min_resume_at, new Date(env.clock.now().getTime() + 7 * DAY).toISOString());
      } finally {
        env.close();
      }
    }
    // 24 h: a prior B1 stop 31 days earlier (outside the lookback).
    {
      const env = makeEnv({});
      try {
        seedPastB1(env.store, env.clock, 31);
        env.routes[FRONT] = CF_BLOCK;
        await env.client.request(FRONT, { surface: 'deals' });
        const g = env.store.getGate();
        assert.equal(g.state, 'stopped');
        assert.equal(g.min_resume_at, new Date(env.clock.now().getTime() + DAY).toISOString());
      } finally {
        env.close();
      }
    }
  });

  test('G2: resume() is refused before min_resume_at and allowed at it', async () => {
    const env = makeEnv({});
    try {
      env.routes[FRONT] = CF_BLOCK;
      await env.client.request(FRONT, { surface: 'deals' });
      const tooEarly = env.gate.resume();
      assert.equal(tooEarly.ok, false);
      assert.equal(tooEarly.reason, 'too_early');
      assert.equal(tooEarly.minResumeAt, env.store.getGate().min_resume_at);
      await env.clock.advance(DAY); // now === min_resume_at
      assert.deepEqual(env.gate.resume(), { ok: true });
      assert.equal(env.store.getGate().state, 'probing');
    } finally {
      env.close();
    }
  });

  test('G2: resume() on an open gate is not_stopped', async () => {
    const env = makeEnv({});
    try {
      assert.deepEqual(env.gate.resume(), { ok: false, reason: 'not_stopped' });
    } finally {
      env.close();
    }
  });

  test('G3: the B2 ladder cools 15m/30m/1h/2h and the 5th consecutive 429 stops (B3)', async () => {
    const env = makeEnv({});
    try {
      env.routes[P0] = { status: 429, headers: { 'Retry-After': '60' } };
      const delays = [15 * MIN, 30 * MIN, 60 * MIN, 120 * MIN];
      for (let i = 0; i < 4; i++) {
        if (i > 0) await env.clock.advance(delays[i - 1]); // to the previous until_at
        const before = env.clock.now().getTime();
        await env.client.request(P0, { surface: 'deals' });
        const g = env.store.getGate();
        assert.equal(g.state, 'cooling');
        assert.equal(g.rule, 'B2');
        assert.equal(g.tier, i + 1);
        assert.equal(g.consecutive_b2, i + 1);
        assert.equal(g.until_at, new Date(before + delays[i]).toISOString());
      }
      // The 5th consecutive 429: B3 — stopped, manual resume after 24 h.
      await env.clock.advance(delays[3]);
      const before = env.clock.now().getTime();
      await env.client.request(P0, { surface: 'deals' });
      const g = env.store.getGate();
      assert.equal(g.state, 'stopped');
      assert.equal(g.rule, 'B3');
      assert.equal(g.min_resume_at, new Date(before + DAY).toISOString());
    } finally {
      env.close();
    }
  });

  test('G3: Retry-After feeds the gate (7200 s at tier 1; the 24 h cap; 503 like 429)', async () => {
    {
      const env = makeEnv({});
      try {
        env.routes[P0] = { status: 429, headers: { 'Retry-After': '7200' } };
        await env.client.request(P0, { surface: 'deals' });
        const g = env.store.getGate();
        assert.equal(g.state, 'cooling');
        assert.equal(g.until_at, new Date(env.clock.now().getTime() + 7200000).toISOString());
      } finally {
        env.close();
      }
    }
    {
      const env = makeEnv({});
      try {
        env.routes[P0] = { status: 429, headers: { 'Retry-After': '200000' } };
        await env.client.request(P0, { surface: 'deals' });
        const g = env.store.getGate();
        assert.equal(g.until_at, new Date(env.clock.now().getTime() + DAY).toISOString());
      } finally {
        env.close();
      }
    }
    {
      const env = makeEnv({});
      try {
        env.routes[P0] = { status: 503 };
        await env.client.request(P0, { surface: 'deals' });
        const g = env.store.getGate();
        assert.equal(g.state, 'cooling');
        assert.equal(g.until_at, new Date(env.clock.now().getTime() + 15 * MIN).toISOString());
      } finally {
        env.close();
      }
    }
  });

  test('G3: a successful probe reopens the gate and resets the counters', async () => {
    const env = makeEnv({});
    try {
      env.routes[P0] = { status: 429, headers: { 'Retry-After': '60' } };
      await env.client.request(P0, { surface: 'deals' });
      assert.equal(env.store.getGate().state, 'cooling');
      await env.clock.advance(15 * MIN);
      env.routes[P0] = { status: 200, body: 'x' };
      const res = await env.client.request(P0, { surface: 'deals' });
      assert.equal(res.class, 'ok');
      const g = env.store.getGate();
      assert.equal(g.state, 'open');
      assert.equal(g.consecutive_b2, 0);
      assert.equal(g.failing_cycles, 0);
      assert.equal(g.b5_tier, 0);
    } finally {
      env.close();
    }
  });

  test('G4: permission_denied on the deals surface stops the gate (B4, immediate resume)', async () => {
    const env = makeEnv({});
    try {
      env.routes[P0] = { status: 403, body: 'forbidden' };
      const res = await env.client.request(P0, { surface: 'deals' });
      assert.equal(res.class, 'permission_denied');
      const g = env.store.getGate();
      assert.equal(g.state, 'stopped');
      assert.equal(g.rule, 'B4');
      assert.equal(g.min_resume_at, env.clock.now().toISOString());
      // min_resume_at is "now": resume works immediately.
      assert.deepEqual(env.gate.resume(), { ok: true });
      assert.equal(env.store.getGate().state, 'probing');
    } finally {
      env.close();
    }
  });

  test('G4: permission_denied on classifieds leaves the gate open', async () => {
    const env = makeEnv({});
    try {
      env.routes[CLS] = { status: 403, body: 'forbidden' };
      const res = await env.client.request(CLS, { surface: 'classifieds' });
      assert.equal(res.class, 'permission_denied');
      assert.equal(env.store.getGate().state, 'open');
    } finally {
      env.close();
    }
  });

  test('G5: three failing deals cycles cool the gate (B5, 2x interval)', async () => {
    const env = makeEnv({ config: { OZB_POLL_INTERVAL_SECONDS: 300 } });
    try {
      env.routes[P0] = { status: 500 };
      env.routes[P1] = { status: 500 };
      env.routes[FRONT] = { status: 500 };
      for (let i = 1; i <= 2; i++) {
        await runDealPoll({ client: env.client, store: env.store, clock: env.clock, config: env.config, log: env.log, gate: env.gate });
        const g = env.store.getGate();
        assert.equal(g.state, 'open');
        assert.equal(g.failing_cycles, i);
        assert.equal(env.store.getGateEvents().length, 0, 'a counter-only change writes no event');
      }
      await runDealPoll({ client: env.client, store: env.store, clock: env.clock, config: env.config, log: env.log, gate: env.gate });
      const g = env.store.getGate();
      assert.equal(g.state, 'cooling');
      assert.equal(g.rule, 'B5');
      assert.equal(g.tier, 1);
      // until = the cycle end + min(interval x 2^1, cap) = +600 s. No
      // clock advance happens after the transition, so "now" is the
      // transition instant.
      assert.equal(g.until_at, new Date(env.clock.now().getTime() + 600000).toISOString());
    } finally {
      env.close();
    }
  });

  test('G5: a failed B5 probe re-cools 4x, 8x, ... capped at 6 h; a good probe reopens', async () => {
    const env = makeEnv({ config: { OZB_POLL_INTERVAL_SECONDS: 300 } });
    try {
      env.routes[P0] = { status: 500 };
      env.routes[P1] = { status: 500 };
      env.routes[FRONT] = { status: 500 };
      await runDealPoll({ client: env.client, store: env.store, clock: env.clock, config: env.config, log: env.log, gate: env.gate });
      await runDealPoll({ client: env.client, store: env.store, clock: env.clock, config: env.config, log: env.log, gate: env.gate });
      await runDealPoll({ client: env.client, store: env.store, clock: env.clock, config: env.config, log: env.log, gate: env.gate });
      assert.equal(env.store.getGate().state, 'cooling');
      // b5_tier 2..7: 4x, 8x, 16x, 32x, 64x the interval, capped at 6 h.
      const expected = [1200000, 2400000, 4800000, 9600000, 19200000, 6 * HOUR];
      for (let i = 0; i < 6; i++) {
        const prevUntil = Date.parse(env.store.getGate().until_at);
        await env.clock.advance(prevUntil - env.clock.now().getTime());
        await runDealPoll({ client: env.client, store: env.store, clock: env.clock, config: env.config, log: env.log, gate: env.gate });
        const g = env.store.getGate();
        assert.equal(g.state, 'cooling');
        assert.equal(g.b5_tier, i + 2);
        assert.equal(g.until_at, new Date(prevUntil + expected[i]).toISOString());
      }
      // A good probe reopens and resets the counters (exactly one request).
      env.routes[P0] = { status: 200, fixture: 'http/r0.xml' };
      const prevUntil = Date.parse(env.store.getGate().until_at);
      await env.clock.advance(prevUntil - env.clock.now().getTime());
      const callsBefore = env.transport.calls;
      await runDealPoll({ client: env.client, store: env.store, clock: env.clock, config: env.config, log: env.log, gate: env.gate });
      const g = env.store.getGate();
      assert.equal(g.state, 'open');
      assert.equal(g.failing_cycles, 0);
      assert.equal(g.b5_tier, 0);
      assert.equal(env.transport.calls, callsBefore + 1, 'the probe is exactly one request');
      // The next full cycle makes three requests.
      env.routes[P1] = { status: 200, fixture: 'http/r1.xml' };
      env.routes[FRONT] = { status: 200, fixture: 'http/feed_feed.xml' };
      await runDealPoll({ client: env.client, store: env.store, clock: env.clock, config: env.config, log: env.log, gate: env.gate });
      assert.equal(env.transport.calls, callsBefore + 4);
    } finally {
      env.close();
    }
  });

  test('G5: unparseable and not_found cycles do not count as failing', async () => {
    const env = makeEnv({ config: { OZB_POLL_INTERVAL_SECONDS: 300 } });
    try {
      env.routes[P0] = { status: 200, body: 'not xml' };
      env.routes[P1] = { status: 404 };
      env.routes[FRONT] = { status: 200, fixture: 'http/feed_feed.xml' };
      const result = await runDealPoll({ client: env.client, store: env.store, clock: env.clock, config: env.config, log: env.log, gate: env.gate });
      assert.equal(result.failures, 2, 'the unparseable and not_found rows are recorded');
      const g = env.store.getGate();
      assert.equal(g.state, 'open');
      assert.equal(g.failing_cycles, 0);
      assert.equal(env.store.getGateEvents().length, 0);
    } finally {
      env.close();
    }
  });

  test('G6: a closed gate makes zero requests and zero failures rows (no catch-up)', async () => {
    const env = makeEnv({});
    try {
      const now = env.clock.now();
      env.store.applyGateTransition(
        {
          ...env.store.getGate(),
          state: 'cooling',
          rule: 'B5',
          tier: 1,
          reason: 'deals_cycle on deals feed',
          since: now.toISOString(),
          until_at: new Date(now.getTime() + 2 * HOUR).toISOString(),
          min_resume_at: null,
          consecutive_b2: 0,
          failing_cycles: 3,
          b5_tier: 1,
          probe_used: 0,
        },
        [],
      );
      const callsBefore = env.transport.calls;
      const result = await runDealPoll({ client: env.client, store: env.store, clock: env.clock, config: env.config, log: env.log, gate: env.gate });
      assert.equal(result.skipped, 'gate_closed');
      assert.equal(env.transport.calls, callsBefore, 'a closed gate makes zero deals requests');
      assert.equal(env.store.getFailures().length, 0, 'a closed gate writes zero failures rows');

      env.store.setSetting('classifieds_enabled', '1');
      env.store.setSetting('ozb_account_cookie', 'test-session=authenticated');
      const clsResult = await runClassifiedsPoll({ client: env.client, store: env.store, clock: env.clock, config: env.config, log: env.log, gate: env.gate });
      assert.equal(clsResult.state, 'gate_closed');
      assert.equal(env.transport.calls, callsBefore, 'a closed gate makes zero classifieds requests');
      assert.equal(env.store.getFailures().length, 0);

      // The first tick at/after until_at makes exactly one request (the probe).
      env.routes[P0] = { status: 200, fixture: 'http/r0.xml' };
      await env.clock.advance(2 * HOUR);
      await runDealPoll({ client: env.client, store: env.store, clock: env.clock, config: env.config, log: env.log, gate: env.gate });
      assert.equal(env.transport.calls, callsBefore + 1, 'the first tick after the cool-off is exactly the probe');
      assert.equal(env.store.getGate().state, 'open');

      // The next tick makes three requests.
      env.routes[P1] = { status: 200, fixture: 'http/r1.xml' };
      env.routes[FRONT] = { status: 200, fixture: 'http/feed_feed.xml' };
      await runDealPoll({ client: env.client, store: env.store, clock: env.clock, config: env.config, log: env.log, gate: env.gate });
      assert.equal(env.transport.calls, callsBefore + 4);
    } finally {
      env.close();
    }
  });

  test('G6: a restart between the probe grant and the probe cannot replay the probe', async () => {
    const env = makeEnv({});
    let store2;
    try {
      const now = env.clock.now();
      env.store.applyGateTransition(
        {
          ...env.store.getGate(),
          state: 'cooling',
          rule: 'B5',
          tier: 1,
          reason: 'deals_cycle on deals feed',
          since: now.toISOString(),
          until_at: new Date(now.getTime() + 15 * MIN).toISOString(),
          min_resume_at: null,
          consecutive_b2: 0,
          failing_cycles: 3,
          b5_tier: 1,
          probe_used: 0,
        },
        [],
      );
      await env.clock.advance(15 * MIN);
      env.gate.read(); // the lazy cooling -> probing transition
      assert.equal(env.store.getGate().state, 'probing');
      const verdict = env.gate.check(env.gate.probeUrl);
      assert.equal(verdict.allowed, true);
      assert.equal(env.store.getGate().probe_used, 1, 'the probe is consumed in the same transaction');
      // Crash before the request goes out: close the store, then open a
      // new store and gate on the same database file.
      env.store.close();
      store2 = openStore({ path: env.dbPath, clock: env.clock });
      const gate2 = createGate({ store: store2, clock: env.clock, config: env.config, log: env.log });
      assert.equal(gate2.check(gate2.probeUrl).allowed, false, 'the persisted probe_used blocks a replay');
      const client2 = createOzbClient({ transport: env.transport, store: store2, clock: env.clock, random: seededRandom(1), config: env.config, log: env.log, gate: gate2 });
      const callsBefore = env.transport.calls;
      await assert.rejects(
        client2.request(env.gate.probeUrl, { surface: 'deals' }),
        (err) => {
          assert.equal(err.name, 'BlockedError');
          assert.equal(err.gateState, 'probing');
          return true;
        },
      );
      assert.equal(env.transport.calls, callsBefore, 'the replayed probe never reaches the transport');

      // The probe was granted but never answered (the process died).
      // Ten minutes after the grant, the next read expires it and the
      // gate re-cools at the next B5 tier (2: 4x the interval).
      await env.clock.advance(10 * MIN);
      const eventsBeforeExpiry = store2.getGateEvents().length;
      gate2.read();
      const g2 = store2.getGate();
      assert.equal(g2.state, 'cooling');
      assert.equal(g2.rule, 'B5');
      assert.equal(g2.b5_tier, 2);
      assert.equal(g2.until_at, new Date(env.clock.now().getTime() + 4 * 300000).toISOString());
      assert.equal(store2.getGateEvents().length, eventsBeforeExpiry + 1);
      const expiryEvent = store2.getGateEvents()[0];
      assert.equal(expiryEvent.from_state, 'probing');
      assert.equal(expiryEvent.to_state, 'cooling');
      assert.equal(expiryEvent.rule, 'B5');
      assert.equal(expiryEvent.tier, 2);
      assert.equal(expiryEvent.reason, 'probe expired');
      // A second read after the expiry writes nothing (idempotent).
      gate2.read();
      assert.equal(store2.getGateEvents().length, eventsBeforeExpiry + 1, 'the second read after the expiry writes nothing');

      // After the re-cool, the first tick makes exactly one new probe.
      env.routes[P0] = { status: 200, fixture: 'http/r0.xml' };
      await env.clock.advance(Date.parse(g2.until_at) - env.clock.now().getTime());
      const callsBeforeProbe = env.transport.calls;
      await runDealPoll({ client: client2, store: store2, clock: env.clock, config: env.config, log: env.log, gate: gate2 });
      assert.equal(env.transport.calls, callsBeforeProbe + 1, 'the first tick after the re-cool is exactly the probe');
      assert.equal(store2.getGate().state, 'open');
    } finally {
      if (store2) store2.close();
      try {
        env.store.close();
      } catch {
        // already closed by the crash simulation
      }
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  test('G7: no path waits more than 60 s in-request (the 3 s pause is unchanged)', async () => {
    // A 429 with Retry-After 3600 waits nothing in-request: the gate
    // cools instead (design 3.7).
    {
      const clock = spyClock('2026-09-25T04:00:00Z');
      const env = makeEnv({ clock });
      try {
        env.routes[P0] = { status: 429, headers: { 'Retry-After': '3600' } };
        await env.client.request(P0, { surface: 'deals' });
        assert.equal(clock.advances.length, 0, 'a rate_limited response waits nothing in-request');
        const g = env.store.getGate();
        assert.equal(g.state, 'cooling');
        assert.equal(g.until_at, new Date(clock.now().getTime() + HOUR).toISOString());
      } finally {
        env.close();
      }
    }
    // 10 consecutive transient 5xx + 10 transport rejections: every wait
    // is at most 60 s, apart from the unchanged 3 s pause.
    {
      const clock = spyClock('2026-09-25T04:00:00Z');
      const env = makeEnv({ clock });
      try {
        env.routes[P0] = { status: 500 };
        for (let i = 0; i < 10; i++) {
          await env.client.request(P0, { surface: 'deals' });
        }
        delete env.routes[P0]; // an unknown URL is a transport rejection
        for (let i = 0; i < 10; i++) {
          await assert.rejects(env.client.request(P0, { surface: 'deals' }));
        }
        assert.ok(clock.advances.length > 0, 'the client waited between requests');
        assert.ok(
          clock.advances.every((ms) => ms <= 60000),
          `every in-request wait is at most 60 s: ${JSON.stringify(clock.advances)}`,
        );
        assert.ok(clock.advances.includes(3000), 'the 3 s inter-request pause is unchanged');
        assert.equal(env.store.getGate().state, 'open', 'transient/transport failures while open do not close the gate');
      } finally {
        env.close();
      }
    }
  });

  test('G11: no gate state, event or log line carries a body, cookie or header value', async () => {
    const env = makeEnv({});
    try {
      // A 429 on classifieds with the sentinel cookie cools the gate (B2).
      env.routes[CLS] = { status: 429, headers: { 'Retry-After': '60' } };
      await env.client.request(CLS, { surface: 'classifieds', cookie: 'SENTINEL_COOKIE_9c2e' });
      assert.equal(env.store.getGate().state, 'cooling');
      // The probe (the only request allowed while probing) is a
      // Cloudflare block with the sentinel body: B1 stops the gate.
      await env.clock.advance(15 * MIN);
      env.routes[P0] = { status: 403, body: 'error code: 1010 SENTINEL_BODY_7f3a' };
      await env.client.request(P0, { surface: 'deals' });
      assert.equal(env.store.getGate().state, 'stopped');

      const gateJson = JSON.stringify(env.store.getGate());
      const eventsJson = JSON.stringify(env.store.getGateEvents());
      for (const sentinel of ['SENTINEL_BODY_7f3a', 'SENTINEL_COOKIE_9c2e']) {
        assert.ok(!gateJson.includes(sentinel), `the gate row carries no ${sentinel}`);
        assert.ok(!eventsJson.includes(sentinel), `the gate events carry no ${sentinel}`);
        assert.ok(!env.logLines.some((line) => line.includes(sentinel)), `no log line carries ${sentinel}`);
      }
    } finally {
      env.close();
    }
  });

  test('concurrency: a queued request is refused when the gate closes behind it (one transport call)', async () => {
    const env = makeEnv({});
    try {
      env.routes[P0] = CF_BLOCK;
      // Back-to-back: both pass the synchronous fast path while the gate
      // is still open; the second is queued behind the first.
      const p1 = env.client.request(P0, { surface: 'deals' });
      const p2 = env.client.request(P0, { surface: 'deals' });
      const r1 = await p1;
      assert.equal(r1.class, 'cloudflare_block');
      assert.equal(env.store.getGate().state, 'stopped');
      await assert.rejects(p2, (err) => {
        assert.equal(err.name, 'BlockedError');
        assert.equal(err.gateState, 'stopped');
        return true;
      });
      assert.equal(env.transport.calls, 1, 'the queued request never reaches the transport');
    } finally {
      env.close();
    }
  });

  test('F8: the gate probeUrl is pinned to buildDealPollUrls(config)[0]', async () => {
    // Default config: the probe is the deals feed page 0, exactly as the
    // poller builds it.
    {
      const env = makeEnv({});
      try {
        assert.equal(env.gate.probeUrl, buildDealPollUrls(env.config)[0]);
      } finally {
        env.close();
      }
    }
    // A feed URL that already has a query: the page param is appended (not
    // dropped), and the gate's probeUrl must still match the poller's
    // first URL.
    {
      const config = { OZB_DEALS_FEED_URL: 'http://127.0.0.1:1/deals/feed?x=1' };
      const env = makeEnv({ config });
      try {
        assert.equal(env.gate.probeUrl, buildDealPollUrls(config)[0]);
      } finally {
        env.close();
      }
    }
  });
});
