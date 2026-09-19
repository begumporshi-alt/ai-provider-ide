#!/bin/zsh
# Idle-trigger test.
#
# The 900s soak proved the worker never lapses while it is being asked to work.
# gateway.log proves it lapses ~484s after it stops being asked. This measures the
# cost of that: sit idle, then fire the first request and time it.
#
# Probing repeatedly would reset the very idle clock under test, so the idle phase is
# passive (tail the log only) and exactly one burst of requests follows it.
set -u
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
D="$HOME/Library/Application Support/dev.aiprovider.router"
OUT="$1"; IDLE="${2:-500}"

KEY=$(security find-generic-password -s ai-provider-router -a masterkey -w)
probe() { # $1 = label
  curl -s -o /dev/null --noproxy '*' --max-time 75 -w "$1 http=%{http_code} time=%{time_total}\n" \
    -H "Authorization: Bearer $KEY" http://127.0.0.1:8787/v1/models
}

: > "$OUT"
echo "idle_phase_start=$(date +%s)" >> "$OUT"
echo "log_lines_before=$(wc -l < "$D/gateway.log")" >> "$OUT"

# Passive watch: does the watchdog fire while we are deliberately not touching it?
#
# Grep the whole tail window, not `tail -1`: a watchdog fire writes TWO lines (the fire, then
# "worker reported in ..."), so `tail -1 | grep -q watchdog` never matches. That bug is why the
# reference run's burst landed 22s *after* a re-warm instead of inside the silence.
START=$(date +%s)
while [ $(( $(date +%s) - START )) -lt "$IDLE" ]; do
  tail -6 "$D/gateway.log" | grep -q watchdog && {
    echo "watchdog_fired_during_idle=$(date +%s)" >> "$OUT"
    break
  }
  sleep 5
done
echo "idle_elapsed=$(( $(date +%s) - START ))" >> "$OUT"

# Now the first request in ~8 minutes. This is the user-visible cost.
for i in 1 2 3; do probe "burst${i}" >> "$OUT" 2>&1; sleep 1; done
echo "--- log tail ---" >> "$OUT"
tail -4 "$D/gateway.log" >> "$OUT"
echo "IDLE_TEST_DONE"
