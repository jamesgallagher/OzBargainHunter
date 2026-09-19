# OzBargain Hunter — Design

**Author:** design lane (Claude Opus 5)
**Date:** 19 September 2026 (AEST). Revised the same day, after the application premise and the R24 classifieds update arrived.
**Status:** Draft for James's approval. Nothing has been built. The only files created are this one and `research.md`.
**Input:** `BRIEF.md` in this repository, which records James's requirements verbatim plus environment facts that were each verified by running a command.
**Companion:** `research.md` — the raw evidence behind sections 2 and 16–20, with every URL and command output. This document is the argument; that one is the proof. Where they disagree, `research.md` is right.

---

## 0. How to read this document

James asked to be challenged, not agreed with. Several requirements in the brief do not do what he expects them to do on this host. Those are argued out below rather than quietly implemented.

Three labels are used throughout, and they mean exactly what they say:

- **FACT** — verified by a command, and recorded in `BRIEF.md` section 3. If it is not labelled FACT, I did not verify it.
- **DECISION** — a choice I am making as the design lane, with the reasoning stated. These are proposals until James approves them, but they are not vague: they name the actual tag, port, path or hostname.
- **OPEN** — genuinely undecided or genuinely unknown. I have not filled any of these with a plausible-sounding guess. Where an OPEN item blocks work, it also appears in section 13.

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

8. **The classifieds decision is the one to think hardest about, and it needs thirty seconds of your time first.** `robots.txt` explicitly disallows `/user/login`; the classifieds gate exists specifically to keep non-members out because of scams; none of the 102 public OzBargain projects has ever logged in. But **`/classified` itself is not disallowed — only the login endpoint is**, which opens a middle path where you authenticate as a human and the app only reads. And underneath it all, **nobody has actually proved that having an account unlocks the classifieds at all.** Before deciding anything, open `ozbargain.com.au/classified` in your normal logged-in browser and see whether you get listings. That either unblocks the work or closes the question entirely. Section 18.

---

## 2. The product surface

**This section was a marked placeholder in Stage 0. The premise has now landed and it is replaced below.**

**Reading order note.** Sections 3–15 were written before the premise and remain valid — they cover delivery, packaging, exposure and access control, none of which the premise changes. The new material sits in **sections 16–20**, which could not be numbered earlier without renumbering things already referenced. If you are reading for the new work, read section 2, then jump to 16. Sections 13, 14 and 15 have been updated in place.

### 2.1 What it is

OzBargain Hunter watches ozbargain.com.au and sends James a notification when something he cares about appears or starts moving. Three alert types:

- **Trending (R19)** — a recently posted deal that is climbing unusually fast, or that has just been promoted to the front page.
- **Watchlist (R20)** — a saved product or company term, his example being "AMD R9700", matched against new deals.
- **Keyword (R21)** — a saved free-text term, his example being "ChatGPT", matched against new deals.

It runs as a background poller with a small web UI for managing watchlist terms and seeing what it has done. Alerts go out over a notification channel (section 20.5).

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

**Added after the premise. These two are not read-only in the same sense — P9 is something James does in a browser, not something an agent runs.**

- **P9 — Does an OzBargain account actually unlock `/classified`? (U7)** James opens `https://www.ozbargain.com.au/classified` in his normal logged-in browser, then again in a logged-out private window. Thirty seconds, no automation, no risk. Blocks R22, R24 and the whole of section 18. **This is the highest-value probe in the list**, because a negative result closes an entire workstream before any of it is designed in detail.
- **P10 — Is there an ntfy instance already running on this host?** The note passed to the design lane says there is one serving Uptime Kuma, but that is not in the verified-facts record and I have not confirmed it. Determines whether D13 is free or costs a container.

---

## 12. Staged plan

Each stage ends at a human approval gate. No stage starts before the previous one is signed off.

