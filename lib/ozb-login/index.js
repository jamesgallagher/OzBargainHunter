/**
 * The login module (chunk 5, prompt 4.4–4.10).
 *
 * `performLogin` drives a real headless Chromium (Playwright) through exactly
 * three page visits — the login form, the login POST, and the classifieds
 * page — and returns the session cookie. It never throws for site or browser
 * outcomes; those are returned as `{ outcome }`. It throws only for
 * programming errors (a missing dependency, or an empty credential), with a
 * fixed message that names the dependency and never a value.
 *
 * Nothing here runs on a timer: the one-shot hard timeout is a single
 * `setTimeout` that fires once, and every wait comes from the injected
 * `pause`, every jitter from the injected `random`, every timestamp from the
 * injected `clock`. The browser is closed (and the close awaited) before the
 * promise resolves, whatever the outcome, so a caller can assert
 * `browser.isConnected() === false` immediately after `performLogin` returns.
 * A step that outlives the timer stops at its next await; a browser that
 * launched after the timer fired is closed there, because the timer's exit
 * ran while the launch had not yet returned.
 *
 * The only place a cookie value leaves the module is the returned `cookie`
 * header. The username and password are `fill`ed into the page and never
 * enter Node; page text is read inside the page (in `page.evaluate`) and the
 * one exception is the body read for the Cloudflare marker test, which is a
 * local variable that is never logged, stored, or returned.
 */
import { classifyResponse, hasCloudflareMarkers } from '../classify.js';
import {
  buildChromeUserAgent,
  CONTEXT_OPTIONS,
  LAUNCH_ARGS,
} from './identity.js';
import { selectSessionCookies } from './cookies.js';

/**
 * The complete set of outcomes `performLogin` can return (prompt 4.4).
 * Frozen: callers may not add to it.
 */
export const LOGIN_OUTCOMES = Object.freeze([
  'ok',
  'bad_credentials',
  'validation_error',
  'login_failed',
  'not_entitled',
  'cloudflare_block',
  'rate_limited',
  'form_changed',
  'gate_closed',
  'timeout',
  'transient',
  'browser_error',
]);

/**
 * The dependencies `performLogin` requires. A missing one is a programming
 * error, thrown with a fixed message that names the dependency.
 */
const REQUIRED_DEPS = [
  'launchBrowser',
  'baseUrl',
  'classifiedsUrl',
  'username',
  'password',
  'gate',
  'store',
  'clock',
  'pause',
  'random',
  'log',
  'platform',
];

/**
 * Assert the dependencies are all present (a programming error otherwise).
 * @param {object} deps
 */
function requireDeps(deps) {
  for (const name of REQUIRED_DEPS) {
    if (!(name in deps) || deps[name] === undefined || deps[name] === null) {
      throw new Error(`performLogin: missing dependency "${name}"`);
    }
  }
  if (typeof deps.username !== 'string' || deps.username.length === 0) {
    throw new Error('performLogin: "username" must be a non-empty string');
  }
  if (typeof deps.password !== 'string' || deps.password.length === 0) {
    throw new Error('performLogin: "password" must be a non-empty string');
  }
  return deps;
}

/**
 * Run the login.
 *
 * @param {object} deps
 * @param {object} deps.launchBrowser `(options) => Promise<Browser>`
 * @param {string} deps.baseUrl the origin the login runs against
 * @param {string} deps.classifiedsUrl the classifieds URL (step 5)
 * @param {string} deps.username
 * @param {string} deps.password
 * @param {object} deps.gate the app gate (`check`, `recordResponse`)
 * @param {object} deps.store the app store (`insertFailure`)
 * @param {object} deps.clock `{ now(): Date }`
 * @param {(ms: number) => Promise<void>} deps.pause
 * @param {object} deps.random `{ next(): number }` in [0, 1)
 * @param {(line: string) => void} deps.log
 * @param {string} deps.platform `process.platform`
 * @param {number} [deps.timeoutMs] the hard timeout; default 45000
 * @returns {Promise<{ outcome: 'ok', cookie: string, uid: number, expiresAt: string|null } | { outcome: string }>}
 */
