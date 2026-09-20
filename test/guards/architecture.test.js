/**
 * The architecture guard (design 2.2, 8.2). The poll loop lives in a separate
 * worker process, never in the Next.js server tree.
 *
 * This file is the UNION of the two approved guard revisions. It carries both
 * envelopes, and the loop detector is the union of both detectors, so a poll
 * loop moved into the server tree in either spelling fails the guard:
 *
 *   - the widened envelope (t_05eef8dc / t_b202bdeb) walks the *transitive*
 *     server tree: it starts from every file under `app/`, `middleware.js`,
 *     and a root `instrumentation.js`/`instrumentation.mjs` if present,
 *     follows relative imports (static, dynamic, `require`, and
 *     `export ... from`) into `lib/**`, and asserts no reachable module is
 *     `lib/acquire/*`, `lib/scheduler.js` or `worker/*`, owns a
 *     `setInterval`, or runs a `setTimeout`/`setImmediate` self-re-scheduling
 *     loop.
 *
 *   - the widened envelope (t_e54d6eec) additionally blanked comments, string
 *     and template literals, and regex literals before brace matching, so a
 *     `}` inside a string, a quote inside a regex literal, or a name in a
 *     comment cannot fool the self-reference test; and it recognised the
 *     *thunk* spelling (`setTimeout(() => poll(), …)` — the shape this repo's
 *     own `lib/scheduler.js` schedules a beat in) and the +arg, block-body,
 *     arrow-binding, concise-body and module-level thunk spellings.
 *
 * The loop detector is therefore the union of the two: it runs the
 * b202bdeb-shaped detector (which resolves a *directly passed* named helper
 * whose own body calls the function — the unwrapped two-function ping-pong
 * loop — and the `this.name` / `name.bind` method shapes) OR the e54d6eec-
 * shaped detector (which blanks comments/strings/regex and recognises the
 * thunk spelling and the division-after-`++`/`--`/`.of` fix). A shape caught
 * by either detector is caught; a shape missed by both is a recorded blind
 * spot below.
 *
 * If a later change moves polling into a route, a `lib/web/*` helper, or
 * `instrumentation.js`, this test fails. That is its entire purpose.
 *
 * Mutation list — each mutant was applied to a scratch copy of the tree and run
 * through `npm test` (only the guard test file was modified in the real tree;
 * the mutants below are documentation, not applied code).
 * "reachable from app/alerts/page.js" is the actual seed: `app/alerts/page.js`
 * is the first seed (in walk order) that reaches `lib/web/db.js`, so that is
 * the path the guard reports.
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
 *          "lib/web/db.js is reachable from app/alerts/page.js and must not
 *          contain setInterval (no polling in the server tree)"
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
 *          "lib/web/db.js is reachable from app/alerts/page.js and must not
 *          run a setTimeout self-re-scheduling loop (a self-re-scheduling
 *          timer is a polling loop with the token rotated)"
 *       (the pre-widening guard passed this mutant — hole 3)
 *
 *   M6  lib/web/db.js + `function pollLoop() { setTimeout(pollLoop, 1000); }`
 *       -> FAIL, test "no reachable server-tree module runs a
 *          setTimeout/setImmediate self-re-scheduling loop" (a plain function
 *          declaration — the repo's own top-level style; the pre-widening
 *          detector only resolved arrow bindings, so this shape survived)
 *
 *   M7  lib/web/db.js +
 *       `const spin = () => { setTimeout(() => spin(), 1000); };`
 *       -> FAIL, same test (a wrapped callback that re-schedules the binding)
 *
 *   M8  lib/web/db.js +
 *       `setImmediate(function tick() { setImmediate(tick); });`
 *       -> FAIL, same test (a named function expression handed to
 *          setImmediate)
 *
 *   M9  lib/web/db.js +
 *       `class Ticker { tick() { setTimeout(this.tick.bind(this), 1000); } }
 *        new Ticker().tick();`
 *       -> FAIL, same test (a class method re-scheduling itself via a
 *          `this.tick` binding)
 *
 *   M10 lib/web/db.js + `const pollExpr = () => setTimeout(pollExpr, 1000);`
 *       -> FAIL, test "no reachable server-tree module runs a
 *          setTimeout/setImmediate self-re-scheduling loop":
 *          "lib/web/db.js is reachable from app/alerts/page.js and must not
 *          run a setTimeout self-re-scheduling loop (a self-re-scheduling
 *          timer is a polling loop with the token rotated)"
 *       (an expression-bodied arrow — no braces — re-scheduling itself. The
 *        round-2 rewrite's `functionBodies` collected only braced forms, so
 *        this shape regressed to a survivor; the async form
 *        `const pollExpr = async () => setTimeout(pollExpr, 1000);` is the
 *        same blind spot and is also caught)
 *
 * M6-M10 were also added as regression fixtures in the positive-control test
 * below, so the detector's coverage of each shape is proven in-tree.
 *
 * The t_e54d6eec detector's own controls (the thunk spelling, the +arg /
 * block-body / arrow-binding / concise-body / module-level thunk spellings,
 * the string-`}` and regex-quote blanking, and the division-after-`++`/`--`/
 * `.of` fix) are the positive/negative controls in the detector test below.
 *
 * Known limitation (recorded, not a defect): `FORBIDDEN_IMPORTS` and
 * `FORBIDDEN_TOKENS` are matched as raw substrings, *including comments and
 * string literals*. The scope of that substring scan is:
 *   - `app/**` + `middleware.js` (card 1's test): both `FORBIDDEN_IMPORTS`
 *     and `FORBIDDEN_TOKENS` are scanned as source text, so a comment or
 *     string that merely mentions `setInterval` or `lib/acquire/` /
 *     `lib/scheduler` / `worker/` in an `app/**` or `middleware.js` file
 *     trips the guard.
 *   - `lib/**` (the widened walk's token loop): only `FORBIDDEN_TOKENS`
 *     (`setInterval`) is scanned as source text. A comment naming
 *     `lib/acquire/poll.js` in a `lib/**` file does *not* trip the guard
 *     (measured rc=0) — the import-token check over `lib/**` applies to the
 *     *resolved path* of a reached module, not to its source text.
 * Either way it is a false positive, not a false negative — it makes the
 * guard stricter, never looser (a legit doc comment that names a forbidden
 * token does break the build). Measured: a doc comment in an `app/**` or
 * `middleware.js` file that names `lib/acquire/poll.js` (or `setInterval`),
 * or a doc comment in a `lib/**` file that contains `setInterval` (or a
 * self-scheduling arrow), fails the guard (rc=1). The loop detector's own
 * scanner skips strings/comments for *its* brace matching, but the
 * `FORBIDDEN_TOKENS` substring check does not.
 *
 * The loop detector is a hand-rolled source scanner that keys on the *literal*
 * `setTimeout` / `setImmediate` call text (a `timer(...)` call where `timer`
 * is the literal identifier, with the scheduling function's own name as the
 * first argument). It covers the shapes above and a *recorded set of blind
 * spots* it does not. These are not false negatives of the guard's stated
 * contract (they are polling-loop shapes the detector does not reason about),
 * and each is recorded here so a later card can close it deliberately rather
 * than by accident:
 *   - object-literal method: `const o = { tick() { setTimeout(o.tick, 1000); } };`
 *     — `callbackReferences` tests `this.NAME` / `NAME.bind`, not `o.NAME`.
 *   - alias indirection: `const s = () => { setTimeout(ref, 1000); }; const ref = s;`
 *   - ~~wrapped mutual recursion~~ (now caught): `function mutA(){ setTimeout(() => mutB(), 1000); }
 *     function mutB(){ mutA(); }` — the one-hop thunk mutual recursion is
 *     resolved (see the "Mutual recursion through a thunk" note below), so both
 *     the direct (`setTimeout(mutB, ms)`) and the wrapped (`() => mutB()`)
 *     forms are flagged.
 *   - `node:timers/promises` awaited loop: `while (true) { await waitMs(5000); }`
 *     where `waitMs` is `import { setTimeout as waitMs } from 'node:timers/promises'`
 *     — no `setInterval` token and no self-referential callback, so neither
 *     mechanism sees it. (This shape is outside the card's three holes and
 *     outside requirement 2's `setTimeout`/`setImmediate` naming; it is scope,
 *     not a weakening — no prior revision of this file ever covered it.)
 *   - `queueMicrotask(spin)` recursion — no timer token at all.
 *   - **Timer reached through a local alias / parameter binding** (t_b202bdeb
 *     item 1) — the detector keys on the literal `setTimeout` / `setImmediate`
 *     call text, so a timer reached through any indirection is not seen. Each
 *     shape below is measured green (passes the guard) and is recorded here:
 *     - `const timer = setTimeout;` then `pollLoop() { timer(pollLoop, 1000); }`
 *     - `const { setTimeout: later } = globalThis;` then `later(pollLoop, 1000)`
 *     - `import { setTimeout as schedule } from 'node:timers';` then `schedule(...)`
 *     - a defaulted parameter `startPoll({ timer = setTimeout } = {})` — the DI
 *       idiom `lib/scheduler.js` itself uses
 *     - `setTimeout.apply(null, [fn, ms])` and `Reflect.apply(setTimeout, null, [...])`
 *   - **`setInterval` via a computed key** (t_b202bdeb item 1): `const KEY =
 *     'set' + 'Interval'; globalThis[KEY](() => {}, 1000);` — the `setInterval`
 *     substring rule never sees the token because it is built by string
 *     concatenation, so neither the token check nor the loop detector fires.
 *   - **Expression-bodied outer + braced inner callback** (t_b202bdeb item 2):
 *     `const poll = () => setTimeout(() => { poll() }, 1000);` — `assignExprRe`'s
 *     body stops at the inner `{`, so `timerFirstArgs` sees an unbalanced call.
 *     The braced-outer form and the concise-inner form are each caught, but this
 *     conjunction is not.
 *   - **`process.nextTick` recursion** (t_b202bdeb item 6):
 *     `function tick() { process.nextTick(tick); }` — `nextTick` is not a
 *     `setTimeout` / `setImmediate` token, so the loop detector does not reason
 *     about it.
 *   - **Cross-module loop** (t_b202bdeb item 6): a `setTimeout` in one reachable
 *     module whose callback calls a function defined in *another* reachable module
 *     (the timer in module A, the recursive call in module B). The detector
 *     reasons per-module, so a self-re-schedule split across two modules is not
 *     seen by either.
 *   - ~~Mutual recursion through a thunk~~ (now caught — the `lib/scheduler.js`
 *     shape): `scheduleNextBeat` schedules `() => fireBeat(…)` and `fireBeat`
 *     calls `scheduleNextBeat` — a *different* function is passed to
 *     `setTimeout` and the self-reference is one hop indirect. The detector
 *     resolves the one-hop thunk mutual recursion (the callback's callee `g`
 *     is looked up and its own body is tested for a reference back to the
 *     scheduling function), so the `lib/scheduler.js` shape is flagged by the
 *     loop detector itself. A `lib/scheduler.js` relocated verbatim into the
 *     server tree (e.g. `cp lib/scheduler.js lib/web/scheduler-echo.js`,
 *     reached through a route's import) is therefore caught by the *loop*
 *     detector, not by the import-prefix check (whose destination-path match
 *     no longer fires once the file is renamed off `lib/scheduler*`).
 * The header's "that is its entire purpose" therefore applies to the three
 * holes and the `setTimeout` / `setImmediate` shapes above, not to the blind
 * spots in this list.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// `fileURLToPath(new URL('../..', ...))` returns a path ending in a separator
// on POSIX (e.g. `.../OzBargainHunter/`), so `file.slice(root.length + 1)`
// would drop the first character of the relative path (`lib/web/db.js` ->
// `ib/web/db.js`) and every `rel.startsWith('lib/acquire/')` check below
// would be permanently false. `resolve()` strips the trailing separator, so
// `file.slice(root.length + 1)` yields the correct repo-relative path.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Recursively list every file under `dir`. A `Set` of already-visited real
 * directory paths guards against a directory symlink pointing at an ancestor
 * (which would otherwise recurse forever).
 * @param {string} dir
 * @param {Set<string>} [seen]
 * @returns {string[]}
 */
