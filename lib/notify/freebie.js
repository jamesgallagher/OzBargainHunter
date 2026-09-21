/**
 * Freebie notifications (design 6.6).
 *
 * "Always notify on freebie" defaults on. Every new classified listing of
 * type *Freebie* produces a notification immediately, without needing to
 * match any rule. Freebies are not a rule; they are their own notification
 * class.
 *
 * - Pinned listings are excluded, even when they are freebies.
 * - Wanted listings are excluded, as everywhere else.
 * - The notification names the poster and summarises the listing.
 * - Priority is normal (only front-page alerts outrank it).
 * - De-duplication applies unchanged: a listing notifies once, keyed on its
 *   node ID. On a cold start the initial batch is suppressed rather than
 *   announced.
 * - Expiry is respected: an already-expired freebie is not announced.
 *
 * Pure: takes records, a store, a clock, the poll time and settings, and
 * returns the freebie alerts to send. Nothing here opens a socket.
 */

// The reserved ledger rule id for freebie de-duplication. Real rules start
// at 1, so 0 is free and keeps the (node, rule) key intact.
export const FREEBIE_RULE_ID = 0;
export const FREEBIE_SETTING_KEY = 'always_notify_freebie';

/**
 * @param {object} record a classifieds record
 * @returns {boolean} true when the record is an alertable freebie: type
 * free, not pinned, and not already expired.
 */
export function isFreebieEligible(record, nowIso) {
  if (record.type !== 'free') return false;
  if (record.pinned === true) return false;
  if (record.expiry_at && Date.parse(record.expiry_at) < Date.parse(nowIso)) return false;
  return true;
}

/**
 * @param {{
 *   records: object[],        // classifieds records
 *   store: object,
 *   clock: { now(): Date },
 *   pollAt: string,           // ISO-8601
 *   coldStart?: boolean,
 * }} args
 * @returns {{ alerts: object[] }} the freebie alerts to send
 */
export function evaluateFreebies(args) {
  const { records, store, clock, pollAt, coldStart = false } = args;
  const nowIso = clock.now().toISOString();
  const enabledRaw = store.getSetting(FREEBIE_SETTING_KEY);
  const enabled = enabledRaw === null ? true : enabledRaw === '1';

  const alerts = [];
  if (!enabled) return { alerts };

  for (const record of records) {
    if (!isFreebieEligible(record, nowIso)) continue;
    const nodeId = record.node_id;

    if (coldStart) {
      // Silent seeding: mark seen, announce nothing.
      store.insertLedger({ node_id: nodeId, rule_id: FREEBIE_RULE_ID, fired_at: nowIso });
      continue;
    }

    if (store.hasLedger(nodeId, FREEBIE_RULE_ID)) continue; // already notified

    store.insertLedger({ node_id: nodeId, rule_id: FREEBIE_RULE_ID, fired_at: nowIso });
    alerts.push({
      kind: 'freebie',
      rule_id: FREEBIE_RULE_ID,
      ruleLabel: 'freebie',
      node_id: nodeId,
      title: record.title,
      url: record.url,
      poster: record.poster,
      priority: 'normal',
      tags: ['freebie', record.type],
      isFrontPage: false,
      pollAt,
    });
  }
  return { alerts };
}
