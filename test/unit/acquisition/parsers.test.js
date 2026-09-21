import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDealsFeed, ParseError } from '../../../lib/parse/deals.js';
import { parseClassifiedsPage, ClassifiedsPageError } from '../../../lib/parse/classifieds.js';

const FIXTURE_NOW = '2026-09-19T06:20:00Z';

function readFixture(path) {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
}

function readRecordFixture(path) {
  return JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'));
}

test('parseDealsFeed on r0.xml deep-equals the 30 records in deals-page0.json', () => {
  const xml = readFixture('fixtures/http/r0.xml');
  const expected = readRecordFixture('fixtures/records/deals-page0.json').records;
  assert.equal(expected.length, 30);
  const actual = parseDealsFeed(xml);
  assert.deepEqual(actual, expected);
});

test('parseDealsFeed on cmp_front.xml deep-equals the 20 records in front-feed.json', () => {
  const xml = readFixture('fixtures/http/cmp_front.xml');
  const expected = readRecordFixture('fixtures/records/front-feed.json').records;
  assert.equal(expected.length, 20);
  const actual = parseDealsFeed(xml);
  assert.deepEqual(actual, expected);
});

test('parseClassifiedsPage on classifieds-page.html deep-equals the 25 records and reports uid 226301', () => {
  const html = readFixture('fixtures/http/classifieds-page.html');
  const expected = readRecordFixture('fixtures/records/classifieds.json').records;
  assert.equal(expected.length, 25);
  const { uid, listings } = parseClassifiedsPage(html, { now: FIXTURE_NOW });
  assert.equal(uid, 226301);
  assert.deepEqual(listings, expected);
});

test('type census: 15 want, 8 sell, 1 free, 1 swap; 8 pinned, of which 7 want and one free (751807)', () => {
  const html = readFixture('fixtures/http/classifieds-page.html');
  const { listings } = parseClassifiedsPage(html, { now: FIXTURE_NOW });
  const census = {};
  for (const r of listings) census[r.type] = (census[r.type] ?? 0) + 1;
  assert.deepEqual(census, { want: 15, sell: 8, free: 1, swap: 1 });

  const pinned = listings.filter((r) => r.pinned);
  assert.equal(pinned.length, 8);
  const pinnedCensus = {};
  for (const r of pinned) pinnedCensus[r.type] = (pinnedCensus[r.type] ?? 0) + 1;
  assert.equal(pinnedCensus.want, 7);
  assert.equal(pinnedCensus.free, 1);
  const pinnedFree = pinned.find((r) => r.type === 'free');
  assert.equal(pinnedFree.node_id, 751807);
});

test('listing 751807 parses with pinned true and posted 2023-01-17T22:33:00Z (the AEDT case)', () => {
  const html = readFixture('fixtures/http/classifieds-page.html');
  const { listings } = parseClassifiedsPage(html, { now: FIXTURE_NOW });
  const r = listings.find((x) => x.node_id === 751807);
  assert.equal(r.pinned, true);
  assert.equal(r.posted_at, '2023-01-17T22:33:00Z');
});

test('listing 975575 parses with a null poster', () => {
  const html = readFixture('fixtures/http/classifieds-page.html');
  const { listings } = parseClassifiedsPage(html, { now: FIXTURE_NOW });
  const r = listings.find((x) => x.node_id === 975575);
  assert.equal(r.poster, null);
  assert.equal(r.poster_id, null);
});

test('parseClassifiedsPage on classifieds-page-anon.html reports uid 0', () => {
  const html = readFixture('fixtures/http/derived/classifieds-page-anon.html');
  const { uid } = parseClassifiedsPage(html, { now: FIXTURE_NOW });
  assert.equal(uid, 0);
});

test('a truncated deals body throws ParseError (it will not parse)', () => {
  const xml = readFixture('fixtures/http/derived/deals-page0-truncated.xml');
  assert.throws(() => parseDealsFeed(xml), ParseError);
});

// --- Safe-failure: unparseable 200 bodies must throw ClassifiedsPageError ---
// The malformed bodies are derived from the complete fixture (or are minimal
// synthetic pages) so the corpus in fixtures/http is never edited.