function listFiles(dir, seen) {
  const out = [];
  const visited = seen ?? new Set();
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // path vanished between readdir and realpath; keep the literal path
  }
  if (visited.has(real)) return out;
  visited.add(real);
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full, visited));
    } else {
      out.push(full);
    }
  }
  return out;
}

const FORBIDDEN_IMPORTS = ['lib/acquire/', 'lib/scheduler', 'worker/'];
// Matched as a raw substring (see the "Known limitation" note in the header):
// a comment mentioning the token would trip the guard, but that is a false
// positive (stricter), never a false negative (looser).
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
 *
 * The dynamic-import pattern tolerates a block comment between the `(` and
 * the specifier (and after it), so a dynamic import whose argument list
 * carries a webpack chunk-name block comment is followed. The comment is
 * consumed before the specifier's opening quote, so a quote inside the
 * comment (the webpack chunk name) is not mistaken for the specifier
 * delimiter. A line comment (`//`) is not tolerated here because it would
 * break the single-expression match; a dynamic import is not written with
 * a `//` comment inside its argument list in this repo.
 */
function importSpecifiers(source) {
  const specs = [];
  // `(?:\/\*[\s\S]*?\*\/\s*)*` = zero or more block comments (with
  // surrounding whitespace), so a webpack chunk-name comment does not hide the
  // specifier.
  const comment = '(?:\\/\\*[\\s\\S]*?\\*\\/\\s*)*';
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    new RegExp(`\\bimport\\s*\\(\\s*${comment}['"]([^'"]+)['"]\\s*${comment}\\)`, 'g'),
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
 *
 * The candidate list is widened (t_b202bdeb item 3) to also try the
 * extensionless `.mjs` / `.jsx` / `.ts` variants and a directory's
 * `index.mjs`, so a dynamic import of an extensionless or non-`.js` target
 * (e.g. `import('../../lib/web/x.mjs')` or `import('../../lib/web/x')`
 * resolving to `x.mjs`) is followed. A specifier that still does not resolve
 * to an existing file (e.g. a path that only resolves at bundle time, or a
 * bare specifier) returns null and is not followed — that is the honest
 * residual: the guard cannot reason about a module it cannot locate.
 */
function resolveImport(importerFile, spec) {
  const base = resolve(dirname(importerFile), spec);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.jsx`,
    `${base}.ts`,
    join(base, 'index.js'),
    join(base, 'index.mjs'),
  ];
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
 * present, then follow relative imports. Returns `{ files }` where `files` is
 * a map of reached absolute path -> the seed that first reached it.
 */
function walkServerTree(base = root) {
  const seeds = [];
  const appDir = join(base, 'app');
  if (existsSync(appDir) && statSync(appDir).isDirectory()) {
    seeds.push(...listFiles(appDir));
  }
  const middlewarePath = join(base, 'middleware.js');
  if (existsSync(middlewarePath) && statSync(middlewarePath).isFile()) {
    seeds.push(middlewarePath);
  }
  for (const name of ['instrumentation.js', 'instrumentation.mjs']) {
    const p = join(base, name);
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
 * Skip past a string literal that starts at `source[i]` (one of `"`, `'`, or
 * a backtick). Returns the index just past the closing quote. Template-literal
 * substitutions are not followed — the guard only needs to avoid misreading a
 * timer token or a name that appears inside a string, which skipping the whole
 * literal achieves.
 */
function skipString(source, i) {
  const quote = source[i];
  i++;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') { i += 2; continue; }
    if (c === quote) { return i + 1; }
    i++;
  }
  return i;
}

/**
 * Return the contents of the block whose opening `{` is at `openIdx`, skipping
 * strings and line or block comments so a brace inside a string or comment
 * does not break the match. Returns null when unbalanced.
 */
function matchBlock(source, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(source, i);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(openIdx + 1, i);
    }
    i++;
  }
  return null;
}

/**
 * Return the contents of the argument list whose opening `(` is at `openIdx`,
 * skipping strings and comments. Returns null when unbalanced.
 */
function matchParens(source, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(source, i);
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return source.slice(openIdx + 1, i);
    }
    i++;
  }
  return null;
}

/** Split `text` on top-level commas (not inside `()`, `[]`, `{}` or strings). */
function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(text, i);
      cur += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
    i++;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

/**
 * Extract the body of a function defined as `name` in `source`. Handles the
 * shapes a polling loop is most likely to use: a `function name(...)`
 * declaration, an arrow bound to `name` (with or without a parameter list), a
 * `function` expression bound to `name`, and a `name(...)` method. Returns the
 * body text (block contents, or the expression for an expression-bodied arrow),
 * or null when `name` is not defined as a function in this module.
 */
function functionBodyFor(name, source) {
  const patterns = [
    new RegExp('\\bfunction\\s+' + name + '\\s*\\(([^)]*)\\)\\s*\\{'),
    new RegExp('\\b' + name + '\\s*=\\s*(?:async\\s+)?\\(([^)]*)\\)\\s*=>\\s*\\{'),
    new RegExp('\\b' + name + '\\s*=\\s*(?:async\\s+)?\\(\\)\\s*=>\\s*\\{'),
    new RegExp('\\b' + name + '\\s*=\\s*(?:async\\s+)?function\\s*\\(([^)]*)\\)\\s*\\{'),
    new RegExp('\\b' + name + '\\s*\\(([^)]*)\\)\\s*\\{'),
  ];
  for (const re of patterns) {
    const m = re.exec(source);
    if (m === null) continue;
    const openIdx = m.index + m[0].length - 1; // index of the opening '{'
    const body = matchBlock(source, openIdx);
    if (body !== null) return body;
  }
  // Expression-bodied arrow: name = (...) => expr
  const exprRe = new RegExp('\\b' + name + '\\s*=\\s*(?:async\\s+)?\\(([^)]*)\\)\\s*=>\\s*([^{\\s][^;]*|\\S[^;]*)(?=;|\\n|$)');
  const em = exprRe.exec(source);
  if (em !== null) return em[2].replace(/;$/, '');
  return null;
}

