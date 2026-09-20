/**
 * The architecture guard (design 2.2, 8.2). The poll loop lives in a separate
 * worker process, never in the Next.js server tree.
 *
 * This test walks every file under `app/` and `middleware.js` and asserts that
 * none of them imports `lib/acquire/`, `lib/scheduler.js` or anything under
 * `worker/`, and that none contains `setInterval`. A final assertion checks
 * that `worker/main.js` does import `lib/acquire/poll.js` — the positive
 * control that proves the guard is looking at the right thing.
 *
 * The widened envelope (t_05eef8dc) walks the *transitive* server tree: it
 * starts from every file under `app/`, `middleware.js`, and a root
 * `instrumentation.js`/`instrumentation.mjs` if present, follows relative
 * imports (static, dynamic, `require`, and `export ... from`) into `lib/**`,
 * and asserts no reachable module is `lib/acquire/*`, `lib/scheduler.js` or
 * `worker/*`, owns a `setInterval`, or runs a `setTimeout`/`setImmediate`
 * self-re-scheduling loop (the shape of a polling loop with the token
 * rotated).
 *
 * If a later change moves polling into a route, a `lib/web/*` helper, or
 * `instrumentation.js`, this test fails. That is its entire purpose.
 *
 * Mutation list — each mutant was applied to a scratch copy of the tree at
 * 04860a2 and run through `npm test` (only the guard test file was modified
 * in the real tree; the mutants below are documentation, not applied code):
 *
 *   M1  app/page.js  + `import { getStore } from '../lib/acquire/poll.js'`
 *       -> FAIL, test "no file in the Next.js server tree imports the
 *          acquisition, scheduler, or worker code":
 *          "app/page.js must not reference lib/acquire/ (polling lives in
 *          the worker, not the server tree)"
 *
 *   M2  middleware.js + `setInterval(() => {}, 1000)`
 *       -> FAIL, test "no file in the Next.js server tree imports the
 *          acquisition, scheduler, or worker code":
 *          "middleware.js must not contain setInterval (no polling in the
 *          server tree)"
 *
 *   M3  lib/web/db.js + module-scope `setInterval(() => {}, 1000)`
 *       -> FAIL, test "no module reachable from the server tree is
 *          acquisition, scheduler, or worker code":
 *          "lib/web/db.js is reachable from app/page.js and must not contain
 *          setInterval (no polling in the server tree)"
 *       (the pre-widening guard passed this mutant — hole 1; every screen
 *        imports lib/web/db.js, so the interval would ride on every route)
 *
 *   M4  root instrumentation.js + module-scope `setInterval(() => {}, 1000)`
 *       -> FAIL, test "no module reachable from the server tree is
 *          acquisition, scheduler, or worker code":
 *          "instrumentation.js is reachable from instrumentation.js and must
 *          not contain setInterval (no polling in the server tree)"
 *       (the pre-widening guard passed this mutant — hole 2; a real Next.js
 *        server entry that the old guard never scanned)
 *
 *   M5  lib/web/db.js +
 *       `const pollLoop = () => { setTimeout(pollLoop, 1000); };`
 *       -> FAIL, test "no reachable server-tree module runs a
 *          setTimeout/setImmediate self-re-scheduling loop":
 *          "lib/web/db.js is reachable from app/page.js and must not run a
 *          setTimeout self-re-scheduling loop (a self-re-scheduling timer is
 *          a polling loop with the token rotated)"
 *       (the pre-widening guard passed this mutant — hole 3)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

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

/**
 * Extract relative import specifiers from a module's source: static
 * `import ... from '...'`, bare `import '...'`, dynamic `import('...')`,
 * CommonJS `require('...')`, and `export ... from '...'` re-exports. Only
 * relative specifiers are returned — bare specifiers (npm packages, `node:`
 * builtins) are not part of this repo's server tree.
 */
function importSpecifiers(source) {
  const specs = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1];
      if (spec.startsWith('./') || spec.startsWith('../')) {
        specs.push(spec);
      }
    }
  }
  return specs;
}

/**
 * Resolve a relative specifier against the importing file's directory to an
 * absolute path, trying the plain path, with `.js` appended, and as a
 * directory with an `index.js`. Returns null when the target does not exist
 * (e.g. a path that only resolves at bundle time).
 */
function resolveImport(importerFile, spec) {
  const base = resolve(dirname(importerFile), spec);
  const candidates = [base, `${base}.js`, join(base, 'index.js')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/**
 * Walk the transitive server tree: seed with every file under `app/`,
 * `middleware.js`, and a root `instrumentation.js`/`instrumentation.mjs` if
 * present, then follow relative imports. Returns `{ files, parent }` where
 * `files` is a map of reached absolute path -> the seed that reached it, and
 * `parent` maps each non-seed file to the file that first reached it.
 */
function walkServerTree() {
  const seeds = [];
  const appDir = join(root, 'app');
  if (existsSync(appDir) && statSync(appDir).isDirectory()) {
    seeds.push(...listFiles(appDir));
  }
  const middlewarePath = join(root, 'middleware.js');
  if (existsSync(middlewarePath) && statSync(middlewarePath).isFile()) {
    seeds.push(middlewarePath);
  }
  for (const name of ['instrumentation.js', 'instrumentation.mjs']) {
    const p = join(root, name);
    if (existsSync(p) && statSync(p).isFile()) {
      seeds.push(p);
    }
  }
  assert.ok(seeds.length > 0, 'expected at least one server-tree seed file to walk');

  const files = new Map(); // path -> seed path
  for (const seed of seeds) {
    files.set(seed, seed);
  }
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift();
    const source = readFileSync(current, 'utf8');
    for (const spec of importSpecifiers(source)) {
      const target = resolveImport(current, spec);
      if (target === null || files.has(target)) continue;
      files.set(target, files.get(current));
      queue.push(target);
    }
  }
  return { files };
}

/**
 * Extract the body of a function/arrow definition assigned to `name` in
 * `source`. Returns the body text (block contents, or the expression for an
 * expression-bodied arrow), or null when `name` is not defined as a function
 * in this module.
 */
function functionBodyFor(name, source) {
  const defRe = new RegExp(
    `\\b${name}\\s*=\\s*(async\\s+)?(function\\s*\\([^)]*\\)\\s*|\\([^)]*\\)\\s*=>\\s*|\\(\\)\\s*=>\\s*)`,
  );
  const m = defRe.exec(source);
  if (m === null) return null;
  const after = m.index + m[0].length;
  const rest = source.slice(after);
  if (rest.startsWith('{')) {
    // Brace-match the block.
    let depth = 0;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '{') depth++;
      else if (rest[i] === '}') {
        depth--;
        if (depth === 0) return rest.slice(1, i);
      }
    }
    return rest;
  }
  // Expression body: take to the end of the line (or a semicolon).
  const lineEnd = rest.indexOf('\n');
  const expr = lineEnd === -1 ? rest : rest.slice(0, lineEnd);
  return expr.replace(/;$/, '');
}

