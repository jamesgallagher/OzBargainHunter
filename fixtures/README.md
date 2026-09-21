# Fixture corpus

Every response the test suite uses. **The suite never reaches `ozbargain.com.au`** — see
*The network guard* below, which makes that a mechanised check rather than a discipline.

All files under `fixtures/http/` are genuine captures taken from the live site on
**19 September 2026**. They are evidence: do not edit them. Anything that needed changing
lives in `fixtures/http/derived/`, is produced by a script in `fixtures/tools/`, and carries
a written justification there.

---

## 1. Constants

Deterministic tests need a frozen clock. These three instants are the corpus's own timeline
and are referenced by name throughout `cards.json`.

| Name | Value (UTC) | Local (Australia/Melbourne) | Meaning |
|---|---|---|---|
| `FIXTURE_NOW` | `2026-09-19T06:20:00Z` | 19 Sep 16:20 AEST | resolves relative classifieds timestamps |
| `POLL_1_AT` | `2026-09-19T07:30:00Z` | 19 Sep 17:30 AEST | first deal poll |
| `POLL_2_AT` | `2026-09-19T08:05:00Z` | 19 Sep 18:05 AEST | second deal poll, 35 minutes later |
| `POLL_3_AT` | `2026-09-19T08:10:00Z` | 19 Sep 18:10 AEST | third deal poll, all three URLs return `304` |

`FIXTURE_NOW` is not arbitrary. Listing 975632 reads *"21 hours 38 min ago"* and must still be
newer than listing 975621, whose absolute stamp is `18/09/2026 - 18:23` AEST
(`2026-09-18T08:23Z`). That forces `FIXTURE_NOW` later than `2026-09-19T06:01Z`.

`POLL_1_AT` and `POLL_2_AT` straddle a real change in the site's data: between the two deals-feed
captures, ten deals gained votes and one new deal appeared. That is what makes threshold rules
testable without inventing numbers.

---

## 2. The poll scenarios

A poll cycle reads exactly three URLs in order (design §3.2). The corpus supplies a matching
triple for each of three consecutive polls.

| | `/deals/feed?page=0` | `/deals/feed?page=1` | `/feed` |
|---|---|---|---|
| **Poll 1** (`POLL_1_AT`) | `r0.xml` (200) | `r1.xml` (200) | `feed_feed.xml` (200) |
| **Poll 2** (`POLL_2_AT`) | `cmp_deals.xml` (200) | `r1.xml` (304) | `cmp_front.xml` (200) |
| **Poll 3** (`POLL_3_AT`) | 304 | 304 | 304 |

Poll 2's page-1 entry is a `304` on purpose: page 1 did not change between the captures, so the
normal case — *a conditional request that returns nothing* — is exercised in the middle of a
cycle that does have new data on the other two URLs.

### What moves between poll 1 and poll 2

| Node | Title (abbreviated) | Poll 1 | Poll 2 | Notes |
|---|---|---|---|---|
| 975704 | Ubiquiti UniFi Dream Router 7 @ PLE | 17 votes, deals only | 24 votes, **also on the front page** | expiry `2026-09-20T14:00:00Z`, live at both polls |
| 975666 | 20% off TorBox Subscriptions | 113 votes, **in both feeds** | 115 votes, in both feeds | the cross-feed de-duplication case |
| 975702 | Noctua NF-A14x25 G2 @ PLE | 26 votes | 28 votes | **expired** at `2026-09-19T05:51:28Z`, before poll 1 |
| 975700 | Ubiquiti UniFi Cloud Gateway Fiber @ PLE | 10 votes | 11 votes | **expired** at `2026-09-19T05:29:06Z` |
| 975672 | PLE 35th Anniversary Gaming PC | 52 votes | 53 votes | **expired** at `2026-09-19T03:54:27Z` |
| 975721 | U98 Fuel $2.339/L @ 7-Eleven | absent | 2 votes, new | the only deal that appears at poll 2 |
| 975623 | RK98 Wireless Mechanical Keyboard | present | fell off page 0 | the only deal that leaves |

Useful term facts, verified across the whole corpus:

- **`ubiquiti`** matches 975704 (live) and 975700 (expired) at both polls, and nothing else.
- **`torbox`** matches only 975666, which is in the deals feed *and* the front-page feed at both polls.
- **`noctua`** matches only 975702, which is expired at every poll — so it must never alert, ever.
- **`fuel`** appears nowhere in `r0.xml`, `r1.xml` or `feed_feed.xml`, and only in 975721 at poll 2.
- **`crocband`** matches only 975122, which exists only in `front-feed-promoted.xml`.

---

## 3. Raw captures — `fixtures/http/`

### Deals feed, `/deals/feed`

| File | Bytes | Items | Notes |
|---|---|---|---|
| `r0.xml` | 48,806 | 30 | page 0, poll 1. Newest item 975715, oldest 975623 |
| `pg0.xml` | 48,805 | 30 | a second page-0 capture seconds apart; same 30 node IDs, one byte of counter drift |
| `r1.xml` | 49,908 | 30 | page 1, poll 1. **Zero overlap with `r0.xml`** — pagination does not repeat items |
| `cmp_deals.xml` | 47,841 | 30 | page 0, poll 2 |
| `f1.xml` | 49,686 | 30 | page 1 from an earlier capture run |
| `f2.xml` / `p2.xml` | 49,107 | 30 | page 2 — captured to establish that depth exists, **never fetched by the application** |
| `pg4.xml`, `f5.xml`, `pg9.xml`, `pg10.xml` | ~48 KB | 30 each | pages 4, 5, 9 and 10. Same purpose: evidence, not inputs |

### Front-page feed, `/feed`

| File | Bytes | Items | Notes |
|---|---|---|---|
| `feed_feed.xml` | 34,013 | 20 | poll 1. All 20 node IDs also appear in `r0.xml` |
| `cmp_front.xml` | 33,963 | 20 | poll 2. All 20 node IDs also appear in `cmp_deals.xml` |

**Neither front-page capture contains a deal that is absent from pages 0–1.** The corpus therefore
cannot exercise D43 from raw captures alone; `derived/front-feed-promoted.xml` fills that gap.

### The page boundary

| File | Bytes | Notes |
|---|---|---|
| `pg11.xml`, `pg12.xml`, `pg13.xml`, `pg14.xml`, `pg19.xml` | 1,015 each | **Not empty feeds.** Each is OzBargain's styled `500 Internal Error` page, reason *"Page limit reached"* — HTML, not XML |

These exist to make the two-page cap testable from the other side: the application must never
request `?page=2` or beyond, and the guard test asserts the fixture transport is never asked for
one. If a build ever did ask, this is the body it would get, and it is not a feed.

### Classifieds

| File | Bytes | Notes |
|---|---|---|
| `classifieds-page.html` | 42,909 | `/classified` served to an **authenticated** client — `OzB_vars.uid` is `226301` |
| `cls403.html` | 1,016 | OzBargain's own `403 Access Denied` page. ~1 KB of styled site HTML |
| `feed_classifieds_feed.xml` | 1,007 | OzBargain's own `404 Not Found` page, despite the filename |
| `cls_headers.txt` | 421 | the real response headers for the 403: `server: cloudflare`, `cf-ray`, and a `PHPSESSID` cookie |

`cls403.html`, `feed_classifieds_feed.xml` and `derived/cloudflare-1010.txt` are the three refusals
the classifier must keep apart. They share nothing but a status code family: the 403 and 404 pages
are ~1 KB of OzBargain's own template, the Cloudflare block is 17 bytes with no HTML at all.

#### What is on the classifieds page

25 listings, all four types present:

| Type | Count | Pinned | Notes |
|---|---|---|---|
| `want` (*Wanted*) | 15 | 7 | never alerts (design §5.1) |
| `sell` (*Selling*) | 8 | 0 | the only alertable type |
| `free` (*Freebie*) | 1 | **1** | node 751807, dated **18 January 2023** |
| `swap` (*Swapping*) | 1 | 0 | never alerts |

The single Freebie being pinned and nearly four years old is not an accident of the capture — it
is the exact hazard design §3.6 describes. A build that ignores `pinned` announces a 2023
giveaway as new. A build that excludes pinned listings correctly emits **zero** freebie
notifications from this page.