/**
 * Collect every function-definition site in `source` as `{ name, body }` —
 * declarations, arrow/function-expression bindings, and methods. This is the
 * widened form of `functionBodyFor`: instead of looking up one name, it finds
 * all functions so `hasSelfReschedulingLoop` can test each one's own body.
 */
function functionBodies(source) {
  const out = [];
  const seen = new Set();
  const add = (name, body) => {
    const key = name + ' ' + body;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, body });
  };
  let m;
  const declRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
  while ((m = declRe.exec(source)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const body = matchBlock(source, openIdx);
    if (body !== null) add(m[1], body);
  }
  const assignRe = /\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s*)?\(([^)]*)\)\s*=>\s*\{/g;
  while ((m = assignRe.exec(source)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const body = matchBlock(source, openIdx);
    if (body !== null) add(m[1], body);
  }
  // Expression-bodied arrow: `name = (...) => expr` (no braces). The body is
  // the expression up to the terminating `;` or newline — a single expression
  // never contains `;`, and a leading `{` means a braced body (handled by the
  // `assignRe` above, which yields an empty `body` here and is skipped). This
  // is the shape the round-1 detector handled via `functionBodyFor` and the
  // round-2 rewrite dropped: `const pollExpr = () => setTimeout(pollExpr,
  // 1000);` (and its async form) must be collected so its timer is examined.
  const assignExprRe = /\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*([^;{\n]*)/g;
  while ((m = assignExprRe.exec(source)) !== null) {
    const body = m[4].trim();
    if (body !== '') add(m[1], body);
  }
  const assignFnRe = /\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\(([^)]*)\)\s*\{/g;
  while ((m = assignFnRe.exec(source)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const body = matchBlock(source, openIdx);
    if (body !== null) add(m[1], body);
  }
  // Method: NAME(...) { ... } — skip control-flow keywords so `if (...) {`
  // and friends are not treated as function definitions.
  const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'finally', 'else', 'function', 'return', 'do', 'with']);
  const methodRe = /\b([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
  while ((m = methodRe.exec(source)) !== null) {
    const name = m[1];
    if (keywords.has(name)) continue;
    const openIdx = m.index + m[0].length - 1;
    const body = matchBlock(source, openIdx);
    if (body !== null) add(name, body);
  }
  return out;
}

/** The first argument of every `timer(...)` call in `body`. */
function timerFirstArgs(body, timer) {
  const out = [];
  const re = new RegExp('\\b' + timer + '\\s*\\(', 'g');
  let m;
  while ((m = re.exec(body)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const argsText = matchParens(body, openIdx);
    if (argsText === null) continue;
    const args = splitTopLevel(argsText);
    out.push(args.length > 0 ? args[0].trim() : '');
  }
  return out;
}

/**
 * The callee of the first top-level call in a wrapped callback (an arrow
 * body): `fireBeat` in `() => fireBeat(…)`, `() => { fireBeat(…); }`, and
 * `async () => await fireBeat(…)`. Returns null when the callback is not a
 * wrapped arrow, when the callee is a keyword, or when the call is a member
 * access (`this.tick` / `o.tick`) — those are handled by the `this.name`
 * branch, not the mutual-recursion lookup. The lookbehind rejects a callee
 * preceded by `.`, so `this.tick` / `o.tick` are not mistaken for a module
 * function.
 * @param {string} callback
 * @returns {string | null}
 */
function thunkCallee(callback) {
  const m = /=>\s*(?:\{)?\s*(?:await\s+)?(?<!\.)([A-Za-z_$][\w$]*)\s*\(/.exec(callback);
  if (m === null) return null;
  const name = m[1];
  const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'finally', 'else', 'function', 'return', 'do', 'with', 'await', 'new', 'typeof', 'instanceof', 'in', 'of', 'void', 'delete', 'throw', 'yield']);
  if (keywords.has(name)) return null;
  return name;
}

/**
 * True when the scheduled callback refers back to `name` — the function whose
 * body schedules it. Covers a direct self-pass (`setTimeout(name, ms)`), a
 * wrapped callback that calls it (`setTimeout(() => name(), ms)`), a
 * `this.name` / `name.bind` binding (a method re-scheduling itself), a
 * *directly* passed named helper whose own body calls it (the unwrapped
 * two-function ping-pong loop, `setTimeout(mutB, ms)` where `mutB` calls
 * `name`), and — the one-hop thunk mutual recursion this repo's own
 * `lib/scheduler.js` is written in — a *wrapped* callback that calls a
 * *different* module-local function `g` whose own body calls `name`
 * (`setTimeout(() => fireBeat(…), ms)` where `fireBeat` calls
 * `scheduleNextBeat`). The last shape is the recorded "mutual recursion
 * through a thunk" blind spot, now resolved: the callback is an anonymous
 * arrow, so the direct helper lookup does not apply, but the callee's own
 * body is looked up and tested for a reference back to `name`.
 */
function callbackReferences(callback, name, source) {
  const refRe = new RegExp('\\b' + name + '\\s*\\(|this\\.' + name + '\\b|\\b' + name + '\\s*\\.bind\\b');
  const idMatch = /^([A-Za-z_$][\w$]*)$/.exec(callback);
  if (idMatch !== null) {
    if (idMatch[1] === name) return true;
    const gBody = functionBodyFor(idMatch[1], source);
    if (gBody !== null && refRe.test(gBody)) return true;
    return false;
  }
  // A wrapped callback: does the arrow body call `name` directly…
  if (refRe.test(callback)) return true;
  // …or does it call a *different* module-local function `g` whose own body
  // calls `name`? That is the one-hop thunk mutual recursion — the shape this
  // repo's own `lib/scheduler.js` schedules a beat in (`scheduleNextBeat`
  // schedules `() => fireBeat(…)` and `fireBeat` calls `scheduleNextBeat`).
  const callee = thunkCallee(callback);
  if (callee !== null) {
    const gBody = functionBodyFor(callee, source);
    if (gBody !== null && refRe.test(gBody)) return true;
  }
  return false;
}

/**
 * The b202bdeb-shaped loop detector: true when `source` contains a function
 * whose body schedules `timer` (setTimeout or setImmediate) with a callback
 * that refers back to it — a self-re-scheduling loop, i.e. a polling loop
 * that avoids the literal `setInterval` token. A one-shot `setTimeout(fn, ms)`
 * where `fn` never refers back to the scheduling function is not flagged.
 */
function b202bdebLoop(source, timer) {
  for (const { name, body } of functionBodies(source)) {
    for (const callback of timerFirstArgs(body, timer)) {
      if (callbackReferences(callback, name, source)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The e54d6eec-shaped loop detector: blanks comments, string/template literals,
// and regex literals before brace matching (so a `}` inside a string, a quote
// inside a regex literal, or a name in a comment cannot fool the
// self-reference test), and recognises the *thunk* spelling
// (`setTimeout(() => name(), …)` — the shape this repo's own `lib/scheduler.js`
// schedules a beat in) plus the +arg, block-body, arrow-binding, concise-body
// and module-level thunk spellings. `canStartRegex` takes the *previous* token,
// so a division whose left operand ends in a postfix `++`/`--` or a member
// access (`.of`) is not misread as a regex-literal start and blanking the file
// to EOF.
// ---------------------------------------------------------------------------

/**
 * Blank out the contents of comments, string/template literals, and regex
 * literals so that a `{`, `}`, identifier, quote, or the word `setTimeout`
 * inside them cannot affect brace matching or the self-reference test.
 * Returns a string of the same length as `source` (bodies replaced by spaces;
 * newlines preserved).
 *
 * A `/` that can start a regex literal (decided from the preceding
 * non-blanked token — after an identifier, `)`, `]`, a keyword, or at start
 * of the source it is a division; after any other token it opens a literal)
 * is blanked through to its unescaped closing `/`, honouring `\` escapes and
 * `[...]` character classes. Known limit: quotes inside JSX text are not
 * blanked (no JSX mode in a lexical pass).
 * @param {string} source
 * @returns {string}
 */
function blankCommentsAndStrings(source) {
  const out = source.split('');
  const n = source.length;
  let i = 0;
  // The last significant token seen so far, used to decide whether a `/`
  // opens a regex literal or divides. A string/regex/comment ends in a
  // sentinel; an identifier or keyword is spelled out in `tok`. `prev` is the
  // significant token before `last`, used to tell a postfix `++`/`--` (the
  // second operator is not an expression-start context) from a binary one, and
  // a member access (`.of`) from a keyword.
  let last = '';
  let prev = '';
  let tok = '';
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    // Line comment: `//` is unambiguous (there is no `//` operator), so it is
    // recognised in any context. Blank to end of line (keep the newline). A
    // comment is whitespace-equivalent, so it leaves the token state
    // (`last`, `tok`) untouched — the token before the comment is the token
    // before the next line.
    if (ch === '/' && next === '/') {
      let j = i;
      while (j < n && source[j] !== '\n') {
        out[j] = ' ';
        j += 1;
      }
      i = j;
      continue;
    }
    // Block comment: `/*` is likewise unambiguous (no `/*` operator), so it is
    // recognised in any context. Blank to the closing `*/`, keeping newlines.
    // As with a line comment, it leaves the token state untouched.
    if (ch === '/' && next === '*') {
      let j = i;
      out[j] = ' ';
      out[j + 1] = ' ';
      j += 2;
      while (j < n) {
        if (source[j] === '*' && source[j + 1] === '/') {
          out[j] = ' ';
          out[j + 1] = ' ';
          j += 2;
          break;
        }
        if (source[j] !== '\n') out[j] = ' ';
        j += 1;
      }
      i = j;
      continue;
    }
    // String / template literal: blank to the matching quote, honouring escapes.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out[i] = ' ';
      i += 1;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          out[i] = ' ';
          if (i + 1 < n && source[i + 1] !== '\n') out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (c !== '\n') out[i] = ' ';
        i += 1;
        if (c === quote) break;
      }
      last = 'string';
      tok = '';
      continue;
    }
    // Regex literal: a `/` that can start one (decided from the preceding
    // significant token) is blanked through to its unescaped closing `/`,
    // honouring `\` escapes and `[...]` character classes.
    if (ch === '/' && canStartRegex(last, tok, prev)) {
      let j = i;
      out[j] = ' ';
      j += 1;
      let inClass = false;
      while (j < n) {
        const c = source[j];
        if (c === '\\') {
          out[j] = ' ';
          if (j + 1 < n && source[j + 1] !== '\n') out[j + 1] = ' ';
          j += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']' && inClass) inClass = false;
        if (c === '/' && !inClass) {
          out[j] = ' ';
          j += 1;
          break;
        }
        if (c !== '\n') out[j] = ' ';
        j += 1;
      }
      i = j;
      last = 'regex';
      tok = '';
      continue;
    }
    // A bare significant character: an identifier/keyword char accumulates
    // into `tok` (reset when a fresh token starts); any other char closes
    // the token and becomes `last` itself. `prev` always holds the
    // significant token that preceded the one starting here.
    if (/[A-Za-z0-9_$]/.test(ch)) {
      if (last !== 'ident') {
        tok = '';
        prev = last;
      }
      tok += ch;
      last = 'ident';
    } else if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
      prev = last;
      last = ch;
      tok = '';
    }
    i += 1;
  }
  return out.join('');
}

/**
 * Punctuation after which a `/` opens a regex literal (an expression-start
 * context). Every other token — an identifier/number, `)`, `]`, a string, a
 * regex literal, `<`, `>`, `.` — is a division operator (or a JSX/JS
 * closing tag, which is not a regex).
 */
const REGEX_START_CONTEXTS = new Set([
  '=', '(', '[', '{', '!', '&', '|', '?', ':', ',', ';', '+', '-', '*', '%', '~', '^',
]);

/**
 * Keywords after which a `/` opens a regex literal (every other identifier
 * before a `/` is a division operator — `a / b`, `x / y`, and
 * `import … from '…'` all end in a non-keyword identifier).
 */
const REGEX_START_KEYWORDS = new Set([
  'return', 'case', 'typeof', 'instanceof', 'in', 'of', 'do', 'else', 'yield',
  'void', 'delete', 'throw', 'await',
]);

/**
 * Can a `/` at the current position open a regex literal, given the preceding
 * significant tokens? A regex can only follow an expression-start context
 * (a whitelisted operator, or a keyword such as `return`/`typeof`/`yield`).
 * Two contexts that look like expression-start but are not:
 *   - a postfix `++`/`--` — the second operator is not an expression-start
 *     context, so `hits++ / total` divides;
 *   - a member access — the identifier after `.` is a property name, not a
 *     keyword, so `counts.of / total` divides.
 * After any other identifier/number (unless it is one of those keywords), `)`,
 * `]`, a string, a regex literal, `<`, `>` or `.` it is a division operator; at
 * the start of the source it opens a literal.
 * @param {string} last
 * @param {string} tok the pending identifier/keyword, if `last` is 'ident'
 * @param {string} prev the significant token before `last`
 * @returns {boolean}
 */
function canStartRegex(last, tok, prev) {
  if (last === '') return true; // start of source
  // Postfix `++`/`--`: the second operator is not an expression-start context.
  if ((last === '+' && prev === '+') || (last === '-' && prev === '-')) {
    return false;
  }
  // Member access: the identifier after `.` is a property name, not a keyword.
  if (last === 'ident' && prev === '.') {
    return false;
  }
  if (last === 'ident') return REGEX_START_KEYWORDS.has(tok);
  return REGEX_START_CONTEXTS.has(last);
}

/**
 * Brace-match forward from the opening `{` at `open` (in an already-blanked
 * source) and return the body slice including both braces, or null when there is
 * no matching close brace.
 * @param {string} source
 * @param {number} open
 * @returns {string | null}
 */
function braceMatch(source, open) {
  let depth = 0;
  let i = open;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Find every named function body in an already-blanked source string: named
 * function declarations (`function poll() { … }`). Returns `{ name, body }`.
 * Function-expression and arrow bindings are handled separately in
 * `e54d6eecLoop`.
 * @param {string} source
 * @returns {Array<{ name: string, body: string }>}
 */
function findFunctionBodies(source) {
  const out = [];
  for (const m of source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    const open = source.indexOf('{', m.index + m[0].length);
    if (open === -1) continue;
    const body = braceMatch(source, open);
    if (body !== null) out.push({ name, body });
  }
  return out;
}

/**
 * The concise (expression) body of an arrow binding: the expression after `=>`
 * up to the first top-level `;` or newline (paren depth respected, so a `;`
 * inside the arguments is not a terminator).
 * @param {string} source
 * @param {number} start
 * @returns {string}
 */
function conciseBody(source, start) {
  let i = start;
  let depth = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0 && (c === ';' || c === '\n')) break;
    i += 1;
  }
  return source.slice(start, i);
}

/**
 * Does `body` (already blanked) contain a `timer`-driven self-reschedule of the
 * function named `name`? Two spellings, both the shape of a poll loop that
 * dodges the `setInterval` check:
 *   - direct:  `timer(name, …)` — `name` is the first argument;
 *   - thunk:   `timer( [async] (params) => [ { ] name( … )` — the arrow
 *     (the first argument) calls the function's own name, i.e. it reschedules
 *     itself. This is the spelling this repo's own poll loop is written in
 *     (`lib/scheduler.js` schedules a beat via `setTimeout(() => fireBeat(…))`).
 * A one-shot `timer(other, …)` (a different first argument, or an arrow that
 * calls a *different* function) is not flagged. The self-reference is matched as
 * a whole token, so a function named `set`/`setup`/`reset` is not matched inside
 * the word `setTimeout`.
 * @param {string} body
 * @param {string} name
 * @param {string} timer
 * @returns {boolean}
 */
function isSelfReschedule(body, name, timer) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Direct form: timer(name, …) with name as the first argument.
  const direct = new RegExp(`\\b${timer}\\s*\\(\\s*${escaped}\\b`);
  // Thunk form: timer( [async] (params) => [ { ] name( … ). The arrow is the
  // first argument and it calls the function's own name. `[^)]*` bounds the
  // arrow's parameter list to the first `)`, so it cannot run past the arrow.
  const thunk = new RegExp(
    `\\b${timer}\\s*\\(\\s*(?:async\\s+)?\\(\\s*[^)]*\\s*\\)\\s*=>\\s*(?:\\{)?\\s*${escaped}\\s*\\(`,
  );
  return direct.test(body) || thunk.test(body);
}

/**
 * The e54d6eec-shaped loop detector: does `source` contain a `timer`-driven
 * self-rescheduling loop? It checks every natural binding form a function can
 * take:
 *   - named function declarations:      `function poll() { …; timer(poll, …); }`
 *   - function-expression bindings:     `const poll = [async] function (… ) { … }`
 *   - arrow bindings, block body:       `const poll = [async] (… ) => { … }`
 *   - arrow bindings, concise body:     `const poll = [async] (… ) => timer(poll, …)`
 * Comments and string/template literals are blanked first, and the self-reference
 * is matched as the first argument of `timer` (a whole token), so legitimate
 * one-shot timers and functions named `set`/`setup`/`reset` are not flagged.
 * @param {string} source
 * @param {string} timer
 * @returns {boolean}
 */
function e54d6eecLoop(source, timer) {
  const blanked = blankCommentsAndStrings(source);
  if (!new RegExp('\\b' + timer + '\\b').test(blanked)) return false;

  // Named function declarations.
  for (const { name, body } of findFunctionBodies(blanked)) {
    if (isSelfReschedule(body, name, timer)) return true;
  }

  // Function-expression bindings: const poll = [async] function (… ) { … }
  for (const m of blanked.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\(/g)) {
    const name = m[1];
    const open = blanked.indexOf('{', m.index + m[0].length);
    if (open === -1) continue;
    const body = braceMatch(blanked, open);
    if (body !== null && isSelfReschedule(body, name, timer)) return true;
  }

  // Arrow bindings with a block body: const poll = [async] (… ) => { … }
  for (const m of blanked.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g)) {
    const name = m[1];
    const open = m.index + m[0].length - 1; // the `{`
    const body = braceMatch(blanked, open);
    if (body !== null && isSelfReschedule(body, name, timer)) return true;
  }

  // Arrow bindings with a concise body: const poll = [async] (… ) => timer(poll, …)
  for (const m of blanked.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?!{)/g)) {
    const name = m[1];
    const start = m.index + m[0].length;
    const body = conciseBody(blanked, start);
    if (isSelfReschedule(body, name, timer)) return true;
  }

  return false;
}

