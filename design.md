# OzBargain Hunter — Design

**Author:** design lane (Claude Opus 5)
**Date:** 19 September 2026 (AEST). Revised the same day, after the application premise and the R24 classifieds update arrived. Revised again the same day, after James's classifieds screenshot settled U7 and the R25–R27 alert rules arrived.
**Status:** Draft for James's approval. Nothing has been built. The only files created are this one and `research.md`.
**Input:** `BRIEF.md` in this repository, which records James's requirements verbatim plus environment facts that were each verified by running a command.
**Companion:** `research.md` — the raw evidence behind sections 2 and 16–21, with every URL and command output, now including an addendum covering James's classifieds screenshot and the vendor-documentation checks behind section 21. This document is the argument; that one is the proof. Where they disagree, `research.md` is right.

---

## 0. How to read this document

James asked to be challenged, not agreed with. Several requirements in the brief do not do what he expects them to do on this host. Those are argued out below rather than quietly implemented.

Three labels are used throughout, and they mean exactly what they say:

- **FACT** — verified by a command, and recorded in `BRIEF.md` section 3. If it is not labelled FACT, I did not verify it.
- **DECISION** — a choice I am making as the design lane, with the reasoning stated. These are proposals until James approves them, but they are not vague: they name the actual tag, port, path or hostname.
- **OPEN** — genuinely undecided or genuinely unknown. I have not filled any of these with a plausible-sounding guess. Where an OPEN item blocks work, it also appears in section 13.

**A fourth label was added in the third revision, and it exists because of a mistake this project already made.** One of the handed-down "facts" (F9) turned out to be wrong because it came from a web-extraction service rather than a direct request, which produced the standing rule that *a claim about a third party's site is only a FACT if it was fetched directly*. James has since supplied evidence I cannot reproduce myself — a screenshot of the logged-in classifieds page, taken in his own browser, which I could not take because I hold no credentials and must not obtain any. That is good evidence and it settles a requirement, but it is not the same thing as a command I ran. So:

- **EVIDENCE** — observed and reported by James, read by me directly (I opened the image), not reproduced by me. Good enough to design against and good enough to close a requirement. Not a FACT, because I did not produce it. Used in 18.1 and 18.7.

Two further conventions, so that nothing in here reads as more solid than it is. Where a claim comes from a vendor's own documentation rather than from something I ran — Cloudflare Access policy behaviour, the notification channel's action buttons — it says **documented, not measured**, and it has a probe against it in section 11. Where I am relying on the orchestrator's brief rather than on my own work, it says so.

There are no tables in this document, by instruction.

One meta-point before the content. The brief was assembled by an agent with **no Docker socket** (FACT), which reaches the Unraid host only over SSH. That is not a limitation of the design — it is a limitation on *how evidence gets produced*. Every claim about the host in this document that is not labelled FACT has to be turned into a command run over SSH with its output pasted, before anything depends on it. Section 11 sets that out.

---

## 1. Executive summary — the things I would change

If you read nothing else, read this. These are the points where the brief, implemented literally, produces something other than what you asked for.

1. **"GitHub builds it, then Unraid pulls it down" describes a push. It will be a pull.** GitHub has no way to reach into your Unraid host, and giving it one would directly violate your own "no back door" requirement. Unraid finds out about new images by *polling* the registry. The loop closes, but on a timer you set, not the instant the build goes green. Section 4.

2. **Tagging every build `latest` destroys your ability to roll back and removes the gate between "I committed something" and "it is in production".** You are a Scrum Master; this is the part to look hardest at. As written, a commit at 11pm on a Tuesday becomes the running production container with no acceptance step and no named version to go back to. My counter-proposal keeps your words almost intact but adds an immutable tag per build and a deliberate promotion step. Section 5.

3. **"Nothing reachable by a back door without coming through Cloudflare Tunnel" is not achievable in your current topology, and the reason is structural, not a misconfiguration.** Your tunnel forwards *everything* to a reverse proxy on a **different machine** (`192.168.0.173`). For that proxy to reach a container on `192.168.0.148`, the container must publish a LAN-reachable port — which is exactly the back door you want closed. The proxy gets in the same way any device on your LAN gets in. There is a clean fix, and it involves editing the single ingress rule that currently serves *every* public hostname you own. Section 7.

4. **A JWT you check in your own app is not the same thing as an edge gate, and you can have the stronger one for less work.** Cloudflare Access sits in front of the hostname, authenticates against an identity provider, and hands your app a signed JWT on every request. Your app verifies it. That literally satisfies "enforce a JWT on each page", gives you MFA for free, means you never store a password or a signing key, and means an unauthenticated request never reaches your code at all. Building your own login page is more work and strictly weaker. Section 7.

5. **Your existing Unraid templates point `<Icon>` at the app's own public URL. Combine that with "JWT on every page" and the Unraid dashboard will show a broken image**, because the icon request gets redirected to a login screen. Host the icon out of the repository instead. Section 9. This is small, but it is a good illustration of requirements R3, R8 and R9 colliding in a way nobody notices until it is live.

### 1.1 Added after the premise arrived — the three things that matter most from the research

Points 1–5 above concern delivery and hosting and are unchanged. These three come from actually going to the site and reading what is there, and they are the ones that change what gets built.

6. **Do not build a scraper. Build a feed reader.** OzBargain publishes a large family of RSS feeds carrying *more* structured data than the HTML pages — vote counts, click counts, comment counts, expiry, and brand/product/tag classification, all as machine-readable attributes. The site owner told developers in 2017 that the feed is the answer to "is there an API", and in March 2026 he **deliberately unblocked `*/feed` URLs in his Cloudflare rules** so that automated feed clients would keep working. Meanwhile I found a live Cloudflare ban sitting on Python's default HTTP client identity. There is no trade-off here: the polite route is also the more robust route and it yields better data. Sections 2.2 and 16.4.

7. **Your trend alert is easier than you thought, and you described it exactly right.** You said it would be a deal appearing "on the 'new deals' page as well as the front page". Those are two separate RSS feeds — `/deals/feed` and `/feed`. Front-page promotion is a directly observable event, about 10 a day. One correction: placement is **not** a vote threshold — I measured a 9-vote deal on the front page and a 43-vote deal off it — so it must be observed rather than predicted. I have added a velocity rule for early warning before promotion, with thresholds justified against 120 real deals. Section 17.3.

8. **The classifieds decision is the one to think hardest about, and your screenshot has settled half of it.** You logged in, `/classified` rendered a full listings page, and U7 is closed. What the screenshot did **not** change is the objection that actually matters: `robots.txt` explicitly disallows `/user/login`, the classifieds gate exists specifically to keep non-members out because of scams, and none of the 102 public OzBargain projects has ever logged in. **`/classified` itself is not disallowed — only the login endpoint is.** That distinction is now the entire argument, because the destination is proven and only the method is in question. My recommendation firms up rather than changes: you authenticate as a human, you hand the app the cookie, the app never touches the login form. Section 18.

### 1.2 Added after the classifieds screenshot and the R25–R27 alert rules

9. **Classifieds listings carry no numbers at all, so one of your three alert types cannot exist there.** Every deal in the RSS feed carries vote, comment and click counters, and those counters are the only reason the trend alert (R19) is computable. A classified row carries a type badge, a category tag, a title, a poster and a timestamp — and nothing numeric except the price inside the title. **The trend alert therefore applies to deals only. Only watchlist and keyword matching (R20, R21) can apply to classifieds.** The three alert types are not uniform across the two surfaces and I would rather say so than let you discover it. Section 18.8.

10. **"One-click unsubscribe" (R26) is in genuine conflict with "a JWT on each page" (R8), and I cannot make the conflict disappear.** A notification tapped on your phone is a state-changing request arriving from a context that has not necessarily authenticated. Every clean answer costs you something: either the click is gated by Cloudflare Access and is occasionally not one click, or it carries its own credential and you accept exactly one documented exception to deny-by-default. I have designed both, stated honestly what an attacker holding the link can do, and put the choice to you as **D17** rather than quietly picking the one that makes the requirement look satisfied. Section 21.2–21.4.

11. **The alert manager (R27) is not a small addition, and it sharpens the tagging argument in section 5 considerably.** With a real management UI, auto-deploying every push to `main` means auto-deploying the interface you use to turn your own alerts off — and running a schema migration against the database holding your rules, unattended, at whatever hour you pushed. A bad deploy no longer just stops alerts; it removes your ability to manage them. That is the strongest version of the case for a promoted `:stable` tag (D2), and it arrived from your own requirement rather than from me. Sections 21.7–21.9.

---

## 2. The product surface

**This section was a marked placeholder in Stage 0. The premise has now landed and it is replaced below.**

**Reading order note.** Sections 3–15 were written before the premise and remain valid — they cover delivery, packaging, exposure and access control, none of which the premise changes. The product material sits in **sections 16–21**, which could not be numbered earlier without renumbering things already referenced. If you are reading for the new work, read section 2, then jump to 16. Sections 13, 14 and 15 are updated in place.

**What changed in the third revision, so you can read just that if you want to.** Your classifieds screenshot settled U7, so **section 18** is substantially reworked — 18.1, 18.2, 18.3, 18.4 and 18.6 are rewritten around a settled gate, and **18.7 and 18.8 are new** (what the page contains; which alert rules can apply to it, which is not all three). The R25–R27 alert rules are designed in **new section 21** — R25 was already satisfied and is closed out, R26 is a genuine collision with your own R8 and is put to you as **D17**, R27 is specified and its scope consequences are stated. New decisions **D17–D21**, new blocker **B11**, new probes **P11–P14**, and **B7 and P9 and P10 are resolved**. Sections 1.2, 2.1, 5.2, 17.4, 19.1, 20.1 and 20.5 are revised where the new requirements made them stale.

### 2.1 What it is

OzBargain Hunter watches ozbargain.com.au and sends James a notification when something he cares about appears or starts moving. Three alert types:

- **Trending (R19)** — a recently posted deal that is climbing unusually fast, or that has just been promoted to the front page. **Deals only.** See below.
- **Watchlist (R20)** — a saved product or company term, his example being "AMD R9700", matched against new deals and, if section 18 proceeds, against classifieds.
- **Keyword (R21)** — a saved free-text term, his example being "ChatGPT", matched the same way across the same two surfaces.

**The three types do not apply uniformly across the two surfaces, and this document is not going to imply that they do.** The trend rule is computed entirely from the `<ozb:meta>` vote, comment and click counters that every RSS item carries (F6, 16.3). The classifieds page carries no counters of any kind (F15, 18.7). There is therefore nothing to compute a trend from, and **R19 is a deals-only rule, permanently, for a reason that no amount of engineering removes.** R20 and R21 are the only rules that can span both surfaces. Section 18.8.

It runs as a background poller with a web UI. That UI was described here as "small" before the R25–R27 rules arrived; **R27 makes it a named requirement reachable from every notification, and it is no longer small** — it manages rules, not just displays status. Section 21.7 specifies it and 21.8 is honest about the scope it implies. Alerts go out over a notification channel (section 20.5).

### 2.2 The one thing I am changing in the premise, up front

James wrote: *"OzBargain Hunter is a scraper for OzBargain.com.au… the correct method for scraping needs to be researched."*

I researched it. **The correct method is not to scrape.** I am saying that plainly because he asked to be challenged and because this is the single most useful finding of the research pass.

OzBargain publishes a large family of RSS feeds that carry *more* structured data than the HTML pages do — vote counts, click counts, comment counts, expiry timestamps, and brand/product/tag classification, all as machine-readable attributes. The site owner has twice stated in public that the feed is the intended route for exactly this use case, and in March 2026 he **specifically exempted `*/feed` URLs from his Cloudflare bot rules** so that automated feed clients would keep working. Meanwhile my own testing found a live Cloudflare ban sitting on Python's default HTTP client identity.

So the choice is not "scrape carefully versus scrape recklessly". It is:

- **Scrape HTML** — parse a layout that changes without warning, on paths defended by rules the owner tunes continuously, to recover data that is *already available in a cleaner form* somewhere else.
- **Consume the feeds** — structured, stable, explicitly protected for automated clients, and richer.

The second is less work, more robust, better-mannered, and produces better data. There is no trade-off to weigh here; the polite option is also the superior engineering option, which is a pleasant and fairly rare situation.

**DECISION — this application is a feed consumer, not a scraper. It makes no HTML requests to ozbargain.com.au in v1.** Evidence in section 16; the acquisition design is section 17.

The word "scraper" can stay in conversation if he likes it. The behaviour will not be scraping.

### 2.3 What this settles that was open in Stage 0

- **It has persistent state, and that state is load-bearing.** Detecting "rising quickly" means comparing now against then, which means remembering then. Section 19.
- **It makes outbound calls** — to ozbargain.com.au and to a notification endpoint. Nothing inbound is required for the product to work.
- **It needs scheduled background work.** A poll loop is the heart of it. This changes the container's health check and restart behaviour (section 20.4).
- **One user.** James. Cloudflare Access as designed in section 7 fits without modification; no public signup.
- **Storage is SQLite on the existing bind mount** (section 19.4). No database container.

### 2.4 The naming question, still open

"OzBargain" is a live third-party brand. Naming the project after it, publishing the image publicly on GHCR, and putting a logo on it are three separate decisions that each carry a small trademark and terms-of-use question. Now that the app is confirmed to consume that site, this is slightly more pointed than it was at Stage 0 — though it is worth recording that OzBargain's Terms of Use contain no clause about automated access at all (section 16.4), and that 102 public GitHub repositories already use the name. Still **OPEN** as D9 in section 14. Decide it knowingly rather than discover it.

---

## 3. Names, identifiers and addresses

These are the concrete strings everything else refers to. I am naming them now so the rest of the document can be specific. All are **DECISION** unless marked otherwise.

- **DECISION — Project folder:** `/opt/data/projects/OzBargainHunter`. Already exists, already `git init`ed (FACT), no commits and no remote (FACT).
- **DECISION — Display name:** `OzBargain Hunter`.
- **DECISION — GitHub repository:** `jamesgallagher/OzBargainHunter`.
- **DECISION — Container image:** `ghcr.io/jamesgallagher/ozbargainhunter`.
  Note the case. GHCR rejects uppercase characters in the image path. If the workflow builds the name from `${{ github.repository }}` it must lowercase it explicitly, or the push fails with a not-obviously-related error. This is a small trap and it catches people every time.
- **DECISION — Unraid container name:** `OzBargainHunter`. Matches the existing convention (`ForcedEnglishSubs`, etc.).
- **DECISION — Unraid template file:** `/boot/config/plugins/dockerMan/templates-user/my-OzBargainHunter.xml`. This matches the verified existing pattern (FACT: `my-ForcedEnglishSubs.xml` sits there today).
- **DECISION — Application data directory on the host:** `/mnt/user/appdata/ozbargain-hunter/`. Matches the existing convention of lowercase-hyphenated appdata directories.
- **DECISION — Port the app listens on inside the container:** `8000`.
  FACT: port `8000` is reported free on the host. But see section 7 — my recommendation is that this port is **not published to the host at all**, in which case "8000 is free" becomes irrelevant and the number is purely internal. I am keeping 8000 anyway so that if you reject that recommendation, the fallback is already chosen and known-free.
- **OPEN — Public hostname.** I suggest `ozb.gallagherhome.au`, on the pattern of the verified `fes.gallagherhome.au`. Short, and it avoids putting the full third-party brand name in a public DNS record. But the hostname is yours to pick and it is cheap to change now and annoying to change later, so it stays OPEN until you say the word. Every example URL below uses `ozb.gallagherhome.au` as a placeholder.

---

## 4. The delivery path: commit → build → publish → host update

### 4.1 What you asked for

> "every commit it will automatically build … On a new push, it will push to GitHub, Github will build it, once it has successfully built, we need Unraid to pull the new container package down so it stays updated."

### 4.2 Does it work as described? Partly. Here is exactly where it breaks.

**The first two hops work.** Push to GitHub → GitHub Actions builds the image → the image is published to GHCR. That is a solved, boring path, and you already have roughly eight images published under `ghcr.io/jamesgallagher/` (FACT), so the pattern is proven on this account.

One genuine subtlety that will otherwise bite you: **FACT** — the `gh` CLI token on this host carries `repo`, `workflow`, `read:packages`, `gist` and `read:org`, but **not** `write:packages`. That means neither you nor this agent can push an image to GHCR from the host right now with that token. It does **not** block the pipeline, because GitHub Actions is issued its own `GITHUB_TOKEN` per run, and a workflow that declares `permissions: packages: write` can push to `ghcr.io/jamesgallagher/*` without any PAT at all. So: no new secret is needed for publishing. If you ever want to push an image by hand from the host, you will need a PAT with `write:packages`, and that is the moment to notice, not before.

**The third hop is the one that does not work as described.** "Once it has successfully built, we need Unraid to pull the new container package down" describes GitHub *telling* Unraid something. There are only two ways that can happen:

- GitHub's hosted runners reach into your LAN — over SSH, or to a webhook receiver you expose publicly. This requires an inbound path from the public internet to `192.168.0.148`, which is precisely the back door requirement R9 forbids. It also means GitHub holds a credential that can execute on your Unraid host. **I am rejecting this.**
- You run a **self-hosted GitHub Actions runner** on the LAN, which polls GitHub for jobs (outbound only, no inbound path) and can then run `docker pull` locally. This is technically sound and does not create a back door. But it means a long-running agent on your host that executes arbitrary workflow code from your repository with whatever permissions you give it, which is a meaningful new trust surface for a one-person project. **Not recommended at this scale.**

**DECISION: the loop closes by polling from the Unraid side, not by a push from GitHub.** Unraid's Docker page already knows how to ask a registry "is the image behind this tag still the one I have?" — that is what the "update ready" indicator in the Docker tab is. Section 6 covers the mechanics and what you click.

The practical consequence, stated plainly so it is not a surprise later: **there will be a delay between "build went green" and "the new container is running", equal to your polling interval.** If you set the check to daily at 04:00, that delay can be up to 24 hours. That is not a flaw; it is the price of having no inbound path, and I think it is the right trade. If you want it faster, section 6.4 has a knob.

### 4.3 The second break: package visibility

**OPEN, and it will silently break the whole loop if it goes the wrong way.**

When a GitHub Actions workflow publishes a package to GHCR for the first time, the package is created **private** by default when it originates from a private repository. A private GHCR package cannot be pulled by the Unraid host unless that host has been `docker login`ed to `ghcr.io` with a token carrying `read:packages`. Worse, **Unraid's update check also fails silently on a private package it cannot authenticate to** — you do not get a clear error in the Docker tab, you just never see "update ready".

Your eight existing images are presumably public, or the host holds a credential. I did not verify which, and neither did the brief. This must be checked (section 11, probe P5). If the repository ends up private and you want the package public, that is a one-time toggle in the package settings on github.com; it is not automatic and it is not in the workflow.

### 4.4 The third break: two commits in quick succession

**DECISION — the workflow must set a concurrency group.**

If you push commit A and then commit B ninety seconds later, both builds run in parallel. There is no guarantee they finish in order. If A's build is slower than B's, `latest` ends up pointing at **A** — the older commit — and stays that way until the next push. You would be running yesterday's code with today's commit hash in your head.

The fix is one block in the workflow:

- concurrency group keyed on the branch reference
- cancel-in-progress enabled

so a newer push on the same branch cancels the older in-flight build. This is a three-line fix for a bug that is very hard to diagnose after the fact, and it is a direct consequence of your "every commit builds and becomes latest" requirement. It is worth knowing that the requirement has this edge in it.

### 4.5 A precision point on "every commit"

**FACT of how GitHub works, not of this host:** a `push` event triggers **one** workflow run for the tip of what you pushed, not one per commit. If you push five commits at once, you get one build of the fifth. In practice this is what you want. But since your tagging scheme is phrased in terms of "every new version", it is worth being precise: the unit is a *push*, and the thing that gets tagged is the *tip commit of that push*. Intermediate commits are never built and have no image.

If you genuinely want every individual commit to be independently buildable and addressable, say so — it is achievable, it costs more Actions minutes, and I do not think you want it.

---

## 5. Tagging: `latest`, `beta`, and why the scheme as stated works against you

### 5.1 What you asked for

> "We will run a tagging system, but every new version will be tagged as latest unless we branch off and then we will have a beta tag alongside latest."

### 5.2 The challenge

A Docker tag is not a version. It is a **mutable pointer**, like a git branch name. `latest` does not mean "version 1.4.2"; it means "whatever was pushed to this name most recently". That single fact produces four problems with the scheme as stated, and I want to name all four because each one bites differently.

**Problem 1 — you cannot roll back, because nothing has a name.**
If build 47 is broken, build 46's image still physically exists in GHCR, but the only way to refer to it is its content digest — a 71-character `sha256:...` string that nobody has written down. You cannot type `:the-one-from-yesterday`. And GHCR treats untagged versions as prunable. At the exact moment you most need last week's image, you will be scrolling a package versions page in a browser trying to match timestamps. This is the single strongest argument against the scheme.

**Problem 2 — you cannot tell what is running.**
`docker ps` will report `ghcr.io/jamesgallagher/ozbargainhunter:latest` whether the container is running build 47 or build 12. To answer "what version is live?" you have to compare digests by hand. In your Scrum terms: you have no increment identity. You cannot point at a thing and say "that one".

**Problem 3 — `latest` means "newest", not "good", and you are auto-deploying it.**
Combining R12 (`every new version tagged latest`) with R13 (`Unraid pulls it so it stays updated`) gives you continuous deployment straight to production, gated by nothing. Every commit to `main` becomes the running application. There is no acceptance step, no definition of done between commit and production, no human decision point. You are the person who normally *insists* on that gate existing. I would expect you to reject this if someone else proposed it.

The failure mode is specific: a commit that **builds** fine but **crashes at runtime** will be auto-pulled and will crash-loop on your host, and Unraid's auto-update does not roll back. You will find out when you try to use the app, not when the build runs.

**R27 makes this argument materially stronger, and I want to re-state it now that the product surface has grown.** When this section was written, the app was a background poller: a bad auto-deploy meant you stopped getting alerts for a while. R27 turns the app into the interface you use to *manage* your alerts — to mute a rule, to fix a term that is firing constantly, to re-enable something you muted by mistake. So a bad deploy no longer merely interrupts the service; **it removes your ability to control the service, at exactly the moment you want to.** Worse, the deploy is unattended and it runs schema migrations (19.4) against the database holding your rules and your alert ledger. A migration that half-applies at 3am against a `:latest` you never chose to deploy is a different class of event from a crash loop, because a crash loop is recoverable by pulling the previous image and a mangled database is not. This is the sharpest form of the case for D2.

**Problem 4 — `beta` is one pointer, and "when we branch off" implies many branches.**
If you have two branches alive at once — say `feature/scrape` and `fix/timezone` — and both publish to `:beta`, then whichever pushed most recently owns `:beta` and the other one silently vanishes. You would be testing a build you did not think you were testing. The scheme as phrased has no answer for concurrent branches.

