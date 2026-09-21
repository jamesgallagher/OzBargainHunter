/**
 * The architecture guard (design 2.2, 8.2). The poll loop lives in a separate
 * worker process, never in the Next.js server tree.
 *
 * The server tree is wider than `app/` + `middleware.js`: Next.js also runs
 * the root `instrumentation.js` at server start, and every screen imports the
 * shared `lib/web/` modules. A poll loop parked in `lib/web/*` or in
 * `instrumentation.js` would move polling into the server process without
 * failing an `app/`-only walk. So the guard walks the union of the server tree
 * — every file under `app/`, `middleware.js`, every file under `lib/web/`, and
 * the root `instrumentation` file (any `instrumentation.@(js|mjs|ts)` variant)
 * when present — and asserts, over that one list, that:
 *
 *   1. no file imports `lib/acquire/`, `lib/scheduler` or anything under
 *      `worker/`; and
 *   2. no file contains `setInterval` or a `setTimeout`-driven self-rescheduling
 *      loop (a function that schedules *itself* with `setTimeout` — the shape of
 *      a poll loop that dodges the `setInterval` check).
 *
 * A second assertion checks that `worker/main.js` does import
 * `lib/acquire/poll.js` — the positive control that proves the guard is looking
 * at the right thing.
 *
 * Legitimate one-shot `setTimeout`s are not flagged: the check requires the
 * function's own name to appear as the first argument of the `setTimeout` call
 * inside its own body, or as the call the first-argument arrow makes (the
 * thunk spelling — `setTimeout(() => poll(), …)` — the shape this repo's own
 * poll loop is written in). The self-reference is matched as a whole token (so
 * a function named `set`, `setup` or `reset` is not matched inside the word
 * `setTimeout`), and comments, string/template literals, and regex literals are
 * blanked out first (so a name in a comment, a `}` inside a string, or a quote
 * inside a regex literal cannot fool the check). A regex literal is only
 * recognised in an expression-start position (after an operator, a keyword such
 * as `return`/`typeof`, or at the start of the source); a division — including
 * a division whose left operand ends in a postfix `++`/`--` or in a member
 * access (`.of`) — is never read as a regex start.
 *
 * Known limits (a lexical pass, not a parser): (1) a quote inside JSX text
 * (e.g. `<p>it's ok</p>`) is not blanked, so a self-rescheduling loop after
 * such JSX in the same file can be hidden; no file in the current tree has
 * one. (2) An *indirect* reschedule — a function that schedules a *different*
 * function which in turn reschedules the first (e.g. `schedule()` calling
 * `fireBeat()`, as in `lib/scheduler.js`) is not caught: the self-reference
 * must be direct (the name, or an arrow that calls the name). Deliberate
 * obfuscation (`globalThis['set'+'Timeout']`, method shorthand) is likewise out
 * of scope by design.
 *
 * If a later change moves polling into a route, a shared web module, or the
 * server-start hook, this test fails. That is its entire purpose.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));

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
 * The union of the server tree the app actually runs: every file under `app/`,
 * `middleware.js`, every file under `lib/web/`, and the root `instrumentation`
 * file when present. One list, walked by every assertion.
 * @returns {string[]}
 */
function serverTreeFiles() {
  const targets = [];
  const appDir = join(root, 'app');
  if (existsSync(appDir) && statSync(appDir).isDirectory()) {
    targets.push(...listFiles(appDir));
  }
  const middlewarePath = join(root, 'middleware.js');
  if (existsSync(middlewarePath) && statSync(middlewarePath).isFile()) {
    targets.push(middlewarePath);
  }
  const webDir = join(root, 'lib', 'web');
  if (existsSync(webDir) && statSync(webDir).isDirectory()) {
    targets.push(...listFiles(webDir));
  }
  const instr = instrumentationFile();
  if (instr) targets.push(instr);
  return targets;
}

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
 * `hasSelfReschedulingTimeout`.
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
 * Does `body` (already blanked) contain a `setTimeout`-driven self-reschedule of
 * the function named `name`? Two spellings, both the shape of a poll loop that
 * dodges the `setInterval` check:
 *   - direct:  `setTimeout(name, …)` — `name` is the first argument;
 *   - thunk:   `setTimeout( [async] (params) => [ { ] name( … )` — the arrow
 *     (the first argument) calls the function's own name, i.e. it reschedules
 *     itself. This is the spelling this repo's own poll loop is written in
 *     (`lib/scheduler.js` schedules a beat via `setTimeout(() => fireBeat(…))`).
 * A one-shot `setTimeout(other, …)` (a different first argument, or an arrow that
 * calls a *different* function) is not flagged. The self-reference is matched as
 * a whole token, so a function named `set`/`setup`/`reset` is not matched inside
 * the word `setTimeout`.
 * @param {string} body
 * @param {string} name
 * @returns {boolean}
 */