/**
 * The union loop detector: true when either the b202bdeb-shaped detector or the
 * e54d6eec-shaped detector flags a `timer`-driven self-rescheduling loop. A
 * shape caught by either is caught; a shape missed by both is a recorded blind
 * spot. Running both (rather than one) is what makes the union complete: the
 * b202bdeb detector resolves a *directly passed* named helper whose own body
 * calls the function (the unwrapped two-function ping-pong loop) and the
 * `this.name` / `name.bind` method shapes, while the e54d6eec detector blanks
 * comments/strings/regex and recognises the thunk spelling and the
 * division-after-`++`/`--`/`.of` fix.
 */
function hasSelfReschedulingLoop(source, timer) {
  return b202bdebLoop(source, timer) || e54d6eecLoop(source, timer);
}

/**
 * The shipped per-module assertion sites, factored into one helper over a base
 * dir (t_b202bdeb review round 1, Major 1). This is the code the synthetic
 * pins exercise: each pin builds a minimal tree whose only path to the
 * forbidden construct runs through one of these checks, and asserts that
 * `assertServerTreeClean(base)` throws with the matching message. Deleting any
 * check (the import-prefix loop, the token loop, the `setTimeout` assert, the
 * `setImmediate` assert) leaves that pin's tree unflagged, so `assert.throws`
 * fails and the suite goes red. Called with `root` from tests 3 and 4, so the
 * real tree is checked by the *same* code the pins exercise (a deleted check is
 * therefore visible on the pins, not hidden behind a private re-implementation).
 */
