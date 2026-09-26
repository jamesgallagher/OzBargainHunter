# OzBargain Hunter — Decision Register

The living document. One line per decision: what it is, its current answer, and its status.

**Statuses:** `DECIDED` — answered by James. `SPECIFIED` — specified by the design lane and carried into `design.md`; not objected to, but not explicitly confirmed either. `OPEN` — unresolved; see the matching `O` item in `design.md` §12.

Update this file whenever a decision changes. Do not append history — replace the line.

---

## Runtime and stack

- **D60 — Application language and runtime.** **Next.js, with the front end in React**, on **Node.js 24 LTS**. Supersedes D36 (Python). Next.js is built on React, so this is one decision. **DECIDED**
- **D61 — Two processes in one container.** Next.js has no scheduler, so the container runs **the Next.js server** and **a worker** — poller, rules engine, notifier — as two long-lived processes under a supervising entrypoint. The entrypoint forwards `SIGTERM`/`SIGINT` to both and exits non-zero if either child exits, so Docker restarts a half-dead container. The two share only the SQLite file. **Polling inside a route handler, middleware, instrumentation hook or revalidation is prohibited**: it would make the application poll only while somebody is watching it. Supersedes "one container, one process group" in design §2.2. **DECIDED**
- **D63 — Access JWT verification lives in Next.js middleware.** One file, applied to every route by default, rather than a check each route handler must remember. Two consequences bind the implementation: the JWT library must verify RS256 against a remote JWKS using **Web Crypto** rather than Node's `crypto`, because of the middleware runtime; and the matcher **must not** use the conventional `/_next/static` exclusion, because acceptance criterion 11.2.4 requires static assets to be protected too. Implements D3. **SPECIFIED**
- **D62 — Health-check authentication.** `/healthz` is behind the same middleware as everything else and authenticates with a **container-local shared secret** generated at container start. It is therefore not an exception to deny-by-default (design §8.3), and a LAN request without the secret is rejected like any other. **SPECIFIED**

## Delivery and packaging

- **D1 — Repository visibility.** PUBLIC, accessed with the two `gh` identities (the writer `jamesgallagher` and the read-only `TheJamesAIBot`); the platform default branch is `main`. **DECIDED**
- **D2 — Production tag.** `:latest`, moved by every successful build on `main`. Exactly two tags exist: `:latest` and the immutable `:main-<sha>`. No beta, stable or semantic-version tags. **DECIDED**
- **D7 — Branch structure.** One long-lived branch, `main`. No beta or integration branch. **DECIDED**
- **D42 — Update path.** The assistant monitors CI and applies the update on the host via Unraid's own `update_container` script, verifying by image digest. A host-side scheduled check is the backstop. **DECIDED**
- **D8 — Build-to-live latency.** The assistant polls CI on a short interval and applies the update on success; a host-side scheduled check is the backstop. **DECIDED**
- **D12 — Poll cadence.** Feeds every 5–10 minutes, never below 5. Classifieds every 60 minutes (interpretation pending). **DECIDED**, sub-item **OPEN (O13)**
- **D41 — Deal pagination cap.** Pages 0 and 1 only, then stop. No page beyond 1 is ever requested, including to recover a gap. Effective observation window: about 30 hours. **DECIDED**
- **D6 — Beta container.** Not built. The tool serves one person, so there is no separate beta instance. **DECIDED**
- **D16 — Registry retention policy** for per-commit tags. **OPEN (O16)**
- **D64 — Merge gate.** `main` is protected with classic branch protection requiring the four CI checks `lint`, `test`, `build`, `smoke` with `strict: true` and `enforce_admins: true`. No required approval is set: GitHub counts only write-access approvals, the approver is deliberately read-only, so the independent approval is enforced by the pipeline, not the platform. The `publish` condition remains the deployment gate: CI refuses to publish `ghcr.io` images unless the four jobs pass. Supersedes the earlier descoping to convention (the repository is now public and the protection endpoints are available). **DECIDED**
- **D66 — Runtime image on `node:24-bookworm-slim` with Playwright's Chromium headless shell.** Both build stages moved off Alpine so the build is one libc (Chromium is a native binary). The browser is installed at build time into `/ms-playwright` (a runtime `ENV`), headless shell only, and runs on Playwright's default **no-sandbox** launch as the unprivileged `node` user (uid 1000) — **no extra container privileges** (no `--cap-add`, no `--security-opt`, no `--ipc=host`; the Unraid template is unchanged). See design §2.2, §10.6; the feature card's decision 7. **SPECIFIED**

## Exposure and access control

- **D3 — Authentication architecture.** Cloudflare Access at the edge, with the application verifying the Access JWT on every request. **SPECIFIED**
- **D4 — Network placement.** Published host port, reachable on the LAN *and* through the tunnel. Accepted consequence: the "no back door" requirement cannot be literally true, and the application's JWT verification becomes the primary control. **DECIDED**
- **D5 — Public hostname.** `ozb.gallagherhome.au`. **DECIDED**
- **D17 — One-click unsubscribe mechanism.** An ordinary authenticated URL, gated by Cloudflare Access like every other path. An unauthenticated tap is authenticated first, then shown the mute confirmation. No exception to deny-by-default. **DECIDED**
- **D21 — Notification topic lockdown.** The topic must not be world-readable. Requirement carried as acceptance criterion 11.3.7. **SPECIFIED**

