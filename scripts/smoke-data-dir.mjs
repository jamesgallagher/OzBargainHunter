import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Create the host directory bind-mounted at /data by the image smoke test.
 *
 * mkdtemp creates mode 0700, but the image deliberately runs as uid 1000 and
 * the CI runner owns this host path as a different uid. The mount therefore
 * needs explicit world read/write/search permission so the non-root container
 * user can create and open its SQLite database and snapshot.
 */
export function createSmokeDataDir(parent = tmpdir()) {
  const dataDir = mkdtempSync(join(parent, 'ozb-smoke-'));
  chmodSync(dataDir, 0o777);
  return dataDir;
}
