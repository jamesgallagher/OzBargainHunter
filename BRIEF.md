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
