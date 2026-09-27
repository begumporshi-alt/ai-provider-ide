#!/bin/zsh
# Soak the gateway's request path and record latency percentiles.
#
# **Retargeted in 25f.** This script used to correlate traffic against the heartbeat watchdog: the
# gateway bridged into a hidden webview, `gateway.log` showed its 2s heartbeat stopping for ~30s at a
# time, and the question was whether the *signal* lapsing meant *traffic* failing — `is_available()`
# was only a proxy for "the webview can answer". That subsystem is gone. 25f deleted the webview, the
# beat, the watchdog and the `is_available()` gate, so there is nothing left to correlate against and
# no `is_available()` to disbelieve. The mechanism is kept because the question underneath it is still
# the one that matters: under sustained load, does the gateway answer every request, and how fast?
#
# The path under test is now Rust — `core/router_bridge.rs` behind `GatewayCore`, reached through the
# same socket, in both the app and `aiproviderd`. `/v1/models` is still the probe: it is the cheapest
# route that exercises the gateway's auth gate and its reply plumbing without spending provider tokens.
#
# Dated reference run (webview era, 900s): 25,367 requests at ~28/s, 100% HTTP 200, p50 6.3ms, p99
# 9.7ms, max 90.5ms, and ZERO watchdog fires — load prevented the lapse entirely. Kept as a
# comparison point, not a target: it measured a different implementation.
#
# **Retargeted again 2026-09-27 (port + recovery).** Two defects, and the first hid the second.
#   1. The script defaulted to port **8787**. The service listens on **8800**
#      (`SERVICE_DEFAULT_PORT`, `bin/aiproviderd.rs:35`; resolved at `:358` as
#      `persisted_gateway_port(&store).unwrap_or(SERVICE_DEFAULT_PORT)`). 8787 is the compiled-in
#      default of the *other* gateway (`core/gateway.rs:38`), not this one, and not the persisted
#      setting — so on a healthy machine the script declared the gateway down and then took a recovery
#      path that could not work either: `open -a "/Applications/AI-Provider Router.app"`, an app that
#      is not installed there. It failed loudly, but it failed on every run.
#   2. Once the port was right the loop actually ran, and the TSV it wrote was **unparseable**: the
#      row used `${RES// /$'\t'}`, and zsh does not expand `$'\t'` inside a parameter-expansion
#      replacement — it writes the five literal characters. Every row carried 3 tab-separated fields
#      against a 4-column header. The port bug had masked it by never letting the loop reach the
#      write. That is the same class of bug the `print -r` note further down warns about.
#
# The port now comes from `lib/gateway-port.sh` — one authority, shared with `repro-restore.sh`, which
# had the identical 8787 default. The recovery path now drives the supervisor that actually owns the
# listener (`launchd`, label `dev.aiprovider.router`, RunAtLoad + KeepAlive).
#
# Emits TSV: epoch, http_code, time_total_s, tcp_connect_ok
set -u
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
OUT="${1:-}"; DURATION="${2:-900}"; GW_PORT="${3:-}"
[ -z "$OUT" ] && { echo "usage: soak-gateway.sh <out.tsv> [duration_s] [port]" >&2; exit 2; }
# Sets APP_DATA, DB and GW_PORT. `$3` wins over the persisted setting, which wins over the constant.
. "${0:A:h}/lib/gateway-port.sh"

LAUNCHD_LABEL="dev.aiprovider.router"
APP_BUNDLE="/Applications/AI-Provider Router.app"
[ -d "$APP_BUNDLE" ] || APP_BUNDLE="$(dirname "$0")/../apps/desktop/src-tauri/target/release/bundle/macos/AI-Provider Router.app"

up() { nc -z -G 1 127.0.0.1 "$GW_PORT" >/dev/null 2>&1; }

# `launchctl print` is the probe that works. `launchctl list` prints NOTHING from a non-interactive
# shell here — measured 2026-09-27: 0 lines, and a control label whose plist is present returned
# nothing too, so an absence read off `launchctl list` is not evidence of absence. (`launchctl list`
# was in fact how the job was first misread as missing; the job is loaded and `state = running`.)
launchd_loaded() { launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1; }

