import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../../lib/store/index.js';
import { fixedClock } from '../../../lib/clock.js';

// The gate tables are added by migration v3 (the prompt said v2, but the
// store was already at v2 when the gate was built — see the hand-back
// report, section 5).
const V3_TABLES = [
  'access_gate',
  'deals',
  'feed_state',
  'failures',
  'gate_events',
  'ledger',
  'observations',
  'pending_alerts',
  'poll_state',
  'providers',
  'rules',
  'settings',
  'suppressions',
].sort();

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-gate-store-'));
  const dbPath = join(dir, 'test.db');
  const store = openStore({ path: dbPath, clock: fixedClock('2026-09-19T06:20:00Z') });
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Roll a real store's database back to the given schema version by dropping
 * whatever the later migrations added and resetting schema_version. The
 * caller supplies the per-version statements (the v1 rollback also drops the
 * v2 unique index and the `sent` column, exactly as store.test.js does).
 */
function rollBackTo(build, version, statements) {
  const db = build.getDb();
  for (const statement of statements) db.exec(statement);
  db.prepare('DELETE FROM schema_version').run();
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, '2026-09-19T06:20:00Z');
}

describe('store: the persisted access gate (3.7)', () => {
  test('a fresh database is created at schema version 3 with all thirteen tables', () => {
    withStore((store) => {
      assert.equal(store.schemaVersion, 3);
      assert.deepEqual([...store.tables].sort(), V3_TABLES);
      assert.equal(store.tables.length, 13);
    });
  });

  test('the gate row is seeded open by the migration', () => {
    withStore((store) => {
      const gate = store.getGate();
      assert.ok(gate, 'the gate row exists');
      assert.equal(gate.id, 1);
      assert.equal(gate.state, 'open');
      assert.equal(gate.rule, null);
      assert.equal(gate.tier, 0);
      assert.equal(gate.reason, null);
      assert.equal(gate.until_at, null);
      assert.equal(gate.min_resume_at, null);
      assert.equal(gate.consecutive_b2, 0);
      assert.equal(gate.failing_cycles, 0);
      assert.equal(gate.b5_tier, 0);
      assert.equal(gate.probe_used, 0);
    });
  });

  test('openStore migrates a v1 database to v3 (gate tables created, v2 de-duplication intact)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ozb-gate-store-'));
    const dbPath = join(dir, 'test.db');
    const clock = fixedClock('2026-09-19T06:20:00Z');

    // 1. Build a real store (v3), then roll it back to a v1-shaped database.
    const build = openStore({ path: dbPath, clock });
    const db = build.getDb();
    db.prepare(
      `INSERT INTO deals (node_id, title, url, author, posted_at, categories, first_seen)
       VALUES (1, 'test deal', 'https://example.com/node/1', 'author', '2026-09-19T06:20:00Z', '[]', '2026-09-19T06:20:00Z')`,
    ).run();
    // Roll the schema back to v1 first (drop the unique index and the v3
    // gate tables), so the two duplicate rows below are insertable.
    db.exec('DROP INDEX idx_gate_events_at');
    db.exec('DROP TABLE gate_events');
    db.exec('DROP TABLE access_gate');
    db.exec('DROP INDEX idx_observations_deal_poll');
    db.exec('ALTER TABLE ledger DROP COLUMN sent');
    db.prepare(
      `INSERT INTO observations (deal_id, votes_pos, votes_neg, comment_count, click_count, observed_at)
       VALUES (1, 10, 0, 5, 100, '2026-09-19T07:30:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO observations (deal_id, votes_pos, votes_neg, comment_count, click_count, observed_at)
       VALUES (1, 12, 0, 6, 110, '2026-09-19T07:30:00Z')`,
    ).run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 2, 'v1 state: two rows for one (deal, poll) pair');
    rollBackTo(build, 1, []);
    build.close();

    // 2. Re-open: the v2 + v3 migrations must run in order.
    const store = openStore({ path: dbPath, clock });
    const db2 = store.getDb();
    assert.equal(store.schemaVersion, 3, 'migrated to v3');
    // The v2 migration de-duplicated before creating the index.
    const obs = db2.prepare('SELECT id, deal_id, observed_at FROM observations ORDER BY id').all();
    assert.equal(obs.length, 1, 'one row per (deal, poll) pair after migration');
    // The v3 migration created the gate tables and seeded the open row.
    const gate = store.getGate();
    assert.ok(gate, 'the gate row was created by the v3 migration');
    assert.equal(gate.state, 'open');
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('openStore migrates a v2 database to v3 (gate tables created, existing data intact)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ozb-gate-store-'));
    const dbPath = join(dir, 'test.db');
    const clock = fixedClock('2026-09-19T06:20:00Z');

    // 1. Build a real store (v3) with a failure row, then roll it back to v2.
    const build = openStore({ path: dbPath, clock });
    build.insertFailure({ failed_at: '2026-09-19T06:01:00Z', response_class: 'transient', body: 'b' });
    rollBackTo(build, 2, [
      'DROP INDEX idx_gate_events_at',
      'DROP TABLE gate_events',
      'DROP TABLE access_gate',
    ]);
    build.close();

    // 2. Re-open: only the v3 migration runs.
    const store = openStore({ path: dbPath, clock });
    assert.equal(store.schemaVersion, 3, 'migrated to v3');
    const gate = store.getGate();
    assert.ok(gate, 'the gate row was created by the v3 migration');
    assert.equal(gate.state, 'open');
    // The pre-existing data survived.
    assert.equal(store.getFailures().length, 1, 'the pre-existing failure row is intact');
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('applyGateTransition persists the row and its events in one transaction', () => {
    withStore((store) => {
      const now = '2026-09-19T06:20:00Z';
      store.applyGateTransition(
        {
          state: 'cooling',
          rule: 'B2',
          tier: 1,
          reason: 'rate_limited on deals feed',
          since: now,
          until_at: '2026-09-19T06:35:00Z',
          min_resume_at: null,
          consecutive_b2: 1,
          failing_cycles: 0,
          b5_tier: 0,
          probe_used: 0,
        },
        [
          {
            at: now,
            from_state: 'open',
            to_state: 'cooling',
            rule: 'B2',
            tier: 1,
            reason: 'rate_limited on deals feed',
            until_at: '2026-09-19T06:35:00Z',
            min_resume_at: null,
          },
        ],
      );
      const gate = store.getGate();
      assert.equal(gate.state, 'cooling');
      assert.equal(gate.rule, 'B2');
      assert.equal(gate.tier, 1);
      assert.equal(gate.until_at, '2026-09-19T06:35:00Z');
      assert.equal(gate.consecutive_b2, 1);
      const events = store.getGateEvents();
      assert.equal(events.length, 1);
      assert.equal(events[0].from_state, 'open');
      assert.equal(events[0].to_state, 'cooling');
      assert.equal(events[0].rule, 'B2');
      assert.equal(events[0].notified, 0);
      assert.equal(events[0].email_status, null);
    });
  });

  test('applyGateTransition rolls back the row and the events when the write throws', () => {
    withStore((store) => {
      const now = '2026-09-19T06:20:00Z';
      // A valid transition first, so there is a previous state to stand.
      store.applyGateTransition(
        {
          state: 'cooling',
          rule: 'B2',
          tier: 1,
          reason: 'rate_limited on deals feed',
          since: now,
          until_at: '2026-09-19T06:35:00Z',
          min_resume_at: null,
          consecutive_b2: 1,
          failing_cycles: 0,
          b5_tier: 0,
          probe_used: 0,
        },
        [
          {
            at: now,
            from_state: 'open',
            to_state: 'cooling',
            rule: 'B2',
            tier: 1,
            reason: 'rate_limited on deals feed',
            until_at: '2026-09-19T06:35:00Z',
            min_resume_at: null,
          },
        ],
      );
      // A bad state violates the CHECK constraint: the row update and the
      // event insert must roll back together, and the previous state stands.
      assert.throws(() => {
        store.applyGateTransition(
          {
            state: 'bogus',
            rule: null,
            tier: 0,
            reason: null,
            since: now,
            until_at: null,
            min_resume_at: null,
            consecutive_b2: 0,
            failing_cycles: 0,
            b5_tier: 0,
            probe_used: 0,
          },
          [
            {
              at: now,
              from_state: 'cooling',
              to_state: 'bogus',
              rule: null,
              tier: null,
              reason: null,
              until_at: null,
              min_resume_at: null,
            },
          ],
        );
      });
      const gate = store.getGate();
      assert.equal(gate.state, 'cooling', 'the previous state stands after the rollback');
      assert.equal(gate.rule, 'B2');
      assert.equal(gate.consecutive_b2, 1);
      const events = store.getGateEvents();
      assert.equal(events.length, 1, 'the rolled-back event was not written');
      assert.equal(events[0].to_state, 'cooling');
    });
  });

  test('getGateEvents returns events newest-first with a limit', () => {
    withStore((store) => {
      const insert = (i, toState) => {
        store.applyGateTransition(
          {
            state: toState,
            rule: 'B2',
            tier: i,
            reason: `rate_limited on deals feed ${i}`,
            since: `2026-09-19T06:${String(i).padStart(2, '0')}:00Z`,
            until_at: null,
            min_resume_at: null,
            consecutive_b2: i,
            failing_cycles: 0,
            b5_tier: 0,
            probe_used: 0,
          },
          [
            {
              at: `2026-09-19T06:${String(i).padStart(2, '0')}:00Z`,
              from_state: 'open',
              to_state: toState,
              rule: 'B2',
              tier: i,
              reason: `rate_limited on deals feed ${i}`,
              until_at: null,
              min_resume_at: null,
            },
          ],
        );
      };
      insert(1, 'cooling');
      insert(2, 'cooling');
      insert(3, 'stopped');

      const all = store.getGateEvents();
      assert.equal(all.length, 3);
      assert.deepEqual(all.map((e) => e.tier), [3, 2, 1], 'the newest event is first');
      assert.deepEqual(all.map((e) => e.notified), [0, 0, 0], 'every event is unnotified');
      assert.ok(all.every((e) => e.email_status === null), 'email_status is NULL on every event');

      const limited = store.getGateEvents({ limit: 2 });
      assert.equal(limited.length, 2);
      assert.deepEqual(limited.map((e) => e.tier), [3, 2]);
    });
  });

  test('countGateEvents counts B1 stops within the lookback window', () => {
    withStore((store) => {
      const insertB1 = (at) => {
        store.applyGateTransition(
          {
            state: 'stopped',
            rule: 'B1',
            tier: 0,
            reason: 'cloudflare_block on deals feed',
            since: at,
            until_at: null,
            min_resume_at: '2026-10-19T06:20:00Z',
            consecutive_b2: 0,
            failing_cycles: 0,
            b5_tier: 0,
            probe_used: 0,
          },
          [
            {
              at,
              from_state: 'open',
              to_state: 'stopped',
              rule: 'B1',
              tier: 0,
              reason: 'cloudflare_block on deals feed',
              until_at: null,
              min_resume_at: '2026-10-19T06:20:00Z',
            },
          ],
        );
      };
      // 10 days before the fixed instant, and 31 days before it.
      insertB1('2026-09-09T06:20:00Z');
      insertB1('2026-08-19T06:20:00Z');
      // A B2 stop is not a B1 stop.
      store.applyGateTransition(
        {
          state: 'stopped',
          rule: 'B3',
          tier: 0,
          reason: 'rate_limited on deals feed',
          since: '2026-09-09T06:20:00Z',
          until_at: null,
          min_resume_at: '2026-10-19T06:20:00Z',
          consecutive_b2: 5,
          failing_cycles: 0,
          b5_tier: 0,
          probe_used: 0,
        },
        [
          {
            at: '2026-09-09T06:20:00Z',
            from_state: 'probing',
            to_state: 'stopped',
            rule: 'B3',
            tier: 0,
            reason: 'rate_limited on deals feed',
            until_at: null,
            min_resume_at: '2026-10-19T06:20:00Z',
          },
        ],
      );

      // 30-day window: only the 10-day-old stop counts.
      assert.equal(store.countGateEvents({ rule: 'B1', toState: 'stopped', sinceIso: '2026-08-20T06:20:00Z' }), 1);
      // A 31-day window: both stops count.
      assert.equal(store.countGateEvents({ rule: 'B1', toState: 'stopped', sinceIso: '2026-08-19T06:20:00Z' }), 2);
      // The boundary is inclusive (at >= sinceIso).
      assert.equal(store.countGateEvents({ rule: 'B1', toState: 'stopped', sinceIso: '2026-09-09T06:20:00Z' }), 1);
      // A different rule counts nothing.
      assert.equal(store.countGateEvents({ rule: 'B3', toState: 'stopped', sinceIso: '2026-08-19T06:20:00Z' }), 1);
    });
  });

  test('mutateGate holds the write lock across the read and the write (spec 4.1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ozb-gate-store-'));
    const dbPath = join(dir, 'test.db');
    const clock = fixedClock('2026-09-19T06:20:00Z');
    const storeA = openStore({ path: dbPath, clock });
    const storeB = openStore({ path: dbPath, clock });
    try {
      storeA.mutateGate((row) => {
        // From inside the transaction, a second connection with
        // busy_timeout = 0 must fail to acquire the write lock.
        const raw = new DatabaseSync(dbPath);
        try {
          raw.exec('PRAGMA busy_timeout = 0');
          assert.throws(() => raw.exec('BEGIN IMMEDIATE'), /database is locked/);
        } finally {
          raw.close();
        }
        return null;
      });
    } finally {
      if (storeB.getDb().isOpen) storeB.close();
      if (storeA.getDb().isOpen) storeA.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mutateGate: fn returning null writes nothing', () => {
    withStore((store) => {
      // A valid transition first, so there is a previous state to compare.
      store.mutateGate((row) => ({
        gate: { ...row, state: 'cooling', rule: 'B2', tier: 1, reason: 'rate_limited on deals feed', since: '2026-09-19T06:20:00Z', until_at: '2026-09-19T06:35:00Z' },
        events: [
          {
            at: '2026-09-19T06:20:00Z',
            from_state: 'open',
            to_state: 'cooling',
            rule: 'B2',
            tier: 1,
            reason: 'rate_limited on deals feed',
            until_at: '2026-09-19T06:35:00Z',
            min_resume_at: null,
          },
        ],
      }));
      const before = store.getGate();
      const eventsBefore = store.getGateEvents().length;
      // fn returns null: the row must be unchanged.
      const result = store.mutateGate(() => null);
      assert.deepEqual(result, before, 'the returned row is the input row');
      assert.deepEqual(store.getGate(), before, 'the stored row is unchanged');
      assert.equal(store.getGateEvents().length, eventsBefore, 'no new events were written');
    });
  });

  test('mutateGate: a throwing fn rolls back the row and the events', () => {
    withStore((store) => {
      // A valid transition first, so there is a previous state to stand.
      store.mutateGate((row) => ({
        gate: { ...row, state: 'cooling', rule: 'B2', tier: 1, reason: 'rate_limited on deals feed', since: '2026-09-19T06:20:00Z', until_at: '2026-09-19T06:35:00Z' },
        events: [
          {
            at: '2026-09-19T06:20:00Z',
            from_state: 'open',
            to_state: 'cooling',
            rule: 'B2',
            tier: 1,
            reason: 'rate_limited on deals feed',
            until_at: '2026-09-19T06:35:00Z',
            min_resume_at: null,
          },
        ],
      }));
      const before = store.getGate();
      const eventsBefore = store.getGateEvents().length;
      // A throwing fn: the row and events must roll back.
      assert.throws(() => {
        store.mutateGate((row) => {
          // Mutate the row, then throw before returning.
          const gate = { ...row, state: 'cooling', rule: 'B2', tier: 2, reason: 'rate_limited on deals feed 2', since: '2026-09-19T06:21:00Z', until_at: '2026-09-19T06:51:00Z' };
          throw new Error('boom');
        });
      }, /boom/);
      assert.deepEqual(store.getGate(), before, 'the previous state stands after the rollback');
      assert.equal(store.getGateEvents().length, eventsBefore, 'the rolled-back event was not written');
    });
  });
});
