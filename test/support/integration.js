/**
 * The integration harness (card 5). Everything here is scaffolding for
 * `test/integration/`: a temporary database, the fixture server over real HTTP,
 * the *real* transport and HTTP client, the rules engine, the compositor and
 * fan-out with a capturing provider.
 *
 * Nothing here is a stub of the application's own logic. The three-poll
 * scenario runs the same `runDealPoll` → `evaluatePoll` → `groupAndCompose` →
 * `fanout` chain the worker runs, over a real socket to the fixture server, so
 * the conditional-request handling, the response classification and the store
 * writes are all the production ones.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../lib/store/index.js';
import { createOzbClient } from '../../lib/http/client.js';
import { createHttpTransport } from '../../lib/http/transport.js';
import { fixedClock } from '../../lib/clock.js';
import { seededRandom } from '../../lib/random.js';
import { runDealPoll } from '../../lib/acquire/poll.js';
import { runClassifiedsPoll } from '../../lib/acquire/classifieds.js';
import { evaluatePoll } from '../../lib/rules/engine.js';
import { groupAndCompose } from '../../lib/notify/compose.js';
import { fanout } from '../../lib/notify/fanout.js';
import { makeProvider } from '../../lib/notify/provider.js';
import { FREEBIE_SETTING_KEY } from '../../lib/notify/freebie.js';

/** The corpus poll instants (`fixtures/README.md` §1). */
export const POLL_1_AT = '2026-09-19T07:30:00Z';
export const POLL_2_AT = '2026-09-19T08:05:00Z';
export const POLL_3_AT = '2026-09-19T08:10:00Z';

export { FREEBIE_SETTING_KEY };

/**
 * Open a store on a temporary database. The caller closes it (the temp
 * directory is removed by `close`).
 * @param {string} [prefix] the temp directory prefix
 * @returns {{ store: object, dir: string, dbPath: string, close: () => void }}
 */