Also, "a beta tag alongside latest" is genuinely ambiguous, and the two readings differ enormously:

- **Reading A:** the branch build gets `:beta`; `main` keeps `:latest`; they are two different images. Sane.
- **Reading B:** the same branch image gets *both* `:beta` and `:latest`. This would push unfinished branch work onto your production tag, and your auto-updating host would deploy it within one poll cycle. This must never happen.

I am **assuming Reading A** and designing to it. Confirm it (D-list, section 14). If you meant something else, this section changes.

### 5.3 What I would do instead — concrete tags

Keep `latest` and `beta` — your vocabulary is fine. Add an immutable tag per build so that every image has a permanent name, and add one deliberate promotion step so that "deployed" is a decision rather than a side effect.

**DECISION — tag set, by trigger.**

Push to `main`, tip commit `a1b2c3d`:
- `ghcr.io/jamesgallagher/ozbargainhunter:latest`
- `ghcr.io/jamesgallagher/ozbargainhunter:main-a1b2c3d`

Push to branch `beta`, tip commit `9f8e7d6`:
- `ghcr.io/jamesgallagher/ozbargainhunter:beta`
- `ghcr.io/jamesgallagher/ozbargainhunter:beta-9f8e7d6`

Push to any other branch, e.g. `feature/deal-parser`, tip commit `4c4c4c4`:
- **builds, runs the full CI suite, and pushes nothing.** No registry noise, no fight over `:beta`.

Push of a git tag `v0.3.0` on `main`:
- `ghcr.io/jamesgallagher/ozbargainhunter:0.3.0`
- `ghcr.io/jamesgallagher/ozbargainhunter:0.3`
- `ghcr.io/jamesgallagher/ozbargainhunter:stable` — moved to point here

**DECISION — exactly one long-lived branch owns `:beta`, and it is named `beta`.**
This solves problem 4 by construction and is self-documenting: branch `beta` → tag `:beta`. You merge feature branches into `beta` to try them, and into `main` when you mean them. If you would rather call it `develop`, that is cosmetic; I picked `beta` because it matches the word you used.

**DECISION (proposed, needs your sign-off — this is D2 in section 14) — production tracks `:stable`, not `:latest`.**

The Unraid production template's `<Repository>` would read:

`ghcr.io/jamesgallagher/ozbargainhunter:stable`

and a second, optional Unraid container tracks `:beta` for trying things out.

What this buys you, in your terms: `:latest` is the *increment* — it exists, it is built, it is testable. `:stable` is the increment that has been *accepted*. Promotion is you pushing a git tag, which takes ten seconds and is a deliberate act you can point at in a review. Rollback becomes: edit `<Repository>` to `ghcr.io/jamesgallagher/ozbargainhunter:main-a1b2c3d`, hit apply, done in under a minute — and you have the exact string in the Actions run log.

What it costs you: one extra command (`git tag v0.3.1 && git push --tags`) when you want something live. That is the entire cost.

**The alternative, stated fairly, in case you want it.** Point production at `:latest` and accept that `main` *is* production. This is a legitimate model — a lot of small teams run it — but it is only safe if two things hold: nothing lands on `main` without passing CI, and the CI actually runs the image rather than merely building it. The first depends on branch protection, which may not be available to you (section 8). The second is buildable. If you pick this model, I would insist on the CI smoke test in section 8.4 as non-negotiable, because it becomes your only gate.

**DECISION — image tag must be a moving tag for Unraid to ever show an update.** This links section 5 to section 6 and is easy to get wrong. Unraid detects updates by asking the registry whether the digest behind a tag has changed. If the template pins `:0.3.0`, that digest never changes, and Unraid will report "up-to-date" forever — correctly, and uselessly. So whichever tag the template points at, it must be one that moves: `:stable`, `:latest` or `:beta`. Pinned semver tags are for rollback and for pointing at deliberately, not for the steady state.

**OPEN — registry retention.** Tagging every build `main-<sha>` means the package version list grows without bound. At some point you will want a cleanup workflow that keeps, say, the most recent 20 `main-*` and `beta-*` tags plus everything semver-tagged. I have not decided the policy because it depends on how often you actually push. Not blocking; revisit at around the 50-build mark.

---

## 6. How the Unraid host notices a new version and updates itself

This is requirement R6, and it is the part with the most "what do I actually click".

### 6.1 The mechanism

**Stated as my understanding, to be confirmed by probe P4 in section 11 — not labelled FACT because the brief did not verify it.**

Unraid's Docker tab shows a version column per container reading "up-to-date", "update ready" or "not available". It produces that by querying the registry for the manifest digest behind the tag in the template's `<Repository>` field and comparing it to the digest of the locally stored image. The result is cached, so the column does not re-query on every page load; there is a **"Check for Updates"** control at the bottom of the Docker tab that forces a fresh query.

When it says "update ready", clicking the container's **"apply update"** pulls the new image and **recreates** the container from its saved template.

### 6.2 The trap worth spelling out

**Do not close this loop with a shell script that does `docker pull && docker restart`.** It will look like it works and it will not.

`docker restart` restarts the *existing container*, which is bound to the image ID it was created from. Pulling a new image under the same tag does not move a running container onto it. You would pull a new image, restart, and still be running the old code — with a `docker images` listing that shows the new digest present, which makes it look like the update succeeded. This is a genuinely nasty failure because every surface-level check says it worked.

Updating correctly means **recreating** the container from its template. Unraid's own tooling does that. Hand-rolled scripts usually do not.

### 6.3 What James actually does — the click path

**DECISION — use the Community Applications "Auto Update Applications" plugin.** It is the supported mechanism, it recreates containers properly, and it is what the rest of your 40+ containers can use too.

Concretely:

1. **Confirm Community Applications is installed.** With 40+ containers running (FACT) it almost certainly is, but it is **OPEN** — probe P6. If it is not: Unraid GUI → Plugins → Install Plugin → the Community Applications plugin URL.
2. Install **"CA Auto Update Applications"** from the Apps tab (search for it; it is a plugin, not a container).
3. Go to **Settings → Auto Update Applications**.
4. Set the **schedule**. Daily at a chosen time — I suggest **04:00** — is the granularity I am confident the plugin offers. Whether it also offers sub-daily intervals is **OPEN**; check the dropdown when you are in there. This choice directly sets your build-to-live latency (section 4.2).
5. On the **Docker Applications** tab of that settings page, set `OzBargainHunter` to auto-update **yes**.
6. If you run a beta container, set it to auto-update **no**. Beta should update when you decide to look at it, not overnight. The whole point of beta is that you are watching.
7. Turn on **notifications** for the plugin, so an update produces a visible record. You said you want evidence rather than assurances; this is the host-side half of that.

Everything else stays in the template file. Nothing in GitHub needs to know this exists.

### 6.4 If daily is too slow

The knob is the plugin's schedule. If the plugin will not go below daily and you want faster, the fallback is a **User Scripts** cron entry that invokes the same proper update path rather than a raw `docker pull`. I am not specifying that script here because it is premature and because the plugin is very likely sufficient. **OPEN** if and only if you find daily unacceptable.

### 6.5 What survives an update, and what does not

**DECISION — all persistent state lives on a bind mount, nothing lives in the container's writable layer.**

Recreating a container from a template throws away everything written inside the container that is not on a mapped volume. That is by design and it is fine, provided the app never writes anything it cares about to a non-mapped path. The template maps:

- `/mnt/user/appdata/ozbargain-hunter/` → `/data` in the container. **This was OPEN at Stage 0 and is now decided** (section 19.4): it holds the SQLite database, and — if section 18 proceeds — a `secrets/` subdirectory mode `0600` for the OzBargain session cookie, which deliberately does not live in the Unraid template (18.5, 7.6).

This is the same shape as the verified `ForcedEnglishSubs` template, which maps `/mnt/user/appdata/stremio-forced-subs/data` → `/data` (FACT).

### 6.6 Where the template lives and the drift problem

**DECISION — the canonical template XML is versioned in the repository at `unraid/my-OzBargainHunter.xml`, and is copied to `/boot/config/plugins/dockerMan/templates-user/my-OzBargainHunter.xml` on the host over SSH.**

**Honest warning about this decision:** editing the container in the Unraid GUI rewrites the file on the flash drive. The repository copy will then be stale and nobody will notice. The rule has to be: after any GUI edit, copy the flash version back into the repository and commit it. If that discipline fails, the repository copy becomes actively misleading — worse than not having one. I still think versioning it is right, because it is the only record of *why* the container is configured the way it is, but you should know the failure mode.

**DECISION — leave `<TemplateURL/>` empty**, matching the verified existing template. Populating it invites Community Applications to manage template updates for an app that is not in any app feed, and the behaviour there is not something I want to guess at.

---

## 7. Exposure and access control

This is the section where the requirements and the host disagree most sharply, so I am going to lay out the topology first and then argue from it.

### 7.1 The topology as it actually is

All FACT, from the brief:

- A container `cloudflared` runs on the Unraid host (`192.168.0.148`) in tunnel mode, tunnel ID `2af6626c-f01d-4532-bf84-0af542711ea3`. It publishes **no host ports**.
- Its config at `/mnt/user/appdata/cloudflared/config.yml` has **one** ingress rule, a catch-all, forwarding **all** hostnames to `https://192.168.0.173` with `originServerName: gallagherhome.au`.
- `192.168.0.173` is a **different machine** from the Unraid host. Per-hostname routing for `*.gallagherhome.au` happens there, on a reverse proxy, not here.
- Containers on the Unraid host publish ports on `0.0.0.0` and are LAN-reachable today — `8080`, `8081`, `8880`, `8881`, `8001`, `8184`, `3000`, `3001` among them. The brief is explicit that this is a fact of the current configuration and not a recommendation.

So the real request path today, for any of your public apps, is:

**Internet → Cloudflare edge → cloudflared (on .148) → reverse proxy (on .173) → back across the LAN → the container's published port (on .148)**

Read that last hop carefully. The traffic leaves the Unraid host, crosses your LAN to another machine, and comes back to the Unraid host as an ordinary LAN connection to a published port.

### 7.2 Why R9 as stated is not achievable in this topology

> "nothing should be accessible by a back door without coming through CloudFlare tunnel"

**The back door is not a hypothetical oversight. It is the mechanism by which the front door works.**

If the container publishes a port on `0.0.0.0:8000`, then the reverse proxy at `192.168.0.173` reaches it by connecting to `192.168.0.148:8000` — which is exactly what a laptop on your wifi does, what any of your other 40 containers can do, what a compromised smart TV can do, and what anyone on a VPN into your LAN can do. There is no way for the container to distinguish "this TCP connection came from the reverse proxy, having traversed Cloudflare" from "this TCP connection came from a device on the LAN", because at the network layer they are identical.

So: **as long as the container publishes a port on 0.0.0.0 and the proxy is on another machine, R9 cannot hold.** That is not a configuration bug to fix; it is what the current design does.

Three ways out, in my order of preference:

**Option 1 (recommended) — put the app container on a shared Docker network with `cloudflared`, and publish no host port at all.**

The app listens on `8000` inside the container. `cloudflared`, being on the same user-defined Docker network, reaches it by container name — `http://ozbargain-hunter:8000`. No port is published to the host, so there is nothing on `0.0.0.0` and nothing for the LAN to connect to. The tunnel becomes genuinely the only inbound path.

This requires adding a **hostname-specific ingress rule ahead of the catch-all** in the tunnel's configuration, so that `ozb.gallagherhome.au` goes to the container and everything else still goes to `192.168.0.173`.

**The risk, stated plainly:** that ingress block currently serves *every public hostname you own*. A bad edit takes all of them down at once. This edit needs a copy of `config.yml` taken first, a single-rule change, and a verification pass over at least two existing hostnames afterwards. It is a five-minute job that deserves ten minutes of care. It is also **blocked** on the question in 7.3.

The other cost, which you should weigh: **you lose LAN access to the app, including your own.** You will not be able to hit `http://192.168.0.148:8000` from your desk to debug. Debugging happens via `docker logs` and `docker exec` over SSH. For a small app I think that is an acceptable and even healthy trade, but it is a real change to how you would work, and it is the main reason you might reject this option.

**Option 2 — publish the port, but firewall it to only `192.168.0.173`.**

Keeps LAN debugging (sort of), keeps the existing topology, and does close the hole. But Docker's port publishing installs its own iptables rules that bypass the `INPUT` chain, so the restriction has to go in the `DOCKER-USER` chain, and on Unraid those rules do not persist across a reboot unless placed in `/boot/config/go`. It is doable. It is also the kind of thing that silently stops being in effect after a reboot or an Unraid upgrade, and you would not notice, because the app would keep working perfectly. **I would only take this option if you reject Option 1 for the LAN-debugging reason.**

**Option 3 — do nothing, publish the port, and accept the LAN is trusted.**

This is what your other 40 containers do today. It is a coherent position — many home setups take it — but it is not R9, and I am not going to describe it as R9. If you want this, the honest wording is "public access only via Cloudflare; LAN access is open and the LAN is trusted", and then the JWT layer in 7.4 becomes your only real control. Say so explicitly, in the document, so future-you does not read "no back door" and believe it.

**DECISION: I recommend Option 1.** It is the only one of the three that makes the requirement true rather than approximately true, and you asked for the requirement.

### 7.3 The blocking unknown: who owns the ingress?

**OPEN — and this blocks Option 1 entirely.**

The brief flags this and I am not going to paper over it. A Cloudflare tunnel is either:

- **Locally managed** — ingress comes from `config.yml` on disk, and editing that file plus restarting `cloudflared` is how you change routing; or
- **Remotely managed** — ingress comes from the Cloudflare Zero Trust dashboard, the local `config.yml` is **ignored for ingress**, and editing it does precisely nothing.

The evidence points both ways. The presence of a `config.yml` with a real catch-all rule suggests local. But the file also carries the stock installer's comment block intact, which is exactly what you would see if it had been written by the installer and never actually consulted. **I will not guess.** Probe P1 in section 11 resolves it.

The related unknown, also from the brief: when you add a new `*.gallagherhome.au` hostname, does it need a DNS record created in the Cloudflare dashboard, a route added on the reverse proxy at `192.168.0.173`, or both? And do you have administrative access to `192.168.0.173`? That machine is not the Unraid host and nothing in the brief establishes what it runs or who configures it. **OPEN** — probes P2 and P3.

Until P1–P3 are answered, section 7 cannot be implemented. It can be designed, which is what this is.

### 7.4 Authentication of the user vs enforcement at the edge

This is the distinction you need, and it is the one most people conflate.

**Application-level authentication** — "enforce a JWT on each page" — means your code inspects a token on every request and refuses to serve anything without a valid one. It stops unauthenticated *use*. It does not stop unauthenticated *reach*. An attacker who can route to your app still gets to talk to your web framework, your TLS stack, your login endpoint, your static file handler, and every dependency CVE you have not patched. The app is still there, still listening, still parsing their input.

**Edge enforcement** means the request is stopped before it ever gets near your code. On Cloudflare that is **Cloudflare Access** (part of Zero Trust): you attach a policy to the hostname, Cloudflare authenticates the visitor against an identity provider, and only then does the request proceed into your tunnel.

**These two compose, and the composition is exactly what you asked for — plus more.**

**DECISION — use Cloudflare Access at the edge, and verify the Access JWT in the application on every request.**

How it works end to end:

1. A request arrives for `https://ozb.gallagherhome.au/anything`.
2. Cloudflare Access intercepts it at the edge. If the visitor has no valid session, they are sent to an identity provider — Google, GitHub, or a one-time PIN emailed to an allowlisted address. No password is ever stored by you.
3. On success, Cloudflare issues a signed JWT, sets it as the `CF_Authorization` cookie, and forwards the request to your origin with the token also present in the `Cf-Access-Jwt-Assertion` header.
4. **Your application verifies that JWT on every single request.** It fetches Cloudflare's public keys from `https://<your-team>.cloudflareaccess.com/cdn-cgi/access/certs`, verifies the RS256 signature, and checks that the `aud` claim equals the Application Audience (AUD) tag of your Access application and that `iss` is your team domain. Then it reads the `email` claim for identity.
5. Anything without a valid token gets a 403. No exceptions, no "internal" paths.

Why this is better than building your own login, in concrete terms:

- **You literally satisfy R8.** There is a JWT, and it is checked on every request. You did not have to design a token format, pick a signing algorithm, or manage key rotation.
- **There is no secret to store.** Your team domain and the AUD tag are not secrets. Compare with a home-rolled JWT, where the signing key is a secret that would have to live in the Unraid template — and see 7.6 for why that is worse than it sounds.
- **MFA comes free** from whichever identity provider you pick. You are not building a TOTP flow.
- **No password database, no reset flow, no account lockout logic, no session fixation bugs.** These are four places to get security wrong that you simply never touch.
- **Unauthenticated traffic never reaches your code.** This is the part that actually addresses the spirit of R9 even where the letter of it is hard. Even if someone finds a LAN path to the container, step 4 still rejects them, because they have no valid Cloudflare-signed token and cannot forge one.

Point 5 is worth dwelling on: **verifying the Access JWT in the app is what makes the LAN back door harmless even in Option 3.** If the app merely trusted that "traffic arrived, so it must have come through Cloudflare", the back door would be wide open. It must verify the signature. If you take only one technical instruction from this document, take that one.

Two caveats I will not hide:

- **Your request path has an extra hop through the reverse proxy at `192.168.0.173`.** For the JWT to reach your app, that proxy must forward the `Cf-Access-Jwt-Assertion` header and the `CF_Authorization` cookie. nginx, SWAG and Nginx Proxy Manager all do by default, but a proxy configured to strip unknown headers would break this in a way that looks like "authentication randomly fails". Under Option 1 this hop disappears entirely, which is another argument for Option 1.
- **Cloudflare Access has a free tier** — at the time of writing, up to 50 users — and needs Zero Trust enabled on your Cloudflare account. Whether it already is, is **OPEN** (probe P7).

**The alternative, stated fairly.** If you reject Access — because you want public signup, or you do not want Cloudflare in your auth path — then the next best option is a self-hosted forward-auth provider (Authelia or Authentik) in front of the app, most naturally on the reverse proxy at `192.168.0.173`. That is more containers to run, more to patch, more to back up, and it sits on a machine I know nothing about. For a small known set of users, Access wins clearly. **This is D3 in section 14.**

### 7.5 "On each page" is the wrong unit — it should be every request

A small but load-bearing correction. Enforcement has to be per **request**, not per **page**. That includes:

- API endpoints and anything a page calls after it loads
- static assets: CSS, JS, images, fonts
- websockets, if the app uses them
- any `/metrics`, `/debug` or admin path
- anything you add later and forget about

The common mistake is protecting the HTML routes and leaving `/api/*` open, at which point the login serves no purpose. With Cloudflare Access, the edge gate covers the whole hostname by default, which is why this class of mistake mostly disappears — but the app-side verification must also be a blanket middleware applied to everything, with exceptions added deliberately and never by default.

**DECISION — deny by default. Any unauthenticated path is an explicit, documented, reviewed exception.** At present there is exactly one candidate exception, and section 9 argues it out of existence.

**Health checks do not need an exception.** A Docker `HEALTHCHECK` runs *inside* the container and talks to `127.0.0.1:8000`, never crossing the edge. Bind a `/healthz` route to loopback-origin requests only, or simply let it be authenticated and have the healthcheck present no credentials but expect a 403 — either works. **DECISION: use an in-container healthcheck against loopback; no public unauthenticated health endpoint.**

### 7.6 A detail about secrets on Unraid that argues for Access

**FACT of how Unraid works:** user templates live at `/boot/config/plugins/dockerMan/templates-user/` — that is, on the **flash drive**, in plain XML. The existing template passes `PUBLIC_URL` as a `Type="Variable"` with `Mask="false"` (FACT, quoted in the brief).

So any secret you put in a template is stored in plaintext on the USB stick, and is included in every Unraid flash backup you take. `Mask="true"` hides it in the GUI; it does not encrypt it on disk.

If you roll your own JWT, the signing key is a secret and it has to get into the container somehow — most naturally as a template variable, i.e. plaintext on the flash. If you use Cloudflare Access, the app needs only the team domain and the AUD tag, **neither of which is secret**, and there is nothing to leak. That is a real, concrete operational advantage and not a theoretical one.

### 7.7 What is out of scope but should be said once

R9 says "nothing should be accessible by a back door". Strictly read, that is a statement about the whole host, not about this app. The Unraid web GUI, SSH on `192.168.0.148`, and 40-odd other containers publishing on `0.0.0.0` all exist regardless of what OzBargain Hunter does. Hardening those is not this project's job and I am not going to scope-creep into it. But it is worth stating once, in writing, that this app can be made as tight as section 7.2 Option 1 allows and the host as a whole will still be exactly as exposed as it is today.

---

## 8. Repository and pipeline layout

### 8.1 Branches

**DECISION:**

- **`main`** — deployable. Every push builds and publishes `:latest` and `:main-<sha>`. Intended to be reached via pull request, subject to section 8.3.
- **`beta`** — the single long-lived integration branch. Every push builds and publishes `:beta` and `:beta-<sha>`. This is the branch that owns the `beta` tag, resolving the collision problem in section 5.2.
- **`feature/*`, `fix/*`** — short-lived. Builds and tests run; **nothing is published**.
- **Git tags `v*.*.*`** on `main` — publish semver tags and move `:stable`.

I deliberately have not proposed a full GitFlow. For a single developer it is overhead with no payoff. Two long-lived branches plus short feature branches is the right weight here.

### 8.2 What the build produces

**DECISION — a single-architecture image, `linux/amd64` only.** Unraid on this host is x86_64 (FACT: Unraid 7.2.3 on `SlimMamma`). Building `linux/arm64` as well would roughly double build time and produce an artefact nothing you own will ever run. If you later want to run this on a Raspberry Pi, that is a one-line change to the workflow; do not pay for it now.

**DECISION — OCI labels on every image**, specifically:

- `org.opencontainers.image.source` = `https://github.com/jamesgallagher/OzBargainHunter`
- `org.opencontainers.image.revision` = the full commit SHA
- `org.opencontainers.image.version` = the tag or branch name
- `org.opencontainers.image.created` = build timestamp

The `source` label is not cosmetic. It is what links the GHCR package back to the repository, which is what makes the package show up on the repository page and what lets the package inherit repository access settings. Without it you get an orphan package with its own separate permissions to manage, which is a small, annoying, entirely avoidable mess.

**DECISION — build cache via GitHub Actions cache**, so the second build onward is fast. Not load-bearing; just do it.

### 8.3 Branch protection — and the plan-tier problem

**FACT, from the brief:** the GitHub account `jamesgallagher` is a **personal** account, and the API returned `plan: null`. **The plan tier is UNVERIFIED.**

