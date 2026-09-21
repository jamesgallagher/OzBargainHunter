#!/usr/bin/env node
/**
 * The image smoke test (card 5, design 10.4 job 4).
 *
 * It runs the **built image** for real: the fixture server serves the captured
 * corpus on loopback, the container is pointed at it, and the container's own
 * health check must go healthy before anything else is asserted.
 *
 * Why the order of the assertions matters:
 *
 * 1. **The container's own health check must go healthy.** `/healthz` reports
 *    *unhealthy* until a poll has succeeded (design 3.7), so a "healthy"
 *    container is proof that the poller inside the image reached the feed,
 *    parsed it and committed it — through the image's own HTTP client, not a
 *    stub.
 * 2. **Only then is any request made to the application**, and the first thing
 *    asserted is that the database *gained observations*. Nothing has talked to
 *    the UI yet, so those rows can only have come from the worker's own
 *    schedule: polling is not request-driven (2.2).
 * 3. Then the access control: without a session the application is not a 200,
 *    with a properly signed Access JWT it is, and a static asset with no
 *    session is not a 200 either (11.2.1-11.2.4).
 *
 * The smoke test never touches `ozbargain.com.au`, and it could not pass if it
 * did: with no reachable feed the health check would never go healthy.
 *
 * Docker is required, and on Linux `--network host` is used so the container can
 * reach the fixture server and the JWKS server on the host's loopback. When
 * Docker (or the image) is absent the script prints SKIP and exits 0 — that path
 * exists for a developer without Docker; CI always has both.
 *
 * Usage:
 *   OZB_SMOKE_IMAGE=ozbargainhunter:ci node scripts/smoke-image.mjs
 *   node scripts/smoke-image.mjs ozbargainhunter:local
 */

import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { startFixtureServer } from './fixture-server.mjs';
import { createSmokeDataDir } from './smoke-data-dir.mjs';
import { startJwksServer } from '../test/support/jwks.js';

const run = promisify(execFile);

/** The image under test: `OZB_SMOKE_IMAGE`, or an argument, or a local default. */
const IMAGE = process.env.OZB_SMOKE_IMAGE ?? process.argv[2] ?? 'ozbargainhunter:smoke';

/**
 * The poll interval the container is given. 300 s is the production floor
 * (`MIN_POLL_INTERVAL_SECONDS`), so this is the interval the smoke test must
 * tolerate — it cannot be shortened, and the image under test is the
 * production image.
 */
const POLL_INTERVAL_SECONDS = 300;

/** Slack on top of the poll interval: the poll cycle's three paced requests,
 *  the commit, and Docker's own 30 s health-check beat. */
const HEALTH_TIMEOUT_SLACK_SECONDS = 120;

/**
 * How long the container's health check may take to go healthy.
 *
 * This has to cover **one whole poll interval**, because the worker's
 * schedulers start with `runImmediately: false` (`lib/scheduler.js`): the first
 * deal-poll beat is due one interval after the worker starts, not immediately.
 * /healthz stays 503 until that first poll has committed (design 3.7), so a
 * window shorter than the interval can never see a healthy container even when
 * everything works.
 *
 * The original 180 s window was shorter than the 300 s interval: on run
 * 35610785899 it spent the full 180 s polling the health of a container that
 * had already been down for 179 of them, and would have failed the same way on
 * a healthy container.
 */
const HEALTH_TIMEOUT_MS = (POLL_INTERVAL_SECONDS + HEALTH_TIMEOUT_SLACK_SECONDS) * 1000;

const TEAM_DOMAIN = 'smoke.cloudflareaccess.com';
const AUD = 'smoke-aud';
const HEALTHCHECK_SECRET = 'smoke-healthcheck-secret';
const CSRF_SECRET = 'smoke-csrf-secret';
const CONTAINER_NAME = `ozbargainhunter-smoke-${process.pid}`;

/** `docker …` with the container name appended. */
const docker = (...args) => run('docker', args);

function skip(reason) {
  console.log(`SKIP  ${reason}`);
  console.log('SKIP  the smoke test needs a reachable Docker daemon and a built image; CI always provides both.');
  process.exit(0);
}

async function dockerAvailable() {
  try {
    await docker('info');
    return true;
  } catch {
    return false;
  }
}

async function imagePresent(image) {
  try {
    await docker('image', 'inspect', image);
    return true;
  } catch {
    return false;
  }
}

/** The container's health status, as Docker itself reports it. */
async function healthStatus() {
  const { stdout } = await docker('inspect', '--format', '{{.State.Health.Status}}', CONTAINER_NAME);
  return stdout.trim();
}

/** Count the observation rows by asking the container's own node to open the database. */
async function countObservations() {
  const script = [
    "const { DatabaseSync } = require('node:sqlite');",
    "const db = new DatabaseSync(process.env.OZB_DB_PATH || '/data/ozbargain.db');",
    "const row = db.prepare('SELECT COUNT(*) AS n FROM observations').get();",
    'console.log(row.n);',
  ].join(' ');
  const { stdout } = await docker('exec', CONTAINER_NAME, 'node', '-e', script);
  return Number.parseInt(stdout.trim(), 10);
}

async function containerLogs() {
  try {
    const { stdout, stderr } = await docker('logs', '--tail', '60', CONTAINER_NAME);
    return `${stdout}\n${stderr}`;
  } catch {
    return '(no logs available)';
  }
}

