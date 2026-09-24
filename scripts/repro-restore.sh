#!/bin/zsh
# Measure how often the gateway fails to auto-restore on launch, and where it stops.
#
# Observed: the app comes up (DB opened, process alive) but `gateway_enable` never finishes —
# no socket, no "enabled on port" line. It happened on 3 of 5 launches. The staged logging
# ("enable: starting" / "enable: listener bound in Nms") says which step never completed, and the
# auto-restore marker says whether the task ran at all. **25f removed the middle stage** — the
# "worker window ready in Nms" line went with the worker window — so a stalled run now stalls
# between those two lines rather than at a window bring-up.
set -u
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
D="$HOME/Library/Application Support/dev.aiprovider.router"
OUT="$1"; ATTEMPTS="${2:-5}"

up() { nc -z -G 1 127.0.0.1 8787 >/dev/null 2>&1; }

: > "$OUT"
for i in $(seq 1 $ATTEMPTS); do
  pkill -f "AI-Provider Router" 2>/dev/null
  sleep 4
  BEFORE=$(wc -l < "$D/gateway.log")
  open -a "/Applications/AI-Provider Router.app"
  T0=$(date +%s)
  UP="no"
  for s in $(seq 1 60); do up && { UP="yes"; break; }; sleep 1; done
  T=$(( $(date +%s) - T0 ))
  {
    echo "=== attempt $i: up=$UP after ${T}s ==="
    awk -v s="$BEFORE" 'NR>s' "$D/gateway.log" | sed 's/^[0-9]* //' | head -8
  } >> "$OUT"
  echo "attempt $i up=$UP after ${T}s"
  # Leave it running briefly so the log settles before the next kill.
  sleep 2
done
echo "REPRO_DONE"