function assertServerTreeClean(base) {
  // The forbidden lists are the guard's contract — non-empty and applied.
  assert.ok(FORBIDDEN_IMPORTS.length > 0, 'FORBIDDEN_IMPORTS must be non-empty');
  assert.ok(FORBIDDEN_TOKENS.length > 0, 'FORBIDDEN_TOKENS must be non-empty');

  const { files } = walkServerTree(base);
  assert.ok(files.size > 0, 'expected at least one reachable server-tree module');

  // No reachable module may *be* forbidden code (a route may only reach it
  // transitively through a lib/ helper).
  for (const [file, seed] of files) {
    const rel = file.slice(base.length + 1).replace(/\\/g, '/');
    for (const forbidden of FORBIDDEN_IMPORTS) {
      assert.ok(
        !rel.startsWith(forbidden),
        `${file} is reachable from ${seed} and must not be ${forbidden}* (polling lives in the worker, not the server tree)`,
      );
    }
  }

  // No reachable module may own a forbidden token (`setInterval`) — including
  // lib/ helpers and instrumentation.js, which the pre-widening guard did not
  // scan.
  for (const [file, seed] of files) {
    const source = readFileSync(file, 'utf8');
    for (const token of FORBIDDEN_TOKENS) {
      assert.ok(
        !source.includes(token),
        `${file} is reachable from ${seed} and must not contain ${token} (no polling in the server tree)`,
      );
    }
  }

  // No reachable module may run a `setTimeout` / `setImmediate`
  // self-re-scheduling loop (the shape of a polling loop with the token
  // rotated).
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
}

/**
 * Positive controls for the loop detector (per the existing pattern: prove the
 * guard is looking at the right thing). The bad samples — one per shape the
 * detector claims to cover — must be flagged; the good samples — the real
 * `lib/clock.js` `advance()` one-shot idiom and a one-shot delayed call to a
 * named function — must not.
 */
