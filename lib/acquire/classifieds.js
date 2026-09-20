/**
 * The classifieds poll cycle (design 3.6).
 *
 * One page per poll, no crawling outward. Fetch /classified (the URL from
 * config), classify the session from the page's own `uid` (the authoritative
 * check, not the status code), and act on the state:
 *
 *   valid           — parse the listings, persist the uid, return them, and
 *                     report the session as valid so the caller keeps
 *                     polling.
 *   expired         — uid 0 or the permission-denial page: stop polling
 *                     classifieds, latch off, raise a visible alert, and
 *                     record a durable trace (a `failures` row) so card 4's
 *                     screen 9 has something to display and clear. Never
 *                     retry in a loop.
 *   cloudflare_block— stop all OzBargain requests, long backoff, loud alert,
 *                     and record a durable trace.
 *   unchanged       — a 304. The page did not change, so the session is "as
 *                     it was": resolve from the last known uid (persisted in
 *                     settings). Not an error; never latches.
 *   unknown         — a transient 5xx, 429 or 404. The session is unknown
 *                     for this response; do not latch or alert.
 *
 * The last known uid is persisted in settings (`classifieds_last_uid`) so a
 * 304 can be resolved without re-reading the page, and a session expiry or
 * block leaves a durable `failures` row (card 4's screen 9 displays and
 * clears it).
 */
import { parseClassifiedsPage } from '../parse/classifieds.js';
import { classifySession } from './session.js';

const LAST_UID_KEY = 'classifieds_last_uid';
// X12: the instant the session was last confirmed working (a 200 that parsed a
// non-zero uid). Screen 9 displays it ("when it was last confirmed working").
const LAST_CONFIRMED_KEY = 'classifieds_last_confirmed_at';
// M1: the screen-9 account-cookie setting. This is the *consumer* for the
// setting the screen-9 route writes (`ozb_account_cookie`): the classifieds
// poll sends it on its request so a fresh cookie actually carries the session.
// The env value (`OZB_ACCOUNT_COOKIE`) is the fallback when the setting is
// absent.
const ACCOUNT_COOKIE_KEY = 'ozb_account_cookie';

/**
 * Resolve the account cookie to send on a classifieds request (M1): the
 * screen-9 setting wins, falling back to the env value.
 * @param {object} store
 * @param {object} config
 * @returns {string}
 */
function resolveAccountCookie(store, config) {
  const fromSetting = store.getSetting ? store.getSetting(ACCOUNT_COOKIE_KEY) : null;
  if (fromSetting) return fromSetting;
  return String(config?.OZB_ACCOUNT_COOKIE ?? '');
}

/**
 * @param {{
 *   client: { request(url: string, options?: { cookie?: string }): Promise<{ class: string, status: number, body: string }>, blocked?: boolean },
 *   store: object,
 *   clock: { now(): Date },
 *   config: object,
 *   log?: (line: string) => void,
 * }} deps
 * @returns {Promise<{ state: string, uid: number, listings: object[], alert: boolean, latched: boolean }>}
 */
