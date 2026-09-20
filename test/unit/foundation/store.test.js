import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../lib/store/index.js';
import { fixedClock } from '../../../lib/clock.js';
import { DatabaseSync } from 'node:sqlite';

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-store-'));
  const dbPath = join(dir, 'test.db');
  const store = openStore({ path: dbPath, clock: fixedClock('2026-09-19T06:20:00Z') });
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a fresh database is created at schema version 2 with all eleven tables', () => {
  withStore((store) => {
    assert.equal(store.schemaVersion, 2);
    const expected = [
      'deals',
      'feed_state',
      'failures',
      'ledger',
      'observations',
      'pending_alerts',
      'poll_state',
      'providers',
      'rules',
      'settings',
      'suppressions',
    ].sort();
    assert.deepEqual([...store.tables].sort(), expected);
    assert.equal(store.tables.length, 11);
  });
});

test('running migrations again changes nothing (idempotent)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-store-'));
  const dbPath = join(dir, 'test.db');
  const clock = fixedClock('2026-09-19T06:20:00Z');

  const store1 = openStore({ path: dbPath, clock });
  const version1 = store1.schemaVersion;
  const tables1 = [...store1.tables].sort();
  store1.close();

  const store2 = openStore({ path: dbPath, clock });
  assert.equal(store2.schemaVersion, version1);
  assert.deepEqual([...store2.tables].sort(), tables1);
  store2.close();

  rmSync(dir, { recursive: true, force: true });
});

test('PRAGMA journal_mode returns wal and busy_timeout at least 5000', () => {
  withStore((store) => {
    assert.equal(store.journalMode, 'wal');
    assert.ok(store.busyTimeout >= 5000, `busy_timeout ${store.busyTimeout} < 5000`);
  });
});

test('pruneObservations deletes an observation 8 days old and leaves one 6 days old', () => {
  withStore((store) => {
    const db = store.getDb();
    db.prepare(
      `INSERT INTO deals (node_id, title, url, author, posted_at, categories, first_seen)
       VALUES (1, 'test deal', 'https://example.com/node/1', 'author', '2026-09-19T06:20:00Z', '[]', '2026-09-19T06:20:00Z')`,
    ).run();

    const now = '2026-09-19T06:20:00Z';
    const eightDaysAgo = '2026-09-11T06:20:00Z';
    const sixDaysAgo = '2026-09-13T06:20:00Z';

    store.insertObservation({
      deal_id: 1,
      votes_pos: 10,
      votes_neg: 0,
      comment_count: 5,
      click_count: 100,
      observed_at: eightDaysAgo,
    });
    store.insertObservation({
      deal_id: 1,
      votes_pos: 11,
      votes_neg: 0,
      comment_count: 6,
      click_count: 110,
      observed_at: sixDaysAgo,
    });

    const deleted = store.pruneObservations(new Date(now));
    assert.equal(deleted, 1);

    const rows = db.prepare('SELECT observed_at FROM observations').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].observed_at, sixDaysAgo);
  });
});

test('writeSnapshot can run twice (the periodic snapshot design 4.3 specifies)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-store-'));
  const dbPath = join(dir, 'test.db');
  const snapshotPath = join(dir, 'snapshot.db');
  const clock = fixedClock('2026-09-19T06:20:00Z');

  const store = openStore({ path: dbPath, clock });
  const db = store.getDb();

  db.prepare(
    `INSERT INTO deals (node_id, title, url, author, posted_at, categories, first_seen)
     VALUES (1, 'test deal', 'https://example.com/node/1', 'author', '2026-09-19T06:20:00Z', '[]', '2026-09-19T06:20:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO ledger (node_id, rule_id, fired_at) VALUES (1, 1, '2026-09-19T06:20:00Z')`,
  ).run();

  const dealsBefore = db.prepare('SELECT COUNT(*) AS n FROM deals').get().n;
  const ledgerBefore = db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;

  // First snapshot.
  store.writeSnapshot(snapshotPath);
  // Second snapshot to the same fixed path — must not throw.
  store.writeSnapshot(snapshotPath);

  const snapDb = new DatabaseSync(snapshotPath);
  const dealsAfter = snapDb.prepare('SELECT COUNT(*) AS n FROM deals').get().n;
  const ledgerAfter = snapDb.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;
  snapDb.close();

  assert.equal(dealsAfter, dealsBefore);
  assert.equal(ledgerAfter, ledgerBefore);
  assert.equal(store.journalMode, 'wal');

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('pruneObservations leaves ledger rows intact (deals and ledger are never pruned)', () => {
  withStore((store) => {
    const db = store.getDb();
    db.prepare(
      `INSERT INTO deals (node_id, title, url, author, posted_at, categories, first_seen)
       VALUES (1, 'test deal', 'https://example.com/node/1', 'author', '2026-09-19T06:20:00Z', '[]', '2026-09-19T06:20:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO ledger (node_id, rule_id, fired_at) VALUES (1, 1, '2026-09-19T06:20:00Z')`,
    ).run();
    store.insertObservation({
      deal_id: 1,
      votes_pos: 10,
      votes_neg: 0,
      comment_count: 5,
      click_count: 100,
      observed_at: '2026-09-11T06:20:00Z', // 8 days old -> pruned
    });

    const now = '2026-09-19T06:20:00Z';
    store.pruneObservations(new Date(now));

    // The old observation is gone, but the ledger row survives.
    const obsRows = db.prepare('SELECT COUNT(*) AS n FROM observations').get().n;
    const ledgerRows = db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;
    const dealRows = db.prepare('SELECT COUNT(*) AS n FROM deals').get().n;
    assert.equal(obsRows, 0);
    assert.equal(ledgerRows, 1);
    assert.equal(dealRows, 1);
  });
});

