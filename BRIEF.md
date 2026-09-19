# OzBargain Hunter — Requirements Brief (as stated by James)

**Status:** captured verbatim from the stakeholder. This file is a RECORD OF WHAT WAS ASKED FOR,
not a design. Design is the design lane's job — do not treat anything here as a settled mechanism.

**Date captured:** 19 September 2026 (AEST)

---

## 1. The stakeholder's own words

> I want to start a new project. This project will be run as a docker project, and will exposed to
> the internet via CloudFlare tunnel. I want it to enforce a JWT on each page, nothing should be
> accessible by a back door without coming through CloudFlare tunnel.
>
> I want this to be a new folder in our Project Directory, called "OzBargainHunter" and the project
> itself will be called "OzBargain Hunter". It will be version controlled with GitHub and it needs to
> have a pipeline build that every commit it will automatically build. We will run a tagging system,
> but every new version will be tagged as latest unless we branch off and then we will have a beta
> tag alongside latest.
>
> This will be run on Unraid using a Docker GUI xml template, and needs to be able to see when there
> is a new version so it can update. On a new push, it will push to GitHub, Github will build it,
> once it has successfully built, we need Unraid to pull the new container package down so it stays
> updated.
>
> Initial steps will be to create a design.md. No build at this stage.
>
> At this stage, lets just create this. I will supply the application premise and idea in a new
> message later. Right now, all we will start doing is documenting the basic application ideas listed
> above.
>
> I will need a logo designed for this, which will also be used in the Unraid Template.

Additional standing instruction from the stakeholder:

> I want Claude Opus 5 to challenge my ideas where appropriate, I don't want a "yes sir, yes sir,
> 3 bags full sir". If an idea is dumb, I want to be challenged.

## 2. Requirements enumerated from the above

**Naming**
- R1. Project folder: `OzBargainHunter`, inside the Project Directory (`/opt/data/projects/`).
- R2. Project display name: `OzBargain Hunter`.
- R3. A logo is required. The same logo asset is to be used in the Unraid Docker template.

**Packaging & hosting**
- R4. The deliverable is a Docker container.
- R5. It runs on Unraid, managed through the Unraid Docker GUI, i.e. via a user XML template
  (`/boot/config/plugins/dockerMan/templates-user/`).
- R6. The container must be able to detect that a new version exists, so the host can update it.

**Exposure & access control**
- R7. Public exposure is via Cloudflare Tunnel.
- R8. A JWT must be enforced on each page.
- R9. Nothing may be reachable by a back door that bypasses the Cloudflare Tunnel path.

**Source control & delivery**
- R10. Version controlled on GitHub.
- R11. A pipeline build: every commit automatically builds.
- R12. Tagging: every new version is tagged `latest`; when work branches off, a `beta` tag exists
  alongside `latest`.
- R13. Delivery loop: push → GitHub builds → on a successful build the host pulls the new image so
  the running container stays updated.

**Scope of THIS stage**
- R14. Produce `design.md`. No application build, no scaffolding of the product itself.
- R15. The application premise / product idea is NOT yet supplied. It arrives in a later message.

## 3. Verified environment facts

Everything in this section was checked by running a command, not assumed. Where something is
unverified it is labelled as such.

**Where this work is happening**
- Hermes (the orchestrator) runs in a container `hermes-agent` on the Unraid host itself.
- That container has **no Docker socket** — it cannot build, run, or inspect images locally.
  Container/registry/host work must go over SSH to the host.
- Host access: `ssh -i /opt/data/.ssh/radiance_ed25519 root@192.168.0.148` (key-based, works).
- Local working copy: `/opt/data/projects/OzBargainHunter`, `git init` already done.
  The git repo currently has no commits and no remote.

