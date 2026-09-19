import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const BUSY_TIMEOUT_MS = 5000;

const TABLES = [
  'deals',
  'observations',
  'rules',
  'ledger',
  'feed_state',
  'poll_state',
  'failures',
  'pending_alerts',
  'providers',
  'settings',
  'suppressions',
];

const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS deals (
        node_id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        author TEXT NOT NULL,
        posted_at TEXT NOT NULL,
        categories TEXT NOT NULL,
        merchant_url TEXT,
        expiry_at TEXT,
        first_seen TEXT NOT NULL,
        front_page_first_seen TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY,
        deal_id INTEGER NOT NULL REFERENCES deals(node_id),
        votes_pos INTEGER NOT NULL,
        votes_neg INTEGER NOT NULL,
        comment_count INTEGER NOT NULL,
        click_count INTEGER NOT NULL,
        observed_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS rules (
        id INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        parameters TEXT NOT NULL,
        state TEXT NOT NULL,
        surfaces TEXT NOT NULL,
        cooldown_seconds INTEGER NOT NULL,
        pinned_slug TEXT,
        created_at TEXT NOT NULL,
        modified_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ledger (
        node_id INTEGER NOT NULL,
        rule_id INTEGER NOT NULL,
        fired_at TEXT NOT NULL,
        PRIMARY KEY (node_id, rule_id)
      )`,
      `CREATE TABLE IF NOT EXISTS feed_state (
        url TEXT PRIMARY KEY,
        etag TEXT,
        last_modified TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS poll_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_success_at TEXT,
        last_response_class TEXT,
        backoff_seconds INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS failures (
        id INTEGER PRIMARY KEY,
        failed_at TEXT NOT NULL,
        response_class TEXT NOT NULL,
        body TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS pending_alerts (
        id INTEGER PRIMARY KEY,
        rule_id INTEGER NOT NULL,
        node_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS providers (
        kind TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        selected INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        disabled_at TEXT,
        last_error TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS suppressions (
        id INTEGER PRIMARY KEY,
        poll_at TEXT NOT NULL,
        node_id INTEGER NOT NULL,
        rule_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('repost', 'expired', 'cooldown', 'muted', 'near_miss')),
        detail TEXT
      )`,
      `INSERT OR IGNORE INTO poll_state (id) VALUES (1)`,
      `CREATE INDEX IF NOT EXISTS idx_observations_observed_at ON observations (observed_at)`,
    ],
  },
];

function applyPragmas(db) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
}

function applyMigrations(db, clock) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
  );

  const current = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  const applied = current ? current.v : 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= applied) continue;
    for (const statement of migration.statements) {
      db.exec(statement);
    }
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      migration.version,
      clock.now().toISOString(),
    );
  }
}

function tableExists(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

function readPragmaInt(db, pragma) {
  const row = db.prepare(pragma).get();
  if (!row) return 0;
  const value = row[Object.keys(row)[0]];
  return typeof value === 'number' ? value : 0;
}

/**
 * Open (or create) the SQLite store, apply migrations, and return the
 * data-access object.
 * @param {{ path: string, clock: { now(): Date } }} options
 * @returns {object} the data-access object
 */
export function openStore({ path, clock }) {
  const db = new DatabaseSync(path);
  applyPragmas(db);
  applyMigrations(db, clock);

  // Per-process counter for writeSnapshot's temp path, so a crash or a pid
  // reuse cannot leave a stale temp that blocks a later snapshot.
  let snapshotCounter = 0;

  const store = {
    get schemaVersion() {
      const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
      return row ? row.v : 0;
    },

    get tables() {
      return TABLES.filter((name) => tableExists(db, name));
    },

    get journalMode() {
      const row = db.prepare('PRAGMA journal_mode').get();
      if (!row) return null;
      const key = Object.keys(row)[0];
      return row[key];
    },

    get busyTimeout() {
      return readPragmaInt(db, 'PRAGMA busy_timeout');
    },

    getDb() {
      return db;
    },

    upsertDeal(deal) {
      const now = clock.now().toISOString();
      db.prepare(
        `INSERT INTO deals (node_id, title, url, author, posted_at, categories, merchant_url, expiry_at, first_seen, front_page_first_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         title = excluded.title,
         url = excluded.url,
         author = excluded.author,
         posted_at = excluded.posted_at,
         categories = excluded.categories,
         merchant_url = excluded.merchant_url,
         expiry_at = excluded.expiry_at,
         front_page_first_seen = COALESCE(excluded.front_page_first_seen, deals.front_page_first_seen)`,
      ).run(
        deal.node_id,
        deal.title,
        deal.url,
        deal.author,
        deal.posted_at,
        JSON.stringify(deal.categories ?? []),
        deal.merchant_url ?? null,
        deal.expiry_at ?? null,
        deal.first_seen ?? now,
        deal.front_page_first_seen ?? null,
      );
    },

    insertObservation(obs) {
      db.prepare(
        `INSERT INTO observations (deal_id, votes_pos, votes_neg, comment_count, click_count, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        obs.deal_id,
        obs.votes_pos,
        obs.votes_neg,
        obs.comment_count,
        obs.click_count,
        obs.observed_at,
      );
    },

    pruneObservations(now) {
      const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const result = db.prepare('DELETE FROM observations WHERE observed_at < ?').run(cutoff);
      return result.changes;
    },

    writeSnapshot(snapshotPath) {
      // VACUUM INTO refuses an existing target, and the snapshot is written
      // on a schedule to a fixed path (design 4.3) — so snapshot to a
      // temporary path and rename over the target. This makes every
      // scheduled run (not just the first) succeed, and the rename is
      // atomic on the same filesystem.
      //
      // The temp suffix is unique (pid + a per-process counter + the clock
      // instant) so a crash between VACUUM INTO and rename, or a pid reuse
      // (deterministic in a container), cannot leave a stale file that makes
      // a later snapshot throw. We also unlink any leftover temp before
      // VACUUM INTO, so a stale file from a previous run cannot block us.
      snapshotCounter += 1;
      const tmpPath = `${snapshotPath}.tmp-${process.pid}-${snapshotCounter}-${clock.now().getTime()}`;
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ENOENT is the expected case; ignore.
      }
      db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
      fs.renameSync(tmpPath, snapshotPath);
    },

    setFeedState(url, etag, lastModified) {
      db.prepare(
        `INSERT INTO feed_state (url, etag, last_modified) VALUES (?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified`,
      ).run(url, etag, lastModified);
    },

    getFeedState(url) {
      return db.prepare('SELECT url, etag, last_modified FROM feed_state WHERE url = ?').get(url) ?? null;
    },

    insertSuppression(sup) {
      db.prepare(
        `INSERT INTO suppressions (poll_at, node_id, rule_id, kind, detail) VALUES (?, ?, ?, ?, ?)`,
      ).run(sup.poll_at, sup.node_id, sup.rule_id, sup.kind, sup.detail ?? null);
    },

    close() {
      db.close();
    },
  };

  return store;
}

export { TABLES, BUSY_TIMEOUT_MS };