test('setTimeout/setImmediate loop detector flags the polling shapes and not one-shot timers', () => {
  // Bad: one fixture per shape the detector claims to cover.
  const badArrow = 'const pollLoop = () => { setTimeout(pollLoop, 1000); };\n';
  const badImmediate = 'const spin = () => { setImmediate(spin); };\n';
  const badDeclaration = 'function pollLoop() { setTimeout(pollLoop, 1000); }\n';
  const badWrapped = 'const spin = () => { setTimeout(() => spin(), 1000); };\n';
  const badNamedFnExpr = 'setImmediate(function tick() { setImmediate(tick); });\n';
  const badMethod = 'class Ticker { tick() { setTimeout(this.tick.bind(this), 1000); } } new Ticker().tick();\n';
  // The round-2 regression shape (M10): an expression-bodied arrow (no
  // braces) re-scheduling itself. The round-2 rewrite's `functionBodies`
  // collected only braced forms, so this survived — it must be flagged.
  const badExprArrow = 'const pollLoop = () => setTimeout(pollLoop, 1000);\n';
  const badAsyncExprArrow = 'const pollLoop = async () => setTimeout(pollLoop, 1000);\n';
  // The thunk spelling (t_e54d6eec): the arrow (the first argument to
  // setTimeout) calls the function's own name. This is the shape this repo's
  // own poll loop is written in (`lib/scheduler.js` schedules a beat via
  // `setTimeout(() => fireBeat(…))`), so a poll loop moved into the server
  // tree in this spelling must be caught.
  const badThunk = 'function pollC(){ setTimeout(() => pollC(), 60000); }\n';
  const badThunkArg = 'function pollD(x){ setTimeout(() => pollD(x), 60000); }\n';
  const badThunkBlock = 'function pollE(){ setTimeout(() => { pollE(); }, 60000); }\n';
  const badConciseThunk = 'const pf = () => setTimeout(() => pf(), 60000);\n';
  const badAsyncThunk = 'const pf = async () => { await tick(); setTimeout(async () => pf(), 60000); };\n';
  // The one-hop thunk mutual recursion (the `lib/scheduler.js` shape): the
  // scheduling function passes a *different* function to `setTimeout` and the
  // self-reference is one hop indirect (`scheduleNextBeat` schedules
  // `() => fireBeat(…)` and `fireBeat` calls `scheduleNextBeat`). This was the
  // recorded "mutual recursion through a thunk" blind spot, now resolved.
  const badThunkMutualRecursion = 'function scheduleNextBeat(){ setTimeout(() => fireBeat(1), 1000); }\nfunction fireBeat(i){ scheduleNextBeat(i + 1); }\n';
  // The wrapped mutual recursion (the `mutA` / `mutB` shape) — the direct
  // (`setTimeout(mutB, ms)`) form was always caught; the wrapped
  // (`() => mutB()`) form is the one-hop thunk mutual recursion, now caught.
  const badMutualRecursionWrapped = 'function mutA(){ setTimeout(() => mutB(), 1000); }\nfunction mutB(){ mutA(); }\n';
  // Lost b53fb5f2 fixtures (Minor 3): an async arrow with a block body and a
  // direct self-pass, a function-expression binding, and a `}` inside a string
  // that must not break the brace match.
  const badAsyncArrowBlock = 'const pf = async () => { setTimeout(pf, 1000); };\n';
  const badFnExprBinding = 'const X = function () { setTimeout(X, 1000); };\n';
  const badBraceInString = 'const pf = () => { const s = "}"; setTimeout(pf, 1000); };\n';
  // The e54d6eec-only pin (review round 1, Minor 1): a loop whose scheduling
  // body carries a *regex literal* (`s.replace(/"/g, '&quot;')`). The
  // b202bdeb arm does not blank regex literals, so the `"` inside the literal
  // breaks its paren/brace matching and it misses the loop; the e54d6eec arm
  // blanks the regex and sees the `() => pollR()` thunk. Measured on the
  // union bytes: `b202bdebLoop(S6) === false`, `e54d6eecLoop(S6) === true`.
  // This is the control that only the e54d6eec arm satisfies — deleting the
  // e54d6eec arm from the OR (the "land the sibling alone" hole) makes this
  // assert fail and the suite go red, so the second envelope is pinned.
  const badRegexLiteralInBody = 'function pollR(){ const esc=(s)=>s.replace(/"/g,\'&quot;\'); setTimeout(() => pollR(), 60000); }\n';
  // Good: the real lib/clock.js idiom (a one-shot timer whose callback is the
  // Promise resolver, not a self-referential function) and one-shot delayed
  // calls to a named function. The one-shot calls sit *inside* a function
  // body so the detector's "callback does not refer back" branch is actually
  // exercised (a module-scope call belongs to no collected body and would
  // pass vacuously).
  const goodClock = 'function systemClock() { return { advance(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); } }; }\n';
  const goodOneShot = 'const tick = () => { console.log("once"); };\nfunction start() { setTimeout(tick, 1000); }\n';
  const goodOneShotImmediate = 'const tick = () => { console.log("once"); };\nfunction start() { setImmediate(tick); }\n';

  assert.ok(hasSelfReschedulingLoop(badArrow, 'setTimeout'), 'must flag a setTimeout arrow self-re-scheduling loop');
  assert.ok(hasSelfReschedulingLoop(badImmediate, 'setImmediate'), 'must flag a setImmediate arrow self-re-scheduling loop');
  assert.ok(hasSelfReschedulingLoop(badDeclaration, 'setTimeout'), 'must flag a setTimeout function-declaration self-re-scheduling loop');
  assert.ok(hasSelfReschedulingLoop(badWrapped, 'setTimeout'), 'must flag a setTimeout wrapped-callback self-re-scheduling loop');
  assert.ok(hasSelfReschedulingLoop(badNamedFnExpr, 'setImmediate'), 'must flag a setImmediate named-function-expression self-re-scheduling loop');
  assert.ok(hasSelfReschedulingLoop(badMethod, 'setTimeout'), 'must flag a setTimeout method (this.bind) self-re-scheduling loop');
  assert.ok(hasSelfReschedulingLoop(badExprArrow, 'setTimeout'), 'must flag a setTimeout expression-bodied arrow self-re-scheduling loop (M10 — the round-2 regression)');
  assert.ok(hasSelfReschedulingLoop(badAsyncExprArrow, 'setTimeout'), 'must flag an async expression-bodied arrow self-re-scheduling loop');
  assert.ok(hasSelfReschedulingLoop(badThunk, 'setTimeout'), 'must flag the thunk spelling (the arrow calls the function itself)');
  assert.ok(hasSelfReschedulingLoop(badThunkArg, 'setTimeout'), 'must flag the thunk spelling with an argument');
  assert.ok(hasSelfReschedulingLoop(badThunkBlock, 'setTimeout'), 'must flag the thunk spelling with a block body');
  assert.ok(hasSelfReschedulingLoop(badConciseThunk, 'setTimeout'), 'must flag a concise-body arrow whose body is a self-rescheduling thunk');
  assert.ok(hasSelfReschedulingLoop(badAsyncThunk, 'setTimeout'), 'must flag the async thunk spelling');
  assert.ok(hasSelfReschedulingLoop(badThunkMutualRecursion, 'setTimeout'), 'must flag the one-hop thunk mutual recursion (the lib/scheduler.js shape — the recorded blind spot, now resolved)');
  assert.ok(hasSelfReschedulingLoop(badMutualRecursionWrapped, 'setTimeout'), 'must flag the wrapped mutual recursion (the () => mutB() form, now resolved)');
  assert.ok(hasSelfReschedulingLoop(badAsyncArrowBlock, 'setTimeout'), 'must flag an async arrow with a block body and a direct self-pass (lost b53fb5f2 fixture)');
  assert.ok(hasSelfReschedulingLoop(badFnExprBinding, 'setTimeout'), 'must flag a function-expression binding re-scheduling itself (lost b53fb5f2 fixture)');
  assert.ok(hasSelfReschedulingLoop(badBraceInString, 'setTimeout'), 'must flag a loop whose body carries a } inside a string (lost b53fb5f2 fixture — the string must not break the brace match)');
  assert.ok(hasSelfReschedulingLoop(badRegexLiteralInBody, 'setTimeout'), 'must flag a loop whose scheduling body carries a regex literal (the e54d6eec-only pin — b202bdebLoop misses it, e54d6eecLoop catches it)');

  assert.ok(!hasSelfReschedulingLoop(goodClock, 'setTimeout'), 'must not flag the clock.js one-shot advance() idiom');
  assert.ok(!hasSelfReschedulingLoop(goodOneShot, 'setTimeout'), 'must not flag a one-shot delayed call to a named function');
  assert.ok(!hasSelfReschedulingLoop(goodOneShotImmediate, 'setImmediate'), 'must not flag a one-shot setImmediate call to a named function');

  // The e54d6eec detector's own negative controls: a guard that silently
  // matches nothing is worse than no guard, because it reads as proof.
  assert.ok(
    !hasSelfReschedulingLoop('setTimeout(() => { done(); }, 0);', 'setTimeout'),
    'an anonymous one-shot timer is not a loop',
  );
  assert.ok(
    !hasSelfReschedulingLoop('function later() { setTimeout(other, 10); }', 'setTimeout'),
    'scheduling a different function once is not a loop',
  );
  assert.ok(
    !hasSelfReschedulingLoop('function stop() { clearTimeout(timer); }', 'setTimeout'),
    'clearing a timer is not scheduling one',
  );
  assert.ok(
    !hasSelfReschedulingLoop('export function set(cb) { setTimeout(cb, 1000); }', 'setTimeout'),
    'a function named "set" is not matched inside the word "setTimeout"',
  );
  assert.ok(
    !hasSelfReschedulingLoop('export function schedule(fn, ms) { const scheduled = setTimeout(fn, ms); return scheduled; }', 'setTimeout'),
    'a function named "schedule" is not matched inside "scheduled"',
  );
  assert.ok(
    !hasSelfReschedulingLoop('function scheduleRetryOnce() { /* scheduleRetryOnce … */ setTimeout(() => {}, 250); }', 'setTimeout'),
    'a name that only appears in a comment is not a self-reschedule',
  );
});

