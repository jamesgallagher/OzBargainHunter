# OzBargain Hunter — Decision Register

The living document. One line per decision: what it is, its current answer, and its status.

**Statuses:** `DECIDED` — answered by James. `SPECIFIED` — specified by the design lane and carried into `design.md`; not objected to, but not explicitly confirmed either. `OPEN` — unresolved; see the matching `O` item in `design.md` §12.

Update this file whenever a decision changes. Do not append history — replace the line.

---

## Delivery and packaging

- **D1 — Repository visibility.** PRIVATE, accessed with a PAT. **DECIDED**
- **D2 — Production tag.** `:latest`, moved by every successful build on `main`. Exactly two tags exist: `:latest` and the immutable `:main-<sha>`. No beta, stable or semantic-version tags. **DECIDED**
- **D7 — Branch structure.** One long-lived branch, `main`. No beta or integration branch. **DECIDED**
- **D42 — Update path.** The assistant monitors CI and applies the update on the host via Unraid's own `update_container` script, verifying by image digest. A host-side scheduled check is the backstop. **DECIDED**
- **D8 — Build-to-live latency.** The assistant polls CI on a short interval and applies the update on success; a host-side scheduled check is the backstop. **DECIDED**
- **D12 — Poll cadence.** Feeds every 5–10 minutes, never below 5. Classifieds every 60 minutes (interpretation pending). **DECIDED**, sub-item **OPEN (O13)**
- **D41 — Deal pagination cap.** Pages 0 and 1 only, then stop. No page beyond 1 is ever requested, including to recover a gap. Effective observation window: about 30 hours. **DECIDED**
- **D6 — Beta container.** Not built. The tool serves one person, so there is no separate beta instance. **DECIDED**
- **D16 — Registry retention policy** for per-commit tags. **OPEN (O16)**

## Exposure and access control

- **D3 — Authentication architecture.** Cloudflare Access at the edge, with the application verifying the Access JWT on every request. **SPECIFIED**
- **D4 — Network placement.** Published host port, reachable on the LAN *and* through the tunnel. Accepted consequence: the "no back door" requirement cannot be literally true, and the application's JWT verification becomes the primary control. **DECIDED**
- **D5 — Public hostname.** `ozb.gallagherhome.au`. **DECIDED**
- **D17 — One-click unsubscribe mechanism.** An ordinary authenticated URL, gated by Cloudflare Access like every other path. An unauthenticated tap is authenticated first, then shown the mute confirmation. No exception to deny-by-default. **DECIDED**
- **D21 — Notification topic lockdown.** The topic must not be world-readable. Requirement carried as acceptance criterion 11.3.7. **SPECIFIED**

## Data acquisition

- **D14 — Client identity.** Honest, explicit self-identification. The tool represents the user and does not disguise itself: no browser impersonation, no TLS-fingerprint impersonation, no identity rotation, no proxies, no bypass tooling. On being blocked while identified honestly, it stops and surfaces the block rather than escalating. **DECIDED**
- **D13 / D10 — Classifieds authentication.** The container performs the login itself, using a dedicated account created for the tool. **DECIDED**
- **D10b — OzBargain credential storage.** Environment variables in the container's `.env`, accepting the Unraid-template storage risk. **DECIDED**

## Alerting

