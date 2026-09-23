import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../lib/store/index.js';
import { createOzbClient } from '../../lib/http/client.js';
import { fixedClock } from '../../lib/clock.js';
import { seededRandom } from '../../lib/random.js';

/**
 * Open a throwaway store + a client wired to a fixture transport, on a fixed
 * clock and a seeded (deterministic) random. Returns a `close` that removes
 * the temp dir.
 */
export function makeAcquisition({ clockIso = '2026-09-19T07:30:00Z', transport, config = {} } = {}) {
  const clock = fixedClock(clockIso);
  const dir = mkdtempSync(join(tmpdir(), 'ozb-acq-'));
  const store = openStore({ path: join(dir, 'test.db'), clock });
  // Most acquisition tests exercise authenticated classifieds behavior; tests
  // for an absent cookie explicitly remove this fixture credential.
  store.setSetting('ozb_account_cookie', 'test-session=authenticated');
  const client = createOzbClient({
    transport,
    store,
    clock,
    random: seededRandom(1),
    config,
    log: () => {},
  });
  return {
    clock,
    store,
    client,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