## Data acquisition

- **D14 — Client identity.** Honest, explicit self-identification. The tool represents the user and does not disguise itself: no browser impersonation, no TLS-fingerprint impersonation, no identity rotation, no proxies, no bypass tooling. On being blocked while identified honestly, it stops and surfaces the block rather than escalating. **DECIDED**
  - **Consequence of D60: the `curl_cffi` / `tls-client` question is moot.** Those tools were weighed when the stack was Python, and their only purpose is to imitate a browser's TLS handshake — which D14 already forbids. The platform's own HTTP client is therefore the correct one, on any stack, and under D60 that is Node's built-in `fetch`. Nothing about the stack change reopens this.
- **D13 / D10 — Classifieds authentication.** The container performs the login itself, using a dedicated account created for the tool. **DECIDED, but BLOCKED (O21)** — it requires `/user/login`, which D14's deny list (design §3.4) forbids outright. v1 therefore takes the session cookie supplied through UI screen 9 (design §7.1) and does not build the self-login. James to resolve.
- **D10b — OzBargain credential storage.** Environment variables in the container's `.env`, accepting the Unraid-template storage risk. **DECIDED**
- **D65 — OzBargain access gate.** All back-off is one persisted gate row that every OzBargain request passes through and that survives restarts. Rules B1–B5: Cloudflare block stops the gate for 24 h (7 days on a repeat within 30 days), rate limiting cools it on a 15-minute doubling ladder (five consecutive stops it), a deals permission denial stops it, and three failing cycles cool it with a 6 h cap; the four `OZB_GATE_*` keys have hard floors, in-request waits are capped at 60 s, there is no catch-up, the dead-man is suppressed while the gate is closed, and `/healthz` reports `backing_off`. See design §3.7. **DECIDED**

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
- **D48 — Classifieds eligibility.** Four listing types exist: *Selling*, *Freebie*, *Wanted*, *Swapping*. Only *Selling* may alert. *Wanted*, *Swapping* and pinned listings never alert. *Freebie* is handled by D49. **DECIDED**
- **D50 — Classifieds parser.** Specified against captured live markup (3.6): node ID from `h2.title@id`, title from `data-title`, type from the `classified-type-tag` CSS class, pinned from `classified-sticky`, poster from the `/user/` link (may be absent), timestamp in either an absolute or a relative format, optional price and thumbnail. **DECIDED**
- **D49 — Freebie notifications.** A configuration checkbox, **"Always notify on freebie"**, defaulting to **on**. When on, every new *Freebie* classified listing notifies immediately without matching any rule. Pinned listings are excluded even if free, as are *Wanted* listings. Notification names the poster and the listing. Normal priority. De-duplicated per node ID, seeded silently on cold start, and expired freebies are not announced. **DECIDED**
- **D51 — Rule configuration lives in the database** (SQLite), not environment variables, so the UI can edit it. Environment variables hold only restart-time values. **DECIDED**
- **D52 — UI scope.** All nine screens in 7.1 ship in v1. Nothing cut. **DECIDED**
- **D53 — Notifications are multi-select, not a ladder.** Any combination of configured providers may be enabled, and every alert is delivered through all of them simultaneously. No priority order, no fallback chain. **DECIDED**
- **D54 — Backup is external.** Handled by the host's third-party backup service; the application implements none. It writes a periodic consistent single-file snapshot so file-level backup captures a valid database despite WAL mode. **DECIDED**
- **D55 — Notifier failure.** Counted per provider; after five consecutive failures that provider is auto-disabled and a notice appears in the UI for the next login. Other providers are unaffected. **DECIDED**
- **D56 — Timestamps** are stored in UTC and displayed in Australia/Melbourne. **DECIDED**
- **D57 — Project name** stays *OzBargain Hunter*. Private and personal; the owner will rename if asked. **DECIDED**
- **D58 — Front-page alert semantics: presence.** Fire once per deal whenever it is observed on the front-page feed, rather than only on a transition into it. **DECIDED**
- **D59 — Logo.** The mark depicts hunting for deals to save money, produced separately within the constraints in 10.7. **DECIDED**; hosting remains **OPEN (O15)**.
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

- **D36 — Application language and runtime.** **SUPERSEDED by D60.** Was Python; the owner has changed the stack to Next.js and React.
- **D37 — Classifieds markup.** **SUPERSEDED by D50.** The markup was captured, O18 is closed, and the parser is specified in design §3.6 against it. The capture is `fixtures/http/classifieds-page.html`.
- **D38 — Classifieds access for a brand-new account.** Evidence came from an established account. **OPEN (O19)**
- **D39 — Threshold window versus feed reach.** A 7-day window exceeds the feed's ~22-hour reach. **OPEN (O12)**
- **D40 — Dependency and image scanning** in CI. **OPEN (O17)**

---

## Counts

**DECIDED:** D1, D2, D4, D5, D6, D7, D8, D10, D10b, D12, D13, D14, D17, D22, D29, D41, D42, D60, D61, D64, D65
**SPECIFIED:** D3, D16(old), D20, D21, D23, D25, D26, D27, D32, D33, D34, D62, D63, D66
**OPEN:** D9, D11(replaced), D15(old), D18, D19, D24, D30(partial), D31, D35, D38, D39, D40
**SUPERSEDED:** D11 (by D22), D36 (by D60), D37 (by D50)
**DEFERRED:** D28
