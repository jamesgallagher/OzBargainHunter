/**
 * The live server and its middleware (card 5, design 8, 11.2.1-11.2.4, 11.3.6).
 *
 * Both real processes are up: the Next.js server exactly as the image runs it,
 * and `worker/main.js` polling the fixture corpus into the database the server
 * reads. The assertions are the ones that decide whether the application is
 * safe to publish a port for:
 *
 *   * an unauthenticated request is not a 200;
 *   * a request carrying a JWT signed by a locally generated key and served from
 *     a loopback JWKS is a 200, and the verified `email` claim is visible to the
 *     application — the middleware forwards it as `x-access-email`, and a
 *     state-changing route bound to that identity proves the claim is the one
 *     the application actually acts on;
 *   * a static asset with no session is not a 200;
 *   * `/healthz` is authenticated with the container-local secret, is 401
 *     without it, and reports healthy once the fixture-fed poll has succeeded;
 *   * polling is not request-driven (design 2.2): the worker fills the shared
 *     database while the application receives no request at all. That proof is
 *     captured in `before`, before this file sends the server anything.
 *
 * Point 2 is the important one for the LAN path (11.2.3): the application
 * verifies the JWT itself rather than trusting that a request came through
 * Cloudflare. Reaching the port directly and sending a valid token works; the
 * same request with no token, a token signed by another key, or a token with the
 * wrong audience does not.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { startJwksServer } from '../support/jwks.js';
import { generateCsrfToken } from '../../lib/csrf.js';
import { openTempStore, spawnWorker, stopChild, waitFor } from '../support/integration.js';
import { ensureBuild, startAppServer } from '../support/app-server.js';

const TEAM_DOMAIN = 'live.cloudflareaccess.com';
const AUD = 'live-aud';
const HEALTHCHECK_SECRET = 'live-healthcheck-secret';
const CSRF_SECRET = 'live-csrf-secret';
const EMAIL = 'james@example.com';

describe('integration: the live server and its middleware', () => {
  let fx;
  let jwks;
  let foreignJwks;
  let temp;
  let app;
  let worker;
  let unwatched;
  let token;
  let foreignToken;
  let healthz;

  before(async () => {
    fx = await startFixtureServer();
    jwks = await startJwksServer({ kid: 'live' });
    // A second key, so "signed by somebody else" can be tested for real.
    const foreign = await startJwksServer({ kid: 'live' });
    foreignJwks = foreign;
    temp = openTempStore('ozb-live-');

    const env = {
      OZB_DB_PATH: temp.dbPath,
      OZB_SNAPSHOT_PATH: join(temp.dir, 'snapshot.db'),
      OZB_HEALTHCHECK_SECRET: HEALTHCHECK_SECRET,
      OZB_CSRF_SECRET: CSRF_SECRET,
      CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      CF_ACCESS_AUD: AUD,
      CF_JWKS_URL: jwks.url,
      OZB_POLL_INTERVAL_SECONDS: '300',
    };

    await ensureBuild();
    app = await startAppServer({ env });
    worker = spawnWorker({
      ...env,
      OZB_DEALS_FEED_URL: `${fx.origin}/deals/feed`,
      OZB_FRONT_FEED_URL: `${fx.origin}/feed`,
      OZB_CLASSIFIEDS_URL: `${fx.origin}/classified`,
    });

    // Polling with nobody watching (2.2): two full cycles reach the fixture
    // server (three URLs each, 3.2) before this file has sent the application
    // a single request. Capture the evidence now, before any request below.
    await waitFor(() => fx.requests.length >= 6, {
      timeoutMs: 60_000,
      intervalMs: 100,
      what: 'two deal-poll cycles to reach the fixture server',
    }).catch((err) => {
      throw new Error(`${err.message}\nworker log:\n${worker.log()}`);
    });
    unwatched = {
      urls: fx.requests.map((r) => r.url),
      observations: temp.store.countAllObservations(),
      deals: temp.store.countDeals(),
      has975704: Boolean(temp.store.getDeal(975704)),
      lastSuccessAt: temp.store.getPollState()?.last_success_at,
    };

    token = await jwks.sign({ email: EMAIL }, { aud: AUD, iss: `https://${TEAM_DOMAIN}`, exp: '2h' });
    foreignToken = await foreign.sign({ email: EMAIL }, { aud: AUD, iss: `https://${TEAM_DOMAIN}`, exp: '2h' });

    healthz = await waitFor(async () => {
      const res = await fetch(`${app.origin}/healthz`, {
        headers: { 'x-healthcheck-secret': HEALTHCHECK_SECRET },
      });
      if (res.status !== 200) return null;
      return { status: res.status, body: await res.json() };
    }, { timeoutMs: 30_000, intervalMs: 200, what: '/healthz to report healthy after a fixture-fed poll' });
  });

  after(async () => {
    await stopChild(worker?.child);
    await app?.stop();
    temp?.close();
    await jwks.close();
    await foreignJwks.close();
    await fx.close();
  });

  describe('polling with nobody watching (2.2)', () => {
    it('gained observations from the worker alone, before any request to the application', () => {
      assert.ok(unwatched.observations >= 60, `every poll-1 deal was observed (got ${unwatched.observations})`);
      assert.ok(unwatched.deals >= 60, `the corpus deals are stored (got ${unwatched.deals})`);
      assert.ok(unwatched.has975704, '975704 is stored');
      assert.ok(unwatched.lastSuccessAt, 'the worker recorded a successful poll');
    });

    it('served the fixture server three URLs per cycle, in order, and never page 2', () => {
      assert.ok(!unwatched.urls.some((u) => u.includes('page=2')), 'the two-page cap holds');
      assert.match(unwatched.urls[0], /\/deals\/feed\?page=0$/);
      assert.match(unwatched.urls[1], /\/deals\/feed\?page=1$/);
      assert.match(unwatched.urls[2], /\/feed$/);
    });
  });

  describe('deny by default (11.2.1, 11.2.3)', () => {
    it('answers an unauthenticated request with 401, not 200', async () => {
      const res = await fetch(`${app.origin}/`);
      assert.equal(res.status, 401);
      await res.text();
    });

    it('refuses a token signed by a key the application does not trust', async () => {
      const res = await fetch(`${app.origin}/`, { headers: { 'Cf-Access-Jwt-Assertion': foreignToken } });
      assert.equal(res.status, 401, 'a valid-looking JWT from another key is not a session');
      await res.text();
    });

    it('refuses a token minted for another audience', async () => {
      const wrongAudience = await jwks.sign({ email: EMAIL }, {
        aud: 'some-other-audience',
        iss: `https://${TEAM_DOMAIN}`,
        exp: '2h',
      });
      const res = await fetch(`${app.origin}/`, { headers: { 'Cf-Access-Jwt-Assertion': wrongAudience } });
      assert.equal(res.status, 401);
      await res.text();
    });

    it('is not a 200 for a static asset with no session (11.2.4)', async () => {
      const res = await fetch(`${app.origin}/_next/static/chunks/255-37e0f0325134c4d7.js`);
      assert.notEqual(res.status, 200, 'the middleware matcher must not exempt /_next/static');
      assert.equal(res.status, 401);
      await res.text();
    });

    it('is not a 200 for the icon route while the icon exemption is off', async () => {
      const res = await fetch(`${app.origin}/icon.svg`);
      assert.equal(res.status, 401);
      await res.text();
    });
  });

  describe('a verified session (11.2.2)', () => {
    it('serves the page as a 200 for a JWT from the trusted loopback JWKS', async () => {
      const res = await fetch(`${app.origin}/`, { headers: { 'Cf-Access-Jwt-Assertion': token } });
      assert.equal(res.status, 200);
      await res.text();
    });

    it('carries the verified email claim through to the application', async () => {
      const res = await fetch(`${app.origin}/`, { headers: { 'Cf-Access-Jwt-Assertion': token } });
      assert.equal(res.headers.get('x-access-email'), EMAIL, 'the verified claim is the identity the app acts on');
      await res.text();
    });

    it('accepts the Access cookie as well as the header', async () => {
      const res = await fetch(`${app.origin}/`, { headers: { Cookie: `CF_Authorization=${token}` } });
      assert.equal(res.status, 200);
      await res.text();
    });
  });

  describe('/healthz reports acquisition health (3.7, D62)', () => {
    it('is 401 without the container-local secret', async () => {
      const res = await fetch(`${app.origin}/healthz`);
      assert.equal(res.status, 401, 'a LAN request with no secret is rejected like any other');
      await res.text();
    });

    it('is 401 with the wrong secret', async () => {
      const res = await fetch(`${app.origin}/healthz`, { headers: { 'x-healthcheck-secret': 'nope' } });
      assert.equal(res.status, 401);
      await res.text();
    });

    it('reports healthy once the fixture-fed poll has succeeded', () => {
      assert.equal(healthz.status, 200);
      assert.equal(healthz.body.status, 'healthy');
      assert.ok(healthz.body.last_success_at, 'the poll the worker made is what it reports on');
    });
  });

  describe('CSRF on a state-changing route (8.6, 11.3.6)', () => {
    it('rejects an authenticated POST with no CSRF token, and changes nothing', async () => {
      const before = temp.store.getSetting('always_notify_freebie');
      const res = await fetch(`${app.origin}/thresholds/freebie`, {
        method: 'POST',
        headers: {
          'Cf-Access-Jwt-Assertion': token,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'freebie=on',
      });
      assert.equal(res.status, 403, 'a valid JWT with no CSRF token still fails');
      await res.text();
      assert.equal(temp.store.getSetting('always_notify_freebie'), before, 'the setting is unchanged');
    });

    it('rejects an unauthenticated POST before the CSRF check is even reached', async () => {
      const csrf = await generateCsrfToken(CSRF_SECRET);
      const res = await fetch(`${app.origin}/thresholds/freebie`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `freebie=on&csrf_token=${encodeURIComponent(csrf)}`,
      });
      assert.equal(res.status, 401, 'deny-by-default survives the UI');
      await res.text();
    });

    it('accepts the POST when both checks pass, and writes the setting', async () => {
      const csrf = await generateCsrfToken(CSRF_SECRET);
      const res = await fetch(`${app.origin}/thresholds/freebie`, {
        method: 'POST',
        headers: {
          'Cf-Access-Jwt-Assertion': token,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: `freebie=on&csrf_token=${encodeURIComponent(csrf)}`,
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.freebie, true);
      assert.equal(temp.store.getSetting('always_notify_freebie'), '1', 'the write is visible on the shared database');
    });

    it('rejects a POST whose CSRF token was minted under another secret', async () => {
      const csrf = await generateCsrfToken('not-the-server-secret');
      const res = await fetch(`${app.origin}/thresholds/freebie`, {
        method: 'POST',
        headers: {
          'Cf-Access-Jwt-Assertion': token,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: `freebie=on&csrf_token=${encodeURIComponent(csrf)}`,
      });
      assert.equal(res.status, 403);
      await res.text();
    });
  });

  describe('the two processes share one database', () => {
    it('the UI reads the rows the worker wrote', async () => {
      assert.ok(temp.store.countAllObservations() > 0, 'the worker polled into the shared database');
      // The rules page is rendered from that same database, under a session.
      const res = await fetch(`${app.origin}/rules`, { headers: { 'Cf-Access-Jwt-Assertion': token } });
      assert.equal(res.status, 200);
      await res.text();
    });

    it('does not report a liveness-only health', () => {
      // A worker that had died would leave /healthz 503 within three intervals;
      // the child is asserted alive here so the healthy reading above cannot be
      // explained by a stale poll_state.
      assert.equal(worker.child.exitCode, null, `the worker is alive; log:\n${worker.log()}`);
    });
  });
});