- **Stage 0 — now.** This document. Nothing built. Awaiting your review and your answers in section 14.
- **Stage 1 — probes.** Run P1–P8. Report raw output. Update this document's OPEN items with facts. Still nothing built. **Add P9: settle U7 — open `ozbargain.com.au/classified` in your logged-in browser and report what you see (section 18.6).** It takes thirty seconds and it decides whether Stage 5 exists at all.
- **Stage 2 — the pipeline skeleton.** Repository created, remote added, a trivial "hello" container, Dockerfile, build workflow, tagging scheme, GHCR publish. **The entire delivery loop is proven with a placeholder application before any product code exists.** This is deliberate: it means when the real app arrives, the delivery path is already known-good and any failure is unambiguously in the app. Ends with the section 10 acceptance test passing.
- **Stage 3 — exposure and access control.** Hostname, ingress edit, Cloudflare Access application, JWT verification in the placeholder app, Unraid template, logo. Ends with the section 10 access-control test passing.
- **Stage 4 — the actual product: the deals side.** The premise has landed, so this is now designed rather than deferred — sections 2 and 17 through 20. Feed acquisition, SQLite state, the three alert rules, de-duplication, the notification channel, the dead-man's switch and the web UI. **Needs no OzBargain account and no credential**, so it is not blocked by anything in section 18 and delivers R16–R21 and R23 on its own. Still not estimated.
- **Stage 5 — classifieds, only if it survives.** Contingent on P9 settling U7 and on your answer to D10. If U7 comes back negative, this stage does not exist. If it comes back positive and you choose Option B, it is small. If you choose Option C, it is much larger than Stage 4 and carries the risk argued in section 18.3. **Deliberately last**, so that the whole product is working and useful before anything touches an account.

**The case for building Stage 2 against a placeholder app**, since it may look like busywork: it separates "is my delivery pipeline correct?" from "is my application correct?". Debug those together and every failure has two possible causes. Debug them apart and every failure has one. It also means the first time you push real product code, it deploys to your house automatically and correctly, which is a good day.

---

## 13. What is blocking

In order of how much they block.

- **B1 — the application premise (R15). RESOLVED.** The premise landed on 19 September 2026 and is designed in sections 2 and 16–20. The specifics it was blocking are now settled: the volume mount target is `/data`, storage is SQLite (no database container), egress is to ozbargain.com.au and one notification endpoint, and the logo now has a subject to depict.

**New blockers arising from the premise:**

- **B7 — U7: nobody has demonstrated that an OzBargain account actually unlocks `/classified`.** Blocks R22 and R24 completely. Everything about the classifieds design is contingent on an unproven assumption. It costs about thirty seconds to settle and must be settled before any classifieds work is scoped. Section 18.6.
- **B8 — D10: the R24 policy decision.** Whether to authenticate to OzBargain at all, and if so how. This is James's call, not mine and not the orchestrator's. It is the most consequential decision in the project and it is argued in section 18. Blocks R22/R24 only; the whole of the deals side (R19, R20, R21) proceeds regardless.
- **B9 — U4/D13: where notifications go.** Blocks the last hop of every alert. Cheap to answer. My recommendation is ntfy (section 20.5), and there is a specific thing to verify: whether the ntfy instance reportedly already running on this host for Uptime Kuma is real. It is not in the verified-facts record.
- **B10 — U6/D11: the trend threshold numbers.** Does not block a build — I have proposed defaults justified against real measured data (section 17.3) and made them configurable. It blocks *acceptance*, in the sense that only James can say whether ~3.5 alerts a day is the right volume.
- **B2 — tunnel management mode (P1).** Blocks the recommended exposure design. Without this, section 7.2 Option 1 cannot even be attempted.
- **B3 — hostname routing ownership (P2, P3).** Blocks R7. If you do not administer `192.168.0.173`, the design narrows sharply.
- **B4 — repository visibility (D1).** Blocks the branch-protection decision (8.3/8.4), the logo hosting decision (9.2), and interacts with the naming question (D9). One decision, three downstream consequences.
- **B5 — Cloudflare Access acceptance (D3).** If you reject Access, section 7.4 is rewritten and Stage 3 grows substantially — you would be designing and building an authentication system rather than configuring one.
- **B6 — GitHub plan tier (P8).** Blocks any acceptance criterion phrased as "CI blocks the merge". Does **not** block Stage 2, because Fallback A in section 8.4 works on any plan.

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
  *Recommendation: not by driving the login form. If you want classifieds, supply the session cookie yourself.* Three options are laid out in full in section 18.4. In short: OzBargain's `robots.txt` names `/user/login` as disallowed, the classifieds gate exists specifically to keep non-members out because of scams, the site owner tunes Cloudflare rules against bots continuously, none of the 102 public OzBargain projects has ever done this, and the account at risk is your personal one. The middle option — you log in as a human in your own browser and paste the resulting session cookie into the app — gets you the classifieds without the app ever touching the disallowed endpoint. **Read section 18 before answering this one.** It is the decision I most want you to make deliberately.

