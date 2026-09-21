/**
 * The architecture guard (design 2.2, 8.2). The poll loop lives in a separate
 * worker process, never in the Next.js server tree. This test walks every file
 * under `app/` and `middleware.js` and asserts that none of them imports
 * `lib/acquire/`, `lib/scheduler.js` or anything under `worker/`, and that none
 * contains `setInterval`. A second assertion checks that `worker/main.js` does
 * import `lib/acquire/poll.js` — the positive control that proves the guard is
 * looking at the right thing.
 *
 * If a later change moves polling into a route, this test fails. That is its
 * entire purpose.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** Recursively list every file under `dir`. */
function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

const FORBIDDEN_IMPORTS = ['lib/acquire/', 'lib/scheduler', 'worker/'];
const FORBIDDEN_TOKENS = ['setInterval'];

test('no file in the Next.js server tree imports the acquisition, scheduler, or worker code', () => {
  const targets = [];
  const appDir = join(root, 'app');
  if (statSync(appDir).isDirectory()) {
    targets.push(...listFiles(appDir));
  }
  const middlewarePath = join(root, 'middleware.js');
  if (statSync(middlewarePath).isFile()) {
    targets.push(middlewarePath);
  }
  assert.ok(targets.length > 0, 'expected at least one server-tree file to walk');

  for (const file of targets) {
    const source = readFileSync(file, 'utf8');
    for (const forbidden of FORBIDDEN_IMPORTS) {
      assert.ok(
        !source.includes(forbidden),
        `${file} must not reference ${forbidden} (polling lives in the worker, not the server tree)`,
      );
    }
    for (const token of FORBIDDEN_TOKENS) {
      assert.ok(
        !source.includes(token),
        `${file} must not contain ${token} (no polling in the server tree)`,
      );
    }
  }
});

test('worker/main.js imports lib/acquire/poll.js (positive control)', () => {
  const workerMain = join(root, 'worker', 'main.js');
  const source = readFileSync(workerMain, 'utf8');
  assert.ok(
    source.includes('lib/acquire/poll.js'),
    'worker/main.js must import lib/acquire/poll.js — the guard is only meaningful if the worker owns the poll loop',
  );
});
