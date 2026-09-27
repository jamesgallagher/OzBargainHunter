import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLoginOrigin } from '../../../lib/ozb-login/origin.js';

// Login-origin resolution (prompt 4.9). Pure. The one live origin a login may
// run against is exactly `https://www.ozbargain.com.au`; otherwise a `http:`
// origin on loopback. In dev mode only loopback is allowed and the live
// origin is refused, so a dev run can never drive a real login at the live
// site. `env` is injected, so every row is pinned.

const LIVE = 'https://www.ozbargain.com.au/classified';

// --- non-dev (the production / normal path) ---

test('a loopback http origin (127.0.0.1) is allowed', () => {
  const result = resolveLoginOrigin({ classifiedsUrl: 'http://127.0.0.1:8080/classified', env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, 'http://127.0.0.1:8080');
});

test('a loopback http origin (localhost) is allowed', () => {
  const result = resolveLoginOrigin({ classifiedsUrl: 'http://localhost:8080/classified', env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, 'http://localhost:8080');
});

test('a loopback http origin ([::1]) is allowed', () => {
  const result = resolveLoginOrigin({ classifiedsUrl: 'http://[::1]:8080/classified', env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, 'http://[::1]:8080');
});

test('the one live origin is allowed, and the base URL is that origin', () => {
  const result = resolveLoginOrigin({ classifiedsUrl: LIVE, env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, 'https://www.ozbargain.com.au');
});

test('http://www.ozbargain.com.au (not https) is refused — only the exact live origin is live', () => {
  const result = resolveLoginOrigin({
    classifiedsUrl: 'http://www.ozbargain.com.au/classified',
    env: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'origin_not_allowed');
});

test('another host is refused', () => {
  const result = resolveLoginOrigin({ classifiedsUrl: 'https://evil.com/classified', env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'origin_not_allowed');
});

test('a look-alike subdomain of the live host is refused', () => {
  const result = resolveLoginOrigin({
    classifiedsUrl: 'https://www.ozbargain.com.au.evil.com/classified',
    env: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'origin_not_allowed');
});

test('an https origin on loopback is refused — only http: loopback is allowed', () => {
  const result = resolveLoginOrigin({ classifiedsUrl: 'https://127.0.0.1:8080/classified', env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'origin_not_allowed');
});

test('an invalid URL is refused, not thrown', () => {
  const result = resolveLoginOrigin({ classifiedsUrl: 'not a url', env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'origin_not_allowed');
});

// --- dev mode ---

test('dev mode: a loopback origin is allowed', () => {
  const result = resolveLoginOrigin({
    classifiedsUrl: 'http://127.0.0.1:8080/classified',
    env: { OZB_DEV_MOCK_TRANSPORT: '1' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, 'http://127.0.0.1:8080');
});

test('dev mode: the localhost loopback origin is allowed', () => {
  const result = resolveLoginOrigin({
    classifiedsUrl: 'http://localhost:8080/classified',
    env: { OZB_DEV_MOCK_TRANSPORT: '1' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, 'http://localhost:8080');
});

test('dev mode: the [::1] loopback origin is allowed', () => {
  const result = resolveLoginOrigin({
    classifiedsUrl: 'http://[::1]:8080/classified',
    env: { OZB_DEV_MOCK_TRANSPORT: '1' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, 'http://[::1]:8080');
});

test('dev mode: the live origin is refused with the dev-mode reason', () => {
  const result = resolveLoginOrigin({ classifiedsUrl: LIVE, env: { OZB_DEV_MOCK_TRANSPORT: '1' } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'dev_mode_live_origin');
});

test('dev mode: another host is refused', () => {
  const result = resolveLoginOrigin({
    classifiedsUrl: 'https://evil.com/classified',
    env: { OZB_DEV_MOCK_TRANSPORT: '1' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'origin_not_allowed');
});

test('dev mode is inert in production: the live origin is allowed when NODE_ENV=production', () => {
  const result = resolveLoginOrigin({
    classifiedsUrl: LIVE,
    env: { OZB_DEV_MOCK_TRANSPORT: '1', NODE_ENV: 'production' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, 'https://www.ozbargain.com.au');
});

test('dev mode is inert in production: a loopback origin is still allowed', () => {
  const result = resolveLoginOrigin({
    classifiedsUrl: 'http://127.0.0.1:8080/classified',
    env: { OZB_DEV_MOCK_TRANSPORT: '1', NODE_ENV: 'production' },
  });
  assert.equal(result.ok, true);
});

test('a falsy dev flag is the non-dev path: the live origin is allowed', () => {
  const result = resolveLoginOrigin({
    classifiedsUrl: LIVE,
    env: { OZB_DEV_MOCK_TRANSPORT: '0' },
  });
  assert.equal(result.ok, true);
});
