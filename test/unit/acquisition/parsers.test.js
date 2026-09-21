import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDealsFeed, ParseError } from '../../../lib/parse/deals.js';
import { parseClassifiedsPage } from '../../../lib/parse/classifieds.js';

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