- **D11 — Trend alert.** **SUPERSEDED.** The velocity rule is reclassified as a dynamic rule and deferred. Replaced by the threshold-in-window rule (D22).
- **D22 — Day-one rule set.** Two static types: a **match rule** (product/company term, over deals *and* classifieds) and a **threshold rule** ("X upvotes within Y hours/days", multiple instances, deals only). **DECIDED**
- **D23 — Alert identity.** Ledger keyed on `(node ID, rule ID)`; a rule fires at most once per deal, ever. A deal may alert more than once if more than one rule fires. **SPECIFIED**
- **D43 — Front-page items are a matching surface.** Items from the front-page feed are matched against match rules exactly as deals-feed items are, so a deal promoted to the front page without appearing on deals pages 0–1 still matches. **DECIDED**
- **D24 — Threshold values.** The starting X for each threshold rule. **OPEN** — the old velocity numbers no longer apply directly.
- **D44 — Threshold windows.** Optional. If set, capped at 24 hours and **rejected at entry beyond that** rather than silently never firing. Unset means "reached X votes while visible". **Decaying deals are not alerted on**: a deal that has left pages 0–1 is decaying by definition, because OzBargain ranks by voting. **DECIDED**
- **D45 — Expired deals never alert.** Including a deal that becomes expired after it was first seen. Expiry is evaluated before an alert is emitted. **DECIDED**
- **D46 — Comment counts are stored from both feeds.** Observations are written for every item seen in any feed, including the front-page feed. Stored now because no other rule consumes them yet but a counter never recorded cannot be recovered. **DECIDED**
- **D47 — No spidering, no link following.** The front-page feed, the deals feed and the classifieds listing page are the only surfaces read. No node pages, no comments, no profiles, no HTML home page, no crawling. **DECIDED**
- **D48 — Classifieds eligibility.** Only listings of type *Selling* may alert. *Wanted* listings and pinned listings never alert. **DECIDED**
- **D49 — Freebie notifications.** A configuration checkbox, **"Always notify on freebie"**, defaulting to **on**. When on, every new *Freebie* classified listing notifies immediately without matching any rule. Pinned listings are excluded even if free, as are *Wanted* listings. Notification names the poster and the listing. Normal priority. De-duplicated per node ID, seeded silently on cold start, and expired freebies are not announced. **DECIDED**
- **D25 — Per-rule cooldown.** Default 24 hours, configurable per rule. **SPECIFIED**
- **D26 — Cold-start seeding.** First run against an empty database seeds silently and sends zero notifications. **SPECIFIED** (D15 in `rationale.md`)
- **D27 — Dead-man's switch.** Alert if no poll succeeds for 30 minutes; repeat at a decaying rate. **SPECIFIED** (D16 in `rationale.md`)
- **D20 — Alert grouping.** One notification per `(rule, poll)`. Grouping across rules is prohibited. **SPECIFIED**
- **D28 — Dynamic rules** ("rapidly rising", "highly commented on"). **DEFERRED** by explicit decision.

## Notifications

- **D29 — Provider model.** Provider-abstract behind one interface. **DECIDED**
- **D30 — Provider order.** Email first. Matrix, ntfy and WhatsApp to follow. Which comes second is **OPEN (O8)**.
- **D31 — WhatsApp.** Desired if it can be done cheaply. **OPEN (O11)** — feasibility research required.
- **D32 — Alert content and controls.** Title, votes and rate, firing rule and matched term, node-page link. Exactly two controls: rule-scoped unsubscribe, and a "Manage alerts" link. **SPECIFIED**

## Product and UI

- **D18 / D19 — Web UI scope.** Nine screens (status, rules list, rule CRUD, rule state control, alert history, near-miss log, threshold config, delivery config, classifieds session status). **OPEN (O4)**
- **D19 — Rule configuration storage.** Database rather than environment variables. **OPEN (O3)**
- **D33 — CSRF protection** on every state-changing request, not relying on cookie `SameSite`. **SPECIFIED**

## Naming and assets

- **D9 — Project name.** "OzBargain" is a live third-party brand. **OPEN (O10)**
- **D34 — Logo asset set.** `logo.svg` master, 512/256 px transparent PNGs, favicon derivatives; no text in the mark; legible at 32 px; readable on dark. **SPECIFIED**
- **D35 — Logo hosting.** Cannot use `raw.githubusercontent.com` (private repository). **OPEN (O15)**

## Not yet decided at all

- **D36 — Application language and runtime.** Python. **DECIDED**
- **D37 — Classifieds markup.** Not captured, so no parser can be written. **OPEN (O18)**
- **D38 — Classifieds access for a brand-new account.** Evidence came from an established account. **OPEN (O19)**
- **D39 — Threshold window versus feed reach.** A 7-day window exceeds the feed's ~22-hour reach. **OPEN (O12)**
- **D40 — Dependency and image scanning** in CI. **OPEN (O17)**

---

## Counts

**DECIDED:** D1, D2, D4, D5, D6, D7, D8, D10, D10b, D12, D13, D14, D17, D22, D29, D36, D41, D42
**SPECIFIED:** D3, D16(old), D20, D21, D23, D25, D26, D27, D32, D33, D34
**OPEN:** D9, D11(replaced), D15(old), D18, D19, D24, D30(partial), D31, D35, D37–D40
**DEFERRED:** D28
