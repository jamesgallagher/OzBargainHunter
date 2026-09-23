/**
 * Local dev worker runner.
 *
 * The worker (`worker/main.js`) reads its configuration from `process.env`
 * (via `lib/config.js`) and does **not** load a `.env` file itself — only
 * Next.js auto-loads `.env` for the server. So for a local `next dev` +
 * worker setup, this runner loads the repo-root `.env` into `process.env`
 * and spawns `node worker/main.js` with those values.
 *
 * Usage: `node scripts/run-worker.mjs`
 *
 * The runner is a thin supervisor: it inherits the worker's stdio, forwards
 * SIGINT/SIGTERM so the worker can stop cleanly (close the database, exit 0),
 * and exits with the worker's exit code. It lives under `scripts/` (not
 * `lib/` or `worker/`) so it is outside the architecture guard's
 * classification and may use Node built-ins freely.
 */

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(root, '.env');

/**
 * Parse a minimal `.env` file into a key/value map. Supports blank lines,
 * full-line `#` comments, `export KEY=VALUE`, and values wrapped in matching
 * single or double quotes. Values that are not quoted are used verbatim
 * (surrounding whitespace trimmed).
 * @param {string} text the file contents
 * @returns {Record<string, string>}
 */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7) : line;
    const eq = body.indexOf('=');
    if (eq < 0) continue;
    const key = body.slice(0, eq).trim();
    if (!key) continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function main() {
  // Read the .env if present; a missing file is fine (the worker falls back
  // to its config defaults for unset keys).
  let fileEnv = {};
  try {
    fileEnv = parseEnv(readFileSync(envPath, 'utf8'));
  } catch {
    fileEnv = {};
  }
  // Precedence: the real environment wins over the file, so a value exported
  // in the shell is not clobbered by a stale .env entry.
  const env = { ...fileEnv, ...process.env };

  const child = spawn(process.execPath, ['worker/main.js'], {
    cwd: root,
    env,
    stdio: 'inherit',
  });

  const forward = (signal) => {
    child.kill(signal);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  child.on('close', (code) => {
    process.exit(code ?? 0);
  });
}

main();
