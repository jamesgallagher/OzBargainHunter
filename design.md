# OzBargain Hunter — Design Specification

**Version:** 1.0 — 19 September 2026
**Status:** Specification for approval. Nothing is built.
**Companions:** `decisions.md` (the decision register — the living document), `rationale.md` (why each decision was made, what was rejected), `research.md` (raw evidence). `BRIEF.md` records the requirements verbatim.

This document is normative. It states what the system must be. It contains no history, no justification and no rejected options — those are in `rationale.md`.

---

## 1. Scope

### 1.1 Purpose

OzBargain Hunter watches `ozbargain.com.au` and notifies its single user when a deal or classified listing matches a rule he has configured.

### 1.2 In scope

- Acquisition of deal data from OzBargain's published RSS feeds.
- Acquisition of classified listings from an authenticated session.
- A rules engine evaluating match rules and vote-threshold rules.
- De-duplicated alert delivery over one or more notification providers.
- A web UI for managing rules, configuration and delivery.
- Packaging as a Docker image, published to GHCR, deployed on Unraid via a user XML template.

### 1.3 Out of scope — non-goals

- **No HTML scraping of deal pages.** All deal data comes from RSS. This is a hard boundary, not a preference.
- **No link following and no spidering.** The application reads only the three surfaces it polls (3.1). It never follows a link out of any of them.
- **No use of OzBargain's site search.** `/search/` is denied by `robots.txt`.
- **No bypass tooling.** No Cloudflare-solving libraries, proxies or User-Agent rotation.
- **No public signup, no multi-user, no roles.** Exactly one user, identified by Cloudflare Access.
- **No public API.**
- **No dynamic rules in v1.** "Rapidly rising" and "highly commented on" rules are explicitly deferred (see 5.5).

---

## 2. System overview

### 2.1 Components

The application is a single container running five internal components:

1. **Poller** — scheduled acquisition from the feeds and, if enabled, the classifieds page.
2. **Store** — SQLite database holding deals, counter observations, rules, the alert ledger and acquisition state.
3. **Rules engine** — evaluates configured rules against newly observed data.
4. **Notifier** — delivers alerts through one or more configured providers.
5. **Web UI** — a server-rendered or SPA interface for rule CRUD, delivery configuration and acquisition status.

### 2.2 Runtime

- One container. One process group. No sidecars and no separate database container.
- **Python.**
- The application binds port **8000** inside the container.
- No inbound dependency: the poller only makes outbound requests.

### 2.3 Data flow

Poll tick → fetch feeds → parse → upsert deals → append counter observations → evaluate rules → consult the alert ledger → suppress duplicates and cooldowns → group → deliver → record ledger entries and poll status.

### 2.4 Reachability

The application is reachable by two paths simultaneously:

- **Public:** `https://ozb.gallagherhome.au`, through the existing Cloudflare Tunnel.
- **Local:** the container publishes a host port, reachable at its private IP and port from the LAN.

Both paths terminate at the same application, which applies the same authentication and verification to each (see 8).

---

## 3. Data acquisition

### 3.1 Sources

**Feeds, polled on a timer:**

- `https://www.ozbargain.com.au/deals/feed` — new deals. 30 items per page, covering approximately 22 hours.
- `https://www.ozbargain.com.au/feed` — front-page deals. 20 items.

**Deal pagination is capped at two pages. This is a hard rule.** Each poll reads `?page=0`, then `?page=1`, and **stops**. No page beyond 1 is ever requested. Older deals are decaying and are explicitly out of scope.

**Measured consequence: pages 0 and 1 together span about 30 hours** of posting. **A threshold window longer than roughly 24 hours therefore cannot be evaluated**, because a deal leaves the index after about a day. Pagination is zero-indexed: `?page=0` is the first page and `?page=1` the second. **There is no third page.**

The feed does technically paginate to about 4 days across 11 pages. **That depth is deliberately not used.**

**Feeds, fetched on demand and rarely**, for watchlist terms that have a confirmed slug:

- `/product/<slug>/feed`, `/brand/<slug>/feed`, `/tag/<slug>/feed`

**Classifieds, polled on a slower timer, authenticated:**

- `https://www.ozbargain.com.au/classified`

