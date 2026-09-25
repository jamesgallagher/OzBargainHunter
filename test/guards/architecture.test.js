/**
 * The architecture guard. The poll loop lives in a separate worker process,
 * never in the Next.js server tree. This file is the permanent static guard
 * for that boundary: a Node built-in `node:test` file that performs static
 * source analysis only — it never imports or executes an application module,
 * it is offline/deterministic, and it writes no repo files (synthetic
 * fixtures live under `os.tmpdir()` and are removed in `finally`).
 *
 * The contract (fixed by the card):
 *   - Server-tree seeds: every source file under `app/**`, the root
 *     `middleware.js`, a root `instrumentation.js`/`instrumentation.mjs` if
 *     present, and the root `next.config.mjs`. Source extensions:
 *     `.js`/`.mjs`/`.jsx`/`.ts`/`.tsx`.
 *   - Follow relative import forms: import-from, bare `import`, dynamic
 *     `import()`, `require()`, and `export ... from`. Resolve a plain path,
 *     a source extension (`.js`/`.mjs`/`.jsx`/`.ts`/`.tsx`), and a
 *     directory `index.js`/`index.mjs`. Fail closed on an unresolved
 *     relative import (the walk throws).
 *   - Walk the full transitive closure. Deny based on the *resolved
 *     destination path*, so a re-export shim cannot launder a denied module.
 *   - Denied destinations: `lib/acquire/**`, `lib/http/**`, `lib/parse/**`,
 *     `lib/rules/**`, `lib/scheduler.js`, `worker/**`.
 *   - Allowed families: `lib/clock.js`, `lib/config.js`, `lib/csrf.js`,
 *     `lib/notify/**`, `lib/random.js`, `lib/store/**`, `lib/time.js`,
 *     `lib/web/**`.
 *   - Every source file under `lib/**` and `worker/**` is classified exactly
 *     once; an unclassified file fails by name.
 *   - For closure files only: reject the `setInterval` token after comments
 *     are blanked (strings remain — a string that names the token trips the
 *     guard: a false positive, stricter, never looser); reject a
 *     self-rescheduling `setTimeout`/`setImmediate` loop — the named direct
 *     pass, the arrow block and concise bodies, the thunk callback, the
 *     one-hop thunk mutual recursion, the named function expression, and the
 *     class-method self-reschedule via `this.tick.bind(this)`; and reject
 *     bare imports of `child_process`, `worker_threads`, `timers`,
 *     `timers/promises` and their `node:` variants.
 *   - One-shot timers are legal. Worker polling/timers are legal: `worker/**`
 *     is a denied *destination* (it can never enter the closure), and worker
 *     files are never scanned for loops.
 *
 * The loop detector is a hand-rolled source scanner, the union of two arms,
 * so a poll loop moved into the server tree in either spelling fails the
 * guard:
 *   - the b202bdeb-shaped arm resolves a *directly passed* named helper
 *     whose own body calls the scheduling function (the unwrapped
 *     two-function ping-pong loop), the `this.name` / `name.bind` method
 *     shapes, and the named function expression;
 *   - the e54d6eec-shaped arm blanks comments, string/template literals, and
 *     regex literals before brace matching (so a `}` inside a string, a
 *     quote inside a regex literal, or a name in a comment cannot fool the
 *     self-reference test), and recognises the thunk spelling
 *     (`setTimeout(() => name(), …)` — the shape this repo's own
 *     `lib/scheduler.js` schedules a beat in) plus the one-hop thunk mutual
 *     recursion (`scheduleNextBeat` schedules `() => fireBeat(…)` and
 *     `fireBeat` calls `scheduleNextBeat`).
 * A shape caught by either arm is caught; a shape missed by both is one of
 * the recorded blind spots below.
 *
 * Detector blind spots (recorded, not a defect — each is a polling shape the
 * detector does not reason about, recorded so a later card can close it
 * deliberately rather than by accident):
 *   - a timer reached through a local alias or parameter binding:
 *     `const timer = setTimeout;` then `timer(pollLoop, 1000)`; a defaulted
 *     parameter `startPoll({ timer = setTimeout } = {})` (the DI idiom
 *     `lib/scheduler.js` itself uses); `setTimeout.apply(null, [fn, ms])`;
 *     `Reflect.apply(setTimeout, null, [...])` — the detector keys on the
 *     literal `setTimeout` / `setImmediate` call text.
 *   - `setInterval` via a computed key: `const KEY = 'set' + 'Interval';
 *     globalThis[KEY](…)` — the token check sees the literal `setInterval`
 *     only; a token built by string concatenation is not seen.
 *   - a `node:timers/promises` awaited loop (`while (true) { await
 *     waitMs(5000); }`): the *import* of `node:timers/promises` is denied
 *     by the bare-import layer, so the shape cannot enter the server tree
 *     through that import; a local `waitMs` alias defined elsewhere is still
 *     blind.
 *   - `queueMicrotask(spin)` recursion — no timer token at all.
 *   - `process.nextTick` recursion — `nextTick` is not a `setTimeout` /
 *     `setImmediate` token.
 *   - a cross-module loop: a `setTimeout` in one reachable module whose
 *     callback calls a function defined in *another* reachable module — the
 *     detector reasons per module, so a self-re-schedule split across two
 *     modules is not seen by either.
 *   - an expression-bodied outer with a braced inner callback:
 *     `const poll = () => setTimeout(() => { poll() }, 1000);` — the
 *     concise-body collection stops at the inner `{`. (Verified below: if a
 *     later revision of the detector catches it, move this note to the
 *     fixture list.)
 *
 * If a later change moves polling into a route, a `lib/web/*` helper, or
 * `instrumentation.js`, this test fails. That is its entire purpose.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';

// `resolve()` strips the trailing separator that `fileURLToPath(new
// URL('../..', …))` leaves on POSIX, so `file.slice(base.length + 1)`
// yields the correct base-relative path.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.jsx', '.ts', '.tsx']);

// The guard's contract — non-empty and applied by `assertServerTreeClean`.
const DENIED_FAMILIES = ['lib/acquire/', 'lib/http/', 'lib/parse/', 'lib/rules/', 'lib/scheduler.js', 'worker/'];
const ALLOWED_FAMILIES = ['lib/clock.js', 'lib/config.js', 'lib/csrf.js', 'lib/env-secret.js', 'lib/gate/', 'lib/notify/', 'lib/random.js', 'lib/store/', 'lib/time.js', 'lib/web/'];
const FORBIDDEN_TOKENS = ['setInterval'];
const DENIED_BARE_IMPORTS = new Set([
  'child_process',
  'node:child_process',
  'worker_threads',
  'node:worker_threads',
  'timers',
  'node:timers',
  'timers/promises',
  'node:timers/promises',
]);

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

/** True when `file` has one of the contract's source extensions. */
function isSourceFile(file) {
  return SOURCE_EXTENSIONS.has(extname(file));
}

/** The base-relative POSIX path of `file` under `base`. */
function relPath(base, file) {
  return file.slice(base.length + 1).replace(/\\/g, '/');
}