function isSelfReschedule(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Direct form: setTimeout(name, …) with name as the first argument.
  const direct = new RegExp(`setTimeout\\s*\\(\\s*${escaped}\\b`);
  // Thunk form: setTimeout( [async] (params) => [ { ] name( … ). The arrow is the
  // first argument and it calls the function's own name. `[^)]*` bounds the
  // arrow's parameter list to the first `)`, so it cannot run past the arrow.
  const thunk = new RegExp(
    `setTimeout\\s*\\(\\s*(?:async\\s+)?\\(\\s*[^)]*\\s*\\)\\s*=>\\s*(?:\\{)?\\s*${escaped}\\s*\\(`,
  );
  return direct.test(body) || thunk.test(body);
}

/**
 * Does `source` contain a `setTimeout`-driven self-rescheduling loop? It checks
 * every natural binding form a function can take:
 *   - named function declarations:      `function poll() { …; setTimeout(poll, …); }`
 *   - function-expression bindings:     `const poll = [async] function (… ) { … }`
 *   - arrow bindings, block body:       `const poll = [async] (… ) => { … }`
 *   - arrow bindings, concise body:     `const poll = [async] (… ) => setTimeout(poll, …)`
 * Comments and string/template literals are blanked first, and the self-reference
 * is matched as the first argument of `setTimeout` (a whole token), so legitimate
 * one-shot timers and functions named `set`/`setup`/`reset` are not flagged.
 * @param {string} source
 * @returns {boolean}
 */
function hasSelfReschedulingTimeout(source) {
  const blanked = blankCommentsAndStrings(source);
  if (!/\bsetTimeout\b/.test(blanked)) return false;

  // Named function declarations.
  for (const { name, body } of findFunctionBodies(blanked)) {
    if (isSelfReschedule(body, name)) return true;
  }

  // Function-expression bindings: const poll = [async] function (… ) { … }
  for (const m of blanked.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\(/g)) {
    const name = m[1];
    const open = blanked.indexOf('{', m.index + m[0].length);
    if (open === -1) continue;
    const body = braceMatch(blanked, open);
    if (body !== null && isSelfReschedule(body, name)) return true;
  }

  // Arrow bindings with a block body: const poll = [async] (… ) => { … }
  for (const m of blanked.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g)) {
    const name = m[1];
    const open = m.index + m[0].length - 1; // the `{`
    const body = braceMatch(blanked, open);
    if (body !== null && isSelfReschedule(body, name)) return true;
  }

  // Arrow bindings with a concise body: const poll = [async] (… ) => setTimeout(poll, …)
  for (const m of blanked.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?!{)/g)) {
    const name = m[1];
    const start = m.index + m[0].length;
    const body = conciseBody(blanked, start);
    if (isSelfReschedule(body, name)) return true;
  }

  return false;
}

const FORBIDDEN_IMPORTS = ['lib/acquire/', 'lib/scheduler', 'worker/'];
const FORBIDDEN_TOKENS = ['setInterval'];