export async function runClassifiedsPoll(deps) {
  const { client, store, clock, config, log = console.log } = deps;
  const url = config?.OZB_CLASSIFIEDS_URL ?? 'https://www.ozbargain.com.au/classified';
  const nowIso = () => clock.now().toISOString();
  // M1: the stored account cookie (screen 9) or the env fallback is sent on the
  // request, so a fresh cookie actually carries the session.
  const cookie = resolveAccountCookie(store, config);

  let response;
  try {
    response = await client.request(url, cookie ? { cookie } : {});
  } catch (err) {
    // A transport error must not abort the caller (design 3.7). Record it
    // and report the session as unknown; the caller keeps its last state.
    store.insertFailure({
      failed_at: nowIso(),
      response_class: 'transport_error',
      body: String(err?.message ?? err),
    });
    log(`${nowIso()} ${url} transport_error ${err?.message ?? err}`);
    return { state: 'unknown', uid: 0, listings: [], alert: false, latched: false };
  }

  // A Cloudflare block latches the client off and stops everything.
  if (response.class === 'cloudflare_block') {
    store.insertFailure({
      failed_at: nowIso(),
      response_class: 'cloudflare_block',
      body: response.body,
    });
    log(`${nowIso()} ${url} cloudflare_block — stopping all requests`);
    return { state: 'cloudflare_block', uid: 0, listings: [], alert: true, latched: true };
  }

  // A 304 is "no change, not an error": resolve the session from the last
  // known uid (persisted in settings). A 304 means the page did not change,
  // so the session is as it was. A 304 never latches or alerts — the caller
  // keeps its previous state and decides what to do with the resolved state.
  // When no last uid is known (a cold store, never a valid 200), the session
  // is `unchanged` — the caller keeps its previous state. When a last uid IS
  // known, it resolves to that uid: a non-zero one stays valid, a zero one
  // (set on expiry) is expired.
  if (response.class === 'not_modified') {
    const raw = store.getSetting(LAST_UID_KEY);
    // A corrupt (non-numeric) setting is treated as "no last uid known", not
    // as 0: `Number.parseInt` of a non-numeric string is NaN, and a NaN last
    // uid must not resolve a dead session as valid (hardening; the current
    // writers only ever store `String(uid)` or `'0'`).
    const parsed = raw === null || raw === undefined ? null : Number.parseInt(raw, 10);
    const lastUid = parsed !== null && Number.isNaN(parsed) ? null : parsed;
    const { state } = classifySession({ class: 'not_modified', uid: lastUid });
    log(`${nowIso()} ${url} not_modified — session as it was (uid=${lastUid ?? 'unknown'})`);
    return { state, uid: lastUid ?? 0, listings: [], alert: false, latched: false };
  }

  // The application permission-denial page (OzBargain's own styled HTML at
  // 403) is an invalid session on /classified: latch off and alert. This is
  // distinct from a Cloudflare block (handled above) and from a transient
  // 5xx/429/404 (not a session signal).
  if (response.class === 'permission_denied') {
    store.setSetting(LAST_UID_KEY, '0');
    store.insertFailure({
      failed_at: nowIso(),
      response_class: 'session_expired',
      body: 'classifieds permission-denied page (session invalid)',
    });
    log(`${nowIso()} ${url} permission_denied — latching off`);
    return { state: 'expired', uid: 0, listings: [], alert: true, latched: true };
  }

  // A transient 5xx, 429 or 404 is not a session signal: report unknown,
  // never latch, never alert.
  if (response.class !== 'ok') {
    log(`${nowIso()} ${url} ${response.class} — session unknown, not latching`);
    return { state: 'unknown', uid: 0, listings: [], alert: false, latched: false };
  }

  // A 200: parse the page to read the authoritative uid.
  const parsed = parseClassifiedsPage(response.body, { now: clock.now() });
  const uid = parsed.uid;
  const { state } = classifySession({ class: response.class, uid });

  if (state === 'expired') {
    // uid 0 or the permission-denial page: stop polling classifieds, latch
    // off, raise a visible alert, and record a durable trace. Never retry in
    // a loop. Invalidate the persisted last uid so a later 304 cannot
    // resolve the dead session as valid from a stale value.
    store.setSetting(LAST_UID_KEY, '0');
    store.insertFailure({
      failed_at: nowIso(),
      response_class: 'session_expired',
      body: `classifieds session expired (uid=${uid})`,
    });
    log(`${nowIso()} ${url} session expired (uid=${uid}) — latching off`);
    return { state, uid, listings: [], alert: true, latched: true };
  }

  // valid: persist the uid so a later 304 can be resolved, and return the
  // listings. X12: also persist the instant the session was confirmed working.
  store.setSetting(LAST_UID_KEY, String(uid));
  store.setSetting(LAST_CONFIRMED_KEY, nowIso());
  return { state, uid, listings: parsed.listings, alert: false, latched: false };
}
