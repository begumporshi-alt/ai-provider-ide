#!/bin/zsh
# One authority for "what port is the gateway on". Sourced, not executed.
#
# **The live port is the authority, not the constant.** `gateway::DEFAULT_PORT` is 8787
# (`apps/desktop/src-tauri/src/core/gateway.rs:38`), but the actual binding is
# `settings.gateway.port`, which is **8800** on this machine because AI Hub v2 also claims 8787.
# `aiproviderd` resolves it as `persisted_gateway_port(&store).unwrap_or(SERVICE_DEFAULT_PORT)`
# (`bin/aiproviderd.rs:358`); any script that has to *reach* the listener must resolve it the same
# way. A hardcoded 8787 does not fail to find the gateway — it dials whatever else holds 8787, or
# nothing, and then reports the gateway as down on a healthy machine.
#
# This lesson was already written down twice — `docs/dev-book/10-headless-service.md` (§ "a port this
# app has never bound, while DEFAULT_PORT is 8787 … the live port is the authority") and
# `docs/COUNT_TOKENS_PLAN.md:148` ("a hardcoded 8787 targets whatever else holds that port"). The
# scripts simply did not follow it; `soak-gateway.sh` and `repro-restore.sh` both defaulted to 8787
# until 2026-09-27. Kept in one file so a third script cannot drift the same way.
#
# Requires: `sqlite3` and `python3` on PATH. Both are already hard dependencies of
# `measure-gateway-latency.mjs` (sqlite3) and `soak-gateway.sh` (python3, for the master key).
#
# Sets: APP_DATA, DB, GW_PORT. Honours a pre-set GW_PORT (a CLI override from the caller).

# AIP_DATA_DIR is what the launchd job exports (`~/Library/LaunchAgents/dev.aiprovider.router.plist`),
# so honour it: the script should look where the service looks.
APP_DATA="${AIP_DATA_DIR:-$HOME/Library/Application Support/dev.aiprovider.router}"
DB="$APP_DATA/ai-provider-router.db"

# 8800 = SERVICE_DEFAULT_PORT (`bin/aiproviderd.rs:35`). Reached only when the setting is
# unreadable — never as a first choice, and never as a guess about configuration.
GW_PORT="${GW_PORT:-}"
if [ -z "$GW_PORT" ]; then
  GW_PORT=$(sqlite3 "$DB" "SELECT value_json FROM settings WHERE key='gateway';" 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('port') or '')" 2>/dev/null)
fi
[ -z "$GW_PORT" ] && GW_PORT=8800
