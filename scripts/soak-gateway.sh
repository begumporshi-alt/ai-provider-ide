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
# Emits TSV: epoch, http_code, time_total_s, tcp_connect_ok
set -u
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
OUT="$1"; DURATION="${2:-900}"; PORT="${3:-8787}"
APP_DATA="$HOME/Library/Application Support/dev.aiprovider.router"

up() { nc -z -G 1 127.0.0.1 "$PORT" >/dev/null 2>&1; }

if ! up; then
  echo "gateway down — launching"
  pkill -f "AI-Provider Router" 2>/dev/null; sleep 3
  open -a "/Applications/AI-Provider Router.app"
  for i in $(seq 1 75); do up && { echo "up after ${i}s"; break; }; sleep 1; done
fi
up || { echo "GATEWAY NEVER CAME UP"; exit 1; }

KEY=$(security find-generic-password -s ai-provider-router -a masterkey -w)
START=$(date +%s)
: > "$OUT"
printf 'epoch\thttp\ttime_s\ttcp\n' >> "$OUT"

while [ $(( $(date +%s) - START )) -lt "$DURATION" ]; do
  TS=$(date +%s)
  # Independent socket check: the listener can stay bound while the request path is unhealthy, and
  # separating "bound" from "answering" is the one habit this script kept from its previous life.
  if nc -z -G 2 127.0.0.1 "$PORT" >/dev/null 2>&1; then TCP=1; else TCP=0; fi
  RES=$(curl -s -o /dev/null --noproxy '*' --max-time 75 \
        -w '%{http_code} %{time_total}' \
        -H "Authorization: Bearer $KEY" \
        "http://127.0.0.1:$PORT/v1/models" 2>/dev/null)
  [ -z "$RES" ] && RES="000 0"
  # printf, not `print -r`: zsh's print writes a literal backslash-t, which silently turns the
  # whole file into one unparseable column. That cost me one analysis pass — check your own
  # instrumentation's output before trusting its verdict.
  printf '%s\t%s\t%s\n' "$TS" "${RES// /$'\t'}" "$TCP" >> "$OUT"
done
# `gateway.log` is the tool audit trail, not a liveness signal: the heartbeat lines it used to carry
# went with the webview in 25f. Copied alongside the run for tool-call correlation only.
cp "$APP_DATA/gateway.log" "$OUT.log" 2>/dev/null
echo "SOAK_DONE elapsed=$(( $(date +%s) - START ))s"
