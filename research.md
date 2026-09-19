# OzBargain Hunter — Research Record

**Author:** design lane (Claude Opus 5)
**Date of research:** 19 September 2026, approximately 16:20–16:45 AEST
**Purpose:** the raw evidence behind `design.md`. Every claim here was produced by a request I made myself, or is a quotation from a page I fetched. This file exists so that the design can be audited rather than believed.

`design.md` is the argument. This file is the evidence. If the two ever disagree, this file is right and the design needs fixing.

---

## 0. How I conducted the research, and the choices I made while doing it

This matters because how to behave on somebody else's production site is itself a design input. What I did here is what the application should do later.

**Volume.** I made roughly 60 requests to ozbargain.com.au across about 25 minutes, spaced 4–6 seconds apart, strictly one at a time, never in parallel. No path was requested in a tight loop. For comparison, a single human browsing the site with a normal browser generates more requests than that in five minutes, because each page pulls CSS, JS, images and ad calls — my requests were bare HTTP with no sub-resources.

**Three things I deliberately did NOT do, and why.**

1. **I did not request `/user/login`.** `robots.txt` disallows it (F14, confirmed below). It is also the exact endpoint whose use is the open policy question in R24. Probing it to inform a recommendation about whether probing it is acceptable would have been circular, and would have made the recommendation worthless. I derived what I needed about the login form's mechanics from a page I *am* allowed to fetch — the site-wide search form, which exposes the same Drupal CSRF token scheme — and from prior art.

2. **I did not request `/api/live` or anything under `/api/`.** `robots.txt` disallows `/api/`. I know this endpoint exists and roughly what it does, because a prior-art project uses it and the `/live` page's own JavaScript calls it. I did not need to fetch it to conclude that the design should not use it.

3. **I did not request anything under `/search/`.** Also disallowed. This has a real design consequence, recorded in section 4: the site's own search cannot be used for keyword matching, which forces that work to happen locally.

**Identification.** Most requests used an ordinary Chrome User-Agent. I also deliberately tested an honest, self-identifying bot User-Agent (`OzBargainHunter/0.1 (personal deal alerter; +https://github.com/...)`) to find out whether being honest gets you blocked. It does not — it returned 200. That result is load-bearing for a design decision, so it had to be measured rather than assumed.

**A note on the fact sheet.** I was handed a fact sheet (F1–F14 in `BRIEF.md`) as a starting point and told to try to prove it wrong. I did try. It is mostly right, and it is right about the things that matter most. It is wrong or incomplete in six places, three of which would have produced a broken build. Section 7 is the itemised verdict.

---

## 1. The feed surface — what actually exists

This turned out to be much larger and much better than the fact sheet described. All of the following returned HTTP 200 with `Content-Type: application/rss+xml`, fetched 19 Sep 2026:

- `/deals/feed` — **New Deals.** 30 items, ~49 KB, spans ~22 hours of posting.
- `/feed` — **Front Page Deals.** 20 items, ~34 KB. The channel title is literally `OzBargain | Front Page Deals`.
- `/deals/popular/feed` — **Popular Deals (Last 30 Days).** 20 items.
- `/freebies/feed` — **New Freebies.** 30 items.
- `/cat/<slug>/feed` — e.g. `/cat/computing/feed`, 30 items.
- `/brand/<slug>/feed` — e.g. `/brand/ubiquiti/feed`, `/brand/amd/feed`, 10 items each.
- `/product/<slug>/feed` — e.g. `/product/catan/feed`, 10 items.
- `/tag/<slug>/feed` — e.g. `/tag/wi-fi-7/feed`, `/tag/graphics-card/feed`, 10 items.
- `/live/feed` — **OzBargain Live.** 75 items. A different shape entirely; see section 3.

`/classified/feed` returns **404**. There is no classifieds feed at any path tried.

**FACT — the two feeds the premise needs are separate feeds, and the fact sheet did not know this.** F2 recorded `/feed` as "a second, distinct feed" whose "relationship to `/deals/feed` is UNVERIFIED". It is now verified: `/deals/feed` is *new deals*, `/feed` is *front page deals*. Those are precisely the two surfaces James named in his description of the trend alert. This is the single most useful discovery of the research pass.

### 1.1 Item structure — confirmed verbatim

One complete item from `/deals/feed`, unedited:

