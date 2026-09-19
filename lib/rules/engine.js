/**
 * The rules engine (design 5).
 *
 * `evaluatePoll` takes the poll's records (grouped by surface), a store, a
 * clock and the poll time, and returns the alerts to send plus the
 * suppressions to record. It upserts the records it evaluates so that the
 * alert ledger and repost lookup are self-contained, and it reads the
 * configured rules from the store.
 *
 * The order of checks is load-bearing:
 *   1. Expiry first. An expired deal never alerts, in any circumstance,
 *      including one that became expired after it was first seen. Expiry is
 *      evaluated at emit time, not only at first sight.
 *   2. Ledger. Keyed on (node ID, rule ID); a rule fires at most once per
 *      deal, ever. A permanent record, not a cooldown.
 *   3. Per-rule cooldown, default 24 hours, configurable per rule, zero
 *      permitted.
 *   4. Repost suppression. A new record whose normalised title is close to
 *      one already alerted under the same rule within 30 days is suppressed
 *      and recorded, not sent. Jaccard similarity over the normalised token
 *      sets, threshold 0.60.
 *   5. Muted rules keep evaluating and keep writing ledger entries; they
 *      send nothing.
 *
 * Gaps (5.4): a gap over 2 hours suppresses threshold rules for one cycle
 * and they resume on the next. Match rules are unaffected. Cold start on an
 * empty database seeds silently: everything in the feeds is written, every
 * rule that would have fired is marked already-alerted, zero notifications
 * are sent, and a log line records the counts.
 */

import { matchRule, isClassifiedsEligible } from './match.js';
import { reachedThreshold } from './threshold.js';
import { tokenise } from './normalise.js';
import { evaluateFreebies } from '../notify/freebie.js';

const GAP_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
const REPOST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const REPOST_SIMILARITY_THRESHOLD = 0.6;

/**
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} Jaccard similarity of the two token sets.
 */
export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Whether a rule applies to a surface.
 * @param {string} surfaces 'deals' | 'classifieds' | 'both'
 * @param {string} surface the record's surface
 * @returns {boolean}
 */
function appliesToSurface(surfaces, surface) {
  if (surfaces === 'both') return true;
  if (surfaces === 'deals') return surface === 'deals' || surface === 'front';
  if (surfaces === 'classifieds') return surface === 'classifieds';
  return false;
}

/**
 * Upsert a record into the store. Deals and front-page records go to the
 * deals table; classifieds records are stored title-bearing so the repost
 * lookup can find their titles.
 * @param {object} store
 * @param {object} record
 * @param {string} surface
 * @param {string} nowIso
 */
function upsertRecord(store, record, surface, nowIso) {
  if (surface === 'deals' || surface === 'front') {
    store.upsertDeal({
      node_id: record.node_id,
      title: record.title,
      url: record.url,
      author: record.author ?? null,
      posted_at: record.posted_at ?? nowIso,
      categories: record.categories ?? [],
      merchant_url: record.merchant_url ?? null,
      expiry_at: record.expiry_at ?? null,
      first_seen: nowIso,
      front_page_first_seen: surface === 'front' ? nowIso : null,
    });
    // Record the vote/comment/click counters as an observation so the
    // rate-over-window lookup and the cold-start seeding both have data.
    store.insertObservation({
      deal_id: record.node_id,
      votes_pos: record.votes_pos ?? 0,
      votes_neg: record.votes_neg ?? 0,
      comment_count: record.comment_count ?? 0,
      click_count: record.click_count ?? 0,
      observed_at: nowIso,
    });
  } else {
    // Classifieds: store a title-bearing row so the repost lookup works.
    // The deals table's author column is NOT NULL, so a missing poster
    // falls back to an empty string rather than null.
    store.upsertDeal({
      node_id: record.node_id,
      title: record.title,
      url: record.url,
      author: record.poster ?? '',
      posted_at: record.posted_at ?? nowIso,
      categories: (record.category_tags ?? []).map((tag) => ({
        kind: 'tag',
        slug: tag.toLowerCase(),
        label: tag,
      })),
      merchant_url: null,
      expiry_at: null,
      first_seen: nowIso,
      front_page_first_seen: null,
    });
  }
}

/**
 * Whether a record is expired at emit time.
 * @param {object} record
 * @param {string} nowIso
 * @returns {boolean}
 */
function isExpired(record, nowIso) {
  return Boolean(record.expiry_at && Date.parse(record.expiry_at) < Date.parse(nowIso));
}

/**
 * Repost suppression: a new record whose normalised title is close (Jaccard
 * >= 0.60) to one already alerted under the same rule within 30 days.
 * @param {object} record
 * @param {object} rule
 * @param {object} store
 * @param {string} nowIso
 * @returns {boolean}
 */
