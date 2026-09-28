/**
 * The sign-in route logic (prompt 4.1, 4.2): one user-driven login against the
 * classifieds origin, run through `performLogin` (chunk 5). This is the only
 * place outside `lib/ozb-login/` that reaches the login module, and it does
 * so with conditional dynamic imports so the unit tests (which inject fakes)
 * never load Playwright.
 *
 * The check order is fixed (prompt 4.2):
 * 1. Input validation (fixed 400 messages, never echoing submitted values).
 * 2. Origin check (`resolveLoginOrigin`): `unavailable` with the reason.
 * 3. The process-wide single-login lock: `busy` while another login runs.
 * 4. The access-gate check: `gate_closed` with `retryAt` (the gate row's
 *    `until_at` when cooling, `min_resume_at` when stopped, else null).
 * 5. The short-term throttle and the B6 lock (`checkLoginAllowed`, B6 first).
 * 6. The attempt record: a `pending` entry is written *before* the browser
 *    runs and updated to the final outcome after it resolves.
 * 7. `performLogin`; a throw is a `browser_error` (the log carries `err.name`
 *    only, never `err.message`).
 * 8. On `ok`: the session settings are saved (prompt 4.2 step 10).
 * 9. On `cloudflare_block` / `rate_limited`: the B7 gate email
 *    (`sendGateEvents`), in its own try/catch.
 * 10. The response carries `{ outcome }` plus `uid`/`expiresAt` for `ok` —
 *     nothing else.
 *
 * The lock is released in a `finally` that covers the save and the gate
 * email, so a slow save can never let a second login start early.
 */

import { systemClock } from '../clock.js';
import { systemRandom } from '../random.js';
import { createGate } from '../gate/index.js';
import { resolveLoginOrigin } from '../ozb-login/origin.js';
import {
  readAttempts,
  writeAttempts,
  checkLoginAllowed,
} from './login-throttle.js';

/** The setting the recorded login attempts live in (prompt 4.3). */
const ATTEMPTS_KEY = 'ozb_login_attempts';

/** The process-wide single-login lock (prompt 4.2). */
let loginInFlight = false;

/**
 * Inject the test fakes (prompt 5: `setLoginDepsForTest`). Any of the three
 * may be absent; the real module is dynamically imported only for the deps
 * that are not faked, so a test that fakes everything never loads Playwright.
 * Pass `null` to clear the fakes.
 * @param {{ performLogin?: Function, launchBrowser?: Function, sendGateEvents?: Function }|null} deps
 */
export function setLoginDepsForTest(deps) {
  testDeps = deps;
}
let testDeps = null;

/**
 * The gate delivery factories, mirroring the worker's
 * `buildGateDeliveryFactories`: every registered mechanism gets its
 * `build(row, cfg)` unless an injected factory wins.
 * @param {object} injected
 * @returns {Promise<object>}
 */
async function buildGateDeliveryFactories(injected) {
  const { MECHANISMS } = await import('../notify/registry.js');
  const factories = { ...injected };
  for (const m of MECHANISMS) {
    if (!factories[m.kind]) factories[m.kind] = (row, cfg) => m.build(row, cfg);
  }
  return factories;
}

/**
 * One-shot sleep (the `pause` dep for `performLogin`).
 * @param {number} ms
 * @returns {Promise<void>}
 */
function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one sign-in attempt (prompt 4.2). Pure with respect to the injected
 * `store`/`config`/`env`/`now`; the only ambient is `console.log` (the log)
 * and `process.platform`.
 *
 * @param {{
 *   body: object,
 *   store: object,
 *   config: object,
 *   env: object,
 *   now: Date
 * }} params
 * @returns {Promise<object>} the response object (prompt 4.2 step 12)
 */