```xml
<item>
 <title>[WA] Ubiquiti Unifi Dream Router 7 (UDR7) $399 + Delivery ($0 WA C&amp;C/ in-Store) @ PLE</title>
 <link>https://www.ozbargain.com.au/node/975704</link>
 <description><![CDATA[<div><img src="https://files.ozbargain.com.au/n/04/975704l.jpg?h=1b74c47d"/></div><p>UDR7 on a good price @PLE as part of their 35 year anniversary celebration…</p>]]></description>
 <comments>https://www.ozbargain.com.au/node/975704#comment</comments>
 <category domain="https://www.ozbargain.com.au/cat/computing">Computing</category>
 <category domain="https://www.ozbargain.com.au/brand/ubiquiti">Ubiquiti</category>
 <category domain="https://www.ozbargain.com.au/product/ubiquiti-unifi-dream-router-7">Ubiquiti Unifi Dream Router 7</category>
 <category domain="https://www.ozbargain.com.au/tag/wi-fi">Wi-Fi</category>
 <category domain="https://www.ozbargain.com.au/tag/wi-fi-7">Wi-Fi 7</category>
 <category domain="https://www.ozbargain.com.au/tag/wireless-router">Wireless Router</category>
 <ozb:meta comment-count="2" link="https://www.ozbargain.com.au/goto/975704" click-count="129"
           expiry="2026-09-21T00:00:00+10:00" starting="2026-09-19T00:00:00+10:00"
           votes-pos="3" votes-neg="0"
           url="https://www.ple.com.au/products/674101/ubiquiti-unifi-dream-router-7"
           image="https://files.ozbargain.com.au/n/04/975704l.jpg?h=1b74c47d" />
 <media:thumbnail url="https://files.ozbargain.com.au/n/04/975704l.jpg?h=1b74c47d" />
 <pubDate>Sat, 19 Sep 2026 15:51:15 +1000</pubDate>
 <dc:creator>zbmat</dc:creator>
 <guid isPermaLink="false">975704 at https://www.ozbargain.com.au</guid>
</item>
```

**FACT — F6 is correct in full.** `votes-pos`, `votes-neg`, `comment-count`, `click-count` and `expiry` are all present on `<ozb:meta>`, on every item, in both `/deals/feed` and `/feed`. The counters are real and they move (section 3.2). `expiry` and `starting` are optional — present on the item above, absent on several front-page items — so the parser must treat them as nullable.

**FACT — F5 is correct.** Brand, product and tag are first-class machine-readable data, carried as `<category domain="...">` with the domain URL encoding the type. ~5.4 categories per deal.

### 1.2 Conditional requests work, and they matter

The feed sends both validators:

```
etag: "ab2f6222c48a78f962f0741d069aaa71"
last-modified: Sat, 19 Sep 2026 06:31:37 GMT
cache-control: must-revalidate
cf-cache-status: DYNAMIC
```

Re-requesting with `If-None-Match` and `If-Modified-Since`:

```
/deals/feed  conditional GET -> 304, 0 bytes transferred
/feed        conditional GET -> 304, 0 bytes transferred
```

**FACT — a conditional poll of an unchanged feed transfers zero bytes of body.** `cf-cache-status: DYNAMIC` means these are not served from Cloudflare's edge cache, so every poll does reach OzBargain's origin — but an unchanged feed costs them a 304 and no 49 KB serialisation or transfer. This is the difference between a polite poller and a rude one, and it was not in the fact sheet at all.

### 1.3 Pagination is zero-indexed — a genuine trap

Node IDs returned, by URL:

```
/deals/feed           30 items, first ids: 975709, 975704, 975702
/deals/feed?page=1    30 items, first ids: 975609, 975608, 975606
/deals/feed?page=2    30 items, first ids: 975549, 975548, 975547
overlap(no-param, page=1) = 0
overlap(page=1, page=2)   = 0
union of 4 pages          = 120 unique deals spanning 48.5 hours
```

**FACT — `?page=1` is the SECOND page, not the first.** The no-parameter URL is page 0. Anyone who writes `for page in 1..N` will silently skip the 30 newest deals — which for this application is exactly the data it exists to look at. F3 stated pagination works and that pages do not overlap, both true, but did not catch the zero-indexing.

---

## 2. The anti-bot boundary, established empirically

This was the part most worth doing directly, because the fact sheet's framing led to the wrong mental model.

### 2.1 There are two completely different refusals, and they look nothing alike

**Refusal type A — Cloudflare blocking a client signature.**

Requesting `/deals/feed` with Python's default `Python-urllib/3.x` User-Agent:

```
HTTP 403, 17 bytes, server: cloudflare
body: b'error code: 1010\n'
```

Seventeen bytes. No HTML, no OzBargain styling, no session cookie. Cloudflare error 1010 is "the owner of this website has banned your access based on your browser's signature".

**Refusal type B — OzBargain's application denying permission.**

Requesting `/classified` with a normal Chrome User-Agent:

```
HTTP 403, 1016 bytes, server: cloudflare
set-cookie: PHPSESSID=5fdg5nh4c621rlseohhu1hv1ik; …
```

```html
<title>403 Access Denied - OzBargain</title>
<link rel="stylesheet" type="text/css" href="/files/css/pagesimple.css?ver=853"/>
<link rel="stylesheet" media="all" type="text/css" href="/themes/ozbargain/style.css?ver=853"/>
…
      <h2>403 Access Denied</h2>
      <p>You do not have permission to access this page.</p>
```

**FACT — F13 is correct, and I reproduced it exactly.** The `/classified` 403 is OzBargain's own styled error page. It sets a PHP session cookie, loads the site's stylesheets, and says in plain words that you lack permission. It is the application talking, not the edge. Note also that the request *reached* the application — Cloudflare passed it through.

