#!/bin/zsh
# Soak the gateway worker path and correlate against the heartbeat watchdog.
#
# Why: gateway.log shows a hidden worker's 2s heartbeat stopping for ~30s at a time. That proves
# the *signal* lapses; it does not prove whether *traffic* fails, because `is_available()` is only
# a proxy for "the webview can answer". /v1/models is answered entirely inside the worker
# (`router.listModels()`), so it is a direct probe of the thing that matters.
#
# Result of the reference run (900s): 25,367 requests at ~28/s, 100% HTTP 200, p50 6.3ms,
# p99 9.7ms, max 90.5ms, and ZERO watchdog fires — i.e. load prevents the lapse entirely.
#
# Emits TSV: epoch, http_code, time_total_s, tcp_connect_ok
set -u
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
OUT="$1"; DURATION="${2:-900}"
APP_DATA="$HOME/Library/Application Support/dev.aiprovider.router"

up() { nc -z -G 1 127.0.0.1 8787 >/dev/null 2>&1; }

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
  # Independent socket check: is the listener still bound while the beat is stale?
  if nc -z -G 2 127.0.0.1 8787 >/dev/null 2>&1; then TCP=1; else TCP=0; fi
  # 75s ceiling: long enough to straddle a full lapse plus recovery.
  RES=$(curl -s -o /dev/null --noproxy '*' --max-time 75 \
        -w '%{http_code} %{time_total}' \
        -H "Authorization: Bearer $KEY" \
        http://127.0.0.1:8787/v1/models 2>/dev/null)
  [ -z "$RES" ] && RES="000 0"
  # printf, not `print -r`: zsh's print writes a literal backslash-t, which silently turns the
  # whole file into one unparseable column. That cost me one analysis pass — check your own
  # instrumentation's output before trusting its verdict.
  printf '%s\t%s\t%s\n' "$TS" "${RES// /$'\t'}" "$TCP" >> "$OUT"
done
cp "$APP_DATA/gateway.log" "$OUT.log"
echo "SOAK_DONE elapsed=$(( $(date +%s) - START ))s"
