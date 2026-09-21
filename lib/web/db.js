/**
 * The shared store accessor for the Next.js process (design 2.2). The UI reads
 * and writes the *same* database the worker polls into — the two processes are
 * separated by the process boundary, not by a copy of the data. The store is
 * opened once per process (a `DatabaseSync` handle) and cached.
 *
 * The UI never opens a second writer to a path the worker owns for a long
 * write: `DatabaseSync` with `WAL` (set by the store's pragmas) lets the UI's
 * short reads and writes coexist with the worker's poll writes.
 *
 * `setStoreForTest` lets a render test inject a store opened on a temporary,
 * fixture-seeded database so a page renders without touching the real DB.
 */

import { openStore } from '../store/index.js';
import { systemClock } from '../clock.js';

let cached = null;
let testStore = null;

/**
 * Get (and lazily open) the process store.
 * @param {object} [env] the environment map (defaults to `process.env`)
 * @returns {object} the store
 */
export function getStore(env = process.env) {
  if (testStore) return testStore;
  if (!cached) {
    const path = String(env.OZB_DB_PATH ?? ':memory:');
    cached = openStore({ path, clock: systemClock() });
  }
  return cached;
}

/**
 * Inject a store for a render test.
 * @param {object|null} store
 */
export function setStoreForTest(store) {
  testStore = store;
}
