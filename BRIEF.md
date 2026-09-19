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