export function openTempStore(prefix = 'ozb-integration-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, 'ozbargain.db');
  const store = openStore({ path: dbPath, clock: fixedClock(POLL_1_AT) });
  return {
    store,
    dir,
    dbPath,
    close: () => {
      try {
        store.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Insert rules. Every rule is enabled, deals-only, with the 24-hour default
 * cooldown, unless the spec overrides it — matching what the UI writes.
 * @param {object} store
 * @param {object[]} specs `{ id, type, parameters, ...overrides }`
 * @returns {object[]} the specs, for readability at the call site
 */
export function insertRules(store, specs) {
  for (const spec of specs) {
    store.insertRule({
      id: spec.id,
      type: spec.type,
      parameters: JSON.stringify(spec.parameters ?? {}),
      state: spec.state ?? 'enabled',
      surfaces: spec.surfaces ?? 'deals',
      cooldown_seconds: spec.cooldown_seconds ?? 86400,
      pinned_slug: spec.pinned_slug ?? null,
      created_at: spec.created_at ?? POLL_1_AT,
      modified_at: spec.modified_at ?? POLL_1_AT,
    });
  }
  return specs;
}

/**
 * The rule set the card names: a match rule on `ubiquiti`, a match rule on
 * `torbox`, a threshold rule at 20 upvotes, and the freebie setting on.
 * @param {object} store
 * @returns {{ ubiquiti: number, torbox: number, threshold20: number }}
 */
export function configureCardRules(store) {
  insertRules(store, [
    { id: 1, type: 'match', parameters: { term: 'ubiquiti' } },
    { id: 2, type: 'match', parameters: { term: 'torbox' } },
    { id: 3, type: 'threshold', parameters: { threshold: 20 } },
  ]);
  // "Always notify on freebie" defaults on; set it explicitly so the scenario
  // is pinned rather than relying on the default (6.6/9.2).
  store.setSetting(FREEBIE_SETTING_KEY, '1');
  return { ubiquiti: 1, torbox: 2, threshold20: 3 };
}

/**
 * A capturing provider. It is *selected* in the store (fan-out reads the
 * selected providers from there) and records every notification it is sent.
 * @param {string} [kind]
 * @returns {{ kind: string, notifications: object[], provider: object }}
 */
export function createCaptureProvider(kind = 'capture') {
  const notifications = [];
  const provider = makeProvider(kind, (notification) => {
    notifications.push(notification);
  });
  return { kind, notifications, provider };
}

/** Register a capturing provider as the store's selected provider. */
export function registerProvider(store, { kind, provider }) {
  void provider;
  store.upsertProvider(kind, '{}', 1);
}

/**
 * Run one classifieds poll cycle end to end: fetch the classifieds URL through
 * the real transport over a real socket, with the real HTTP client (so the
 * conditional requests and the validator cache are real) and the real store on
 * a temporary database. The classifieds URL comes from `config` (the fixture
 * server's `OZB_CLASSIFIEDS_URL`).
 *
 * Each cycle gets its own `fixedClock` pinned at the poll instant, because the
 * client takes its inter-request pause from the clock.
 *
 * @param {object} args
 * @param {object} args.store
 * @param {object} args.config the config the classifieds URL comes from
 * @param {string} args.pollAt the poll instant
 * @param {(line: string) => void} [args.log]
 * @returns {Promise<object>} the `runClassifiedsPoll` result
 */
export async function runClassifiedsCycle({ store, config, pollAt, log = () => {} }) {
  const fetchClock = fixedClock(pollAt);
  const client = createOzbClient({
    transport: createHttpTransport({ userAgent: 'ozbargain-hunter-integration-test' }),
    store,
    clock: fetchClock,
    random: seededRandom(1),
    config,
    log,
  });
  return runClassifiedsPoll({ client, store, clock: fetchClock, config, log });
}

/**
 * Run one deal poll cycle end to end: fetch the three URLs through the real
 * transport, upsert and observe, evaluate the rules, compose and fan out.
 *
 * Each cycle gets its own `fixedClock` pinned at the poll instant, because the
 * client takes its inter-request pause from the clock: a fresh clock keeps the
 * cycle anchored at the corpus instant instead of drifting with the pause.
 *
 * @param {object} args
 * @param {object} args.store
 * @param {object} args.config the config the URLs come from (the fixture server's)
 * @param {string} args.pollAt the corpus poll instant
 * @param {{ kind: string, provider: object, notifications: object[] }} args.capture
 * @param {boolean} [args.coldStart] pin the cold-start decision instead of
 *   deriving it from the store. The worker derives it (`countDeals() === 0 &&
 *   countAllObservations() === 0`, captured before the poll upserts anything);
 *   a test passes `false` to exercise the same feeds against an *established*
 *   database, which is the only way to observe a match rule's first alert for
 *   a deal that is already in the feeds at poll 1.
 * @param {(line: string) => void} [args.log]
 * @returns {Promise<{ poll: object, evaluation: object|null, notifications: object[], coldStart: boolean }>}
 */
export async function runPollCycle({ store, config, pollAt, capture, coldStart, log = () => {} }) {
  // Cold start is decided *before* the poll upserts the deals (the worker does
  // the same: `worker/main.js` dealPollTask).
  const isColdStart = coldStart ?? (store.countDeals() === 0 && store.countAllObservations() === 0);

  const fetchClock = fixedClock(pollAt);
  const client = createOzbClient({
    transport: createHttpTransport({ userAgent: 'ozbargain-hunter-integration-test' }),
    store,
    clock: fetchClock,
    random: seededRandom(1),
    config,
    log,
  });

  const poll = await runDealPoll({ client, store, clock: fetchClock, config, log });
  // The cycle's own instant, exactly as the worker uses it: the poller stamped
  // its observations with it, so the engine must evaluate at the same instant
  // or its upsert would append a second observation row for the same poll.
  const cyclePollAt = poll.pollAt ?? pollAt;

  let evaluation = null;
  const notifications = [];
  if (poll.feeds.length > 0) {
    evaluation = evaluatePoll({
      feeds: poll.feeds,
      store,
      clock: fixedClock(cyclePollAt),
      pollAt: cyclePollAt,
      coldStart: isColdStart,
      gapMs: null,
      log,
    });
    if (evaluation.alerts.length > 0) {
      const composed = groupAndCompose(evaluation.alerts);
      await fanout({
        notifications: composed,
        providers: [capture.provider],
        store,
        clock: fixedClock(cyclePollAt),
      });
      notifications.push(...composed);
    }
  }
  return { poll, evaluation, notifications, coldStart };
}

/**
 * Run the whole three-poll corpus scenario.
 * @param {object} args
 * @param {object} args.store
 * @param {object} args.config
 * @param {{ kind: string, provider: object, notifications: object[] }} args.capture
 * @param {string[]} [args.pollInstants]
 * @param {(line: string) => void} [args.log]
 * @returns {Promise<object[]>} one entry per cycle
 */
export async function runThreePolls({
  store,
  config,
  capture,
  pollInstants = [POLL_1_AT, POLL_2_AT, POLL_3_AT],
  log = () => {},
}) {
  const cycles = [];
  for (const pollAt of pollInstants) {
    cycles.push(await runPollCycle({ store, config, pollAt, capture, log }));
  }
  return cycles;
}

/**
 * Poll `probe` until it returns a truthy value or the timeout expires.
 * @param {() => unknown | Promise<unknown>} probe
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.intervalMs]
 * @param {string} [options.what] what we waited for (the error message)
 * @returns {Promise<unknown>}
 */
export async function waitFor(probe, { timeoutMs = 120_000, intervalMs = 250, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what} (last value: ${JSON.stringify(last)})`);
}

/**
 * Wait for an exit, with a timeout, for a spawned child.
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} [timeoutMs]
 * @returns {Promise<{ code: number|null, signal: string|null }>}
 */
export function waitForExit(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the child to exit')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/**
 * Kill a child process tree (SIGTERM, then SIGKILL after a grace period).
 * @param {import('node:child_process').ChildProcess|null} child
 */
export async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child, 5000).catch(() => null);
  child.kill('SIGTERM');
  const first = await exited;
  if (first) return;
  child.kill('SIGKILL');
  await waitForExit(child, 5000).catch(() => null);
}
