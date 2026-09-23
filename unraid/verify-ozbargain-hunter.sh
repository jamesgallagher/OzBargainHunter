#!/bin/sh
# verify-ozbargain-hunter.sh — host-side verifier for the Unraid deployment.
#
# Run from the repository:
#   ssh -i <key> root@<host> 'sh -s' < unraid/verify-ozbargain-hunter.sh
#
# Prints one PASS/FAIL/NOTE line per criterion and exits 0 iff every required
# criterion passes. It is strictly read-only: it never reads, prints, or
# compares a secret value, and it never inspects masked (credential) fields.
# The deployed template is a configured dockerMan host template (dockerMan
# re-serializes it and the Sponsor sets masked values in the GUI), so this
# verifier checks SEMANTIC deployment fields only — never a byte or hash
# identity with the repository template.
#
# Health is a required post-credential invariant. The verifier reads only
# .State.Health.Status, waits at most 360 seconds in fixed short intervals,
# and fails unless it reaches exactly "healthy". It never reads the health
# command, the health log, the container environment, a request header, or a
# secret. Docker's own "healthy" result is the credential-free proof that the
# image healthcheck received a successful /healthz response.
set -u

C=0
F=0
ok()  { C=$((C+1)); printf 'PASS: %s\n' "$1"; }
bad() { F=$((F+1)); printf 'FAIL: %s\n' "$1"; }
note(){ printf 'NOTE: %s\n' "$1"; }

T=/boot/config/plugins/dockerMan/templates-user/my-ozbargain-hunter.xml
N=ozbargain-hunter
HEALTH_WAIT_SECONDS=360
HEALTH_INTERVAL_SECONDS=5

# Semantic Config check: the deployed template is re-serialized by dockerMan,
# so attribute order and spacing are not a stable invariant. Each Config is
# one line; match the Target attribute and the element content on the same
# line with a tolerant pattern. The content is anchored to the closing
# </Config> tag (the content is the text immediately before it), so a literal
# ">" inside a Description attribute cannot create a false boundary. This
# never selects or counts masked (credential) fields.
cfg() { grep -Eq "Target=\"$1\".*>$2</Config>" "$T"; }

# 1. The deployed user template exists, is well-formed XML, and its stem and
#    Name bind to the canonical container name.
if [ -f "$T" ]; then
  ok "template present at $T"
  STEM=$(basename "$T" .xml)
  [ "$STEM" = "$N" ] && ok "template file stem binds to $N" || bad "template file stem binds to $N (got ${STEM:-none})"

  # Well-formedness: prefer xmllint, fall back to python3/python. If neither
  # is available the check is reported as a NOTE (not a failure) — the
  # semantic field checks below are the load-bearing contract.
  if command -v xmllint >/dev/null 2>&1; then
    if xmllint --noout "$T" >/dev/null 2>&1; then
      ok "deployed template is well-formed XML"
    else
      bad "deployed template is well-formed XML"
    fi
  elif command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
    PY=$(command -v python3 || command -v python)
    if "$PY" -c 'import sys,xml.dom.minidom;xml.dom.minidom.parse(sys.argv[1])' "$T" >/dev/null 2>&1; then
      ok "deployed template is well-formed XML"
    else
      bad "deployed template is well-formed XML"
    fi
  else
    note "no XML parser available on host; well-formedness not checked"
  fi

  grep -q '<Name>ozbargain-hunter</Name>' "$T" && ok "template Name is ozbargain-hunter" || bad "template Name is ozbargain-hunter"
  grep -q '<Repository>ghcr.io/jamesgallagher/ozbargainhunter:latest</Repository>' "$T" && ok "template Repository is ghcr.io/jamesgallagher/ozbargainhunter:latest" || bad "template Repository is ghcr.io/jamesgallagher/ozbargainhunter:latest"
  grep -q '<Network>bridge</Network>' "$T" && ok "template network is bridge" || bad "template network is bridge"
  cfg '8000' '7171' && ok "template maps host 7171 to container 8000" || bad "template maps host 7171 to container 8000"
  cfg '/data' '/mnt/user/appdata/ozbargain-hunter/' && ok "template mounts /mnt/user/appdata/ozbargain-hunter/ at /data" || bad "template mounts /mnt/user/appdata/ozbargain-hunter/ at /data"
  grep -q '<ExtraParams>--restart unless-stopped</ExtraParams>' "$T" && ok "template ExtraParams carries --restart unless-stopped" || bad "template ExtraParams carries --restart unless-stopped"
  cfg 'TZ' 'Australia/Sydney' && ok "template sets TZ=Australia/Sydney" || bad "template sets TZ=Australia/Sydney"
  cfg 'CF_ACCESS_TEAM_DOMAIN' 'tailormade.cloudflareaccess.com' && ok "template CF_ACCESS_TEAM_DOMAIN is tailormade.cloudflareaccess.com" || bad "template CF_ACCESS_TEAM_DOMAIN is tailormade.cloudflareaccess.com"
  grep -q '<Icon>https://raw.githubusercontent.com/jamesgallagher/OzBargainHunter/main/assets/logo/icon-1024.png</Icon>' "$T" && ok "template uses the canonical public icon URL" || bad "template uses the canonical public icon URL"