function isRepost(record, rule, store, nowIso) {
  const sinceIso = new Date(Date.parse(nowIso) - REPOST_WINDOW_MS).toISOString();
  const alerted = store.getLedgerWithTitles(rule.id, sinceIso);
  const newTokens = tokenise(record.title);
  for (const row of alerted) {
    if (row.node_id === record.node_id) continue; // same record, not a repost
    if (!row.title) continue;
    const alertedTokens = tokenise(row.title);
    if (jaccard(newTokens, alertedTokens) >= REPOST_SIMILARITY_THRESHOLD) return true;
  }
  return false;
}

/**
 * Normalise a rule row (as returned by `store.getRules()`) into the flat shape
 * the engine reads. The store keeps rule-specific parameters in a JSON blob
 * (`parameters`) and the pinned slug in its own column; the engine reads them
 * as flat fields. Tolerant of an already-flat rule (used when the engine is
 * driven directly with plain objects in tests).
 * @param {object} row a rule row or a flat rule
 * @returns {object} a flat rule
 */
export function normalizeRule(row) {
  const params = row.parameters && typeof row.parameters === 'object' ? row.parameters : {};
  return {
    ...row,
    ...params,
    pinnedSlug: row.pinned_slug ?? row.pinnedSlug ?? null,
  };
}

/**
 * The best-effort rate over the configured window (votes per hour). Null when
 * there is no observation at the window's start.
 * @param {object} store
 * @param {number} nodeId
 * @param {number|null} windowMs
 * @param {string} nowIso
 * @returns {number|null}
 */
function rateOverWindow(store, nodeId, windowMs, nowIso) {
  if (!windowMs) return null;
  const startIso = new Date(Date.parse(nowIso) - windowMs).toISOString();
  const obs = store.getObservations(nodeId);
  const current = obs.length ? obs[obs.length - 1] : null;
  if (!current) return null;
  const atStart = obs.find((o) => o.observed_at <= startIso);
  if (!atStart) return null;
  const netNow = current.votes_pos - current.votes_neg;
  const netStart = atStart.votes_pos - atStart.votes_neg;
  const hours = windowMs / (60 * 60 * 1000);
  return (netNow - netStart) / hours;
}

/**
 * Evaluate one rule against one record. Returns the decision:
 *   { action: 'skip' | 'no_match' | 'no_reach' | 'skip_gap' | 'skip_ledger'
 *            | 'seeded' | 'suppress' | 'alert',
 *     kind?: string, alert?: object, netVotes?: number }
 * @param {object} record
 * @param {string} surface
 * @param {object} rule
 * @param {object} ctx
 */
function evaluateRecordRule(record, surface, rule, ctx) {
  // Surface applicability.
  if (!appliesToSurface(rule.surfaces, surface)) return { action: 'skip' };
  if (rule.type === 'threshold' && surface === 'classifieds') return { action: 'skip' };
  if (rule.type === 'match' && surface === 'classifieds' && !isClassifiedsEligible(record)) {
    return { action: 'skip' };
  }

  // Does the rule fire on this record?
  const nowIso = ctx.nowIso;
  if (rule.type === 'match') {
    const m = matchRule(rule, record, surface);
    if (!m.matched) return { action: 'no_match' };
  } else {
    if (!reachedThreshold(rule, record)) {
      // Near miss: within 10% below the threshold.
      const net = record.votes_pos - record.votes_neg;
      if (net >= rule.threshold * 0.9) {
        return { action: 'suppress', kind: 'near_miss' };
      }
      return { action: 'no_reach' };
    }
  }

  // 1. Expiry first (deals/front only; evaluated at emit time).
  if ((surface === 'deals' || surface === 'front') && isExpired(record, nowIso)) {
    return { action: 'suppress', kind: 'expired' };
  }

  // Gap: a gap over 2 hours suppresses threshold rules for one cycle.
  if (rule.type === 'threshold' && ctx.suppressThreshold) {
    return { action: 'skip_gap' };
  }

  // 2. Ledger: a rule fires at most once per deal, ever.
  if (ctx.store.hasLedger(record.node_id, rule.id)) return { action: 'skip_ledger' };

  // Cold start: seed silently (mark already-alerted, send nothing).
  if (ctx.coldStart) {
    ctx.store.insertLedger({
      node_id: record.node_id,
      rule_id: rule.id,
      fired_at: nowIso,
    });
    return { action: 'seeded' };
  }

  // 5. Muted: keep evaluating, write a ledger entry, send nothing.
  if (rule.state === 'muted') {
    ctx.store.insertLedger({
      node_id: record.node_id,
      rule_id: rule.id,
      fired_at: nowIso,
    });
    return { action: 'suppress', kind: 'muted' };
  }

  // 3. Per-rule cooldown (default 24 hours, configurable, zero permitted).
  // The ledger (step 2) already silently skips a deal that fired under this
  // rule, so the cooldown only ever catches a *new* deal under a rule that
  // recently fired: it suppresses 975721 at poll 2 because 975704 fired 35
  // minutes earlier, and records a `cooldown` suppression row.
  const lastFire = ctx.store.getRuleLastFire(rule.id);
  if (lastFire && rule.cooldown_seconds > 0) {
    const elapsedMs = Date.parse(nowIso) - Date.parse(lastFire);
    if (elapsedMs < rule.cooldown_seconds * 1000) {
      return { action: 'suppress', kind: 'cooldown' };
    }
  }

  // 4. Repost suppression.
  if (isRepost(record, rule, ctx.store, nowIso)) {
    return { action: 'suppress', kind: 'repost' };
  }

  // Fire.
  ctx.store.insertLedger({
    node_id: record.node_id,
    rule_id: rule.id,
    fired_at: nowIso,
  });
  const netVotes = record.votes_pos - record.votes_neg;
  const alert = {
    kind: 'rule',
    rule_id: rule.id,
    ruleLabel: rule.label ?? rule.term ?? `rule ${rule.id}`,
    node_id: record.node_id,
    title: record.title,
    url: record.url,
    netVotes,
    rate: rateOverWindow(ctx.store, record.node_id, rule.windowHours ? rule.windowHours * 60 * 60 * 1000 : null, nowIso),
    matchedTerm: rule.type === 'match' ? rule.term : null,
    priority: ctx.frontPageNodeIds.has(record.node_id) ? 'high' : 'normal',
    isFrontPage: ctx.frontPageNodeIds.has(record.node_id),
    tags: [rule.type, rule.type === 'match' ? rule.term : String(rule.threshold)],
    pollAt: ctx.pollAt,
  };
  return { action: 'alert', alert, netVotes };
}