test('an empty body throws ClassifiedsPageError (code unparseable, reason empty or whitespace-only)', () => {
  let caught = null;
  try {
    parseClassifiedsPage('');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'an empty body must not parse');
  assert.ok(caught instanceof ClassifiedsPageError, `got ${caught?.name}: ${caught?.message}`);
  assert.equal(caught.code, 'unparseable');
  assert.equal(caught.reason, 'empty or whitespace-only body');
});

test('a whitespace-only body throws ClassifiedsPageError (reason empty or whitespace-only)', () => {
  assert.throws(
    () => parseClassifiedsPage('  \n\t  \n'),
    (err) => err instanceof ClassifiedsPageError && err.reason === 'empty or whitespace-only body',
  );
});

test('a JSON (non-HTML) body throws ClassifiedsPageError (reason missing OzB_vars)', () => {
  assert.throws(
    () => parseClassifiedsPage('{"error":"not found","status":404}'),
    (err) => err instanceof ClassifiedsPageError && err.reason === 'missing OzB_vars',
  );
});

test('an HTML page lacking OzB_vars throws ClassifiedsPageError (reason missing OzB_vars)', () => {
  assert.throws(
    () => parseClassifiedsPage('<!DOCTYPE html><html><head><title>x</title></head><body><p>hi</p></body></html>'),
    (err) => err instanceof ClassifiedsPageError && err.reason === 'missing OzB_vars',
  );
});

test('a truncated page (derived by cutting the complete fixture mid-stream) throws ClassifiedsPageError (reason missing closing </html> terminator)', () => {
  const full = readFixture('fixtures/http/classifieds-page.html');
  // Cut at the midpoint: the head (with OzB_vars) is kept, the closing
  // </html> is not — the exact shape of a stream that died mid-body.
  const truncated = full.slice(0, Math.floor(full.length / 2));
  assert.ok(!/\/html\s*>/i.test(truncated), 'the derived fixture must lack the terminator');
  assert.throws(
    () => parseClassifiedsPage(truncated),
    (err) => err instanceof ClassifiedsPageError && err.reason === 'missing closing </html> terminator',
  );
});

test('a page with an unreadable listing block (a heading id without a numeric suffix) throws ClassifiedsPageError', () => {
  // OzB_vars present, </html> present, but the one listing block's heading
  // id does not end in digits: the block is unreadable, not a session signal.
  const mangled = [
    '<!DOCTYPE html>',
    '<html><head><script>OzB_vars={"uid":226301};</script></head>',
    '<body>',
    '<div class="node node-classified node-teaser">',
    '<h2 class="title" id="title-broken" data-title="Test">Test</h2>',
    '</div>',
    '</body></html>',
  ].join('\n');
  assert.throws(
    () => parseClassifiedsPage(mangled),
    (err) => err instanceof ClassifiedsPageError && err.reason === 'listing block with an unreadable node id',
  );
});

test('a complete page still parses (no throw) and a genuine uid-0 page still reports uid 0', () => {
  const full = readFixture('fixtures/http/classifieds-page.html');
  const complete = parseClassifiedsPage(full, { now: FIXTURE_NOW });
  assert.equal(complete.uid, 226301);
  assert.equal(complete.listings.length, 25);
  const anon = readFixture('fixtures/http/derived/classifieds-page-anon.html');
  const { uid } = parseClassifiedsPage(anon, { now: FIXTURE_NOW });
  assert.equal(uid, 0);
});

// --- Review round-1 (Abhishek, pinned fb688f3): the gates were token checks ---
// The structural gate accepted any body that merely *contained* "OzB_vars ="
// and "</html>" (so a JSON error envelope quoting them parsed), and extractUid
// defaulted an absent or malformed uid to 0 — which is a session expiry. Both
// classes are fixed here: the session object must live in a <script> element,
// and the uid must be an explicit integer literal.