test('writeSnapshot produces a valid database with identical row counts and source stays in WAL mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-store-'));
  const dbPath = join(dir, 'test.db');
  const snapshotPath = join(dir, 'snapshot.db');
  const clock = fixedClock('2026-09-19T06:20:00Z');

  const store = openStore({ path: dbPath, clock });
  const db = store.getDb();

  db.prepare(
    `INSERT INTO deals (node_id, title, url, author, posted_at, categories, first_seen)
     VALUES (1, 'test deal', 'https://example.com/node/1', 'author', '2026-09-19T06:20:00Z', '[]', '2026-09-19T06:20:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO observations (deal_id, votes_pos, votes_neg, comment_count, click_count, observed_at)
     VALUES (1, 10, 0, 5, 100, '2026-09-19T06:20:00Z')`,
  ).run();

  const dealsBefore = db.prepare('SELECT COUNT(*) AS n FROM deals').get().n;
  const obsBefore = db.prepare('SELECT COUNT(*) AS n FROM observations').get().n;

  store.writeSnapshot(snapshotPath);

  const snapDb = new DatabaseSync(snapshotPath);
  const dealsAfter = snapDb.prepare('SELECT COUNT(*) AS n FROM deals').get().n;
  const obsAfter = snapDb.prepare('SELECT COUNT(*) AS n FROM observations').get().n;
  snapDb.close();

  assert.equal(dealsAfter, dealsBefore);
  assert.equal(obsAfter, obsBefore);
  assert.equal(store.journalMode, 'wal');

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// A v1-shaped database: the v1 schema (no `sent` column, no unique
// observations index) carrying a node seen in both the deals feed and the
// front feed as two rows with the same (deal_id, observed_at) — exactly the
// state the previous commit's own engine wrote. openStore() must migrate it
// to v2 without a UNIQUE constraint error, and must leave one row per pair.
test('openStore migrates a v1 database with a duplicate observation pair to v2 without a UNIQUE constraint error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-store-'));
  const dbPath = join(dir, 'test.db');
  const clock = fixedClock('2026-09-19T06:20:00Z');

  // 1. Build a real store (v2), then roll it back to a v1-shaped database.
  const build = openStore({ path: dbPath, clock });
  const db = build.getDb();
  db.prepare(
    `INSERT INTO deals (node_id, title, url, author, posted_at, categories, first_seen)
     VALUES (1, 'test deal', 'https://example.com/node/1', 'author', '2026-09-19T06:20:00Z', '[]', '2026-09-19T06:20:00Z')`,
  ).run();
  // Roll the schema back to v1 *first* (drop the unique index), so the two
  // duplicate rows below are insertable — a v1 database has no unique index,
  // so the previous commit's engine wrote the node once per feed.
  db.exec('DROP INDEX idx_observations_deal_poll');
  db.exec('ALTER TABLE ledger DROP COLUMN sent');
  // Two rows, same (deal_id, observed_at): one per feed, as v1 left them.
  db.prepare(
    `INSERT INTO observations (deal_id, votes_pos, votes_neg, comment_count, click_count, observed_at)
     VALUES (1, 10, 0, 5, 100, '2026-09-19T07:30:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO observations (deal_id, votes_pos, votes_neg, comment_count, click_count, observed_at)
     VALUES (1, 12, 0, 6, 110, '2026-09-19T07:30:00Z')`,
  ).run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 2, 'v1 state: two rows for one (deal, poll) pair');
  db.prepare('DELETE FROM schema_version').run();
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (1, ?)').run('2026-09-19T06:20:00Z');
  build.close();

  // 2. Re-open: the v2 migration must de-duplicate before creating the index.
  const store = openStore({ path: dbPath, clock });
  const db2 = store.getDb();
  assert.equal(store.schemaVersion, 2, 'migrated to v2');
  const obs = db2.prepare('SELECT id, deal_id, observed_at FROM observations ORDER BY id').all();
  assert.equal(obs.length, 1, 'one row per (deal, poll) pair after migration');
  assert.equal(obs[0].deal_id, 1);
  // The unique index now exists and the second feed upserts onto it.
  const idx = db2.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_observations_deal_poll'`,
  ).get();
  assert.ok(idx, 'the unique index was created');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
