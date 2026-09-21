import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Create the host directory bind-mounted at /data by the image smoke test.
 *
 * `mkdtemp` creates mode 0700, but the image deliberately runs as uid 1000
 * (`USER node` in the Dockerfile) and the CI runner owns this host path as a
 * different uid (1001). With the default mode the container's own user cannot
 * traverse the mount at all, so the worker dies on startup with
 * `unable to open database file` and the smoke test can never go healthy —
 * which is exactly what happened on run 35610785899.
 *
 * So the mount needs explicit world read/write/search permission: the
 * deployment contract is that the host directory backing /data is writable by
 * uid 1000 (the Dockerfile says the same thing about the Unraid host path), and
 * the smoke test's own data directory has to meet the contract it tests.
 * It is a throwaway directory under the system temp dir, removed in the smoke
 * test's `finally`, so the world-writable mode has no wider exposure.
 *
 * @param {string} [parent] the parent directory (default: the system temp dir)
 * @returns {string} the created directory, mode 0777
 */
export function createSmokeDataDir(parent = tmpdir()) {
  const dataDir = mkdtempSync(join(parent, 'ozb-smoke-'));
  chmodSync(dataDir, 0o777);
  return dataDir;
}
