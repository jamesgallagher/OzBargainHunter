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
 *   304  — nothing changed. Not an error; the expected common case.
 *   other— record a failures row and continue (degrade rather than die, 3.7):
 *          a failed front feed does not discard the deals already committed.
 *
 * poll_state is updated with the last successful poll, the last response
 * class, and the backoff state.
 */
import { parseDealsFeed, ParseError } from '../parse/deals.js';

// The three URLs, in order. The base is the config default; the page query
// is the only thing that varies. There is no fourth entry and no loop that
// derives a page number — the cap is the length of this list.
export const DEAL_POLL_URLS = [
  'https://www.ozbargain.com.au/deals/feed?page=0',
  'https://www.ozbargain.com.au/deals/feed?page=1',
  'https://www.ozbargain.com.au/feed',
];

const FRONT_PAGE_URL = DEAL_POLL_URLS[2];

/**
 * @param {{
 *   client: { request(url: string): Promise<{ class: string, status: number, body: string }> },
 *   store: object,
 *   clock: { now(): Date },
 *   config: object,
 *   log?: (line: string) => void,
 * }} deps
 * @returns {Promise<{ frontPageAvailable: boolean, failures: number, lastResponseClass: string }>}
 */
export async function runDealPoll(deps) {
  const { client, store, clock, log = console.log } = deps;

  // One observation per node per poll, deduped across feeds. The first feed
  // in order that carries a node supplies its values (feed order: p0, p1,
  // front). A 304 page contributes nothing — it did not change.
  const observed = new Map();

  let lastResponseClass = null;
  let anySuccess = false;
  let frontPageAvailable = false;
  let failures = 0;
  let consecutiveFailures = 0;

  const nowIso = () => clock.now().toISOString();

  async function handle(url, isFrontPage) {
    const response = await client.request(url);
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
      anySuccess = true;
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
          // preserves an earlier value on later polls.
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
      // 304: nothing changed. Not an error. No observations, no upserts.
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

  for (const url of DEAL_POLL_URLS) {
    await handle(url, url === FRONT_PAGE_URL);
    if (client.blocked) {
      // Cloudflare block: stop all OzBargain requests. Commit what we have.
      break;
    }
  }

  for (const obs of observed.values()) {
    store.insertObservation(obs);
  }

  store.setPollState({
    lastSuccessAt: anySuccess ? nowIso() : null,
    lastResponseClass,
    backoffSeconds: anySuccess ? 0 : consecutiveFailures,
    consecutiveFailures: anySuccess ? 0 : consecutiveFailures,
  });

  return {
    frontPageAvailable,
    failures,
    lastResponseClass,
  };
}