test('no file in the server tree imports the acquisition, scheduler, or worker code', () => {
  const targets = serverTreeFiles();
  assert.ok(targets.length > 0, 'expected at least one server-tree file to walk');

  for (const file of targets) {
    const source = readFileSync(file, 'utf8');
    for (const forbidden of FORBIDDEN_IMPORTS) {
      assert.ok(
        !source.includes(forbidden),
        `${file} must not reference ${forbidden} (polling lives in the worker, not the server tree)`,
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

test('no file in the server tree hosts a poll loop', () => {
  const targets = serverTreeFiles();
  assert.ok(targets.length > 0, 'expected at least one server-tree file to walk');

  for (const file of targets) {
    const source = readFileSync(file, 'utf8');
    for (const token of FORBIDDEN_TOKENS) {
      assert.ok(
        !source.includes(token),
        `${file} must not contain ${token} (no polling in the server tree — the poll loop lives in the worker)`,
      );
    }
    assert.ok(
      !hasSelfReschedulingTimeout(source),
      `${file} must not contain a setTimeout-driven self-rescheduling loop (no polling in the server tree)`,
    );
  }
});

// The detector above is a heuristic, so it needs its own controls: a guard that
// silently matches nothing is worse than no guard, because it reads as proof.
test('the poll-loop detector catches the shapes it exists for (positive controls)', () => {
  assert.ok(
    hasSelfReschedulingTimeout('function poll() { doWork(); setTimeout(poll, 5000); }'),
    'a named function rescheduling itself with setTimeout is a poll loop',
  );
  assert.ok(
    hasSelfReschedulingTimeout('const pollOnce = async () => { await work(); setTimeout(pollOnce, 5000); };'),
    'the arrow-binding (block body) form is the same loop with a different spelling',
  );
  assert.ok(
    hasSelfReschedulingTimeout('const pollX = () => setTimeout(pollX, 1000);'),
    'the concise-body arrow form is the same loop',
  );
  assert.ok(
    hasSelfReschedulingTimeout('const pollX = function () { setTimeout(pollX, 1000); };'),
    'the function-expression binding form is the same loop',
  );
  assert.ok(
    hasSelfReschedulingTimeout("function pollWithTemplate(){ const b='retry }'; setTimeout(pollWithTemplate,60000); }"),
    'a } inside a string does not hide the loop (strings are blanked before brace matching)',
  );
  assert.ok(
    hasSelfReschedulingTimeout("const esc = (s) => s.replace(/\"/g, '&quot;');\nfunction pollEsc(){ setTimeout(pollEsc, 60000); }"),
    'a quote inside a regex literal does not hide a later self-rescheduling loop (regex literals are blanked, so their quotes are not read as string delimiters)',
  );
  // The thunk spelling: the arrow (the first argument to setTimeout) calls the
  // function's own name. This is the shape this repo's own poll loop is
  // written in (`lib/scheduler.js` schedules a beat via
  // `setTimeout(() => fireBeat(…))`), so a poll loop moved into the server
  // tree in this spelling must be caught.
  assert.ok(
    hasSelfReschedulingTimeout('function pollC(){ setTimeout(() => pollC(), 60000); }'),
    'the thunk spelling (the arrow calls the function itself) is the same loop',
  );
  assert.ok(
    hasSelfReschedulingTimeout('function pollD(x){ setTimeout(() => pollD(x), 60000); }'),
    'the thunk spelling with an argument is the same loop',
  );
  assert.ok(
    hasSelfReschedulingTimeout('function pollE(){ setTimeout(() => { pollE(); }, 60000); }'),
    'the thunk spelling with a block body is the same loop',
  );
  assert.ok(
    hasSelfReschedulingTimeout('const pf = () => setTimeout(() => pf(), 60000);'),
    'a concise-body arrow whose body is a self-rescheduling thunk is the same loop',
  );
  assert.ok(
    hasSelfReschedulingTimeout('const pf = async () => { await tick(); setTimeout(async () => pf(), 60000); };'),
    'the async thunk spelling is the same loop',
  );
});

test('the poll-loop detector leaves one-shot timers alone (negative controls)', () => {
  assert.ok(
    !hasSelfReschedulingTimeout('setTimeout(() => { done(); }, 0);'),
    'an anonymous one-shot timer is not a loop',
  );
  assert.ok(
    !hasSelfReschedulingTimeout('function later() { setTimeout(other, 10); }'),
    'scheduling a different function once is not a loop',
  );
  assert.ok(
    !hasSelfReschedulingTimeout('function stop() { clearTimeout(timer); }'),
    'clearing a timer is not scheduling one',
  );
  assert.ok(
    !hasSelfReschedulingTimeout('export function set(cb) { setTimeout(cb, 1000); }'),
    'a function named "set" is not matched inside the word "setTimeout"',
  );
  assert.ok(
    !hasSelfReschedulingTimeout('export function schedule(fn, ms) { const scheduled = setTimeout(fn, ms); return scheduled; }'),
    'a function named "schedule" is not matched inside "scheduled"',
  );
  assert.ok(
    !hasSelfReschedulingTimeout('function scheduleRetryOnce() { /* scheduleRetryOnce … */ setTimeout(() => {}, 250); }'),
    'a name that only appears in a comment is not a self-reschedule',
  );
});

// Regression pin for the round-3 division misread (review round 3, Major 2): a
// division whose left operand ends in a postfix `++`/`--` or in a member access
// (`.of`) used to be read as a regex-literal start (the second `+`/`-` is an
// expression-start context, and a keyword-shaped token after `.` was read as a
// keyword). The phantom literal then blanked forward to the next `/` — or to
// EOF when there was none — hiding any loop after it. These controls prove the
// division is treated as division, so a real self-rescheduling loop that follows
// is still caught.
test('a division after a postfix operator or member access does not hide a later self-rescheduling loop (division-regression pin)', () => {
  assert.ok(
    hasSelfReschedulingTimeout('function f(){ const hits = 1; const total = 2; const r = hits++ / total; setTimeout(f, 1000); }'),
    'a division whose left operand ends in a postfix ++ is not a regex start, so the loop after it is caught',
  );
  assert.ok(
    hasSelfReschedulingTimeout('function f(){ const slots = 1; const total = 2; const r = slots-- / total; setTimeout(f, 1000); }'),
    'a division whose left operand ends in a postfix -- is not a regex start, so the loop after it is caught',
  );
  assert.ok(
    hasSelfReschedulingTimeout('function f(){ const counts = { of: 1 }; const total = 2; const r = counts.of / total; setTimeout(f, 1000); }'),
    'a member-access operand (counts.of) is not a keyword, so the division is not a regex start and the loop after it is caught',
  );
  assert.ok(
    hasSelfReschedulingTimeout('function f(){ const a = 1; const b = 2; const q3 = a / b; setTimeout(f, 1000); }'),
    'a plain division is not a regex start, so the loop after it is caught',
  );
  // And the inverse: a one-shot timer that merely sits after a division is not
  // flagged (the division does not corrupt the token stream into a false loop).
  assert.ok(
    !hasSelfReschedulingTimeout('function f(){ const hits = 1; const total = 2; const r = hits++ / total; setTimeout(other, 1000); }'),
    'a one-shot timer after a division is not a loop',
  );
});

// The file-level pin for the regex-literal blanking fix (review round 2, Major
// 1): `app/rules/[id]/mute/route.js` carries an ordinary HTML escaper
// (`s.replace(/"/g, '&quot;')`), and a quote inside a regex literal used to be
// read as a string delimiter, blanking the file to EOF and hiding any loop
// appended after it. This test reads the real file, appends a self-rescheduling
// loop, and asserts the detector catches it — the exact "a poll loop parked in
// a route handler" scenario the guard exists for.
test('a quote inside a regex literal must not hide a later self-rescheduling loop (file-level pin)', () => {
  const mutePath = join(root, 'app', 'rules', '[id]', 'mute', 'route.js');
  const source = readFileSync(mutePath, 'utf8');
  assert.ok(
    /replace\(\/"/.test(source) || /replace\(\/'/.test(source),
    'precondition: the mute route carries a regex-literal HTML escaper (the case this pin protects)',
  );
  const withLoop = `${source}\nfunction pollMute(){ setTimeout(pollMute, 60000); }\npollMute();\n`;
  assert.ok(
    hasSelfReschedulingTimeout(withLoop),
    'a self-rescheduling loop appended after the regex-literal escaper in app/rules/[id]/mute/route.js must be caught',
  );
  assert.ok(
    !hasSelfReschedulingTimeout(source),
    'the pristine mute route (no loop) is not flagged',
  );
});