**These three surfaces are the only things the application reads.** It never follows a link from any feed or from the classifieds listing page, never requests a deal's node page, never fetches a user profile, a comment page, or the site's HTML home page, and never performs any form of crawling. **Every decision the application makes is derived from the front-page feed, the deals feed and the classifieds listing page, and nothing else.**

### 3.2 Polling

- **Deal feeds: every 5 to 10 minutes. Never less than 5 minutes.** Default 5.
- **Classifieds: every 60 minutes.** *(Interpretation of an ambiguous answer — see Open Item O13.)*
- **Each deal-poll cycle fetches exactly three URLs, in order, then stops:** deals page 0, deals page 1, front page. **No page beyond 1 is ever requested.**
- Requests are issued **sequentially, never in parallel**, with a pause of a few seconds between each.
- At the default 5-minute interval this is **864 requests per day**, the large majority of which are conditional `304` responses with zero-byte bodies.
- The poll interval is configurable from the web UI.

### 3.3 Request discipline

- **Conditional requests are mandatory.** Every request carries `If-None-Match` / `If-Modified-Since` from the previous response for that URL. A `304` with a zero-byte body is the expected common case.
- `Retry-After` is honoured on `429` and `503`.
- All other failures back off exponentially with jitter.
- **A `403` is never retried quickly.** It is classified before any retry (see 3.5).
- One request at a time; no connection-pool races.
- Every request's URL, response class and timestamp is logged.

### 3.4 Denied paths

The HTTP client carries a **hard-coded deny list**. These paths are never requested by any part of the application, including future features:

`/api/` · `/ozbapi/` · `/search/` · `/comment/` · `/goto/` · `/privatemsg/` · `/user/login`

Note `/goto/` is the click-tracking redirect present in feed data. It may be **displayed** as a link for the user to click; the application never follows it. Notification links point at the deal's `/node/<id>` page.

### 3.5 Response classification

Every response is classified before any action is taken. The following classes are distinct and must not be conflated:

- **`200`** — parse and process.
- **`304 Not Modified`** — nothing new. Not an error. The common case.
- **Cloudflare block** — identified by a `403` with a ~17-byte body reading `error code: 1010`, or a body containing `"Just a moment..."`, or a challenge page. **Action: stop all OzBargain requests, enter long backoff, raise a prominent alert.** Never treated as transient.
- **Application permission denial** — a `403` carrying roughly 1 KB of OzBargain's own styled HTML. On `/classified` this means the session is invalid or not entitled. On a feed it is unexpected and alerts.
- **`404`** — the path has moved or been withdrawn. Alert. Do not retry on a timer.
- **`429` / `503`** — back off, honour `Retry-After`, retry with jitter.
- **Timeout / connection error** — exponential backoff; alert after three consecutive failures.
- **`200` with unparseable XML** — treated as a failure. The raw body is retained for diagnosis.

### 3.6 Classifieds acquisition