/**
 * True when `source` passes a named function to `timer` (setTimeout or
 * setImmediate) and that function's body schedules a timer again — a
 * self-re-scheduling loop, i.e. a polling loop that avoids the literal
 * `setInterval` token. A one-shot `setTimeout(fn, ms)` where `fn` never
 * schedules a timer is not flagged.
 */
function hasSelfReschedulingLoop(source, timer) {
  const callRe = new RegExp(`\\b${timer}\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*(?:\\(\\s*)?[,)]`, 'g');
  let m;
  while ((m = callRe.exec(source)) !== null) {
    const name = m[1];
    const body = functionBodyFor(name, source);
    if (body === null) continue;
    if (new RegExp(`\\b${timer}\\s*\\(`).test(body)) {
      return true;
    }
  }
  return false;
}

/**
 * Positive controls for the loop detector (per the existing pattern: prove
 * the guard is looking at the right thing). The bad sample must be flagged;
 * the good samples — the real `lib/clock.js` sleep idiom and a one-shot
 * delayed call to a named function — must not.
 */
test('setTimeout/setImmediate loop detector flags the polling shape and not one-shot timers', () => {
  const bad = 'const pollLoop = () => { setTimeout(pollLoop, 1000); };\n';
  const badImmediate = 'const spin = () => { setImmediate(spin); };\n';
  const goodSleep = 'function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }\n';
  const goodOneShot = 'const tick = () => { console.log("once"); };\nsetTimeout(tick, 1000);\n';
  assert.ok(hasSelfReschedulingLoop(bad, 'setTimeout'), 'must flag a setTimeout self-re-scheduling loop');
  assert.ok(hasSelfReschedulingLoop(badImmediate, 'setImmediate'), 'must flag a setImmediate self-re-scheduling loop');
  assert.ok(!hasSelfReschedulingLoop(goodSleep, 'setTimeout'), 'must not flag the clock.js sleep idiom');
  assert.ok(!hasSelfReschedulingLoop(goodOneShot, 'setTimeout'), 'must not flag a one-shot delayed call');
});

test('no module reachable from the server tree is acquisition, scheduler, or worker code', () => {
  const { files } = walkServerTree();
  assert.ok(files.size > 0, 'expected at least one reachable server-tree module');

  // No reachable module may *be* forbidden code (a route may only reach it
  // transitively through a lib/ helper).
  for (const [file, seed] of files) {
    const rel = file.slice(root.length + 1).replace(/\\/g, '/');
    for (const forbidden of FORBIDDEN_IMPORTS) {
      assert.ok(
        !rel.startsWith(forbidden),
        `${file} is reachable from ${seed} and must not be ${forbidden}* (polling lives in the worker, not the server tree)`,
      );
    }
  }

  // No reachable module may import forbidden code.
  for (const [file, seed] of files) {
    const source = readFileSync(file, 'utf8');
    for (const spec of importSpecifiers(source)) {
      const resolved = resolveImport(file, spec);
      if (resolved === null) continue;
      const rel = resolved.slice(root.length + 1).replace(/\\/g, '/');
      for (const forbidden of FORBIDDEN_IMPORTS) {
        assert.ok(
          !rel.startsWith(forbidden),
          `${file} (reachable from ${seed}) must not import ${rel} (polling lives in the worker, not the server tree)`,
        );
      }
    }
  }

  // No reachable module may own a setInterval — including lib/ helpers and
  // instrumentation.js, which the pre-widening guard did not scan.
  for (const [file, seed] of files) {
    const source = readFileSync(file, 'utf8');
    for (const token of FORBIDDEN_TOKENS) {
      assert.ok(
        !source.includes(token),
        `${file} is reachable from ${seed} and must not contain ${token} (no polling in the server tree)`,
      );
    }
  }
});

test('no reachable server-tree module runs a setTimeout/setImmediate self-re-scheduling loop', () => {
  const { files } = walkServerTree();
  for (const [file, seed] of files) {
    const source = readFileSync(file, 'utf8');
    assert.ok(
      !hasSelfReschedulingLoop(source, 'setTimeout'),
      `${file} is reachable from ${seed} and must not run a setTimeout self-re-scheduling loop (a self-re-scheduling timer is a polling loop with the token rotated)`,
    );
    assert.ok(
      !hasSelfReschedulingLoop(source, 'setImmediate'),
      `${file} is reachable from ${seed} and must not run a setImmediate self-re-scheduling loop (a self-re-scheduling timer is a polling loop with the token rotated)`,
    );
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