test('no module reachable from the server tree is acquisition, scheduler, or worker code', () => {
  // The forbidden lists are the guard's contract — they must be non-empty and
  // must be the very lists the shipped per-module checks apply (t_b202bdeb
  // item 4: pin the token/import layers so deleting them cannot leave 5/5
  // green). The real tree is checked by `assertServerTreeClean(root)` — the
  // same helper the synthetic pins below exercise, so a deleted check is
  // visible on the pins.
  assertServerTreeClean(root);

  // Pin the import grammar (t_b202bdeb item 4): `importSpecifiers` must
  // extract each of its four forms — `import ... from`, bare `import`,
  // dynamic `import(...)` (including the commented form), and `require(...)`
  // — so deleting a pattern cannot leave 5/5 green. `export ... from` is
  // matched by the `from` form.
  {
    const grammarSrc = [
      "import { x } from './a.js';",
      "import './b.js';",
      "const c = await import('./c.js');",
      "const d = await import(/* webpackChunkName: \"x\" */ './d.js');",
      "const e = require('./e.js');",
      "export { f } from './f.js';",
    ].join('\n');
    const specs = importSpecifiers(grammarSrc);
    for (const expected of ['./a.js', './b.js', './c.js', './d.js', './e.js', './f.js']) {
      assert.ok(specs.includes(expected), `importSpecifiers must extract ${expected} (one of its four forms)`);
    }
  }

  // Pin the transitive closure (t_b202bdeb item 4): `lib/store/index.js` is
  // a depth-2 module reached only through the walk's `queue.push(target)` —
  // `app/alerts/page.js` statically imports `lib/web/db.js` (depth 1), and
  // `lib/web/db.js` in turn imports `lib/store/index.js`. Deleting the
  // closure leaves `lib/store/index.js` out of the map, so this fails.
  const files = walkServerTree().files;
  const storeIndex = join(root, 'lib', 'store', 'index.js');
  assert.ok(files.has(storeIndex), 'the walk must reach the depth-2 module lib/store/index.js (transitive closure)');
  const webDb = join(root, 'lib', 'web', 'db.js');
  assert.ok(files.has(webDb), 'the walk must reach the depth-1 module lib/web/db.js');
  assert.notStrictEqual(files.get(storeIndex), storeIndex, 'lib/store/index.js must be reached transitively (its seed is not itself)');

  // Synthetic-tree pins: the real tree has no `setInterval` in any lib/ module
  // and no root `instrumentation.js`, so the token block, the instrumentation
  // seed, and the dynamic-import pattern are each vacuous on the real tree
  // (deleting any of them leaves 5/5 green — the measured residual). Each pin
  // below builds a minimal tree where the only path to the forbidden token
  // runs through the layer being pinned, so deleting that layer turns the
  // suite red (t_b202bdeb item 4).

  // Pin 1 — the token block: a lib module reached *statically* owns
  // `setInterval`; only the token loop can see it. Positive control: the
  // shipped token loop (inside `assertServerTreeClean`) must flag the
  // fixture, so deleting the token block (or `FORBIDDEN_TOKENS`) leaves the
  // tree unflagged and `assert.throws` fails — the suite goes red.
  {
    const base = mkdtempSync(join(tmpdir(), 'guard-token-'));
    try {
      mkdirSync(join(base, 'app'));
      mkdirSync(join(base, 'lib'));
      writeFileSync(join(base, 'app', 'index.js'), 'import { a } from "../lib/a.js";\n');
      writeFileSync(join(base, 'lib', 'a.js'), 'export function a() { setInterval(() => {}, 1000); }\n');
      const t = walkServerTree(base).files;
      const target = join(base, 'lib', 'a.js');
      assert.ok(t.has(target), 'the statically-reached lib module must be in the walked set');
      assert.throws(
        () => assertServerTreeClean(base),
        /must not contain setInterval \(no polling in the server tree\)/,
        'the shipped token block must flag a statically-reached lib module that owns setInterval (positive control)',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // Pin 2 — the instrumentation seed: a root `instrumentation.js` (the only
  // seed) owns `setInterval`; only the seed loop puts it into the map, and
  // only the token loop flags it. Positive control: the shipped helper must
  // flag the seeded file, so deleting the seed (the file never reaches the
  // map) or the token block leaves the tree unflagged and `assert.throws`
  // fails — the suite goes red.
  {
    const base = mkdtempSync(join(tmpdir(), 'guard-instr-'));
    try {
      writeFileSync(join(base, 'instrumentation.js'), 'setInterval(() => {}, 1000);\n');
      const t = walkServerTree(base).files;
      const target = join(base, 'instrumentation.js');
      assert.ok(t.has(target), 'the root instrumentation.js must be seeded into the walked set (positive control for the seed layer)');
      assert.throws(
        () => assertServerTreeClean(base),
        /must not contain setInterval \(no polling in the server tree\)/,
        'the shipped token block must flag the seeded instrumentation.js that owns setInterval (positive control)',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // Pin 3 — the dynamic-import pattern: the lib module is reached *only*
  // through a commented `import(...)`; only the dynamic-import pattern
  // follows it, and only the token loop flags it. Positive control: the
  // shipped helper must flag the reached module, so deleting the pattern
  // (the module never reaches the map) or the token block leaves the tree
  // unflagged and `assert.throws` fails — the suite goes red.
  {
    const base = mkdtempSync(join(tmpdir(), 'guard-dynimp-'));
    try {
      mkdirSync(join(base, 'app'));
      mkdirSync(join(base, 'lib'));
      writeFileSync(join(base, 'app', 'index.js'), 'const m = await import(/* webpackChunkName: "x" */ "../lib/a.js");\n');
      writeFileSync(join(base, 'lib', 'a.js'), 'export function a() { setInterval(() => {}, 1000); }\n');
      const t = walkServerTree(base).files;
      const target = join(base, 'lib', 'a.js');
      assert.ok(t.has(target), 'the dynamically-reached lib module must be in the walked set (positive control for the dynamic-import pattern)');
      assert.throws(
        () => assertServerTreeClean(base),
        /must not contain setInterval \(no polling in the server tree\)/,
        'the shipped token block must flag a dynamically-reached lib module that owns setInterval (positive control)',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // Pin 4 — the `resolveImport` widening (t_b202bdeb item 3 + review round 2,
  // Minor 1): a lib module is reached *only* through an extensionless dynamic
  // import that resolves to a `.mjs` file, a `.ts` file, a `.jsx` file, and
  // a directory that resolves to `index.mjs`. Reverting the candidate list to
  // the pre-widening `[base, base.js, index.js]` (or dropping the `.ts` /
  // `.jsx` entries) leaves all four targets unresolved (never in the walked
  // set), so the token block never sees them and `assertServerTreeClean` does
  // not throw — `assert.throws` fails and the suite goes red. The widened
  // candidate list (`.mjs` / `.jsx` / `.ts` and `index.mjs`) is what follows
  // them.
  //
  // (t_b202bdeb approval Minor: the original "all four targets unresolved"
  // quantifier was loose — a single drop leaves one. The pin now asserts all
  // four targets are in the walked set *individually*, so dropping any single
  // candidate (`.mjs`, `.ts`, `.jsx`, or `index.mjs`) leaves that one target
  // unresolved and the corresponding `assert.ok` fails — the suite goes red.)
  {
    const base = mkdtempSync(join(tmpdir(), 'guard-resolve-'));
    try {
      mkdirSync(join(base, 'app'));
      mkdirSync(join(base, 'lib'));
      mkdirSync(join(base, 'lib', 'b'));
      writeFileSync(join(base, 'app', 'index.js'), 'const m = await import("../lib/a");\nconst n = await import("../lib/b");\nconst o = await import("../lib/c");\nconst p = await import("../lib/d");\n');
      writeFileSync(join(base, 'lib', 'a.mjs'), 'export function a() { setInterval(() => {}, 1000); }\n');
      writeFileSync(join(base, 'lib', 'b', 'index.mjs'), 'export function b() { setInterval(() => {}, 1000); }\n');
      writeFileSync(join(base, 'lib', 'c.ts'), 'export function c() { setInterval(() => {}, 1000); }\n');
      writeFileSync(join(base, 'lib', 'd.jsx'), 'export function d() { setInterval(() => {}, 1000); }\n');
      const t = walkServerTree(base).files;
      const targetA = join(base, 'lib', 'a.mjs');
      const targetB = join(base, 'lib', 'b', 'index.mjs');
      const targetC = join(base, 'lib', 'c.ts');
      const targetD = join(base, 'lib', 'd.jsx');
      assert.ok(t.has(targetA), 'the extensionless dynamic import must resolve to a.mjs (positive control for the resolveImport widening)');
      assert.ok(t.has(targetB), 'the directory dynamic import must resolve to b/index.mjs (positive control for the resolveImport widening)');
      assert.ok(t.has(targetC), 'the extensionless dynamic import must resolve to c.ts (positive control for the resolveImport widening)');
      assert.ok(t.has(targetD), 'the extensionless dynamic import must resolve to d.jsx (positive control for the resolveImport widening)');
      assert.throws(
        () => assertServerTreeClean(base),
        /must not contain setInterval \(no polling in the server tree\)/,
        'the shipped token block must flag the .mjs / .ts / .jsx / index.mjs modules reached through the widened resolver (positive control)',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // Pin 5 — the import-prefix layer (t_b202bdeb review round 2, Major 1 +
  // item 4 "FORBIDDEN_IMPORTS ... applied"): a lib module that *is* forbidden
  // code (`lib/acquire/poll.js`) is reached through a route. No other check
  // can see it — it owns no `setInterval` and runs no loop — so only the
  // import-prefix loop over the walked closure flags it. Positive control: the
  // shipped import-prefix loop (inside `assertServerTreeClean`) must flag the
  // reached module, so deleting that loop (or `FORBIDDEN_IMPORTS`) leaves the
  // tree unflagged and `assert.throws` fails — the suite goes red.
  {
    const base = mkdtempSync(join(tmpdir(), 'guard-prefix-'));
    try {
      mkdirSync(join(base, 'app'));
      mkdirSync(join(base, 'lib', 'acquire'), { recursive: true });
      writeFileSync(join(base, 'app', 'index.js'), 'import { p } from "../lib/acquire/poll.js";\n');
      writeFileSync(join(base, 'lib', 'acquire', 'poll.js'), 'export function p() {}\n');
      const t = walkServerTree(base).files;
      const target = join(base, 'lib', 'acquire', 'poll.js');
      assert.ok(t.has(target), 'the statically-reached lib/acquire module must be in the walked set');
      assert.throws(
        () => assertServerTreeClean(base),
        /must not be lib\/acquire\/\* /,
        'the shipped import-prefix loop must flag a reached forbidden module (positive control for the import-prefix layer)',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test('no reachable server-tree module runs a setTimeout/setImmediate self-re-scheduling loop', () => {
  // The real tree is checked by the same shipped helper the pins below
  // exercise (the `setTimeout` / `setImmediate` loop asserts live inside
  // `assertServerTreeClean`), so deleting either assert is visible here and
  // on the pin.
  assertServerTreeClean(root);

  // Pin the tree-level `setImmediate` assert (t_b202bdeb item 4): no reachable
  // module in the real tree runs a `setImmediate` self-re-scheduling loop, so
  // deleting the `setImmediate` assert leaves 5/5 green. A synthetic tree
  // where a lib module is reached statically and runs the loop is a positive
  // control: the shipped `setImmediate` assert (inside `assertServerTreeClean`)
  // must flag it, so deleting the assert (or the detector's `setImmediate`
  // branch) leaves the tree unflagged and `assert.throws` fails — the suite
  // goes red.
  {
    const base = mkdtempSync(join(tmpdir(), 'guard-imm-'));
    try {
      mkdirSync(join(base, 'app'));
      mkdirSync(join(base, 'lib'));
      writeFileSync(join(base, 'app', 'index.js'), 'import { a } from "../lib/a.js";\n');
      writeFileSync(join(base, 'lib', 'a.js'), 'export const spin = () => { setImmediate(spin); };\n');
      const t = walkServerTree(base).files;
      const target = join(base, 'lib', 'a.js');
      assert.ok(t.has(target), 'the statically-reached lib module must be in the walked set');
      assert.throws(
        () => assertServerTreeClean(base),
        /must not run a setImmediate self-re-scheduling loop/,
        'the shipped setImmediate assert must flag a statically-reached lib module running a setImmediate self-re-scheduling loop (positive control)',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // Pin the tree-level `setTimeout` assert (t_b202bdeb review round 2, Major 1):
  // no reachable module in the real tree runs a `setTimeout` self-re-scheduling
  // loop, so deleting the `setTimeout` assert leaves 5/5 green. A synthetic tree
  // where a lib module is reached statically and runs the loop is a positive
  // control: the shipped `setTimeout` assert (inside `assertServerTreeClean`)
  // must flag it, so deleting the assert (or the detector's `setTimeout` branch)
  // leaves the tree unflagged and `assert.throws` fails — the suite goes red.
  {
    const base = mkdtempSync(join(tmpdir(), 'guard-timeout-'));
    try {
      mkdirSync(join(base, 'app'));
      mkdirSync(join(base, 'lib'));
      writeFileSync(join(base, 'app', 'index.js'), 'import { a } from "../lib/a.js";\n');
      writeFileSync(join(base, 'lib', 'a.js'), 'export const poll = () => { setTimeout(poll, 1000); };\n');
      const t = walkServerTree(base).files;
      const target = join(base, 'lib', 'a.js');
      assert.ok(t.has(target), 'the statically-reached lib module must be in the walked set');
      assert.throws(
        () => assertServerTreeClean(base),
        /must not run a setTimeout self-re-scheduling loop/,
        'the shipped setTimeout assert must flag a statically-reached lib module running a setTimeout self-re-scheduling loop (positive control)',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // Pin the one-hop thunk mutual recursion — the `lib/scheduler.js` shape,
  // relocated verbatim to a non-`lib/scheduler*` server-tree path (review
  // round 1, blocking Major + the card's named survivor #1). The relocated
  // body is written into `lib/web/scheduler-echo.js` (a path that does NOT
  // start with `lib/scheduler`, so the import-prefix check does not fire)
  // and reached through a route's import. The only mechanism that can see it
  // is the loop detector resolving the one-hop thunk mutual recursion
  // (`scheduleNextBeat` schedules `() => fireBeat(…)` and `fireBeat` calls
  // `scheduleNextBeat`). Deleting the detector's mutual-recursion resolution
  // (or the `setTimeout` assert) leaves the relocated module unflagged and
  // `assert.throws` fails — the suite goes red. This is the faithful
  // construction the earlier round measured (`cp lib/scheduler.js
  // lib/web/scheduler-echo.js` + an import from a walked file), which the
  // union's pre-fix bytes left green (exit 0, 7/7 pass).
  {
    const base = mkdtempSync(join(tmpdir(), 'guard-schedreloc-'));
    try {
      mkdirSync(join(base, 'app'));
      mkdirSync(join(base, 'lib', 'web'), { recursive: true });
      writeFileSync(join(base, 'app', 'index.js'), 'import { createScheduler } from "../lib/web/scheduler-echo.js";\n');
      // The `lib/scheduler.js` shape, relocated to a non-`lib/scheduler*`
      // path: `scheduleNextBeat` schedules `() => fireBeat(…)` and
      // `fireBeat` calls `scheduleNextBeat` — a one-hop-indirect self
      // reference through a thunk.
      const schedulerBody = `export function createScheduler({ setTimeout, intervalMs, task, log = () => {} }) {
  let timerId = null;
  function scheduleNextBeat(nextIndex) {
    timerId = setTimeout(() => fireBeat(nextIndex), intervalMs);
  }
  function fireBeat(nextIndex) {
    task(nextIndex);
    scheduleNextBeat(nextIndex + 1);
  }
  return { start() { scheduleNextBeat(1); }, stop() {} };
}
`;
      writeFileSync(join(base, 'lib', 'web', 'scheduler-echo.js'), schedulerBody);
      const t = walkServerTree(base).files;
      const target = join(base, 'lib', 'web', 'scheduler-echo.js');
      assert.ok(t.has(target), 'the relocated scheduler module must be in the walked set (reached through the route import)');
      // The relocated path does not start with `lib/scheduler`, so the
      // import-prefix check cannot see it — only the loop detector can.
      assert.ok(!target.slice(base.length + 1).startsWith('lib/scheduler'), 'the relocated path must not start with lib/scheduler (so only the loop detector can flag it)');
      assert.throws(
        () => assertServerTreeClean(base),
        /must not run a setTimeout self-re-scheduling loop/,
        'the shipped loop detector must flag the relocated scheduler body (the one-hop thunk mutual recursion — the recorded blind spot, now resolved)',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

// The e54d6eec detector's division-regression pin (review round 3, Major 2): a
// division whose left operand ends in a postfix `++`/`--` or in a member access
// (`.of`) used to be read as a regex-literal start (the second `+`/`-` is an
// expression-start context, and a keyword-shaped token after `.` was read as a
// keyword). The phantom literal then blanked forward to the next `/` — or to
// EOF when there was none — hiding any loop after it. These controls prove the
// division is treated as division, so a real self-rescheduling loop that follows
// is still caught.
test('a division after a postfix operator or member access does not hide a later self-rescheduling loop (division-regression pin)', () => {
  assert.ok(
    hasSelfReschedulingLoop('function f(){ const hits = 1; const total = 2; const r = hits++ / total; setTimeout(f, 1000); }', 'setTimeout'),
    'a division whose left operand ends in a postfix ++ is not a regex start, so the loop after it is caught',
  );
  assert.ok(
    hasSelfReschedulingLoop('function f(){ const slots = 1; const total = 2; const r = slots-- / total; setTimeout(f, 1000); }', 'setTimeout'),
    'a division whose left operand ends in a postfix -- is not a regex start, so the loop after it is caught',
  );
  assert.ok(
    hasSelfReschedulingLoop('function f(){ const counts = { of: 1 }; const total = 2; const r = counts.of / total; setTimeout(f, 1000); }', 'setTimeout'),
    'a member-access operand (counts.of) is not a keyword, so the division is not a regex start and the loop after it is caught',
  );
  assert.ok(
    hasSelfReschedulingLoop('function f(){ const a = 1; const b = 2; const q3 = a / b; setTimeout(f, 1000); }', 'setTimeout'),
    'a plain division is not a regex start, so the loop after it is caught',
  );
  // And the inverse: a one-shot timer that merely sits after a division is not
  // flagged (the division does not corrupt the token stream into a false loop).
  assert.ok(
    !hasSelfReschedulingLoop('function f(){ const hits = 1; const total = 2; const r = hits++ / total; setTimeout(other, 1000); }', 'setTimeout'),
    'a one-shot timer after a division is not a loop',
  );
});

// The e54d6eec detector's file-level pin for the regex-literal blanking fix
// (review round 2, Major 1): `app/rules/[id]/mute/route.js` carries an ordinary
// HTML escaper (`s.replace(/"/g, '&quot;')`), and a quote inside a regex literal
// used to be read as a string delimiter, blanking the file to EOF and hiding any
// loop appended after it. This test reads the real file, appends a
// self-rescheduling loop, and asserts the detector catches it — the exact "a poll
// loop parked in a route handler" scenario the guard exists for.
test('a quote inside a regex literal must not hide a later self-rescheduling loop (file-level pin)', () => {
  const mutePath = join(root, 'app', 'rules', '[id]', 'mute', 'route.js');
  const source = readFileSync(mutePath, 'utf8');
  assert.ok(
    /replace\(\/"/.test(source) || /replace\(\/'/.test(source),
    'precondition: the mute route carries a regex-literal HTML escaper (the case this pin protects)',
  );
  const withLoop = `${source}\nfunction pollMute(){ setTimeout(pollMute, 60000); }\npollMute();\n`;
  assert.ok(
    hasSelfReschedulingLoop(withLoop, 'setTimeout'),
    'a self-rescheduling loop appended after the regex-literal escaper in app/rules/[id]/mute/route.js must be caught',
  );
  assert.ok(
    !hasSelfReschedulingLoop(source, 'setTimeout'),
    'the pristine mute route (no loop) is not flagged',
  );
});

test('worker/main.js imports lib/acquire/poll.js (positive control)', () => {
  const workerMain = join(root, 'worker', 'main.js');
  const source = readFileSync(workerMain, 'utf8');
  assert.ok(
    source.includes('lib/acquire/poll.js'),
    'worker/main.js must import lib/acquire/poll.js — the guard is only meaningful if the worker owns the poll loop',
  );
});