export function performLogin(deps) {
  const {
    launchBrowser,
    baseUrl,
    classifiedsUrl,
    username,
    password,
    gate,
    store,
    clock,
    pause,
    random,
    log,
    platform,
  } = requireDeps(deps);
  const timeoutMs = deps.timeoutMs ?? 45_000;

  return new Promise((resolve) => {
    /** The outcome to resolve with; set before every `finish()`. */
    let outcome = null;
    /** The count of requests the allowlist aborted. */
    let blockedRequests = 0;
    /** The launched browser (null until step 1). */
    let browser = null;
    /** The context created in step 1 (null until then). */
    let context = null;
    /** The page created in step 1 (null until then). */
    let page = null;
    /** The hard-timeout handle (null once cleared). */
    let timer = null;
    /** True once the hard timeout has fired. */
    let timedOut = false;
    /** True once `finish()` has started; a second exit is a no-op. */
    let settled = false;
    /** The reason code for the outcome (a fixed set, never a value). */
    let reason = null;
    /** The login POST's status, or null if the POST never answered. */
    let postStatus = null;
    /** The cookie names for the no_session_cookie outcome (never values). */
    let cookieNames = null;
    /** The base hostname, for the allowlist and the landed-path check. */
    const baseHostname = new URL(baseUrl).hostname;

    /**
     * Close the browser (awaiting the close, tolerating a double close), log
     * the outcome and the blocked-request count, and resolve. Idempotent: the
     * promise settles once, and a late exit (the hard timeout racing a step
     * that rejected when the browser closed) cannot log or resolve twice.
     */
    async function finish() {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // Read the landing path before the browser is closed (it cannot be read
      // after). Never the query string or the host: the pathname only, with
      // `/user/<digits>` replaced by `/user/<uid>`, and `offsite` when the host
      // is not the base hostname.
      let landed = '-';
      if (page) {
        try {
          const url = new URL(await page.url());
          landed = url.hostname !== baseHostname
            ? 'offsite'
            : url.pathname.replace(/^\/user\/\d+/, '/user/<uid>');
        } catch {
          landed = '-';
        }
      }
      try {
        if (browser) {
          try {
            await browser.close();
          } catch {
            // Already closed (the timeout handler may have closed it first).
          }
        }
        try {
          log(
            `login: outcome=${outcome ? outcome.outcome : 'unknown'} ` +
              `reason=${reason ?? '-'} ` +
              `post=${postStatus ?? '-'} ` +
              `landed=${landed} ` +
              `blockedRequests=${blockedRequests}` +
              (reason === 'no_session_cookie' ? ` cookies=${cookieNames ?? ''}` : ''),
          );
        } catch {
          // A broken sink must not skip the resolve (or reject the exit).
        }
      } finally {
        resolve(outcome);
      }
    }

    /**
     * Stop if the call has already settled (the hard timeout fired while a
     * step was still pending). If the launch returned after the timer's
     * `finish()` ran, the timer never closed the browser — close it here.
     * @returns {Promise<boolean>} true when the caller must stop
     */
    async function stopIfSettled() {
      if (!settled) return false;
      if (browser) {
        try {
          await browser.close();
        } catch {
          // Already closed (the timer's `finish()` may have closed it first).
        }
      }
      return true;
    }

    // The hard timeout (prompt 4.6): a one-shot timer that, on fire, closes
    // the browser and resolves `timeout`. Cleared on every exit.
    timer = setTimeout(() => {
      timedOut = true;
      outcome = { outcome: 'timeout' };
      reason = 'timeout';
      void finish();
    }, timeoutMs);

    void (async () => {
      try {
        // Step 0 — pre-flight, no browser. A closed gate ends the attempt
        // without launching.
        const preFlight = await gate.check(`${baseUrl}/user/login`);
        if (await stopIfSettled()) return;
        if (!preFlight.allowed) {
          outcome = { outcome: 'gate_closed' };
          reason = 'gate_closed';
          void finish();
          return;
        }

        // Step 1 — launch. A launch failure is a browser_error.
        browser = await launchBrowser({ headless: true, args: LAUNCH_ARGS });
        if (await stopIfSettled()) return;
        const major = browser.version().split('.')[0];
        const userAgent = buildChromeUserAgent(major, platform);
        context = await browser.newContext({ ...CONTEXT_OPTIONS, userAgent });
        if (await stopIfSettled()) return;
        page = await context.newPage();
        if (await stopIfSettled()) return;

        // The request allowlist (prompt 4.5): only the base hostname (plus
        // `data:` / `blob:`) is allowed; everything else — including other
        // ozbargain subdomains — is aborted. Only a count is recorded.
        await context.route('**/*', (route) => {
          const target = route.request().url();
          let host;
          try {
            host = new URL(target).hostname;
          } catch {
            host = '';
          }
          const isDataOrBlob = target.startsWith('data:') || target.startsWith('blob:');
          if (isDataOrBlob || host === baseHostname) {
            return route.continue();
          }
          blockedRequests += 1;
          return route.abort('blockedbyclient');
        });
        if (await stopIfSettled()) return;

        // Step 2 — the login form.
        await pause(1000 + random.next() * 1500);
        if (await stopIfSettled()) return;
        const formResponse = await page.goto(`${baseUrl}/user/login`, {
          waitUntil: 'domcontentloaded',
        });
        if (await stopIfSettled()) return;
        const formStep = await classifyStep(formResponse, page);
        if (await stopIfSettled()) return;
        if (formStep.class === 'cloudflare_block' || formStep.class === 'rate_limited') {
          return endOnGateSignal(formStep, 'login_form');
        }
        if (formStep.class !== 'ok') {
          outcome = { outcome: 'transient' };
          reason = 'transient_form';
          void finish();
          return;
        }
        // Verify the login form inside the page, scoped to `#user_login`.
        // A missing form (or a page that changed shape) is form_changed.
        const formPresent = await page.evaluate(() => {
          const form = document.querySelector('form#user_login');
          if (!form) return false;
          return Boolean(
            form.querySelector('#edit-name') &&
              form.querySelector('#edit-pass') &&
              form.querySelector('input[name="edit[form_token]"]') &&
              form.querySelector("input[name='op'], button[name='op']"),
          );
        });
        if (await stopIfSettled()) return;
        if (!formPresent) {
          outcome = { outcome: 'form_changed' };
          reason = 'form_changed';
          void finish();
          return;
        }

        // Step 3 — fill and submit. `fill` only, never `type` /
        // `pressSequentially`.
        await page.locator('#user_login #edit-name').fill(username);
        if (await stopIfSettled()) return;
        await pause(300 + random.next() * 500);
        if (await stopIfSettled()) return;
        await page.locator('#user_login #edit-pass').fill(password);
        if (await stopIfSettled()) return;
        await pause(1000 + random.next() * 1000);
        if (await stopIfSettled()) return;
        const submitGate = await gate.check(`${baseUrl}/user/login`);
        if (await stopIfSettled()) return;
        if (!submitGate.allowed) {
          outcome = { outcome: 'gate_closed' };
          reason = 'gate_closed';
          void finish();
          return;
        }
        // Arm the wait for the main frame's next committed navigation before
        // the click, but outside the POST wait: a POST answer that commits no
        // new document (a 204, a download, a redirect the allowlist aborts)
        // must not hold the attempt. The `.then(ok, fail)` matters: without
        // it, a browser closed by the hard timeout rejects the armed promise
        // with nobody listening (an unhandled rejection in the web process).
        const committed = page
          .waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame(), timeout: 15_000 })
          .then(() => true, () => false);
        // The click must not wait for the navigation it triggers (`noWaitAfter`):
        // a redirect whose target never commits would otherwise hold the click
        // for Playwright's 30 s action timeout, past the 15 s commit limit.
        // The commit wait is the gate that controls that navigation.
        const [post] = await Promise.all([
          page.waitForResponse(
            (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/user/login',
          ),
          page.locator("#user_login input[name='op'], #user_login button[name='op']").first().click({ noWaitAfter: true }),
        ]);
        if (await stopIfSettled()) return;
        postStatus = post.status();
        // Only a 200/302/303 must be replaced by a new document before step 4
        // reads the page; any other status is classified at once. A 15 s
        // commit wait that resolves without a commit ends the attempt as
        // `transient`, keeping the real POST status.
        if (postStatus === 200 || postStatus === 302 || postStatus === 303) {
          const didCommit = await committed;
          if (await stopIfSettled()) return;
          if (!didCommit) {
            outcome = { outcome: 'transient' };
            reason = 'no_document';
            void finish();
            return;
          }
        }
        await page.waitForLoadState('domcontentloaded');
        if (await stopIfSettled()) return;
        const postStep = await classifyStep(post, page);
        if (await stopIfSettled()) return;
        if (postStep.class === 'cloudflare_block' || postStep.class === 'rate_limited') {
          return endOnGateSignal(postStep, 'login_submit');
        }
        if (postStep.class !== 'ok' && postStep.class !== 'redirect') {
          outcome = { outcome: 'transient' };
          reason = 'transient_submit';
          void finish();
          return;
        }

        // Step 4 — read the result, inside the page. `postStatus` was set in
        // step 3 (the closure variable, not a redeclaration).
        if (postStatus === 200) {
          // The message is reduced inside the page: only a keyword crosses
          // into Node, never the text.
          const message = await page.evaluate(() => {
            const el = document.querySelector('.messages.error');
            const text = el ? el.textContent : '';
            if (text.includes('Validation error')) return 'validation_error';
            if (text.includes('Unrecognised username or password')) return 'bad_credentials';
            if (/failed login attempts|temporarily blocked/i.test(text)) return 'flood';
            return text ? 'other' : 'none';
          });
          if (await stopIfSettled()) return;
          if (message === 'validation_error') {
            outcome = { outcome: 'validation_error' };
            reason = 'validation_error';
            void finish();
            return;
          }
          if (message === 'bad_credentials') {
            outcome = { outcome: 'bad_credentials' };
            reason = 'bad_credentials';
            void finish();
            return;
          }
          outcome = { outcome: 'login_failed' };
          reason = message === 'flood' ? 'post200_flood' : message === 'none' ? 'post200_none' : 'post200_other';
          void finish();
          return;
        }
        if (postStatus === 302 || postStatus === 303) {
          const uid = await readUidFromPage(page);
          if (await stopIfSettled()) return;
          if (!uid || uid === 0) {
            outcome = { outcome: 'login_failed' };
            reason = 'redirect_no_uid';
            void finish();
            return;
          }
          return stepFiveAndSix(uid);
        }
        // Any other status was already classified as transient above.
        outcome = { outcome: 'transient' };
        reason = 'transient_submit';
        void finish();
        return;
      } catch (err) {
        // A genuine browser failure (a launch reject, a forced exception) is a
        // browser_error. If the hard timeout fired and closed the browser, the
        // pending step rejects with a "target closed" error — the `timeout`
        // outcome is already set, so do not overwrite it. A step that timed
        // out on its own (Playwright's default `waitForResponse` timeout,
        // `err.name === 'TimeoutError'`) is a timeout, not a browser_error.
        // Never log `err.message` (a Playwright error can quote the selector
        // and the `fill` value); the name is safe.
        if (!timedOut) {
          const isTimeout = !!(err && err.name === 'TimeoutError');
          try {
            log(`login: ${isTimeout ? 'timeout' : 'browser_error'} (${err && err.name ? err.name : 'Error'})`);
          } catch {
            // A broken sink must not skip the resolve.
          }
          outcome = isTimeout ? { outcome: 'timeout' } : { outcome: 'browser_error' };
          reason = isTimeout ? 'timeout' : 'browser_error';
        }
        void finish();
      }
    })();

    /**
     * End on a gate signal (prompt 4.8, 4.10): only `cloudflare_block` and
     * `rate_limited` are fed to the gate, and only from the login surface.
     * A `cloudflare_block` also records one failures row with fixed text that
     * names the step (prompt 4.10) — no page content, no URL query.
     * @param {{ class: string, retryAfterSeconds?: number }} step
     * @param {'login_form'|'login_submit'|'classified'} stepName
     */
    async function endOnGateSignal(step, stepName) {
      if (step.class === 'cloudflare_block') {
        store.insertFailure({
          failed_at: clock.now().toISOString(),
          response_class: 'cloudflare_block',
          body: `login: Cloudflare challenge at ${stepName}`,
        });
        gate.recordResponse({ class: 'cloudflare_block', surface: 'login' });
        outcome = { outcome: 'cloudflare_block' };
        reason = 'cloudflare_block';
      } else {
        gate.recordResponse({
          class: 'rate_limited',
          surface: 'login',
          retryAfterSeconds: step.retryAfterSeconds,
        });
        outcome = { outcome: 'rate_limited' };
        reason = 'rate_limited';
      }
      await finish();
    }

    /**
     * Steps 5 and 6: the classifieds page, then the session cookie.
     * @param {number} uid the uid read in step 4
     */
    async function stepFiveAndSix(uid) {
      await pause(2000 + random.next() * 2000);
      if (await stopIfSettled()) return;
      const classifiedsGate = await gate.check(classifiedsUrl);
      if (await stopIfSettled()) return;
      if (!classifiedsGate.allowed) {
        outcome = { outcome: 'gate_closed' };
        reason = 'gate_closed';
        await finish();
        return;
      }
      const classifiedsResponse = await page.goto(classifiedsUrl, { waitUntil: 'domcontentloaded' });
      if (await stopIfSettled()) return;
      const classifiedsStep = await classifyStep(classifiedsResponse, page);
      if (await stopIfSettled()) return;
      if (classifiedsStep.class === 'cloudflare_block' || classifiedsStep.class === 'rate_limited') {
        await endOnGateSignal(classifiedsStep, 'classified');
        return;
      }
      if (classifiedsStep.class === 'permission_denied') {
        outcome = { outcome: 'not_entitled' };
        reason = 'not_entitled';
        await finish();
        return;
      }
      if (classifiedsStep.class !== 'ok') {
        outcome = { outcome: 'transient' };
        reason = 'transient_classified';
        await finish();
        return;
      }
      // The classifieds page's uid must be the one we logged in as.
      const pageUid = await readPageUid(page);
      if (await stopIfSettled()) return;
      if (pageUid === 0 || pageUid !== uid) {
        outcome = { outcome: 'login_failed' };
        reason = pageUid === 0 ? 'classified_uid_zero' : 'classified_uid_mismatch';
        await finish();
        return;
      }
      const cookies = await context.cookies(classifiedsUrl);
      if (await stopIfSettled()) return;
      const selected = selectSessionCookies(cookies, clock.now().getTime());
      if (!selected.hasSession) {
        outcome = { outcome: 'login_failed' };
        reason = 'no_session_cookie';
        cookieNames = [...selected.keptNames, ...selected.droppedNames].join(',');
        await finish();
        return;
      }
      outcome = { outcome: 'ok', cookie: selected.header, uid, expiresAt: selected.expiresAt };
      reason = 'ok';
      await finish();
    }
  });
}