- **Authentication: the application performs the login itself**, using a dedicated OzBargain account created for this purpose (not the user's personal account).
- **Session state is determined from OzBargain's own page variable.** Every page embeds `OzB_vars` containing a `uid` field. `uid == 0` means anonymous, and any non-zero value means authenticated. This is the authoritative session check.
- Three states are distinguished and handled differently:
  - **Valid** — `uid != 0` and `/classified` returns `200`. Proceed.
  - **Expired** — `uid == 0`, or the application permission-denial page. Stop polling classifieds and raise a **visible** alert requesting attention. **Never retry the login in a loop** — repeated failed logins are the pattern that gets an account flagged.
  - **Cloudflare block** — as 3.5. Back off, stop all OzBargain requests, alert.
- **No crawling outward.** One page per poll. The application does not request individual listings, user profiles or private messages.
- **HTML parsing is used for classifieds only** — never for deals. The listing page is parsed for: listing-type badge, bracketed category tag, title, poster and timestamp.

### 3.7 Breakage handling

Acquisition is expected to break without warning, because the site owner tunes his bot rules continuously.

- **A dead-man's switch is part of the product.** If no poll has succeeded for 30 minutes, send a notification. Repeat at a decaying rate: 30 minutes, 2 hours, 6 hours, then daily.
- **The container health check reflects acquisition health, not process liveness.** `/healthz` reports unhealthy when the last successful poll is older than three poll intervals.
- **The last N failed response bodies are retained** (truncated) so the actual failure can be inspected rather than guessed from a log line.
- **Degrade rather than die.** If `/feed` fails while `/deals/feed` succeeds, the rules that need only new deals continue, and the UI states plainly that front-page detection is unavailable.
- **On a permanent block, the application stops.** It does not adopt bypass tooling, rotate User-Agents or introduce proxies.

### 3.8 Client identity

**The application acts on the user's behalf and is open about it.** It is a personal assistant representing him: it does not disguise itself as something it is not.

- Every request carries an explicit User-Agent naming the application, its version and a contact URL.
- **No browser impersonation.** No spoofed Chrome, curl, or other client identity.
- **No TLS-fingerprint impersonation.** Clients whose purpose is to mimic a real browser's TLS handshake are not used, whatever they would technically permit.
- **No identity rotation, no proxies, no bypass tooling.**

Because the tool represents the user, its conduct is his conduct:

- It stays strictly on permitted paths (3.4).
- It polls at a restrained rate (3.2).
- **If it is blocked while identifying itself honestly, it stops** rather than escalating — and the block is surfaced to the user as a decision for him, not worked around.

---

## 4. Data model

### 4.1 Entities

**`deals`** — one row per OzBargain node, keyed on the integer node ID.
Fields: node ID, title, URL, author, posted timestamp, categories (including brand/product/tag classification), merchant URL, expiry, first-seen timestamp, and **front-page first-seen timestamp** (nullable). The front-page timestamp cannot be recovered once missed, because OzBargain's feeds publish only the original posting time in both feeds.

**The node ID is the identity of a deal across every feed, and cross-feed de-duplication depends on it.** A deal appears in the deals feed and in the front-page feed under the *same* node ID, with an identical `guid` of the form `<node id> at https://www.ozbargain.com.au`. It therefore occupies one row and produces one ledger entry regardless of how many feeds it appears in. Without this, a deal present in both feeds would alert twice.

**`observations`** — one row per deal per poll.
Fields: deal ID, `votes-pos`, `votes-neg`, `comment-count`, `click-count`, observed timestamp. This history is the only reason any trend or threshold calculation is possible.

**Observations are recorded for every item seen in any feed, including the front-page feed**, and the comment count is captured from both feeds. Comment counts are stored now although no rule consumes them yet: the deferred "highly commented on" rule (5.5) will need history, and a counter that was never recorded cannot be recovered retrospectively.

**`rules`** — one row per rule.
Fields: ID, type, parameters, enabled/muted/snoozed state, surfaces it applies to (deals / classifieds / both), per-rule cooldown, optional pinned slug, creation and modification timestamps.

**`ledger`** — one row per `(node ID, rule ID)` pair that has fired.
Fields: node ID, rule ID, fired timestamp. Append-only.

**`feed_state`** — one row per polled URL.
Fields: URL, last `ETag`, last `Last-Modified`.

**`poll_state`** — last successful poll timestamp, last response class, current backoff state.

**`failures`** — the last N failed response bodies, truncated, with timestamps and response class.

**`pending_alerts`** — alerts computed but not yet delivered, so that muting a rule suppresses its already-queued output.

### 4.2 Retention

- **Counter observations: 7 days**, then deleted by a nightly job. Under the two-page cap (3.1) a deal is only observed for about 30 hours, so 7 days is a ceiling that is not reached in practice.
- **Deal rows: retained indefinitely.** They are small, and they are what makes "have I already alerted on this?" work across a repost.
- **Ledger rows: retained indefinitely.**

### 4.3 Storage engine

- **SQLite, a single file**, on the bind mount at `/mnt/user/appdata/ozbargain-hunter/`, mounted at `/data` in the container.
- **WAL mode enabled**, so UI reads do not block the poller's writes.
- **Schema migrations from version 1.** The schema will change as thresholds are tuned; losing counter history to a schema change is unacceptable.

---

## 5. Rules engine

### 5.1 Rule types in v1

**Match rule.** A product or company term drawn from a managed list, matched against **deals and classifieds**.

Matching runs over the deal title, description text and structured category labels, and over the classifieds title, category tag and type badge.

**Items from the front-page feed are matched as well as items from the deals feed.** A deal that reaches the front page without ever appearing on deals pages 0–1 is therefore still matched, rather than silently ignored. (3.1)

**On classifieds, only listings of type "Selling" are eligible.** Listings marked *Wanted* — someone seeking an item rather than offering one — and any pinned listing are never alerted on, whatever they match. A wanted advert is not an offer.

Normalisation: lower-cased, punctuation stripped, whitespace runs collapsed, so that `AMD R9700` and `amd  r9700` behave identically.

Default matching mode is **all tokens present, in any order, word-boundary anchored**. A keyword rule uses **any token present**. Word boundaries are mandatory.

If a term is pinned to a confirmed `/product/`, `/brand/` or `/tag/` slug, matching against that slug is exact and additive.

**Threshold rule.** "Has reached X upvotes." Multiple instances are configured independently, each with its own threshold.

**The window is optional.** Unset, the rule fires when a deal is seen to reach X votes at any point while it is visible. If set, it means "reached X votes within Y of posting", and **Y may not exceed 24 hours** — anything longer is rejected at entry rather than accepted, because it could never be satisfied and would present as a rule that silently never fires.

Examples: **10 upvotes in 6 hours** — a fast-rise rule, where the short window is precisely what makes it specific; and **100 upvotes** with no window, which fires on any deal that gets big, and in practice therefore fires on deals that are still climbing.

**Visibility is the decay filter, and it is why a long window is unnecessary.** OzBargain ranks deals by voting, so a deal rises while it is receiving votes and falls when it stops. **A deal that has dropped off pages 0–1 is decaying, and decaying deals are not alerted on.** A deal that would reach 100 votes over several days would still be receiving votes throughout and would therefore still be visible.

- **Threshold rules apply to deals only.** Classified listings carry no vote, comment or click counts, so a threshold rule can never fire on them.
- **Each threshold is its own rule with its own ID.** A 10-vote rule and a 50-vote rule are two rules, not one rule with a parameter. A deal clearing both produces two alerts, which is the intended behaviour and is what makes "mute the noisy one" possible.

### 5.2 Alert identity

**The alert ledger is keyed on `(node ID, rule ID)`, and a rule fires at most once per deal, ever.** This is a permanent record, not a cooldown.

Consequence: a deal legitimately alerts more than once when more than one rule fires on it.

Editing a rule's definition retains its ID and its ledger history. Resetting a rule's history is a separate, deliberate action offered in the UI.

### 5.3 Suppression

- **Per-rule cooldown.** After a rule fires, it does not fire again for its cooldown period, default 24 hours, configurable **per rule**. Rare terms may be set to zero; busy terms may be set to days.
- **Repost suppression.** If a new deal's normalised title closely matches one already alerted under the same rule within 30 days, the alert is suppressed and recorded in the UI rather than sent.
- **Expired deals are never alerted, in any circumstance.** A deal whose feed metadata marks it expired produces no alert — including a deal that becomes expired after it was first seen. Expiry is evaluated before an alert is emitted, not only when the deal is first recorded.
- **Muted rules continue to evaluate and continue writing ledger entries; they send nothing.** This is deliberate: it makes re-enabling a rule quiet rather than a burst of stale alerts, and it lets the UI report how many matches occurred while muted.

### 5.4 Gaps

- **On a gap longer than 2 hours, threshold rules are suppressed for one poll cycle** and resume on the next. A single observation after a long gap produces a delta over an unrepresentative window.
- **Match rules are unaffected by gaps**, because "this deal matches your term" is true regardless of how long the poller was away.
- **On a gap longer than 12 hours, deals posted during the outage that have already scrolled past page 1 are lost.** This is accepted. The two-page cap is a hard rule and is not extended to recover a gap.
- **On a cold start with an empty database, the system seeds silently.** Everything currently in the feeds is written to the database and every rule that would have fired is marked as already-alerted. **Zero notifications are sent.** A log line records the counts.

### 5.5 Deferred

Dynamic rules — "rapidly rising", "highly commented on" — are out of scope for v1. The counter history retained under 4.2 is what will make them possible later.

---

## 6. Notifications

### 6.1 Provider model

Delivery is **provider-abstract**. All providers implement one internal interface taking a title, a body, a URL, a priority and tags. Adding a provider must not require changes to the rules engine.

### 6.2 Providers

- **Email — the first provider.**
- **Matrix** — an explicit target. A homeserver already runs on the host (`matrix` container, client-server API on port 8008). Delivery is a single HTTP request to the client-server API. An access token must be created.
- **ntfy** — supported as a provider. Note the hosted service is `ntfy.sh`, and no ntfy instance currently runs on the host.
- **WhatsApp** — desired if it can be done cheaply. Feasibility is unresolved (Open Item O11).

Provider configuration lives in the web UI, not in a config file.

### 6.3 Content

Every alert carries: the deal title; current net votes and the rate over the configured window; which rule fired and which term matched; and a link **directly to the OzBargain node page** — never the `/goto/` redirect.

**Front-page alerts carry the highest delivery priority.** Every other alert is normal priority. Front-page presence is the strongest available indicator that a deal is good, and it is the one alert class that should be able to interrupt.

### 6.4 Controls

Every notification carries exactly two controls:

- **An unsubscribe control for the rule that fired**, labelled with the rule in the user's own words — for example *"Stop alerts for 'playstation'"* — never a rule number.
- **A "Manage alerts" link** to the alert manager.

The unsubscribe control is an **ordinary authenticated URL** — `/rules/<id>/mute` — gated by Cloudflare Access exactly like every other path. **No exception to deny-by-default is made for it.**

Flow: the link is requested. If the visitor has no valid Access session, Access authenticates them first. The request then reaches the application, which verifies the Access JWT, mutes the rule, and shows a confirmation.

**Nothing in the notification is a credential.** If a notification leaks, the link is worthless to whoever holds it, because they still face Cloudflare Access.

The *behaviour* is fixed:

- **Mute, never delete.** The rule remains and is marked disabled.
- **Already-queued alerts from that rule are suppressed** at the moment of muting.
- **A confirmation is produced** for every mute, and **undo is one tap** from it.
- **The confirmation offers snooze options** — 24 hours, 7 days, or keep it off.

### 6.5 Grouping

**Alerts are grouped per `(rule, poll)`.** One notification per rule per poll, listing every deal that rule matched in that poll, and carrying exactly one unsubscribe control naming that rule.

Grouping across rules into a single notification is prohibited: it would leave the unsubscribe control without an unambiguous target, and a control that silently disables the wrong rule is worse than no control.

### 6.6 Freebie notifications

A configuration option, **"Always notify on freebie"**, lives in the notification settings and **defaults to on**.

When enabled, **every new classified listing of type *Freebie* produces a notification immediately, without needing to match any rule.** Freebies are not a rule; they are their own notification class.

- **Pinned listings are excluded, even when they are freebies.** A pinned freebie never notifies.
- **Wanted listings are excluded**, as everywhere else (5.1).
- The notification names the poster and summarises the listing — *"<user> has just listed a new freebie — <title>"* — with a link to the listing.
- It carries the same two controls as any other alert (6.4).
- Priority is normal. Only front-page alerts outrank it (6.3).
- **De-duplication applies unchanged**: a listing notifies once, keyed on its node ID (5.2), and the cold-start seeding rule (5.4) suppresses the initial batch rather than announcing every freebie already on the board at first run.
- Expiry is respected: an already-expired freebie is not announced (5.3).

---

## 7. Web UI

### 7.1 Screens

The UI contains the following screens. Nothing else.

1. **Status** — acquisition health first: last successful poll, last response class, current backoff state, and a visible last-checked timestamp on every page of the application.
2. **Rules list** — every rule with: enabled / muted / snoozed state; match counts over 7 and 30 days; last-fired time; cooldown; optional pinned slug; and **which surfaces it applies to** (deals, classifieds, or both — fixed to deals-only for threshold rules and not editable).
3. **Rule create, edit and delete** — full CRUD. Term text, matching mode, cooldown, surfaces.
4. **Rule state control** — enable, mute, snooze, re-enable.
5. **Alert history** — what fired, when, under which rule, for which deal or listing, with a link.
6. **Near-miss and suppression log** — how close the top deals came to firing on each poll, plus suppressed reposts and expired deals.
7. **Threshold configuration** — editable.
8. **Delivery configuration** — provider selection, credentials, and a test-send button.
9. **Classifieds session status** — cookie validity, when it was last confirmed working, and somewhere to supply a fresh one.

### 7.2 Behaviour requirements

- **The UI is operable on a phone.** Every notification links to it and notifications are read on a phone.
- **CSRF protection on every state-changing request.** Cloudflare Access authenticates the user, not the origin of the request; it does not provide CSRF protection.

### 7.3 Excluded from v1

User accounts and roles; per-rule notification routing; saved searches over history; charts; a mobile app.

---

## 8. Security and exposure

### 8.1 Edge

Public traffic terminates at **Cloudflare Access** before reaching the application. Access authenticates the visitor against an identity provider and forwards a signed JWT in the `Cf-Access-Jwt-Assertion` header and the `CF_Authorization` cookie.

### 8.2 Application verification

**The application verifies the Access JWT on every request, without exception.** It fetches Cloudflare's public keys, verifies the signature, and checks that the audience claim matches the application's AUD tag and that the issuer is the correct team domain. Identity is taken from the verified `email` claim.

The application **never infers** that a request came through Access from the network path. Verification is mandatory.

**This verification is the application's primary access control**, because the LAN path exists by design (8.4).

### 8.3 Deny by default

Every path requires a verified JWT. Unauthenticated access to any path is an explicit, documented, reviewed exception, enumerated here and nowhere else.

Current exceptions:

- **The icon route**, if the logo cannot be served from a public location (see Open Item O15).

Health checks do not require an exception: the container health check calls `127.0.0.1:8000` from inside the container and never crosses the edge.

### 8.4 LAN posture

The container publishes a host port and is reachable from the LAN. **This means the requirement that nothing is reachable while bypassing the tunnel cannot be literally true**, and the accurate statement of the posture is:

> Public access is via Cloudflare Tunnel only. LAN access is open and the LAN is trusted.

The application's own JWT verification is what makes the LAN path harmless, and it is therefore load-bearing rather than defence-in-depth.

### 8.5 Secrets

- Application secrets live in **environment variables** in the container's `.env` file, by explicit decision of the owner, who accepts the risk of them being stored in the Unraid template.
- **The classifieds credential is a login for a dedicated account created for this purpose**, not the owner's personal account.
- Secrets are never logged, never rendered in the UI, and redacted from diagnostic output.
- Residual risks are recorded in Open Item O7.

### 8.6 CSRF

State-changing requests are protected by CSRF tokens. The `SameSite` behaviour of the Access cookie is not relied upon.

---

## 9. Configuration

### 9.1 Environment variables

The following values are configurable without a code change or a rebuild. Exact key names are an implementation choice.

- Feed URLs (both)
- Classifieds URL
- User-Agent string
- Poll interval, feeds
- Poll interval, classifieds
- Database path
- Notification provider and its credentials
- OzBargain account credential
- Threshold defaults

### 9.2 Editable in the UI

- Rules and their parameters, including thresholds
- Per-rule cooldowns and surface selection
- Poll intervals
- Notification providers and their configuration
- **"Always notify on freebie"** — a checkbox, on by default (6.6)

Rule configuration must be editable from the UI, which requires it to live in the database rather than in environment variables. **This is Open Item O3 and is not yet decided.**

---

## 10. Packaging and delivery

### 10.1 Repository

- **GitHub repository `jamesgallagher/OzBargainHunter`, private**, accessed with a PAT.
- **One long-lived branch: `main`.** There is no integration or beta branch; the tool serves one person and does not need one.
- Short-lived branches: `feature/*`, `fix/*`.

### 10.2 Tags

Exactly two tags are published, and only from `main`:

- `:latest` — moves on every successful build. **This is what production runs.**
- `:main-<sha>` — an immutable tag naming that specific build, so a previous version can be rolled back to **by name** rather than by image ID.

- Push to `main`, commit `a1b2c3d` → `:latest` and `:main-a1b2c3d`
- Push to any other branch → builds and tests, **publishes nothing**

There are no `beta`, `stable` or semantic-version tags.

### 10.3 Production tag

**Production tracks `:latest`.** Every successful build on `main` is a release.

The gate between a commit and production is the pipeline rather than a promotion step: publishing is conditional on lint, unit tests, the image build and the smoke test all passing, and the deployment is conditional on the assistant confirming that outcome (10.6). A failing build never reaches the host.

The Unraid template's repository field reads `ghcr.io/jamesgallagher/ozbargainhunter:latest`, and must always point at a **moving** tag — a pinned tag never produces an update.

### 10.4 Continuous integration

Workflow jobs, in order:

1. Lint / format check
2. Unit tests
3. Build the image — on every trigger, including pull requests
4. **Smoke test the built image** — run the container, wait for health, make one HTTP request, assert a sane response
5. Publish — only on `main`, and **only if 1–4 passed**

Pull requests run 1–4 and never publish.

The workflow sets a **concurrency group keyed on the branch reference with cancel-in-progress enabled**, so two rapid pushes cannot finish out of order and leave `:latest` pointing at the older commit.

Images are built for **`linux/amd64` only**, carry OCI labels including `org.opencontainers.image.source`, and use the GitHub Actions build cache.

**Branch protection is unavailable on this account** (private repository, personal Free plan). Therefore **the deployment is the gate, not the merge**: publishing is conditional on tests passing, so a failing commit cannot reach the host. This is mandatory, not optional.

### 10.5 Registry

- Images are published to `ghcr.io/jamesgallagher/ozbargainhunter`.
- **The package will be private by default** because the repository is private. The Unraid host must hold working `ghcr.io` credentials, because **Unraid's update check fails silently** on a package it cannot authenticate to — the "update ready" indicator simply never appears.

### 10.6 Unraid deployment

- Container name: **`OzBargainHunter`**
- Template: **`/boot/config/plugins/dockerMan/templates-user/my-OzBargainHunter.xml`**, canonical copy versioned in the repository at `unraid/my-OzBargainHunter.xml`
- Data directory: **`/mnt/user/appdata/ozbargain-hunter/`** → `/data`
- Internal port: **8000**, published to the host
- **All persistent state lives on the bind mount.** Nothing of value is written inside the container.

**Update mechanism — primary.** The assistant monitors the repository's CI runs on a short interval. When a run on `main` completes successfully, it applies the update on the host by invoking Unraid's own update script:

```
/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/update_container OzBargainHunter
```

That is the same script the Unraid GUI's update button calls. It stops the container, pulls the new image, **removes and recreates** the container from its template, and removes the orphaned image. **A `docker pull` followed by `docker restart` does not update a running container and must never be used as a substitute.**

The assistant confirms success by checking that the running container's image digest has changed — **not** by the script's exit status or its output.

**Update mechanism — backstop.** A host-side scheduled check applies the same update if the assistant has not already done so, so that a new build is still deployed when the agent is unavailable.

Unraid detects updates by comparing the registry's manifest digest behind the tag with the local image's digest. This is why the tag must move.

### 10.7 Logo

- Assets: `logo.svg` (master), `icon-512.png`, `icon-256.png` (transparent, 512 and 256 square), plus favicon derivatives.
- Design constraints: square; legible at 32 pixels; **no text in the mark**; no hairline strokes; readable on a dark background; transparent background.
- The mark must not imitate or evoke OzBargain's own branding.
- The Unraid template's `<Icon>` field points at a hosted copy of `icon-256.png`. **Because the repository is private, the icon cannot be served from `raw.githubusercontent.com`** — see Open Item O15.

---

## 11. Acceptance criteria

### 11.1 Delivery path

1. Push a trivial commit to `main`; record the short SHA.
2. The Actions run for that SHA is green, including the smoke test.
3. The GHCR package lists a new version tagged `latest` and `main-<sha>`.
4. The assistant detects the green run and applies the update on the host.
5. `docker inspect --format '{{.Image}}' OzBargainHunter` over SSH returns the new digest, confirming the container was recreated rather than merely pulled.
6. Rollback: point `<Repository>` at the previous `main-<sha>`, apply, and confirm the digest reverts.

### 11.2 Access control

1. With no Cloudflare session, a request to the hostname reaches the Access login and **never reaches the application** — confirmed in the application's own logs.
2. After authenticating, the page loads and the application log shows the verified `email` claim.
3. From a LAN machine, a direct request to the published port **still returns a rejection**, because the app verifies the JWT rather than trusting the path. A `200` here is a failure of the whole design.
4. A static asset requested with no session is not a `200`.
5. The Unraid Docker tab renders the logo correctly.

### 11.3 Alert behaviour

1. **One alert per criterion.** A deal tripping a threshold rule produces exactly one notification, and the ledger holds exactly one row for that `(node, rule)` pair, across many polls.
2. **Unsubscribe.** Tapping the control on a locked phone mutes that rule. Count the taps and record them.
3. **Unsubscribe requires no credential.** Nothing in the notification is a secret; the link is worthless without a valid Access session.
4. **Undo.** Re-enabling the muted rule fires on the next match and **does not** fire retroactively for matches that occurred while muted.
5. **Manage alerts** is reachable from a notification and usable at phone screen size.
6. **Deny-by-default survives the UI.** An unauthenticated POST to a rule-editing endpoint is rejected and the rule is unchanged.
7. **The notification topic is not world-readable** — an unauthenticated subscription attempt is refused.

### 11.4 Acquisition

1. A normal poll cycle is dominated by `304` responses with zero-byte bodies.
2. Manually invalidating the stored `ETag` produces a `200` and correct parsing.
3. Simulating a Cloudflare block produces the loud alert and long backoff, and does not retry.
4. Killing the container for 40 minutes produces a dead-man's-switch notification.
5. Starting with an empty database seeds silently and sends zero notifications.

---

## 12. Open items

Each is unresolved and has an owner. Nothing in this list may be assumed.

**Owner: James — decision required**

- **O3. Rule configuration storage** — database versus environment. The UI requirement makes the database the natural answer.
- **O4. UI scope for v1** — the nine screens in 7.1 are the proposed set.
- **O7. Secret storage.** Accepted as environment variables by the owner. Residual risks: credential reuse elsewhere, and plaintext storage in Unraid template backups.
- **O8. Notification channel priority** — which provider to build first beyond email.
- **O10. Naming and trademark** — "OzBargain" is a live third-party brand.

**Owner: design/implementation — to be resolved by research or probe**

- **O11. WhatsApp feasibility**, including whether routing through the existing Matrix homeserver removes the need for a direct integration.
- **O13. Cadence interpretation.** Whether the two stated intervals (60 minutes, 5–10 minutes) mean classifieds and feeds respectively.
- **O14. Icon caching** by Unraid, which may delay a changed logo appearing.
- **O15. Logo hosting**, since a private repository rules out `raw.githubusercontent.com`. Options: one unauthenticated icon route, or hosting the asset elsewhere.
- **O16. Registry retention policy** — bounded growth of per-commit tags.
- **O17. Dependency and image scanning** in CI.
- **O18. Classifieds markup capture** — the listing page's HTML has not been captured, so no parser can yet be written against it. The parser must extract, at minimum: the listing type (to restrict alerts to *Selling*), whether the listing is pinned, the bracketed category tag, the title, the poster and the timestamp.
- **O19. Classifieds access for a newly created account.** The evidence that an account unlocks the section came from an established account. Whether a brand-new account has the same access is unverified, and the dedicated account will be new.
- **O20. Classifieds session lifetime**, which determines how often the session must be renewed by hand.

**Gaps identified in the completeness audit. Not yet designed.**

- **O23. Notifier failure handling.** No behaviour is specified for a provider that fails to deliver — no retry, no backoff, and no alert when alerting itself is broken.
- **O24. Database backup and restore.** The application's entire state is one SQLite file. No backup procedure, schedule or restore path is specified.
- **O25. Timezone handling.** Feed timestamps carry `+1000` offsets. Nothing states how times are stored and in which zone they are displayed.
- **O26. The logo mark itself.** §10.7 fixes the asset set and the constraints, but the mark has not been designed and is not covered by any other item here.

**Deliberately left to implementation** (recorded so their absence is not mistaken for an oversight): the UI's routes and endpoint shapes, the Python framework, and the specific test framework and coverage expectations.
