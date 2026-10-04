#!/usr/bin/env bash
#
# One command: build `aiproviderd`, install it as the login-item gateway, then build and run the app.
#
# Why this exists. Building the app is not enough to test a change that touches Rust. The desktop
# app and the installed LaunchAgent resolve to the **same** data directory and the **same** port —
# `tauri.conf.json`'s `identifier` is what `app.path().app_data_dir()` returns, and the service
# computes the identical path from the same string (`bin/aiproviderd.rs`, `data_dir()`). So a
# service left running from older source keeps answering the app on `127.0.0.1:8800`, on every
# admin route, with no error. It just behaves like the old code — which is how a change that was
# built, tested and green looks broken on first run, with nothing in the logs to say why.
#
# This script closes that gap by making the two moves that matter: rebuild the service binary, and
# replace the *installed* copy rather than only the one in `target/`.
#
# Usage:
#   scripts/dev-up.sh                 build + install the service, then run the app (`pnpm dev`)
#   scripts/dev-up.sh --no-run        build + install the service only
#   scripts/dev-up.sh --release       build the packaged app (tauri build) and install from the
#                                     bundle; does not run a dev server
#   scripts/dev-up.sh --help
#
# Exit codes:
#   0  success
#   1  a precondition is missing (cargo, launchctl, node, or not macOS)
#   2  the service binary failed to build
#   3  the install failed
#   4  the install reported success but the job is not running
#
# Safe to re-run. Nothing is deleted: the binary and database being replaced are copied aside first
# with a timestamp, matching the `.bak-<ts>` convention the installer already keeps.

set -euo pipefail

RUN_APP=1
RELEASE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --no-run) RUN_APP=0 ;;
        --release) RELEASE=1; RUN_APP=0 ;;
        --help|-h)
            # The header comment is the usage text, so there is one copy of it. Printed by
            # structure (the leading `#` block after the shebang) rather than by line number,
            # which would silently truncate the moment a line is added above.
            awk 'NR>1 { if (/^#/) { sub(/^# ?/, ""); print } else exit }' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            echo "dev-up: unknown argument '$1' (try --help)" >&2
            exit 1
            ;;
    esac
    shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT/apps/desktop/src-tauri"

