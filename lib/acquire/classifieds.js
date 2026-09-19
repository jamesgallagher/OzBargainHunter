/**
 * The classifieds poll cycle (design 3.6).
 *
 * One page per poll, no crawling outward. Fetch /classified, classify the
 * session from the page's own `uid` (the authoritative check, not the
 * status code), and act on the state:
 *
 *   valid           — parse the listings, return them, and report the session
 *                     as valid so the caller keeps polling.
 *   expired         — stop polling classifieds, latch off, raise a visible
 *                     alert. Never retry in a loop.
 *   cloudflare_block— stop all OzBargain requests, long backoff, loud alert.
 *
 * A 304 on /classified is not expected (it is not a conditional feed), but if
 * it occurs it is treated as "no change, not an error".
 */
import { parseClassifiedsPage } from '../parse/classifieds.js';
import { classifySession } from './session.js';

/**
 * @param {{
 *   client: { request(url: string): Promise<{ class: string, status: number, body: string }>, blocked?: boolean },
 *   store: object,
 *   clock: { now(): Date },
 *   config: object,
 *   log?: (line: string) => void,
 * }} deps
 * @returns {Promise<{ state: string, uid: number, listings: object[], alert: boolean, latched: boolean }>}
 */
export async function runClassifiedsPoll(deps) {
  const { client, clock, log = console.log } = deps;
  const url = 'https://www.ozbargain.com.au/classified';

  const response = await client.request(url);
  const nowIso = () => clock.now().toISOString();

  // A Cloudflare block latches the client off and stops everything.
  if (response.class === 'cloudflare_block') {
    log(`${nowIso()} ${url} cloudflare_block — stopping all requests`);
    return { state: 'cloudflare_block', uid: 0, listings: [], alert: true, latched: true };
  }

  // Parse the page to read the authoritative uid. A 304 has an empty body;
  // there is no uid to read, so fall back to the last known session state
  // (valid) — a 304 means the page did not change, so the session is as it
  // was.
  let uid = 0;
  let listings = [];
  if (response.class === 'ok') {
    const parsed = parseClassifiedsPage(response.body, { now: clock.now() });
    uid = parsed.uid;
    listings = parsed.listings;
  }

  const { state } = classifySession({ class: response.class, uid });

  if (state === 'expired') {
    // uid 0 or the permission-denial page: stop polling classifieds, latch
    // off, raise a visible alert. Never retry in a loop.
    log(`${nowIso()} ${url} session expired (uid=${uid}) — latching off`);
    return { state, uid, listings: [], alert: true, latched: true };
  }

  // valid
  return { state, uid, listings, alert: false, latched: false };
}