This matters concretely. On GitHub, **rulesets, classic branch protection and merge queues are plan-gated for private repositories on a personal Free account.** They are available for public repositories on Free, and available for private repositories on Pro and above.

So the question "can CI block a merge?" has three possible answers and I do not know which one applies:

- Repository **public**, account Free → protection available. Works.
- Repository **private**, account **Pro** or above → protection available. Works.
- Repository **private**, account **Free** → **protection not available**. CI runs, CI reports, CI cannot block anything.

**This must be probed before any acceptance criterion says "CI gates the merge".** Probe P8 in section 11. Do not build a process on top of a feature you have not confirmed you have.

### 8.4 The fallback if branch protection is unavailable

If the probe comes back "private repo on Free, no protection", here are the options in order of how much I like them.

**Fallback A (recommended) — make the deployment the gate, not the merge.**
You cannot stop yourself merging a red build, but you can absolutely stop a red build reaching your host. The publish step is conditional on the test job passing. If tests fail, no image is pushed, `:latest` does not move, `:stable` certainly does not move, and the Unraid host sees nothing new. The bad commit sits in `main` looking embarrassing and affects nothing.

This is the honest engineering answer, and it is arguably *better* than branch protection for your situation, because branch protection protects the branch while this protects production. It also works identically regardless of plan tier, which means **you can build it now without waiting for the probe.** That is the real reason I rank it first.

**Fallback B — make the repository public.** Unlocks rulesets on Free at zero cost, and also solves the logo hosting problem in section 9, and also makes Actions minutes unmetered. Three problems, one decision. The cost is that the code is public — which for this project may be completely fine, or may not be, depending on the premise (section 2) and the naming question (D9). **This is D1 and it is worth thinking about properly rather than defaulting.**

**Fallback C — GitHub Pro.** Roughly US$4/month, enables protected branches on private repositories. Perfectly reasonable if you want a private repository and a real merge gate.

**Fallback D — local git hooks.** A `pre-push` hook running the same checks. Helps against carelessness; useless against deliberate bypass (`--no-verify`), and it does not run in CI. Supplementary at best. Do not rely on it as the gate.

**DECISION: implement Fallback A regardless of what the probe returns.** If protection is also available, use both. A gate on the merge and a gate on the deployment are not redundant; they catch different mistakes.

### 8.5 What CI actually runs

The product premise is unknown, so the *content* of the tests is **OPEN**. The *shape* is decidable now, and I am deciding it:

1. **Lint / format check** — fails the run on violation.
2. **Unit tests** — fails the run on any failure.
3. **Build the image** — on every trigger including pull requests.
4. **Smoke test the built image** — run the container in the runner, wait for health, make one HTTP request, assert a sane response. **I consider this the most important job in the pipeline**, because it is the only one that catches "builds fine, crashes on startup", which is exactly the failure that auto-update will happily deploy to your house. A build that only compiles proves very little.
5. **Publish** — runs only on `main`, on `beta`, or on a `v*` tag, and **only if 1–4 passed**.

**DECISION — pull requests run 1–4 and never publish.** Keeps the registry clean and makes the pull request a real check rather than a formality.

**OPEN — dependency and image scanning.** Trivy or Dependabot would be sensible additions. Still open, but the premise narrows it: this application parses untrusted XML fetched from the internet, so whatever it is written in, the XML parser is the dependency most worth watching (17.2). Not blocking.

### 8.6 Repository layout

**DECISION** — at the point where building starts, which is not now:

- `design.md` — this file
- `BRIEF.md` — the requirements record
- `README.md`
- `.github/workflows/` — build and publish
- `Dockerfile`
- `unraid/my-OzBargainHunter.xml` — canonical template (section 6.6)
- `assets/logo/` — logo sources and exports (section 9)
- application source, layout **OPEN** — the runtime and language are still deliberately undecided (nothing in this design depends on them), but the shape is now known from sections 17–20: a poll loop, a rules engine, a SQLite store with migrations, a notifier behind a one-method interface, and a small web UI

None of these exist yet and none will be created at this stage.

---

## 9. The logo

### 9.1 What is actually needed

The Unraid template's `<Icon>` field takes a URL to an image that Unraid renders in the Docker tab and on the Dashboard, at small sizes.

**DECISION — asset set:**

- `assets/logo/logo.svg` — vector master, the source of truth
- `assets/logo/icon-512.png` — 512×512, transparent background, exported from the master
- `assets/logo/icon-256.png` — 256×256, transparent background. **This is the one the Unraid `<Icon>` points at.**
- `assets/logo/favicon.ico` plus `favicon-32.png` and `apple-touch-icon-180.png` — for the web app itself, once it exists

**DECISION — design constraints, which I can set without knowing the premise:**

- Square aspect ratio. Unraid assumes it; non-square gets squashed.
- Must be legible at **32 pixels**. This is the binding constraint and it rules out most ideas.
- **No text in the mark.** Words are illegible at 32px and just become grey mush. The container name already appears as text beside the icon.
- No hairline strokes; they disappear when downscaled.
- Must read on a **dark background** — Unraid's default theme is dark, and this is the single most common way home-lab icons end up looking broken.
- Transparent background, not white.

**Now unblocked — what the mark depicts.** The app watches for deals that are climbing and alerts on them. That gives three honest directions that all survive the 32-pixel test in the constraints above: an upward trend arrow, a stylised radar or sonar sweep (watching, detecting), or a simple alert/bell form. My preference is the **trend arrow**, because it is the one idea that reads at 32px with a single heavy stroke, it says "rising" which is the distinctive thing this tool does, and it is the furthest from anything resembling OzBargain's own mark. Still **OPEN** as a choice — this is the sort of thing you will have an opinion on, and it is cheap to change now.

**OPEN, flagged in section 2 and repeated here because it lands specifically on this deliverable —** the mark must not copy, imitate or evoke OzBargain's own branding. Combined with the naming question (D9), this is worth thinking about before an artist, a generator or I produce anything.

### 9.2 Where it lives and how it reaches Unraid

Here is the collision I flagged in section 1.

**FACT:** the existing verified template reads `<Icon>https://fes.gallagherhome.au/icon.png</Icon>` — the icon is served by the application itself, over its own public hostname.

**If you follow that precedent here, it breaks**, because of your own requirement R8. Every request to `ozb.gallagherhome.au` will be gated by Cloudflare Access. Unraid fetching `https://ozb.gallagherhome.au/icon.png` has no Access session, so it receives a redirect to a login page instead of a PNG, and your Unraid dashboard shows a broken image icon forever. Nothing errors. Nothing logs. It just looks wrong and you spend twenty minutes wondering why.

There are two ways out.

**Option A (recommended) — serve the icon from the repository, not the app.**

`<Icon>https://raw.githubusercontent.com/jamesgallagher/OzBargainHunter/main/assets/logo/icon-256.png</Icon>`

This is better than the existing precedent in three separate ways, not just the one:
- It is unauthenticated because it is a public file on GitHub, so Access never sees it.
- The icon renders **even when your app is down or mid-update** — which is precisely when you are looking at the Docker tab.
- It creates no unauthenticated public endpoint on your app at all, which keeps section 7.5's "deny by default" genuinely absolute.

**The catch: `raw.githubusercontent.com` only serves public repositories.** For a private repository the URL needs a token, and those expire. So **Option A requires the repository to be public** — which is the second independent reason D1 (public vs private) matters, after branch protection in section 8.4. Two unrelated problems, one decision.

**Option B — carve out `/icon.png` as an unauthenticated route on the app.**

Works with a private repository. The risk is genuinely negligible in itself — it is a logo. But it establishes the precedent that "deny by default" has exceptions, and exceptions accumulate. If you go this way, the exception must be exactly one path, hard-coded, not a pattern, and written down here.

**DECISION: Option A if the repository is public, Option B if it is private.** This is contingent on D1 and I am not pre-empting your call on that.

**Minor OPEN:** Unraid may cache fetched icons locally, so replacing the logo later might not show up immediately. I have not verified how or where it caches. Not blocking; worth knowing when the icon changes and appears not to.

---

## 10. Evidence, not assurances

You said you want evidence. Here is what "done" looks like for the delivery loop, expressed as things you can observe rather than things I can claim.

**Acceptance test for the end-to-end path** (to be run once there is something to build, not now):

1. Push a trivial commit to `main`. Record the short SHA — call it `a1b2c3d`.
2. **Evidence:** the GitHub Actions run for that SHA shows all jobs green, including the smoke test from section 8.5. Screenshot or `gh run view`.
3. **Evidence:** the GHCR package page lists a new version with a fresh timestamp, tagged both `latest` and `main-a1b2c3d`.
4. Push git tag `v0.0.1`. **Evidence:** `:stable` now resolves to the same digest as `:main-a1b2c3d`.
5. On the Unraid Docker tab, click **Check for Updates**. **Evidence:** `OzBargainHunter` flips from "up-to-date" to "update ready".
6. Let the scheduled auto-update run, or apply it manually. **Evidence:** over SSH, `docker inspect --format '{{.Image}}' OzBargainHunter` returns the digest recorded in step 3. **This is the check that matters** — it is the one that catches the `docker restart` trap from section 6.2, because every other check would pass even if the update had silently done nothing.
7. **Evidence of rollback:** change `<Repository>` to the previous `main-<sha>` tag, apply, and confirm step 6's digest goes back. A rollback path you have never exercised is not a rollback path.

**Acceptance test for access control:**

1. From a browser with no Cloudflare session, request `https://ozb.gallagherhome.au/`. **Evidence:** redirected to the Access login, never reaching the app. Confirm in the app's own logs that no request was recorded.
2. Authenticate. **Evidence:** the page loads, and the app log shows the verified `email` claim from the JWT.
3. **The important one.** From a LAN machine, request the container directly, bypassing Cloudflare entirely. Under Option 1 (section 7.2) **evidence** is connection refused — there is no published port. Under Option 3, **evidence** is a `403` from the application because the Access JWT is absent. Either is a pass. A `200` is a failure of the whole design and means the app is not verifying the token.
4. Request a static asset directly with no session. **Evidence:** not a `200`.
5. **Evidence:** the Unraid Docker tab shows the icon rendering correctly — which confirms section 9's collision was actually avoided.

**Acceptance test for the alert lifecycle (R25, R26, R27).** Added in the third revision. These are the checks that catch the failures section 21 is designed against, and each is a thing you observe on your own phone rather than something I claim.

1. **R25, one alert per criterion.** Let a deal trip the trend rule, then watch it across the next six polls. **Evidence:** exactly one notification, and the alert ledger holds exactly one row for that `(node_id, rule_id)`. Then let the same deal be promoted to the front page. **Evidence:** a second notification, from a different rule, and two ledger rows. One deal, two alerts, two distinct criteria — that is R25 working, and a third notification from either rule is a failure.
2. **R26, the one-click unsubscribe, and this is the one to time with a stopwatch.** From a notification on your phone with the screen locked, tap the unsubscribe control. **Evidence:** count the taps it actually took, including any login. Under Mechanism A a login bounce is expected sometimes and is a pass; **an in-app webview that demands a login every single time is a failure of D17 and means Mechanism B**, and this test is the only way to find out. Then: **Evidence** that the rule shows as muted in the manager, that a confirmation arrived, that no further alerts come from it, and — the one people forget — **that an alert from that rule which was already queued does not arrive afterwards.**
3. **R26, the security property, and it differs by mechanism.** Under **Mechanism A**: take the unsubscribe URL, open it on a device with no Cloudflare session. **Evidence:** you reach an Access login and the rule is not muted. A mute is a total failure of the design. Under **Mechanism B**: use a token once. **Evidence:** the second use returns the same response as an invalid token and changes nothing. Then confirm an expired token is refused, and that the token cannot reach any path other than its own.
4. **R26, undo.** Re-enable the muted rule from the manager. **Evidence:** it fires on the next match — and does **not** fire on everything it matched while muted, which is the silent-evaluation decision in 21.5 working.
5. **R27, reachability.** Tap "Manage alerts" from a notification. **Evidence:** the manager loads on the phone, authenticated, and is actually usable at that screen size. It being reachable but unreadable on a phone is a failure of the requirement, since a notification is the primary way in.
6. **R27, deny-by-default still holds after the UI exists.** From a browser with no Cloudflare session, POST to a rule-editing endpoint. **Evidence:** not a `200`, and the rule is unchanged. Repeat from a LAN machine directly against the container. Same expectation. **This is the test that proves R27 did not quietly punch holes in section 7.**
7. **D21, the topic is not world-readable.** Subscribe to the notification topic from an unauthenticated client. **Evidence:** refused. If it succeeds, every alert and — under Mechanism B — every unsubscribe token has been public the whole time.

Every one of these is a command or a screenshot, not a claim.

---

## 11. Probes that must run before implementation

These are read-only. None of them changes state. They resolve the OPEN items that block work. I have not run them, because this stage is design only.

- **P1 — Is the tunnel locally or remotely managed?** Inspect the `cloudflared` container's logs for evidence of configuration being pushed from Cloudflare, and check the tunnel's configuration in the Zero Trust dashboard. Blocks section 7.2 Option 1.
- **P2 — How does a new `*.gallagherhome.au` hostname get routed?** Determine whether a Cloudflare DNS record is required, whether a route must be added on the reverse proxy at `192.168.0.173`, or both. Blocks R7 entirely.
- **P3 — What is `192.168.0.173` and do you administer it?** Nothing in the brief establishes what it runs or whether you can change it. If you cannot change it, Option 1 in section 7.2 becomes the *only* viable option, not merely the preferred one.
- **P4 — Confirm Unraid's update-detection mechanism** on this specific version (7.2.3) — that the digest comparison behaves as described in section 6.1, and where the cached result lives.
- **P5 — How do the existing eight `ghcr.io/jamesgallagher/*` images pull?** Are those packages public, or does the host hold a GHCR credential? Determines whether section 4.3 is a problem or a non-issue.
- **P6 — Is Community Applications installed, and is CA Auto Update Applications available?** Determines the section 6.3 click path.
- **P7 — Is Cloudflare Zero Trust / Access already enabled on the account?** Is there a team domain? Determines how much of section 7.4 is setup versus configuration.
- **P8 — GitHub plan tier.** Determines whether branch protection is available for a private repository. Section 8.3.

**Added after the premise, and both are now resolved. They are kept here as a record rather than struck out, because what a probe returned is worth more than the fact that it ran.**

- **P9 — Does an OzBargain account actually unlock `/classified`? (U7) — RESOLVED, positive.** James opened the page in his own logged-in browser and supplied a screenshot. It renders a full listings page. This was the highest-value probe in the list and it came back in our favour: the workstream is not closed, only the method question remains. The anatomy it revealed is in 18.7. **Superseded by P11, which is the follow-on capture that is now worth doing.**
- **P10 — Is there an ntfy instance already running on this host? — RESOLVED, negative.** The orchestrator checked directly: `docker ps -a` on `192.168.0.148` lists no ntfy, Gotify or Apprise container, and there is no matching Unraid template. **There is no ntfy on this host.** The belief that one was already serving Uptime Kuma is not supported by anything on the machine — those alerts may go somewhere else on the network or to the public `ntfy.sh`, and neither has been verified. I flagged this as a convenient assumption in 20.5 before it was checked, and it turned out to be one. **Consequence: D13 costs a container, or costs a decision to use somebody else's service.** Answering it is now P12.

**Added after the classifieds screenshot and the R25–R27 alert rules.**

- **P11 — Capture the classifieds page properly, now that we know it renders. (U11, U12)** Another browser-only job for James, no automation, and it is the one that lets a parser be written without the agent ever holding a credential. Four things to capture: **(a)** save the page source of `/classified` — "Save page as → HTML only", or copy the DOM out of developer tools — because 18.7's anatomy comes from a rendered screenshot and a parser has to be written against markup, not against a picture; **(b)** type something into the "Search classifieds" box, submit it, and **report the resulting URL**, because if it routes through `/search/` then the efficient path for R20/R21 sits on the robots-disallowed list (U11) and 18.8 changes; **(c)** scroll to the top of the page and say whether there are tabs, type filters or category filters above the search box, which the screenshot is cropped above (U12); **(d)** note the `PHPSESSID` cookie's value and expiry from developer tools, which is Option B's only real unknown. **Privacy note: the page carries other members' usernames, so whatever is captured stays out of the repository**, the same way the screenshot did.
- **P12 — Where do notifications actually go? (U4/D13)** P10 answered the easy half negatively. The remaining question is yours: stand up an ntfy container, point at an instance elsewhere on your network if one exists, use public `ntfy.sh`, or pick a different channel entirely. **This is now a real decision with a real cost rather than a formality**, and R26 adds a constraint to it that did not exist before — see P13 and D21.
- **P13 — Confirm the notification channel can carry an action button, and that its topic can be locked down.** R26's one-tap unsubscribe depends on the channel supporting a button in the notification, and D21 depends on the topic not being world-readable. For ntfy I have checked both against the vendor's own documentation rather than assuming — `docs.ntfy.sh` states up to **three** action buttons per notification, of types `view`, `http`, `broadcast` and `copy`, with the `http` type sending a POST with custom headers and a body without opening a browser; and it states that by default **"everyone can read and write to any topic"**, with per-topic ACLs available via `ntfy access USERNAME TOPIC PERMISSION` and `auth-default-access: deny-all`. **Documented, not measured.** It must be confirmed on the actual instance once P12 picks one, because a channel that cannot carry a button makes 21.4 unbuildable as designed. If you choose a channel other than ntfy, this probe is about that channel instead.
- **P14 — Confirm what Cloudflare Access can do on a single path.** Needed only if D17 goes the way of Mechanism B. From Cloudflare's own documentation: Access supports a **Bypass** policy action which "disables Access enforcement for specific traffic", applications can be scoped to a path and not just a hostname (with wildcard support), Service Auth policies with service tokens exist, and Session Duration is configurable per application. One cost is stated explicitly in that documentation and I am repeating it because it matters: under Bypass, **"requests are not logged"** by Access. **Documented, not measured** — confirm against your own Zero Trust account, which is P7's territory anyway.

---

## 12. Staged plan

Each stage ends at a human approval gate. No stage starts before the previous one is signed off.

- **Stage 0 — now.** This document. Nothing built. Awaiting your review and your answers in section 14.
- **Stage 1 — probes.** Run P1–P8. Report raw output. Update this document's OPEN items with facts. Still nothing built. **P9 and P10 are already done and are struck from this stage** — P9 came back positive (the classifieds render for an authenticated account) and P10 came back negative (there is no ntfy on the host). What replaces them is **P11**, the follow-on classifieds capture that a parser needs, and **P12**, choosing a notification channel now that the convenient answer has evaporated. P13 and P14 are capability confirmations and can run alongside.
- **Stage 2 — the pipeline skeleton.** Repository created, remote added, a trivial "hello" container, Dockerfile, build workflow, tagging scheme, GHCR publish. **The entire delivery loop is proven with a placeholder application before any product code exists.** This is deliberate: it means when the real app arrives, the delivery path is already known-good and any failure is unambiguously in the app. Ends with the section 10 acceptance test passing.
- **Stage 3 — exposure and access control.** Hostname, ingress edit, Cloudflare Access application, JWT verification in the placeholder app, Unraid template, logo. Ends with the section 10 access-control test passing.
- **Stage 4 — the actual product: the deals side.** The premise has landed, so this is now designed rather than deferred — sections 2 and 17 through 21. Feed acquisition, SQLite state, the three alert rules, de-duplication, the notification channel, the dead-man's switch, and the web UI. **Needs no OzBargain account and no credential**, so it is not blocked by anything in section 18 and delivers R16–R21 and R23 on its own. Still not estimated.

  **Honest revision: R25–R27 land in this stage and they make it bigger.** R25 was already satisfied by the alert ledger in 20.1, so it costs nothing (21.1). R26 and R27 are new work and they are not trimmings — R27 in particular turns the web UI from a status page into a small CRUD application with forms, validation, CSRF and write endpoints, and 21.8 says plainly what that means. **If you would rather split Stage 4 into "alerting works" and "you can manage it", say so** — I have not split it on your behalf, because a poller that can only be reconfigured by editing an Unraid template and recreating a container is a worse first release than one you can actually drive, and because R26 and R27 are the requirements that make the tool liveable rather than merely correct.

- **Stage 5 — classifieds, if you want them.** **No longer contingent on P9** — U7 is settled and the section demonstrably renders for an authenticated account. It is now contingent on exactly one thing: your answer to **D10**. If you choose Option B it is a contained piece of work: one authenticated page fetch every 15 minutes, an HTML parser for the row anatomy in 18.7, and the two rules that can apply there (18.8). If you choose Option C it is larger, and it carries the three objections in 18.3 that your screenshot left completely untouched, plus the narrowed fourth, plus the new fifth about account age. **Deliberately still last**, so the whole product is working and useful before anything touches an account — and note that with R19 excluded from classifieds by F15, Stage 5 adds coverage for your watchlist and keyword terms and nothing else. That is a smaller prize than it looked before the screenshot arrived, and you should price the decision accordingly.

**The case for building Stage 2 against a placeholder app**, since it may look like busywork: it separates "is my delivery pipeline correct?" from "is my application correct?". Debug those together and every failure has two possible causes. Debug them apart and every failure has one. It also means the first time you push real product code, it deploys to your house automatically and correctly, which is a good day.

---

## 13. What is blocking

In order of how much they block.

- **B1 — the application premise (R15). RESOLVED.** The premise landed on 19 September 2026 and is designed in sections 2 and 16–21. The specifics it was blocking are now settled: the volume mount target is `/data`, storage is SQLite (no database container), egress is to ozbargain.com.au and one notification endpoint, and the logo now has a subject to depict.

**New blockers arising from the premise:**

- **B7 — U7: nobody has demonstrated that an OzBargain account actually unlocks `/classified`. RESOLVED.** James logged in and supplied a screenshot of the rendered listings page on 19 September 2026. An account is sufficient for *his* account. This no longer blocks anything. Two smaller successors remain and neither is a blocker: the markup has not been captured (P11), and **the evidence covers an established account, not a newly created one** — which matters only if D10 goes to Option C, and is argued in 18.2.
- **B8 — D10: the R24 policy decision.** Whether to authenticate to OzBargain at all, and if so how. This is James's call, not mine and not the orchestrator's. **It is now the *only* thing blocking classifieds, since B7 is resolved**, and it is argued in section 18. Blocks R22/R24 only; the whole of the deals side (R19, R20, R21) proceeds regardless.
- **B9 — U4/D13: where notifications go.** Blocks the last hop of every alert. **The cheap answer is gone.** The specific thing I asked to be verified has been verified and it came back negative: **there is no ntfy, Gotify or Apprise container on this host and no matching Unraid template** (P10). So this is no longer "confirm the free option is really there" — it is a decision with a cost attached, either a new container to run and patch or a dependency on a service outside the house. R26 adds a second constraint on top: whatever the channel is, it has to carry an action button in the notification (P13) and its topic must not be world-readable (D21).
- **B10 — U6/D11: the trend threshold numbers.** Does not block a build — I have proposed defaults justified against real measured data (section 17.3) and made them configurable. It blocks *acceptance*, in the sense that only James can say whether ~3.5 alerts a day is the right volume.
- **B2 — tunnel management mode (P1).** Blocks the recommended exposure design. Without this, section 7.2 Option 1 cannot even be attempted.
- **B3 — hostname routing ownership (P2, P3).** Blocks R7. If you do not administer `192.168.0.173`, the design narrows sharply.
- **B4 — repository visibility (D1).** Blocks the branch-protection decision (8.3/8.4), the logo hosting decision (9.2), and interacts with the naming question (D9). One decision, three downstream consequences.
- **B5 — Cloudflare Access acceptance (D3).** If you reject Access, section 7.4 is rewritten and Stage 3 grows substantially — you would be designing and building an authentication system rather than configuring one.
- **B6 — GitHub plan tier (P8).** Blocks any acceptance criterion phrased as "CI blocks the merge". Does **not** block Stage 2, because Fallback A in section 8.4 works on any plan.

