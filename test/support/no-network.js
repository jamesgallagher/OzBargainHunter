/**
 * The network guard. Loaded via `node --test --import ./test/support/no-network.js`.
 * Replaces globalThis.fetch, http.request, https.request,
 * net.Socket.prototype.connect, tls.TLSSocket.prototype.connect and dns.lookup
 * with wrappers that throw NetworkBlockedError for any host other than
 * 127.0.0.1, localhost or ::1. Loopback stays open because card 5's
 * integration tests run a real server there.
 *
 * The predicate is "is this host loopback", not "is this host OzBargain":
 * every non-loopback egress THROUGH THE WRAPPED CALL SHAPES — including hosts
 * the test suite never names — is blocked. The wrapped shapes are the five
 * above (fetch, http/https.request, net.Socket/tls.TLSSocket connect, dns.lookup).
 * This is an in-process, opt-in guard and does NOT wrap the surrounding
 * envelope: `dns.promises` / `dns.resolve*`, `dgram` (UDP), a caller-supplied
 * `lookup` function, spawned child processes, and the ESM named-import path
 * (`import { lookup } from 'node:dns'` binds to the underlying function at
 * module-link time, not to the namespace property the guard mutates, so it
 * returns the unwrapped function) are out of scope and are not blocked here.
 * Where a wrapped call shape can carry more than one host
 * (e.g. an options object with both `hostname` and `host`), the guard blocks
 * if ANY present candidate is non-loopback. node's net/tls dial `host` when
 * both are present, so trusting `hostname` first would fail open; blocking on
 * any non-loopback candidate keeps it fail-closed (a self-contradictory object
 * is blocked).
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export class NetworkBlockedError extends Error {
  constructor(host) {
    super(`NetworkBlockedError: host "${host}" is not loopback`);
    this.name = 'NetworkBlockedError';
  }
}

// Normalise a host for the loopback check: strip IPv6 brackets so that
// "[::1]" matches "::1", and lowercase so casing cannot slip through.
function normalizeHost(host) {
  if (typeof host !== 'string') return null;
  let h = host.trim();
  if (h.startsWith('[') && h.endsWith(']')) {
    h = h.slice(1, -1);
  }
  return h.toLowerCase();
}

function hostFromUrl(url) {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

// Single-host check (fetch, dns.lookup): block unless the host is loopback.
function assertLoopback(host, label) {
  if (host === null || !ALLOWED_HOSTS.has(host)) {
    throw new NetworkBlockedError(host ?? label);
  }
}

// Multi-candidate check (options objects, positional host args): block if ANY
// present candidate normalises to a non-loopback host. A self-contradictory
// object (e.g. { hostname: '127.0.0.1', host: '<non-loopback>' }) is blocked,
// because node's net/tls dial `host` when both are present — so trusting
// `hostname` first would fail open.
function assertLoopbackAny(candidates, label) {
  for (const candidate of candidates) {
    const h = normalizeHost(candidate);
    if (h !== null && !ALLOWED_HOSTS.has(h)) {
      throw new NetworkBlockedError(h);
    }
  }
}

// --- fetch ---
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  // input can be a string, a URL, or a Request. URL objects expose .href
  // (not .url); Request objects expose .url.
  const url = typeof input === 'string' ? input : input.url ?? input.href ?? String(input);
  const host = hostFromUrl(url);
  assertLoopback(host, url);
  return originalFetch(input, init);
};

// --- http.request / https.request ---
function collectRequestCandidates(input, options) {
  const candidates = [];
  if (typeof input === 'string') {
    candidates.push(hostFromUrl(input));
  } else if (input instanceof URL) {
    candidates.push(normalizeHost(input.hostname));
  } else if (input && typeof input === 'object') {
    // http.request(options, callback): the first argument is the options object.
    // Block if ANY of hostname / host is non-loopback (fail-closed).
    if (input.hostname !== undefined) candidates.push(input.hostname);
    if (input.host !== undefined) candidates.push(input.host);
  }
  if (options && typeof options === 'object') {
    // http.request(url, options, callback): the options object may also carry a host.
    if (options.hostname !== undefined) candidates.push(options.hostname);
    if (options.host !== undefined) candidates.push(options.host);
  }
  return candidates;
}

function wrapRequest(original) {
  return function wrappedRequest(input, options, callback) {
    assertLoopbackAny(collectRequestCandidates(input, options), 'http.request');
    return original(input, options, callback);
  };
}

http.request = wrapRequest(http.request);
https.request = wrapRequest(https.request);

// --- net.Socket.prototype.connect (also net.connect / net.createConnection) ---
function collectSocketCandidates(args) {
  const candidates = [];
  // node passes a normalised array as args[0] for some call shapes, e.g.
  // [{ host, port }, null]; unwrap it.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === 'string') {
    // connect('host', port) or a unix socket path (not egress).
    candidates.push(first);
  } else if (first && typeof first === 'object') {
    // connect(options): block if ANY of hostname / host is non-loopback.
    if (first.hostname !== undefined) candidates.push(first.hostname);
    if (first.host !== undefined) candidates.push(first.host);
  }
  // Port-form: connect(port, host) — the host is the second positional arg.
  if (args[1] !== undefined && typeof args[1] === 'string') {
    candidates.push(args[1]);
  }
  return candidates;
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  assertLoopbackAny(collectSocketCandidates(args), 'net.Socket.connect');
  return originalConnect.apply(this, args);
};

// --- tls.TLSSocket.prototype.connect (tls.connect) ---
// REDUNDANT (no distinct coverage): tls.TLSSocket.prototype inherits from
// net.Socket.prototype (it has no own `connect`), so the
// net.Socket.prototype.connect wrapper below it still throws
// NetworkBlockedError for the same dial. Deleting this tls wrapper therefore
// leaves tls.connect blocked via the inherited net wrapper — verified by probe
// at card t_c95fd9e3. This wrapper is defence-in-depth only: it is not pinned
// by a test (a pin cannot fail on the deletion mutant), and its presence is
// documented here rather than asserted.
if (typeof tls.TLSSocket.prototype.connect === 'function') {
  const originalTlsConnect = tls.TLSSocket.prototype.connect;
  tls.TLSSocket.prototype.connect = function connect(...args) {
    assertLoopbackAny(collectSocketCandidates(args), 'tls.TLSSocket.connect');
    return originalTlsConnect.apply(this, args);
  };
}

// --- dns.lookup ---
const originalLookup = dns.lookup;
dns.lookup = function lookup(hostname, options, callback) {
  assertLoopback(normalizeHost(hostname), 'dns.lookup');
  return originalLookup(hostname, options, callback);
};

// --- sentinel ---
globalThis.__NETWORK_GUARD_SENTINEL__ = 'no-network';
