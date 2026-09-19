/**
 * The network guard. Loaded via `node --test --import ./test/support/no-network.js`.
 * Replaces globalThis.fetch, http.request, https.request,
 * net.Socket.prototype.connect and dns.lookup with wrappers that throw
 * NetworkBlockedError for any host other than 127.0.0.1, localhost or ::1.
 * Loopback stays open because card 5's integration tests run a real
 * server there.
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

function hostFromUrl(url) {
  try {
    return new URL(url).hostname;
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
  const url = typeof input === 'string' ? input : input.url;
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
      host = input.hostname;
    } else if (options && options.hostname) {
      host = options.hostname;
    } else if (options && options.host) {
      host = options.host;
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
  let host;
  if (typeof args[0] === 'string') {
    host = args[0];
  } else if (args[0] && typeof args[0].host === 'string') {
    host = args[0].host;
  }
  assertLoopback(host, 'net.Socket.connect');
  return originalConnect.apply(this, args);
};

// --- dns.lookup ---
const originalLookup = dns.lookup;
dns.lookup = function lookup(hostname, options, callback) {
  assertLoopback(hostname, 'dns.lookup');
  return originalLookup(hostname, options, callback);
};

// --- sentinel ---
globalThis.__NETWORK_GUARD_SENTINEL__ = 'no-network';