**New blocker from the R25–R27 alert rules:**

- **B11 — D17: how the one-click unsubscribe authenticates.** R26 cannot be built until this is answered, because the two candidate mechanisms produce different code, different Cloudflare configuration and different security properties. It is a genuine collision between two of your own requirements and I am not going to resolve it by quietly demoting one of them. **It blocks R26 only** — R25 is already done (21.1) and R27 can be built without it. Section 21.2 states the collision, 21.3 and 21.4 design both answers, and the decision is yours. Note it is cheap to defer: the alert manager can ship first with unsubscribe reachable only from inside the authenticated UI, and the notification-side control added afterwards.

---

## 14. Decisions I need from James

Each has my recommendation and the reason. Answer these and Stage 1 can start.

- **D1 — Repository public or private?**
  *Recommendation: public.* It unlocks branch protection on a Free plan at no cost, makes Actions minutes unmetered, and makes the logo hosting clean (section 9.2 Option A). The cost is that the code is readable by anyone, which interacts with D9. If it must be private, the design still works — Fallback A for the gate, Option B for the icon — it is just slightly worse in three places.

- **D2 — Does production track `:latest`, or a promoted `:stable`?**
  *Recommendation: `:stable`.* It restores rollback and puts a human decision between "committed" and "live", at a cost of one `git tag` command. Tracking `:latest` means every push to `main` deploys itself to your house overnight. You would not accept that gate-free flow from a team; I do not think you should accept it from yourself.

- **D3 — Cloudflare Access plus app-side JWT verification, or a self-built login?**
  *Recommendation: Cloudflare Access.* Less code, no stored secrets, MFA free, unauthenticated traffic never reaches your app. The only reason to reject it is if the premise requires public self-service signup — which is exactly the kind of thing the premise might reveal, so hold this one lightly until section 2 is filled in.

- **D4 — Network placement: shared Docker network with `cloudflared` and no published port, or keep the published port?**
  *Recommendation: shared network, no published port* (section 7.2 Option 1). It is the only option that makes R9 literally true. The real cost is that you lose LAN access to the app for debugging, and you should decide whether that bothers you before, not after.

- **D5 — Public hostname.** *Suggestion: `ozb.gallagherhome.au`.* Yours to pick; cheap now, annoying later. Confirm or replace.

- **D6 — Do you want a beta container running alongside production on the same host?**
  *Recommendation: yes* — a second Unraid template `my-OzBargainHunter-Beta.xml`, tracking `:beta`, on its own appdata directory `/mnt/user/appdata/ozbargain-hunter-beta/`, its own hostname, and **auto-update off**. It costs one container's worth of RAM and gives the `beta` tag somewhere to actually land. Without it, `:beta` is a tag nothing ever runs, which makes R12 decorative.

- **D7 — Confirm the "beta alongside latest" reading.** I have assumed Reading A in section 5.2: branch builds get `:beta`, `main` keeps `:latest`, two different images. Confirm, because Reading B would push unfinished work to production automatically.

- **D8 — Build-to-live latency.** What delay between "build went green" and "it is running" are you actually willing to accept? Daily at 04:00 is my default. If the answer is "minutes", say so now, because it changes section 6.4.

- **D9 — The name.** "OzBargain" is a third party's brand. Publishing a public repository and a public container image under a name derived from theirs, with a logo, is a decision rather than an oversight. I am not telling you not to; I am telling you to decide it on purpose. It also feeds D1.

**Decisions arising from the premise. D1–D9 are unchanged and keep their numbers.**

- **D10 — The big one: do we authenticate to OzBargain for the classifieds (R24), and if so how?**
  *Recommendation, now firmer rather than different: Option B. Not by driving the login form — you supply the session cookie yourself.* Three options are laid out in full in section 18.4. **Your screenshot changed the question but not the answer.** It removed the objection that we were building toward an unproven premise, which was the one objection that argued for doing nothing at all, so Option A ("skip classifieds") is now weaker and Option B is now stronger — the destination is confirmed to exist and Option B's only remaining unknown is how long a session lasts. What the screenshot did not touch: `robots.txt` still names `/user/login` as disallowed, the gate still exists specifically to keep non-members out because of scams, the site owner still tunes Cloudflare rules against bots continuously, and the account at risk is still your personal one. **And a new objection appeared that argues specifically against Option C:** R24 as you worded it says *"we will likely need to create a user login for this"*, but your evidence comes from your own long-standing account, and OzBargain's published classifieds rules gate participation on membership older than one year. Nobody has shown what a *freshly created* account sees at `/classified`. Option C wants its own account; the evidence does not cover one. Option B uses the account the evidence actually covers. **Read section 18 before answering.** It is still the decision I most want you to make deliberately.

- **D11 — The trend thresholds (R19).** *Recommendation: alert when a deal is under 6 hours old, has at least 10 net votes, and is running at 5.0+ net votes/hour; and separately whenever a deal is promoted to the front page.* Measured against 120 real deals, that fires about 3.5 times a day plus about 10 front-page promotions a day. All four numbers are environment variables and I expect you to move them in week one. Justification and the measured distribution: section 17.3.

- **D12 — Poll interval.** *Recommendation: 5 minutes.* Two feeds, conditional requests, which means ~576 requests a day of which almost all return 304 with a zero-byte body. Your trend detection can never be finer-grained than this number, and that relationship is stated honestly in section 17.6. Faster is possible and I would not go below 2 minutes.

- **D13 — Notification channel (U4).** *Recommendation: ntfy, behind a one-method internal interface* so that swapping to Discord, Apprise or email later touches one file. Reasoning in section 20.5. **Correction since the last revision: there is no ntfy on this host.** I flagged the "there's already one running for Uptime Kuma" note as an assumption that would otherwise get quietly baked in; it was checked directly and it is not true — `docker ps -a` on `192.168.0.148` shows no ntfy, Gotify or Apprise container and no matching template. So this decision now costs you a container rather than nothing. I still recommend ntfy, and the reasons in 20.5 are unchanged and were never based on it already being there — but you are choosing to stand something up, not choosing to reuse something, and that is a different decision. See also D21, which R26 forces on top of this one.

- **D14 — Identify the bot honestly in the User-Agent, rather than impersonating a browser.**
  *Recommendation: yes, identify honestly.* Every prior-art project I read spoofs either Chrome or curl. I am recommending against that, and the reasoning is in section 20.2. It carries a real risk, which is that an honest bot is easier to block deliberately than a hidden one. I think that risk is worth taking and I have verified that an honest User-Agent returns 200 today.

- **D15 — Seed on first run; do not alert on history.** *Recommendation: on a cold start with an empty database, record everything the feeds currently show as already-seen and send zero alerts.* Otherwise your first launch fires 120 notifications for deals from two days ago. Section 19.3.

- **D16 — A dead-man's switch is part of the product, not an optional extra.** *Recommendation: if no poll has succeeded for 30 minutes, send an alert saying so.* A silent broken alerter is worse than no alerter, because you will trust it. Section 20.4.

**Decisions arising from the R25–R27 alert rules. D1–D16 are unchanged and keep their numbers.**

- **D17 — How does the one-click unsubscribe authenticate? This is the one that needs your judgement, not mine.**
  *Recommendation: Mechanism A — the unsubscribe link is an ordinary application URL behind Cloudflare Access, exactly like every other page, with no exception of any kind.* The honest cost is that "one click" becomes "one click **plus** an identity-provider bounce whenever your phone's Access session has lapsed". With a long Access session duration that bounce should be rare, and whether your phone opens the link in a browser that holds the Access cookie or in a cookie-less in-app webview is testable in five minutes (21.4).
  *The alternative is Mechanism B* — a scoped, single-use, expiring capability token delivered as an action button that fires the request directly, with no browser involved. **That is literally one tap and it always works.** It costs exactly one documented exception to R8 and to section 7.5's deny-by-default, it needs a Cloudflare Access Bypass policy on one path, and Cloudflare's own documentation notes that under Bypass **requests are not logged** — so the single endpoint with no identity check is also the single endpoint with no edge audit trail. I do not like that combination and I am naming it rather than burying it.
  **I am putting this to you rather than picking**, because you wrote R8 and R9 in strong terms and you wrote R26 in strong terms, and they genuinely pull against each other. Section 21.2 states the collision precisely, 21.3 covers what I rejected and why, 21.4 designs both and states what an attacker holding the link can actually do in each. If you tell me "one tap, always, I accept the exception", I will build Mechanism B and it will be scoped as tightly as 21.4 describes.

- **D18 — What is in the alert manager in v1?**
  *Recommendation: rules list with enable/disable/snooze, add/edit/delete a rule, alert history, near-miss log, acquisition status, and a test-notification button — and nothing else.* Specified in 21.7. What I would deliberately leave out of v1: user accounts (there is one user), per-rule notification routing, saved searches over history, and any charting. **Be aware this is the requirement that changes the shape of the project** — 21.8 is honest about it. If you want it smaller, the thing to cut is the alert history view, because it is the largest piece and the least load-bearing.

- **D19 — Rule configuration moves out of environment variables and into the database.**
  *Recommendation: yes, with a clean split.* R27 only means something if the things it manages are editable without recreating a container. So **rule** configuration — watchlist and keyword terms, per-term cooldowns, enabled state, the four trend thresholds from D11 — lives in SQLite, seeded from environment variables on first run, with the UI as the source of truth thereafter. **Operational** configuration stays exactly where section 20.4 put it: feed URLs, the User-Agent, the poll interval and the notification endpoint remain environment variables, because when acquisition breaks the fix must be a template edit and a restart rather than a rebuild. The split is "things you tune" versus "things you fix in an emergency", and it matters that they do not live in the same place.

- **D20 — Notifications are grouped by rule, not by poll.**
  *Recommendation: yes, and it is a revision to a decision I already made in 20.1.* That section says one poll producing five alerts sends one notification listing five deals. R26 breaks that: if a single notification covers three different rules, an "unsubscribe" button on it has no unambiguous target, and a button that unsubscribes from the wrong thing is worse than no button. **So the grouping unit becomes (rule, poll)** — one notification per rule per poll, listing all of that rule's deals, carrying exactly one unsubscribe control that names that rule. The cost is more notifications on a busy poll; the mitigation is that this is precisely the case the per-term cooldown in 20.1 already exists to damp. Reasoning in 21.6.

- **D21 — The notification topic must be access-controlled, and this is no longer optional.**
  *Recommendation: yes — a dedicated user, a non-guessable topic name, and `auth-default-access: deny-all`.* Vendor documentation for ntfy states that by default **"everyone can read and write to any topic"**. Before R26 that was untidy: anybody who guessed the topic name could read which bargains you were being told about. After R26 it is a security boundary, because your notifications now carry controls that change application state — and under Mechanism B they would carry a credential. A world-readable topic would hand every unsubscribe token to anyone who guessed a string. Note one trap in the same documentation: an ntfy access token grants **"full access to the user account"**, so the token the container holds must belong to a dedicated publish-only user, not to your admin user. If D13 picks a channel other than ntfy, the equivalent question has to be asked of that channel instead (P13).

---

## 15. Requirement-by-requirement verdict

Faithful coverage of `BRIEF.md` section 2, with my position on each.

- **R1 — Project folder `OzBargainHunter` under `/opt/data/projects/`.** Agreed, already true. No comment.
- **R2 — Display name "OzBargain Hunter".** Agreed, with the naming caveat in D9.
- **R3 — Logo, reused in the Unraid template.** Agreed, but **not served from the app's own URL** as the existing templates do — that collides with R8 and yields a permanently broken dashboard icon. Section 9.
- **R4 — Docker container.** Agreed without reservation.
- **R5 — Unraid via a user XML template.** Agreed. Template versioned in the repository, with the drift caveat in section 6.6.
- **R6 — Container can detect a new version so the host updates.** Agreed, with a correction: the *host* detects it, not the container, and it does so by **polling**. Requires the template to point at a moving tag. Section 6.
- **R7 — Public exposure via Cloudflare Tunnel.** Agreed in principle, **blocked** on B2 and B3. The current single catch-all ingress to a different machine is the central complication.
- **R8 — JWT enforced on each page.** Agreed and **strengthened**: per *request*, not per page; and sourced from Cloudflare Access rather than home-rolled. Section 7.4, 7.5.
- **R9 — Nothing reachable by a back door bypassing the tunnel.** **Not achievable as stated in the current topology.** Achievable with the change in section 7.2 Option 1. Substantially mitigated even without it, provided the app verifies the Access JWT rather than trusting the network path. This is the requirement I most want you to read the argument on.
- **R10 — GitHub version control.** Agreed.
- **R11 — Every commit automatically builds.** Agreed, with two precisions: the trigger is a *push*, one run per push not per commit; and a concurrency group is required or `latest` can end up pointing at the older of two rapid commits. Section 4.4, 4.5.
- **R12 — Every version tagged `latest`; `beta` alongside when branching.** **Challenged.** Kept as vocabulary, changed in substance: immutable `main-<sha>` and `beta-<sha>` tags so rollback is possible, exactly one branch owning `:beta`, and a promoted `:stable` for production. Section 5.
- **R13 — Push → build → host pulls and stays updated.** **Half agreed.** The build-and-publish half is exactly as you describe. The "then Unraid pulls it" half is a poll from your side, not a push from GitHub's, because the push version would require the inbound path that R9 forbids. Section 4.2.
- **R14 — Produce `design.md`, no build.** Done. This file and `research.md` are the only things created. No Dockerfile, no workflow, no scaffolding, no application code.
- **R15 — Premise supplied later.** Respected at Stage 0, and now **satisfied** — the premise arrived and section 2 is written from it rather than from a guess.

**R16–R24, from the premise and the mid-research update. Same style, same honesty.**

- **R16 — A scraper/aggregator for OzBargain.com.au.** **Challenged on the method, agreed on the goal.** It will aggregate OzBargain, but it will not scrape. The site publishes RSS feeds that carry more structured data than the HTML does, and the owner deliberately exempted `*/feed` from his Cloudflare bot rules to keep automated feed clients working. Scraping would be more fragile, more hostile and would yield worse data. Section 2.2, evidence in 16.4.
- **R17 — Criteria to surface "the best" or targeted deals.** **Partly agreed, partly not yet testable.** "Targeted" is fully specified by R20/R21 and is designed in 17.4 and 17.5. "The best" is not yet a number — U6 is still open. I have given the trend rule concrete defaults justified against measured data (17.3) rather than leave it hand-wavy, but whether they match your idea of "best" is yours to say.
- **R18 — Method chosen with Cloudflare anti-bot protection in mind.** **Agreed, and this drove the whole design.** The empirical boundary is in 16.2: Cloudflare blocks by client signature — Python's default `urllib` identity is banned outright — while the feeds are explicitly protected. The design stays entirely on permitted paths, identifies itself honestly, uses conditional requests, and treats a Cloudflare block and an application denial as different events with different responses (20.3).
- **R19 — Trending alert.** **Agreed, and it turned out to be easier and more literal than expected.** You described it as a deal appearing "on the 'new deals' page as well as the front page". Those are two separate RSS feeds — `/deals/feed` and `/feed` — so front-page promotion is a directly observable event, not something to infer. Combined with a vote-velocity rule for early warning before promotion. Section 17.3. One correction to your mental model: front-page placement is **not** derivable from vote counts — I measured a 9-vote deal on the front page and a 43-vote deal off it — so this has to be observed, not predicted.
- **R20 — Watchlist match on a saved term ("AMD R9700").** **Agreed, with the obvious implementation rejected on evidence.** The appealing design is to subscribe to the structured `/product/<slug>/feed`. It cannot be the primary mechanism: a product slug only exists once a deal for that product has been posted, and I verified there is no slug for the R9700 today. Waiting for the R9700 by subscribing to the R9700 feed requires the thing you are waiting for to have already happened. Text matching is primary; slugs are a precision enhancement. Section 17.4.
- **R21 — Keyword match ("ChatGPT").** **Agreed.** Mechanically the same pipeline as R20 with looser matching and different suppression. One constraint worth naming: `robots.txt` disallows `/search/`, so the site's own search engine is off-limits and all matching happens locally against feed content. That is fine — it is also faster and it is one less dependency. Section 17.5.
- **R22 — Classifieds in scope for alerts.** **Not achievable as originally stated, superseded by R24, and now achievable in principle but only partially.** Verified by me: there is no classifieds feed at any path (`/classified/feed` → 404), and `/classified` returns OzBargain's own 403 page reading "You do not have permission to access this page" to an anonymous client. The fact-sheet framing of "blocked" is wrong; the correct framing is "members-only". **Settled by your screenshot:** with an account it renders. **But "in scope for alerts" cannot mean all three alert types.** Classifieds listings carry no vote, comment or click counts, so R19 has nothing to compute from and is permanently deals-only. R22 delivers watchlist and keyword coverage (R20, R21) on classifieds, and that is all it can ever deliver. Sections 18.7 and 18.8.
- **R23 — Alerts delivered as notifications.** **Agreed; channel still your call, and it now costs something.** Recommending ntfy behind a one-method interface so the choice is cheap to revisit. Section 20.5. Still OPEN as U4/D13 — and corrected since the last revision: **there is no ntfy on this host**, so this is a container to stand up rather than one to reuse. R26 adds a requirement the channel must meet: it has to carry a control inside the notification (P13), and its topic must not be world-readable (D21).
- **R24 — The bot authenticates with a user account, then searches the classifieds.** **This is the one I am pushing back on hardest, and you should expect that given you asked to be challenged.** I am not refusing it and it is your call to make. But: `robots.txt` explicitly names `/user/login` as disallowed; the classifieds gate exists specifically to keep non-members out because of scams; the owner tunes Cloudflare rules against bots continuously; none of the 102 public OzBargain projects has ever done this, so there is no prior art for the *mechanism* to copy; and the account at risk is your personal one, not a throwaway. There is also a middle path that gets you the classifieds without the app ever touching the login form — you authenticate as a human in your browser and hand the app the resulting session cookie. Critically, `/classified` itself is **not** robots-disallowed; only `/user/login` is. That distinction is what makes the middle path coherent rather than a fudge. **Update: U7 is settled and I am not going to pretend otherwise.** Your screenshot shows `/classified` rendering a full listings page for an authenticated account, so the objection that this was all built on an unproven premise is gone, and I have struck it rather than preserving it to keep my argument tidy. What survives is the part that was always the real objection — the method, not the destination — plus one new objection that your own wording invited: R24 says *"create a user login"*, and the evidence comes from your established account, not a new one. Section 18.2. The full argument and the authentication architecture — for if you say yes — are in section 18.

**R25–R27, from the alert rules. Same style, same honesty.**

- **R25 — A deal alerts once per criterion, never twice for the same criterion, and may alert again on crossing a different one.** **Agreed, and already designed — no new work.** Section 20.1 specifies an alert ledger keyed on `(node_id, rule_id)` in which a rule fires at most once per deal, *ever* — a permanent record rather than a cooldown — and it already states the exact case you raised: a deal legitimately alerts twice when two different rules fire, "once for rising fast, once when promoted". Your "passed 50 votes" example is that same shape with a vote-threshold rule in place of the promotion rule. I arrived at this independently before you asked for it, which is a reasonable sign that it is the natural answer rather than a clever one. **One thing your wording adds that I am adopting:** it makes explicit that criteria must be discrete and individually identifiable, or "crossed into another criteria" is not computable — so a 10-vote threshold and a 50-vote threshold are two rules with two rule IDs, not one rule with a parameter. Closed out in 21.1.
- **R26 — One-click unsubscribe from the rule that fired, from inside the notification.** **Agreed in intent; the mechanism is a real collision with R8 and I am putting it to you rather than resolving it silently.** You are asking for a state-changing action reached from a phone notification, and you have also asked for a JWT on every request and for nothing to be reachable without it. Those are not trivially compatible. I can give you a genuinely one-tap control that costs exactly one documented exception, or a control that costs no exception but is occasionally one tap plus a login bounce. Both are designed, both have their security properties stated plainly, and the choice is **D17**. What I have *not* done is ship the naive answer — an unauthenticated magic link with no scope, no expiry and no single-use limit — because that is precisely the exception R8 exists to forbid, and it would be a link that disables your alerting for anyone who ever obtains it. Section 21.2–21.5. Note also that 17.4 already promised "a one-tap way to mute the term" on every alert; that line was written casually and turns out to have been hiding this entire problem, which is a fair illustration of why the requirement was worth stating.
- **R27 — Every notification carries a "manage alerts" link to the alert manager.** **Agreed, and it is the requirement that most changes the size of this project.** Section 2.1 already promised "a small web UI for managing watchlist terms and seeing what it has done", so the surface was anticipated — but as a convenience, not as a named requirement reachable from every alert. Making it a requirement means it has to exist in v1, it has to be good enough to use on a phone, and it turns the app from a poller with a status page into a small CRUD application with write endpoints, forms, validation and CSRF. **That makes section 7's access-control design load-bearing rather than incidental**, and it materially strengthens the case for a promoted `:stable` tag over auto-deploying `:latest`, because the thing being auto-deployed is now the control panel for your own alerts and the migration runner for the database holding your rules. The link itself is the easy half — it is an ordinary authenticated URL and it needs no exception, unlike R26. Sections 21.7–21.9.

---

## 16. What the research found

You said the expectation is that the designer does the research — goes to the site, looks at what is there, and finds out whether anyone has solved this before — rather than designing from what you said. That was a fair criticism of the last pass. This section is the answer to it.

I made about 60 requests to ozbargain.com.au over roughly 25 minutes, one at a time, spaced 4–6 seconds apart. I read the site's wiki, its terms of use, its robots.txt and four forum threads including two where the site owner answers exactly the questions we were asking. I searched GitHub and found 102 projects in this space and read the source of the most relevant eight.