if ! up; then
  echo "gateway down on :$GW_PORT — attempting recovery"
  if launchd_loaded; then
    # The listener is owned by launchd (RunAtLoad + KeepAlive), so kickstart is the targeted restart.
    # The old path `pkill -f "AI-Provider Router"` + `open -a` drove a GUI app that does not exist
    # here, and under KeepAlive a pkill would only have been undone by the supervisor anyway.
    echo "  $LAUNCHD_LABEL is loaded — kickstarting"
    launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
  elif [ -d "$APP_BUNDLE" ]; then
    echo "  no launchd job — opening $APP_BUNDLE"
    open "$APP_BUNDLE"
  else
    echo "  no launchd job, and no app bundle at $APP_BUNDLE" >&2
    echo "  start the service with:" >&2
    echo "    launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/$LAUNCHD_LABEL.plist" >&2
    exit 1
  fi
  for i in $(seq 1 75); do up && { echo "up after ${i}s"; break; }; sleep 1; done
fi
# Name the port in the failure. "NEVER CAME UP" without one sent the reader looking at the gateway
# instead of at the port it was aimed at.
up || { echo "GATEWAY NEVER CAME UP on :$GW_PORT after recovery attempt"; exit 1; }

# The master key is file-backed since 1.2.0 (increment 27a). The keychain item is **no longer read**
# by the app, and it still holds a *superseded* value — reading it here presented an obsolete
# credential, so every request answered `401 invalid gateway key` with nothing to point at.
KEY=$(python3 -c "import json;print(json.load(open('$APP_DATA/.secrets.json'))['masterkey'])")
START=$(date +%s)
: > "$OUT"
printf 'epoch\thttp\ttime_s\ttcp\n' >> "$OUT"

while [ $(( $(date +%s) - START )) -lt "$DURATION" ]; do
  TS=$(date +%s)
  # Independent socket check: the listener can stay bound while the request path is unhealthy, and
  # separating "bound" from "answering" is the one habit this script kept from its previous life.
  if nc -z -G 2 127.0.0.1 "$GW_PORT" >/dev/null 2>&1; then TCP=1; else TCP=0; fi
  RES=$(curl -s -o /dev/null --noproxy '*' --max-time 75 \
        -w '%{http_code} %{time_total}' \
        -H "Authorization: Bearer $KEY" \
        "http://127.0.0.1:$GW_PORT/v1/models" 2>/dev/null)
  [ -z "$RES" ] && RES="000 0"
  # Split into fields, then let printf own the tabs. Do NOT write `${RES// /$'\t'}`: zsh does not
  # expand `$'\t'` inside a parameter-expansion *replacement* — it inserts the five literal
  # characters `$'\t'`, so the row carries 3 tab-separated fields against a 4-column header and the
  # code column reads as `200$'\t'0.026336`. Verified at the byte level 2026-09-27: `od -c` showed
  # `$ ' \ t '` between code and time, and `awk -F'\t' '{print NF}'` gave 4 for the header and 3 for
  # every data row. Instrumentation is a claim too — od it, do not read it.
  IFS=' ' read -r CODE TIME <<< "$RES"
  [ -z "${TIME:-}" ] && TIME=0
  # printf, not `print -r`: zsh's print writes a literal backslash-t, which silently turns the
  # whole file into one unparseable column. That cost me one analysis pass — check your own
  # instrumentation's output before trusting its verdict.
  printf '%s\t%s\t%s\t%s\n' "$TS" "$CODE" "$TIME" "$TCP" >> "$OUT"
done
# `gateway.log` is the tool audit trail, not a liveness signal: the heartbeat lines it used to carry
# went with the webview in 25f. Copied alongside the run for tool-call correlation only.
cp "$APP_DATA/gateway.log" "$OUT.log" 2>/dev/null
echo "SOAK_DONE elapsed=$(( $(date +%s) - START ))s port=$GW_PORT"