- **D11 — The trend thresholds (R19).** *Recommendation: alert when a deal is under 6 hours old, has at least 10 net votes, and is running at 5.0+ net votes/hour; and separately whenever a deal is promoted to the front page.* Measured against 120 real deals, that fires about 3.5 times a day plus about 10 front-page promotions a day. All four numbers are environment variables and I expect you to move them in week one. Justification and the measured distribution: section 17.3.

- **D12 — Poll interval.** *Recommendation: 5 minutes.* Two feeds, conditional requests, which means ~576 requests a day of which almost all return 304 with a zero-byte body. Your trend detection can never be finer-grained than this number, and that relationship is stated honestly in section 17.6. Faster is possible and I would not go below 2 minutes.

- **D13 — Notification channel (U4).** *Recommendation: ntfy, behind a one-method internal interface* so that swapping to Discord, Apprise or email later touches one file. Reasoning in section 20.5.

- **D14 — Identify the bot honestly in the User-Agent, rather than impersonating a browser.**
  *Recommendation: yes, identify honestly.* Every prior-art project I read spoofs either Chrome or curl. I am recommending against that, and the reasoning is in section 20.2. It carries a real risk, which is that an honest bot is easier to block deliberately than a hidden one. I think that risk is worth taking and I have verified that an honest User-Agent returns 200 today.

- **D15 — Seed on first run; do not alert on history.** *Recommendation: on a cold start with an empty database, record everything the feeds currently show as already-seen and send zero alerts.* Otherwise your first launch fires 120 notifications for deals from two days ago. Section 19.3.

- **D16 — A dead-man's switch is part of the product, not an optional extra.** *Recommendation: if no poll has succeeded for 30 minutes, send an alert saying so.* A silent broken alerter is worse than no alerter, because you will trust it. Section 20.4.

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
- **R22 — Classifieds in scope for alerts.** **Not achievable as originally stated, and superseded by R24.** Verified: there is no classifieds feed at any path (`/classified/feed` → 404), and `/classified` returns OzBargain's own 403 page reading "You do not have permission to access this page". The fact-sheet framing of "blocked" is wrong; the correct framing is "members-only". That is a different problem with a different answer. Section 18.
- **R23 — Alerts delivered as notifications.** **Agreed; channel still your call.** Recommending ntfy behind a one-method interface so the choice is cheap to revisit. Section 20.5. Still OPEN as U4/D13.
- **R24 — The bot authenticates with a user account, then searches the classifieds.** **This is the one I am pushing back on hardest, and you should expect that given you asked to be challenged.** I am not refusing it and it is your call to make. But: `robots.txt` explicitly names `/user/login` as disallowed; the classifieds gate exists specifically to keep non-members out because of scams; the owner tunes Cloudflare rules against bots continuously; none of the 102 public OzBargain projects has ever done this, so there is no proven path to copy; and the account at risk is your personal one, not a throwaway. There is also a middle path that gets you the classifieds without the app ever touching the login form — you authenticate as a human in your browser and hand the app the resulting session cookie. Critically, `/classified` itself is **not** robots-disallowed; only `/user/login` is. That distinction is what makes the middle path coherent rather than a fudge. And underneath all of it sits U7: **nobody has actually demonstrated that having an account unlocks `/classified` at all.** Settle that first, for free, before deciding anything. The full argument and the authentication architecture — for if you say yes — are in section 18.

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
- **F10** — `/deals?sort=votes` returns 200 but **does not sort**. Identical node ordering to `/deals`; the parameter is ignored. A design that fetched it believing it was getting top-voted deals would get new deals in date order and never notice. The real popularity surface is `/deals/popular/feed`. Also, the forum path is `/forum`, singular, which returns 200.

