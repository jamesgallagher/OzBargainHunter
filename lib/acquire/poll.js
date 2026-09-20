/**
 * The deal poll cycle (design 3.1, 3.2, 3.7, 4.1).
 *
 * One cycle fetches exactly three URLs, in order, then stops: deals page 0,
 * deals page 1, the front page. The two-page cap is structural — the list is
 * a constant of length three and there is no code path that computes a page
 * number beyond 1 (D41). Requests are sequential, never parallel, with the
 * client's pause between them.
 *
 * Per URL:
 *   200  — parse, upsert deals, append one observation per node (deduped
 *          across feeds within the cycle, first-seen in feed order wins), and
 *          set front_page_first_seen for nodes seen in the front feed.
 *          A body that will not parse is a failure: record class
 *          unparseable, retain the body, upsert nothing from it (3.7).
 *   304  — nothing changed. Not an error; the expected common case. A 304
 *          proves the URL was reached, so it counts as a successful poll
 *          (it keeps the last-success timestamp alive and, for the front
 *          feed, keeps front-page detection available).
 *   other— record a failures row (class = the response class) and continue
 *          (degrade rather than die, 3.7): a failed front feed does not
 *          discard the deals already committed.
 *   transport error — a timeout, connection, or TLS error: record a failures
 *          row (class transport_error) and continue to the next URL; the
 *          cycle never aborts mid-way.
 *   BlockedError — the client is already latched off by a Cloudflare block:
 *          record a failures row (class cloudflare_block), stop issuing
 *          further requests, and commit what the cycle already fetched.
 *   DeniedPathError — a configured URL points at a deny-listed path: a
 *          configuration error that fails on every cycle, so it is rethrown
 *          (fail loudly) rather than recorded as a transient failure. The
 *          observation flush and the poll_state write run in a finally, so a
 *          cycle that reached a feed flushes its deals and observations
 *          before the error propagates — it never leaves half its writes
 *          behind.
 *
 * poll_state is updated with the last successful poll (preserved when the
 * cycle produced no new success), the last response class, and the backoff
 * state (a real delay, accumulated across cycles via the stored
 * consecutive_failures counter).
 */
import { parseDealsFeed, ParseError } from '../parse/deals.js';

// The base backoff, matching the client's (design 3.3: exponential with
// jitter). The stored counter is the exponent; the client's own backoff
// doubles on each consecutive failure, so 2^n is the base delay that the
// cycle would wait before the next request.
const BASE_BACKOFF_SECONDS = 2;
// The backoff exponent is clamped so `backoff_seconds` can never leave the
// safe-integer range. 2^54 exceeds Number.MAX_SAFE_INTEGER, and a poll_state
// row that stores it can no longer be read back (better-sqlite3 throws
// RangeError), which would wedge every later cycle at getPollState().
// Clamping at 12 keeps the stored value bounded (2 * 2^11 = 4096 s) while
// still expressing "the poller has been failing for a long time".
const MAX_BACKOFF_EXPONENT = 12;

/**
 * Build the three poll URLs from config. The deals feed base carries the
 * `?page=0` / `?page=1` query; the front feed is the configured URL as-is.
 * The list is a constant of length three and there is no code path that
 * derives a page number beyond 1 (D41). When `config` is absent (e.g. a
 * caller that does not wire the 9.1 config), the production defaults are
 * used.
 *
 * The page query is composed with `URL` + `searchParams.set`, not string
 * concatenation: a base that already carries a query (e.g. a loopback
 * fixture server `…/feed?fixture=deals`) must get `page` as a *separate*
 * param, and a base with a `#fragment` must not have its query folded into
 * the fragment.
 * @param {object} [config] the validated config (9.1)
 * @returns {string[]} [deals page 0, deals page 1, front page]
 */
export function buildDealPollUrls(config) {
  const dealsBase = config?.OZB_DEALS_FEED_URL ?? 'https://www.ozbargain.com.au/deals/feed';
  const front = config?.OZB_FRONT_FEED_URL ?? 'https://www.ozbargain.com.au/feed';
  const page0 = new URL(dealsBase);
  page0.searchParams.set('page', '0');
  const page1 = new URL(dealsBase);
  page1.searchParams.set('page', '1');
  return [page0.toString(), page1.toString(), front];
}