test('a non-HTML body that merely quotes the OzB_vars and </html> tokens throws ClassifiedsPageError (reason missing OzB_vars)', () => {
  // The exact shape that used to parse: a JSON error envelope whose text
  // contains the tokens the old token checks looked for. It has no <script>
  // element and no session object, so it is not a page.
  const quoted = JSON.stringify({
    error: 'bad gateway',
    upstream: 'OzB_vars = {"site_name":"OzBargain","adstype":"FUSE"}; </html>',
  });
  assert.throws(
    () => parseClassifiedsPage(quoted),
    (err) => err instanceof ClassifiedsPageError && err.reason === 'missing OzB_vars',
  );
});

test('an OzB_vars assignment outside a script element is not a page (reason missing OzB_vars)', () => {
  // Real HTML shape, the assignment present, but as body *text* rather than
  // the site's embedded script: still not a classifieds page.
  const notAScript = [
    '<!DOCTYPE html>',
    '<html><head><title>x</title></head>',
    '<body><p>OzB_vars={"uid":226301};</p></body>',
    '</html>',
  ].join('\n');
  assert.throws(
    () => parseClassifiedsPage(notAScript),
    (err) => err instanceof ClassifiedsPageError && err.reason === 'missing OzB_vars',
  );
});

test('a fragment with </html> but no <html> document element throws ClassifiedsPageError (reason missing <html> document element)', () => {
  const fragment = '<script>OzB_vars={"uid":226301};</script></html>';
  assert.throws(
    () => parseClassifiedsPage(fragment),
    (err) => err instanceof ClassifiedsPageError && err.reason === 'missing <html> document element',
  );
});

// The four malformed session objects are derived from the complete fixture by
// rewriting only the uid field, so the corpus in fixtures/http is never edited.
// Each one used to parse as uid 0 — a fabricated session expiry.

test('a complete page whose OzB_vars carries no uid field throws ClassifiedsPageError (reason missing uid field in OzB_vars)', () => {
  const full = readFixture('fixtures/http/classifieds-page.html');
  const withoutUid = full.replace('"uid":226301,', '');
  assert.notEqual(withoutUid, full, 'the derived fixture must have changed the uid field');
  assert.throws(
    () => parseClassifiedsPage(withoutUid),
    (err) => err instanceof ClassifiedsPageError && err.reason === 'missing uid field in OzB_vars',
  );
});

test('a complete page whose uid is not an explicit integer literal (quoted or null) throws ClassifiedsPageError (reason malformed uid)', () => {
  const full = readFixture('fixtures/http/classifieds-page.html');
  for (const [what, replacement] of [
    ['a quoted string', '"uid":"226301",'],
    ['null', '"uid":null,'],
  ]) {
    const derived = full.replace('"uid":226301,', replacement);
    assert.notEqual(derived, full, `${what}: the derived fixture must have changed the uid field`);
    assert.throws(
      () => parseClassifiedsPage(derived),
      (err) => err instanceof ClassifiedsPageError && err.reason === 'malformed uid in OzB_vars (not an explicit integer)',
      `${what} must not parse as a uid`,
    );
  }
});

test('a field merely ending in uid (e.g. "suid") is not read as the uid (reason missing uid field in OzB_vars)', () => {
  const page = [
    '<!DOCTYPE html>',
    '<html><head><script>OzB_vars={"site_name":"OzBargain","suid":226301};</script></head>',
    '<body></body>',
    '</html>',
  ].join('\n');
  assert.throws(
    () => parseClassifiedsPage(page),
    (err) => err instanceof ClassifiedsPageError && err.reason === 'missing uid field in OzB_vars',
  );
});

test('an explicit integer uid in the embedded script is read as before (0 stays anonymous, 226301 stays authenticated)', () => {
  const page = (uid) =>
    [
      '<!DOCTYPE html>',
      `<html><head><script>OzB_vars={"site_name":"OzBargain","uid":${uid},"adstype":"FUSE"};</script></head>`,
      '<body></body>',
      '</html>',
    ].join('\n');
  assert.equal(parseClassifiedsPage(page(0)).uid, 0);
  assert.equal(parseClassifiedsPage(page(226301)).uid, 226301);
});