/**
 * @param {{
 *   feeds: { surface: string, records: object[] }[],
 *   store: object,
 *   clock: { now(): Date },
 *   pollAt: string,
 *   coldStart?: boolean,
 *   gapMs?: number | null,
 *   log?: (line: string) => void,
 * }} args
 * @returns {{
 *   alerts: object[],
 *   suppressions: object[],
 *   coldStart: boolean,
 *   counts: { records: number, alerts: number, suppressions: number, seeded: number },
 * }}
 */
export function evaluatePoll(args) {
  const { feeds, store, clock, pollAt, coldStart = false, gapMs = null, log = () => {} } = args;
  const nowIso = clock.now().toISOString();
  const rules = store.getRules().map(normalizeRule);
  const suppressThreshold = gapMs != null && gapMs > GAP_THRESHOLD_MS;

  // Front-page node ids, for priority.
  const frontPageNodeIds = new Set();
  for (const feed of feeds) {
    if (feed.surface === 'front') {
      for (const record of feed.records) frontPageNodeIds.add(record.node_id);
    }
  }

  const ctx = {
    store,
    nowIso,
    pollAt,
    coldStart,
    suppressThreshold,
    frontPageNodeIds,
  };

  // Upsert every record so the ledger and repost lookup are self-contained.
  let recordCount = 0;
  for (const feed of feeds) {
    for (const record of feed.records) {
      upsertRecord(store, record, feed.surface, nowIso);
      recordCount += 1;
    }
  }

  const alerts = [];
  const suppressions = [];
  let seeded = 0;

  // Freebies (classifieds) — their own notification class.
  for (const feed of feeds) {
    if (feed.surface !== 'classifieds') continue;
    const freebieResult = evaluateFreebies({
      records: feed.records,
      store,
      clock,
      pollAt,
      coldStart,
    });
    for (const alert of freebieResult.alerts) alerts.push(alert);
  }

  // Rules.
  for (const feed of feeds) {
    for (const record of feed.records) {
      for (const rule of rules) {
        const decision = evaluateRecordRule(record, feed.surface, rule, ctx);
        if (decision.action === 'alert') {
          alerts.push(decision.alert);
        } else if (decision.action === 'seeded') {
          seeded += 1;
        } else if (decision.action === 'suppress') {
          const sup = {
            poll_at: pollAt,
            node_id: record.node_id,
            rule_id: rule.id,
            kind: decision.kind,
            detail: null,
          };
          store.insertSuppression(sup);
          suppressions.push(sup);
        }
      }
    }
  }

  // Cold start: zero notifications; a log line records the counts.
  let sentAlerts = alerts;
  if (coldStart) {
    sentAlerts = [];
    log(
      `cold start: seeded ${seeded} already-alerted ledger rows across ${recordCount} records, 0 notifications sent`,
    );
  }

  return {
    alerts: sentAlerts,
    suppressions,
    coldStart,
    counts: {
      records: recordCount,
      alerts: sentAlerts.length,
      suppressions: suppressions.length,
      seeded,
    },
  };
}

export { GAP_THRESHOLD_MS, REPOST_WINDOW_MS };