/** Fail the run with the container's own log attached. */
async function fail(message) {
  console.error(`FAIL  ${message}`);
  console.error('--- container logs ---');
  console.error(await containerLogs());
  process.exit(1);
}

async function main() {
  if (!(await dockerAvailable())) skip('docker is not available on this machine.');
  if (!(await imagePresent(IMAGE))) skip(`the image ${IMAGE} is not present locally (build it first).`);

  const fixture = await startFixtureServer();
  const jwks = await startJwksServer({ kid: 'smoke' });
  const dataDir = createSmokeDataDir();
  let containerStarted = false;

  try {
    const token = await jwks.sign(
      { email: 'smoke@example.com' },
      { aud: AUD, iss: `https://${TEAM_DOMAIN}`, exp: '2h' },
    );

    const env = {
      ...fixture.appConfig(),
      OZB_DB_PATH: '/data/ozbargain.db',
      OZB_SNAPSHOT_PATH: '/data/ozbargain-snapshot.db',
      // The production floor is five minutes. The scheduler's first beat is one
      // interval in, so the container's first poll lands ~300 s after the worker
      // starts: HEALTH_TIMEOUT_MS above is derived from this same constant, so
      // the wait and the interval cannot drift apart.
      OZB_POLL_INTERVAL_SECONDS: String(POLL_INTERVAL_SECONDS),
      OZB_CLASSIFIEDS_INTERVAL_SECONDS: '3600',
      OZB_HEALTHCHECK_SECRET: HEALTHCHECK_SECRET,
      OZB_CSRF_SECRET: CSRF_SECRET,
      CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      CF_ACCESS_AUD: AUD,
      CF_JWKS_URL: jwks.url,
      OZB_USER_AGENT: 'ozbargain-hunter-smoke-test',
    };

    const args = ['run', '-d', '--name', CONTAINER_NAME,
      // Host networking so the container's 127.0.0.1 is the host's: the fixture
      // server and the JWKS server both bind loopback only (10.4).
      '--network', 'host',
      '-v', `${dataDir}:/data`,
    ];
    for (const [key, value] of Object.entries(env)) {
      args.push('-e', `${key}=${value}`);
    }
    args.push(IMAGE);

    let stdout;
    try {
      ({ stdout } = await docker(...args));
    } catch (err) {
      await fail(`docker run failed: ${err.stderr || err.message}`);
    }
    containerStarted = true;
    console.log(`smoke: started ${IMAGE} as ${CONTAINER_NAME} (${stdout.trim().slice(0, 12)})`);

    // 1. The container's own health check must go healthy. This is a request the
    //    *image* makes to itself with the container-local secret; the script
    //    does not touch the application to decide this.
    let status = '';
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      status = await healthStatus().catch(() => '');
      if (status === 'healthy') break;
      if (status === 'unhealthy') {
        // It reports unhealthy until a poll has succeeded, so keep waiting
        // rather than failing on the first unhealthy reading.
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (status !== 'healthy') {
      await fail(`the container never reported healthy within ${HEALTH_TIMEOUT_MS / 1000}s (last: ${status || 'none'})`);
    }
    console.log('smoke: the container health check reports healthy — a poll succeeded through the fixture feed');

    // 2. No request has been made to the application yet. This is the assertion
    //    that matters most: the rows exist although nothing has visited the UI.
    const observations = await countObservations();
    const fixtureRequests = fixture.requests.length;
    if (!(observations > 0)) {
      await fail(`the database gained no observations although the poll succeeded (got ${observations})`);
    }
    if (!(fixtureRequests >= 3)) {
      await fail(`the fixture server served ${fixtureRequests} requests; a cycle is three URLs`);
    }
    console.log(`smoke: ${observations} observations in the database with no request made to the application`);
    console.log(`smoke: the fixture server served ${fixtureRequests} poll requests`);

    // 3. Access control, through the published port on loopback.
    const base = 'http://127.0.0.1:8000';
    const unauthenticated = await fetch(`${base}/`);
    if (unauthenticated.status === 200) {
      await fail('an unauthenticated request to / was answered 200 (11.2.3)');
    }
    console.log(`smoke: an unauthenticated request is not a 200 (${unauthenticated.status})`);

    const authenticated = await fetch(`${base}/`, { headers: { 'Cf-Access-Jwt-Assertion': token } });
    if (authenticated.status !== 200) {
      await fail(`a request with a valid Access JWT was answered ${authenticated.status} (11.2.2)`);
    }
    console.log(`smoke: a properly signed request is a 200 (email claim: ${authenticated.headers.get('x-access-email')})`);
    await authenticated.text();

    const staticRes = await fetch(`${base}/_next/static/chunks/255-37e0f0325134c4d7.js`);
    if (staticRes.status === 200) {
      await fail('a static asset with no session was answered 200 (11.2.4)');
    }
    console.log(`smoke: a static asset with no session is not a 200 (${staticRes.status})`);
    await staticRes.text();

    console.log(`PASS  ${IMAGE}: healthy, ${observations} observations before any request, access control holds`);
  } finally {
    if (containerStarted) {
      await docker('rm', '-f', CONTAINER_NAME).catch(() => {});
    }
    await fixture.close();
    await jwks.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