**Not re-tested:** **F11**, the owner's continuous anti-scraper tuning. I did not re-fetch node 946105, but it is corroborated by his March 2026 statements which I did fetch, and by my own 1010 result. Treat as confirmed.

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

- **There is no classifieds feed.** `/classified/feed` → 404, and every plural variant → 404. The RSS route that makes the rest of this project clean simply does not exist here.
- **`/classified` returns OzBargain's own 403 page**, styled, with a PHP session cookie, reading *"You do not have permission to access this page."* This is the application denying permission, **not** a Cloudflare challenge. F13 confirmed byte for byte. Your reading of this — that it is an authorised-only section — is correct.
- **`robots.txt` disallows `/user/login`.** It is named alongside `/privatemsg/` and `/search/`. This is the site telling automated clients not to drive its login form, and it predates this project.
- **`/classified` itself is NOT disallowed by `robots.txt`.** Only the login endpoint is. **This distinction is the hinge of the whole section** and I will come back to it.
- **The gate exists specifically to keep non-members out, because of scams.** Moderator *moocher*, 12/02/2019: *"we will not be bringing it back as it is a public page, and we no longer want to expose classifieds to non-members due to incidents of scams."* And the next day, diagnosing a user's 403: *"Were you accessing the section from a guest session (i.e. not logged in)?"*
- **No prior art.** None of the 102 public OzBargain projects logs in, and none touches classifieds (16.5).
- **No terms-of-use prohibition.** OzBargain's ToS has no anti-automation clause at all (16.4). So automating the login would breach `robots.txt` but would not breach any stated term. I want that stated accurately rather than dramatised in either direction.

### 18.2 What is NOT verified, and it is the foundation of everything

**U7 — nobody has demonstrated that having an account actually unlocks `/classified`.**

The evidence leans your way: a moderator said classifieds are hidden from non-members and diagnosed a 403 by asking whether the user was logged out. But the official wiki rules I found are about **posting** — one year of membership, private messaging enabled, one post per 24 hours — and say nothing about **viewing**. It remains possible that viewing carries a requirement nobody has written down, in which case an account does not deliver R22 and all the work below is wasted.

**Building anything before settling this would be building on an assumption.** See 18.6 — it costs about thirty seconds.

### 18.3 My honest assessment of R24 as written

You wrote: *"classified is a authorised only section, so we will likely need to create a user login for this. The bot will need to authenticate, then search that section."*

The diagnosis is right. The proposed remedy is where I push back, on four grounds:

1. **`robots.txt` names `/user/login` as disallowed.** That is the clearest, most specific signal this site gives about automated access, it is machine-readable, and it predates us. Everywhere else this design leans on `robots.txt` as the authority for what is permitted — sections 16.1, 17.1 and 17.5 all defer to it, and 17.5 gives up site search because of it. We do not get to treat it as binding where convenient and advisory where inconvenient.

