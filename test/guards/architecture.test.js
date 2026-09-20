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
 * in the real tree; the mutants below are documentation, not applied code).
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
 * Known limitation (recorded, not a defect): `FORBIDDEN_TOKENS` is matched as
 * a raw substring against every reachable module. A comment or string literal
 * that merely mentions `setInterval` in a `lib/**` file would trip the guard
 * (a false positive, not a false negative — it makes the guard stricter, never
 * looser). The same brittleness exists for `app/**` from card 1.
 *
 * The loop detector is a hand-rolled source scanner, so it covers the shapes
 * above and a *recorded set of blind spots* it does not. These are not
 * false negatives of the guard's stated contract (they are polling-loop
 * shapes the detector does not reason about), and each is recorded here so a
 * later card can close it deliberately rather than by accident:
 *   - object-literal method: `const o = { tick() { setTimeout(o.tick, 1000); } };`
 *     — `callbackReferences` tests `this.NAME` / `NAME.bind`, not `o.NAME`.
 *   - alias indirection: `const s = () => { setTimeout(ref, 1000); }; const ref = s;`
 *   - wrapped mutual recursion: `function mutA(){ setTimeout(() => mutB(), 1000); }
 *     function mutB(){ mutA(); }` — the direct (`setTimeout(mutB, ms)`) form
 *     is caught, the wrapped (`() => mutB()`) form is not.
 *   - `node:timers/promises` awaited loop: `while (true) { await waitMs(5000); }`
 *     where `waitMs` is `import { setTimeout as waitMs } from 'node:timers/promises'`
 *     — no `setInterval` token and no self-referential callback, so neither
 *     mechanism sees it. (This shape is outside the card's three holes and
 *     outside requirement 2's `setTimeout`/`setImmediate` naming; it is scope,
 *     not a weakening — no prior revision of this file ever covered it.)
 *   - `queueMicrotask(spin)` recursion — no timer token at all.
 * The header's "that is its entire purpose" therefore applies to the three
 * holes and the `setTimeout`/`setImmediate` shapes above, not to the blind
 * spots in this list.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// `fileURLToPath(new URL('../..', ...))` returns a path ending in a separator
// on POSIX (e.g. `.../OzBargainHunter/`), so `file.slice(root.length + 1)`
// would drop the first character of the relative path (`lib/web/db.js` ->
// `ib/web/db.js`) and every `rel.startsWith('lib/acquire/')` check below
// would be permanently false. `resolve()` strips the trailing separator, so
// `file.slice(root.length + 1)` yields the correct repo-relative path.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

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
 * present, then follow relative imports. Returns `{ files }` where `files` is
 * a map of reached absolute path -> the seed that first reached it.
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
 * True when the scheduled callback refers back to `name` — the function whose
 * body schedules it. Covers a direct self-pass (`setTimeout(name, ms)`), a
 * wrapped callback that calls it (`setTimeout(() => name(), ms)`), a
 * `this.name` / `name.bind` binding (a method re-scheduling itself), and a
 * *directly* passed named helper whose own body calls it (the unwrapped
 * two-function ping-pong loop, `setTimeout(mutB, ms)` where `mutB` calls
 * `name`). The *wrapped* mutual-recursion variant — `setTimeout(() => mutB(),
 * ms)` where `mutB` calls `name` — is a recorded blind spot (the callback is
 * an anonymous arrow, so the helper lookup below does not apply).
 */
function callbackReferences(callback, name, source) {
  const idMatch = /^([A-Za-z_$][\w$]*)$/.exec(callback);
  if (idMatch !== null) {
    if (idMatch[1] === name) return true;
    const gBody = functionBodyFor(idMatch[1], source);
    if (gBody !== null && new RegExp('\\b' + name + '\\s*\\(|this\\.' + name + '\\b|\\b' + name + '\\s*\\.bind\\b').test(gBody)) {
      return true;
    }
    return false;
  }
  return new RegExp('\\b' + name + '\\s*\\(|this\\.' + name + '\\b|\\b' + name + '\\s*\\.bind\\b').test(callback);
}

/**
 * True when `source` contains a function whose body schedules `timer`
 * (setTimeout or setImmediate) with a callback that refers back to it — a
 * self-re-scheduling loop, i.e. a polling loop that avoids the literal
 * `setInterval` token. A one-shot `setTimeout(fn, ms)` where `fn` never refers
 * back to the scheduling function is not flagged.
 */
function hasSelfReschedulingLoop(source, timer) {
  for (const { name, body } of functionBodies(source)) {
    for (const callback of timerFirstArgs(body, timer)) {
      if (callbackReferences(callback, name, source)) return true;
    }
  }
  return false;
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

  assert.ok(!hasSelfReschedulingLoop(goodClock, 'setTimeout'), 'must not flag the clock.js one-shot advance() idiom');
  assert.ok(!hasSelfReschedulingLoop(goodOneShot, 'setTimeout'), 'must not flag a one-shot delayed call to a named function');
  assert.ok(!hasSelfReschedulingLoop(goodOneShotImmediate, 'setImmediate'), 'must not flag a one-shot setImmediate call to a named function');
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
