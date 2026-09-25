/**
 * The worker process (design 2.2). It is the composition root: it opens the
 * shared store, builds the transport, the HTTP client, the rules engine and
 * the providers from config, and registers the four scheduled jobs. It binds
 * no port.
 *
 * The four jobs:
 *   - the **deal poll** every `OZB_POLL_INTERVAL_SECONDS` (default 300);
 *   - the **classifieds poll** every `OZB_CLASSIFIEDS_INTERVAL_SECONDS`
 *     (default 3600);
 *   - the **dead-man's-switch check** (3.7), which sends a notification when
 *     one is due;
 *   - a **nightly** job running `pruneObservations` and `writeSnapshot`
 *     (4.2, 4.3).
 *
 * `SIGTERM` and `SIGINT` stop the schedulers, let an in-flight tick finish,
 * close the database and exit 0. An unrecoverable error exits non-zero —
 * card 5's entrypoint then takes the container down, because a container
 * with a dead poller and a live UI looks exactly like a quiet day.
 *
 * `startWorker` accepts injectable deps so a test can drive it against a
 * temporary database and a fixture transport with no network and no real
 * providers. The module entry (below) builds the real transport and providers
 * from config and calls it.
 */

import { loadConfig } from '../lib/config.js';
import { openStore } from '../lib/store/index.js';
import { createHttpTransport } from '../lib/http/transport.js';
import { createDevMockTransport, isDevMockTransport } from '../lib/http/mock-transport.js';
import { createOzbClient } from '../lib/http/client.js';
import { systemRandom } from '../lib/random.js';
import { systemClock } from '../lib/clock.js';
import { createScheduler } from '../lib/scheduler.js';
import { runDealPoll } from '../lib/acquire/poll.js';
import { runClassifiedsPoll } from '../lib/acquire/classifieds.js';
import { deadManState } from '../lib/acquire/deadman.js';
import { sendDeadman } from '../lib/notify/deadman.js';
import { evaluatePoll } from '../lib/rules/engine.js';
import { groupAndCompose } from '../lib/notify/compose.js';
import { fanout } from '../lib/notify/fanout.js';

/**
 * The dead-man's-switch state, persisted in `settings` so the worker's
 * decaying schedule survives a restart (3.7). The key holds a JSON object
 * `{ lastNotificationAt, step }`.
 */
const DEADMAN_STATE_KEY = 'deadman_state';

/** The hour (0-23) the nightly job runs at. Default 3 a.m. */
const NIGHTLY_HOUR = 3;

/** How often the dead-man's-switch is checked. 60 s: fine-grained enough
 *  that the 30-minute first step is not missed by more than a minute. */
const DEADMAN_CHECK_MS = 60 * 1000;

/** How often the nightly job's scheduler wakes to check the hour. 1 h. */
const NIGHTLY_CHECK_MS = 60 * 60 * 1000;

/**
 * Read the dead-man's-switch state from the store.
 * @param {object} store the store
 * @returns {{ lastNotificationAt: string|null, step: string }}
 */
function readDeadmanState(store) {
  const raw = store.getSetting(DEADMAN_STATE_KEY);
  if (!raw) return { lastNotificationAt: null, step: 'none' };
  try {
    const parsed = JSON.parse(raw);
    return {
      lastNotificationAt: parsed.lastNotificationAt ?? null,
      step: parsed.step ?? 'none',
    };
  } catch {
    return { lastNotificationAt: null, step: 'none' };
  }
}

/**
 * Write the dead-man's-switch state to the store.
 * @param {object} store the store
 * @param {{ lastNotificationAt: string|null, step: string }} state
 */
function writeDeadmanState(store, state) {
  store.setSetting(DEADMAN_STATE_KEY, JSON.stringify(state));
}

/**
 * Build the real providers from the store's selected provider rows. Each
 * provider's transport is built from config; a provider that is not selected
 * or is disabled is not returned (fanout re-checks, but we only build the
 * selected ones).
 * @param {object} store the store
 * @param {object} config the config
 * @param {(kind: string, client: object) => object} providerFactories a map of
 *   provider kind to its factory (injected so a test can substitute fakes)
 * @returns {object[]} the selected providers
 */
function buildProviders(store, config, providerFactories) {
  const rows = store.getProviders();
  const selected = rows.filter((row) => row.selected && row.enabled);
  return selected.map((row) => {
    const factory = providerFactories[row.kind];
    if (!factory) return null;
    return factory(row, config);
  }).filter(Boolean);
}