2. **The gate's stated purpose is to keep exactly this out.** Classifieds are hidden from non-members because of scams. An automated client harvesting that section is close to the thing the gate was built to prevent. This is different in kind from the deals side, where the owner *deliberately protected* automated access.

3. **The account at risk is your personal one (U9).** Not a throwaway. If automated access is detected, plausible outcomes run from a Cloudflare challenge on the session through to suspension. Nobody has published a case of exactly this, so the probability is genuinely unknown — but the asset is a real account with real history, and 18.1 establishes that the section is tied to membership standing. Losing it costs more than the feature is worth.

4. **There is no proven path and no prior art.** With 102 projects over a decade, nobody has published this. You would be doing original work, against a login form sitting behind Cloudflare, maintained by an owner who tunes rules against bots continuously — to reach a section whose gate is explicitly anti-automation.

**None of that is a refusal.** It is your site account, your risk and your call. But you asked not to be told "yes sir, three bags full", and a design that quietly implemented an automated login against an explicit `robots.txt` disallow would be exactly that.

### 18.4 Three options — D10

**Option A — do not do classifieds. Ship the deals side.**
R19, R20 and R21 all work today on explicitly-protected feeds with no account, no credential and no policy question. This is most of the value of the product. R22 gets recorded as "not available via a sanctioned route" and you lose classified coverage of your watchlist terms.
*Cost:* you do not get the thing you asked for.
*Risk:* none.

**Option B (recommended) — you authenticate as a human; the app only reads.**

This is the middle path and it turns on the distinction in 18.1: **`/user/login` is robots-disallowed; `/classified` is not.**

You log in to OzBargain in your own browser, as a human, the way you already do. You copy the resulting session cookie out of your browser and paste it into the app's settings once. The application then requests `/classified` — a permitted path — with that cookie, at the same polite cadence as everything else. **The application never touches the login form, never holds your password, and never drives an endpoint `robots.txt` names.**

Why I like this:
- It respects the one clear instruction the site gives, precisely and not approximately.
- There is no password anywhere in the system. This matters given section 7.6: Unraid template variables are plaintext XML on the flash drive and in every flash backup. A session cookie is bad to leak; a password is much worse.
- There is prior art for the shape — `eckyecky`'s `OZBARGAIN_COOKIES` does exactly this.
- It is honest about what it is. A human authenticated; a tool the human runs then reads a page that human is entitled to read.

*Cost:* the session expires and you re-paste the cookie periodically. How often is unknown — OzBargain's `PHPSESSID` is sent with a **90-day** `Max-Age`, which is promising but is the cookie's lifetime, not necessarily the server's session lifetime. Could be weeks, could be less. The app must detect expiry and ask you, clearly, rather than failing silently.
*Risk:* low but not zero. Automated requests still originate from your account. The mitigation is behavioural — a slow cadence, an honest User-Agent, one section, no crawling outward — and that is designed in 18.5.

**Option C — the app performs the login itself, as you described.**
*Cost:* materially more engineering (18.5), plus a stored password.
*Risk:* the highest of the three, and it is the option that breaches `robots.txt`.
*My position:* I do not recommend it. If you direct it, I will design and build it — it is your account and your call — and 18.5 covers what it actually takes, so the choice is informed rather than theoretical.

**My recommendation: settle U7 first (18.6). If it confirms, take Option B. If you want Option C anyway, say so and I will build it — but I want your "yes" on the record, knowing the four objections in 18.3.**

### 18.5 If we proceed — the authentication architecture

Covering Option C properly, since that is what was asked for. Option B is a strict subset: everything below about session storage, expiry detection and failure surfacing applies to it too; only the login mechanics drop away.

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

### 18.6 Settle U7 first — the cheapest possible test

Before any of this is scoped, and it costs nothing:

1. **In your normal browser, logged in as you always are, visit `https://www.ozbargain.com.au/classified`.** If you see listings, U7 is confirmed and an account is sufficient. If you see "You do not have permission to access this page", then an account alone is **not** sufficient, R24 does not deliver R22, and the whole question is closed before a line is written.
2. **Then open the same URL in a private window** where you are logged out. You should see the 403 I reproduced. That confirms the account is the variable rather than something else.

Thirty seconds, no automation, no risk, and it either unblocks the work or saves all of it. **Please do this before answering D10.**

If step 1 shows listings and you want Option B, the third step is to copy the `PHPSESSID` cookie value out of your browser's developer tools — and at that point we will also learn empirically how long a session survives, which is the main unknown in Option B's running cost.

---

## 19. State — what the application must remember

New, and load-bearing. A delta cannot be computed without a previous value, so "what do we remember, and what happens when we forget" is a first-class design question rather than an implementation detail.

### 19.1 What must be remembered between polls

- **Per deal:** node ID (the natural key, stable and integer), title, URL, author, posted timestamp, categories, merchant URL, expiry, and the timestamp we first saw it.
- **Per deal, per poll:** an observation of `votes-pos`, `votes-neg`, `comment-count`, `click-count` with the time we observed it. **This is the only reason trend detection is possible at all.** Without a history there is no delta.
- **Front-page state:** whether the node has ever appeared in `/feed`, and **the time we first saw it there**. The feed's `pubDate` is the *original posting* time in both feeds — I checked all 20 overlapping items and they are identical — so OzBargain does not tell us when a deal was promoted. We only know it because we watched. If we forget, we can never recover it.
- **Watchlist and keyword terms,** with their matching options and optional pinned slug.
- **The alert ledger:** which (node, rule) pairs have already fired, and when. This is what stops the same deal alerting six polls running.
- **Per feed:** the last `ETag` and `Last-Modified`, so conditional requests work.
- **The last successful poll time,** which the dead-man's switch watches.

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

**Problem 2 — a watchlist term alerting on every repost.** OzBargain deals recur constantly: the same Steam freebie, the same Amazon price, reposted weekly. Matching on text means every repost is a new node ID, so the ledger above does not help — it is genuinely a different deal.

**DECISION — a per-term cooldown, default 24 hours, plus a repost check.** After a term fires, it will not fire again for 24 hours regardless of how many matching deals appear. Additionally, if a new deal's normalised title is very close to one already alerted on for that term within the last 30 days, suppress it as a repost and note it in the UI rather than notifying. Prior art supports the shape — `TT-RB/OzBargain_Scraper` uses a 3600-second per-user cooldown for the same reason — and I have set it longer because a watchlist term is a standing interest rather than a live feed.

**DECISION — cooldown is per term, configurable per term.** "ChatGPT" (R21) is a busy topic and may want 48 hours; "AMD R9700" (R20) is rare and you would want every single one, so it might be set to zero. A single global number cannot serve both, and getting this wrong in either direction is how people end up muting the whole tool.

**DECISION — group alerts within a poll.** If one poll produces five alerts, send one notification listing five deals, not five notifications. This is the difference between a useful tool and one you silence.

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

**One thing to verify.** The note passed to me says an ntfy instance is already running on this host for Uptime Kuma alerts. **That was not verified by me and is not in the verified-facts record in `BRIEF.md`.** If true, this is a near-zero-cost decision and the dead-man's switch can reuse the same infrastructure. If not, ntfy is another container to run. Worth thirty seconds to confirm before you commit to D13 — and I am flagging it precisely because it is the kind of convenient assumption that would otherwise get quietly baked in.

**DECISION — alert content, because this determines whether the tool is usable:** the deal title; the current net votes and vote rate; which rule fired and which term matched; and a click-through URL going **directly to the OzBargain node page**, not the `/goto/` redirect (that path is robots-disallowed and it is their affiliate tracker — we link to the discussion, you decide what to click). Front-page promotion alerts should say how long the deal took to get promoted, because that number is the actual signal and we are the only ones who know it.