# `cargo` is not on the default PATH for a non-interactive shell here; `rustup` installs it under
# the home directory. Prepending is what makes this script work from a hook or a CI step.
export PATH="$HOME/.cargo/bin:$PATH"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[31mdev-up: %s\033[0m\n' "$1" >&2; exit "${2:-1}"; }

# ---------- preconditions ----------

[ "$(uname -s)" = "Darwin" ] || die "this script manages a macOS LaunchAgent" 1
for tool in cargo node; do
    command -v "$tool" >/dev/null 2>&1 || die "'$tool' is not on PATH" 1
done
[ -x /bin/launchctl ] || die "/bin/launchctl is missing" 1

# The identifier is read from the config rather than repeated here: it is the string that ties the
# app's data directory to the service's, and a second copy of it is a second chance to disagree.
IDENTIFIER="$(node -p "require('$TAURI_DIR/tauri.conf.json').identifier")"
[ -n "$IDENTIFIER" ] || die "could not read 'identifier' from tauri.conf.json" 1

DATA_DIR="${AIP_DATA_DIR:-$HOME/Library/Application Support/$IDENTIFIER}"
LABEL="$IDENTIFIER"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
TS="$(date +%Y%m%d-%H%M%S)"

echo "dev-up: identifier  $IDENTIFIER"
echo "         data dir    $DATA_DIR"
echo "         launchd job $DOMAIN/$LABEL"

# ---------- 1. build ----------

step "Building aiproviderd"
cd "$TAURI_DIR"

if [ "$RELEASE" -eq 1 ]; then
    # `--no-default-features` drops Tauri entirely, so the packaged gateway does not link WebKit.
    # That is the property `scripts/substitute-tauri-free-aiproviderd.sh` checks with `otool` after
    # `tauri build`; building it here means the same binary is what we install.
    cargo build --release --bin aiproviderd --no-default-features \
        || die "the service binary failed to build" 2
    SERVICE_BIN="$TAURI_DIR/target/release/aiproviderd"
else
    cargo build --bin aiproviderd || die "the service binary failed to build" 2
    SERVICE_BIN="$TAURI_DIR/target/debug/aiproviderd"
fi
[ -x "$SERVICE_BIN" ] || die "expected a binary at $SERVICE_BIN" 2

if [ "$RELEASE" -eq 1 ]; then
    step "Building the packaged app"
    # Addressed through the desktop package, not the workspace root: `@tauri-apps/cli` is a
    # dependency of `apps/desktop`, so the root has neither a `tauri` script nor a `tauri` binary
    # under `node_modules/.bin`, and `pnpm tauri build` there fails with `Command "tauri" not
    # found`. `--bundles app` is not optional either — the default set also asks for a DMG, which
    # needs `hdiutil` and fails in a sandboxed shell (recorded in `09-status.md`). This is the same
    # invocation `scripts/ci-local.sh` uses.
    ( cd "$ROOT" && pnpm --filter ai-provider-router-desktop tauri build --bundles app ) \
        || die "tauri build failed" 2
    bash "$ROOT/scripts/substitute-tauri-free-aiproviderd.sh" \
        || die "the tauri-free substitution failed" 2
    # Globbed rather than spelled out, so a change to `productName` cannot leave a second copy of
    # the name here to disagree with it — the same reason the identifier is read from the config.
    BUNDLE_APP="$(ls -d "$TAURI_DIR"/target/release/bundle/macos/*.app 2>/dev/null | head -1 || true)"
    [ -n "$BUNDLE_APP" ] \
        || die "tauri build produced no .app under $TAURI_DIR/target/release/bundle/macos" 2
    SERVICE_BIN="$BUNDLE_APP/Contents/MacOS/aiproviderd"
    [ -x "$SERVICE_BIN" ] || die "the bundle has no aiproviderd at $SERVICE_BIN" 2
fi

# ---------- 2. back up what is about to be replaced ----------

step "Backing up the installed binary and database"
mkdir -p "$DATA_DIR/bin"
if [ -f "$DATA_DIR/bin/aiproviderd" ]; then
    cp -p "$DATA_DIR/bin/aiproviderd" "$DATA_DIR/bin/aiproviderd.bak-$TS"
    echo "    binary -> bin/aiproviderd.bak-$TS"
fi
DB="$DATA_DIR/ai-provider-router.db"
DB_BAK="$DB.pre-install-$TS.bak"
if [ -f "$DB" ]; then
    # Taken **while the old service is still running**, so a plain `cp` of the `.db` would be a
    # copy of a database mid-transaction: recent commits live in `-wal`, and the copy would omit
    # them — the backup would look fine and be missing exactly the rows written most recently.
    # `.backup` takes a consistent snapshot of a live database. The three-file copy is the
    # fallback for a machine with no `sqlite3`, and is only correct as a *set*.
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$DB" ".backup '$DB_BAK'" || die "could not back up the database" 1
    else
        cp -p "$DB" "$DB_BAK"
        if [ -f "$DB-wal" ]; then cp -p "$DB-wal" "$DB_BAK-wal" || die "could not back up the WAL" 1; fi
        if [ -f "$DB-shm" ]; then cp -p "$DB-shm" "$DB_BAK-shm" || die "could not back up the SHM" 1; fi

# Rotate: one snapshot per dev-up run is one per rebuild, and each is a full database copy.
# Keep the newest ROTATE_KEEP of each kind — a backup that is never pruned is just a second
# data directory wearing a disguise (measured 2026-10-04: ~28 snapshots, ~80 MB).
ROTATE_KEEP=5
for pattern in "bin/aiproviderd.bak-*" "ai-provider-router.db.pre-install-*.bak"; do
    # shellcheck disable=SC2086
    ls -t "$DATA_DIR"/$pattern 2>/dev/null | tail -n +$((ROTATE_KEEP + 1)) | while IFS= read -r old; do
        rm -f "$old" && echo "    rotated $(basename "$old")"
    done
done
    fi
    echo "    database -> $(basename "$DB_BAK")"
fi

# ---------- 3. install ----------

step "Installing the service"

# Two paths, because `bootstrap` requires an **Aqua session** and a shell spawned by an editor,
# a CI job or an agent does not have one. `launchctl bootstrap` fails there with
# `5: Input/output error`, whose own text names the cause: "this process has no GUI session
# (Aqua)". The binary's `install` subcommand always does `bootout` then `bootstrap`, so on a
# machine where the job is already registered it would tear a working gateway down and then fail
# to put it back.
#
# When launchd already holds the label, neither call is needed: swap the binary and `kickstart`
# the job, which works from any session. `install` is used only for the first-time case, where
# there is no job to lose.
#
# The swap is a **rename, never a write in place**. `install` over the live path truncates and
# rewrites the very file the running job was started from, and macOS invalidates a running
# process's code signature the moment its on-disk image changes — the kernel then SIGKILLs it with
# `OS_REASON_CODESIGNING` (`launchctl print` shows `last exit reason = OS_REASON_CODESIGNING`, and
# AppKit files a report reading "Code Signature Invalid"). That is why every `dev-up.sh` run left
# a crash report behind while the gateway had in fact come up cleanly seconds later. A
# same-directory temp file plus `mv` is rename(2): the running process keeps the old inode, and the
# path points at a complete, correctly-signed file before launchd is asked to start it.
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    echo "    job is registered — swapping the binary and restarting it"
    NEW_BIN="$DATA_DIR/bin/.aiproviderd.new-$$"
    # The temp file is removed by the rename below; if `install` or `mv` dies mid-write, the EXIT
    # trap takes it with the script — a half-written dotfile next to the live binary is exactly
    # the kind of debris that outlives the run that made it.
    trap 'rm -f "$NEW_BIN"' EXIT
    install -m 755 "$SERVICE_BIN" "$NEW_BIN" \
        || die "could not write $NEW_BIN" 3
    mv -f "$NEW_BIN" "$DATA_DIR/bin/aiproviderd" \
        || die "could not replace $DATA_DIR/bin/aiproviderd" 3
    trap - EXIT
    launchctl kickstart -k "$DOMAIN/$LABEL" \
        || die "the job is registered but would not restart — see $DATA_DIR/aiproviderd.err.log" 3
else
    echo "    job is not registered — installing it from scratch"
    if ! INSTALL_OUT="$("$SERVICE_BIN" install 2>&1)"; then
        printf '%s\n' "$INSTALL_OUT" >&2
        if printf '%s' "$INSTALL_OUT" | grep -q "Aqua"; then
            die "registering a LaunchAgent needs a GUI session. Run this from Terminal.app, or
       use the app's Control screen, which is already in one. (Nothing was changed: there was
       no job to unload.)" 3
        fi
        die "the service install failed" 3
    fi
    printf '%s\n' "$INSTALL_OUT"
fi

# ---------- 4. verify the durable artifact, not the exit code ----------

step "Verifying"
# Polled, because `kickstart -k` reports `spawn scheduled` for a moment before `running`, and a
# one-shot read would call a healthy restart a failure. The `/health` probe is the half that
# matters: launchd can hold a job that is failing to bind the port, and the app would still be
# unable to reach it. `-f` is deliberate — a proxy answering `502` must not read as ready.
STATE=""
i=0
while [ "$i" -lt 15 ]; do
    STATE="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null \
        | sed -n 's/^[[:space:]]*state = //p' | head -1)"
    if [ "$STATE" = "running" ] && curl -fsS -o /dev/null "http://127.0.0.1:8800/health" 2>/dev/null; then
        break
    fi
    i=$((i + 1))
    sleep 1
done
echo "    launchd state: ${STATE:-<none>}"
echo "    /health:       $(curl -fsS -o /dev/null "http://127.0.0.1:8800/health" 2>/dev/null && echo reachable || echo NOT REACHABLE)"
[ "$STATE" = "running" ] || die "the job is not running — see $DATA_DIR/aiproviderd.err.log" 4
curl -fsS -o /dev/null "http://127.0.0.1:8800/health" 2>/dev/null \
    || die "the job is running but 127.0.0.1:8800 does not answer /health" 4

if command -v sqlite3 >/dev/null 2>&1 && [ -f "$DATA_DIR/ai-provider-router.db" ]; then
    # The running binary migrates the database on start. A green build says nothing about whether
    # it did, so the version is read back from the file the app will open.
    VERSION="$(sqlite3 "$DATA_DIR/ai-provider-router.db" \
        "SELECT version || ' ' || name FROM schema_version ORDER BY version DESC LIMIT 1;" 2>/dev/null || true)"
    echo "    schema:        ${VERSION:-<unreadable>}"
fi

echo
echo "dev-up: gateway is up on 127.0.0.1:8800 (log: $DATA_DIR/aiproviderd.log)"

# ---------- 5. run the app ----------

if [ "$RUN_APP" -eq 1 ]; then
    step "Starting the app (pnpm dev) — Ctrl-C to stop"
    cd "$ROOT"
    # `exec` so Ctrl-C reaches the dev server rather than stopping a wrapper that leaves it running.
    exec pnpm dev
fi

if [ "$RELEASE" -eq 1 ]; then
    step "Done — the packaged app is in $TAURI_DIR/target/release/bundle/macos"
fi
