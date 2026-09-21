# syntax=docker/dockerfile:1
#
# OzBargain Hunter (design 2.2, 10.4, 10.6). One container running two
# long-lived processes — the Next.js server and the poller — supervised by
# docker-entrypoint.sh. There are no sidecars and no separate database: the
# SQLite file lives on the bind mount at /data.
#
# Build:
#   docker build -t ozbargainhunter:local .
# Run (the same shape the Unraid template uses):
#   docker run -d --name OzBargainHunter \
#     -p 8000:8000 -v /mnt/user/appdata/ozbargain-hunter:/data \
#     -e OZB_HEALTHCHECK_SECRET=… ozbargainhunter:local

# ---------------------------------------------------------------------------
# Stage 1 — dependencies and the Next.js build.
#
# The image is built from the committed lockfile (`npm ci`), so the image and CI
# resolve identical dependencies (10.4). The standalone output is the artefact
# the runtime stage carries forward: the server, its traced node_modules and the
# static assets, without the build toolchain.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS builder

WORKDIR /app

# Dependencies first: this layer is only invalidated by a lockfile change.
COPY package.json package-lock.json ./
RUN npm ci

# Then the source. `.dockerignore` keeps the context to the files the build
# needs, so a local .next/ or node_modules/ cannot leak into the image.
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# `next.config.mjs` sets `output: 'standalone'`; this is the same invocation CI
# job 2 and the integration suite use.
RUN node ./node_modules/next/dist/bin/next build

# ---------------------------------------------------------------------------
# Stage 2 — runtime.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

# OCI labels (10.4). `org.opencontainers.image.source` ties the package to the
# repository, which is what makes GHCR link the two.
LABEL org.opencontainers.image.source="https://github.com/jamesgallagher/OzBargainHunter" \
      org.opencontainers.image.title="OzBargain Hunter" \
      org.opencontainers.image.description="Personal deal and classifieds watcher for OzBargain: a Next.js UI and a poll loop in one container." \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.version="1.0.0"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8000 \
    HOSTNAME=0.0.0.0 \
    OZB_DB_PATH=/data/ozbargain.db \
    OZB_SNAPSHOT_PATH=/data/ozbargain-snapshot.db

WORKDIR /app

# The worker's runtime dependencies. The Next.js server carries its own traced
# node_modules inside the standalone output; the worker (which is deliberately
# not part of the server's module graph — design 2.2, the architecture guard)
# needs the production dependencies too, notably nodemailer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The standalone server, its static assets, and the worker with the library
# code it imports. Nothing is written inside the container: the SQLite database
# and the snapshot both live on /data (10.6).
COPY --from=builder --chown=node:node /app/.next/standalone/ ./
COPY --from=builder --chown=node:node /app/.next/static/ ./.next/static/
COPY --from=builder --chown=node:node /app/lib/ ./lib/
COPY --from=builder --chown=node:node /app/worker/ ./worker/
COPY --from=builder --chown=node:node /app/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# The bind mount is the deployment's data directory, but the image must also be
# runnable on its own (a smoke run with no -v). /data belongs to the non-root
# user; a reviewer deploying on Unraid must make the host directory writable by
# uid 1000 — the container never runs as root, so it cannot chown the mount.
RUN mkdir -p /data && chown node:node /data && chmod 0755 /usr/local/bin/docker-entrypoint.sh

# The application binds 8000 inside the container (the worker binds no port).
EXPOSE 8000

# The health check authenticates with the container-local secret (D62) and
# reports on *acquisition* health, not process liveness: /healthz stays 503
# until a poll has succeeded (3.7). `node` is used rather than wget/curl so the
# check cannot be broken by a missing busybox applet; the start period is long
# enough for the first poll cycle.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/healthz',{headers:{'x-healthcheck-secret':process.env.OZB_HEALTHCHECK_SECRET||''}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Non-root (uid 1000). The entrypoint supervises both children as this user.
USER node

VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
