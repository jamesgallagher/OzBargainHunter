#!/bin/sh
#
# The supervisor (design 2.2, 6.7). This script is the whole reason the
# application is one container with two processes rather than two containers.
#
# The runtime is two long-lived processes:
#
#   1. the Next.js server — the web UI and its routes, and nothing else;
#   2. the worker (`worker/main.js`) — the poll loop, the rules engine and the
#      notifier, which run whether or not anybody is looking at the UI.
#
# Both share one SQLite database and nothing else; there is no socket, queue or
# RPC between them (2.2).
#
# The failure this script exists to prevent: a container with a live UI and a
# dead poller. From the outside that is indistinguishable from a quiet day —
# no alerts, no errors, a web page that loads — and the user only discovers it
# when they miss a deal (6.7). So:
#
#   * SIGTERM and SIGINT are forwarded to *both* children, so `docker stop`
#     shuts both down cleanly and the SQLite file is closed;
#   * the moment *either* child exits on its own, the survivor is stopped and
#     this script exits non-zero, so Docker's restart policy brings the whole
#     application back.
#
# It is POSIX sh: the runtime image is Alpine, whose shell is busybox ash. There
# is no `wait -n` here, so the first exit is detected by polling the children
# with `kill -0` on a one-second beat.
#
# The two commands are overridable through the environment
# (`OZB_NEXT_SERVER_CMD`, `OZB_WORKER_CMD`) purely so the supervisor can be
# exercised without Docker: the integration suite runs this script with two
# throwaway children and asserts the signal forwarding and the non-zero exit.
# The defaults are what the image runs.

set -eu

NEXT_SERVER_CMD="${OZB_NEXT_SERVER_CMD:-node /app/server.js}"
WORKER_CMD="${OZB_WORKER_CMD:-node /app/worker/main.js}"
POLL_INTERVAL_SECONDS="${OZB_SUPERVISOR_POLL_SECONDS:-1}"

log() {
  printf '%s supervisor: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

NEXT_PID=''
WORKER_PID=''
SIGNALLED=''
SERVER_DEAD='0'
WORKER_DEAD='0'

forward_shutdown() {
  signal="$1"
  SIGNALLED="$signal"
  log "received $signal: forwarding to the Next.js server (pid ${NEXT_PID:-none}) and the worker (pid ${WORKER_PID:-none})"
  if [ -n "$NEXT_PID" ]; then
    kill -"$signal" "$NEXT_PID" 2>/dev/null || true
  fi
  if [ -n "$WORKER_PID" ]; then
    kill -"$signal" "$WORKER_PID" 2>/dev/null || true
  fi
}

trap 'forward_shutdown TERM' TERM
trap 'forward_shutdown INT' INT

# Both children inherit this script's stdout/stderr, so `docker logs` shows the
# interleaved log of both processes — which is what makes a dead poller visible
# in the container's own log.
$NEXT_SERVER_CMD &
NEXT_PID=$!

$WORKER_CMD &
WORKER_PID=$!

log "started the Next.js server (pid $NEXT_PID) and the worker (pid $WORKER_PID)"

while :; do
  if ! kill -0 "$NEXT_PID" 2>/dev/null; then
    SERVER_DEAD='1'
    break
  fi
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    WORKER_DEAD='1'
    break
  fi
  if [ -n "$SIGNALLED" ]; then
    # A deliberate stop: let both children finish, then exit 0. A forwarded
    # signal is not a failure, and reporting it as one would make every
    # deployment look like a crash.
    wait "$NEXT_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
    log "both children stopped after $SIGNALLED; exiting 0"
    exit 0
  fi
  sleep "$POLL_INTERVAL_SECONDS"
done

# A child exited on its own. Reap it for its status, take the survivor down, and
# exit non-zero so Docker restarts the container.
if [ "$SERVER_DEAD" = '1' ]; then
  DEAD_NAME='the Next.js server'
  SURVIVOR_NAME='the worker'
  SURVIVOR_PID="$WORKER_PID"
  DEAD_PID="$NEXT_PID"
else
  DEAD_NAME='the worker'
  SURVIVOR_NAME='the Next.js server'
  SURVIVOR_PID="$NEXT_PID"
  DEAD_PID="$WORKER_PID"
fi

STATUS=0
wait "$DEAD_PID" 2>/dev/null || STATUS=$?
if [ "$STATUS" -eq 0 ]; then
  # Exited 0 but on its own: still a failure of the supervised pair, so a
  # non-zero container exit is what makes Docker act.
  STATUS=1
fi

log "$DEAD_NAME exited on its own (status $STATUS); stopping $SURVIVOR_NAME (pid $SURVIVOR_PID) so Docker restarts the container"
kill -TERM "$SURVIVOR_PID" 2>/dev/null || true
wait "$SURVIVOR_PID" 2>/dev/null || true

log "exiting non-zero ($STATUS) so the container is restarted"
exit "$STATUS"