/**
 * Read the uid from the page: `OzB_vars.uid` if defined and numeric, else the
 * number in `location.pathname` matching `^/user/(\d+)`, else null. Runs
 * inside the page so no page text enters Node.
 * @param {object} page the Playwright page
 * @returns {Promise<number|null>}
 */
async function readUidFromPage(page) {
  return page.evaluate(() => {
    if (typeof globalThis.OzB_vars !== 'undefined' && Number.isFinite(globalThis.OzB_vars.uid)) {
      return globalThis.OzB_vars.uid;
    }
    const match = location.pathname.match(/^\/user\/(\d+)/);
    return match ? Number(match[1]) : null;
  });
}

/**
 * Read the uid from the classifieds page (`OzB_vars.uid`), or 0 if absent.
 * Runs inside the page so no page text enters Node.
 * @param {object} page the Playwright page
 * @returns {Promise<number>}
 */
async function readPageUid(page) {
  return page.evaluate(() => {
    if (typeof globalThis.OzB_vars !== 'undefined' && Number.isFinite(globalThis.OzB_vars.uid)) {
      return globalThis.OzB_vars.uid;
    }
    return 0;
  });
}

/**
 * Classify one step of the login (prompt 4.8).
 *
 * A Cloudflare challenge is detected whatever the status: the document title
 * contains `Just a moment` (reduced in the page to a boolean), or the status
 * is 403/429/503 and the body carries a Cloudflare marker. The body is used
 * for that marker test only — a local variable that is never logged, stored,
 * or returned.
 *
 * @param {object|null} response the Playwright response (or null)
 * @param {object|null} page the Playwright page (for the title read)
 * @returns {Promise<{ class: string, retryAfterSeconds?: number }>}
 *   `class` is one of `ok`, `redirect`, `cloudflare_block`, `rate_limited`,
 *   `not_found`, `permission_denied`, `transient`.
 */
export async function classifyStep(response, page) {
  if (!response) return { class: 'transient' };
  const status = response.status();
  const headers = response.headers();

  // A challenge, whatever the status. The title check is reduced in the
  // page: only a boolean crosses into Node.
  let isChallengeTitle = false;
  if (page) {
    try {
      isChallengeTitle = await page.evaluate(() => document.title.includes('Just a moment'));
    } catch {
      isChallengeTitle = false;
    }
  }
  if (isChallengeTitle) {
    return { class: 'cloudflare_block' };
  }
  if (status === 403 || status === 429 || status === 503) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      body = '';
    }
    if (hasCloudflareMarkers(body)) {
      return { class: 'cloudflare_block' };
    }
  }

  if (status >= 300 && status < 400) return { class: 'redirect' };
  if (status === 429 || status === 503) {
    const retryAfter = headers['retry-after'];
    let retryAfterSeconds;
    if (retryAfter !== undefined) {
      const n = Number.parseInt(retryAfter, 10);
      if (!Number.isNaN(n)) retryAfterSeconds = n;
    }
    return { class: 'rate_limited', retryAfterSeconds };
  }
  return classifyResponse({ status, headers, body: undefined });
}