/**
 * Does `rel` (a base-relative path) match `family`? A family ending in `/`
 * is a directory prefix; otherwise it is an exact file name.
 * @param {string} rel
 * @param {string} family
 * @returns {boolean}
 */
function familyMatches(rel, family) {
  if (family.endsWith('/')) return rel.startsWith(family);
  return rel === family;
}

/**
 * Every base-relative source file under `base/lib` and `base/worker`.
 * @param {string} base
 * @returns {string[]}
 */
function listLibWorkerRelPaths(base) {
  const out = [];
  for (const sub of ['lib', 'worker']) {
    const dir = join(base, sub);
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      for (const file of listFiles(dir)) {
        if (isSourceFile(file)) out.push(relPath(base, file));
      }
    }
  }
  return out;
}

/**
 * The classification invariant: every source file under `lib/**` and
 * `worker/**` is classified exactly once (exactly one of the denied or
 * allowed families). An unclassified file fails by name; a file matching
 * more than one family also fails.
 * @param {string} base
 */
function classifyTree(base) {
  const rels = listLibWorkerRelPaths(base);
  // An empty set is classified vacuously: a tree with no lib/worker files
  // (a seed-only fixture) has nothing to fail by name, so it proceeds to the
  // walk and token checks. The real-tree test below separately asserts the
  // set is non-empty, so the invariant is still enforced where it matters.
  for (const rel of rels) {
    const deniedCount = DENIED_FAMILIES.filter((f) => familyMatches(rel, f)).length;
    const allowedCount = ALLOWED_FAMILIES.filter((f) => familyMatches(rel, f)).length;
    assert.ok(
      deniedCount + allowedCount === 1,
      `${rel} is not classified exactly once (denied matches: ${deniedCount}, allowed matches: ${allowedCount}) — every source file under lib/ and worker/ must be exactly one family`,
    );
  }
}

/**
 * Extract import specifiers from a module's source: static
 * `import ... from '...'`, bare `import '...'`, dynamic `import('...')`,
 * CommonJS `require('...')`, and `export ... from '...'` re-exports. All
 * specifiers (relative and bare) are returned — the walk follows the
 * relative ones, and the bare-import check tests the full list.
 *
 * The dynamic-import pattern tolerates a block comment between the `(` and
 * the specifier (and after it), so a dynamic import whose argument list
 * carries a webpack chunk-name block comment is followed. The comment is
 * consumed before the specifier's opening quote, so a quote inside the
 * comment (the webpack chunk name) is not mistaken for the specifier
 * delimiter.
 * @param {string} source
 * @returns {string[]}
 */
function importSpecifiers(source) {
  const specs = [];
  // `(?:\/\*[\s\S]*?\*\/\s*)*` = zero or more block comments (with
  // surrounding whitespace), so a webpack chunk-name comment does not hide
  // the specifier.
  const comment = '(?:\\/\\*[\\s\\S]*?\\*\\/\\s*)*';
  // `sep` = any run of whitespace and/or block and/or line comments. A legal
  // comment placed between the `import` keyword and a bare specifier (e.g.
  // `import /* boundary */ "./x.js"` or `import // note\n"./x.js"`) must not
  // hide the specifier, so the bare pattern tolerates `sep` there. (`comment`
  // is block-only and is used by the dynamic-import pattern; `sep`
  // additionally covers line comments and plain whitespace.)
  const sep = '(?:\\s|\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*\\n?)*';
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    new RegExp(`\\bimport${sep}['"]([^'"]+)['"]`, 'g'),
    new RegExp(`\\bimport\\s*\\(\\s*${comment}['"]([^'"]+)['"]\\s*${comment}\\)`, 'g'),
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s+(?:\{[^}]*\}|\*)\s+from\s+['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      specs.push(m[1]);
    }
  }
  return specs;
}

/**
 * Resolve a relative specifier against the importing file's directory to an
 * absolute path, trying the plain path, with a source extension appended
 * (`.js`/`.mjs`/`.jsx`/`.ts`/`.tsx`), and as a directory with an
 * `index.js`/`index.mjs`. **Fails closed**: throws when the target does not
 * resolve to an existing file (a path that only resolves at bundle time, a
 * typo, or a deleted module must not silently drop out of the guard).
 * @param {string} importerFile
 * @param {string} spec
 * @returns {string}
 */
