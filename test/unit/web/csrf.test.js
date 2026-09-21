import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { generateCsrfToken, verifyCsrfToken } from '../../../lib/csrf.js';

const SECRET = 'csrf-secret-for-tests';

describe('csrf: signed double-submit token (8.6, D33)', () => {
  test('a generated token verifies', async () => {
    const token = await generateCsrfToken(SECRET);
    assert.match(token, /^[0-9a-f]+\.[0-9]+\.[0-9a-f]+$/, 'token is value.exp.signature');
    assert.equal(await verifyCsrfToken(token, SECRET), true);
  });

  test('a token is unique (not reused across calls)', async () => {
    const a = await generateCsrfToken(SECRET);
    const b = await generateCsrfToken(SECRET);
    assert.notEqual(a, b, 'two generated tokens differ');
  });

  test('a token signed under a different secret is rejected', async () => {
    const token = await generateCsrfToken(SECRET);
    assert.equal(await verifyCsrfToken(token, 'a-different-secret'), false);
  });

  test('a tampered signature is rejected', async () => {
    const token = await generateCsrfToken(SECRET);
    const idx = token.lastIndexOf('.');
    const value = token.slice(0, idx);
    let sig = token.slice(idx + 1);
    // Flip the last hex digit.
    const last = sig[sig.length - 1];
    const replacement = last === 'f' ? '0' : 'f';
    sig = sig.slice(0, -1) + replacement;
    assert.equal(await verifyCsrfToken(`${value}.${sig}`, SECRET), false);
  });

  test('a tampered value is rejected (signature no longer matches)', async () => {
    const token = await generateCsrfToken(SECRET);
    const idx = token.lastIndexOf('.');
    const value = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    // Change the first character of the value.
    const newValue = (value[0] === '0' ? '1' : '0') + value.slice(1);
    assert.equal(await verifyCsrfToken(`${newValue}.${sig}`, SECRET), false);
  });

  test('malformed tokens are rejected', async () => {
    assert.equal(await verifyCsrfToken('', SECRET), false);
    assert.equal(await verifyCsrfToken('noperiod', SECRET), false);
    assert.equal(await verifyCsrfToken('.sigsig', SECRET), false);
    assert.equal(await verifyCsrfToken('value.', SECRET), false);
    assert.equal(await verifyCsrfToken(null, SECRET), false);
    assert.equal(await verifyCsrfToken(undefined, SECRET), false);
  });

  test('a truncated signature is rejected (length mismatch)', async () => {
    const token = await generateCsrfToken(SECRET);
    const idx = token.lastIndexOf('.');
    const value = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    assert.equal(await verifyCsrfToken(`${value}.${sig.slice(0, -4)}`, SECRET), false);
  });

  test('a token has a 15-minute expiry and a fresh one verifies (m3)', async () => {
    const token = await generateCsrfToken(SECRET);
    const idx = token.lastIndexOf('.');
    const value = token.slice(0, idx);
    assert.equal(await verifyCsrfToken(`${value}.${token.slice(idx + 1)}`, SECRET, new Date(Date.now() + 10 * 60 * 1000)), true);
  });

  test('an expired token is rejected (m3)', async () => {
    const token = await generateCsrfToken(SECRET);
    const idx = token.lastIndexOf('.');
    const value = token.slice(0, idx);
    assert.equal(await verifyCsrfToken(`${value}.${token.slice(idx + 1)}`, SECRET, new Date(Date.now() + 16 * 60 * 1000)), false);
  });

  test('a token bound to another email is rejected (m3)', async () => {
    const token = await generateCsrfToken(SECRET, 'bound@example.com');
    const idx = token.lastIndexOf('.');
    const value = token.slice(0, idx);
    assert.equal(await verifyCsrfToken(`${value}.${token.slice(idx + 1)}`, SECRET, undefined, 'other@example.com'), false);
  });

  test('a token bound to the same email verifies (m3)', async () => {
    const token = await generateCsrfToken(SECRET, 'bound@example.com');
    const idx = token.lastIndexOf('.');
    const value = token.slice(0, idx);
    assert.equal(await verifyCsrfToken(`${value}.${token.slice(idx + 1)}`, SECRET, undefined, 'bound@example.com'), true);
  });

  test('an unbound token verifies for any email (m3)', async () => {
    const token = await generateCsrfToken(SECRET);
    const idx = token.lastIndexOf('.');
    const value = token.slice(0, idx);
    assert.equal(await verifyCsrfToken(`${value}.${token.slice(idx + 1)}`, SECRET, undefined, 'anyone@example.com'), true);
  });
});
