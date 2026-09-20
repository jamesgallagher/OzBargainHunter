/**
 * The architecture guard (design 2.2, 8.2). The poll loop lives in a separate
 * worker process, never in the Next.js server tree. This test walks every file
 * under `app/` and `middleware.js` and asserts that none of them imports
 * `lib/acquire/`, `lib/scheduler.js` or anything under `worker/`, and that none
 * contains `setInterval`. A second assertion checks that `worker/main.js` does
 * import `lib/acquire/poll.js` — the positive control that proves the guard is
 * looking at the right thing.
 *
 * The server tree is wider than `app/` + `middleware.js`: Next.js also runs
 * the root `instrumentation.js` at server start, and every screen imports the
 * shared `lib/web/` modules. A poll loop parked in `lib/web/*` or in
 * `instrumentation.js` would move polling into the server process without
 * failing the `app/`-only walk, so the guard extends to the transitive server
 * tree: every file under `lib/web/`, plus the root `instrumentation` file
 * (any `instrumentation.@(js|mjs|ts)` variant) when present. In that tree the
 * guard forbids `setInterval` and a `setTimeout`-driven self-rescheduling loop
 * (a function that schedules itself with `setTimeout` — the shape of a poll
 * loop that dodges the `setInterval` check). Legitimate one-shot `setTimeout`s
 * are not flagged: the check requires the function to reference its own name
 * inside its body.
 *
 * If a later change moves polling into a route, a shared web module, or the
 * server-start hook, this test fails. That is its entire purpose.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

/**
 * Find the root `instrumentation` file, if present: Next.js runs it at server
 * start, so it is part of the server tree. Matches `instrumentation.js`,
 * `instrumentation.mjs` and `instrumentation.ts`.
 * @returns {string | null} the absolute path, or null when absent
 */
function instrumentationFile() {
  for (const ext of ['js', 'mjs', 'ts']) {
    const path = join(root, `instrumentation.${ext}`);
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

/**
 * Find every named function body in a source string: function declarations and
 * function expressions. Returns `{ name, body }`. (Arrow functions are
 * deliberately not matched: their anonymous callbacks would create false
 * positives, and a self-rescheduling loop that dodges a named function is
 * caught by the `const name = () =>` binding check in
 * `hasSelfReschedulingTimeout`.)
 * @param {string} source
 * @returns {Array<{ name: string, body: string }>}
 */
function findFunctionBodies(source) {
  const out = [];
  for (const m of source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    // Brace-match forward from the opening brace of the function body.
    const open = source.indexOf('{', m.index + m[0].length);
    if (open === -1) continue;
    let depth = 0;
    let i = open;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (i < source.length) {
      out.push({ name, body: source.slice(open, i + 1) });
    }
  }
  return out;
}

/**
 * Does `source` contain a `setTimeout`-driven self-rescheduling loop? That is,
 * a function whose body both calls `setTimeout` and references the function's
 * own name — the shape of a poll loop that dodges the `setInterval` check
 * (`function poll() { …; setTimeout(poll, delay); }`). A legitimate one-shot
 * `setTimeout` (no self-reference) is not flagged.
 * @param {string} source
 * @returns {boolean}
 */
function hasSelfReschedulingTimeout(source) {
  if (!source.includes('setTimeout')) return false;
  for (const { name, body } of findFunctionBodies(source)) {
    if (body.includes('setTimeout') && body.includes(name)) return true;
  }
  // Named arrow-function bindings: `const pollOnce = () => { … setTimeout(pollOnce, …) }`.
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g)) {
    const name = m[1];
    const open = m.index + m[0].length - 1; // position of the `{`
    let depth = 0;
    let i = open;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (i < source.length) {
      const body = source.slice(open, i + 1);
      if (body.includes('setTimeout') && body.includes(name)) return true;
    }
  }
  return false;
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

test('no file in the transitive server tree (lib/web, instrumentation) hosts a poll loop', () => {
  const targets = [];
  const webDir = join(root, 'lib', 'web');
  if (statSync(webDir).isDirectory()) {
    targets.push(...listFiles(webDir));
  }
  const instr = instrumentationFile();
  if (instr) targets.push(instr);
  assert.ok(targets.length > 0, 'expected at least one transitive server-tree file to walk');

  for (const file of targets) {
    const source = readFileSync(file, 'utf8');
    assert.ok(
      !source.includes('setInterval'),
      `${file} must not contain setInterval (no polling in the server tree — the poll loop lives in the worker)`,
    );
    assert.ok(
      !hasSelfReschedulingTimeout(source),
      `${file} must not contain a setTimeout-driven self-rescheduling loop (no polling in the server tree)`,
    );
  }
});