function resolveImport(importerFile, spec) {
  const base = resolve(dirname(importerFile), spec);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.jsx`,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.js'),
    join(base, 'index.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  throw new Error(`unresolved relative import "${spec}" in ${importerFile} (fail closed)`);
}

/**
 * Walk the transitive server tree: seed with every source file under
 * `app/`, the root `middleware.js`, a root `instrumentation.js` /
 * `instrumentation.mjs` if present, and the root `next.config.mjs`, then
 * follow relative imports (all five forms). Returns `{ files }` where
 * `files` is a map of reached absolute path -> the seed that first reached
 * it. Throws on an unresolved relative import (fail closed).
 * @param {string} [base]
 * @returns {{ files: Map<string, string> }}
 */
function walkServerTree(base = root) {
  const seeds = [];
  const appDir = join(base, 'app');
  if (existsSync(appDir) && statSync(appDir).isDirectory()) {
    for (const file of listFiles(appDir)) {
      if (isSourceFile(file)) seeds.push(file);
    }
  }
  for (const name of ['middleware.js', 'instrumentation.js', 'instrumentation.mjs', 'next.config.mjs']) {
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
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      const target = resolveImport(current, spec);
      if (files.has(target)) continue;
      files.set(target, files.get(current));
      queue.push(target);
    }
  }
  return { files };
}

// ---------------------------------------------------------------------------
// Lexer: blanking comments (strings remain) for the `setInterval` token check.
// Strings and regex literals are *recognised* (so a `//` inside a string is
// not read as a comment) but not blanked — per the contract, the token check
// runs on source with comments blanked while strings remain.
// ---------------------------------------------------------------------------

/**
 * Punctuation after which a `/` opens a regex literal (an expression-start
 * context). Every other token — an identifier/number, `)`, `]`, a string, a
 * regex literal, `<`, `>`, `.` — is a division operator.
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
 * significant tokens? Two contexts that look like expression-start but are
 * not:
 *   - a postfix `++`/`--` — the second operator is not an expression-start
 *     context, so `hits++ / total` divides;
 *   - a member access — the identifier after `.` is a property name, not a
 *     keyword, so `counts.of / total` divides.
 * @param {string} last
 * @param {string} tok the pending identifier/keyword, if `last` is 'ident'
 * @param {string} prev the significant token before `last`
 * @returns {boolean}
 */
function canStartRegex(last, tok, prev) {
  if (last === '') return true; // start of source
  if ((last === '+' && prev === '+') || (last === '-' && prev === '-')) {
    return false;
  }
  if (last === 'ident' && prev === '.') {
    return false;
  }
  if (last === 'ident') return REGEX_START_KEYWORDS.has(tok);
  return REGEX_START_CONTEXTS.has(last);
}

/**
 * Blank out the contents of comments (line and block) so that an identifier
 * or the word `setInterval` inside a comment cannot trip the token check,
 * while strings and regex literals remain (a string that names the token
 * trips the guard: a false positive, stricter, never looser). Strings and
 * regex literals are recognised — via the `canStartRegex` token state, so a
 * `//` inside a string is not read as a comment — but left in place.
 * Returns a string of the same length as `source` (comment bodies replaced
 * by spaces; newlines preserved).
 * @param {string} source
 * @returns {string}
 */
function blankCommentsOnly(source) {
  const out = source.split('');
  const n = source.length;
  let i = 0;
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
    // Block comment: `/*` is likewise unambiguous. Blank to the closing `*/`,
    // keeping newlines. As with a line comment, it leaves the token state
    // untouched.
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
    // String / template literal: recognised (so a `//` inside it is not read
    // as a comment) but left in place — strings remain.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        i += 1;
        if (c === quote) break;
      }
      last = 'string';
      tok = '';
      continue;
    }
    // Regex literal: a `/` that can start one (decided from the preceding
    // significant token) is skipped through to its unescaped closing `/`,
    // honouring `\` escapes and `[...]` character classes, and left in place.
    if (ch === '/' && canStartRegex(last, tok, prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const c = source[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']' && inClass) inClass = false;
        if (c === '/' && !inClass) {
          j += 1;
          break;
        }
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

// ---------------------------------------------------------------------------
// The b202bdeb-shaped loop detector arm: resolves a *directly passed* named
// helper whose own body calls the scheduling function (the unwrapped
// two-function ping-pong loop), the `this.name` / `name.bind` method shapes,
// and the named function expression.
// ---------------------------------------------------------------------------

/**
 * Skip past a string literal that starts at `source[i]` (one of `"`, `'`, or
 * a backtick). Returns the index just past the closing quote.
 */
function skipString(source, i) {
  const quote = source[i];
  i += 1;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') { i += 2; continue; }
    if (c === quote) { return i + 1; }
    i += 1;
  }
  return i;
}

/**
 * Return the contents of the block whose opening `{` is at `openIdx`,
 * skipping strings and line or block comments so a brace inside a string or
 * comment does not break the match. Returns null when unbalanced.
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
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIdx + 1, i);
    }
    i += 1;
  }
  return null;
}

/**
 * Return the contents of the argument list whose opening `(` is at
 * `openIdx`, skipping strings and comments. Returns null when unbalanced.
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
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openIdx + 1, i);
    }
    i += 1;
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
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
    i += 1;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

/**
 * Extract the body of a function defined as `name` in `source`. Handles the
 * shapes a polling loop is most likely to use: a `function name(...)`
 * declaration, an arrow bound to `name` (with or without a parameter list),
 * a `function` expression bound to `name`, and a `name(...)` method. Returns
 * the body text (block contents, or the expression for an expression-bodied
 * arrow), or null when `name` is not defined as a function in this module.
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
 * declarations, arrow/function-expression bindings, and methods.
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
  const assignRe = /\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s+)?\(([^)]*)\)\s*=>\s*\{/g;
  while ((m = assignRe.exec(source)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const body = matchBlock(source, openIdx);
    if (body !== null) add(m[1], body);
  }
  // Expression-bodied arrow: `name = (...) => expr` (no braces). The body is
  // the expression up to the terminating `;` or newline — a single
  // expression never contains `;`, and a leading `{` means a braced body
  // (handled by the `assignRe` above). This is the shape
  // `const pollExpr = () => setTimeout(pollExpr, 1000);` (and its async
  // form) must be collected so its timer is examined.
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
 * True when the scheduled callback refers back to `name` — the function
 * whose body schedules it. Covers a direct self-pass (`setTimeout(name, ms)`),
 * a wrapped callback that calls it (`setTimeout(() => name(), ms)`), a
 * `this.name` / `name.bind` binding (a method re-scheduling itself), a
 * *directly* passed named helper whose own body calls it (the unwrapped
 * two-function ping-pong loop, `setTimeout(mutB, ms)` where `mutB` calls
 * `name`), and — the one-hop thunk mutual recursion this repo's own
 * `lib/scheduler.js` is written in — a *wrapped* callback that calls a
 * *different* module-local function `g` whose own body calls `name`
 * (`setTimeout(() => fireBeat(…), ms)` where `fireBeat` calls
 * `scheduleNextBeat`).
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
  // calls `name`? That is the one-hop thunk mutual recursion — the shape
  // this repo's own `lib/scheduler.js` schedules a beat in.
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
// The e54d6eec-shaped loop detector: blanks comments, string/template
// literals, and regex literals before brace matching (so a `}` inside a
// string, a quote inside a regex literal, or a name in a comment cannot fool
// the self-reference test), and recognises the thunk spelling
// (`setTimeout(() => name(), …)`) plus the one-hop thunk mutual recursion.
// `canStartRegex` takes the *previous* token, so a division whose left
// operand ends in a postfix `++`/`--` or a member access (`.of`) is not
// misread as a regex-literal start and blanking the file to EOF.
// ---------------------------------------------------------------------------

/**
 * Blank out the contents of comments, string/template literals, and regex
 * literals so that a `{`, `}`, identifier, quote, or the word `setTimeout`
 * inside them cannot affect brace matching or the self-reference test.
 * Returns a string of the same length as `source` (bodies replaced by spaces;
 * newlines preserved).
 * @param {string} source
 * @returns {string}
 */
function blankCommentsAndStrings(source) {
  const out = source.split('');
  const n = source.length;
  let i = 0;
  let last = '';
  let prev = '';
  let tok = '';
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    // Line comment: recognised in any context. Blank to end of line (keep the
    // newline). A comment is whitespace-equivalent, so it leaves the token
    // state (`last`, `tok`) untouched.
    if (ch === '/' && next === '/') {
      let j = i;
      while (j < n && source[j] !== '\n') {
        out[j] = ' ';
        j += 1;
      }
      i = j;
      continue;
    }
    // Block comment: blank to the closing `*/`, keeping newlines.
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
    // String / template literal: blank to the matching quote, honouring
    // escapes.
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
    // the token and becomes `last` itself.
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
 * Brace-match forward from the opening `{` at `open` (in an already-blanked
 * source) and return the body slice including both braces, or null when there
 * is no matching close brace.
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
 * The concise (expression) body of an arrow binding: the expression after
 * `=>` up to the first top-level `;` or newline (paren depth respected, so a
 * `;` inside the arguments is not a terminator).
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
 * Does `body` (already blanked) contain a `timer`-driven self-reschedule of
 * the function named `name`? Two spellings, both the shape of a poll loop
 * that dodges the `setInterval` check:
 *   - direct:  `timer(name, …)` — `name` is the first argument;
 *   - thunk:   `timer( [async] (params) => [ { ] name( … )` — the arrow
 *     (the first argument) calls the function's own name, i.e. it
 *     reschedules itself. This is the spelling this repo's own poll loop is
 *     written in (`lib/scheduler.js` schedules a beat via
 *     `setTimeout(() => fireBeat(…))`).
 * A one-shot `timer(other, …)` (a different first argument, or an arrow that
 * calls a *different* function) is not flagged. The self-reference is
 * matched as a whole token, so a function named `set`/`setup`/`reset` is not
 * matched inside the word `setTimeout`.
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
 * Comments and string/template literals are blanked first, and the
 * self-reference is matched as the first argument of `timer` (a whole token),
 * so legitimate one-shot timers and functions named `set`/`setup`/`reset` are
 * not flagged.
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
 * The union loop detector: true when either the b202bdeb-shaped detector or
 * the e54d6eec-shaped detector flags a `timer`-driven self-rescheduling loop.
 * A shape caught by either is caught; a shape missed by both is a recorded
 * blind spot.
 */
function hasSelfReschedulingLoop(source, timer) {
  return b202bdebLoop(source, timer) || e54d6eecLoop(source, timer);
}

// ---------------------------------------------------------------------------
// The shipped per-tree assertion site, factored into one helper over a base
// dir. This is the code the synthetic pins exercise: each pin builds a
// minimal tree whose only path to the forbidden construct runs through one
// of these checks, and asserts that `assertServerTreeClean(base)` throws with
// the matching message. Deleting any check (the classification loop, the
// import-prefix loop, the token loop, the `setTimeout` assert, the
// `setImmediate` assert, the bare-import loop) leaves that pin's tree
// unflagged, so `assert.throws` fails and the suite goes red. Called with
// `root` from the real-tree tests, so the real tree is checked by the *same*
// code the pins exercise (a deleted check is therefore visible on the pins,
// not hidden behind a private re-implementation).
// ---------------------------------------------------------------------------

/**
 * Assert the full architecture contract over `base`: the classification
 * invariant (every source file under `lib/**` and `worker/**` is classified
 * exactly once), the transitive walk (failing closed on an unresolved
 * relative import), the denied-destination check (by resolved path), the
 * `setInterval` token check (comments blanked, strings remain), the
 * `setTimeout` / `setImmediate` self-rescheduling loop check, and the
 * denied-bare-import check.
 * @param {string} base
 */
function assertServerTreeClean(base) {
  // The forbidden lists are the guard's contract — non-empty and applied.
  assert.ok(DENIED_FAMILIES.length > 0, 'DENIED_FAMILIES must be non-empty');
  assert.ok(ALLOWED_FAMILIES.length > 0, 'ALLOWED_FAMILIES must be non-empty');
  assert.ok(FORBIDDEN_TOKENS.length > 0, 'FORBIDDEN_TOKENS must be non-empty');
  assert.ok(DENIED_BARE_IMPORTS.size > 0, 'DENIED_BARE_IMPORTS must be non-empty');

  // The classification invariant: every source file under lib/** and
  // worker/** is classified exactly once; an unclassified file fails by name.
  classifyTree(base);

  const { files } = walkServerTree(base);
  assert.ok(files.size > 0, 'expected at least one reachable server-tree module');

  // No reachable module may *be* denied code (a route may only reach it
  // transitively through a lib/ helper). The check is on the *resolved*
  // destination path, so a re-export shim cannot launder a denied module.
  for (const [file, seed] of files) {
    const rel = relPath(base, file);
    const seedRel = relPath(base, seed);
    const denied = DENIED_FAMILIES.filter((f) => familyMatches(rel, f));
    assert.ok(
      denied.length === 0,
      `${rel} is reachable from ${seedRel} and is denied (${denied[0]} — worker-owned code must not enter the server tree)`,
    );
  }

  // No reachable module may own a forbidden token (`setInterval`) — the token
  // check runs on source with comments blanked while strings remain, so a
  // comment naming the token does not trip the guard but a string that
  // names it does (a false positive, stricter, never looser).
  for (const [file, seed] of files) {
    const source = readFileSync(file, 'utf8');
    const noComments = blankCommentsOnly(source);
    for (const token of FORBIDDEN_TOKENS) {
      assert.ok(
        !noComments.includes(token),
        `${relPath(base, file)} is reachable from ${relPath(base, seed)} and must not contain ${token} (no polling in the server tree)`,
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
      `${relPath(base, file)} is reachable from ${relPath(base, seed)} and must not run a setTimeout self-re-scheduling loop (a self-re-scheduling timer is a polling loop with the token rotated)`,
    );
    assert.ok(
      !hasSelfReschedulingLoop(source, 'setImmediate'),
      `${relPath(base, file)} is reachable from ${relPath(base, seed)} and must not run a setImmediate self-re-scheduling loop (a self-re-scheduling timer is a polling loop with the token rotated)`,
    );
  }

  // No reachable module may import a denied bare module (`child_process`,
  // `worker_threads`, `timers`, `timers/promises` and their `node:`
  // variants) — the timer/scheduler primitives are worker-owned.
  for (const [file, seed] of files) {
    const source = readFileSync(file, 'utf8');
    for (const spec of importSpecifiers(source)) {
      assert.ok(
        !DENIED_BARE_IMPORTS.has(spec),
        `${relPath(base, file)} is reachable from ${relPath(base, seed)} and must not import ${spec} (denied bare module in the server tree)`,
      );
    }
  }
}

/**
 * Build a synthetic tree under `os.tmpdir()`, run `fn(base)` against it, and
 * always remove it (the guard writes no repo files).
 * @param {string} prefix
 * @param {(base: string) => void} fn
 */
function withTree(prefix, fn) {
  const base = mkdtempSync(join(tmpdir(), prefix));
  try {
    fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// C16 (tree level, real tree): the real closure carries the *allowed*
// families — `lib/store/**` and `lib/notify/**` are reached through the
// routes, and the one-shot timer idioms they use (the `lib/clock.js`
// `advance()` resolver, the delayed one-shot calls) are legal. Passing the
// real tree below is the proof that allowed store/notify imports and one-shot
// timers do not trip the guard.
test('the Next.js server tree is clean: no denied module reachable, no forbidden token, no self-rescheduling loop, no denied bare import', () => {
  assertServerTreeClean(root);
});

// C14: the classification invariant — every source file under `lib/**` and
// `worker/**` in the real tree is classified exactly once (the helper
// enforces this; deleting the classification loop or a family entry leaves an
// unclassified file unflagged — the synthetic pins below make that red).
test('every source file under lib/ and worker/ is classified exactly once', () => {
  classifyTree(root);

  // The real tree must actually exercise both sides of the invariant: at
  // least one denied and one allowed file, so the family lists are not
  // vacuous.
  const rels = listLibWorkerRelPaths(root);
  assert.ok(rels.some((rel) => DENIED_FAMILIES.some((f) => familyMatches(rel, f))), 'the real tree must contain at least one denied file');
  assert.ok(rels.some((rel) => ALLOWED_FAMILIES.some((f) => familyMatches(rel, f))), 'the real tree must contain at least one allowed file');

  // Negative control: an unclassified file fails by name.
  withTree('guard-classify-bad-', (base) => {
    mkdirSync(join(base, 'app'));
    mkdirSync(join(base, 'lib'));
    writeFileSync(join(base, 'app', 'index.js'), 'export const ok = true;\n');
    writeFileSync(join(base, 'lib', 'orphan.js'), 'export const orphan = true;\n');
    assert.throws(
      () => assertServerTreeClean(base),
      /lib\/orphan\.js is not classified exactly once/,
      'an unclassified file under lib/ must fail by name (positive control for the classification invariant)',
    );
  });

  // Unmutated twin: the same tree with every lib file classified (an allowed
  // family) passes.
  withTree('guard-classify-good-', (base) => {
    mkdirSync(join(base, 'app'));
    mkdirSync(join(base, 'lib'));
    writeFileSync(join(base, 'app', 'index.js'), 'export const ok = true;\n');
    writeFileSync(join(base, 'lib', 'clock.js'), 'export const clock = () => 0;\n');
    assertServerTreeClean(base);
  });
});

// C5: the import grammar — `importSpecifiers` must extract each of the five
// relative import forms, so deleting a pattern cannot leave the suite green.
test('import extraction covers the five relative import forms (import-from, bare import, dynamic import, require, export-from)', () => {
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
    assert.ok(specs.includes(expected), `importSpecifiers must extract ${expected} (one of the five forms)`);
  }

  // The `export ... from` form must also be *followed* into the closure — a
  // re-export shim cannot launder a denied module (the deny is on the
  // resolved destination path). Negative control: a shim that re-exports a
  // denied module is flagged.
  withTree('guard-exportfrom-bad-', (base) => {
    mkdirSync(join(base, 'app'));
    mkdirSync(join(base, 'lib', 'acquire'), { recursive: true });
    writeFileSync(join(base, 'app', 'index.js'), 'export { p } from "../lib/acquire/poll.js";\n');
    writeFileSync(join(base, 'lib', 'acquire', 'poll.js'), 'export function p() {}\n');
    assert.throws(
      () => assertServerTreeClean(base),
      /lib\/acquire\/poll\.js is reachable from app\/index\.js and is denied/,
      'a re-export shim cannot launder a denied module (the deny is on the resolved destination path)',
    );
  });

  // Unmutated twin: the same shim re-exporting an allowed module passes.
  withTree('guard-exportfrom-good-', (base) => {
    mkdirSync(join(base, 'app'));
    mkdirSync(join(base, 'lib', 'web'), { recursive: true });
    writeFileSync(join(base, 'app', 'index.js'), 'export { p } from "../lib/web/db.js";\n');
    writeFileSync(join(base, 'lib', 'web', 'db.js'), 'export function p() {}\n');
    assertServerTreeClean(base);
  });
});

// C4: the transitive closure follows dynamic imports (including the commented
// webpack-chunk-name form) and reaches depth-2 modules.
test('the transitive closure follows dynamic imports and reaches depth-2 modules', () => {
  // Real tree: `lib/store/index.js` is a depth-2 module reached only through
  // the walk's queue — `app/layout.js` statically imports `lib/web/db.js`
  // (depth 1), and `lib/web/db.js` in turn imports `lib/store/index.js`.
  // Deleting the closure (the `queue.push(target)`) leaves it out of the map.
  const files = walkServerTree(root).files;
  const storeIndex = join(root, 'lib', 'store', 'index.js');
  assert.ok(files.has(storeIndex), 'the walk must reach the depth-2 module lib/store/index.js (transitive closure)');
  const webDb = join(root, 'lib', 'web', 'db.js');
  assert.ok(files.has(webDb), 'the walk must reach the depth-1 module lib/web/db.js');
  assert.notStrictEqual(files.get(storeIndex), storeIndex, 'lib/store/index.js must be reached transitively (its seed is not itself)');

  // Negative control: a lib module reached *only* through a commented dynamic
  // import, at depth 2, owns `setInterval`; only the dynamic-import pattern
  // follows it, and only the token loop flags it.
  withTree('guard-dynimp-bad-', (base) => {
    mkdirSync(join(base, 'app'));
    mkdirSync(join(base, 'lib', 'web'), { recursive: true });
    writeFileSync(join(base, 'app', 'index.js'), 'const m = await import(/* webpackChunkName: "x" */ "../lib/web/a.js");\n');
    writeFileSync(join(base, 'lib', 'web', 'a.js'), "import { b } from './b.js';\nexport { b };\n");
    writeFileSync(join(base, 'lib', 'web', 'b.js'), 'export function b() { setInterval(() => {}, 1000); }\n');
    const t = walkServerTree(base).files;
    const target = join(base, 'lib', 'web', 'b.js');
    assert.ok(t.has(target), 'the depth-2 module reached through a commented dynamic import must be in the walked set');
    assert.throws(
      () => assertServerTreeClean(base),
      /must not contain setInterval \(no polling in the server tree\)/,
      'the shipped token block must flag a depth-2 module reached through a dynamic import (positive control)',
    );
  });

  // Unmutated twin: the same tree with a one-shot timer in the depth-2 module
  // passes.
  withTree('guard-dynimp-good-', (base) => {
    mkdirSync(join(base, 'app'));
    mkdirSync(join(base, 'lib', 'web'), { recursive: true });
    writeFileSync(join(base, 'app', 'index.js'), 'const m = await import(/* webpackChunkName: "x" */ "../lib/web/a.js");\n');
    writeFileSync(join(base, 'lib', 'web', 'a.js'), "import { b } from './b.js';\nexport { b };\n");
    writeFileSync(join(base, 'lib', 'web', 'b.js'), 'export function b() { setTimeout(() => {}, 1000); }\n');
    assertServerTreeClean(base);
  });
});

// C17 (fail closed): an unresolved relative import must throw, not silently
// drop out of the guard.
test('an unresolved relative import fails closed', () => {
  withTree('guard-unresolved-bad-', (base) => {
    mkdirSync(join(base, 'app'));
    writeFileSync(join(base, 'app', 'index.js'), "import { x } from '../lib/missing.js';\n");
    assert.throws(
      () => walkServerTree(base),
      /unresolved relative import "\.\.\/lib\/missing\.js"/,
      'an unresolved relative import must fail closed (the walk throws)',
    );
  });

  // Unmutated twin: the same tree with the target present resolves and walks
  // cleanly.
  withTree('guard-unresolved-good-', (base) => {
    mkdirSync(join(base, 'app'));
    mkdirSync(join(base, 'lib'));
    writeFileSync(join(base, 'app', 'index.js'), "import { x } from '../lib/missing.js';\n");
    writeFileSync(join(base, 'lib', 'missing.js'), 'export const x = 1;\n');
    const t = walkServerTree(base).files;
    assert.ok(t.has(join(base, 'lib', 'missing.js')), 'the resolved relative import must be in the walked set');
  });
});

// C1: denied destinations are rejected by resolved path — a direct import of a
// denied module from a seed is flagged.
test('denied destinations are rejected by resolved path (a direct import of a denied module is flagged)', () => {
  withTree('guard-denied-bad-', (base) => {
    mkdirSync(join(base, 'app'));
    mkdirSync(join(base, 'lib', 'acquire'), { recursive: true });
    writeFileSync(join(base, 'app', 'index.js'), 'import { p } from "../lib/acquire/poll.js";\n');
    writeFileSync(join(base, 'lib', 'acquire', 'poll.js'), 'export function p() {}\n');
    const t = walkServerTree(base).files;
    const target = join(base, 'lib', 'acquire', 'poll.js');
    assert.ok(t.has(target), 'the statically-reached denied module must be in the walked set');
    assert.throws(
      () => assertServerTreeClean(base),
      /lib\/acquire\/poll\.js is reachable from app\/index\.js and is denied/,
      'the shipped import-prefix check must flag a reached denied module (positive control for the denied-destination layer)',
    );
  });

  // Unmutated twin: the same tree importing an allowed module passes.
  withTree('guard-denied-good-', (base) => {
    mkdirSync(join(base, 'app'));
    mkdirSync(join(base, 'lib', 'web'), { recursive: true });
    writeFileSync(join(base, 'app', 'index.js'), 'import { p } from "../lib/web/db.js";\n');
    writeFileSync(join(base, 'lib', 'web', 'db.js'), 'export function p() {}\n');
    assertServerTreeClean(base);
  });
});

// C18 (the card's correction): a LEGAL commented bare import of a denied
// module must be followed and denied. `importSpecifiers` tolerates a block
// comment between the `import` keyword and the specifier, so a denied
// destination reached through the commented spelling cannot slip past the
// guard (the pre-fix bypass: `import /* boundary */ "./lib/acquire/poll.js"`
// was legal JS but dropped by the walk, letting the denied module in).
test('a commented bare import of a denied module is followed and denied (the legal comment-between-tokens spelling)', () => {
  withTree('guard-commentbare-bad-', (base) => {
    writeFileSync(join(base, 'middleware.js'), 'import { NextResponse } from "next/server.js";\nimport /* boundary */ "./lib/acquire/poll.js";\n');
    mkdirSync(join(base, 'lib', 'acquire'), { recursive: true });
    writeFileSync(join(base, 'lib', 'acquire', 'poll.js'), 'export function runDealPoll() {}\n');
    const t = walkServerTree(base).files;
    const target = join(base, 'lib', 'acquire', 'poll.js');
    assert.ok(t.has(target), 'the denied module reached through a commented bare import must be in the walked set (the import is followed)');
    assert.throws(
      () => assertServerTreeClean(base),
      /lib\/acquire\/poll\.js is reachable from middleware\.js and is denied/,
      'the shipped guard must flag a denied module reached through a legal commented bare import (the pre-fix bypass is closed)',
    );
  });

  // Unmutated twin: the same commented bare import of an *allowed* module
  // passes — the comment is legal and the destination is allowed.
  withTree('guard-commentbare-good-', (base) => {
    writeFileSync(join(base, 'middleware.js'), 'import { NextResponse } from "next/server.js";\nimport /* boundary */ "./lib/web/db.js";\n');
    mkdirSync(join(base, 'lib', 'web'), { recursive: true });
    writeFileSync(join(base, 'lib', 'web', 'db.js'), 'export function getStore() {}\n');
    assertServerTreeClean(base);
  });
});

// C2 + C3: seed and transitive `setInterval` — a seed file (the root
// `middleware.js`, the root `instrumentation.js`) and a transitively reached
// module that owns the token are each flagged.
test('seed and transitive setInterval are rejected (middleware seed, instrumentation seed, depth-2)', () => {
  // Pin — the `middleware.js` seed: the only seed owns `setInterval`; only
  // the seed loop puts it into the map, and only the token loop flags it.
  withTree('guard-seed-bad-', (base) => {
    writeFileSync(join(base, 'middleware.js'), 'setInterval(() => {}, 1000);\n');
    const t = walkServerTree(base).files;
    assert.ok(t.has(join(base, 'middleware.js')), 'the root middleware.js must be seeded into the walked set (positive control for the seed layer)');
    assert.throws(
      () => assertServerTreeClean(base),
      /must not contain setInterval \(no polling in the server tree\)/,
      'the shipped token block must flag the seeded middleware.js that owns setInterval (positive control)',
    );
  });

  // Unmutated twin: the same tree with a one-shot timer in the seed passes.
  withTree('guard-seed-good-', (base) => {
    writeFileSync(join(base, 'middleware.js'), 'setTimeout(() => {}, 1000);\n');
    assertServerTreeClean(base);
  });

  // Pin — the `instrumentation.js` seed: the only seed owns `setInterval`.
  withTree('guard-instr-bad-', (base) => {
    writeFileSync(join(base, 'instrumentation.js'), 'setInterval(() => {}, 1000);\n');
    const t = walkServerTree(base).files;
    assert.ok(t.has(join(base, 'instrumentation.js')), 'the root instrumentation.js must be seeded into the walked set (positive control for the instrumentation seed layer)');
    assert.throws(
      () => assertServerTreeClean(base),
      /must not contain setInterval \(no polling in the server tree\)/,
      'the shipped token block must flag the seeded instrumentation.js that owns setInterval (positive control)',
    );
  });

  // Unmutated twin: a clean instrumentation.js passes.
  withTree('guard-instr-good-', (base) => {
    writeFileSync(join(base, 'instrumentation.js'), 'export function register() {}\n');
    assertServerTreeClean(base);
  });

  // Pin — the instrumentation seed reaching a *denied* module: a root
  // `instrumentation.js` that imports `lib/rules/engine.js` (denied) is
  // flagged by the denied-destination check on the resolved path.
  withTree('guard-instr-deny-bad-', (base) => {
    mkdirSync(join(base, 'lib', 'rules'), { recursive: true });
    writeFileSync(join(base, 'instrumentation.js'), "import { engine } from './lib/rules/engine.js';\nexport { engine };\n");
    writeFileSync(join(base, 'lib', 'rules', 'engine.js'), 'export function engine() {}\n');
    assert.throws(
      () => assertServerTreeClean(base),
      /lib\/rules\/engine\.js is reachable from instrumentation\.js and is denied/,
      'the instrumentation seed reaching a denied module must be flagged on the resolved path (positive control for the instrumentation seed/deny layer)',
    );
  });

  // Unmutated twin: the same import from an allowed module passes.
  withTree('guard-instr-deny-good-', (base) => {
    mkdirSync(join(base, 'lib', 'web'), { recursive: true });
    writeFileSync(join(base, 'instrumentation.js'), "import { db } from './lib/web/db.js';\nexport { db };\n");
    writeFileSync(join(base, 'lib', 'web', 'db.js'), 'export function db() {}\n');
    assertServerTreeClean(base);
  });
});

// C6: denied bare imports — `child_process`, `worker_threads`, `timers`,
// `timers/promises` and their `node:` variants are rejected in closure files.
test('denied bare imports are rejected (child_process, worker_threads, timers, timers/promises, node: variants)', () => {
  for (const [label, importLine] of [
    ['child_process', "import { exec } from 'child_process';"],
    ['node:child_process', "import { exec } from 'node:child_process';"],
    ['worker_threads', "import { Worker } from 'worker_threads';"],
    ['node:worker_threads', "import { Worker } from 'node:worker_threads';"],
    ['timers', "const { setTimeout } = require('timers');"],
    ['node:timers', "import { setTimeout } from 'node:timers';"],
    ['timers/promises', "import { setTimeout } from 'timers/promises';"],
    ['node:timers/promises', "import { setTimeout } from 'node:timers/promises';"],
  ]) {
    withTree(`guard-bare-${label.replace(/[^a-z0-9]/g, '-')}-bad-`, (base) => {
      mkdirSync(join(base, 'app'));
      mkdirSync(join(base, 'lib', 'web'), { recursive: true });
      writeFileSync(join(base, 'app', 'index.js'), 'import { a } from "../lib/web/a.js";\n');
      writeFileSync(join(base, 'lib', 'web', 'a.js'), `${importLine}\nexport const a = 1;\n`);
      assert.throws(
        () => assertServerTreeClean(base),
        new RegExp(`must not import ${label.replace(/[/]/g, '\\/')}`),
        `the shipped bare-import check must flag a closure file importing ${label} (positive control)`,
      );
    });
  }

  // Unmutated twin: the same tree importing an allowed bare module (`node:fs`)
  // passes.
  withTree('guard-bare-good-', (base) => {
    mkdirSync(join(base, 'app'));
    mkdirSync(join(base, 'lib', 'web'), { recursive: true });
    writeFileSync(join(base, 'app', 'index.js'), 'import { a } from "../lib/web/a.js";\n');
    writeFileSync(join(base, 'lib', 'web', 'a.js'), "import { readFileSync } from 'node:fs';\nexport const a = readFileSync;\n");
    assertServerTreeClean(base);
  });
});

// C7-C13 (detector level): the loop detector flags the self-rescheduling
// shapes and not one-shot timers. Each bad fixture is paired with its legal
// twin (the unmutated control).
test('the loop detector flags self-rescheduling shapes and not one-shot timers', () => {
  // C7 — the named direct pass.
  assert.ok(hasSelfReschedulingLoop('function pollLoop() { setTimeout(pollLoop, 1000); }\n', 'setTimeout'), 'must flag a setTimeout function-declaration self-re-scheduling loop (named direct pass)');
  assert.ok(!hasSelfReschedulingLoop('const tick = () => { console.log("once"); };\nfunction start() { setTimeout(tick, 1000); }\n', 'setTimeout'), 'a one-shot delayed call to a different named function is not a loop (twin of the named direct pass)');

  // C8 — the arrow block and concise bodies.
  assert.ok(hasSelfReschedulingLoop('const pollLoop = () => { setTimeout(pollLoop, 1000); };\n', 'setTimeout'), 'must flag a setTimeout arrow block-body self-re-scheduling loop');
  assert.ok(hasSelfReschedulingLoop('const pollLoop = () => setTimeout(pollLoop, 1000);\n', 'setTimeout'), 'must flag a setTimeout arrow concise-body self-re-scheduling loop');
  assert.ok(hasSelfReschedulingLoop('const pollLoop = async () => setTimeout(pollLoop, 1000);\n', 'setTimeout'), 'must flag an async concise-body arrow self-re-scheduling loop');
  assert.ok(hasSelfReschedulingLoop('const pollLoop = async () => { setTimeout(pollLoop, 1000); };\n', 'setTimeout'), 'must flag an async arrow block-body self-re-scheduling loop');
  assert.ok(!hasSelfReschedulingLoop('const tick = () => { console.log("once"); };\nfunction start() { setTimeout(tick, 1000); }\n', 'setTimeout'), 'a one-shot delayed call to a named function is not a loop (twin of the arrow shapes)');

  // C9 — the thunk spelling (the arrow, the first argument, calls the
  // function itself — the shape this repo's own poll loop is written in).
  assert.ok(hasSelfReschedulingLoop('function pollC(){ setTimeout(() => pollC(), 60000); }\n', 'setTimeout'), 'must flag the thunk spelling (the arrow calls the function itself)');
  assert.ok(hasSelfReschedulingLoop('function pollD(x){ setTimeout(() => pollD(x), 60000); }\n', 'setTimeout'), 'must flag the thunk spelling with an argument');
  assert.ok(hasSelfReschedulingLoop('function pollE(){ setTimeout(() => { pollE(); }, 60000); }\n', 'setTimeout'), 'must flag the thunk spelling with a block body');
  assert.ok(hasSelfReschedulingLoop('const pf = () => setTimeout(() => pf(), 60000);\n', 'setTimeout'), 'must flag a concise-body arrow whose body is a self-rescheduling thunk');
  assert.ok(hasSelfReschedulingLoop('const pf = async () => { await tick(); setTimeout(async () => pf(), 60000); };\n', 'setTimeout'), 'must flag the async thunk spelling');
  assert.ok(!hasSelfReschedulingLoop('setTimeout(() => { done(); }, 0);\n', 'setTimeout'), 'an anonymous one-shot timer is not a loop (twin of the thunk shapes)');
  assert.ok(!hasSelfReschedulingLoop('function later() { setTimeout(other, 10); }\n', 'setTimeout'), 'scheduling a different function once is not a loop (twin of the thunk shapes)');

  // C10 — the one-hop thunk mutual recursion (the `lib/scheduler.js` shape):
  // the scheduling function passes a *different* function to `setTimeout` and
  // the self-reference is one hop indirect.
  assert.ok(hasSelfReschedulingLoop('function scheduleNextBeat(){ setTimeout(() => fireBeat(1), 1000); }\nfunction fireBeat(i){ scheduleNextBeat(i + 1); }\n', 'setTimeout'), 'must flag the one-hop thunk mutual recursion (the lib/scheduler.js shape)');
  assert.ok(hasSelfReschedulingLoop('function mutA(){ setTimeout(() => mutB(), 1000); }\nfunction mutB(){ mutA(); }\n', 'setTimeout'), 'must flag the wrapped mutual recursion (the () => mutB() form)');
  assert.ok(hasSelfReschedulingLoop('function mutA(){ setTimeout(mutB, 1000); }\nfunction mutB(){ mutA(); }\n', 'setTimeout'), 'must flag the direct-pass mutual recursion (the setTimeout(mutB, ms) form)');
  // Twin: the same shape with the recursion broken (fireBeat never calls back)
  // is not a loop.
  assert.ok(!hasSelfReschedulingLoop('function scheduleNextBeat(){ setTimeout(() => fireBeat(1), 1000); }\nfunction fireBeat(i){ task(i); }\n', 'setTimeout'), 'a thunk whose callee never calls back is not a loop (twin of the one-hop mutual recursion)');

  // C12 — the setImmediate, named function expression, and class-method
  // shapes.
  assert.ok(hasSelfReschedulingLoop('const spin = () => { setImmediate(spin); };\n', 'setImmediate'), 'must flag a setImmediate arrow self-re-scheduling loop');
  assert.ok(hasSelfReschedulingLoop('setImmediate(function tick() { setImmediate(tick); });\n', 'setImmediate'), 'must flag a setImmediate named-function-expression self-re-scheduling loop');
  assert.ok(hasSelfReschedulingLoop('class Ticker { tick() { setTimeout(this.tick.bind(this), 1000); } } new Ticker().tick();\n', 'setTimeout'), 'must flag a setTimeout class-method (this.bind) self-re-scheduling loop');
  assert.ok(hasSelfReschedulingLoop('const X = function () { setTimeout(X, 1000); };\n', 'setTimeout'), 'must flag a function-expression binding re-scheduling itself');
  // Twins: one-shot setImmediate and a class method that does not bind itself.
  assert.ok(!hasSelfReschedulingLoop('const tick = () => { console.log("once"); };\nfunction start() { setImmediate(tick); }\n', 'setImmediate'), 'a one-shot setImmediate call to a named function is not a loop (twin of the setImmediate shapes)');
  assert.ok(!hasSelfReschedulingLoop('class Ticker { tick() { console.log("once"); } } new Ticker().tick();\n', 'setTimeout'), 'a class method that does not self-bind is not a loop (twin of the class-method shape)');

  // C13 — lexer robustness: a quote inside a regex literal and a `}` inside a
  // string must not break the blanking / brace matching.
  assert.ok(hasSelfReschedulingLoop('function pollR(){ const esc=(s)=>s.replace(/"/g, \'&quot;\'); setTimeout(() => pollR(), 60000); }\n', 'setTimeout'), 'must flag a loop whose scheduling body carries a quote inside a regex literal (the e54d6eec arm blanks the regex)');
  assert.ok(hasSelfReschedulingLoop('const pf = () => { const s = "}"; setTimeout(pf, 1000); };\n', 'setTimeout'), 'must flag a loop whose body carries a } inside a string (the string must not break the brace match)');
  // Twins: the same bodies without the loop are not flagged.
  assert.ok(!hasSelfReschedulingLoop('function clean(){ const esc=(s)=>s.replace(/"/g, \'&quot;\'); setTimeout(() => done(), 60000); }\n', 'setTimeout'), 'a regex literal in a body without a self-reschedule is not a loop (twin of the regex-quote case)');
  assert.ok(!hasSelfReschedulingLoop('const pf = () => { const s = "}"; setTimeout(() => done(), 1000); };\n', 'setTimeout'), 'a } inside a string without a self-reschedule is not a loop (twin of the brace-in-string case)');

  // Lexer robustness — the division regression: a division whose left operand
  // ends in a postfix `++`/`--` or in a member access (`.of`) must not be
  // read as a regex-literal start (which would blank the file to EOF and hide
  // any loop after it).
  assert.ok(hasSelfReschedulingLoop('function f(){ const hits = 1; const total = 2; const r = hits++ / total; setTimeout(f, 1000); }', 'setTimeout'), 'a division whose left operand ends in a postfix ++ is not a regex start, so the loop after it is caught');
  assert.ok(hasSelfReschedulingLoop('function f(){ const slots = 1; const total = 2; const r = slots-- / total; setTimeout(f, 1000); }', 'setTimeout'), 'a division whose left operand ends in a postfix -- is not a regex start, so the loop after it is caught');
  assert.ok(hasSelfReschedulingLoop('function f(){ const counts = { of: 1 }; const total = 2; const r = counts.of / total; setTimeout(f, 1000); }', 'setTimeout'), 'a member-access operand (counts.of) is not a keyword, so the division is not a regex start and the loop after it is caught');
  assert.ok(hasSelfReschedulingLoop('function f(){ const a = 1; const b = 2; const q3 = a / b; setTimeout(f, 1000); }', 'setTimeout'), 'a plain division is not a regex start, so the loop after it is caught');
  assert.ok(!hasSelfReschedulingLoop('function f(){ const hits = 1; const total = 2; const r = hits++ / total; setTimeout(other, 1000); }', 'setTimeout'), 'a one-shot timer after a division is not a loop (twin of the division cases)');

  // C16 (detector level): the legal one-shot idioms — the real `lib/clock.js`
  // `advance()` resolver, `clearTimeout`, a name that only appears in a
  // comment, and functions named `set`/`schedule` (not matched inside
  // `setTimeout`/`scheduled`).
  assert.ok(!hasSelfReschedulingLoop('function systemClock() { return { advance(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); } }; }\n', 'setTimeout'), 'must not flag the clock.js one-shot advance() idiom');
  assert.ok(!hasSelfReschedulingLoop('function stop() { clearTimeout(timer); }\n', 'setTimeout'), 'clearing a timer is not scheduling one');
  assert.ok(!hasSelfReschedulingLoop('function scheduleRetryOnce() { /* scheduleRetryOnce … */ setTimeout(() => {}, 250); }\n', 'setTimeout'), 'a name that only appears in a comment is not a self-reschedule');
  assert.ok(!hasSelfReschedulingLoop('export function set(cb) { setTimeout(cb, 1000); }\n', 'setTimeout'), 'a function named "set" is not matched inside the word "setTimeout"');
  assert.ok(!hasSelfReschedulingLoop('export function schedule(fn, ms) { const scheduled = setTimeout(fn, ms); return scheduled; }\n', 'setTimeout'), 'a function named "schedule" is not matched inside "scheduled"');
});

// C11: a relocated `lib/scheduler.js` body — written verbatim to a
// non-`lib/scheduler*` server-tree path and reached through a route import —
// is caught by the *loop* detector (the import-prefix check cannot see it:
// the path no longer starts with `lib/scheduler`).
test('a relocated lib/scheduler.js body is caught by the loop detector, not the import-prefix check', () => {
  withTree('guard-schedreloc-bad-', (base) => {
    mkdirSync(join(base, 'app'));
    mkdirSync(join(base, 'lib', 'web'), { recursive: true });
    writeFileSync(join(base, 'app', 'index.js'), 'import { createScheduler } from "../lib/web/scheduler-echo.js";\n');
    // The `lib/scheduler.js` shape, relocated to a non-`lib/scheduler*`
    // path: `scheduleNextBeat` schedules `() => fireBeat(…)` and `fireBeat`
    // calls `scheduleNextBeat` — a one-hop-indirect self reference through a
    // thunk.
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
      'the shipped loop detector must flag the relocated scheduler body (the one-hop thunk mutual recursion)',
    );
  });

  // Unmutated twin: the same body with the recursion broken (fireBeat never
  // calls back) passes — the one-shot beat schedule is legal.
  withTree('guard-schedreloc-good-', (base) => {
    mkdirSync(join(base, 'app'));
    mkdirSync(join(base, 'lib', 'web'), { recursive: true });
    writeFileSync(join(base, 'app', 'index.js'), 'import { createScheduler } from "../lib/web/scheduler-echo.js";\n');
    const schedulerBody = `export function createScheduler({ setTimeout, intervalMs, task, log = () => {} }) {
  let timerId = null;
  function scheduleNextBeat(nextIndex) {
    timerId = setTimeout(() => fireBeat(nextIndex), intervalMs);
  }
  function fireBeat(nextIndex) {
    task(nextIndex);
  }
  return { start() { scheduleNextBeat(1); }, stop() {} };
}
`;
    writeFileSync(join(base, 'lib', 'web', 'scheduler-echo.js'), schedulerBody);
    assertServerTreeClean(base);
  });
});

// C15: positive control — the guard is only meaningful if the worker owns the
// poll loop. `worker/main.js` must import `lib/acquire/poll.js`.
test('worker/main.js imports lib/acquire/poll.js (positive control)', () => {
  const workerMain = join(root, 'worker', 'main.js');
  const source = readFileSync(workerMain, 'utf8');
  const specs = importSpecifiers(source);
  assert.ok(
    specs.includes('../lib/acquire/poll.js'),
    'worker/main.js must import lib/acquire/poll.js — the guard is only meaningful if the worker owns the poll loop',
  );
});
