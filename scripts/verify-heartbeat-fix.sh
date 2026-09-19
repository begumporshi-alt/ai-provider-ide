#!/bin/zsh
# End-to-end check of the heartbeat fix.
#
# Old behaviour: every ~8.5 idle minutes the watchdog logged
#   "watchdog: no heartbeat for Nms — re-warming worker window"
# and re-composited the window (a visible flash), forever.
#
# New behaviour under test:
#   1. exactly ONE "watchdog: worker beat stale for Nms — asleep, revives on the next request"
#      line per idle episode, and NO "re-warming" line at all
#   2. the first request after the idle period still succeeds, via await_core
set -u
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
D="$HOME/Library/Application Support/dev.aiprovider.router"
OUT="$1"; IDLE="${2:-620}"

up() { nc -z -G 1 127.0.0.1 8787 >/dev/null 2>&1; }

if ! up; then
  pkill -f "AI-Provider Router" 2>/dev/null; sleep 3
  open -a "/Applications/AI-Provider Router.app"
  for i in $(seq 1 75); do up && { echo "gateway up after ${i}s" | tee -a "$OUT"; break; }; sleep 1; done
fi
up || { echo "GATEWAY NEVER CAME UP"; exit 1; }

: >> "$OUT"
BEFORE=$(wc -l < "$D/gateway.log")
echo "log_lines_before=$BEFORE" >> "$OUT"
echo "idle_start=$(date +%s)" >> "$OUT"

START=$(date +%s)
while [ $(( $(date +%s) - START )) -lt "$IDLE" ]; do
  # Whole-tail grep: the watchdog's new line is a single line, but the OLD one came in a
  # pair, and `tail -1` missed it because of that. Match the window, not the last line.
  if tail -6 "$D/gateway.log" | grep -q "beat stale"; then
    echo "stale_logged_after=$(( $(date +%s) - START ))s" >> "$OUT"
    break
  fi
  sleep 5
done
echo "idle_elapsed=$(( $(date +%s) - START ))" >> "$OUT"

KEY=$(security find-generic-password -s ai-provider-router -a masterkey -w)
for i in 1 2 3; do
  curl -s -o /dev/null --noproxy '*' --max-time 75 \
    -w "post_idle_request_${i} http=%{http_code} time=%{time_total}\n" \
    -H "Authorization: Bearer $KEY" http://127.0.0.1:8787/v1/models >> "$OUT"
  sleep 1
done

echo "--- new log lines ---" >> "$OUT"
awk -v s="$BEFORE" 'NR>s' "$D/gateway.log" >> "$OUT"
echo "VERIFY_DONE"