/**
 * Start the worker.
 * @param {object} deps
 * @param {object} deps.store an already-open store (the caller closes it)
 * @param {object} deps.transport the transport (real or fixture)
 * @param {object} deps.clock the clock (real or fixed)
 * @param {object} deps.random the random source
 * @param {object} deps.config the config
 * @param {object[]} [deps.providers] the providers to fan out through (built
 *   by the caller; defaults to building them from the store)
 * @param {object} [deps.providerFactories] provider kind to factory (used when
 *   `providers` is not supplied)
 * @param {(line: string) => void} [deps.log] log sink
 * @returns {Promise<{ stop(): Promise<void>, store: object, schedulers: object[] }>}
 *   `stop` stops the schedulers and resolves once an in-flight tick settles;
 *   the caller closes `store` and exits.
 */
export async function startWorker({
  store,
  transport,
  clock,
  random,
  config,
  providers,
  providerFactories,
  log = console.log,
}) {
  const client = createOzbClient({ transport, store, clock, random, config, log });
  const selectedProviders = providers ?? buildProviders(store, config, providerFactories ?? {});

  // The last poll instant, for gap detection (6.3). A gap over two hours
  // suppresses threshold rules for one cycle.
  let lastPollAtMs = null;
  // The last successful poll instant, for the dead-man's switch.
  let lastSuccessAt = null;

  const nowIso = () => clock.now().toISOString();

  /**
   * Run the rules engine over a set of feeds and fan out the resulting
   * notifications. Shared by the deal and classifieds polls.
   * @param {object[]} feeds the feeds
   * @param {string} pollAt the poll instant
   * @param {boolean} coldStart whether this is the first poll from an empty
   *   database (seeds silently, zero notifications)
   * @param {number|null} gapMs the gap since the last poll, or null
   */
  async function evaluateAndFanout(feeds, pollAt, coldStart, gapMs) {
    const out = evaluatePoll({ feeds, store, clock, pollAt, coldStart, gapMs, log });
    if (out.alerts.length > 0) {
      const notifications = groupAndCompose(out.alerts);
      await fanout({ notifications, providers: selectedProviders, store, clock });
    }
    return out;
  }

  /**
   * The deal-poll task: fetch the three URLs, evaluate the rules, fan out.
   */
  async function dealPollTask() {
    // Cold start: the first poll from an empty database seeds silently.
    // Must be captured *before* runDealPoll upserts the deals, otherwise the
    // count is already non-zero and the first poll would alert instead of
    // seeding (acceptance 11.4.5).
    const wasEmpty = store.countDeals() === 0 && store.countAllObservations() === 0;
    const result = await runDealPoll({ client, store, clock, config, log });
    // The cycle's observation instant, not "now": the poller stamped its
    // observations with it, and the engine must evaluate the feeds at the same
    // instant so its own upsert of those records lands on the same
    // (deal_id, observed_at) key instead of appending a second row (design
    // 4.1, one row per deal per poll).
    const pollAt = result.pollAt ?? nowIso();
    // Gap detection: the gap since the last poll, in ms.
    let gapMs = null;
    if (lastPollAtMs !== null) {
      const gap = Date.parse(pollAt) - lastPollAtMs;
      if (gap > 2 * 60 * 60 * 1000) gapMs = gap;
    }
    lastPollAtMs = Date.parse(pollAt);
    await evaluateAndFanout(result.feeds, pollAt, wasEmpty, gapMs);
  }

  /**
   * The classifieds-poll task: fetch the classifieds page, evaluate the
   * freebies, fan out.
   */
  async function classifiedsPollTask() {
    const wasEmpty = store.countDeals() === 0 && store.countAllObservations() === 0;
    const result = await runClassifiedsPoll({ client, store, clock, config, log });
    if (result.listings.length > 0) {
      const pollAt = nowIso();
      await evaluateAndFanout([{ surface: 'classifieds', records: result.listings }], pollAt, wasEmpty, null);
    }
  }

  /**
   * The dead-man's-switch check: read the last successful poll, decide if a
   * notification is due, and send it when it is.
   */
  async function deadmanCheckTask() {
    const pollState = store.getPollState() ?? {};
    const lastSuccess = pollState.last_success_at ?? null;
    const state = readDeadmanState(store);
    const now = nowIso();
    const dm = deadManState({ lastSuccessAt: lastSuccess, now, lastNotificationAt: state.lastNotificationAt, step: state.step });
    if (dm.due) {
      await sendDeadman({ deadmanState: dm, providers: selectedProviders, store, clock });
      // Record the notification so the decaying schedule advances.
      const nextStep = dm.step === '30min' ? '2h' : dm.step === '2h' ? '6h' : 'daily';
      writeDeadmanState(store, { lastNotificationAt: now, step: nextStep });
    }
  }

  /**
   * The nightly job: prune observations older than seven days and write a
   * snapshot. Runs when the clock's hour matches NIGHTLY_HOUR.
   */
  async function nightlyTask() {
    const hour = clock.now().getUTCHours();
    if (hour !== NIGHTLY_HOUR) return;
    const now = clock.now();
    const pruned = store.pruneObservations(now);
    store.writeSnapshot(config.OZB_SNAPSHOT_PATH);
    log(`nightly: pruned ${pruned} observations, snapshot written`);
  }

  const dealScheduler = createScheduler({
    clock,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    intervalMs: config.OZB_POLL_INTERVAL_SECONDS * 1000,
    task: dealPollTask,
    log,
  });
  const classifiedsScheduler = createScheduler({
    clock,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    intervalMs: config.OZB_CLASSIFIEDS_INTERVAL_SECONDS * 1000,
    task: classifiedsPollTask,
    log,
  });
  const deadmanScheduler = createScheduler({
    clock,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    intervalMs: DEADMAN_CHECK_MS,
    task: deadmanCheckTask,
    log,
  });
  const nightlyScheduler = createScheduler({
    clock,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    intervalMs: NIGHTLY_CHECK_MS,
    task: nightlyTask,
    log,
  });

  const schedulers = [dealScheduler, classifiedsScheduler, deadmanScheduler, nightlyScheduler];
  for (const s of schedulers) s.start();

  async function stop() {
    for (const s of schedulers) await s.stop();
  }

  // The task functions are exposed so a test can drive a single job without
  // waiting on a real timer. In production the schedulers drive them.
  return { stop, store, schedulers, tasks: { dealPoll: dealPollTask, classifiedsPoll: classifiedsPollTask, deadmanCheck: deadmanCheckTask, nightly: nightlyTask } };
}