export async function handleLoginRequest({ body, store, config, env, now }) {
  const log = (line) => console.log(line);
  const nowIso = now.toISOString();

  // 1. Input validation: fixed messages, never echoing submitted values. A
  // non-string field (a number, an object) is refused, not coerced: an
  // absent or empty field and a non-string field both read as "not a usable
  // username or password".
  if (typeof body.username !== 'string' || typeof body.password !== 'string') {
    return { inputError: 'Username and password are required.' };
  }
  const username = body.username.trim();
  const password = body.password;
  if (!username || !password) return { inputError: 'Username and password are required.' };
  if (username.length > 60) return { inputError: 'Username is too long.' };
  if (username.includes('@')) return { inputError: 'Use your OzBargain username, not your email address.' };
  if (password.length > 256) return { inputError: 'Password is too long.' };

  // 2. Origin check.
  const origin = resolveLoginOrigin({ classifiedsUrl: config.OZB_CLASSIFIEDS_URL, env });
  if (!origin.ok) return { outcome: 'unavailable', reason: origin.reason };

  // 3. The process-wide single-login lock; released in the `finally` below,
  // which covers the save (step 10) and the gate email (step 11).
  if (loginInFlight) return { outcome: 'busy' };
  loginInFlight = true;
  try {
    // 4. The access-gate check (a state-changing route may apply the lazy
    // transitions; the page must not, and does not).
    const gate = createGate({ store, clock: systemClock(), config, log });
    if (!gate.isOpen()) {
      const row = gate.read();
      const retryAt =
        row.state === 'cooling' ? row.until_at : row.state === 'stopped' ? row.min_resume_at : null;
      return { outcome: 'gate_closed', retryAt };
    }

    // 5. The short-term throttle and the B6 lock (one call, B6 first).
    const verdict = checkLoginAllowed(readAttempts(store.getSetting(ATTEMPTS_KEY)), now);
    if (!verdict.ok) return { outcome: verdict.reason, retryAt: verdict.retryAt };

    // 6. The attempt record: `pending` first, before the browser runs.
    const attempts = readAttempts(store.getSetting(ATTEMPTS_KEY));
    attempts.push({ at: nowIso, outcome: 'pending' });
    store.setSetting(ATTEMPTS_KEY, writeAttempts(attempts, now));

    // 7. `performLogin` (fakes win over the real module).
    const performLogin =
      testDeps?.performLogin ?? (await import('../ozb-login/index.js')).performLogin;
    const launchBrowser =
      testDeps?.launchBrowser ?? (await import('../ozb-login/browser.js')).launchChromium;
    let result;
    try {
      result = await performLogin({
        launchBrowser,
        baseUrl: origin.baseUrl,
        classifiedsUrl: config.OZB_CLASSIFIEDS_URL,
        username,
        password,
        gate,
        store,
        clock: systemClock(),
        pause: realSleep,
        random: systemRandom(),
        log,
        platform: process.platform,
      });
    } catch (err) {
      // Log `err.name` only, never `err.message` (prompt 4.2 step 8).
      log(`login: ${err?.name ?? 'error'}`);
      result = { outcome: 'browser_error' };
    }

    // 9. The attempt record: update the `pending` entry to the final outcome.
    const outcome = result.outcome;
    const idx = attempts.findIndex((a) => a.at === nowIso);
    if (idx >= 0) {
      attempts[idx] = { ...attempts[idx], outcome };
      store.setSetting(ATTEMPTS_KEY, writeAttempts(attempts, now));
    }

    if (outcome === 'ok') {
      // 8. On `ok`: save the session (prompt 4.2 step 10), all in one go.
      const cookie = result.cookie;
      const uid = result.uid;
      const expiresAt = result.expiresAt ?? null;
      store.setSetting('ozb_account_cookie', cookie);
      store.setSetting('ozb_account_cookie_set_at', nowIso);
      if (expiresAt) {
        store.setSetting('ozb_account_cookie_expires_at', expiresAt);
      } else {
        store.deleteSetting('ozb_account_cookie_expires_at');
      }
      store.setSetting('classifieds_last_uid', String(uid));
      store.setSetting('classifieds_last_confirmed_at', nowIso);
      store.setFeedState(config.OZB_CLASSIFIEDS_URL, null, null);
    }

    if (outcome === 'cloudflare_block' || outcome === 'rate_limited') {
      // 10 (B7): the gate email, in its own try/catch (sendGateEvents never
      // throws, but a factory construction error must not break the response).
      try {
        const sendGateEvents =
          testDeps?.sendGateEvents ?? (await import('../notify/gate.js')).sendGateEvents;
        const providerFactories = await buildGateDeliveryFactories({});
        await sendGateEvents({ store, clock: systemClock(), config, providerFactories, log });
      } catch (err) {
        log(`gate events: ${err?.name ?? 'error'}`);
      }
    }

    // 11. The response: `{ outcome }` plus `uid`/`expiresAt` for `ok` —
    // nothing else.
    if (outcome === 'ok') {
      return { outcome, uid: result.uid, expiresAt: result.expiresAt ?? null };
    }
    return { outcome };
  } finally {
    loginInFlight = false;
  }
}
