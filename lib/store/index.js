import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { DISABLE_AFTER_CONSECUTIVE_FAILURES } from '../notify/fanout.js';

const BUSY_TIMEOUT_MS = 5000;

// Failed response bodies are retained for diagnosis (design 3.7) but
// truncated at ingest: a sustained failure mode can carry several multi-MB
// bodies per cycle, and the `failures` table is not pruned by card 1's
// nightly job (which only prunes `observations`). Truncating to a few KB
// at the write boundary keeps the bind-mounted SQLite file bounded; the
// "last N" retention window is owned by card 4's nightly prune.
const FAILURE_BODY_MAX_BYTES = 8 * 1024;

// The gate row in its resting (open) state. The migration seeds this; a
// missing row is read as this (the seed is `INSERT OR IGNORE`, so a
// database rolled back under an open connection can lack the row).
const DEFAULT_GATE_ROW = {
  id: 1,
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
  'access_gate',
  'gate_events',
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
  {
    version: 2,
    statements: [
      // Only a *sent* alert may anchor the per-rule cooldown. Seeded (cold
      // start) and muted ledger rows must not, so the first real alert after
      // a cold start is a real one (D15/D26).
      `ALTER TABLE ledger ADD COLUMN sent INTEGER NOT NULL DEFAULT 0`,
      // A v1 database written by the previous commit's engine can carry a
      // node seen in both the deals feed and the front feed as two rows with
      // the same (deal_id, observed_at). De-duplicate before the unique index
      // is created, keeping the highest id per pair, or the index creation
      // throws a UNIQUE constraint error and the store cannot open.
      `DELETE FROM observations WHERE id NOT IN (
        SELECT MAX(id) FROM observations GROUP BY deal_id, observed_at
      )`,
      // One row per deal per poll: a node seen in both the deals feed and the
      // front feed is one observation, not two (design 4.1).
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_deal_poll ON observations (deal_id, observed_at)`,
    ],
  },
  {
    version: 3,
    statements: [
      // The persisted access gate (design 3.7): one row, the state machine's
      // current state; a missing row is read as open (the seed below).
      `CREATE TABLE IF NOT EXISTS access_gate (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL CHECK (state IN ('open', 'cooling', 'probing', 'stopped')),
        rule TEXT,
        tier INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        since TEXT,
        until_at TEXT,
        min_resume_at TEXT,
        consecutive_b2 INTEGER NOT NULL DEFAULT 0,
        failing_cycles INTEGER NOT NULL DEFAULT 0,
        b5_tier INTEGER NOT NULL DEFAULT 0,
        probe_used INTEGER NOT NULL DEFAULT 0,
        probe_granted_at TEXT
      )`,
      // One row per gate state change, `notified=0` until a (later card's)
      // notification path marks it; `email_status` stays NULL until then.
      `CREATE TABLE IF NOT EXISTS gate_events (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        rule TEXT,
        tier INTEGER,
        reason TEXT,
        until_at TEXT,
        min_resume_at TEXT,
        notified INTEGER NOT NULL DEFAULT 0,
        email_status TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_gate_events_at ON gate_events (at)`,
      // `state` is NOT NULL with no default, so the seed names it.
      `INSERT OR IGNORE INTO access_gate (id, state) VALUES (1, 'open')`,
    ],
  },
];

function applyPragmas(db) {
  db.exec('PRAGMA journal_mode = WAL');
  // NORMAL is SQLite's recommended setting for WAL: commits stay atomic and
  // the database is never corrupted; only a power loss can drop the last few
  // commits, which the next poll re-fetches. FULL (the default) syncs the disk
  // on every commit, and the poll commits row by row.
  db.exec('PRAGMA synchronous = NORMAL');
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
         front_page_first_seen = COALESCE(deals.front_page_first_seen, excluded.front_page_first_seen)`,
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
      // One row per deal per poll: a node seen in both the deals feed and the
      // front feed is one observation, not two (design 4.1). The key is
      // (deal_id, observed_at), and the first writer wins: `DO NOTHING`, not
      // `DO UPDATE`.
      //
      // Two writers write the same key inside one poll cycle — the poller
      // (which stamps the cycle with one instant and takes the first feed in
      // order that carried a node) and the rules engine (which upserts the
      // records it evaluates, so its alert ledger and repost lookup are
      // self-contained). `DO UPDATE` would let the engine's pass overwrite the
      // poller's counters with the *later* feed's — for poll 1 that turns
      // 975666's page-0 count of 113 into the front feed's 99, contradicting
      // first-feed-wins and injecting a non-monotonic step into the series
      // design 4.1 calls the basis for every trend and threshold calculation.
      // `DO NOTHING` makes the engine's write idempotent on the key and leaves
      // the observation the poller actually made intact.
      db.prepare(
        `INSERT INTO observations (deal_id, votes_pos, votes_neg, comment_count, click_count, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(deal_id, observed_at) DO NOTHING`,
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

    getDeal(nodeId) {
      const row = db
        .prepare('SELECT node_id, title, url, author, posted_at, categories, merchant_url, expiry_at, first_seen, front_page_first_seen FROM deals WHERE node_id = ?')
        .get(nodeId);
      if (!row) return null;
      return {
        ...row,
        categories: JSON.parse(row.categories),
      };
    },

    countDeals() {
      const row = db.prepare('SELECT COUNT(*) AS n FROM deals').get();
      return row ? row.n : 0;
    },

    countAllObservations() {
      const row = db.prepare('SELECT COUNT(*) AS n FROM observations').get();
      return row ? row.n : 0;
    },

    countFrontPageFirstSeen() {
      const row = db.prepare('SELECT COUNT(*) AS n FROM deals WHERE front_page_first_seen IS NOT NULL').get();
      return row ? row.n : 0;
    },

    countObservations(dealId) {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM observations WHERE deal_id = ?')
        .get(dealId);
      return row ? row.n : 0;
    },

    getObservations(dealId) {
      return db
        .prepare('SELECT id, deal_id, votes_pos, votes_neg, comment_count, click_count, observed_at FROM observations WHERE deal_id = ? ORDER BY id')
        .all(dealId);
    },

    getPollState() {
      const row = db.prepare('SELECT * FROM poll_state WHERE id = 1').get();
      return row ? { ...row } : null;
    },

    setPollState({ lastSuccessAt, lastResponseClass, backoffSeconds, consecutiveFailures }) {
      // lastSuccessAt may be null (preserve the stored value when the cycle
      // produced no new success); the other fields are always written.
      db.prepare(
        `INSERT INTO poll_state (id, last_success_at, last_response_class, backoff_seconds, consecutive_failures)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_success_at = COALESCE(excluded.last_success_at, poll_state.last_success_at),
         last_response_class = excluded.last_response_class,
         backoff_seconds = excluded.backoff_seconds,
         consecutive_failures = excluded.consecutive_failures`,
      ).run(lastSuccessAt, lastResponseClass, backoffSeconds, consecutiveFailures);
    },

    insertFailure(failure) {
      // Truncate the retained body at the byte boundary (design 3.7) so a
      // sustained failure mode cannot grow the `failures` table without
      // bound. Slice on bytes, not characters, so a multi-byte UTF-8
      // sequence is never split mid-codepoint. A plain subarray().toString()
      // turns a dangling partial sequence into U+FFFD, so after slicing we
      // walk back over the trailing bytes of the last codepoint and, if it
      // is incomplete (its remaining bytes were cut off), drop it.
      let body = String(failure.body ?? '');
      const bytes = Buffer.byteLength(body, 'utf8');
      if (bytes > FAILURE_BODY_MAX_BYTES) {
        const buffer = Buffer.from(body, 'utf8');
        let end = FAILURE_BODY_MAX_BYTES;
        // Walk back over trailing continuation bytes (0x80-0xBF) to reach
        // the last codepoint's lead byte (or a single byte, 0x00-0x7F).
        let i = end - 1;
        while (i >= 0 && (buffer[i] & 0xc0) === 0x80) i -= 1;
        // If the last codepoint is a multi-byte lead whose remaining bytes
        // were cut off, it is incomplete: drop it so the buffer stays a
        // valid UTF-8 prefix (no U+FFFD is introduced).
        if (i >= 0 && buffer[i] >= 0x80) {
          const lead = buffer[i];
          const length = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
          if (end - i < length) {
            end = i;
          }
        }
        body = buffer.subarray(0, end).toString('utf8');
      }
      db.prepare(
        'INSERT INTO failures (failed_at, response_class, body) VALUES (?, ?, ?)',
      ).run(failure.failed_at, failure.response_class, body);
    },

    getFailures() {
      // node:sqlite rows carry a null prototype, which React's server->client
      // serialization rejects; spread into plain objects (as getPollState and
      // getRules do) so the list can be passed to a client component.
      return db
        .prepare('SELECT id, failed_at, response_class, body FROM failures ORDER BY id DESC')
        .all()
        .map((row) => ({ ...row }));
    },

    clearFailures() {
      return db.prepare('DELETE FROM failures').run().changes;
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

    setSetting(key, value) {
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(key, String(value));
    },

    getSetting(key) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : null;
    },

    deleteSetting(key) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    },

    insertSuppression(sup) {
      db.prepare(
        `INSERT INTO suppressions (poll_at, node_id, rule_id, kind, detail) VALUES (?, ?, ?, ?, ?)`,
      ).run(sup.poll_at, sup.node_id, sup.rule_id, sup.kind, sup.detail ?? null);
    },
    getSuppressions() {
      return db
        .prepare('SELECT id, poll_at, node_id, rule_id, kind, detail FROM suppressions ORDER BY id')
        .all();
    },
    countSuppressions() {
      const row = db.prepare('SELECT COUNT(*) AS n FROM suppressions').get();
      return row ? row.n : 0;
    },

    // --- rules ---
    insertRule(rule) {
      db.prepare(
        `INSERT INTO rules (id, type, parameters, state, surfaces, cooldown_seconds, pinned_slug, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         parameters = excluded.parameters,
         state = excluded.state,
         surfaces = excluded.surfaces,
         cooldown_seconds = excluded.cooldown_seconds,
         pinned_slug = excluded.pinned_slug,
         modified_at = excluded.modified_at`,
      ).run(
        rule.id,
        rule.type,
        rule.parameters,
        rule.state,
        rule.surfaces,
        rule.cooldown_seconds,
        rule.pinned_slug ?? null,
        rule.created_at,
        rule.modified_at,
      );
    },
    getRule(id) {
      const row = db.prepare('SELECT * FROM rules WHERE id = ?').get(id);
      return row ? { ...row, parameters: JSON.parse(row.parameters) } : null;
    },
    getRules() {
      return db
        .prepare('SELECT * FROM rules ORDER BY id')
        .all()
        .map((row) => ({ ...row, parameters: JSON.parse(row.parameters) }));
    },
    setRuleState(id, state, modifiedAt) {
      db.prepare('UPDATE rules SET state = ?, modified_at = ? WHERE id = ?').run(state, modifiedAt, id);
    },
    deleteRule(id) {
      return db.prepare('DELETE FROM rules WHERE id = ?').run(id).changes;
    },
    countRules() {
      const row = db.prepare('SELECT COUNT(*) AS n FROM rules').get();
      return row ? row.n : 0;
    },
    // X6: the next rule id is MAX(id)+1, never COUNT(*)+1. COUNT(*)+1 collides
    // with an existing id after a delete (delete 2 from [1,2,3] -> count 2 ->
    // new id 3, overwriting rule 3). MAX(id)+1 is monotonic and gap-safe.
    nextRuleId() {
      const row = db.prepare('SELECT MAX(id) AS m FROM rules').get();
      const max = row && row.m != null ? row.m : 0;
      return max + 1;
    },

    // --- ledger ---
    insertLedger(entry) {
      // `sent` marks a row written by a *sent* alert (the only kind that may
      // anchor the per-rule cooldown). Seeded (cold start) and muted rows
      // default to 0.
      db.prepare(
        'INSERT OR IGNORE INTO ledger (node_id, rule_id, fired_at, sent) VALUES (?, ?, ?, ?)',
      ).run(
        entry.node_id,
        entry.rule_id,
        entry.fired_at,
        entry.sent ? 1 : 0,
      );
    },
    hasLedger(nodeId, ruleId) {
      const row = db
        .prepare('SELECT 1 AS x FROM ledger WHERE node_id = ? AND rule_id = ?')
        .get(nodeId, ruleId);
      return row !== undefined;
    },
    getLedgerForRule(ruleId) {
      return db
        .prepare('SELECT node_id, fired_at FROM ledger WHERE rule_id = ? ORDER BY fired_at DESC')
        .all(ruleId);
    },
    getRuleLastFire(ruleId) {
      const row = db.prepare('SELECT MAX(fired_at) AS t FROM ledger WHERE rule_id = ?').get(ruleId);
      return row && row.t ? row.t : null;
    },
    getRuleLastSent(ruleId) {
      // The per-rule cooldown is anchored on the last *sent* alert, not on
      // seeded (cold start) or muted rows.
      const row = db
        .prepare('SELECT MAX(fired_at) AS t FROM ledger WHERE rule_id = ? AND sent = 1')
        .get(ruleId);
      return row && row.t ? row.t : null;
    },
    getLedgerLastFire(nodeId, ruleId) {
      const row = db
        .prepare('SELECT MAX(fired_at) AS t FROM ledger WHERE node_id = ? AND rule_id = ?')
        .get(nodeId, ruleId);
      return row && row.t ? row.t : null;
    },
    getLedgerWithTitles(ruleId, sinceIso) {
      return db
        .prepare(
          `SELECT l.node_id, d.title, l.fired_at
           FROM ledger l LEFT JOIN deals d ON d.node_id = l.node_id
           WHERE l.rule_id = ? AND l.fired_at >= ?
           ORDER BY l.fired_at DESC`,
        )
        .all(ruleId, sinceIso);
    },
    countLedger() {
      const row = db.prepare('SELECT COUNT(*) AS n FROM ledger').get();
      return row ? row.n : 0;
    },

    // --- providers ---
    upsertProvider(kind, config, selected) {
      db.prepare(
        `INSERT INTO providers (kind, config, selected) VALUES (?, ?, ?)
       ON CONFLICT(kind) DO UPDATE SET config = excluded.config, selected = excluded.selected`,
      ).run(kind, config, selected ? 1 : 0);
    },
    getProviders() {
      return db
        .prepare(
          'SELECT kind, config, selected, enabled, consecutive_failures, disabled_at, last_error FROM providers ORDER BY kind',
        )
        .all();
    },
    getProvider(kind) {
      return (
        db
          .prepare(
            'SELECT kind, config, selected, enabled, consecutive_failures, disabled_at, last_error FROM providers WHERE kind = ?',
          )
          .get(kind) ?? null
      );
    },
    recordProviderFailure(kind, error, atIso) {
      const prow = db
        .prepare('SELECT consecutive_failures, enabled, disabled_at FROM providers WHERE kind = ?')
        .get(kind);
      if (!prow) return { consecutiveFailures: 0, disabled: false };
      const cf = prow.consecutive_failures + 1;
      const disabled = cf >= DISABLE_AFTER_CONSECUTIVE_FAILURES;
      db.prepare(
        'UPDATE providers SET consecutive_failures = ?, enabled = ?, disabled_at = ?, last_error = ? WHERE kind = ?',
      ).run(cf, disabled ? 0 : prow.enabled, disabled ? atIso : prow.disabled_at, error, kind);
      return { consecutiveFailures: cf, disabled };
    },
    recordProviderSuccess(kind) {
      db.prepare('UPDATE providers SET consecutive_failures = 0 WHERE kind = ?').run(kind);
    },
    setProviderEnabled(kind, enabled, atIso) {
      if (enabled) {
        // Re-enabling a provider resets its consecutive-failure counter, so it
        // takes five fresh failures to disable it again rather than one.
        db.prepare(
          'UPDATE providers SET enabled = 1, disabled_at = NULL, consecutive_failures = 0 WHERE kind = ?',
        ).run(kind);
      } else {
        // Disabling leaves the counter untouched.
        db.prepare('UPDATE providers SET enabled = 0, disabled_at = ? WHERE kind = ?').run(atIso, kind);
      }
    },
    deleteProvider(kind) {
      return db.prepare('DELETE FROM providers WHERE kind = ?').run(kind).changes;
    },

    // --- settings ---
    getSetting(key) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : null;
    },
    setSetting(key, value) {
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(key, value);
    },
    getSettings() {
      const rows = db.prepare('SELECT key, value FROM settings').all();
      const map = {};
      for (const row of rows) map[row.key] = row.value;
      return map;
    },

    // --- pending alerts ---
    insertPendingAlert(alert) {
      db.prepare('INSERT INTO pending_alerts (rule_id, node_id, payload, created_at) VALUES (?, ?, ?, ?)').run(
        alert.rule_id,
        alert.node_id,
        alert.payload,
        alert.created_at,
      );
    },
    getPendingAlerts() {
      return db
        .prepare('SELECT id, rule_id, node_id, payload, created_at FROM pending_alerts ORDER BY id')
        .all();
    },
    deletePendingAlertsForRule(ruleId) {
      return db.prepare('DELETE FROM pending_alerts WHERE rule_id = ?').run(ruleId).changes;
    },

    // --- access gate (design 3.7) ---
    getGate() {
      const row = db.prepare('SELECT * FROM access_gate WHERE id = 1').get();
      return row ? { ...row } : null;
    },

    /**
     * Persist one gate transition atomically (design 3.7: one transaction
     * per transition). The row update and every event insert commit
     * together; a throw rolls back and the previous state stands.
     * @param {object} nextGate the next gate row (all columns)
     * @param {object[]} events the events to record (may be empty: the
     *   probe-consumption flip changes the row without a state change)
     */
    applyGateTransition(nextGate, events) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(
          `UPDATE access_gate SET
             state = ?, rule = ?, tier = ?, reason = ?, since = ?, until_at = ?,
             min_resume_at = ?, consecutive_b2 = ?, failing_cycles = ?,
             b5_tier = ?, probe_used = ?, probe_granted_at = ?
           WHERE id = 1`,
        ).run(
          nextGate.state,
          nextGate.rule,
          nextGate.tier,
          nextGate.reason,
          nextGate.since,
          nextGate.until_at,
          nextGate.min_resume_at,
          nextGate.consecutive_b2,
          nextGate.failing_cycles,
          nextGate.b5_tier,
          nextGate.probe_used,
          nextGate.probe_granted_at ?? null,
        );
        const insertEvent = db.prepare(
          `INSERT INTO gate_events (at, from_state, to_state, rule, tier, reason, until_at, min_resume_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const event of events) {
          insertEvent.run(
            event.at,
            event.from_state,
            event.to_state,
            event.rule,
            event.tier,
            event.reason,
            event.until_at,
            event.min_resume_at,
          );
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    getGateEvents({ limit = 10 } = {}) {
      return db
        .prepare(
          `SELECT id, at, from_state, to_state, rule, tier, reason, until_at, min_resume_at, notified, email_status
           FROM gate_events ORDER BY id DESC LIMIT ?`,
        )
        .all(limit)
        .map((row) => ({ ...row }));
    },

    /**
     * Run one gate transition in a single transaction (spec 4.1: "every
     * transition is one transaction (BEGIN IMMEDIATE … COMMIT)", covering
     * the read as well as the write). The row read, the caller's
     * computation and the row+events write all happen under one
     * `BEGIN IMMEDIATE` … `COMMIT`, so a concurrent process can never
     * observe the write without the read that produced it (no lost
     * updates, no double-granted probe, no duplicate lazy-transition
     * events), and a crash between the read and the write is impossible.
     *
     * `fn` is synchronous and must not do I/O: the transaction holds the
     * write lock for the whole call. It receives the current row (the
     * default open row when the table is empty) and returns
     * `{ gate, events }` to write, or `null` to leave the row untouched.
     * A throw rolls the transaction back and rethrows; the previous state
     * stands.
     * @param {(row: object) => { gate: object, events: object[] } | null} fn
     * @returns {object} the resulting gate row (the input row when `fn`
     *   returned `null`)
     */
    mutateGate(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT * FROM access_gate WHERE id = 1').get();
        const current = row ? { ...row } : { ...DEFAULT_GATE_ROW };
        const result = fn(current);
        if (result === null) {
          db.exec('ROLLBACK');
          return current;
        }
        const { gate, events } = result;
        db.prepare(
          `INSERT INTO access_gate (
            id, state, rule, tier, reason, since, until_at,
            min_resume_at, consecutive_b2, failing_cycles, b5_tier, probe_used, probe_granted_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            state = excluded.state, rule = excluded.rule, tier = excluded.tier,
            reason = excluded.reason, since = excluded.since, until_at = excluded.until_at,
            min_resume_at = excluded.min_resume_at, consecutive_b2 = excluded.consecutive_b2,
            failing_cycles = excluded.failing_cycles, b5_tier = excluded.b5_tier,
            probe_used = excluded.probe_used, probe_granted_at = excluded.probe_granted_at`,
        ).run(
          gate.state,
          gate.rule,
          gate.tier,
          gate.reason,
          gate.since,
          gate.until_at,
          gate.min_resume_at,
          gate.consecutive_b2,
          gate.failing_cycles,
          gate.b5_tier,
          gate.probe_used,
          gate.probe_granted_at ?? null,
        );
        const insertEvent = db.prepare(
          `INSERT INTO gate_events (at, from_state, to_state, rule, tier, reason, until_at, min_resume_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const event of events) {
          insertEvent.run(
            event.at,
            event.from_state,
            event.to_state,
            event.rule,
            event.tier,
            event.reason,
            event.until_at,
            event.min_resume_at,
          );
        }
        db.exec('COMMIT');
        return { ...gate };
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    /**
     * The B1 lookback (design 3.7): how many B1 stops happened at or
     * after `sinceIso`.
     */
    countGateEvents({ rule, toState, sinceIso }) {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM gate_events WHERE rule = ? AND to_state = ? AND at >= ?')
        .get(rule, toState, sinceIso);
      return row ? row.n : 0;
    },

    close() {
      db.close();
    },
  };

  return store;
}

export { TABLES, BUSY_TIMEOUT_MS };