**The full evidence, with every URL and command output, is in `research.md` in this repository.** This section is the argument; that file is the proof. It is deliberately separate so this document stays readable and so the evidence can be audited without wading through prose.

### 16.1 How I behaved on somebody else's site, and why it is a design input

Three things I deliberately did not do, because how to behave on a third party's production site is itself part of the design and the research should model the application's manners:

- **I did not request `/user/login`.** `robots.txt` disallows it, and it is the exact endpoint whose acceptability is the open question in R24. Probing it in order to advise on whether probing it is acceptable would have been circular.
- **I did not request anything under `/api/`.** Disallowed. A convenient JSON endpoint exists there and a prior-art project uses it. I did not need to fetch it to conclude we should not use it.
- **I did not request anything under `/search/`.** Disallowed, and this has a real consequence for R21 — the site's own search cannot be used, so keyword matching happens locally.

This is the standard the application should hold itself to: stay on permitted paths, go slowly, one request at a time, and do not probe the thing you have been asked not to touch.

### 16.2 The anti-bot boundary, measured rather than assumed

This is where the fact sheet's framing was leading us wrong, and the distinction matters enormously because the two cases demand opposite responses.

**There are two entirely different refusals on this site.**

**Cloudflare blocking a client signature.** Requesting `/deals/feed` with Python's default `Python-urllib/3.x` User-Agent returns **HTTP 403 with a 17-byte body: `error code: 1010`**. No HTML, no OzBargain branding, no session cookie. That is Cloudflare, at the edge, banning a browser signature. The request never reached OzBargain.

**OzBargain's application denying permission.** Requesting `/classified` with a normal Chrome User-Agent returns **HTTP 403 with 1,016 bytes of OzBargain's own styled error page**, loading the site's stylesheets, setting a PHP session cookie, and saying: *"You do not have permission to access this page."* The request reached the application, which considered it and said no.

Both are HTTP 403. Both carry `server: cloudflare`. They are trivially separable by body size and content, and the application **must** separate them, because one means "change how you identify yourself and back off" and the other means "you are not a member" — and confusing the two produces either a pointless retry storm or a silently abandoned feature.

**The block is narrow and surgical, not a general anti-automation posture.** Same URL, varying only the User-Agent:

- `Python-urllib/3.x` (library default) → **403, error code 1010**
- no User-Agent header at all → 200
- `python-requests/2.32.3` → 200
- `Go-http-client/1.1` → 200
- `Wget/1.21.4` → 200
- `curl/8.5.0` → 200
- `GPTBot/1.1` → 200
- Chrome 140 → 200
- `OzBargainHunter/0.1 (+github url)` → **200**

Two things follow. First, **the most common default HTTP client identity in the most likely implementation language is already banned** — a build using Python's `urllib` with defaults would have failed on day one with a 17-byte body and an error code that appears nowhere in the fact sheet. Second, **an honest self-identifying bot User-Agent is not blocked today**, which is the evidence behind D14.

**This corrects F1.** F1 concluded the feed path was clear of Cloudflare obstacles. Broadly true, but there is a live UA ban sitting directly across the most probable implementation choice, and we would have walked into it.

### 16.3 The feed surface is far larger than the fact sheet knew

All of these return 200 with `application/rss+xml`:

`/deals/feed` (New Deals, 30 items) · `/feed` (**Front Page Deals**, 20 items) · `/deals/popular/feed` (Popular, last 30 days) · `/freebies/feed` · `/cat/<slug>/feed` · `/brand/<slug>/feed` · `/product/<slug>/feed` · `/tag/<slug>/feed` · `/live/feed` (an event stream — see 17.3).

**The discovery that matters most: `/feed` is the front-page feed.** The fact sheet recorded it as "a second, distinct feed" of unverified relationship. It is the Front Page — its channel title is literally `OzBargain | Front Page Deals`. You described the trend alert as a deal appearing "on the 'new deals' page as well as the front page". Those are two RSS feeds. Your alert is a set-membership test between them, and that is a great deal more reliable than any heuristic I would have invented.

**F6 is correct in full and it is the foundation of the design.** Every item in both feeds carries `<ozb:meta>` with `votes-pos`, `votes-neg`, `comment-count`, `click-count` and (optionally) `expiry` and `starting`, plus the merchant's own product URL. So yes — a "rising quickly" alert can be built from feed deltas, without touching a deal page. Two caveats I found that the fact sheet did not: `expiry`/`starting` are optional and must be nullable, and **the counters are not monotonic** — I watched a comment count go *down* by 4 between two polls, because comments get deleted. Delta arithmetic that assumes counters only rise will produce negative rates and, unguarded, nonsense alerts.

**Conditional requests work and this is a bigger deal than it sounds.** The feeds send `etag` and `last-modified`, and re-requesting with `If-None-Match`/`If-Modified-Since` returns **304 with zero bytes of body**. A 5-minute poll of an unchanged feed costs OzBargain a 304 instead of serialising and shipping 49 KB. This single mechanism is most of what separates a polite poller from a rude one, and it was not in the fact sheet at all.

### 16.4 There is a sanctioned path, and the site owner spelled it out

This is the most important thing I found, and it is why section 2.2 rejects the word "scraper".

**scotty (site owner), 29/12/2017**, asked directly whether OzBargain has an API:

> "Not really. You can get the data from RSS feed. There are some extra XML elements containing extra data (votes, comments, etc)."

That is the owner pointing developers at the feed *and specifically at the `<ozb:meta>` extras we intend to use*.

**scotty, 24/03/2026**, after a Cloudflare rule caught RSS readers in the crossfire:

> "We decided to block some older Chrome browser versions because bots and script kiddies hard coded them when they scrap OzBargain that causes excessive load. However some RSS apps also identify themselves by those old Chrome versions (and did not provide a way to change that), which then got blocked on CloudFlare as well. **We have now unblocked those old Chrome versions on `*/feed` URLs, i.e. where all our RSS lives**, so hopefully those RSS apps will keep on working."

He weakened his own anti-bot protection, specifically on feed URLs, specifically so that automated clients would keep working. That is about as close to a sanctioned machine-readable path as a site without an API can offer.

**And there is no contractual prohibition.** I pulled OzBargain's Terms of Use and searched the text: zero occurrences of scrape, crawl, robot, spider, harvest, RSS or machine. The only hit for "automat" is about their own ad serving. The wiki's "Guide for Third-Party Site Operators" turns out to be about manual deal-posting etiquette and says nothing about programmatic access.

So the governing signals, in order of authority, are: `robots.txt` (specific and machine-readable), the owner's public statements (unusually clear), and no terms-of-use clause either way.

**What this does not mean.** It does not mean we are safe. F11 is correct and I am not softening it: the owner tunes rules against scrapers continuously, and my own `error code: 1010` result is a live instance of that tuning. The right reading is *the feed is the one surface with a public commitment behind it, and even that commitment is maintained by hand and could change tomorrow.* Design for breakage anyway — section 20.4.

### 16.5 Prior art: 102 projects, and the one thing none of them does

GitHub returns **102 repositories** for "ozbargain", spanning about a decade. This is well-trodden ground and the shape of what you want is clearly viable.

**The most instructive is `eckyecky/ozbargain-ntfy-live-bridge`** (TypeScript/Bun, Docker, ntfy, active March 2026) — almost exactly this project. Four things from its source, three of them warnings:

- It polls `/api/live`, which **`robots.txt` disallows**. A convenient endpoint exists; it is off-limits. We take the same data from permitted feeds.
- It **spoofs `curl/8.5.0`** as its User-Agent rather than identifying itself.
- It **shells out to the `curl` binary instead of using its own runtime's HTTP client**, and its error handling explicitly tests for `"Just a moment..."` — the Cloudflare interstitial. Nobody writes that code speculatively. This is an author who got blocked by client signature and worked around it by delegating to a binary whose signature passes. That is independent corroboration of my 1010 finding, from a different language.
- It has an **`OZBARGAIN_COOKIES`** option — "allow passing the full cookie string … or a fresh one". It contemplates running with a session cookie *handed to it*, not one it obtained by driving a login form. **That distinction is the basis of my R24 recommendation.**

**`TT-RB/OzBargain_Scraper`** (Python, April 2026) uses RSS plus keywords plus Discord, with a per-user 3600-second cooldown and duplicate suppression per deal — direct prior art for section 20.1. Its README also admits *"Upvote scraping is heuristic; changes to OzBargain layout may require updates"* — they parse upvotes out of HTML while `votes-pos` sits in the feed they are already fetching. A concrete example of the cost of not reading the feed properly.

**`harinder83Aus/ozbargain-monitor`** (Flask/PostgreSQL/Docker) is the closest architectural analogue — RSS feeds, search-term management, matching, web dashboard, docker-compose. Confirms the overall shape. Its 6-hour poll is far too slow for R19; you cannot detect a deal rising quickly on a 6-hour interval.

**`Accurate0/ozb`** (Rust, May 2026) and **`jojo-data/ozbargain-tracker`** (Python, September 2026 — the most recently active) are both small, alive, feed-based keyword alerters. The latter parses with `defusedxml` rather than stdlib `ElementTree`; safely parsing untrusted XML is a real concern and we should copy that.

**`Givo29/ozbargain-scraper`** (8 stars) scrapes `/search/node/...` with cheerio — a **robots-disallowed path**. A popular project doing the thing we should not do.

**And the finding you specifically asked for: nobody logs in.** I looked across 102 repository names and descriptions, the file trees and source of the eight most relevant, and targeted web searches for OzBargain plus login/session/authentication/classifieds. **I found no open-source project that authenticates to OzBargain programmatically, and none that touches the classifieds at all.** The closest is that `OZBARGAIN_COOKIES` variable, which is a human-supplied cookie.

That absence is itself a finding. With 102 projects over a decade, classifieds are an obvious thing to want, and nobody has published a way to get them. It is weak evidence but it points one way: either people tried and it did not work well enough to publish, or people looked at a members-only anti-scam section and decided against. **R24 has no proven path and no prior art to copy.**

**One more thing, so nobody suggests it later.** The standard Cloudflare bypass tools — `cloudscraper`, `cfscrape`, `puppeteer-stealth`, `playwright-stealth`, `FlareSolverr` — are now widely reported as obsolete or detected on sight, with `cloudscraper` abandoned and `FlareSolverr` stalled. That closes off "just bypass it" as an *engineering* matter before anyone has to argue it as an ethical one. Adopting one would mean a maintenance dependency on a losing arms race, to do something the owner is actively tuning against, while a protected feed carrying better data sits right there.

### 16.6 Verdict on the fact sheet: F1–F14

You should know which of the handed-down "facts" survived contact. Full detail in `research.md` section 7.

**Confirmed, reproduced myself:** F2 (and extended — the relationship is now known), F4, F5, **F6 in full**, F7, F12, **F13 byte for byte**, F14.

**Confirmed but incomplete in ways that would have hurt:**
- **F1** — feed works as described, but missed the live Cloudflare ban on `Python-urllib`. Would have broken the build on day one.
- **F3** — pagination works and pages do not overlap, both true. Missed that **pagination is zero-indexed**: `?page=1` is the *second* page. A loop over pages 1..N silently skips the 30 newest deals, which is the exact data this app exists to watch.
- **F8** — substance right (no classifieds feed, 403 on `/classified`), framing superseded. "Not obtainable" is wrong; "members-only" is right, and it is a different problem.

**Corrected — the fact sheet is wrong:**
- **F9, three errors.** The live `robots.txt` is 253 bytes and I quoted it in full. There is **no `DataForSeoBot` rule**. There are **no `GPTBot`/`ChatGPT-User`/`CriteoBot` rules and no `Crawl-delay` directive anywhere in the file**. There is **no `Sitemap:` declaration** (the sitemap file exists and returns 200, but robots.txt does not point at it). I verified the file is not varied by client — identical 253 bytes and identical SHA-256 for Chrome, curl, GPTBot and an honest bot UA. **This matters because U3 reasons from the non-existent crawl-delay** to conclude that single-digit-second delays are within tolerance. That inference must be withdrawn; my cadence recommendation in 17.6 is built on different grounds.
  **Update: this has now been independently reproduced.** The orchestrator re-fetched the file three times with different client identities — a Chrome User-Agent, curl's default, and `GPTBot/1.1` — and got identical bytes and the identical SHA-256 I recorded, and `BRIEF.md` now carries the correction. The cause is worth keeping visible because it is a standing rule rather than a one-off: **F9 came from a web-extraction service rather than a direct HTTP request, and the service returned a stale or synthesised copy.** Every other fact in that record came from a direct request and every other fact survived. A fact about a third party's site is only a fact if it was fetched directly. I have checked the rest of this document against the correction and **nothing in it depended on the error** — 17.6 already declines to lean on the phantom crawl-delay and states the alternative grounds, which is the only place the inference could have taken hold.
- **F10** — `/deals?sort=votes` returns 200 but **does not sort**. Identical node ordering to `/deals`; the parameter is ignored. A design that fetched it believing it was getting top-voted deals would get new deals in date order and never notice. The real popularity surface is `/deals/popular/feed`. Also, the forum path is `/forum`, singular, which returns 200.

**Not re-tested:** **F11**, the owner's continuous anti-scraper tuning. I did not re-fetch node 946105, but it is corroborated by his March 2026 statements which I did fetch, and by my own 1010 result. Treat as confirmed.

**F15 and F16, added to the record after my research pass, are of a different kind and I am grading them differently.** Both come from James's screenshot of the authenticated classifieds page. I read the image myself rather than accepting a summary of it, and I agree with both: there are no vote, comment or click counts on a classified row (F15), and there is a "Search classifieds" input on the page (F16). But neither was produced by a request I made, because I hold no OzBargain credentials and must not obtain any. **They are stakeholder-supplied evidence, not FACTs by this document's standard**, and I am labelling them that way for exactly the reason the F9 correction exists: the moment this document starts grading second-hand claims as verified, its labels stop meaning anything. They are entirely sufficient to settle U7 and to design against. Section 18.7 sets out everything I could read off the image and marks which parts are observation and which are inference.

**New facts not in the fact sheet at all:** `/feed` is the Front Page feed · `/product/`, `/brand/`, `/tag/`, `/cat/`, `/deals/popular/`, `/freebies/` all have feeds · `/live/feed` is a per-event stream with a ~23-minute window · conditional GET returns 304 with zero bytes · front-page placement is not derivable from vote counts · counters are not monotonic · the Terms of Use contain no anti-automation clause · scotty deliberately exempted `*/feed` from Cloudflare rules · no product slug exists for a product nobody has posted yet · no prior-art project logs in.

---

## 17. Data acquisition design

Grounded in section 16, not in general scraping advice.

### 17.1 What we fetch, and nothing else

**DECISION — v1 fetches exactly two URLs on a timer:**

- `https://www.ozbargain.com.au/deals/feed` — new deals, 30 items, ~22 hours of history
- `https://www.ozbargain.com.au/feed` — front page deals, 20 items

Plus, on demand and rarely, `/product/<slug>/feed`, `/brand/<slug>/feed` and `/tag/<slug>/feed` for watchlist terms that have a slug (17.4).

**DECISION — paths this application never requests, permanently:** `/api/`, `/ozbapi/`, `/search/`, `/comment/`, `/goto/`, `/privatemsg/`, `/user/login`. Those are the seven `robots.txt` disallows. They are a hard-coded deny list in the HTTP client, not a convention — the point is that a future feature cannot casually reach one of them. Note that `/goto/` is the outbound click-tracking redirect that appears in `ozb:meta/@link`: we display it as a link for you to click in a browser, and the application itself never follows it.

**DECISION — no HTML parsing of ozbargain.com.au in v1.** Everything needed for R19, R20 and R21 is in the feeds. This is the single biggest robustness decision in the document: HTML layout changes without warning and breaks parsers, while the feed is a stable published contract that the owner protects.

### 17.2 The poll

Every 5 minutes (D12), sequentially, never in parallel:

1. `GET /deals/feed` with `If-None-Match`/`If-Modified-Since` from the last response.
2. Wait a few seconds.
3. `GET /feed` with the same.
4. Classify each response (20.3). On 304, there is nothing new in that feed and we move on.
5. Parse with a hardened XML parser — `defusedxml` or equivalent, following `jojo-data`'s lead. This is untrusted input from the internet and stdlib XML parsers have known entity-expansion problems.
6. Upsert each item into the deals table; append a counter observation for each.
7. Evaluate the three rules.
8. Emit alerts that survive de-duplication (20.1).
9. Record a successful-poll timestamp — this is what the dead-man's switch watches.

### 17.3 R19 — turning "suddenly starts to rise very quickly" into something mechanical

You gave no threshold and asked for one. Here it is, with the measurements behind it.

**Signal 1 — front-page promotion. This is the literal thing you described, and it is free.**

You said: *"Possibly this would be a new deal, that suddenly finds itself on the 'new deals' page as well as the front page."* `/deals/feed` is the new-deals page. `/feed` is the front page. So:

> **A deal we have already seen in `/deals/feed` appears in `/feed` for the first time.**

That is a discrete, unambiguous, observable event. No threshold, no tuning, no heuristic.

**A correction to the mental model, though.** I checked whether front-page placement is just a vote threshold. It is not: at one instant I recorded a deal with **9 net votes on the front page** and a deal with **43 net votes, posted inside the same time window, not on it**. Placement is an editorial/algorithmic decision by OzBargain that we can observe but cannot compute. That is good news — we watch for the event rather than trying to predict it, and OzBargain's own judgement about what is interesting comes along for free.

Measured frequency: 20 of 120 deals in a 48.5-hour sample were on the front page — about **10 promotions per day**.

**Signal 2 — velocity, to catch a deal *before* promotion.** Promotion is the confirmation; you also want the early warning. The rule:

> **Alert when a deal is under 6 hours old, has at least 10 net votes, and is running at 5.0 or more net votes per hour since posting.**

Why these numbers, from 120 real deals across 48.5 hours:

- The distribution of net votes per hour is **median 0.79, p75 1.90, p90 4.79, p95 8.56, max 18.04**. A 5.0/hour threshold is approximately the 90th percentile — genuinely unusual, not merely above average.
- **The 10-vote floor exists to kill a specific artefact.** A deal 7 minutes old with a single vote computes to 8.56 votes/hour and lands in the 95th percentile. Velocity is unstable when the denominator is tiny. Without a floor this rule fires on every new deal that gets one sympathy vote. This is the trap in the obvious implementation and it is why a pure rate threshold is wrong.
- The 6-hour age cap keeps it about *new* deals rising, which is what you asked for, rather than an old deal grinding upward.

**Measured alert volume for that rule: 7 of 120 deals, about 3.5 alerts per day.** Two of the seven were not yet on the front page at the time — genuine early warning, which is the point. Deals arrive at about 59 per day, so this fires on roughly the top 6%.

For calibration, alternative settings against the same sample: requiring 15 votes gives ~3.0/day; extending to 12 hours gives ~4.0/day; tightening to 20 votes and 8.0/hour gives ~1.5/day.

**Mark this as a knob you will tune.** All four numbers — max age, minimum votes, minimum rate, and whether promotion alerts separately — are environment variables. My sample was a Saturday afternoon, which is quiet; a weekday evening will run hotter and you may want the threshold higher. Expect to move these in week one. The app should log, for every poll, how close the top few deals came to firing, so you can tune from your own data instead of guessing.

**Why not use vote deltas per poll?** I measured that too, and it does not work well: over an 8.7-minute interval, **24 of 29 deals moved zero votes**. Votes are a low-rate signal and a per-poll delta is reading mostly zeroes. Velocity since posting is the more stable measure. Worth noting that **`click-count` is roughly an order of magnitude more responsive** — one deal took +119 clicks in the same interval it took +0 votes — so if the vote rule proves too slow in practice, clicks are the obvious second input. I have not put clicks in the v1 rule because I have no baseline distribution for them yet and I would rather not invent a threshold I cannot justify. Gathering that baseline is a natural week-two task.

**On `/live/feed`.** There is a third surface — an event stream of individual votes, comments and posts, timestamped to the second. It is tempting for velocity. I am **not** using it in v1 and the reason is a measurement: its 75-item window covered only **23.4 minutes** when I sampled it on a quiet Saturday. It is a *sliding window*, so any poll gap longer than the window loses events permanently and silently. The feed counters are *cumulative*, so a missed poll widens the delta window but loses nothing. That robustness difference is worth more than the extra resolution. Revisit if the trend rule proves too coarse, and if we do, it needs lap detection.

### 17.4 R20 — watchlist match, and why the elegant answer is wrong

Your example is "AMD R9700". The question is whether to match free text or the structured `/product/`, `/brand/` and `/tag/` slugs that the feed carries.

The structured answer is very appealing. Each feed item carries its classification as machine-readable categories, so `/product/amd-radeon-ai-pro-r9700/feed` would be an exact, false-positive-free subscription.

**I tested it, and it does not work as the primary mechanism:**

- `/brand/amd/feed` → 200, exists
- `/tag/graphics-card/feed` → 200, exists
- `/product/amd-radeon-ai-pro-r9700/feed` → **404**
- `/product/amd-r9700/feed` → **404**

**A product slug only comes into existence when somebody posts and tags a deal for that product.** For a product nobody has posted yet, there is no slug — and that is exactly the moment you want to be alerted about. The elegant design requires the thing you are waiting for to have already happened.

**DECISION — text matching is primary; structured slugs are a precision enhancement.**

A watchlist term is stored with:
- **The match text**, normalised: lower-cased, punctuation stripped, runs of whitespace collapsed, so that "AMD R9700", "amd r9700" and "AMD  R-9700" all behave the same. Matching runs over the item title, the description text, and the category *labels*.
- **Optional required-tokens semantics.** "AMD R9700" as a phrase will miss "Radeon AI PRO R9700 by AMD". Default is **all tokens present, in any order, word-boundary matched** — so "amd" and "r9700" both appear somewhere. Word boundaries matter: a naive substring search for "amd" hits "Amderma" and every "AMD-compatible" accessory.
- **An optional slug subscription**, added later. Once a real R9700 deal appears, its `<category>` elements reveal the canonical slug; the UI offers to pin the term to it. From then on, matching is exact and also catches deals whose title does not contain your string.

So the flow is: text match catches the first one; the slug makes every subsequent one precise. You get both, in the order that actually works.

**A caveat worth stating: this will produce false positives and you should expect them.** "AMD R9700" is specific enough to be fine. A term like "Apple" will match constantly. The UI should show a term's recent match count so a too-broad term is obvious before it becomes annoying, and every alert should carry a one-tap way to mute the term.

**That last clause is now requirement R26, and it was a much bigger promise than it looked when I wrote it.** I put it in as an obvious usability nicety. James then independently asked for the same thing in stronger terms — a one-click unsubscribe from inside the notification, with a "manage alerts" link beside it — and designing it properly turned up a direct collision with his own R8. A one-tap mute reached from a phone notification is a state-changing request arriving without a JWT. Section 21 works that out; **D17 is the open decision.** This is a small illustration of a general point worth making once: casual usability sentences in a design document can hide security requirements, and the way to find out is to try to build them.

