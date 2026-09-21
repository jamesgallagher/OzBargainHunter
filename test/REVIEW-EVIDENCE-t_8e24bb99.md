# REVIEW-EVIDENCE t_8e24bb99 (residual-gap hardening for t_c95fd9e3)

Base: c76a58a (branch card/t_c95fd9e3). Worked on a fresh worktree at
/opt/data/builder-wt/t_8e24bb99 (git worktree add c76a58a), per the reviewer's
workspace note. Committed on branch card/t_8e24bb99 @ 5a1e67a.

Scope (git diff --stat c76a58a...5a1e67a):
  test/guards/no-network.test.js | 120 +++++...
  test/support/no-network.js     |  10 +-
  2 files changed, 121 insertions(+), 9 deletions(-)
No lib/**, no package.json, no un-named test touched. test/** only. No new deps.

## Gate (on committed HEAD 5a1e67a)
  npm run lint            -> exit 0
  npm run test:foundation -> exit 0; 68 tests / 68 pass / 0 fail / 0 skipped
  (63 baseline + 5 new tests: dns-ordering, fetch-URL-object control,
   https.request-options, http.request string-URL, http.request 2nd-arg options;
   the existing dns block test was expanded, not replaced)

## Item 1 — dns predicate breadth (KILL PROOF: FAILS under the blacklist mutant)
New: the dns block test now also blocks 198.51.100.7 (TEST-NET-1), a host named
NOWHERE else in the suite (mirrors the fetch-layer precedent at :23-34).
Mutant (applied to a private copy, node --check clean):
    - assertLoopback(normalizeHost(hostname), 'dns.lookup');
    + if (hostname === '203.0.113.9') throw new NetworkBlockedError(hostname);
Result: 68 tests / 66 pass / 2 fail, exit 1.
  ✖ a dns.lookup of a non-loopback host is blocked (dns.lookup predicate, not one literal)
      AssertionError [ERR_ASSERTION]: Missing expected exception.
  ✖ a dns.lookup of a non-loopback host never reaches the resolver (check-before-resolve ordering)
      AssertionError [ERR_ASSERTION]: Missing expected exception.
The blacklist mutant lets 198.51.100.7 through (a numeric literal needs no
resolver, so it resolves instead of throwing) -> the predicate is now pinned, not
one literal.

## Item 2 — fetch URL-object positive direction (KILL PROOF: FAILS under the input.url mutant)
New: a loopback URL-object control over a real ephemeral server
(server.listen(0,'127.0.0.1')), asserting status 200.
Mutant (private copy, node --check clean):
    - const url = typeof input === 'string' ? input : input.url ?? input.href ?? String(input);
    + const url = typeof input === 'string' ? input : input.url;
Result: 68 tests / 67 pass / 1 fail, exit 1.
  ✖ a fetch of a URL object for a loopback host is permitted over a real server (positive direction)
      Error [NetworkBlockedError]: NetworkBlockedError: host "undefined" is not loopback
Exactly the regression the card measured (status 200 on the delivered guard, threw
under the mutant). The block-direction URL-object test stays green (fail-closed),
so only the new control kills this mutant.

## Item 3 — dns check ordering (KILL PROOF: FAILS under the resolve-before-check mutant)
New: a test that records the resolver callback, throws synchronously, waits 100ms,
and asserts the callback NEVER fired (pins check-before-resolve).
Mutant (private copy, node --check clean):
    - assertLoopback(normalizeHost(hostname), 'dns.lookup');
    - return originalLookup(hostname, options, callback);
    + const r = originalLookup(hostname, options, callback);
    + assertLoopback(normalizeHost(hostname), 'dns.lookup');
    + return r;
Result: 68 tests / 67 pass / 1 fail, exit 1.
  ✖ a dns.lookup of a non-loopback host never reaches the resolver (check-before-resolve ordering)
      AssertionError [ERR_ASSERTION]: the resolver callback must never fire (check runs before the resolver is invoked)
The resolve-before-check wrapper still throws NetworkBlockedError to the caller but
the non-loopback hostname reaches the resolver first (DNS egress) — the new test
catches it. The shipped check-first ordering is correct and now pinned.

## Item 4 — stale tls comment (deleted; node fact verified)
Deleted test/support/no-network.js:149-150 ("TLS sockets do not inherit
net.Socket.prototype.connect, so tls.connect is a separate egress path"). The
verified REDUNDANT note below it is kept. Node fact re-verified on v26.5.1:
  tls.TLSSocket.prototype own connect = false
  Object.getPrototypeOf(tls.TLSSocket.prototype) === net.Socket.prototype = true
  net.Socket.prototype has own connect = true
i.e. tls.TLSSocket inherits connect from net.Socket.prototype — the deleted line
was wrong, the REDUNDANT note is correct.

## Item 5 — request-layer branches (now PINNED via a never-dialing agent)
Round-1 measured the three reported-unpinned shapes as block-direction tests and
found the deletion mutants survive (all three 68/68, exit 0), concluding they
were "NOT independently pinnable by a test" because the block is
egress-redundant (the net/tls socket wrapper still throws synchronously when
node initiates the dial). Round-2 review FALSIFIED that conclusion: pass a
never-dialing agent stub and the socket wrapper is never reached, making the
request-layer check the ONLY barrier:
  const stub = { addRequest() {}, protocol: 'http:'|'https:', defaultPort,
                maxSockets: Infinity };
  assert.throws(() => http.request('http://203.0.113.9/', { agent: stub },
                  () => {}), isNetworkBlocked);
Measured on the delivered guard: THROWS NetworkBlockedError. Under M5b/M5c the
original returns a ClientRequest (the stub is consulted, no dial) -> the
assertion fails -> the mutant dies. (M5a in round 2 was killed only by an
incidental TypeError from the invalid 3-arg call shape — corrected in round 3,
see below.) So the three branches ARE independently pinnable, and the fix
gives each of the three tests that never-dialing agent (plus the original
default-agent assertion kept as a regression net).
The default-agent (regression-net) assertions still hold under each mutant via
the socket wrapper, so the block survives the branch's absence even though the
branch itself is now pinned.

Round-3 correction (review round 2, tier H): the round-2 https test passed the
stub as a SEPARATE 2nd options object (https.request(optionsObj, {agent}, cb)).
That shape is not a documented node signature — node discards the 2nd options
object and never consults the stub (measured on stock node v26.5.1, no guard:
THREW TypeError: The "listener" argument must be of type function; stub
addRequest calls = 0). So the round-2 M5a kill was an INCIDENTAL TypeError from
that invalid call shape, not the intended assertion. Fixed in round 3 by moving
the agent INSIDE the single options object
(https.request({ hostname, port, path, agent: stubAgent }, cb)); measured on
stock node: RETURNS ClientRequest with the stub consulted (addRequest calls = 1,
no dial). Re-measured round-3:
  M5a https.request wrap removed    -> 67/68, exit 1  (KILLED by the intended
                                              stub assertion: Missing expected
                                              exception, ClientRequest returned)
  M5b string-URL branch removed     -> 67/68, exit 1  (KILLED by the stub test)
  M5c 2nd-arg options branch removed-> 67/68, exit 1  (KILLED by the stub test)

ESM named-import path: disclosed in the guard docblock out-of-scope list
(`import { lookup } from 'node:dns'` binds to the underlying function at module-link
time, not to the namespace property the guard mutates, so it returns the unwrapped
function). Not wrapped — it cannot be wrapped from this in-process opt-in guard
(the named import is bound before the guard's `dns.lookup = ...` mutation is
observable to a later import), and wrapping it is out of the card's test/**-only
scope. Disclosed, per the card's "either disclose it or wrap it".

## Mutant summary table (round 3, current bytes)
  M1 dns predicate (blacklist 203.0.113.9)   -> 66/68, exit 1  (KILLED by new tests)
  M2 fetch URL-object (input.url only)        -> 67/68, exit 1  (KILLED by new control)
  M3 dns ordering (resolve before check)      -> 67/68, exit 1  (KILLED by new ordering test)
  M5a https.request wrap removed              -> 67/68, exit 1  (KILLED by the intended
                                                             stub assertion, round 3)
  M5b string-URL branch removed              -> 67/68, exit 1  (KILLED by the stub test)
  M5c 2nd-arg options branch removed         -> 67/68, exit 1  (KILLED by the stub test)

All mutants applied to a private copy, all node --check clean.
