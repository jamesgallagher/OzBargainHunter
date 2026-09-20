import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('a fresh database is created at schema version 1 with all eleven tables', () => {
  withStore((store) => {
    assert.equal(store.schemaVersion, 1);
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

test('writeSnapshot succeeds twice with a stale temp file present (unique suffix + pre-unlink pin)', () => {
  // Pins the snapshot temp-path behaviour. The round-2 defect used a fixed
  // temp path (${snapshotPath}.tmp-${process.pid}) with no pre-VACUUM INTO
  // unlink, so a leftover temp file made the next snapshot throw "file is not
  // a database". The fix uses a unique suffix (pid + counter + clock instant)
  // and pre-unlinks any leftover temp. A stale file at the base temp path must
  // therefore not break subsequent snapshots.
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

  // A stale temp file at the base temp path (the round-2 defect's exact path).
  const staleTemp = `${snapshotPath}.tmp-${process.pid}`;
  writeFileSync(staleTemp, 'stale temp file that is not a database');

  // Both snapshots must succeed despite the stale temp.
  store.writeSnapshot(snapshotPath);
  store.writeSnapshot(snapshotPath);

  // The snapshot opens as a valid DB with identical row counts.
  const snapDb = new DatabaseSync(snapshotPath);
  const dealsAfter = snapDb.prepare('SELECT COUNT(*) AS n FROM deals').get().n;
  const ledgerAfter = snapDb.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;
  snapDb.close();

  assert.equal(dealsAfter, dealsBefore);
  assert.equal(ledgerAfter, ledgerBefore);
  // The source is still WAL.
  assert.equal(store.journalMode, 'wal');

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('writeSnapshot succeeds twice with a stale temp file at the deterministic unique path present (pre-VACUUM INTO unlink pin)', () => {
  // Superset of the base-path pin: in addition to the round-2 defect's base
  // temp path, a stale file at the deterministic UNIQUE temp path (the first
  // snapshot's exact path under the fixed clock: pid + counter 1 + the frozen
  // clock instant). The shipped implementation pre-unlinks that exact path
  // before VACUUM INTO, so a stale file there must not break the snapshot.
  // Without the pre-unlink (mutant M7: pre-unlink deleted, unique suffix
  // kept), VACUUM INTO hits the stale file and throws "file is not a
  // database".
  //
  // The pin is format-independent: per-call temp-path uniqueness (B2a) and the
  // second-call refresh (B4) are asserted through the captured temp paths and
  // the snapshot's row count, NOT by hard-coding the temp-path formula. The
  // frozen instant is single-sourced from the clock so the stale-file path
  // and the clock cannot drift apart (editing the ISO literal moves both).
  const dir = mkdtempSync(join(tmpdir(), 'ozb-store-'));
  const dbPath = join(dir, 'test.db');
  const snapshotPath = join(dir, 'snapshot.db');
  const FROZEN_ISO = '2026-09-19T06:20:00Z';
  const clock = fixedClock(FROZEN_ISO);
  const FROZEN_MS = clock.now().getTime(); // single-sourced frozen instant

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

  // A stale temp file at the base temp path (the round-2 defect's exact path).
  const staleTemp = `${snapshotPath}.tmp-${process.pid}`;
  writeFileSync(staleTemp, 'stale temp file that is not a database');

  // A stale temp file at the deterministic unique temp path — the first
  // snapshot's exact temp path under the fixed clock (pid + counter 1 + the
  // frozen clock instant). This is a path the shipped implementation actually
  // generates, so the pre-VACUUM INTO unlink runs against an existing file.
  // (M7 kill: without the pre-unlink, VACUUM INTO hits this and throws
  // "file is not a database".)
  const uniqueTemp = `${snapshotPath}.tmp-${process.pid}-1-${FROZEN_MS}`;
  writeFileSync(uniqueTemp, 'stale unique temp file that is not a database');

  // Capture the temp path each writeSnapshot uses (the src arg to renameSync),
  // so per-call uniqueness can be asserted without pinning the formula.
  const tempPaths = [];
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (src, dst) => {
    tempPaths.push(src);
    return originalRenameSync(src, dst);
  };

  try {
    // First snapshot.
    store.writeSnapshot(snapshotPath);

    // Insert a row between the two snapshots so the second call is observable.
    db.prepare(
      `INSERT INTO deals (node_id, title, url, author, posted_at, categories, first_seen)
       VALUES (2, 'second deal', 'https://example.com/node/2', 'author', '2026-09-19T06:20:00Z', '[]', '2026-09-19T06:20:00Z')`,
    ).run();

    // Second snapshot to the same fixed path — must not throw and must
    // refresh the file to reflect the inserted row.
    store.writeSnapshot(snapshotPath);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  // The snapshot opens as a valid DB.
  const snapDb = new DatabaseSync(snapshotPath);
  const dealsAfter = snapDb.prepare('SELECT COUNT(*) AS n FROM deals').get().n;
  const ledgerAfter = snapDb.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;
  snapDb.close();

  // B4 kill: the second snapshot must reflect the row inserted between the
  // two calls (dealsBefore was 1, so the snapshot must now have 2).
  assert.equal(dealsAfter, dealsBefore + 1);
  assert.equal(ledgerAfter, ledgerBefore);
  // The source is still WAL.
  assert.equal(store.journalMode, 'wal');

  // B2a kill: the two snapshots must not have reused one temp path (the
  // per-call unique suffix). Asserted from the captured paths, not by
  // hard-coding the formula.
  assert.equal(tempPaths.length, 2);
  assert.notEqual(tempPaths[0], tempPaths[1]);

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
