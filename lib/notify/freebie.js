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
// at 1, so 0 is free and keeps the (node, rule) key intact. Node ids are one
// id space across deals and classifieds, so rule id 0 stays the single freebie
// ledger for both surfaces.
export const FREEBIE_RULE_ID = 0;
export const FREEBIE_SETTING_KEY = 'always_notify_freebie';
// The deal-freebie setting and its seeding key (design 6.6, D49). Absent
// `always_notify_deal_freebie` means on; `deal_freebies_seeded_at` records the
// ISO instant the freebies feed was first evaluated on a store.
export const DEAL_FREEBIE_SETTING_KEY = 'always_notify_deal_freebie';
export const DEAL_FREEBIE_SEEDED_AT_KEY = 'deal_freebies_seeded_at';

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

    // A real classifieds freebie alert: write the ledger row with `sent: true`
    // so it appears in Activity (review round 1 F3). The cold-start seeding
    // rows above (sent: 0) do not.
    store.insertLedger({ node_id: nodeId, rule_id: FREEBIE_RULE_ID, fired_at: nowIso, sent: true });
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

/**
 * Whether a deal record is an alertable deal freebie: not expired by either
 * the `ozb:title-msg type="expired"` marker or its `expiry_at` timestamp.
 * `upcoming`, `targeted` and `longrunning` items are eligible.
 * @param {object} record a deals record (from the freebies feed)
 * @param {string} nowIso
 * @returns {boolean}
 */
export function isDealFreebieEligible(record, nowIso) {
  if (record.title_msg_types?.includes('expired')) return false;
  if (record.expiry_at && Date.parse(record.expiry_at) < Date.parse(nowIso)) return false;
  return true;
}

/**
 * Evaluate the deal freebies (design 6.6, D49). Every deal OzBargain lists in
 * the freebies feed is a freebie; the setting `always_notify_deal_freebie`
 * gates them (absent = on, '1' on, '0' off).
 *
 * Silent seeding: the first time the freebies feed is evaluated on a store
 * that has never seen it, every eligible item is marked in the ledger and
 * nothing is sent, and the `deal_freebies_seeded_at` key is set. Seeding
 * happens even when the setting is off, so turning it on later does not flood
 * the user with week-old freebies. This is independent of the worker's
 * `coldStart`, which only covers an empty database.
 *
 * One notification per node per poll: if a keyword/threshold rule alerts on
 * the same node in the same poll, the freebie alert is dropped but its ledger
 * row is still written, so it never fires later.
 *
 * @param {{
 *   records: object[],        // deals records from the freebies feed
 *   store: object,
 *   clock: { now(): Date },
 *   pollAt: string,           // ISO-8601
 *   ruleAlertedNodeIds?: Set<number>, // nodes a rule alerted on this poll
 * }} args
 * @returns {{ alerts: object[] }} the deal-freebie alerts to send
 */
export function evaluateDealFreebies(args) {
  const { records, store, clock, pollAt, ruleAlertedNodeIds = new Set() } = args;
  const nowIso = clock.now().toISOString();
  const enabledRaw = store.getSetting(DEAL_FREEBIE_SETTING_KEY);
  const enabled = enabledRaw === null ? true : enabledRaw === '1';
  const isSeeding = store.getSetting(DEAL_FREEBIE_SEEDED_AT_KEY) == null;

  const alerts = [];
  for (const record of records) {
    if (!isDealFreebieEligible(record, nowIso)) continue;
    const nodeId = record.node_id;
    if (store.hasLedger(nodeId, FREEBIE_RULE_ID)) continue; // already notified

    if (isSeeding || !enabled) {
      // Silent seeding (first evaluation) or the setting is off: mark the
      // item so it does not alert later, send nothing.
      store.insertLedger({ node_id: nodeId, rule_id: FREEBIE_RULE_ID, fired_at: nowIso });
      continue;
    }

    // Setting on, not seeding: this is a real alert. Write the ledger row so
    // the freebie never fires later, even if a rule alert drops it below. A
    // node dropped because a rule alerted in the same poll gets `sent: false`
    // (the rule's notification is the one the user saw), so it does not
    // appear in Activity; a node that is actually pushed gets `sent: true`
    // (review round 1 F3).
    const dropped = ruleAlertedNodeIds.has(nodeId);
    store.insertLedger({ node_id: nodeId, rule_id: FREEBIE_RULE_ID, fired_at: nowIso, sent: !dropped });
    if (dropped) continue; // one notification per node
    alerts.push({
      kind: 'deal_freebie',
      rule_id: FREEBIE_RULE_ID,
      ruleLabel: 'freebie',
      node_id: nodeId,
      title: record.title,
      url: record.url,
      merchant_url: record.merchant_url ?? null,
      priority: 'normal',
      tags: ['freebie', 'deal'],
      isFrontPage: false,
      pollAt,
    });
  }
  if (isSeeding) {
    store.setSetting(DEAL_FREEBIE_SEEDED_AT_KEY, nowIso);
  }
  return { alerts };
}
