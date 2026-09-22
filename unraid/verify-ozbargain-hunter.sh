#!/bin/sh
# verify-ozbargain-hunter.sh — host-side verifier for the Unraid deployment.
#
# Run from the repository:
#   ssh -i <key> root@<host> 'sh -s' < unraid/verify-ozbargain-hunter.sh
#
# Prints one PASS/FAIL/NOTE line per criterion and exits 0 iff every required
# criterion passes. It never reads or prints a secret value: masked template
# fields are tested only for emptiness.
set -u

C=0
F=0
ok()  { C=$((C+1)); printf 'PASS: %s\n' "$1"; }
bad() { F=$((F+1)); printf 'FAIL: %s\n' "$1"; }
note(){ printf 'NOTE: %s\n' "$1"; }

T=/boot/config/plugins/dockerMan/templates-user/my-ozbargain-hunter.xml
N=ozbargain-hunter
# SHA256 of the repository template at the same revision as this verifier.
EXPECTED_TEMPLATE_SHA256=5cf4bc5e88c68f945210b1129a945bddbbe4d86525b064ba3929df3fb602da52

# 1. The deployed user template is the exact repository template.
if [ -f "$T" ]; then
  ok "template present at $T"
  ACTUAL_TEMPLATE_SHA256=$(sha256sum "$T" | awk '{print $1}')
  if [ "$ACTUAL_TEMPLATE_SHA256" = "$EXPECTED_TEMPLATE_SHA256" ]; then
    ok "deployed template is byte-identical to repository template ($EXPECTED_TEMPLATE_SHA256)"
  else
    bad "deployed template is byte-identical to repository template (expected $EXPECTED_TEMPLATE_SHA256, got $ACTUAL_TEMPLATE_SHA256)"
  fi
else
  bad "template present at $T"
fi

# 2. Template contract and empty masked fields.
if [ -f "$T" ]; then
  grep -q '<Name>ozbargain-hunter</Name>' "$T" && ok "template Name is ozbargain-hunter" || bad "template Name is ozbargain-hunter"
  grep -q '<Repository>ghcr.io/jamesgallagher/ozbargainhunter:latest</Repository>' "$T" && ok "template Repository is ghcr.io/jamesgallagher/ozbargainhunter:latest" || bad "template Repository is ghcr.io/jamesgallagher/ozbargainhunter:latest"
  grep -q '<Network>bridge</Network>' "$T" && ok "template network is bridge" || bad "template network is bridge"
  grep -q 'Target="8000"[^>]*>7171<' "$T" && ok "template maps host 7171 to container 8000" || bad "template maps host 7171 to container 8000"
  grep -q 'Target="/data"[^>]*>/mnt/user/appdata/ozbargain-hunter/<' "$T" && ok "template mounts /mnt/user/appdata/ozbargain-hunter/ at /data" || bad "template mounts /mnt/user/appdata/ozbargain-hunter/ at /data"
  grep -q '<ExtraParams>--restart unless-stopped</ExtraParams>' "$T" && ok "template ExtraParams carries --restart unless-stopped" || bad "template ExtraParams carries --restart unless-stopped"
  grep -q 'Target="TZ"[^>]*>Australia/Sydney<' "$T" && ok "template sets TZ=Australia/Sydney" || bad "template sets TZ=Australia/Sydney"
  grep -q 'Target="CF_ACCESS_TEAM_DOMAIN"[^>]*>tailormade.cloudflareaccess.com<' "$T" && ok "template CF_ACCESS_TEAM_DOMAIN is tailormade.cloudflareaccess.com" || bad "template CF_ACCESS_TEAM_DOMAIN is tailormade.cloudflareaccess.com"
  grep -q '<Icon>https://raw.githubusercontent.com/jamesgallagher/OzBargainHunter/main/assets/logo/icon-256.png</Icon>' "$T" && ok "template uses the canonical public icon URL" || bad "template uses the canonical public icon URL"

  NONEMPTY=$(sed -n 's/.*<Config[^>]*Mask="true"[^>]*>\(.*\)<\/Config>.*/\1/p' "$T" | grep -c '.' || true)
  if [ "$NONEMPTY" -eq 0 ]; then
    ok "no value in any Mask=true Config element"
  else
    bad "no value in any Mask=true Config element (found $NONEMPTY non-empty)"
  fi
fi

# 3. Persistent host directory contract.
if [ -d /mnt/user/appdata/ozbargain-hunter ]; then
  OW=$(stat -c '%u:%g' /mnt/user/appdata/ozbargain-hunter)
  [ "$OW" = "1000:1000" ] && ok "appdata /mnt/user/appdata/ozbargain-hunter owned 1000:1000" || bad "appdata /mnt/user/appdata/ozbargain-hunter owned 1000:1000 (got $OW)"
else
  bad "appdata /mnt/user/appdata/ozbargain-hunter exists"
fi

# 4. Running dockerMan-managed runtime contract.
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
    HS=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$N")
    note "container health=$HS (pre-credential health may be unhealthy until the Sponsor sets masked secrets in the GUI)"
  else
    bad "container is running (status=${ST:-unknown})"
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
