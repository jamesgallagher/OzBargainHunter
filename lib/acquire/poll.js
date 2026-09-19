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
 *   other— record a failures row and continue (degrade rather than die, 3.7):
 *          a failed front feed does not discard the deals already committed.
 *   transport error — record a failures row (class transport_error) and
 *          continue to the next URL; the cycle never aborts mid-way.
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

/**
 * Build the three poll URLs from config. The deals feed base carries the
 * `?page=0` / `?page=1` query; the front feed is the configured URL as-is.
 * The list is a constant of length three and there is no code path that
 * derives a page number beyond 1 (D41). When `config` is absent (e.g. a
 * caller that does not wire the 9.1 config), the production defaults are
 * used.
 * @param {object} [config] the validated config (9.1)
 * @returns {string[]} [deals page 0, deals page 1, front page]
 */
export function buildDealPollUrls(config) {
  const dealsBase = config?.OZB_DEALS_FEED_URL ?? 'https://www.ozbargain.com.au/deals/feed';
  const front = config?.OZB_FRONT_FEED_URL ?? 'https://www.ozbargain.com.au/feed';
  return [`${dealsBase}?page=0`, `${dealsBase}?page=1`, front];
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
  let anySuccess = false;
  let frontPageAvailable = false;
  let failures = 0;
  // The consecutive-failure counter is accumulated across cycles from the
  // stored value (design 3.5: "three consecutive failures"), not reset every
  // cycle. A success resets it to 0.
  const storedState = store.getPollState() ?? {};
  let consecutiveFailures = Number(storedState.consecutive_failures ?? 0);

  const nowIso = () => clock.now().toISOString();

  async function handle(url, isFrontPage) {
    let response;
    try {
      response = await client.request(url);
    } catch (err) {
      // A transport error (timeout, connection error, TLS, or a BlockedError
      // from an already-latched client) must not abort the cycle (design
      // 3.7 "degrade rather than die"). Record it and continue to the next
      // URL; the observations and poll_state are written unconditionally
      // below.
      store.insertFailure({
        failed_at: nowIso(),
        response_class: 'transport_error',
        body: String(err?.message ?? err),
      });
      failures += 1;
      consecutiveFailures += 1;
      lastResponseClass = 'transport_error';
      log(`${nowIso()} ${url} transport_error ${err?.message ?? err}`);
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
        consecutiveFailures += 1;
        log(`${nowIso()} ${url} unparseable ${err.message}`);
        if (isFrontPage) frontPageAvailable = false;
        return;
      }
      anySuccess = true;
      consecutiveFailures = 0;
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
      // so it counts as a successful poll (keeps last_success_at alive) and,
      // for the front feed, keeps front-page detection available.
      anySuccess = true;
      consecutiveFailures = 0;
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
    consecutiveFailures += 1;
    log(`${nowIso()} ${url} ${response.class}`);
    if (isFrontPage) frontPageAvailable = false;
  }

  for (const url of urls) {
    await handle(url, url === frontPageUrl);
    if (client.blocked) {
      // Cloudflare block: stop all OzBargain requests. Commit what we have.
      break;
    }
  }

  for (const obs of observed.values()) {
    store.insertObservation(obs);
  }

  // A real backoff delay (2^n, n = accumulated consecutive failures), not a
  // per-cycle URL count. On a successful cycle the counter is 0, so the
  // stored backoff is 0.
  const backoffSeconds = consecutiveFailures === 0 ? 0 : BASE_BACKOFF_SECONDS * Math.pow(2, consecutiveFailures - 1);

  store.setPollState({
    lastSuccessAt: anySuccess ? nowIso() : null,
    lastResponseClass,
    backoffSeconds,
    consecutiveFailures,
  });

  return {
    frontPageAvailable,
    failures,
    lastResponseClass,
  };
}