else
  bad "template present at $T"
fi

# 2. Persistent host directory contract.
if [ -d /mnt/user/appdata/ozbargain-hunter ]; then
  OW=$(stat -c '%u:%g' /mnt/user/appdata/ozbargain-hunter)
  [ "$OW" = "1000:1000" ] && ok "appdata /mnt/user/appdata/ozbargain-hunter owned 1000:1000" || bad "appdata /mnt/user/appdata/ozbargain-hunter owned 1000:1000 (got $OW)"
else
  bad "appdata /mnt/user/appdata/ozbargain-hunter exists"
fi

# 3. Running dockerMan-managed runtime contract.
if docker inspect "$N" >/dev/null 2>&1; then
  ok "container $N exists"

  MANAGED=$(docker inspect -f '{{index .Config.Labels "net.unraid.docker.managed"}}' "$N")
  [ "$MANAGED" = "dockerman" ] && ok "container is GUI-managed by dockerMan" || bad "container is GUI-managed by dockerMan (got ${MANAGED:-none})"

  IMG=$(docker inspect -f '{{.Config.Image}}' "$N")
  [ "$IMG" = "ghcr.io/jamesgallagher/ozbargainhunter:latest" ] && ok "container image is ghcr.io/jamesgallagher/ozbargainhunter:latest" || bad "container image is ghcr.io/jamesgallagher/ozbargainhunter:latest (got $IMG)"

  NET=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$N")
  [ "$NET" = "bridge" ] && ok "container runtime network is bridge" || bad "container runtime network is bridge (got ${NET:-none})"

  RP=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$N")
  [ "$RP" = "unless-stopped" ] && ok "container restart policy is unless-stopped" || bad "container restart policy is unless-stopped (got $RP)"

  P=$(docker inspect -f '{{range (index .NetworkSettings.Ports "8000/tcp")}}{{.HostPort}}{{"\n"}}{{end}}' "$N")
  printf '%s\n' "$P" | grep -qx '7171' && ok "container publishes host 7171 to container 8000" || bad "container publishes host 7171 to container 8000"

  M=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$N")
  [ "$M" = "/mnt/user/appdata/ozbargain-hunter" ] && ok "container mounts /mnt/user/appdata/ozbargain-hunter at /data" || bad "container mounts /mnt/user/appdata/ozbargain-hunter at /data (got ${M:-none})"

  ST=$(docker inspect -f '{{.State.Status}}' "$N")
  if [ "$ST" = "running" ]; then
    ok "container is running"
  else
    bad "container is running (status=${ST:-unknown})"
  fi

  # 4. Health is a required post-credential invariant. Read ONLY the health
  #    status; wait at most HEALTH_WAIT_SECONDS in fixed short intervals and
  #    fail unless it reaches exactly "healthy". A permanently "starting" or
  #    "unhealthy" container fails the feature. No permanent pre-credential exception.
  ELAPSED=0
  HS=""
  while [ "$ELAPSED" -lt "$HEALTH_WAIT_SECONDS" ]; do
    HS=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$N")
    [ "$HS" = "healthy" ] && break
    sleep "$HEALTH_INTERVAL_SECONDS"
    ELAPSED=$((ELAPSED + HEALTH_INTERVAL_SECONDS))
  done
  if [ "$HS" = "healthy" ]; then
    ok "container health=healthy"
  else
    bad "container health=healthy (status=${HS:-unknown} after ${HEALTH_WAIT_SECONDS}s)"
  fi

  if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | awk '{print $4}' | grep -Eq '(^|[:.])7171$'; then
    ok "host has a TCP listener on port 7171"
  else
    bad "host has a TCP listener on port 7171"
  fi

  HTTP_CODE=$(curl -sS -o /dev/null --max-time 10 -w '%{http_code}' http://127.0.0.1:7171/ 2>/dev/null || true)
  case "$HTTP_CODE" in
    2??|3??|401|403) ok "application responds on http://127.0.0.1:7171/ (HTTP $HTTP_CODE)" ;;
    *) bad "application responds on http://127.0.0.1:7171/ (HTTP ${HTTP_CODE:-none})" ;;
  esac

  # Supervisor startup evidence: one log line containing BOTH markers.
  if docker logs "$N" 2>&1 | grep -F 'supervisor: started the Next.js server' | grep -Fq 'and the worker'; then
    ok "container log records supervisor starting the Next.js server and worker"
  else
    bad "container log records supervisor starting the Next.js server and worker"
  fi
else
  bad "container $N exists"
fi

# 5. Unraid autostart contract.
if grep -qx "$N" /var/lib/docker/unraid-autostart 2>/dev/null; then
  ok "autostart lists $N"
else
  bad "autostart lists $N"
fi

printf 'SUMMARY: %d passed, %d failed\n' "$C" "$F"
[ "$F" -eq 0 ]