**The Unraid host**
- Unraid 7.2.3, hostname `SlimMamma`, address `192.168.0.148`.
- Docker version 27.5.1.
- 40+ containers currently running. Many LAN-facing services publish ports on `0.0.0.0`, e.g.
  `8080` (qBittorrent), `8081` (Nextcloud), `8880`, `8881`, `8001`, `8184`, `3000`, `3001`.
  Port `8000` is reported free. **Any port a new container publishes is reachable from the LAN
  by default** — that behaviour is a fact of this host's current configuration, not a recommendation.
- A reverse proxy and DNS setup exists elsewhere on the network; see "Public exposure" below.

**GitHub**
- `gh` CLI installed at `/opt/data/.local/bin/gh`, authenticated as user **`jamesgallagher`**
  (a personal account, not an organisation account; `plan` returned `null` from the API).
- Token scopes: `gist`, `read:org`, `read:packages`, `repo`, `workflow`.
  Note it does **not** carry `write:packages`.
- The account is a member of one organisation: `Open-University-PG-SWEng`.
- Existing container packages already published under the account include:
  `stremio-forced-english-subtitles`, `nuvio-forced-english-subtitles`, `stremio_ai_recommender`,
  `spoilerfreeplexsports`, `yt-simple-download`, `sortdvr`, `taxhelper`.
- **The GitHub account's plan tier could not be determined from the API.** This matters because
  rulesets, classic branch protection and merge queues are plan-gated for private repos on a
  personal Free account. UNVERIFIED — must be probed before any criterion depends on it.

