/**
 * The network guard. Loaded via `node --test --import ./test/support/no-network.js`.
 * Replaces globalThis.fetch, http.request, https.request,
 * net.Socket.prototype.connect and dns.lookup with wrappers that throw
 * NetworkBlockedError for any host other than 127.0.0.1, localhost or ::1.
 * Loopback stays open because card 5's integration tests run a real
 * server there.
 *
 * The predicate is "is this host loopback", not "is this host OzBargain":
 * every non-loopback egress — including hosts the test suite never names —
 * is blocked.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
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

function assertLoopback(host, label) {
  if (host === null || !ALLOWED_HOSTS.has(host)) {
    throw new NetworkBlockedError(host ?? label);
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
function wrapRequest(original) {
  return function wrappedRequest(input, options, callback) {
    let host;
    if (typeof input === 'string') {
      host = hostFromUrl(input);
    } else if (input instanceof URL) {
      host = normalizeHost(input.hostname);
    } else if (input && typeof input === 'object') {
      // http.request(options, callback): the first argument is the options object.
      host = normalizeHost(input.hostname ?? input.host);
    } else if (options && typeof options === 'object') {
      host = normalizeHost(options.hostname ?? options.host);
    }
    assertLoopback(host, 'http.request');
    return original(input, options, callback);
  };
}

http.request = wrapRequest(http.request);
https.request = wrapRequest(https.request);

// --- net.Socket.prototype.connect ---
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  // node passes a normalised array as args[0] for some call shapes, e.g.
  // [{ host, port }, null]; unwrap it.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host;
  if (typeof first === 'string') {
    host = normalizeHost(first);
  } else if (first && typeof first === 'object') {
    host = normalizeHost(first.hostname ?? first.host);
  }
  assertLoopback(host, 'net.Socket.connect');
  return originalConnect.apply(this, args);
};

// --- dns.lookup ---
const originalLookup = dns.lookup;
dns.lookup = function lookup(hostname, options, callback) {
  assertLoopback(normalizeHost(hostname), 'dns.lookup');
  return originalLookup(hostname, options, callback);
};

// --- sentinel ---
globalThis.__NETWORK_GUARD_SENTINEL__ = 'no-network';