/**
 * Install the SIGTERM/SIGINT handlers: stop the schedulers, close the store
 * and exit 0 (exit 1 if shutdown itself fails). A second signal while
 * shutting down is ignored. `proc`, `exit` and the log sinks are injectable so
 * the handler is tested in-process with a fake process object — a real OS
 * signal cannot be delivered gracefully on every platform (Windows has no
 * SIGTERM), and spawning a real worker to signal it would need the network
 * guard and fixtures just to exercise these few lines.
 * @param {{
 *   worker: { stop(): Promise<void> },
 *   store: { close(): void },
 *   proc?: { on(event: string, fn: () => void): void },
 *   exit?: (code: number) => void,
 *   log?: (line: string) => void,
 *   logError?: (line: string) => void,
 * }} deps
 * @returns {(signal: string) => Promise<void>} the shutdown function
 */
export function installShutdown({
  worker,
  store,
  proc = process,
  exit = (code) => process.exit(code),
  log = console.log,
  logError = console.error,
}) {
  // A repeated signal returns the shutdown already in flight.
  let inFlight = null;
  const shutdown = (signal) => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      log(`${signal}: stopping worker`);
      try {
        await worker.stop();
        store.close();
        log('worker stopped cleanly, database closed');
        exit(0);
      } catch (err) {
        logError(`shutdown error: ${err?.message ?? err}`);
        exit(1);
      }
    })();
    return inFlight;
  };
  proc.on('SIGTERM', () => shutdown('SIGTERM'));
  proc.on('SIGINT', () => shutdown('SIGINT'));
  return shutdown;
}

/**
 * The module entry: build the real transport, providers and config from the
 * environment, open the store, and run the worker. Handles SIGTERM/SIGINT by
 * stopping the schedulers, closing the store and exiting 0. Exits non-zero on
 * an unrecoverable error.
 */
async function main() {
  const config = loadConfig();
  const clock = systemClock();
  const random = systemRandom();
  const store = openStore({ path: config.OZB_DB_PATH, clock });
  // DEV-ONLY: when OZB_DEV_MOCK_TRANSPORT is active (inert in production),
  // serve the four poll URLs from the committed fixtures so a local dev
  // worker never queries the live OzBargain site.
  const useMock = isDevMockTransport();
  const transport = useMock
    ? createDevMockTransport(config)
    : createHttpTransport({ userAgent: config.OZB_USER_AGENT });
  console.log(
    `${new Date().toISOString()} transport: ${useMock ? 'dev mock (fixtures, no network)' : 'live HTTP'}`,
  );

  // The real provider factories, built from the delivery-mechanism registry.
  // Each mechanism's `build` is the single construction point shared with the
  // test-send route.
  const { MECHANISMS } = await import('../lib/notify/registry.js');
  const providerFactories = {};
  for (const m of MECHANISMS) {
    providerFactories[m.kind] = (row, cfg) => m.build(row, cfg);
  }

  const worker = await startWorker({ store, transport, clock, random, config, providerFactories });

  installShutdown({ worker, store });

  // An unhandled error is unrecoverable: exit non-zero so the container is
  // restarted (a dead poller with a live UI is the failure to prevent).
  process.on('uncaughtException', (err) => {
    console.error(`uncaught: ${err?.message ?? err}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    console.error(`unhandled rejection: ${err?.message ?? err}`);
    process.exit(1);
  });
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  main().catch((err) => {
    console.error(`worker failed to start: ${err?.message ?? err}`);
    process.exit(1);
  });
}
