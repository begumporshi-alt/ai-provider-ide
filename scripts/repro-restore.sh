#!/bin/zsh
# Measure how often the gateway fails to auto-restore on launch, and where it stops.
#
# Observed (webview era): the app comes up (DB opened, process alive) but `gateway_enable` never
# finishes — no socket, no "enabled on port" line. It happened on 3 of 5 launches. The staged logging
# ("enable: starting" / "enable: listener bound in Nms") says which step never completed, and the
# auto-restore marker says whether the task ran at all. **25f removed the middle stage** — the
# "worker window ready in Nms" line went with the worker window — so a stalled run now stalls
# between those two lines rather than at a window bring-up.
#
# **Retargeted 2026-09-27.** This script had three defects that together made it measure nothing and
# report success:
#   1. `up()` probed port **8787**. The service listens on **8800**. Now resolved through
#      `lib/gateway-port.sh`, the same authority `soak-gateway.sh` uses.
#   2. `pkill -f "AI-Provider Router"` **matches nothing** — the process is `aiproviderd`, and the
#      pattern is case- and hyphen-sensitive (`pgrep -f "AI-Provider Router"` → exit 1, measured
#      2026-09-27; `pgrep -f aiproviderd` → the pid). So nothing was killed, the listener never went
#      down, and the wait loop reported `up=yes after 1s` on every attempt — attributing a no-op to a
#      successful restore. That is a fabricated verdict, which is worse than a crash.
#   3. `open -a "/Applications/AI-Provider Router.app"` opens an app that is not installed there.
#
# **And the mechanism changed under it.** The listener is now owned by launchd
# (`~/Library/LaunchAgents/dev.aiprovider.router.plist`, RunAtLoad + KeepAlive), so "does it
# auto-restore" is answered by the *supervisor*, not by the app's launch path. The kill is therefore
# `launchctl kill SIGKILL` against the job — the faithful analogue of the old `pkill`: it stops the
# process and lets the supervisor's own policy decide whether it comes back. `kickstart -k` would be
# wrong here; it *forces* the restart and so destroys the very question this script asks.
# The open question — whether a Tauri-era `gateway_enable` stall can still occur in a launchd-owned
# process, and whether `gateway.log` still carries the markers this script greps for — is left for a
# human to decide. Do not read a green run as evidence that the old race is fixed.
set -u
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
OUT="${1:-}"; ATTEMPTS="${2:-5}"; GW_PORT="${3:-}"
[ -z "$OUT" ] && { echo "usage: repro-restore.sh <out.txt> [attempts] [port]" >&2; exit 2; }
. "${0:A:h}/lib/gateway-port.sh"   # sets APP_DATA, DB, GW_PORT

LAUNCHD_LABEL="dev.aiprovider.router"
APP_BUNDLE="/Applications/AI-Provider Router.app"
[ -d "$APP_BUNDLE" ] || APP_BUNDLE="$(dirname "$0")/../apps/desktop/src-tauri/target/release/bundle/macos/AI-Provider Router.app"

up() { nc -z -G 1 127.0.0.1 "$GW_PORT" >/dev/null 2>&1; }
# `launchctl print`, not `launchctl list`: the latter prints 0 lines from a non-interactive shell
# here (measured 2026-09-27), so an absence read off it is not evidence of absence.
launchd_loaded() { launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1; }

if ! launchd_loaded && [ ! -d "$APP_BUNDLE" ]; then
  echo "neither the launchd job nor an app bundle at $APP_BUNDLE exists — nothing to restart" >&2
  exit 1
fi

: > "$OUT"
for i in $(seq 1 $ATTEMPTS); do
  if launchd_loaded; then
    launchctl kill SIGKILL "gui/$(id -u)/$LAUNCHD_LABEL"   # KeepAlive decides whether it returns
  else
    pkill -f aiproviderd 2>/dev/null                       # the name that actually matches
  fi
  sleep 4
  BEFORE=$(wc -l < "$APP_DATA/gateway.log" 2>/dev/null || echo 0)
  # Only the non-launchd path needs an explicit launch. When the supervisor owns the process,
  # opening the bundle as well would start a *second* instance and corrupt the measurement.
  launchd_loaded || open "$APP_BUNDLE" 2>/dev/null
  T0=$(date +%s)
  UP="no"
  for s in $(seq 1 60); do up && { UP="yes"; break; }; sleep 1; done
  T=$(( $(date +%s) - T0 ))
  {
    echo "=== attempt $i: up=$UP after ${T}s (port $GW_PORT) ==="
    awk -v s="$BEFORE" 'NR>s' "$APP_DATA/gateway.log" 2>/dev/null | sed 's/^[0-9]* //' | head -8
  } >> "$OUT"
  echo "attempt $i up=$UP after ${T}s"
  # Leave it running briefly so the log settles before the next kill.
  sleep 2
done
echo "REPRO_DONE"