Other properties worth knowing before writing the parser:

- **Both timestamp formats occur.** 16 listings carry `on DD/MM/YYYY - HH:MM`; 9 carry a relative
  age (`1 hour 41 min ago` … `21 hours 38 min ago`). The relative form has **no** `on` prefix.
- **Daylight saving is live in the data.** 2026 dates are AEST (+10:00); the pinned 2023 Freebie
  (`18/01/2023 - 09:33`) is AEDT (+11:00) and resolves to `2023-01-17T22:33:00Z`. A fixed +10
  offset gets this one wrong by an hour.
- **Listing 975575 has no poster.** The `/user/71488` anchor is present, but its visible text is
  the literal string `No user info`. That is an absent poster, not a user named "No user info".
- **Titles are capped at 128 characters** by the site, in `data-title` and in the anchor text
  alike (975209 and 975313 are both cut mid-word). `data-title` is still the right source: the
  anchor's inner HTML contains `<em class="dollar">` markup, `data-title` does not.
- **11 listings carry a price**; one of those (975712) also carries a separate shipping element.
- **Listings 975593 and 975574 are a genuine repost pair** — the same Nintendo Switch Online
  family membership, posted by two different users, priced identically. See §5.

---

## 4. Derived fixtures — `fixtures/http/derived/`

Produced by `python3 fixtures/tools/derive_fixtures.py`. Each is the smallest possible mutation
of a real capture; the script records why each exists.

| File | Derived from | Change | Exercises |
|---|---|---|---|
| `classifieds-page-unpinned-freebie.html` | `classifieds-page.html` | listing 975712 retyped `sell` → `free` | the positive freebie path — the raw capture's only Freebie is pinned |
| `classifieds-page-anon.html` | `classifieds-page.html` | `OzB_vars.uid` `226301` → `0` | expired session detection (design §3.6) |
| `cloudflare-1010.txt` | — | 17 bytes, `error code: 1010\n` | Cloudflare block, reproduced byte-exactly from `research.md` §2.2 |
| `deals-page0-truncated.xml` | `r0.xml` | cut inside the third `<item>` | `200` with unparseable XML |
| `front-feed-promoted.xml` | `cmp_front.xml` | item 975122 spliced in verbatim from `pg9.xml` | D43 — a deal on the front page that never appeared on pages 0–1 |