### 17.5 R21 — keyword match

Mechanically the same pipeline as R20 with two differences.

Your example is "ChatGPT", which is a product nobody will tag as a `/product/` slug in the normal way — it is a subject that turns up in deal titles. So this is the free-text path, permanently.

- **Matching is looser:** any token match rather than all-tokens, case-insensitive, word-boundary anchored, over title + description + category labels.
- **Suppression is tighter,** because a topical keyword recurs far more than a specific product does. Section 20.1.

**A constraint worth naming explicitly:** `robots.txt` disallows `/search/`, so OzBargain's own search engine is off-limits to this application. All matching is local, against feed content we have already fetched. That is not a compromise — it is faster, it adds no requests, and it removes a dependency. But it does mean **we only match against the ~22 hours of deals the feed window covers**, not the whole site history. For an alerting tool that is exactly right; for "has there ever been a ChatGPT deal?" it is not, and that is a search feature we are not building.

### 17.6 Polling cadence, politeness, and the latency you are buying

Stated honestly, because it is a genuine limit and not a detail:

> **A trend cannot be detected at a resolution finer than the poll interval.** At a 5-minute poll, a deal that goes from nothing to front-page in 90 seconds is seen 5 minutes later at the earliest. Every alert carries up to one poll interval of latency, and every rate we compute is an average over an interval we did not observe the inside of.

This is inherent. The only way to reduce it is to poll more often, which costs OzBargain more requests. That is the entire trade and you should set the dial knowingly.

**DECISION — 5 minutes.** The arithmetic: two feeds, every 5 minutes, is 576 requests per day. Nearly all return **304 with a zero-byte body**, because the feeds serve `etag` and `last-modified` and we send conditional requests. On a quiet night the whole application's daily footprint is a few hundred 304s.

Set against real behaviour: front-page promotions happen about 10 times a day, so a 5-minute poll catches each within 5 minutes and is nowhere near being flooded. Vote velocity is computed since posting rather than per-poll, so it does not degrade at this interval.

**What I explicitly did not do — and a correction.** U3 in `BRIEF.md` reasons that a polite rate can be inferred from the `Crawl-delay: 5` that `robots.txt` supposedly sets for GPTBot. **There is no `Crawl-delay` directive anywhere in `robots.txt`** (16.6). That inference is withdrawn. The 5-minute figure is instead justified by: no published crawl-delay exists, so we choose conservatively; conditional requests make the marginal cost near zero; it comfortably beats the ~10/day event rate we need to catch; and it is 5× slower than the prior-art project that polls every 60 seconds.

**I would not go below 2 minutes**, and if you ever want faster, the right answer is not a shorter interval but `/live/feed` with lap detection.

---

## 18. The classifieds, and the decision I need you to make (R22, R24)

This is the most consequential judgement in the project. I am putting it to you rather than designing around it silently, and I am going to argue against part of it, because you asked to be challenged and this is where the challenge earns its keep.

### 18.1 What is verified

**Settled since the last revision of this document, and it is the largest single change in this pass.**

- **EVIDENCE (stakeholder-supplied) — an authenticated account does unlock `/classified`. U7 is resolved, positively.** You logged in with your own browser and supplied a screenshot: the address bar reads `ozbargain.com.au/classified` and below it is a populated listings column, not the 403. I opened the image and read it myself rather than working from a summary of it.
  **I am labelling this EVIDENCE and not FACT, deliberately.** This document's standing rule — reinforced by the F9 correction in 16.6 — is that a claim about a third party's site is only a FACT if I fetched it directly. I did not fetch this and I cannot: I hold no OzBargain credentials and must not obtain any. It is your observation, reported by you. **That is entirely sufficient to settle the requirement**, and I am treating it as settled; it is simply not the same class of evidence as the 403 I reproduced myself, and the labels in this document stop being worth anything the moment I blur that. What the page contains is set out in 18.7.

- **There is no classifieds feed.** `/classified/feed` → 404, and every plural variant → 404. The RSS route that makes the rest of this project clean simply does not exist here. **This is unchanged by U7 and it is the reason classifieds cost real work even now that access is proven:** everything else in this design reads a published, structured, owner-protected feed, and this one surface is HTML that has to be parsed.
- **`/classified` returns OzBargain's own 403 page to an anonymous client**, styled, with a PHP session cookie, reading *"You do not have permission to access this page."* This is the application denying permission, **not** a Cloudflare challenge. F13 confirmed byte for byte. Your reading of this — that it is an authorised-only section — is correct, and your screenshot has now confirmed the other half of it: authenticate and the denial goes away.
- **`robots.txt` disallows `/user/login`.** It is named alongside `/privatemsg/` and `/search/`. This is the site telling automated clients not to drive its login form, and it predates this project.
- **`/classified` itself is NOT disallowed by `robots.txt`.** Only the login endpoint is. **This distinction is the hinge of the whole section** and I will come back to it.
- **The gate exists specifically to keep non-members out, because of scams.** Moderator *moocher*, 12/02/2019: *"we will not be bringing it back as it is a public page, and we no longer want to expose classifieds to non-members due to incidents of scams."* And the next day, diagnosing a user's 403: *"Were you accessing the section from a guest session (i.e. not logged in)?"*
- **No prior art.** None of the 102 public OzBargain projects logs in, and none touches classifieds (16.5).
- **No terms-of-use prohibition.** OzBargain's ToS has no anti-automation clause at all (16.4). So automating the login would breach `robots.txt` but would not breach any stated term. I want that stated accurately rather than dramatised in either direction.

### 18.2 U7 is settled — and here is exactly what it did and did not settle

This subsection previously said that nobody had demonstrated an account unlocks `/classified`, and that everything below rested on an unproven assumption. **That is no longer true and I have rewritten it rather than hedging around it.** The assumption has been demonstrated. Good.

**What is settled.** An OzBargain account renders the classifieds section. The gate is a membership check, not something stranger — not a per-user grant by a moderator, not an invitation, not a paid tier. My earlier worry that "viewing may carry a requirement nobody has written down" is answered for practical purposes: whatever requirement exists, your account meets it.

**What is NOT settled, and one piece of it is sharper than anything I had before.**

- **The evidence covers an *established* account. It does not cover a *new* one — and R24 as you wrote it asks for a new one.** Your exact words were *"we will likely need to create a user login for this"*. The account that produced the screenshot is yours, with history. OzBargain's own published classifieds guidelines gate participation on **membership older than one year**, with — in their words — *"NO exceptions to this requirement"*. Those published rules are about **posting**, and nothing says viewing is gated the same way, so I am not claiming a fresh account would be refused. **But nobody has shown that it would be admitted, either, and that is precisely the gap your screenshot does not close.** The practical consequence is specific: **if the plan involves a dedicated bot account, the evidence supporting the plan does not cover the account the plan would use.** This is a new argument and it cuts against Option C in 18.4 and only against Option C — Option B runs on the account the evidence actually covers, which is yours. Testing it would mean creating an account, which is not free and not obviously appropriate, so I would rather it be a reason to prefer Option B than a probe.
- **The markup is unknown.** 18.7 is read off a rendered screenshot. A parser has to be written against HTML, and a picture of a page is not HTML. P11 captures it.
- **Does the classifieds search route through `/search/`? (U11)** If it does, the most efficient way to answer a watchlist term sits on the robots-disallowed list, and 18.8 has to change. P11 settles it in one submit.
- **What is above the fold? (U12)** The screenshot begins at the search box, so any tabs, type filters or category filters above that line are invisible. P11.
- **How long does a session last?** OzBargain's `PHPSESSID` carries a 90-day `Max-Age`, but that is the cookie's lifetime, not the server's session lifetime. This is Option B's only real running cost and the only way to learn it is to run it.

### 18.3 My honest assessment of R24 as written

You wrote: *"classified is a authorised only section, so we will likely need to create a user login for this. The bot will need to authenticate, then search that section."*

The diagnosis is right — and your screenshot has now proved the diagnosis right, which it was not able to do before. The proposed remedy is still where I push back. **Your evidence weakened exactly one of my four objections and left the other three untouched, and it produced a fifth.** I am marking which is which rather than restating the same four as though nothing had happened:

1. **`robots.txt` names `/user/login` as disallowed.** That is the clearest, most specific signal this site gives about automated access, it is machine-readable, and it predates us. Everywhere else this design leans on `robots.txt` as the authority for what is permitted — sections 16.1, 17.1 and 17.5 all defer to it, and 17.5 gives up site search because of it. We do not get to treat it as binding where convenient and advisory where inconvenient.

2. **The gate's stated purpose is to keep exactly this out.** Classifieds are hidden from non-members because of scams. An automated client harvesting that section is close to the thing the gate was built to prevent. This is different in kind from the deals side, where the owner *deliberately protected* automated access.

3. **The account at risk is your personal one (U9).** Not a throwaway. If automated access is detected, plausible outcomes run from a Cloudflare challenge on the session through to suspension. Nobody has published a case of exactly this, so the probability is genuinely unknown — but the asset is a real account with real history, and 18.1 establishes that the section is tied to membership standing. Losing it costs more than the feature is worth.

4. **There is no proven path and no prior art. — PARTLY DISSOLVED, and I am saying so plainly rather than preserving it because it suited my argument.** The strongest form of this objection was that nobody had shown the destination was even reachable, so the whole workstream might be effort spent toward nothing. **Your screenshot killed that, and it was the single best reason to do nothing at all.** What survives is narrower and still real: with 102 projects over a decade, **nobody has published a programmatic OzBargain login**, so while the destination is now proven, the *mechanism* still has no prior art to copy. You would be doing original work against a login form behind Cloudflare, maintained by an owner who tunes rules against bots continuously. Original work against a moving target is a maintenance commitment rather than a build, and that part of the objection is unchanged.

5. **NEW — R24's own wording asks for an account the evidence does not cover.** You wrote *"create a user login for this"*. The screenshot came from your established account. OzBargain's published classifieds rules gate participation on membership older than one year with "NO exceptions", and while those rules are written about posting rather than viewing, **nobody has demonstrated what a newly created account sees at `/classified`.** A plan that provisions a fresh account for the bot is a plan whose central premise is, once again, unproven — just one step further along than it was this morning. Full argument in 18.2. This objection applies to Option C specifically and not to Option B.

**None of that is a refusal.** It is your site account, your risk and your call. But you asked not to be told "yes sir, three bags full", and a design that quietly implemented an automated login against an explicit `robots.txt` disallow would be exactly that.

**And note what did not move.** Objections 1, 2 and 3 are entirely untouched by U7 being settled, because **a screenshot of the destination says nothing whatever about the method.** `robots.txt` still names `/user/login`; the gate still exists specifically to keep non-members out because of scams; the account still belongs to you and not to a throwaway. Objection 1 was always the core of this section and it is exactly as strong today as it was yesterday.

### 18.4 Three options — D10

**Option A — do not do classifieds. Ship the deals side.**
R19, R20 and R21 all work today on explicitly-protected feeds with no account, no credential and no policy question. This is most of the value of the product. **The honest wording has changed since your screenshot: R22 is no longer "not available via a sanctioned route", it is "available, and you chose not to take it".** That is a weaker position for this option than it held yesterday and I am not going to dress it up.
*Cost:* you do not get the thing you asked for. **But price that cost accurately, because it is smaller than it looked.** With R19 permanently inapplicable to classifieds (18.8), what you forgo is watchlist and keyword coverage on one extra surface — not a third of the product, more like an extension of two rules to a second source.
*Risk:* none.

**Option B (recommended) — you authenticate as a human; the app only reads.**

This is the middle path and it turns on the distinction in 18.1: **`/user/login` is robots-disallowed; `/classified` is not.**

You log in to OzBargain in your own browser, as a human, the way you already do. You copy the resulting session cookie out of your browser and paste it into the app's settings once. The application then requests `/classified` — a permitted path — with that cookie, at the same polite cadence as everything else. **The application never touches the login form, never holds your password, and never drives an endpoint `robots.txt` names.**

Why I like this:
- It respects the one clear instruction the site gives, precisely and not approximately.
- There is no password anywhere in the system. This matters given section 7.6: Unraid template variables are plaintext XML on the flash drive and in every flash backup. A session cookie is bad to leak; a password is much worse.
- There is prior art for the shape — `eckyecky`'s `OZBARGAIN_COOKIES` does exactly this.
- It is honest about what it is. A human authenticated; a tool the human runs then reads a page that human is entitled to read.

- **And now: the destination is confirmed.** Before your screenshot, Option B carried two unknowns — whether the page would render at all, and how long the session would last. **The first is gone.** The account that produced the screenshot is the same account whose cookie the app would hold, so this option is running on the exact configuration that has been demonstrated to work. That is a meaningfully better position than Option C, which would run on an account nobody has tested (18.2).

*Cost:* the session expires and you re-paste the cookie periodically. How often is unknown — OzBargain's `PHPSESSID` is sent with a **90-day** `Max-Age`, which is promising but is the cookie's lifetime, not necessarily the server's session lifetime. Could be weeks, could be less. The app must detect expiry and ask you, clearly, rather than failing silently — and with R27 there is now an obvious place for it to ask, which is the alert manager (21.7).
*Risk:* low but not zero. Automated requests still originate from your account. The mitigation is behavioural — a slow cadence, an honest User-Agent, one section, no crawling outward — and that is designed in 18.5.

**Option C — the app performs the login itself, as you described.**
*Cost:* materially more engineering (18.5), plus a stored password.
*Risk:* the highest of the three, and it is the option that breaches `robots.txt`. **It also now carries the one risk your screenshot created rather than removed:** if Option C runs on a dedicated bot account rather than yours, it runs on an account nobody has demonstrated can see the section at all (18.2, objection 5 in 18.3). If it runs on *your* account, then it is Option B with a password added and an extra `robots.txt` breach, which is a strictly worse trade for the same result.
*My position:* I do not recommend it, and I recommend it slightly less than I did this morning. If you direct it, I will design and build it — it is your account and your call — and 18.5 covers what it actually takes, so the choice is informed rather than theoretical.

**My recommendation: Option B. U7 is settled, so there is nothing left to wait for — this is answerable now.**

My position has firmed up rather than changed, and it is worth being precise about why, because the evidence moved and the recommendation did not. The screenshot removed the one objection that pointed toward Option A, so **Option A is weaker.** It left objections 1, 2 and 3 exactly where they were, so **Option C is no better.** And it demonstrated the section rendering for your established account specifically, which is the configuration Option B uses and the configuration Option C would abandon — so **Option B is stronger, and it is the only option the new evidence actively supports.** If you want Option C anyway, say so and I will build it, but I want your "yes" on the record knowing the five objections in 18.3.

### 18.5 If we proceed — the authentication architecture

Covering Option C properly, since that is what was asked for. Option B is a strict subset: everything below about session storage, expiry detection and failure surfacing applies to it too; only the login mechanics drop away.

**One consequence that applies to both B and C, and that I should have stated more loudly before: classifieds break the single most robust decision in this document.** Section 2.2 and 17.1 commit the application to consuming feeds and making **no HTML requests to ozbargain.com.au in v1**, on the grounds that HTML layout changes without warning while the feed is a published contract the owner actively protects. **There is no classifieds feed, so any classifieds support necessarily means parsing HTML.** That is not a reason to refuse it, but it is a reason to build it as a walled-off module:

- **The classifieds parser lives behind its own interface and its own failure state.** If the layout changes and parsing breaks, the deals side — which is the robust, feed-based, owner-sanctioned 90% of the product — keeps running untouched, and the UI says classifieds acquisition is broken. This is the same "degrade rather than die" principle as 20.4, applied at a module boundary rather than a feed boundary.
- **Expect this parser to break, and not on OzBargain's schedule.** 18.7 lists one hazard visible in the screenshot alone: several listings appear to be pinned, so "newest first" cannot be assumed. Layout assumptions that are true today are exactly what F11 warns about.
- **Treat classifieds parse failures as a normal, non-urgent state, not an alert storm.** A broken parser should notify once, set a visible status, and stop — the same discipline as the session-expiry handling below.

**Performing the login.** OzBargain runs on Drupal, and its forms carry a CSRF token — I verified this on the site-wide search form, which is a `POST` to `/search/node` with a hidden `edit[form_token]` field. The login form will follow the same pattern. So a login is not one request but a sequence: `GET` the login page to obtain the form token and initial session cookie, then `POST` credentials plus that token, then follow the redirect and capture the authenticated session cookie. Cloudflare sits in front of the login endpoint as it does everything else, so a challenge can appear at any step. If it does, an HTTP client cannot proceed and the only route is a real browser engine — which means a headless Chromium in the container, which roughly triples the image size and adds a large, fast-moving dependency. **Whether a challenge actually appears on this endpoint is unverified, because I deliberately did not probe it (16.1).** That unknown is the largest single source of variance in the cost of Option C.

**Detecting session state — this part is pleasingly cheap.** While reading the `/live` page I noticed OzBargain embeds this in every page:

```
OzB_vars={"site_name":"OzBargain","ga_uacct":"G-VTWXKF7VP6","uid":0,...}
```

**`uid` is the logged-in user ID, and it is `0` when anonymous.** So session validity is a single unambiguous check on any ordinary page: `uid == 0` means we are logged out. No guessing from page titles, no heuristics.

That gives three distinguishable states, which must never be conflated:

- **Session valid** — `/classified` returns 200 and `uid != 0`. Proceed.
- **Session expired** — `/classified` returns the 1,016-byte OzBargain 403 page, or a page shows `uid == 0`. *Response:* stop polling classifieds, raise a **visible** alert asking for a fresh cookie (Option B) or attempting one re-login (Option C). **Never retry in a loop** — repeated failed logins are exactly the pattern that gets an account flagged.
- **Cloudflare block** — the 17-byte `error code: 1010`, or an HTML body containing `"Just a moment..."`, or a 503 challenge page. *Response:* back off hard, stop **all** OzBargain requests including the deals feeds, alert. This is the serious one, because it may indicate we have been noticed.

**Where the credential lives.** Section 7.6 established that Unraid user-template variables are plaintext XML on the flash drive and in every flash backup, with `Mask="true"` hiding them in the GUI only. So:

**DECISION — the OzBargain credential is never an Unraid template variable.** Instead: a file at `/mnt/user/appdata/ozbargain-hunter/secrets/ozb.json`, mode `0600`, on the array rather than the flash drive, bind-mounted read-only into the container. It holds the session cookie (Option B) or the credential (Option C). It is in `.gitignore` and it is never logged, never rendered in the UI, and redacted from any diagnostic output. Under Option B this file holds only a cookie, which is the main reason I prefer Option B.

**Behaviour, if we read classifieds at all.** Poll `/classified` **at most once every 15 minutes** — classified ads do not move at deal speed and there is no reason to be quick. One page only; do not crawl outward into individual listings, user profiles or private messaging. Same honest User-Agent, same conditional requests, same backoff. If the deals-side acquisition is in a backoff state, classifieds polling stops too.

### 18.6 The next cheap human step, now that the gate is open

**Done.** This subsection used to ask you to open `/classified` in your logged-in browser. You did, and the answer was listings. Nothing in this section is waiting on that any more, and D10 is answerable today.

**What is worth doing next is the same shape — a browser, a few minutes, no automation, and no agent ever holding your credentials.** This is P11 in section 11, and it exists because 18.7 below is read off a *picture* of a page and a parser has to be written against *markup*. Four things, in the order that makes them easy:

1. **Save the page.** With `/classified` open and logged in: "Save Page As → Web Page, HTML Only", or open developer tools, right-click the `<html>` element and "Copy outerHTML". Either gives a parser something real to be written against. **This is the one that actually unblocks work.**
2. **Type anything into "Search classifieds" and submit it, then tell me the URL you land on.** This settles U11 in one action. If the URL contains `/search/`, then the fast path for watchlist matching is on the robots-disallowed list, the application cannot use it, and 18.8's matching design stands as written. If it is something else — a query string on `/classified`, say — then a watchlist term could potentially be answered with one targeted request instead of fetching and scanning the whole listing page, which would cut this feature's request volume substantially. **Worth knowing either way, and it is one keystroke and one screenshot.**
3. **Scroll to the very top and say what is above the search box.** Tabs, listing-type filters, category filters, a sort control — the screenshot is cropped just above the search input so none of it is visible (U12). Whatever is there changes how much of the page has to be fetched.
4. **From developer tools → Application → Cookies, note the `PHPSESSID` value and its expiry.** That is Option B's credential and its only real unknown. Do not paste the value into this repository or into chat — it is a live session.

**Privacy, and it applies to all four.** That page carries other members' usernames, and your screenshot was deliberately kept out of the repository for that reason. Anything captured in step 1 stays out of git too; if it is needed as a parser fixture later, it gets a scrubbed cut-down version with usernames replaced, not the original.

### 18.7 What the classifieds page actually contains

Read off your screenshot. **Observation and inference are marked separately**, because a rendered image is good evidence for what is on a page and poor evidence for how it is structured underneath.

**Observed — the page furniture, above the listings:**

- A **"Search classifieds"** text input with a magnifier button, at the top of the listing column. This is F16.
- A **"Show expired and inactive listings"** checkbox, unchecked in your screenshot. So listings carry a live/expired state and the default view already excludes dead ones — which is convenient, because 20.1 has a decision that we never alert on an expired item, and the site's default view is doing that filtering for us.
- A **"+ New Listing"** button. Not interesting to us except as a reminder that this is a page with write actions on it, which is a reason to fetch exactly one URL and never follow anything.

**Observed — the anatomy of a listing row.** Each row is two lines:

- A small square **poster avatar**.
- A small **pin/thumbtack glyph**, present on every visible row.
- A **listing-type badge**. Two values observed: **`Wanted`** (seven rows) and **`Freebie`** (one row).
- A **bracketed category tag**. Three values observed: **`[Code Request & Giveaway]`**, **`[Code Giveaway Megathread]`**, **`[Perks]`**.
- A **title**, which contains the item and — where there is one — the price, rendered in a contrasting colour inside the title rather than in a separate column.
- A **trailing `@ <location or merchant>`**: `@ MyMaccas App`, `@ JB Hi-Fi`, `@ Google Store Australia`, `@ IKEA`, `@ The Good Guys`.
- A second line reading **`Posted by <username> on DD/MM/YYYY - HH:MM`**.

**Observed — three details that matter more than they look:**