Both refusals are HTTP 403 and both carry `server: cloudflare`, which is why they are so easily conflated. They are trivially distinguishable by body: 17 bytes of plain text versus 1016 bytes of styled HTML. The application must distinguish them, because they demand opposite responses (section 5 of `design.md`'s new material).

### 2.2 The block is by client signature, and it is narrow

Same URL (`/deals/feed`), same everything, varying only User-Agent:

```
Python-urllib/3.x (library default)  -> 403   error code: 1010
(no User-Agent header at all)        -> 200   49,649 bytes
python-requests/2.32.3               -> 200   49,649 bytes
Go-http-client/1.1                   -> 200   49,649 bytes
Wget/1.21.4                          -> 200   49,649 bytes
curl/8.5.0                           -> 200   49,649 bytes
GPTBot/1.1                           -> 200   (robots.txt fetch)
Chrome/140 desktop                   -> 200   49,649 bytes
OzBargainHunter/0.1 (+github url)    -> 200   (robots.txt fetch)
```

**FACT — the most common default HTTP client identity in the most likely implementation language is already banned, while sending no User-Agent at all works fine.** This is a specific, surgical rule, not a broad anti-automation posture.

**This corrects F1.** F1 claimed the feed "responded identically to a plain `curl` … and with **no User-Agent at all**", concluding no Cloudflare obstacle exists on that path. The conclusion is broadly right but the evidence was incomplete: there *is* a live Cloudflare UA ban sitting directly across the most probable implementation choice. Had the build used `urllib` with defaults, it would have failed immediately with a 17-byte body and an error code that appears nowhere in the fact sheet.

**FACT — an honest, self-identifying bot User-Agent is not blocked today.** This is the evidence behind the recommendation to use one rather than to impersonate a browser.

### 2.3 Ordinary pages are reachable; two fact-sheet claims about them are wrong

Fetched with a Chrome UA, all 200: `/`, `/deals`, `/deals?sort=votes`, `/live`, `/node/975704`, `/cat/computing`, `/wiki`, `/forum`, `/opensearch.xml`, `/sitemaps/index.xml.gz`.

**Correction to F10, part 1.** F10 says "`/forums` returned 404 — the forum path is something else". True, and the path is `/forum` (singular), which returns 200 with title `All Forums - OzBargain Forums`.

**Correction to F10, part 2 — this one matters.** F10 states that `/deals?sort=votes` returns 200 and that "top by votes is therefore scrapeable in principle". It returns 200, but **it does not sort**:

```
/deals            first 12 node ids: 975704, 975702, 975701, 975700, 975699, 975698, 975677, 975675, 975672, 975670, 975666, 975664
/deals?sort=votes first 12 node ids: 975704, 975702, 975701, 975700, 975699, 975698, 975677, 975675, 975672, 975670, 975666, 975664
identical ordering? True
```

**FACT — the `sort=votes` parameter is ignored.** A design that fetched that URL believing it was getting top-voted deals would get new deals in date order and never notice. The real "by popularity" surface is `/deals/popular/feed`, which exists and is explicitly titled "Popular Deals (Last 30 Days)".

### 2.4 robots.txt — F9 is materially wrong

The live file is **253 bytes**. Here it is in full, and this is the whole file:

```
User-Agent: *
Disallow: /api/
Disallow: /comment/
Disallow: /goto/
Disallow: /ozbapi/
Disallow: /privatemsg/
Disallow: /search/
Disallow: /user/login

User-Agent: AhrefsBot
Disallow: /

User-Agent: dotbot
Disallow: /

User-Agent: Superfeedr
Disallow: /
```

I checked it is not varied by client: fetched with Chrome, curl, GPTBot and an honest bot UA, all returned the identical 253 bytes (SHA-256 `1f66247a91b1eb00…` in every case).

**Confirmed:** the seven disallowed paths, exactly as F9 lists them, including `/user/login` (F14).

**Wrong in F9, three ways:**
- **There is no `DataForSeoBot` rule.** F9 lists it among the fully-disallowed bots. It is not in the file.
- **There are no `GPTBot`, `ChatGPT-User` or `CriteoBot` rules, and no `Crawl-delay` directive anywhere.** F9 claims these bots "get `Crawl-delay: 5`". No such lines exist. This is the most consequential of the three, because **U3 reasons from it** — U3 infers that "single-digit-second delays are within the site's tolerance" from the supposed GPTBot crawl-delay. That inference rests on a directive that is not there and must be withdrawn.
- **No sitemap is declared.** F9 says "A sitemap is declared at `/sitemaps/index.xml.gz`". There is no `Sitemap:` line. The file *does* exist and returns 200 with 7,550 bytes of XML — so the resource is real, but robots.txt does not point at it.

**Note what remains permitted, because it is the whole basis of the design:** `/deals`, `/node/*`, `/cat/*`, `/brand/*`, `/product/*`, `/tag/*`, `/classified`, and every `*/feed` path. None of these is disallowed.

---

## 3. The live feed, and measuring how fast things actually move

### 3.1 `/live/feed` is an event stream, not a deal list

Channel description: *"OzBargain Live Feed showing the most recent posts, comments and votes"*. Items look like this:

```xml
<item>
 <title>Vote Up: Noctua NF-A14x25 G2 LS PWM - 140mm x 25mm 800RPM $29 …</title>
 <link>https://www.ozbargain.com.au/node/975702</link>
 <pubDate>Sat, 19 Sep 2026 16:29:43 +1000</pubDate>
 <dc:creator>toneypaloney</dc:creator>
 <guid>https://www.ozbargain.com.au/node/975702/votes#user449487</guid>
</item>
```

Individual events, timestamped to the second, each naming the node and the acting user. No `<ozb:meta>`.

Measured on the 75-item window captured at 16:29 AEST Saturday:

```
oldest event 16:06:19, newest 16:29:43
span 1404 s = 23.4 minutes for 75 events
rate 3.21 events/minute
types: Vote Up 45, Comment 28, Post 2
```

**FACT — the `/live/feed` window held 23.4 minutes of history at this sampling moment.** That is the hard constraint on using it: it is a *sliding window*, so any poll gap longer than the window loses events permanently. A Saturday-afternoon rate is not a peak rate; a weekday evening with a hot deal will compress that window considerably. Anything built on this needs a wide safety margin, and needs to notice when it has been lapped.

Contrast with the counters in `/deals/feed`, which are **cumulative**. A missed poll widens the delta window but loses nothing. That difference decides the architecture.

### 3.2 Real counter movement, measured

Two samples of `/deals/feed`, 8.7 minutes apart (16:24:13 and 16:32:55 AEST):

```
+2 votes (13.8/hr)  +19  clicks  +0 cmts  now=104  FP  node975666  TorBox Subscriptions
+1 votes ( 6.9/hr)  +31  clicks  +0 cmts  now=29   FP  node975675  Philips LED Bulb
+1 votes ( 6.9/hr)  +25  clicks  +0 cmts  now=44       node975672  PLE Anniversary Gaming PC
+1 votes ( 6.9/hr)  +25  clicks  +0 cmts  now=112  FP  node975647  Free PAPERHEAD @ Steam
+1 votes ( 6.9/hr)  +18  clicks  +0 cmts  now=16       node975702  Noctua NF-A14x25
+0 votes            +119 clicks  +2 cmts  now=14   FP  node975699  Catan New Energies
+0 votes            +61  clicks  +0 cmts  now=26   FP  node975662  Coolabah Kamado BBQ
… (24 more, all +0 votes)
+0 votes            +6   clicks  -4 cmts  now=13   FP  node975629  D-Link Eagle Pro
```

Three findings, all of which shape the design:

**FACT — over 8.7 minutes, 24 of 29 deals moved zero votes.** Votes are a low-rate signal. A trend rule that diffs votes over a single short poll interval is reading mostly zeroes and occasionally a one. This is why the trend rule in the design uses votes-per-hour-since-posting rather than a per-poll delta.

**FACT — click-count is roughly an order of magnitude more responsive than votes** (+119 clicks versus +0 votes on the same deal, same interval). It is the better early-movement signal, and the fact sheet never mentioned it as such.

**FACT — comment-count can go DOWN.** Node 975629 lost 4 comments between samples, because comments get deleted. The counters are **not monotonic**. Any delta arithmetic that assumes monotonicity will produce negative rates and, if unguarded, nonsense alerts.

### 3.3 The distribution that justifies a threshold

120 unique deals across 4 pages of `/deals/feed`, spanning 48.5 hours. Net votes per hour since posting:

```
n=120   median 0.79 v/hr   p75 1.90   p90 4.79   p95 8.56   max 18.04
deal arrival rate: 59.4 deals/day
```

Top of the distribution:

```
18.04 v/hr  net=104  age= 5.8h  FP      node975666  TorBox Subscriptions
13.00 v/hr  net=16   age= 1.2h          node975702  Noctua NF-A14x25
11.34 v/hr  net=44   age= 3.9h          node975672  PLE Anniversary Gaming PC
10.76 v/hr  net=112  age=10.4h  FP      node975647  Free PAPERHEAD @ Steam
 9.01 v/hr  net=122  age=13.5h  FP      node975645  Free Deadshot @ Steam
 8.56 v/hr  net=1    age= 0.1h          node975709  Star Citizen Pirate Week   <-- ARTEFACT
```

**FACT — velocity alone is unstable on very young deals.** Node 975709 was 7 minutes old with a single vote, which divides out to 8.56 votes/hour and lands it in the 95th percentile. Any rate-based rule needs an absolute floor on the vote count or it will fire on every brand-new deal that gets one sympathy vote.

### 3.4 Front-page promotion is not a vote threshold

Comparing membership of `/feed` (front page) against `/deals/feed` at the same instant:

```
ON FRONT PAGE, lowest:   net=  9  node975654  Border Ranges Grass Fed Beef Box
NOT ON FRONT PAGE, highest: net= 45  node975609  20x Everyday Rewards Points
                            net= 43  node975672  PLE Anniversary Gaming PC   (age 3.9h, inside the front-page time window)
                            net= 40  node975622  Apple Watch Ultra 4
```

**FACT — a deal with 9 net votes was on the front page while a deal with 43 net votes, posted inside the same time window, was not.** Front-page placement is not computable from the vote counters. It is an editorial/algorithmic decision made by OzBargain that is only observable, not derivable.

That is good news, not bad: it means the application should *observe* the promotion event rather than try to predict it. Promotion frequency in the sample:

```
20 of 120 deals were on the front page = 17% -> ~9.9 promotions/day
```

**FACT — no promotion occurred during the 8.7-minute observation window**, consistent with ~10 per day. A 5-minute poll will catch promotions with at most 5 minutes of latency and will not be flooded.

---

## 4. Is there a sanctioned path? — the most important section

### 4.1 The site owner has answered this question in public, twice

**scotty (site owner), 29/12/2017, in the forum thread "Is there an Ozbargain API?" (node 352730)**, asked whether an API exists:

> "Not really. You can get the data from RSS feed. There are some extra XML elements containing extra data (votes, comments, etc)."

That is the owner pointing developers at the feed *and specifically at the `<ozb:meta>` extras*. Those extra elements are not an accident of the CMS; they are there to be consumed.

**scotty, 24/03/2026, in the forum thread "RSS Feed Not Working??" (node 953060)**, after RSS readers were caught by a Cloudflare rule:

> "We decided to block some older Chrome browser versions because bots and script kiddies hard coded them when they scrap OzBargain that causes excessive load. However some RSS apps also identify themselves by those old Chrome versions (and did not provide a way to change that), which then got blocked on CloudFlare as well. We have now unblocked those old Chrome versions on `*/feed` URLs, i.e. where all our RSS lives, so hopefully those RSS apps will keep on working."

And the day before, 23/03/2026:

> "We are blocking older versions of Chrome on CloudFlare. Unfortunately QuiteRSS does not let you change the user agent manually."

**FACT — OzBargain deliberately carved `*/feed` URLs OUT of its Cloudflare bot rules in order to keep automated RSS clients working.** This is the strongest possible answer to U2. The feed is not merely tolerated. The owner took specific action, at some cost to his own anti-bot posture, to keep automated feed consumers functioning.

A third data point, **scotty, 29/01/2025 (node 890968)**, on a proposal to gate deals behind membership:

> "We have tried bot mode before but people complained that their RSS feeds no longer work. Some of our webhooks also stopped working, so it would be quite fiddly to tune it to cater for all cases."

Again: RSS consumers are a constituency he protects.

**This reframes the project.** James described the premise as "a scraper … the correct method for scraping needs to be researched". The correct method, on this site, is not to scrape. It is to consume the feeds the owner built, advertises, and has actively defended. Scraping HTML would be both riskier *and worse*, because the feed carries structured data (`votes-pos`, `click-count`, brand/product/tag slugs) that the HTML only implies.

### 4.2 Set against that: F11 is correct and should not be softened

The fact sheet's F11 quotes scotty on continuously tuning rules against scrapers. I did not re-fetch node 946105, but the 2026 statements above corroborate it directly and in the same voice: rules are tuned, rules change, and the tuning is aimed at clients that cause load. My own `error code: 1010` result on `Python-urllib` is a live instance of exactly that tuning.

**The correct reading is not "we are safe because the feed is blessed."** It is: *the feed is the one surface with a public commitment behind it, and even that commitment is maintained by hand and could be reconfigured tomorrow.* Design for breakage regardless.

### 4.3 There is no Terms-of-Use prohibition on automated access

I fetched `/wiki/help:terms` (18,209 bytes) and searched the extracted text (6,124 characters) directly:

```
automat      1 hit   -- "OzBargain serves relevant ads using a completely automated process" (about their ads)
scrap        0 hits
crawl        0 hits
robot        0 hits
spider       0 hits
harvest      0 hits
RSS          0 hits
machine      0 hits
```

**FACT — OzBargain's Terms of Use contain no clause prohibiting scraping, crawling, robots, spiders, data harvesting or automated access.** I also read `/wiki/help:price_comparison_site` ("Guide for Third-Party Site Operators"), which turns out to be about manual deal-posting etiquette and says nothing about programmatic access.

So the governing signals, in descending order of authority, are: (1) `robots.txt`, which is specific and machine-readable; (2) the owner's public statements, which are unusually clear; (3) no contractual prohibition either way. This matters for R24, because it means driving `/user/login` would breach `robots.txt` but would not breach any stated term of use. That is a real distinction and James should have it stated accurately rather than dramatised in either direction.

---

## 5. The classifieds

**FACT — there is no classifieds feed.** `/classified/feed` → 404. The fact sheet's list of 404s used the plural `/classifieds/…`; the singular `/classified/feed` is also 404. Confirmed on the correct path.

**FACT — `/classified` and `/classified/` both return the OzBargain application's own 403 page** (section 2.1), not a Cloudflare challenge.

**Why it is gated — from the site's own moderators.** In node 111116 ("New Classifieds Section Replaces Selling and Swapping Forum"), moderator **moocher, 12/02/2019**:

> "Sorry, we will not be bringing it back as it is a public page, and we no longer want to expose classifieds to non-members due to incidents of scams."

And on **13/02/2019**, responding to a user reporting exactly the 403 I reproduced:

> "Were you accessing the section from a guest session (i.e. not logged in)?"

From the official wiki, `/wiki/help:classified_posting_guidelines`:

> "Only memberships older than 1 year are allowed to post in the classifieds area. There are NO exceptions to this requirement so please do not contact moderators to ask for an exemption."

> "Before posting, you must enable private messaging so that other members can communicate with you privately."

> "Users are limited to 1 classified post every 24 hours or 2 classifieds posts every 7 days. There is no exception to this."

**Verdict on U7 — still genuinely unverified, but the evidence now leans clearly one way.** A moderator has said in plain words that classifieds are hidden from non-members, and has diagnosed a user's 403 by asking whether they were logged out. That is strong circumstantial evidence that *any* logged-in account can view. It is not a demonstration, and the quoted wiki rules are about **posting** (1-year membership, private messaging enabled), not viewing — so the possibility remains that viewing also carries a requirement nobody has written down. Nobody has demonstrated it either way.

**The gate's stated purpose is scam prevention — it exists specifically to keep non-members out.** That is directly relevant to the R24 policy decision and is argued in `design.md`.

---

## 6. Prior art

GitHub search (`api.github.com/search/repositories?q=ozbargain`) returns **102 repositories**. This is a well-trodden space; James is not the first person to want this, and that is useful.

### 6.1 The projects worth learning from

**`eckyecky/ozbargain-ntfy-live-bridge`** (TypeScript/Bun, pushed 2026-03-17) — the closest analogue to this project: Docker, ntfy, a `state.ts`, a poll loop. Its actual code is the most informative artefact I found.

Its configuration defaults:

```ts
POLL_INTERVAL_MS: parseInt(getEnv('POLL_INTERVAL_MS', '60000')),
OZBARGAIN_API_URL: getEnv('OZBARGAIN_API_URL',
  'https://www.ozbargain.com.au/api/live?disable=comments%2Cvotes%2Cwiki&types=Forum%2CComp%2CAd&update=1'),
USER_AGENT: getEnv('USER_AGENT', 'curl/8.5.0'),
OZBARGAIN_COOKIES: process.env.OZBARGAIN_COOKIES,
```

Four things to take from this, three of them warnings:

1. **It uses `/api/live`, which `robots.txt` disallows.** A convenient JSON endpoint exists; it is off-limits. The feed provides the same information on a permitted path.
2. **It spoofs `curl/8.5.0` as its User-Agent** rather than identifying itself.
3. **It shells out to `curl` instead of using the runtime's own HTTP client**, and its error handling explicitly tests for `"Just a moment..."` (the Cloudflare interstitial) and `"Site Under Maintenance"`. Nobody writes that code speculatively. This is an author who was blocked by client signature and worked around it by delegating to a binary whose signature passes — independent corroboration of my `error code: 1010` finding, from a different language and runtime.
4. **`OZBARGAIN_COOKIES` — "Allow passing the full cookie string … or a fresh one".** This project contemplates operating with a session cookie *supplied to it*, not one it obtained by driving a login form. That distinction is the basis of the recommendation on R24.

Its state handling is a single `{ lastTimestamp }` JSON file with a try/catch that falls back to a cold start on parse failure. Serviceable, and a reasonable floor to beat.

**`TT-RB/OzBargain_Scraper`** (Python, pushed 2026-04-16) — RSS + keyword matching + Discord. Its README documents the de-duplication approach:

> "Cooldown: per-user cooldown (default 3600s) prevents frequent notifications. Also prevents duplicate notify for same deal."

> "Upvote scraping is heuristic; changes to OzBargain layout may require updates in `scraper.py`."

The second line is the instructive one: they parse **upvotes out of HTML** and acknowledge it is fragile — while `votes-pos` sits in the feed they are already fetching. A concrete example of the cost of not reading the feed properly.

**`harinder83Aus/ozbargain-monitor`** (Python/Flask/PostgreSQL/Docker) — the closest architectural analogue: "Scrapes OzBargain RSS feeds every 6 hours", search-term management, deal matching, web dashboard, docker-compose. Confirms the overall shape is sound. Its 6-hour interval is far too slow for R19 — you cannot detect a deal "rising quickly" on a 6-hour poll — but it is fine for its own keyword-alert purpose.

**`Accurate0/ozb`** (Rust, pushed 2026-05-06) — "Pings you in Discord when certain keywords are matched on OzBargain's new deals RSS feed." Maintained, uses SQLx/SQLite-style migrations, feed-based. A clean, small, still-alive example of exactly the R21 use case.

**`jojo-data/ozbargain-tracker`** (Python, pushed 2026-09-17 — the most recently active) — parses the feed with `defusedxml`, declares `RSS_NS = {"ozb": "https://www.ozbargain.com.au"}` (i.e. it reads `ozb:meta`), and sends a spoofed Chrome 124 User-Agent. Note `defusedxml` rather than stdlib `ElementTree`: parsing untrusted XML safely is a real concern and this author took it seriously.

**`Givo29/ozbargain-scraper`** (JavaScript, 8 stars) — builds an API by scraping HTML with cheerio, including `scraper/searchData.js` which fetches `https://www.ozbargain.com.au/search/node/${query}`. **That path is `robots.txt`-disallowed.** A popular project doing the thing the design should not do.

### 6.2 The finding James most wants: nobody logs in

I looked for this specifically, across 102 repository names and descriptions, the file trees and source of the eight most relevant projects, and targeted web searches for OzBargain plus login/session/authentication/classifieds.

**FACT — I found no open-source project that logs in to OzBargain programmatically. I found no open-source project that touches the classifieds section at all.** Every one of the 102 works exclusively on public deal data.

The closest anything comes is `eckyecky`'s `OZBARGAIN_COOKIES` environment variable — which is a *human-supplied* cookie, not an automated login.

**How to read that absence.** With 102 repositories over roughly a decade, the classifieds are an obvious thing to want and nobody has published a way to get them. That is weak evidence, but it points in one direction: either people tried and it did not work well enough to publish, or people looked at a members-only anti-scam section and decided not to. Either way, **R24 has no proven path and no prior art to copy.** It would be original work against a gate whose stated purpose is to keep automated non-members out.

### 6.3 On Cloudflare bypass tooling

Searching for what happens to scrapers when Cloudflare tightens: the standard bypass tools — `cloudscraper`, `cfscrape`, `puppeteer-stealth`, `playwright-stealth`, `FlareSolverr` — are consistently reported as obsolete or detected on sight against current Cloudflare, with `cloudscraper` abandoned and `FlareSolverr` stalled on maintenance.

**This closes off the "just bypass it" option as an engineering matter, before anyone has to argue it as an ethical one.** Adopting a bypass tool would mean taking a maintenance dependency on a losing arms race, in order to do something the site owner has publicly said he is actively tuning rules against — while an explicitly-protected feed sits right there carrying better data.

---

## 7. Verdict on the fact sheet, item by item

**CONFIRMED, reproduced myself:**

- **F1** — `/deals/feed` is a real RSS 2.0 feed, HTTP 200, `application/rss+xml`, ~49 KB, 30 items, fast. **Confirmed but incomplete** — see the correction below.
- **F2** — `/feed` is a second, distinct feed, 200, RSS, ~34 KB. **Confirmed and extended**: the "UNVERIFIED relationship" is now verified — it is the Front Page feed.
- **F4** — item structure (title, link, description CDATA, comments, pubDate with +1000, dc:creator, guid, media:thumbnail). Confirmed verbatim.
- **F5** — `<category domain>` taxonomy with `/cat/`, `/brand/`, `/product/`, `/tag/`. Confirmed, ~5.4 per deal.
- **F6** — `<ozb:meta>` carries `votes-pos`, `votes-neg`, `comment-count`, `click-count`, `expiry`, `starting`, `url`, `image`, `link`. Confirmed on every item in both feeds. Caveat added: `expiry`/`starting` are optional, and the counters are not monotonic.
- **F7** — `<ozb:title-msg type="…">` deal-state signalling. Confirmed present.
- **F12** — no official public API; `/api/` and `/ozbapi/` disallowed; third-party paid wrappers exist. Confirmed, and strengthened by scotty's own "Not really" in 2017.
- **F13** — the `/classified` 403 is an application-level permission denial with the exact wording "You do not have permission to access this page." Confirmed byte for byte.
- **F14** — `robots.txt` disallows `/user/login`. Confirmed.

**CONFIRMED but incomplete in a way that would have caused a failure:**

- **F1** — the claim that the feed responds identically "with **no User-Agent at all**" is true, but the surrounding conclusion that this path is clear of Cloudflare obstacles missed a live UA ban. `Python-urllib/3.x` gets `403 error code: 1010`. Section 2.2.
- **F3** — pagination works and pages do not overlap: confirmed (120 unique deals over 4 pages, 48.5 hours). Missed: **pagination is zero-indexed**, so `?page=1` is the second page. Section 1.3.
- **F8** — "the classifieds are not obtainable this way, and not obtainable anonymously": the *substance* is confirmed (no feed at any path, 403 on `/classified`). But the framing is superseded — F13 and the moderator quotes reframe this from "blocked" to "members-only", which is a different problem. Also, F8's path list is all plural (`/classifieds/...`); the singular `/classified/feed` is equally 404, which I checked.

**CORRECTED — the fact sheet is wrong:**

- **F9 — three errors.** No `DataForSeoBot` rule. No `GPTBot`/`ChatGPT-User`/`CriteoBot` rules and **no `Crawl-delay` directive anywhere in the file**. No `Sitemap:` declaration (though `/sitemaps/index.xml.gz` does exist and returns 200). The whole file is 253 bytes and is quoted in full in section 2.4. **U3's reasoning depends on the non-existent crawl-delay and must be withdrawn.**
- **F10 — `/deals?sort=votes` does not sort.** Returns 200, identical ordering to `/deals`. The parameter is ignored. Use `/deals/popular/feed`. Also, the forum path is `/forum`, which returns 200.

**NOT RE-TESTED:**

- **F11** — the site owner's continuous anti-scraper tuning, quoted from forum node 946105. I did not re-fetch that thread. I consider it corroborated by scotty's March 2026 statements in node 953060, which I did fetch and which say the same thing in the same voice, and by my own 1010 result. Treat as confirmed.

**NEW FACTS not in the fact sheet at all:**

- `/feed` is the **Front Page** feed — the second half of R19's signal (section 1).
- `/product/<slug>/feed`, `/brand/<slug>/feed`, `/tag/<slug>/feed`, `/cat/<slug>/feed`, `/deals/popular/feed`, `/freebies/feed` all exist (section 1).
- `/live/feed` is a per-event stream with a ~23-minute window (section 3.1).
- Conditional GET works: **304, zero bytes** (section 1.2).
- Front-page placement is **not** derivable from vote counts (section 3.4).
- Counters are **not monotonic** — comment counts fall (section 3.2).
- The Terms of Use contain **no** anti-automation clause (section 4.3).
- scotty **deliberately exempted `*/feed` from Cloudflare bot rules** to keep RSS clients working (section 4.1).
- **No product slug exists for a product nobody has posted yet** (section 8) — which decides the R20 design.
- **No prior-art project logs in to OzBargain** (section 6.2).

---

## 8. The R20 slug question, settled empirically

James's example is "AMD R9700". The obvious design is to subscribe to `/product/<slug>/feed` and get precise, structured matching with no false positives. I tested whether that is possible:

```
/brand/amd/feed                       -> 200, 10 items, "OzBargain - AMD"
/tag/graphics-card/feed               -> 200, 10 items, "OzBargain - Video Card"
/product/amd-radeon-ai-pro-r9700/feed -> 404
/product/amd-r9700/feed               -> 404
```

**FACT — brand and tag slugs exist, but there is no product slug for the R9700.**

This is not a gap in my slug guessing. A `/product/` slug comes into existence when somebody posts and tags a deal for that product. **For a product that has never been posted, the slug does not exist — and that is precisely the moment James wants to be alerted about.**

So the appealing answer is self-defeating: subscribing to the product feed for the thing you are waiting for requires the thing you are waiting for to have already happened. Text matching has to be primary. Structured slugs are a precision *enhancement* for terms that already have a slug, and a way to catch deals whose title does not contain the search string. The design recommends both, in that priority order, and this measurement is why.

---

## 9. Notification channels

James has not said where alerts go (U4). Options for a self-hosted Unraid container:

- **ntfy** — self-hostable, publish by plain HTTP POST with no SDK, topic-based, native Android and genuine iOS push, supports priorities, tags, click-through URLs and action buttons. Widely regarded as the current default for homelab alerting. Publishing is literally one HTTP request, which means the application needs no client library and the failure mode is a visible non-2xx.
- **Gotify** — self-hosted, simpler, token-per-application, weaker iOS story.
- **Apprise** — not a delivery service; a *router* that fans one notification out to 80+ backends including ntfy, Gotify, Discord, Telegram and email. Valuable once you need multiple destinations; an extra dependency if you need one.
- **Discord / Telegram webhooks** — trivial to implement, excellent formatting, but put a third-party cloud service in the alert path for a self-hosted tool, and both have rate limits that bite during a burst.
- **Email** — universally reachable, but latency and deliverability make it poor for "this deal is rising *right now*", and it needs an SMTP credential.

**Recommendation: ntfy, behind a one-method internal interface.** Reasons: it is a single HTTP POST with no SDK; the alert path stays entirely inside the house, which matches the rest of this design; it has the rich fields this application actually wants (priority for trend vs watchlist, a click URL straight to the deal, tags per rule); and there is direct prior art — `eckyecky/ozbargain-ntfy-live-bridge` is an OzBargain-to-ntfy bridge, so the pairing is proven.

The one-method interface (`send(title, body, url, priority, tags)`) is the important part. It costs nothing now and means adopting Apprise later, or adding Discord, is a new implementation of one interface rather than a change to the alerting logic.

**OPEN — U4 is still James's call**, and there is a specific thing to confirm: the orchestrator's note says an ntfy instance is already running on this host for Uptime Kuma alerts. That was not verified by me and is not in the verified-facts section of `BRIEF.md`. If it is true, this is a near-zero-cost decision and the dead-man's-switch in the failure design can reuse the same infrastructure. If it is not, ntfy is another container to run and the calculus changes slightly. Probe before relying on it.