Node 975122 (*"Disney and Pixar's Lightning McQueen Dinoco Crocband Clog $125 Delivered @ Culture
Kings"*, 9 votes, no expiry) was posted four days before the capture and sits at page 9. It is
therefore unreachable under the two-page cap by any route except the front-page feed — which is
precisely the case D43 exists for.

---

## 5. Record-level fixtures — `fixtures/records/`

Produced by `python3 fixtures/tools/derive_records.py`. These are the **parser contract**: the
exact records the acquisition layer must produce from three of the captures.

| File | Source | Records |
|---|---|---|
| `deals-page0.json` | `fixtures/http/r0.xml` | 30 deals |
| `front-feed.json` | `fixtures/http/cmp_front.xml` | 20 deals |
| `classifieds.json` | `fixtures/http/classifieds-page.html` | 25 listings |

They serve two purposes. The acquisition card asserts its parsers reproduce them field for field.
The rules card consumes them directly, so the rules engine is testable against real data without
depending on the parser being finished.

Derivation rules, in full — a parser that follows these reproduces the files:

**Deals** (one record per `<item>`)

- `node_id` — the integer prefix of `<guid>`, which reads `<id> at https://www.ozbargain.com.au`.
  This is the same value in both feeds and is the identity used for de-duplication.
- `title`, `url`, `author` — `<title>`, `<link>`, `<dc:creator>`, XML-unescaped.
- `posted_at` — `<pubDate>` (RFC 822, `+1000`) converted to UTC, `Z`-suffixed, second precision.
- `expiry_at` — `ozb:meta@expiry` converted to UTC, or `null`. Present on 92 of the 130 items in
  the poll corpus. **There is no `expired` flag** — a deal is expired when `expiry_at` is in the past.
- `merchant_url` — `ozb:meta@url`. `goto_url` — `ozb:meta@link`, stored for display and **never fetched**.
- `votes_pos`, `votes_neg`, `comment_count`, `click_count` — the matching `ozb:meta` attributes, as integers.
- `categories` — one entry per `<category>`, `{kind, slug, label}`, where `kind` is the path
  segment of `@domain`: `cat`, `tag`, `brand` or `product`, and `slug` is the final segment.
- `description_html` — the `<description>` CDATA verbatim.
- Records keep feed order.

**Classifieds** (one record per `div.node.node-classified.node-teaser`)

- `node_id` — the digits in `h2.title@id` (`title975712`).
- `title` — `h2.title@data-title`, HTML-entity-decoded.
- `type` — the second class on `div.classified-type-tag`: `sell`, `free`, `want` or `swap`.
- `pinned` — any descendant carrying `classified-sticky`.
- `category_tags` — the leading `[...]` segments of the title, brackets stripped, decoded, in order.
- `poster` / `poster_id` — the `/user/<id>` anchor inside `div.submitted`; both `null` when the
  anchor text is `No user info`.
- `posted_at` — UTC. `on DD/MM/YYYY - HH:MM` is Australia/Melbourne wall time (DST-aware); a
  relative age is `FIXTURE_NOW` minus the sum of its parts. `posted_at_source` records which.
- `price` / `shipping` — `span.price` text and the nested `span[title=shipping]` text, or `null`.
- `thumbnail_url` — the first `img@src` inside `div.right`, or `null`.

---

## 6. Repost similarity — the number, and where it comes from

Design §5.3 requires repost suppression but does not fix a similarity measure. The corpus does.

Normalise a title per §5.1 — lower-case, non-alphanumeric runs to a single space, collapse
whitespace — then take the **Jaccard similarity of the token sets**:

```
similarity(a, b) = |tokens(a) ∩ tokens(b)| / |tokens(a) ∪ tokens(b)|
```

Measured over every pair in the corpus:

| Pair | Similarity |
|---|---|
| 975593 / 975574 — the real Nintendo repost | **0.667** |
| next-highest classifieds pair (975696 / 975593) | 0.400 |
| highest deals pair (975699 / 975698) | 0.364 |

**The threshold is 0.60.** It sits in a gap with nothing in it between 0.400 and 0.667, so the one
true repost in the corpus is caught and no other pair in it is. This is a tuned constant
with a margin, not a guess, and the regression test asserts both halves: the pair matches, and
nothing else does.

---

## 7. The network guard

The suite must be *incapable* of reaching OzBargain, not merely uninclined to.

`test/support/no-network.js` is loaded with `node --test --import ./test/support/no-network.js`
and replaces `globalThis.fetch`, `http.request`, `https.request`, `net.Socket.prototype.connect`
and `dns.lookup` with wrappers that throw `NetworkBlockedError` for any host that is not
`127.0.0.1`, `localhost` or `::1`. Loopback stays open because the integration tests run a real
Next.js server and a fixture HTTP server there.

Three things make it a gate rather than a habit:

1. The guard sets a sentinel global. A test asserts the sentinel is present, so removing the
   `--import` flag fails the suite instead of silently disarming it.
2. A test reads `package.json` and asserts **every** `test:*` script carries the `--import` flag.
3. A test attempts `fetch('https://www.ozbargain.com.au/deals/feed')` and asserts it throws.

The fixture transport does not open sockets at all — it maps a URL to a file — so under normal
operation the guard never fires. It exists for the build that wires the real transport into a
test by accident.

The loopback fixture server also accepts per-test response descriptors in its `timeline` option.
A descriptor can select a corpus `fixture` or an inline `body`, plus an HTTP `status`,
`contentType`, and response `headers`. This keeps malformed, empty, and failure shakeouts on the
same real HTTP transport path without adding synthetic files to the captured corpus.

The malformed shakeouts derive their body from the capture itself: `mock-shakeout.test.js` cuts
`http/classifieds-page.html` inside its first listing (before that listing's title heading), the
same way `derived/deals-page0-truncated.xml` is cut inside its third `<item>`. The cut is made in
the test rather than committed as a file, so the corpus stays exactly as captured and a truncation
can never drift away from the bytes it was derived from.