- **Classified listings are `/node/<id>` URLs, the same namespace as deals.** The browser's status bar in your screenshot reads `https://www.ozbargain.com.au/node/751807` while a listing row is under the cursor. **This is the most useful single thing in the image**, and I will come back to it in 18.8.
- **`@ merchant` is part of the title string, not a separate field.** Two rows prove it by being cut off mid-phrase — one ends `@ JB Hi-Fi (` and another ends `Contact Lenses Online) @` with nothing after it. A parser must not expect `@` to be a reliable delimiter, and must not assume the displayed title is complete.
- **The timestamp is `DD/MM/YYYY - HH:MM` with no timezone marker.** Day-first is confirmed by the image itself — `18/`, `22/` and `30/` all appear in the first position. Compare the deal feed, which gives RFC-822 with an explicit `+1000`. So classifieds times must be interpreted as site-local and **will be ambiguous for one hour each year when daylight saving ends**. Minor, real, and the kind of thing that produces one baffling bug in April.

**Observed — what is NOT on a listing row: any number at all.** No votes, no comment count, no click count, no age-relative label. The only numeral on a row is the price inside the title and the date. This is F15 and it is the subject of 18.8.

**Inference, marked as such:**

- **The pin glyph most likely marks pinned or sticky rows, and the visible block is probably the pinned set.** The evidence is that every visible row carries it *and* the dates run 18/09/2026, 16/09/2026, 16/09/2026, 07/09/2026, 07/09/2026, 30/08/2026, **18/01/2023**, **22/07/2021** — a three-year-old megathread sitting among last week's listings is not a recency ordering. I am not certain; the glyph could be a generic listing marker. **Either way the design consequence is the same and it is not optional: do not assume the classifieds page is ordered newest-first, and expect a small set of ancient rows to be present on every single fetch, forever.** Without the alert ledger from 20.1 this would notify you about a 2021 megathread on every poll, and without silent cold-start seeding (D15) it would do so loudly on first run. Both are already designed; this is a good demonstration that they were worth designing.
- **`Wanted` and `Freebie` are probably two values of a small closed set**, with things like "For Sale" and "Swap" presumably also existing. Not visible in the screenshot, and P11 step 3 would show them.

**What is not usable from this page.** The right-hand rail is the live deals sidebar, showing `+3`, `+15`, `+4`, `+8` with comment counts and relative ages. **Ignore it entirely.** It is the same data the deals feed already gives us in structured form, and parsing it would mean taking a dependency on a layout for information we already have properly.

### 18.8 Which alert rules can actually apply to classifieds — and the answer is not all of them

This follows directly from F15 and it is the consequence I most want stated plainly, because the brief's R22 says "classifieds in scope for alerts" as though alerts were one uniform thing.

**The trend alert (R19) cannot apply to classifieds. Not "is hard to", not "is deferred" — cannot.**

R19 is computed entirely from `<ozb:meta>`: `votes-pos`, `votes-neg`, `comment-count` and `click-count`, sampled over time and differenced (17.3, 19.1). **A classified row carries none of those, and neither does any page I have evidence of.** There is no counter to sample, so there is no delta to compute, so there is no velocity and no threshold to cross. Front-page promotion is equally inapplicable: the front page is a deals feed and classifieds do not appear on it. **No amount of engineering changes this, because the data does not exist to be engineered with.**

**DECISION — R19 is a deals-only rule, permanently. R20 and R21 are the only rules that span both surfaces.** Anywhere this document lists "three alert types" without qualification, this is the qualification.

**What matching against a classified actually runs over.** The listing page gives a title, a category tag, a type badge and a poster. It does not give a description — that lives on the individual listing page, which we are not fetching (18.5: one page, never crawl outward). So:

**DECISION — classifieds matching runs over the title, the bracketed category tag and the type badge, and nothing else.** That is a narrower matching surface than deals, where 17.4 matches over title, description *and* structured category labels. Two practical consequences: a term that only appears in a listing's body will be missed, and there are no `/product/`, `/brand/` or `/tag/` slugs here at all, so the slug-based precision enhancement in 17.4 has no classifieds counterpart. **Classifieds matching is text-only, and slightly blunter than deals matching. Say it now rather than let it look like a bug later.**

**The node-ID finding pays off here, and it is worth spelling out.** Because classified listings are `/node/<id>` URLs in the same namespace as deals, **the alert ledger keyed on `(node_id, rule_id)` from 20.1 spans both surfaces with no change and no collision risk.** There is no need for a composite key, no need for a surface discriminator in the ledger, and no possibility of a classified and a deal colliding on an ID. R25's "once per deal per criterion" therefore becomes "once per *node* per criterion" and covers classifieds for free. That is a genuinely lucky structural fact and it came out of the browser status bar in the corner of your screenshot.

**One thing that follows for the UI (R27).** Since R19 does not apply to classifieds and R20/R21 do, a rule needs a **surfaces** setting — deals, classifieds, or both — and the alert manager has to show it, defaulting to both for watchlist and keyword rules and to deals-only, non-editable, for trend rules. Folded into 21.7.

---

## 19. State — what the application must remember

New, and load-bearing. A delta cannot be computed without a previous value, so "what do we remember, and what happens when we forget" is a first-class design question rather than an implementation detail.

### 19.1 What must be remembered between polls

- **Per deal:** node ID (the natural key, stable and integer), title, URL, author, posted timestamp, categories, merchant URL, expiry, and the timestamp we first saw it.
- **Per deal, per poll:** an observation of `votes-pos`, `votes-neg`, `comment-count`, `click-count` with the time we observed it. **This is the only reason trend detection is possible at all.** Without a history there is no delta.
- **Front-page state:** whether the node has ever appeared in `/feed`, and **the time we first saw it there**. The feed's `pubDate` is the *original posting* time in both feeds — I checked all 20 overlapping items and they are identical — so OzBargain does not tell us when a deal was promoted. We only know it because we watched. If we forget, we can never recover it.
- **Watchlist and keyword terms,** with their matching options, optional pinned slug, **enabled/disabled state, snooze-until timestamp, per-term cooldown, and which surfaces they apply to (18.8)**.
- **The alert ledger:** which (node, rule) pairs have already fired, and when. This is what stops the same deal alerting six polls running. **Note this key works unchanged for classifieds, because classified listings share the `/node/<id>` namespace with deals (18.7).**
- **Per feed:** the last `ETag` and `Last-Modified`, so conditional requests work.
- **The last successful poll time,** which the dead-man's switch watches.

**Added by R25–R27. These are new and they are not incidental.**

- **Rule configuration itself** — the trend thresholds from D11, per-term cooldowns, enabled state. These move out of environment variables and into the database, because R27 means they are edited through a UI rather than by recreating a container (D19). Operational configuration — feed URLs, User-Agent, poll interval, notification endpoint — deliberately stays in environment variables, for the emergency-fix reason in 20.4.
- **Unsubscribe tokens, if D17 goes to Mechanism B** — one row per issued token, holding a **hash** of the token rather than the token itself, the rule it is scoped to, its expiry, and whether it has been consumed. Storing the hash rather than the value means a leaked database does not hand over live capabilities; it is the same reasoning as never storing a password in plaintext, applied to something that is functionally a single-purpose password. Under Mechanism A this table does not exist at all, which is one of the arguments for Mechanism A.
- **An audit line per state change** — which rule was muted or re-enabled, when, and by which route (the authenticated UI, or a notification control). This is what makes an accidental mute diagnosable rather than mysterious, and under Mechanism B it is **the only** audit trail that exists, because Cloudflare's documentation states that requests under a Bypass policy are not logged (P14). If you take Mechanism B, this stops being a nicety.
- **A queue of computed-but-unsent alerts,** so that muting a rule can suppress its pending alerts as R26 requires rather than only its future ones (21.5).

### 19.2 Counter history is bounded, deliberately

Storing every observation of every deal forever would grow without limit for no benefit. Deals stop being interesting once they are old — the trend rule only looks at deals under 6 hours old.

**DECISION — keep counter observations for 7 days, then delete them. Keep the deal row itself indefinitely** (it is small, and it is what makes "have I already alerted on this?" work across a repost). A nightly tidy job does the deletion. At ~59 deals/day and a 5-minute poll, seven days of observations is on the order of a few hundred thousand small rows — nothing for SQLite.

### 19.3 Restart, cold start, and missed polls

**On restart with an existing database:** nothing special happens. State is on the bind mount and survives container recreation (section 6.5). The next poll computes deltas against the last stored observation; the gap is simply wider. The alert ledger prevents re-alerting on anything already notified. **This is the payoff for using cumulative counters instead of `/live/feed`** — a restart costs resolution, not data.

**On a cold start with an empty database — this is the one that will bite if we get it wrong.** The feeds hand us 30 deals from the last 22 hours, several of which will satisfy the trend rule, and every watchlist term will match everything it was ever going to match.

**DECISION (D15) — seed silently.** On the first poll against an empty database, write everything to the database, mark every (node, rule) pair that *would* have fired as already-alerted, and **send zero notifications**. Log a clear line saying that N deals were seeded and M alerts suppressed. Your first launch is quiet, and the first real alert you get is a real one.

This also covers the disaster case: if the database is lost, the app re-seeds and goes quiet rather than firing 120 historical notifications at 3am.

**On a missed poll** — container down, host rebooted, network out, or we were in backoff:
- **Counters:** fine. Cumulative. The next poll computes a delta over a longer interval and we know exactly how long because observations are timestamped. Velocity stays correct.
- **Front-page promotions:** mostly fine. Membership persists in `/feed` for many hours, so a gap of minutes or a few hours still catches the promotion — it just timestamps it late. A gap longer than the front-page feed's window (about 19 hours in my sample) can miss a promotion entirely.
- **New deals:** safe for gaps under ~22 hours, which is the `/deals/feed` window. Longer than that and deals were posted and expired without us ever seeing them. **DECISION — if the gap since the last successful poll exceeds 12 hours, fetch `/deals/feed?page=1` as well** to reach back roughly two days, and log that we did. Remember that pagination is zero-indexed (16.6), so `?page=1` is genuinely the *second* page.
- **`/live/feed` events:** would be lost permanently. Another reason it is not in v1.

**DECISION — after any gap longer than 2 hours, suppress the trend rule for one poll cycle** and let it resume on the following poll. A single observation after a long gap produces a delta over an unrepresentative window; better to re-baseline than to fire a burst of stale alerts on the way back up. Watchlist and keyword matching still run, because "this deal matches your term" is true regardless of how long we were away.

### 19.4 Storage

**DECISION — SQLite, one file, on the existing bind mount at `/mnt/user/appdata/ozbargain-hunter/` → `/data` in the container.**

Reasons: the workload is one writer, a few hundred small rows a day and simple queries — the weakest possible case for a database server. It needs no extra container, no second thing to back up, no network dependency, no credential. It is a single file, so backup is a file copy and restore is a file copy. It survives container recreation because it is on a mapped volume, which is precisely the requirement section 6.5 set. And `Accurate0/ozb` uses the same approach for the same job.

**DECISION — enable WAL mode**, so the web UI reading does not block the poll loop writing.

**DECISION — schema migrations from version 1.** Not ceremony: this schema will change as the trend rule is tuned, and the alternative is losing the counter history that makes trend detection work. `harinder83Aus/ozbargain-monitor` carries four migrations for exactly this reason.

**The mount target is now decided**, closing the open item left in section 6.5: `/mnt/user/appdata/ozbargain-hunter/` → `/data`, matching the `ForcedEnglishSubs` precedent.

---

## 20. Alerting behaviour, politeness, and failing loudly

### 20.1 De-duplication and suppression

Two distinct problems, often conflated, with different fixes.

**Problem 1 — one deal alerting on six consecutive polls.** A deal that is rising will satisfy the trend rule on every poll for hours.

**DECISION — an alert ledger keyed on (node_id, rule_id), and a rule fires at most once per deal, ever.** Not a cooldown — a permanent record. The trend rule and the front-page rule are *different* rule IDs, so a deal can legitimately alert twice: once for rising fast, once when promoted. That is useful rather than noisy, and it is the natural narrative of a deal taking off. A watchlist term and a keyword term are also separate rule IDs, so a deal matching both tells you both — though see the grouping decision below.

**This is R25, and it was already here before R25 was asked for. Closed out in 21.1, not redesigned.**

**Problem 2 — a watchlist term alerting on every repost.** OzBargain deals recur constantly: the same Steam freebie, the same Amazon price, reposted weekly. Matching on text means every repost is a new node ID, so the ledger above does not help — it is genuinely a different deal.

**DECISION — a per-term cooldown, default 24 hours, plus a repost check.** After a term fires, it will not fire again for 24 hours regardless of how many matching deals appear. Additionally, if a new deal's normalised title is very close to one already alerted on for that term within the last 30 days, suppress it as a repost and note it in the UI rather than notifying. Prior art supports the shape — `TT-RB/OzBargain_Scraper` uses a 3600-second per-user cooldown for the same reason — and I have set it longer because a watchlist term is a standing interest rather than a live feed.

**DECISION — cooldown is per term, configurable per term.** "ChatGPT" (R21) is a busy topic and may want 48 hours; "AMD R9700" (R20) is rare and you would want every single one, so it might be set to zero. A single global number cannot serve both, and getting this wrong in either direction is how people end up muting the whole tool.

**DECISION — group alerts within a poll.** If one poll produces five alerts, send one notification listing five deals, not five notifications. This is the difference between a useful tool and one you silence.

**REVISED by R26 — the grouping unit is (rule, poll), not the poll alone.** R26 requires every notification to carry a one-click unsubscribe from *the rule that fired*. A notification covering three different rules has no unambiguous target for that button, and a button that unsubscribes from the wrong rule is worse than no button at all — it silently stops alerts you wanted and you find out weeks later. So: **one notification per rule per poll, listing all of that rule's deals, carrying exactly one unsubscribe control naming that rule.** The cost is more notifications on a busy poll, and the damper is the per-term cooldown decided immediately above, which exists for precisely this. Full reasoning in 21.6; it is **D20** if you want to argue it.

**DECISION — suppress alerts for deals already marked expired** in `ozb:meta/@expiry` or `ozb:title-msg`. Alerting you to a bargain you cannot take is worse than silence.

### 20.2 Being a decent guest

The behaviour I used while researching is the behaviour the application should have. Concretely:

- **Conditional requests always.** 304 with zero bytes for unchanged feeds. This is the big one.
- **One request at a time.** No parallel fetching, no connection pooling races, a few seconds between the two feed requests.
- **5-minute interval** (17.6), never below 2 minutes.
- **Respect `Retry-After`** on 429 and 503, and back off exponentially with jitter on anything else.
- **Never retry a 403 quickly.** A 403 means stop and think, not try again harder.
- **The seven robots-disallowed paths are a hard deny list in the HTTP client** (17.1), not a convention.
- **Log every request's outcome**, so if OzBargain ever asks what we were doing, there is an answer.

**DECISION (D14) — identify the application honestly:**

```
User-Agent: OzBargainHunter/<version> (personal deal alerter; +https://github.com/jamesgallagher/OzBargainHunter)
```

Every prior-art project I read spoofs something — Chrome 124, `curl/8.5.0`, an old Chrome build. I am recommending against that, for three reasons. It is identifiable, so if we ever do cause a problem the owner can see who it is and block *us* rather than a whole class of clients. It is a prerequisite for ever asking to be allowed. And impersonation is precisely the *"sneaky bad actors keep on changing tactics"* behaviour scotty complains about; being part of that is how the feed carve-out gets withdrawn from everyone.

**The honest counter-argument, which is real:** an identifiable bot is easier to block deliberately than a hidden one. A spoofed Chrome UA is statistically safer in the short run. I still recommend honesty — partly on principle, partly because I verified that an honest UA returns 200 today (16.2), and mostly because the whole design depends on a carve-out the owner maintains voluntarily. Free-riding on it while disguised is the fastest way to lose it. **If you disagree, this is a one-line change and it is your call.**

### 20.3 Classifying every response

The poll does not ask "did it work" but "what happened", with these outcomes and these responses:

- **200** — parse and process.
- **304 Not Modified** — nothing new. Not an error. The common case.
- **403 with a ~17-byte body / `error code: 1010` / `"Just a moment..."` / a challenge page** — **Cloudflare has blocked us.** Stop all OzBargain requests, enter long backoff, raise a loud alert. This is the serious case and must never be treated as transient.
- **403 with ~1KB of styled OzBargain HTML containing "You do not have permission"** — an **application permission denial**. On `/classified` this means logged out or not entitled (18.5). On a deals feed it would be new and surprising and should alert.
- **404** — the path has moved or been withdrawn. Alert; do not retry on a timer.
- **429 / 503** — back off, honour `Retry-After`, retry with jitter.
- **Timeout / connection error** — retry with exponential backoff, alert after 3 consecutive failures.
- **200 but unparseable XML** — treat as a failure, keep the raw body for diagnosis, alert. This is what a Cloudflare interstitial served with a 200 looks like.

The first two 403 cases being distinguishable by body is not a nicety — it is the difference between "back off, we may have been noticed" and "the user needs to log in again".

### 20.4 Acquisition will break one day. Design for it.

The site owner says he tunes Cloudflare rules against scrapers continuously, and my `error code: 1010` result proves those rules are live and specific. **Acquisition will break without warning at some point.** Not a risk to mitigate — a certainty to plan for.

**The governing principle: a silent dead alerting tool is worse than a visibly broken one.** If this thing stops working and says nothing, you will carry on assuming no alerts means no bargains, and you will not find out until you notice a deal you should have been told about. The failure mode of an alerter is *silence*, which is indistinguishable from normal operation. That has to be engineered against explicitly.

**DECISION (D16) — a dead-man's switch.** If no poll has succeeded for 30 minutes (six intervals), send a notification saying so, then repeat at a decaying rate — 30 minutes, 2 hours, 6 hours, daily — so it nags without becoming noise you learn to ignore.

**DECISION — the container health check reflects acquisition health, not just process liveness.** A process that is running but has not fetched anything in an hour is **not** healthy, and Unraid should show that. Concretely: `/healthz` returns unhealthy if the last successful poll is older than three intervals. This is worth more than it looks — it makes "broken" visible in a place you already look, without reading logs.

**DECISION — the web UI's front page leads with acquisition status:** when the last successful poll was, what the last response was, and whether we are in backoff. Not buried on a diagnostics page.

**DECISION — a visible "last checked" timestamp on every page.** The cheapest possible defence against silent death: you glance at it and know.

**DECISION — keep the last N failed response bodies** (truncated, in the database) so that when it breaks you can see *what* OzBargain actually said rather than guessing from a log line. When the block came, knowing whether it was 1010 or a challenge page decides the next move.

**DECISION — degrade rather than die.** If `/feed` fails but `/deals/feed` succeeds, keep running the rules that only need new deals, and say clearly in the UI that front-page detection is unavailable. Partial function with honest reporting beats a crash loop.

**The recovery path, when it does break.** In rough order: read the stored failure body to identify which of the 20.3 cases it is; if it is a client-signature block, the User-Agent is an environment variable and can be changed without a rebuild; if the feed path itself has moved, the feed URLs are environment variables too. **DECISION — every URL and the User-Agent are configuration, not constants**, so the first response to a break is a template edit and a restart rather than a code change, a rebuild and a deploy cycle. Given section 4.2's build-to-live latency, that distinction could be the difference between fixing it in two minutes and waiting a day.

And if it breaks permanently — if the owner withdraws the feed carve-out or blocks us specifically — **the correct response is to stop, not to escalate.** No bypass tooling, no rotating User-Agents, no proxies. Section 16.5 shows that path is technically losing anyway; it is also the fastest way to make things worse for every RSS consumer on the site. If we get blocked while identifying ourselves honestly and polling every 5 minutes with conditional requests, then we were not wanted, and the answer is to ask or to stop.

### 20.5 Where notifications go (U4, D13)

You have not said. Options for a self-hosted Unraid container: **ntfy** (self-hosted, publish by one plain HTTP POST, topic-based, real iOS and Android push, priorities and click-through URLs); **Gotify** (simpler, weaker iOS story); **Apprise** (not a delivery service but a *router* that fans one notification out to 80+ backends); **Discord/Telegram webhooks** (trivial, great formatting, but put a third-party cloud service in the alert path of a self-hosted tool and rate-limit during bursts); **email** (universally reachable, but latency and deliverability make it poor for "this is rising right now").

**DECISION — ntfy, behind a one-method internal interface.**

Why ntfy: publishing is a single HTTP POST with no SDK, so there is no client library to maintain and a failure is a visible non-2xx. The alert path stays inside the house, matching the rest of this design. It has the fields this app actually wants — priority (trend alerts louder than keyword matches), a click URL straight to the deal, and tags per rule. And the pairing is proven: `eckyecky/ozbargain-ntfy-live-bridge` is an OzBargain-to-ntfy bridge.

Why the interface: `send(title, body, url, priority, tags)` costs nothing now and means adopting Apprise later, or adding Discord, is a new implementation of one method rather than surgery on the alerting logic. Given U4 is your call and you may change your mind, that cheapness is the point.

**The thing I asked to be verified has been verified, and it came back the other way. CORRECTED.** This paragraph previously said that a note passed to me claimed an ntfy instance was already running on this host for Uptime Kuma alerts, that I had not verified it, that it was not in the verified-facts record, and that it was "the kind of convenient assumption that would otherwise get quietly baked in". It was checked directly on `192.168.0.148`: **`docker ps -a` lists no ntfy, Gotify or Apprise container, and there is no matching Unraid template. There is no ntfy on this host.** Those Uptime Kuma alerts may go to an instance elsewhere on your network, or to the public `ntfy.sh` — both are plausible, neither is verified, and I am not going to pick one.

**What changes because of it.** The recommendation does not: the reasons for ntfy in the paragraphs above were never that one already existed. What changes is the price. D13 now costs you a container to run, patch and back up, or a decision to put a third-party service in the alert path of a self-hosted tool — which is the thing I argued against for Discord and Telegram, and the argument does not get weaker just because the service is ntfy.sh. **Decide it on the merits above, not on a convenience that turned out not to exist.** Note also that the dead-man's switch (20.4) now depends on infrastructure that has to be stood up first: an alerter whose failure alarm runs through the same channel that has not been built yet is not much of an alarm.

**And R26 puts a new constraint on this decision that did not exist when it was first written.** Whatever channel you pick must be able to carry a control — a button or an actionable link — inside the notification, or R26 is unbuildable as specified. For ntfy I checked the vendor documentation rather than assuming: it supports **up to three action buttons** per notification, of types `view`, `http`, `broadcast` and `copy`, where an `http` action "Sends HTTP POST/GET/PUT request when the action button is tapped" with custom headers and a body and without opening a browser. **Documented, not measured** — confirm on the real instance (P13). Three is enough for what R26 and R27 need, which is two: unsubscribe, and manage alerts. It is not much headroom, so do not plan a third.

**DECISION — alert content, because this determines whether the tool is usable:** the deal title; the current net votes and vote rate; which rule fired and which term matched; and a click-through URL going **directly to the OzBargain node page**, not the `/goto/` redirect (that path is robots-disallowed and it is their affiliate tracker — we link to the discussion, you decide what to click). Front-page promotion alerts should say how long the deal took to get promoted, because that number is the actual signal and we are the only ones who know it.

