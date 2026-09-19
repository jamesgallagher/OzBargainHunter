# OzBargain Hunter — Design

**Author:** design lane (Claude Opus 5)
**Date:** 19 September 2026 (AEST)
**Status:** Draft for James's approval. Nothing has been built. No files other than this one have been created.
**Input:** `BRIEF.md` in this repository, which records James's requirements verbatim plus environment facts that were each verified by running a command.

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

## 1. Executive summary — the five things I would change

If you read nothing else, read this. These are the points where the brief, implemented literally, produces something other than what you asked for.

1. **"GitHub builds it, then Unraid pulls it down" describes a push. It will be a pull.** GitHub has no way to reach into your Unraid host, and giving it one would directly violate your own "no back door" requirement. Unraid finds out about new images by *polling* the registry. The loop closes, but on a timer you set, not the instant the build goes green. Section 4.

2. **Tagging every build `latest` destroys your ability to roll back and removes the gate between "I committed something" and "it is in production".** You are a Scrum Master; this is the part to look hardest at. As written, a commit at 11pm on a Tuesday becomes the running production container with no acceptance step and no named version to go back to. My counter-proposal keeps your words almost intact but adds an immutable tag per build and a deliberate promotion step. Section 5.

3. **"Nothing reachable by a back door without coming through Cloudflare Tunnel" is not achievable in your current topology, and the reason is structural, not a misconfiguration.** Your tunnel forwards *everything* to a reverse proxy on a **different machine** (`192.168.0.173`). For that proxy to reach a container on `192.168.0.148`, the container must publish a LAN-reachable port — which is exactly the back door you want closed. The proxy gets in the same way any device on your LAN gets in. There is a clean fix, and it involves editing the single ingress rule that currently serves *every* public hostname you own. Section 7.

4. **A JWT you check in your own app is not the same thing as an edge gate, and you can have the stronger one for less work.** Cloudflare Access sits in front of the hostname, authenticates against an identity provider, and hands your app a signed JWT on every request. Your app verifies it. That literally satisfies "enforce a JWT on each page", gives you MFA for free, means you never store a password or a signing key, and means an unauthenticated request never reaches your code at all. Building your own login page is more work and strictly weaker. Section 7.

5. **Your existing Unraid templates point `<Icon>` at the app's own public URL. Combine that with "JWT on every page" and the Unraid dashboard will show a broken image**, because the icon request gets redirected to a login screen. Host the icon out of the repository instead. Section 9. This is small, but it is a good illustration of requirements R3, R8 and R9 colliding in a way nobody notices until it is live.

---

## 2. The product surface — deliberately unfinished

**OPEN — and this is the largest open item in the document.**

The application premise has not been supplied. James has said it arrives in a later message. I am not going to invent one, because a plausible guess here would silently set the data model, the storage requirements, the external network egress, the auth granularity and the port layout, and every one of those would then be quietly wrong.

What stays undecided until the premise lands:

- What the app actually does, and therefore what "a page" is.
- Whether it has persistent state at all, and if so whether that is a file, SQLite, or a database container.
- Whether it makes outbound network calls (scraping, APIs, notifications) and to where. This matters for egress rules and for rate-limit/etiquette questions against any third-party site.
- Whether it needs scheduled background work (a scraper loop, a digest email) or is purely request-driven. Background work changes the container's restart behaviour and its health check.
- Whether there is more than one user, or one class of user. Everything in section 7 assumes a small, known set of humans — if this needs public signup, section 7 changes completely and Cloudflare Access is the wrong tool.
- The runtime and language. Nothing below depends on it, deliberately.

What is decidable *without* the premise, and is decided below: the repository layout, the build and publish pipeline, the tagging scheme, the host update mechanism, the exposure path, the access-control architecture, and the logo asset pipeline. That is the whole of this document, and it is why this stage is useful even with a hole in the middle of it.

**One thing I will flag now rather than later.** "OzBargain" is a live third-party brand — ozbargain.com.au. If this application consumes that site, then naming the project after it, publishing the image publicly on GHCR, and putting a logo on it are three separate decisions that each carry a small trademark and terms-of-use question. I am not a lawyer and this is not a refusal; it is a thing you should decide knowingly rather than discover. It also interacts with the public/private repository decision in section 8. Listed as **OPEN** in section 14 (D9).

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

- `/mnt/user/appdata/ozbargain-hunter/` → a path inside the container, exact target **OPEN** until the premise lands (section 2).

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

**OPEN — dependency and image scanning.** Trivy or Dependabot would be sensible additions. I have not decided because it depends on the language and dependency surface, which depends on the premise. Not blocking; revisit after the premise.

### 8.6 Repository layout

**DECISION** — at the point where building starts, which is not now:

- `design.md` — this file
- `BRIEF.md` — the requirements record
- `README.md`
- `.github/workflows/` — build and publish
- `Dockerfile`
- `unraid/my-OzBargainHunter.xml` — canonical template (section 6.6)
- `assets/logo/` — logo sources and exports (section 9)
- application source, layout **OPEN** pending the premise

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

**OPEN — what the mark actually depicts.** I am not designing the mark before I know what the application does. A logo that means nothing is worse than a placeholder, because it gets used and then never revisited. Until then, a plain monogram or solid-colour placeholder is fine and honest.

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

---

## 12. Staged plan

Each stage ends at a human approval gate. No stage starts before the previous one is signed off.

- **Stage 0 — now.** This document. Nothing built. Awaiting your review and your answers in section 14.
- **Stage 1 — probes.** Run P1–P8. Report raw output. Update this document's OPEN items with facts. Still nothing built.
- **Stage 2 — the pipeline skeleton.** Repository created, remote added, a trivial "hello" container, Dockerfile, build workflow, tagging scheme, GHCR publish. **The entire delivery loop is proven with a placeholder application before any product code exists.** This is deliberate: it means when the real app arrives, the delivery path is already known-good and any failure is unambiguously in the app. Ends with the section 10 acceptance test passing.
- **Stage 3 — exposure and access control.** Hostname, ingress edit, Cloudflare Access application, JWT verification in the placeholder app, Unraid template, logo. Ends with the section 10 access-control test passing.
- **Stage 4 — the actual product.** Requires the premise (section 2). Not designed. Not estimated.

**The case for building Stage 2 against a placeholder app**, since it may look like busywork: it separates "is my delivery pipeline correct?" from "is my application correct?". Debug those together and every failure has two possible causes. Debug them apart and every failure has one. It also means the first time you push real product code, it deploys to your house automatically and correctly, which is a good day.

---

## 13. What is blocking

In order of how much they block.

- **B1 — the application premise (R15).** Blocks Stage 4 entirely, and blocks several specifics in earlier stages: the volume mount target, whether there is a database, egress requirements, the logo's subject matter. Stages 1 through 3 can proceed without it. You have said it is coming.
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
- **R14 — Produce `design.md`, no build.** Done. This file is the only thing created. No Dockerfile, no workflow, no scaffolding, no application code.
- **R15 — Premise supplied later.** Respected. Section 2 is a marked placeholder and I have not invented a product to fill it.