**Existing, working precedent on this host** (this is what the stakeholder's other apps do today)
- Roughly eight containers run images of the form `ghcr.io/jamesgallagher/<name>:latest`.
- Each has a user XML template at `/boot/config/plugins/dockerMan/templates-user/my-<Name>.xml`.
- Reference template `my-ForcedEnglishSubs.xml`, quoted exactly as it exists on disk:

```xml
<?xml version="1.0"?>
<Container version="2">
  <Name>ForcedEnglishSubs</Name>
  <Repository>ghcr.io/jamesgallagher/stremio-forced-english-subtitles:latest</Repository>
  <Registry>https://github.com/jamesgallagher/Stremio-Forced-English-Subtitles</Registry>
  <Network>bridge</Network>
  <MyIP/>
  <Shell>sh</Shell>
  <Privileged>false</Privileged>
  <Support/>
  <Project/>
  <ReadMe/>
  <Overview/>
  <Category/>
  <WebUI>https://fes.gallagherhome.au/</WebUI>
  <TemplateURL/>
  <Icon>https://fes.gallagherhome.au/icon.png</Icon>
  <ExtraParams/>
  <PostArgs/>
  <CPUset/>
  <DateInstalled>1780852745</DateInstalled>
  <DonateText/>
  <DonateLink/>
  <Requires/>
  <Config Name="GUI" Target="7000" Default="" Mode="tcp" Description="" Type="Port" Display="always" Required="false" Mask="false">7000</Config>
  <Config Name="Data" Target="/data" Default="" Mode="rw" Description="" Type="Path" Display="always" Required="false" Mask="false">/mnt/user/appdata/stremio-forced-subs/data</Config>
  <Config Name="Public URL" Target="PUBLIC_URL" Default="" Mode="" Description="" Type="Variable" Display="always" Required="false" Mask="false">https://fes.gallagherhome.au</Config>
  <TailscaleStateDir/>
</Container>
```
  Note the pattern this template already uses: the `<Icon>` points at the app's own public URL, and a
  `Public URL` variable is passed into the container. Whether those choices are good is a design
  question, not a fact.

**Public exposure / Cloudflare Tunnel**
- A container `cloudflared` (`cloudflare/cloudflared:latest`) is running on the host, in tunnel mode:
  entrypoint `cloudflared --no-autoupdate`, command `tunnel run 2af6626c-f01d-4532-bf84-0af542711ea3`.
  It publishes no host ports.
- Its configuration directory is `/mnt/user/appdata/cloudflared/`, containing
  `config.yml`, `cert.pem` and the tunnel credentials JSON for tunnel
  `2af6626c-f01d-4532-bf84-0af542711ea3`.
- `/mnt/user/appdata/cloudflared/config.yml` in full:

```yaml
tunnel: 2af6626c-f01d-4532-bf84-0af542711ea3
credentials-file: /home/nonroot/.cloudflared/2af6626c-f01d-4532-bf84-0af542711ea3.json

# NOTE: You should only have one ingress tag, so if you uncomment one block comment the others

# forward all traffic to Reverse Proxy w/ SSL
ingress:
  - service: https://192.168.0.173
    originRequest:
      originServerName: gallagherhome.au
```
  **Read this carefully.** The tunnel has a single catch-all ingress rule that forwards *all* public
  hostnames to a reverse proxy at `192.168.0.173` over HTTPS. So per-hostname routing for
  `*.gallagherhome.au` is currently done by that reverse proxy — which is on a *different machine*
  from the Unraid host.
- **UNVERIFIED:** whether a new public hostname for OzBargain Hunter has to be registered in the
  Cloudflare dashboard, on the reverse proxy at `192.168.0.173`, or both. This was not probed, and
  it is on the critical path for requirement R7. Do not assume an answer; flag it as an open item.
- **UNVERIFIED:** whether this tunnel is remotely managed (dashboard ingress) or locally managed
  (the `config.yml` above). The presence of a local `config.yml` with a single catch-all suggests
  locally managed, but the file also looks like the stock installer template with comments intact.
- Note that `gallagherhome.au` hostnames resolve through Cloudflare, and the existing app templates
  use them (e.g. `fes.gallagherhome.au`), so the pattern is live in production today.

## 4. What the design lane is asked to produce at this stage

1. `design.md` in the repository root.
2. It must cover the ideas listed in section 2 faithfully, and must state plainly where it disagrees
   with them and why. The stakeholder has explicitly asked to be challenged rather than agreed with.
3. It must record the open questions and unverified items that block the design, including the ones
   in section 3, rather than filling them with assumptions.
4. It must leave the product surface clearly and honestly unfinished, because the application premise
   has not been supplied yet. Inventing a product to fill the gap would be worse than leaving a
   marked placeholder.
5. No application code, no Dockerfile, no workflow files, no repository scaffolding. `design.md` and
   nothing else at this stage.

---

# PREMISE — supplied by James, 19 September 2026

Added after the design lane's Stage 0 document. This section is a RECORD, not a design.

## P.1 The premise, in James's own words

> OzBargain Hunter is a scraper for OzBargain.com.au. It will use certain criteria to find the best or
> targeted deals posted on OzBargain. It needs to be super aware that there is antibot protection and
> so the correct method for scraping needs to be researched. Bot detection is done by Cloudflare.
>
> There is an RSS feed available, I am not sure what it contains, just new deals or if it has access
> to the 'Classifieds' section too.
>
> An example of an Alert. Any new deal that has been posted that suddenly starts to rise very quickly.
> Possibly this would be a new deal, that sudden finds itself on the 'new deals' page as well as the
> front page.
>
> Another type of alert will be a company or product is posted from a saved list. Example, "AMD
> R9700". If any deal or classified is posted with this product, alert should be generated.
>
> Another example of an alert. Any time some one posts a deal about ChatGPT as a deal or classifieds,
> send a notification.

## P.2 Requirements enumerated from the premise

- R16. The product is a scraper/aggregator for OzBargain.com.au.
- R17. It applies criteria to surface "the best" or specifically targeted deals.
- R18. The scraping method must be chosen with anti-bot protection in mind; bot detection is
  Cloudflare's.
- R19. Alert type A — **trending**: a newly posted deal that starts rising quickly, evidently
  signalled by it appearing on both the "new deals" page and the front page.
- R20. Alert type B — **watchlist match**: a saved product/company term (example: "AMD R9700"); alert
  on any deal **or classified** containing it.
- R21. Alert type C — **keyword match**: any deal or classified about a term (example: "ChatGPT").
- R22. `Classifieds` content is in scope for alerts. Whether it is obtainable at all is now a verified
  fact — see F8 below, and it is the largest new obstacle in the project.
- R23. Alerts are delivered as notifications. The delivery channel is NOT stated — see U4.

## P.3 Scraping / data-source research — VERIFIED FACTS

Every item below was produced by an actual request from this container on 19 September 2026 (AEST),
or is quoted from a live public page. Raw response files are kept in `/opt/data/arch-scratch/`.

- **F1. `https://www.ozbargain.com.au/deals/feed` works, and it is a real RSS 2.0 feed.**
  HTTP 200, `content-type: application/rss+xml; charset=utf-8`, 49,645 bytes, 30 `<item>` elements,
  served in ~90 ms. It responded identically to a plain `curl` with a normal browser User-Agent, with
  a normal `Accept` header, and with **no User-Agent at all**. **No Cloudflare challenge, interstitial
  or block was encountered on this path from this host.**
- **F2. `https://www.ozbargain.com.au/feed` is a second, distinct feed** — HTTP 200, RSS, 34,013 bytes.
  Its relationship to `/deals/feed` is UNVERIFIED.
- **F3. The feed paginates, and pagination is real.** `?page=1`, `?page=2`, `?page=5` all return 200.
  Page 2 shares **zero** node IDs with page 1. One page of 30 items spans **22 hours 18 minutes** of
  posting (19 Sep 15:51 back to 18 Sep 17:32); page 2 reaches back to 18 Sep 07:05. So three pages
  reach back roughly two days.
- **F4. Item structure.** Each item carries: `title`; `link` (`https://www.ozbargain.com.au/node/<id>`);
  `description` (CDATA HTML — a thumbnail image plus a truncated body); `comments` URL; `pubDate`
  (RFC-822 with `+1000`); `dc:creator` (the poster's username); `guid` (`<id> at https://www.ozbargain.com.au`);
  and a `<media:thumbnail>`.
- **F5. Item taxonomy is rich and machine-readable.** Each item carries multiple `<category>` elements
  whose `domain` attribute classifies the term: `/cat/<slug>` (section, e.g. computing),
  `/brand/<slug>` (e.g. ubiquiti), `/product/<slug>` (e.g. ubiquiti-unifi-dream-router-7) and
  `/tag/<slug>` (e.g. wi-fi-7). 161 category elements across 30 items — about 5.4 per deal. **Brand,
  product and tag terms are therefore first-class feed data, not something that has to be inferred
  from the title string.**
- **F6. THE VOTING DATA IS IN THE FEED.** Every item carries a custom `<ozb:meta ... />` element with
  the attributes `votes-pos`, `votes-neg`, `comment-count`, `click-count`, `expiry`, `starting`,
  `url` (the merchant's own product URL), `image`, and `link` (an OzBargain `/goto/` redirect).
  Observed spread within a single page: `votes-pos` 2 to 120, `comment-count` 0 to 77,
  `click-count` 95 to 5294. **This means a "rising quickly" trend can be detected by polling the feed
  and diffing these counters over time. It does not require scraping deal pages.**
- **F7. The feed also signals deal state.** Some items carry `<ozb:title-msg type="...">`
  — observed `expired` (4), `upcoming` (2), `targeted` (1) in the sampled page. Expiry is also present
  as an absolute timestamp in `ozb:meta/@expiry`.
- **F8. THE CLASSIFIEDS ARE NOT OBTAINABLE THIS WAY, AND NOT OBTAINABLE ANONYMOUSLY.**
  - No RSS feed exists for them at any path tried: `/classifieds/feed`, `/classifieds/all/feed`,
    `/classifieds/feed/all`, `/classified/feed`, `/classified/rss`, `/classified/all/feed` → **all 404**.
    `/classifieds` and `/classifieds/` → **404**.
  - The real path is `/classified`, and it returns **HTTP 403** with the body titled
    `403 Access Denied - OzBargain` — OzBargain's own styled error page (`/files/css/pagesimple.css`),
    served through Cloudflare (`server: cloudflare`, `cf-ray: ...-MEL`, `PHPSESSID` cookie set).
  - **This 403 was reproduced in a real headless Chromium browser, not just curl.** The browser's page
    title was `🐴 403 Access Denied - OzBargain`. A genuine JavaScript/managed challenge would have
    been solved by a real browser. **It was not. This is an application-level denial to unauthenticated
    clients.**
  - Consequence: **R22 as stated is not achievable without an authenticated OzBargain account**, and
    possibly not even then. See U1.
- **F9. `robots.txt`, quoted in full for the disallow list.** `Disallow:` is set for `/api/`,
  `/comment/`, `/goto/`, `/ozbapi/`, `/privatemsg/`, `/search/` and `/user/login`. Per-bot rules:
  AhrefsBot, dotbot, DataForSeoBot and Superfeedr are `Disallow: /`; GPTBot, ChatGPT-User and
  CriteoBot get `Crawl-delay: 5`. A sitemap is declared at `/sitemaps/index.xml.gz`.
  **Note what is NOT disallowed: `/deals`, `/node/*`, `/cat/*`, and `/deals/feed` itself.**
- **F10. Ordinary HTML pages are currently reachable by a plain client.** `/deals`,
  `/deals?sort=votes`, `/live`, `/node/975704` and `/cat/computing` each returned **200** to `curl`
  with a browser User-Agent. (`/forums` returned 404 — the forum path is something else.) "The
  front page" and "top by votes" are therefore scrapeable in principle today, but see F11.
- **F11. The site owner actively and continuously defends against scraping.** In a public forum thread
  (node 946105, "Cloudflare Verification Every Page Very Slow", January 2026), the site owner
  **scotty** states that verification was implemented to "make sure bot access is throttled or
  blocked", acknowledges the cost to genuine users, and adds that "some of those sneaky bad actors keep
  on changing tactics so they can scrap more OzBargain pages … so the fine-tuned rules you set up last
  week become no longer relevant". He notes they cannot afford AI-driven adaptive defence. Read
  plainly: **whatever works today is not guaranteed to work next month, and the rules are tuned
  against exactly the behaviour a scraper exhibits.**
- **F12. There is no official public API.** `robots.txt` disallows `/api/` and `/ozbapi/`. Third-party
  paid wrappers exist (e.g. a "Parse" marketplace endpoint) that re-expose publicly available deal
  data with voting counts. Their reliability is unverified, they insert a third party into the request
  path, they cost money, and they do not change the underlying access position. Recorded as an option,
  not a recommendation.

## P.4 Open questions raised by the research — UNVERIFIED

- **U1. Does `/classified` become accessible when logged in with a real OzBargain account?**
  UNVERIFIED and not guessable. It requires an account and a live login, which this agent must not
  perform. Note the forum thread node 111116 ("New Classifieds Section Replaces Selling and Swapping
  Forum") contains a user reporting `403 Access Denied` to the classified page as long ago as 2011, so
  this behaviour is not new. R22 depends entirely on the answer.
- **U2. Is the RSS feed a sanctioned access path, or merely tolerated?** UNVERIFIED. There is no
  published policy. What is verifiable: `robots.txt` does not disallow it, and the site advertises the
  feed with an RSS icon on its own listing pages. This is the strongest evidence available that the
  feed is the *intended* machine-readable surface.
- **U3. What polling rate is polite and safe for the feed?** UNVERIFIED. No crawl-delay is published
  for the feed path. The `GPTBot`/`ChatGPT-User` rules suggest single-digit-second delays are within
  the site's tolerance for AI crawlers, but that is an inference, not a fact.
- **U4. Where do notifications go?** NOT STATED. Not in the premise. (Known from other context: an
  ntfy instance is already in use for Uptime Kuma alerts, but the premise does not name a channel and
  this must not be assumed on his behalf.)
- **U5. Does James hold an OzBargain account, and is he willing to use it?** UNVERIFIED. Relevant to
  U1, to the classifieds requirement R22, and to whether any authenticated access is permissible
  under the site's terms.
- **U6. What does "the best deals" mean numerically?** The premise says "certain criteria to find the
  best or targeted deals" without defining them, and R17 is therefore not yet a testable requirement.
  The trend alert (R19) also has no threshold: "rise very quickly" and "finds itself on the front page"
  are not yet numbers.

---

# REQUIREMENT UPDATE — James, 19 September 2026 (mid-research)

Delivered while the design lane was running its research pass. Recorded verbatim.

> So, classified is a authorised only section, so we will likely need to create a user login for this.
> The bot will need to authenticate, then search that section.

## R.1 New requirement

- **R24. The bot authenticates to OzBargain with a user account, then searches the classifieds
  section.** This supersedes the implication in R22 that classifieds must be reachable anonymously.
  James believes the section is authorised-users-only and that an account is the way in.

## R.2 Additional verified facts

- **F13. The `/classified` 403 is an application-level permission denial, not a bot challenge.**
  The complete response body is OzBargain's own styled page (`/files/css/pagesimple.css`,
  `/themes/ozbargain/style.css`), headed `403 Access Denied`, with the single sentence
  **"You do not have permission to access this page."** This is consistent with a members-only or
  permission-gated section. It is NOT proof that authenticating grants access — that remains
  unverified (U7 below).
- **F14. `robots.txt` explicitly disallows the login endpoint.** The first rule block is
  `User-Agent: *` / `Disallow: /api/ /comment/ /goto/ /ozbapi/ /privatemsg/ /search/ /user/login`.
  `/user/login` is named alongside the private-messaging and search endpoints. This is the site
  telling automated clients not to drive its login form, and it was already true before this project
  existed.

## R.3 New open questions

- **U7. Does an OzBargain account actually unlock `/classified`?** UNVERIFIED. It requires a live
  login with real credentials, which this agent must not perform and does not have. James's statement
  is the basis for R24, but it has not been demonstrated. If it turns out that classifieds access is
  granted per-user by the site's moderators rather than by merely having an account, R24 does not
  deliver R22.
- **U8. Is driving `/user/login` from a container acceptable, given `robots.txt` names it as
  disallowed, and given the site owner's publicly stated position on bots?** A policy question, not a
  technical one. It is now the single most consequential judgement in the project and it is James's to
  make, not the design lane's and not the orchestrator's.
- **U9. What is the risk to the account itself?** If automated login is detected, the plausible
  outcomes range from a Cloudflare challenge on the session, to the account being suspended. The
  account is personal to James. UNVERIFIED — nobody has published a case of exactly this.
- **U10. Where does the OzBargain credential live?** Specified nowhere. Note the known environment
  fact from `design.md` section 7.6: Unraid user-template variables are stored in plain XML on the
  flash drive, so a password placed in the template is plaintext on removable media and in every flash
  backup. `Mask="true"` hides it in the GUI only.

---

# EVIDENCE — classifieds section, supplied by James, 19 September 2026

James logged into OzBargain in his own browser and sent a screenshot of the classifieds section
rendered for an authenticated user. The screenshot is saved at
`/opt/data/arch-scratch/classified-example-james.png` (deliberately not committed to the repository,
since it shows other members' usernames).

## E.1 What this settles

- **U7 is RESOLVED. `/classified` IS reachable with an authenticated account.** It renders a full
  listings page. Caveat on the evidence: this was produced by James in his own browser and reported by
  him; it has not been reproduced by the agent, which holds no credentials and must not obtain any.
  Recorded as stakeholder-supplied evidence, which is sufficient to settle the requirement.
- **R24 is therefore viable in principle** — an account is a way in. It does not settle the policy
  question U8 (whether automating the login is acceptable given `robots.txt` disallows `/user/login`)
  or the storage question U10.

## E.2 What the classifieds page actually contains — observed structure

- A **"Search classifieds"** text input with a magnifier control, at the top of the listing column.
- A **"Show expired and inactive listings"** checkbox — so listings carry a live/expired state, and
  expiry is filterable in the UI.
- A **"+ New Listing"** button.
- Listing rows, each reading: poster avatar; a **listing-type badge** (`Wanted`, `Freebie` both
  observed); a **bracketed category tag** (`[Code Request & Giveaway]`, `[Code Giveaway Megathread]`,
  `[Perks]` observed); a title containing the item and its price; a trailing `@ <location or
  merchant>`; and **`Posted by <username> on DD/MM/YYYY - HH:MM`** as an absolute timestamp.
- The right-hand rail on the same page is the **live deals sidebar**, showing vote totals (`+3`,
  `+15`, `+4`, `+8`), comment counts, and relative ages (`37 min ago`, `1 hour 8 min ago`,
  `1 hour 53 min ago`).

## E.3 Two consequences that change the design

- **F15. Classifieds listings carry NO vote, comment or click counts.** The deals feed's `<ozb:meta>`
  (F6) has no counterpart here — a classified row shows type, category, title, poster and timestamp,
  and nothing else numeric. **Consequence: the trend/rising alert (R19) cannot apply to classifieds.
  Only keyword and taxonomy matching (R20, R21) can.** The three alert types therefore do not apply
  uniformly across the two surfaces, and the design must say so rather than implying otherwise.
- **F16. Classifieds have their own search input.** If a watchlist term could be answered by that
  search rather than by fetching and scanning every listing, the request volume drops sharply, which
  matters for the politeness and anti-bot exposure of the whole design.

## E.4 New open question

- **U11. Does the classifieds search route through `/search/`?** `robots.txt` disallows `/search/`
  (F9/F14). UNVERIFIED — checking requires an authenticated session. If it does, the most efficient
  path for watchlist matching sits on the explicitly disallowed list, and R20/R21 must instead be
  satisfied by matching against listing titles and category tags as they are fetched. This is a
  concrete question to settle during the authenticated probe.
- **U12. Does the classifieds view have type or category filters beyond the ones visible in the
  screenshot?** The screenshot shows only `Wanted` and `Freebie` listings, and begins below the search
  box, so tabs or filters above that line are not visible. UNVERIFIED.

---

# ALERT RULES — James, 19 September 2026

Delivered verbatim.

> A rules for designer. I only want to hear about a deal once (per deal). Unless it crosses into
> another criteria. Example, A deal has passed 50 votes.
>
> There most be a one click unsubscribe from a rule. Example, if I am looking for a Playstation so
> have an alert for Playstation, I then go out an buy one. The next alert that comes through for
> playstation should have subtext "I no longer wish to recieve alerts for "playstation". There should
> also be a link to "manage alerts" which will take you to the alert manager.

## A.1 New requirements

- **R25. A deal alerts ONCE per criterion, and never twice for the same criterion.** It may alert
  again only when it crosses into a *different* criterion — his example is the same deal later passing
  50 votes. **Alert identity is therefore the pair (deal, criterion), not the deal alone.** Corollary:
  criteria must be discrete and individually identifiable, or "crossed into another criteria" is not
  computable. A deal that clears a 10-vote criterion and later a 50-vote criterion produces two
  alerts, which is what he is asking for.
- **R26. One-click unsubscribe from the rule that fired, from inside the notification.** His example:
  a "Playstation" watchlist rule, he buys one, and the next Playstation alert must carry a one-click
  control to the effect of *"I no longer wish to receive alerts for 'playstation'"*. It must disable
  **that rule specifically** — not all rules, and not the whole program. Presumably also suppress the
  remaining queued alerts from that rule.
- **R27. Every notification must also carry a "manage alerts" link** that opens the alert manager.
  This confirms the product has a user interface — it is not only a background scraper plus a phone
  notification.

## A.2 Tensions these requirements create — recorded, NOT resolved

These are for the design lane to reconcile, and any that cannot be reconciled belong to James.

- **T1. R26 against R8/R9.** A one-click unsubscribe is a state-changing action reached from a
  notification, on a device and in a context that has not necessarily come through the authenticated
  edge path. R8 demands a JWT on every request; R9 denies anything arriving without it. Reconciling a
  state-changing click from a phone notification with deny-by-default is a real design problem, and
  the naive answer (an unauthenticated magic link) is exactly the exception R8 forbids.
- **T2. R27 widens the product surface.** An alert manager is a web UI with state: listing rules,
  editing them, disabling them, probably showing history. That makes the access-control design
  load-bearing rather than incidental, and it makes the `:beta`-vs-`:stable` production question in
  `design.md` section 5 matter to James's own daily use, not just to the host.
- **T3. R25 forces durable per-(deal, criterion) state.** "Have I already told him about this pairing"
  has to survive a restart, a missed poll, a re-fetch of the same deal on a later feed page, and the
  app being redeployed by the auto-update loop in section 6. De-duplication here is a persistence
  problem, not a formatting one.
- **T4. R25 interacts with R19's trend alert.** The trend alert is itself a criterion, so the same
  deal appearing in the feed across many consecutive polls must produce exactly one alert when it
  first trips the trend criterion — and then a second, distinct one if it later passes a vote
  threshold. The counters in `<ozb:meta>` (F6) are the only source that makes this computable.

---

# CORRECTIONS — 19 September 2026, after independent verification

Recorded rather than quietly edited out, so the record shows what was wrong and how it was caught.

## C.1 F9 was WRONG, and the design lane caught it

F9 claimed `robots.txt` contained `Crawl-delay: 5` rules for GPTBot, ChatGPT-User and CriteoBot, a
`DataForSeoBot` rule, and a `Sitemap:` declaration. **None of that is in the live file.**

The live `robots.txt` is **253 bytes**, and it was fetched three times with different client
identities — a Chrome User-Agent, curl's default, and `GPTBot/1.1` — returning **identical bytes and
identical SHA-256 `1f66247a91b1eb002a7901d0d74196b017838ce1e7470a7d2bfaee6b862ac4d6`**. Its complete
content is the seven `Disallow:` lines under `User-Agent: *`, plus `Disallow: /` for AhrefsBot, dotbot
and Superfeedr. There is **no `Crawl-delay` directive anywhere, no `Sitemap:` line, and no per-bot rule
beyond those three.** Note the file is *not* varied by client identity — a uniform 253 bytes for every
one.

**Cause.** F9 was taken from a web-extraction service rather than a direct HTTP request, and that
service returned a stale or synthesised copy. Every other fact in this record came from a direct
request. **Lesson, recorded as a standing rule: a fact about a third party's site is only a fact if it
was fetched directly.**

**Consequence.** **U3's inference is withdrawn.** U3 reasoned from the (non-existent) `Crawl-delay: 5`
that single-digit-second delays were within the site's tolerance. There is no such directive, so there
is no such inference to draw. Poll cadence must be justified on other grounds.

## C.2 ntfy is NOT running on the Unraid host

Checked directly: `docker ps -a` on `192.168.0.148` lists **no** container matching ntfy, gotify or
apprise, and there is no matching Unraid template. The belief that an ntfy instance already runs for
Uptime Kuma alerts is therefore **not supported by anything on the host.**

It may run elsewhere on the network, or those alerts may go to the public `ntfy.sh` service — both are
plausible and neither is verified. **U4 / D13 remains open, and this must be confirmed with James
rather than assumed.** The design lane flagged this itself, unprompted, as "the kind of convenient
assumption that would otherwise get quietly baked in", which is worth noting: the orchestrator's
handed-down context was wrong twice in one pass.

## C.3 R25 is already satisfied in substance

`design.md` section 20.1 specifies an **alert ledger keyed on `(node_id, rule_id)` where a rule fires
at most once per deal, ever** — a permanent record, not a cooldown — and explicitly notes that a deal
legitimately alerts twice when two different rules fire, "once for rising fast, once when promoted".
That is R25's requirement arrived at independently. R26 (one-click unsubscribe) and R27 (the alert
manager) are new and are not yet designed.