**DECISION — every notification also carries exactly two controls, and they are requirements rather than polish:** an **unsubscribe control for the rule that fired**, labelled with the rule in plain words — *"Stop alerts for 'playstation'"* — which is R26 and whose mechanism is D17; and a **"Manage alerts" link** to the alert manager, which is R27 and which needs no special mechanism because it is an ordinary authenticated URL. Two controls, two of ntfy's three action slots. **For a classifieds match the alert must also say which surface it came from**, because a classified carries no votes and no vote rate and an alert that silently omits those fields looks broken rather than different (18.8).

---

## 21. R25, R26 and R27 — alert lifecycle, unsubscribe, and the alert manager

New. These three arrived after the research pass and after sections 19 and 20 were written. One of them was already done; one is a straightforward addition with a large scope consequence; one is a genuine collision between two of your own requirements and I have not resolved it on your behalf.

### 21.1 R25 — already satisfied in substance. Closing it out rather than redesigning it.

> *"I only want to hear about a deal once (per deal). Unless it crosses into another criteria. Example, A deal has passed 50 votes."*

**This is already the design, and it was already the design before you asked for it.** Section 20.1 specifies an **alert ledger keyed on `(node_id, rule_id)` in which a rule fires at most once per deal, ever** — a permanent record, explicitly not a cooldown — and it already gives your exact case in its own words: a deal legitimately alerts twice when two different rules fire, "once for rising fast, once when promoted". Swap the promotion rule for a 50-vote rule and that is your sentence.

**I am saying so rather than writing a new design for it**, because the worst thing I could do with a requirement that is already met is produce a second mechanism that does the same job slightly differently. Alert identity is the pair, not the deal. That is settled.

**Two things your wording adds, and I am adopting both.**

1. **Criteria must be discrete and individually identifiable, or "crossed into another criteria" is not computable.** This is the corollary and it constrains the rules engine: a 10-vote threshold and a 50-vote threshold are **two rules with two rule IDs**, not one rule with a parameter. A deal that clears 10 and later clears 50 produces two alerts, which is exactly what you asked for. A single parameterised rule would produce one, or six. **DECISION — vote-threshold criteria are modelled as individual rules, each with its own rule ID and its own ledger entries.** The alert manager (21.7) therefore lists them individually and you can mute the noisy one and keep the interesting one.
2. **It extends to classifieds for free.** Because classified listings share the `/node/<id>` namespace with deals (18.7), the same ledger key covers both surfaces with no change. Worth noting because it is the rare case where a new surface costs nothing.

**One thing to be aware of rather than to fix.** "Once per deal, ever" means that if a rule's *definition* changes — you widen a term from "playstation" to "playstation OR ps5" — the ledger still holds the old firings under the same rule ID, so deals that already alerted under the narrow term will not re-alert under the wide one. That is almost certainly what you want, and it is the sort of thing that looks like a bug if nobody wrote it down. **DECISION — editing a rule keeps its ID and its ledger history. If you genuinely want a clean slate, the alert manager offers "reset history for this rule" as a separate, deliberate action.**

### 21.2 R26 — stating the collision precisely, because the precise version is narrower than it looks

> *"There must be a one click unsubscribe from a rule… The next alert that comes through for playstation should have subtext 'I no longer wish to receive alerts for playstation'."*

**First, a correction to how this conflict has been framed, because getting it right shrinks the problem considerably.**

The tension has been described as R26 against R8 **and** R9. **It is R8 only. R9 is not involved, and it is important that it is not.** R9 says nothing may be reachable by a back door that bypasses the Cloudflare Tunnel path. A tap on a notification produces an ordinary HTTPS request to `ozb.gallagherhome.au`, which resolves through Cloudflare, enters the tunnel, and arrives at the app the same way every other request does. **No back door is created, no port is published, and section 7.2 Option 1 — the load-bearing exposure decision in this entire document — is completely untouched by R26.** Whatever we decide here cannot weaken it.

What R26 actually collides with is **R8** ("a JWT must be enforced on each page") and with **section 7.5's** commitment that anything unauthenticated is an explicit, documented, reviewed exception. That is a real collision and I am not going to talk it away.

**Why it is hard, reduced to three properties in tension:**

- **(a) The action changes state.** It disables a rule. It is not a read.
- **(b) It is initiated from a context that may hold no identity token** — a phone, from a notification, possibly from a lock screen, possibly through an app-supplied webview that does not share cookies with your normal browser.
- **(c) It must take one tap.** That is the requirement, in your words, and "one click" was the point of it.

**Any two of these are easy.** State-changing and authenticated but multi-step: trivial, that is the alert manager. Unauthenticated and one tap but read-only: trivial, that is a link to a public page. Authenticated and one tap but not state-changing: trivial. **All three together is the problem**, and every honest answer gives ground on one of them.

### 21.3 What I rejected, and why — including the answer you will be offered by anyone else

**Rejected — the unauthenticated magic link.** A long random URL, no expiry, no scope, no single-use limit, that disables a rule when fetched. This is the obvious answer and it is exactly the exception R8 exists to forbid. It is a permanent credential in a message, and *"anyone who obtains this link can turn off your alerting"* is not a footnote, it is the design. Rejected outright. Note that the capability token in Mechanism B below is **not** this: the difference is scope, expiry, single use, and a stated blast radius, and those differences are the entire argument.

**Rejected — trusting the network path.** "Only Cloudflare can reach the container, so an unauthenticated request must have come through Access." Section 7.4 already names this as the single technical instruction to take from this document if you take only one, and it names it because it is the mistake that turns a LAN back door from harmless into fatal. The app must verify, never infer. Rejected, and it would have been rejected even if it worked.

**Rejected — a Cloudflare Access service token in the notification.** This looks clever: Access supports Service Auth policies with `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers (P14), so an action button could carry those and satisfy Access without any Bypass policy at all. **It is strictly worse than the thing it avoids.** A service token is long-lived and authenticates to the *whole application*; a capability token is single-use and authenticates one operation on one rule. Putting the service token in every notification means putting a broad permanent credential everywhere a narrow disposable one would have done, in order to avoid a configuration change. I am naming this explicitly so that nobody proposes it later as the tidy answer. **If we are going to put a secret in a notification, it must be the narrowest secret that does the job.**

**Rejected — quietly making it two clicks and describing it as one.** A confirmation page saying "Are you sure?" is the safe engineering answer and it is not what you asked for. If the answer ends up being two taps, it will say so in plain words rather than be presented as satisfying R26.

### 21.4 The two mechanisms that survive — and what an attacker holding the link can actually do

**Mechanism A — the unsubscribe link is an ordinary authenticated URL. No exception at all.**

The notification carries a `view` action pointing at `https://ozb.gallagherhome.au/rules/<id>/mute`. That URL is gated by Cloudflare Access like every other URL on the hostname, and the app verifies the Access JWT on it exactly as 7.4 describes. The `email` claim is the identity. If the session is valid the rule is muted on load and the page renders *"Muted 'playstation'. Undo."* If it is not, Access bounces through your identity provider first and then lands on the same page.

*On the state-changing GET, which is normally bad practice:* it is acceptable **here specifically** because CSRF requires an attacker to make your browser issue the request, and under Access an attacker cannot produce an Access-signed request at all — cross-site forgery is structurally impossible, not merely unlikely. The residual risk is a **prefetch** by your own browser or an OS link-preview acting with your own cookies, which would mute a rule you were only looking at. Mitigations: the operation is idempotent, the result page offers one-tap undo, and it emits a confirmation. I would accept that trade; if you would not, this becomes two taps.

*Security properties, stated honestly:* **nothing in the notification is a credential.** If the notification leaks — off a lock screen, out of a world-readable topic, through the push relay — the link is worthless to whoever holds it, because they still face Cloudflare Access and cannot get past it. That single property is the whole case for Mechanism A, and it is a strong one. Requests are logged by Access, so there is an edge audit trail as well as the app's own.

*What it costs:* **it is not guaranteed to be one tap.** Two things decide it. First, **Access session duration**, which Cloudflare's documentation confirms is configurable per application — set it long and the bounce is rare. Second, and this is the real unknown: **whether the notification opens the link in a browser that holds the `CF_Authorization` cookie, or in a cookie-less in-app webview** that will present a login every single time. I have not verified this and it depends on the channel and the phone. **It is testable in five minutes once a channel exists**, and it should be tested before this decision is finalised, because if it comes back badly then Mechanism A is not "occasionally two taps", it is "always a login", and that fails R26 properly rather than marginally.

**Mechanism B — a scoped, single-use, expiring capability token. One documented exception.**

The notification carries an `http` action that POSTs to `https://ozb.gallagherhome.au/u/<token>` and clears the notification. No browser opens. It is genuinely one tap, always, from the lock screen, regardless of cookies.

*The token, as designed:*

- **256 bits of cryptographically random, URL-safe data.** Guessing is not a threat at that width.
- **Scoped to exactly one operation on exactly one rule:** disable rule N. It cannot read anything, cannot enumerate rules, cannot re-enable anything, cannot reach any other path, and does not establish a session or issue a cookie.
- **Single use.** Consumed on first successful use and never valid again.
- **Expiring, 30 days.** Long enough that an alert you find late still works; short enough to bound the exposure window.
- **Stored as a hash, never as the value.** A database read does not yield live capabilities — the same reasoning as never storing a password in plaintext, applied to something that is functionally a single-purpose password.
- **One token per (rule, notification).** A leaked token affects one rule, not a set.

*What an attacker holding the link can do, in plain words, because this is the question that decides it:* **disable one alert rule, once.** That is the entire blast radius. They cannot read your deals, cannot see your watchlist, cannot re-enable anything, cannot pivot to any other endpoint, and cannot obtain a session. The damage is that you stop being told about Playstations — a denial of alerts, not a breach of anything. It is immediately visible, because the mute emits a confirmation notification, and immediately reversible from the alert manager.

*What it costs, with nothing hidden:*

1. **It is an exception to R8 and to section 7.5.** 7.5's own wording is that every exception must be explicit, documented and reviewed. This would be it, and there would be exactly one: the path `/u/*`, nothing else, hard-coded rather than pattern-matched — the same discipline 9.2 Option B demands for the icon route.
2. **It needs a Cloudflare Access Bypass policy on `/u/*`, and Bypass has a cost Cloudflare states in its own documentation: "requests are not logged".** So the one endpoint with no identity check is also the one endpoint with no edge audit trail. That is a genuinely unattractive pairing and it is the specific reason I prefer Mechanism A. The app must log every hit itself (19.1), and under this mechanism that log is the only record that exists.
3. **The token lives in the notification, and the notification is not private.** It sits on the notification server — where, by default, "everyone can read and write to any topic" (D21) — and it transits Google's or Apple's push infrastructure to reach your phone. **Unavoidable, and it must be said plainly: under Mechanism B, a party with access to your push relay or your notification topic can mute one of your alert rules.** D21 closes the easiest of those paths. Nothing closes the push-relay one short of not using push.
4. **The endpoint must be rate-limited hard and must return an identical response for valid, invalid, expired and consumed tokens**, so that it cannot be used as an oracle to probe which tokens exist.

**DECISION (proposed — this is D17 and it is genuinely yours): Mechanism A.**

The reasoning: it costs zero exceptions to requirements you wrote emphatically; nothing in the notification is a credential, so the dominant leak paths become irrelevant rather than merely mitigated; and its one weakness — the occasional login bounce — is measurable in five minutes rather than argued about. R8 and R9 were the first things you specified for this project, before there was a product, which tells me how you weight them.

**But I want to be straight about what I am asking you to give up.** You asked for one click. Mechanism A is one click in the common case and one click plus a login bounce in the uncommon one, and if the webview test goes badly it is worse than that. **If your answer is "one tap, always, I accept the exception", say so and I will build Mechanism B exactly as scoped above** — it is tightly bounded, its worst case is an annoyance rather than a compromise, and I would not describe choosing it as reckless.

**And a de-risking note that is not fence-sitting.** The mute operation itself is identical under both mechanisms; only the front door differs. So starting with A and moving to B later is a contained change, not a rewrite. If you have no strong feeling, **start with A, run the five-minute test, and switch if it annoys you.** That is the cheapest path to a right answer.

### 21.5 What "unsubscribe" actually does — six decisions

The mechanism is D17. The behaviour is the same either way, and it needs more thought than "set a flag".

- **DECISION — mute, never delete.** The rule stays and is marked disabled. Deleting would throw away its history, make a mis-tap unrecoverable, and lose the ledger entries that stop it re-alerting on everything if you turn it back on. R26 says *"I no longer wish to receive alerts"*, which is a statement about notifications, not about the rule's existence.
- **DECISION — suppress that rule's already-queued alerts.** This is the corollary in your own requirement and it needs the pending-alert queue in 19.1. Muting a rule and then receiving three more alerts from it because they were computed forty seconds earlier would make the control feel broken on first use, which is the worst possible moment.
- **DECISION — a muted rule keeps evaluating and keeps writing ledger entries; it just sends nothing.** This is the one that is not obvious. If a muted rule stopped evaluating, re-enabling it would fire on everything that matched while it was off — you buy the Playstation, mute the rule, un-mute it in March, and get a burst of stale alerts. Evaluating silently means re-enabling is quiet, and it means the alert manager can tell you something genuinely useful: *"muted 6 weeks ago, 12 matches since"*. That is the same principle as D15's silent cold-start seeding, applied to a different kind of gap.
- **DECISION — every mute produces a confirmation.** A rendered page under Mechanism A, a confirmation notification under Mechanism B. A state change triggered from a phone with no visible result is exactly the kind of thing you will later be unsure you did. You asked for evidence rather than assurances; this is that principle applied to a button.
- **DECISION — undo is one tap from the confirmation, and permanently available in the manager.** A one-tap destructive control with no one-tap reversal is a trap, and this one will be tapped on a phone, in a pocket, by accident, eventually.
- **DECISION — the confirmation offers snooze as a second thought.** The button itself is a mute, because R26 asks for one click and a menu is not one click. But *after* the fact, the confirmation offers "24 hours / 7 days / keep it off". This matters most for the trend rule, where "stop telling me about rising deals" is a much blunter thing to do permanently than muting a specific term — and the trend rule is a rule like any other, so R26's button will appear on its alerts too.

**One labelling requirement that is easy to get wrong.** The control must name the rule in the words *you* used for it — *"Stop alerts for 'playstation'"*, not *"Unsubscribe from rule 7"*. That is not cosmetic: it is the only thing standing between you and muting the wrong rule from a lock screen, and under Mechanism B there is no confirmation step to catch it.

### 21.6 The consequence R26 has for alert grouping — a decision in 20.1 has to change

Section 20.1 decided that alerts are grouped **per poll**: five alerts in one poll become one notification listing five deals, because five separate notifications is how a tool gets silenced.

**R26 breaks that, and I would rather revise the earlier decision than let the two sit in the document contradicting each other.**

If one notification covers matches from three different rules — a "playstation" watchlist hit, a "ChatGPT" keyword hit and a trend alert — then an "unsubscribe" button on it has no unambiguous target. Three ways out, and only one is any good:

- **Three buttons, one per rule.** Fails immediately: the channel allows three action buttons total (P13) and "Manage alerts" already takes one, and a notification covering four rules has nowhere to go.
- **One button that unsubscribes from "whatever matched".** Actively dangerous. A button that silently disables a rule you did not mean to disable is worse than no button, because the failure is silence and you find out weeks later when a deal you wanted goes past unannounced.
- **Group by rule instead of by poll.** One notification per rule per poll, listing all of that rule's deals, carrying exactly one unsubscribe control that names that rule.

**DECISION (D20) — the grouping unit becomes (rule, poll), superseding 20.1's per-poll grouping.**

*The cost, honestly:* a busy poll produces more notifications than it would have. *The damper:* the per-term cooldown decided in 20.1 — default 24 hours, configurable per term — exists precisely to stop a single term flooding you, and it is unaffected. In practice the measured volumes make this a small change: the trend rule fires about 3.5 times a day, promotions about 10 (17.3), and watchlist terms are rate-limited by their own cooldowns. The number of *rules* firing in a single five-minute poll will almost always be one.

### 21.7 R27 — what the alert manager actually contains

> *"There should also be a link to 'manage alerts' which will take you to the alert manager."*

**The link itself is the easy half and needs no special mechanism**: it is an ordinary authenticated URL at `https://ozb.gallagherhome.au/alerts`, gated by Access, verified by the app, no exception of any kind. Unlike R26, there is no tension here at all — following a link to a page and logging in if asked is normal behaviour, and the destination is a page you are going to spend time on anyway.

**The hard half is that R27 makes the UI a requirement rather than a convenience, which means it has to exist in v1 and it has to be usable on a phone** — because every notification links to it, and notifications are read on a phone. That is a design constraint the "small web UI" in 2.1 never had.

**DECISION — v1 contains these and only these (this is D18):**

1. **Acquisition status, at the top of the first screen.** Already decided in 20.4: when the last successful poll was, what the last response was, whether we are in backoff, and a visible "last checked" timestamp. R27 gives it a home rather than changing it.
2. **The rules list.** Every rule: watchlist terms (R20), keyword terms (R21), the velocity rule and the promotion rule (R19), and any vote-threshold rules (21.1). Per rule: enabled / muted / snoozed, match count over the last 7 and 30 days, when it last fired, its cooldown, its optional pinned slug, and **which surfaces it applies to** — deals, classifieds, or both, which 18.8 requires and which is fixed to deals-only and not editable for trend rules.
3. **Add, edit and delete a rule.** The term text, the matching mode (all-tokens for watchlist, any-token for keyword — 17.4 and 17.5), the cooldown, the surfaces.
4. **Enable, mute, snooze and re-enable** — the counterpart to R26. Without this, a mis-tap from a notification is permanent, which would make the R26 button something you are afraid of.
5. **Alert history.** What fired, when, which rule, which deal or listing, with a link. This is the "seeing what it has done" from 2.1 and it is the evidence surface for the whole tool.
6. **The near-miss and suppression log.** 17.3 already decided that every poll logs how close the top deals came to firing, so that thresholds can be tuned from your own data rather than guessed; 20.1 suppresses reposts and expired deals. **Both are currently written to a log file nobody will read.** R27 gives them a screen, and that is what turns D11's thresholds from "numbers I justified against a sample" into "numbers you tuned against your own week".
7. **The trend thresholds themselves** (D11), editable — which is what forces D19.
8. **Classifieds session status,** if D10 proceeds: whether the cookie is valid, when it was last confirmed working, and somewhere to paste a fresh one. 18.4 requires the app to ask clearly rather than fail silently, and this is where it asks.
9. **A "send a test notification" button.** Proves the whole delivery path end to end in one tap, including the action buttons, which is how you will verify D17 and D21 without waiting for a real deal.

**Deliberately NOT in v1:** user accounts and roles (there is one user, and Access already decides who that is), per-rule notification routing, saved searches over history, charts of anything, and a mobile app. If you want v1 smaller, **cut item 5** — the alert history view is the largest single piece and the least load-bearing, and the ledger still records everything whether or not there is a screen for it.

### 21.8 Being honest about the scope R27 implies

Section 2.1 promised "a small web UI". **R27 makes it not small, and I would rather say that now than discover it during Stage 4.**

- **It goes from a read-only status page to a small CRUD application.** Forms, input validation, the ability to break your own alerting by saving a bad rule, and a persistence layer that is now edited by a human rather than only written by a poller.
- **It introduces write endpoints, which makes section 7's access control load-bearing rather than incidental.** Up to now, a failure of the access-control design would have leaked a list of bargains. Now it would let someone change what you are alerted about. 7.5's deny-by-default blanket covers these by construction, which is the payoff for having written it that way.
- **CSRF protection is required, and Cloudflare Access does not provide it.** This is worth stating because the opposite is easy to assume. Access authenticates the **user**, not the **origin of the request** — a malicious page in another tab could attempt a cross-site POST that rides along with your `CF_Authorization` cookie. Whether that cookie's `SameSite` attribute would block it depends on Cloudflare's cookie settings, which are configurable and which **I have not verified**. **DECISION — implement CSRF tokens on every state-changing request and do not rely on the cookie's behaviour.** Verify the cookie settings anyway, as defence in depth, not as the defence.
- **On effort, as a shape rather than an estimate:** this is the largest single piece of product work in the project after feed acquisition itself, and it roughly doubles the surface of Stage 4. I am not estimating it — you are the Scrum Master and estimates are yours — but you should size Stage 4 knowing that it now contains a small web application and not only a poller.

**Is it worth it? Yes, and the argument is not a UX one.** Section 17.3 says in plain terms that you will move the trend thresholds in week one and that the tool should let you tune from your own data. Without a UI, "tuning" means editing an Unraid template, recreating a container and losing the running state — which means in practice you will not do it, and the thresholds will stay at my defaults forever. R27 is what makes D11 real.

### 21.9 What R27 does to the tagging argument in section 5

This is the consequence I most want you to notice, because it comes from your own requirement rather than from my opinion, and it lands squarely on the one decision in this document I have pushed hardest on.

Section 5.2 argues against tracking `:latest` in production on four grounds, of which Problem 3 is that `latest` means "newest", not "good", and you would be auto-deploying it. When that was written, the app was a background poller and a bad auto-deploy meant you stopped getting alerts for a while — bad, but bounded, and the dead-man's switch in 20.4 would have told you.

**R27 changes what is being auto-deployed.** With a real management UI:

- **A bad deploy removes your ability to manage your alerts, not just your alerts.** If the container is crash-looping, you cannot mute the rule that has been firing every five minutes since lunchtime, because the thing you would use to mute it is the thing that is down. The failure is worse *and* your remedy is inside the failure.
- **Every auto-deploy runs schema migrations (19.4) against the database holding your rules and your alert ledger, unattended, at whatever hour you happened to push.** A crash loop is recoverable by pointing the template at the previous image. A half-applied migration against your only copy of your rules is not, or not quickly. This is a categorically different failure from the one section 5 was originally arguing about.
- **D19 makes it sharper still.** Moving rule configuration out of environment variables and into the database is the right call for R27, but it means your rules now live in the thing the migration touches, rather than in a template file you could read off the flash drive with a text editor.

**None of this is an argument against auto-update. It is an argument for auto-updating something that was promoted on purpose.** `:stable` (D2) costs you one `git tag` command and buys a deliberate moment between "I committed something" and "the control panel for my alerting was replaced while I slept". I made that argument before R27 existed. R27 makes it considerably harder to argue with, and I would rather point that out than let a decision you have not yet answered quietly get more expensive.

**One smaller consequence, for D6.** If you run a beta container alongside production, it will have its own appdata directory and therefore **its own separate rules database**. Rules you create in production will not exist in beta, so the beta container will start with nothing to alert on and will not exercise the thing you most want tested. Not a problem, but plan for it: either seed beta from a copy of the production database file — it is one file (19.4), so that is a `cp` — or accept that beta tests the plumbing and not your rules.