/**
 * @param {{
 *   client: { request(url: string): Promise<{ class: string, status: number, body: string }>, blocked?: boolean },
 *   store: object,
 *   clock: { now(): Date },
 *   config: object,
 *   log?: (line: string) => void,
 * }} deps
 * @returns {Promise<{ frontPageAvailable: boolean, failures: number, lastResponseClass: string }>}
 */
export async function runDealPoll(deps) {
  const { client, store, clock, config, log = console.log } = deps;

  // The three URLs, in order, built from config. There is no fourth entry
  // and no loop that derives a page number — the cap is the length of this
  // list.
  const urls = buildDealPollUrls(config);
  const frontPageUrl = urls[2];

  // One observation per node per poll, deduped across feeds. The first feed
  // in order that carries a node supplies its values (feed order: p0, p1,
  // front). A 304 page contributes nothing — it did not change.
  const observed = new Map();

  let lastResponseClass = null;
  let frontPageAvailable = false;
  let failures = 0;
  // Whether at least one *deals* feed (page 0 or page 1 — not the front
  // page) was reached with a 200 or 304. This is what certifies the poll
  // as having made progress, and it is what decides whether a front-feed
  // 304 alone may advance last_success_at (see the bookkeeping below).
  let dealsFeedReached = false;
  // The consecutive-failure counter is accumulated across cycles from the
  // stored value (design 3.5: "three consecutive failures"). It is derived
  // from the cycle's *totals* at the end, not from whichever URL came last,
  // so a front-feed 304 cannot launder a failing cycle (a 304 on the front
  // feed must not zero the counter when the deals feed failed).
  const storedState = store.getPollState() ?? {};
  const storedFailures = Number(storedState.consecutive_failures ?? 0);

  const nowIso = () => clock.now().toISOString();

  async function handle(url, isFrontPage) {
    let response;
    try {
      response = await client.request(url);
    } catch (err) {
      // A DeniedPathError is a configuration error (a configured URL points
      // at a deny-listed path), not a transient transport condition: it
      // will fail on every cycle, so it must fail loudly rather than be
      // recorded as a transient failure and retried forever. Rethrow it. The
      // rethrow propagates out of the URL loop, but the observation flush and
      // the poll_state write run in the finally below, so the deals and
      // observations collected before this throw are still committed.
      if (err?.name === 'DeniedPathError') {
        throw err;
      }
      // A BlockedError is the client already latched off by a Cloudflare
      // block. Record it as cloudflare_block (not transport_error) so the
      // block class is not mislabelled; the loop breaks on client.blocked
      // and the observations and poll_state are written below.
      const isBlock = err?.name === 'BlockedError';
      const responseClass = isBlock ? 'cloudflare_block' : 'transport_error';
      // A transport error (timeout, connection error, TLS, or a BlockedError
      // from an already-latched client) must not abort the cycle (design
      // 3.7 "degrade rather than die"). Record it and continue to the next
      // URL; the observations and poll_state are written unconditionally
      // below.
      store.insertFailure({
        failed_at: nowIso(),
        response_class: responseClass,
        body: String(err?.message ?? err),
      });
      failures += 1;
      lastResponseClass = responseClass;
      log(`${nowIso()} ${url} ${responseClass} ${err?.message ?? err}`);
      if (isFrontPage) frontPageAvailable = false;
      return;
    }

    lastResponseClass = response.class;

    if (response.class === 'ok') {
      let records;
      try {
        records = parseDealsFeed(response.body);
      } catch (err) {
        // A 200 whose body will not parse is a failure (3.5 / 3.7). Retain
        // the body for diagnosis, upsert nothing from it, and continue.
        store.insertFailure({
          failed_at: nowIso(),
          response_class: 'unparseable',
          body: response.body,
        });
        failures += 1;
        log(`${nowIso()} ${url} unparseable ${err.message}`);
        if (isFrontPage) frontPageAvailable = false;
        return;
      }
      if (!isFrontPage) dealsFeedReached = true;
      if (isFrontPage) frontPageAvailable = true;

      for (const record of records) {
        store.upsertDeal({
          node_id: record.node_id,
          title: record.title,
          url: record.url,
          author: record.author,
          posted_at: record.posted_at,
          categories: record.categories,
          merchant_url: record.merchant_url ?? null,
          expiry_at: record.expiry_at ?? null,
          first_seen: nowIso(),
          // Set on first sighting in the front feed; the store's COALESCE
          // preserves an *earlier* value on later polls (first-seen, not
          // last-seen — design 4.1).
          front_page_first_seen: isFrontPage ? nowIso() : null,
        });
        // One observation per node per poll; first-seen in feed order wins.
        if (!observed.has(record.node_id)) {
          observed.set(record.node_id, {
            deal_id: record.node_id,
            votes_pos: record.votes_pos,
            votes_neg: record.votes_neg,
            comment_count: record.comment_count,
            click_count: record.click_count,
            observed_at: nowIso(),
          });
        }
      }
      return;
    }

    if (response.class === 'not_modified') {
      // 304: nothing changed. Not an error. It proves the URL was reached,
      // so for a deals page it counts as having reached the feed (keeps
      // last_success_at alive), and for the front feed it keeps front-page
      // detection available. It does NOT reset the consecutive-failure
      // counter — the counter is derived from the cycle's totals at the end,
      // so a front-feed 304 cannot launder a failing cycle.
      if (!isFrontPage) dealsFeedReached = true;
      if (isFrontPage) frontPageAvailable = true;
      return;
    }

    // Any other class: record a failures row and continue (degrade rather
    // than die). A Cloudflare block latches the client off; the cycle
    // commits what it already got and stops issuing further requests.
    store.insertFailure({
      failed_at: nowIso(),
      response_class: response.class,
      body: response.body,
    });
    failures += 1;
    log(`${nowIso()} ${url} ${response.class}`);
    if (isFrontPage) frontPageAvailable = false;
  }

  try {
    for (const url of urls) {
      await handle(url, url === frontPageUrl);
      if (client.blocked) {
        // Cloudflare block: stop all OzBargain requests. Commit what we have.
        break;
      }
    }
  } finally {
    // The observation flush and the poll_state write run unconditionally — in
    // a finally — so a cycle that reached a feed never leaves half its writes
    // behind. A DeniedPathError (a configuration error, deliberately
    // rethrown so it fails loudly) propagates out of the URL loop above, but
    // the observations collected before the throw and the poll_state are still
    // flushed before the error reaches the caller. On the happy path this runs
    // identically to the previous inline flush.

    for (const obs of observed.values()) {
      store.insertObservation(obs);
    }

    // The consecutive-failure counter is derived from the cycle's *totals*,
    // not from whichever URL came last. If the cycle recorded any failures
    // the counter accumulates from the stored value. If it recorded none, it
    // resets to 0 only when a *deals* feed was reached (real progress); an
    // aborted cycle that reached no feed (e.g. a DeniedPathError on the first
    // URL) preserves the stored counter — a zero-progress abort must not wipe
    // an accumulated failure count. This is also what a front-feed 304 cannot
    // launder: a 304 on the front feed does not zero the counter when the
    // deals feed failed (dealsFeedReached stays false).
    const consecutiveFailures =
      failures > 0
        ? storedFailures + failures
        : dealsFeedReached
          ? 0
          : storedFailures;

    // A real backoff delay (2^n, n = accumulated consecutive failures), not a
    // per-cycle URL count. On a successful cycle the counter is 0, so the
    // stored backoff is 0. The exponent is clamped so the stored value never
    // leaves the safe-integer range (see MAX_BACKOFF_EXPONENT).
    const backoffSeconds =
      consecutiveFailures === 0
        ? 0
        : BASE_BACKOFF_SECONDS * Math.pow(2, Math.min(consecutiveFailures, MAX_BACKOFF_EXPONENT) - 1);

    // last_success_at advances only when the cycle made real progress: at
    // least one *deals* feed (page 0 or page 1) was reached with a 200 or a
    // 304. A front-feed 304 alone (deals feed failing) must not certify the
    // poll healthy — otherwise a broken deals feed reads as healthy and the
    // dead-man's switch / /healthz can never fire. In every non-throwing path
    // `failures === 0` already implies a deals feed was reached, so gating on
    // dealsFeedReached alone is equivalent there; the only case it changes is
    // an aborted cycle that reached no feed (e.g. a DeniedPathError on the
    // first URL, where failures is 0 but no deals feed was reached), which must
    // NOT record a false success. When the cycle produced no new success,
    // lastSuccessAt is null and the store's COALESCE preserves the stored value.
    const newSuccess = dealsFeedReached;

    store.setPollState({
      lastSuccessAt: newSuccess ? nowIso() : null,
      lastResponseClass,
      backoffSeconds,
      consecutiveFailures,
    });
  }

  return {
    frontPageAvailable,
    failures,
    lastResponseClass,
  };
}
