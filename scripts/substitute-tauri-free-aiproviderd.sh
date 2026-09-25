#!/usr/bin/env bash
#
# Phase 6 step 2 build step — close the gap 26r left open.
#
# `tauri build` compiles the app with default features (i.e. with Tauri + WebKit).
# The bundled `aiproviderd` it places in `Contents/MacOS/` is therefore the
# Tauri-linked binary. This script:
#   1. builds the Tauri-free `aiproviderd` (no `app` feature) in release mode,
#   2. verifies with `otool -L` that it does NOT link WebKit/wry/gtk,
#   3. substitutes it into the `.app` bundle,
#   4. re-verifies the substituted binary one more time.
#
# Run this AFTER `pnpm tauri build`. It is a build step, not a gate — CI can
# call it and let the two `otool` checks be the guard, or a developer can call
# it locally before packaging.
#
# Usage:
#   scripts/substitute-tauri-free-aiproviderd.sh
#
# Exit codes:
#   0  success — the bundled `aiproviderd` is the Tauri-free binary
#   1  build failure
#   2  otool check failed — WebKit leaked into the Tauri-free binary
#   3  bundle not found — `tauri build` was not run (or its output was cleaned)
#   4  substitution failed

set -euo pipefail

SRCTAURI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../apps/desktop/src-tauri" && pwd)"
BUNDLE_DIR="$SRCTAURI_DIR/target/release/bundle/macos"
APP_NAME="AI-Provider Router.app"

cd "$SRCTAURI_DIR"

if ! command -v otool &>/dev/null; then
    echo "ERROR: otool not found (this script requires macOS)." >&2
    exit 1
fi

if [ ! -d "$BUNDLE_DIR" ]; then
    echo "ERROR: $BUNDLE_DIR not found." >&2
    echo "Run 'pnpm tauri build' first, then re-run this script." >&2
    exit 3
fi

# ---------------------------------------------------------------------------
# 1. Build both variants, snapshotting the Tauri-free one before the
#    default-features build clobbers the shared target/release binary.
# ---------------------------------------------------------------------------
echo "==> Building Tauri-free aiproviderd (--no-default-features)"
cargo build --no-default-features --release --bin aiproviderd

FREE_BIN="$SRCTAURI_DIR/target/release/aiproviderd"
# `otool -L` lists every linked dylib/framework. A WebKit line proves the
# binary links WebKit directly; wry/gtk are the two platform crates that
# would pull WebKit into a build that should not link it.
matches_free=$(otool -L "$FREE_BIN" | grep -icE 'WebKit|wry|gtk' || true)
if [ "$matches_free" -ne 0 ]; then
    echo "ERROR: Tauri-free aiproviderd still links WebKit/wry/gtk." >&2
    echo "The following lines should be empty:" >&2
    otool -L "$FREE_BIN" | grep -iE 'WebKit|wry|gtk' >&2
    echo "This is a regression — the --no-default-features build must not link WebKit." >&2
    exit 2
fi
# Snapshot it: the next build writes to the same target path.
cp "$FREE_BIN" "${FREE_BIN}.tauri-free"
echo "==> Tauri-free build verified: WebKit/wry/gtk link count = $matches_free (must be 0)"

# Default-features build for the contrast. It reuses the cached Tauri crates;
# only the final link differs, so it is cheap when the default build is current.
echo "==> Building default-features aiproviderd (for contrast)"
cargo build --release --bin aiproviderd
matches_default=$(otool -L "$SRCTAURI_DIR/target/release/aiproviderd" | grep -icE 'WebKit|wry|gtk' || true)

echo "==> WebKit/wry/gtk link counts:"
echo "    Tauri-free:       $matches_free        (must be 0)"
echo "    default-features: $matches_default     (should be >= 1 — confirms the contrast)"

# ---------------------------------------------------------------------------
# 3. Substitute into the bundle
# ---------------------------------------------------------------------------
TARGET="$BUNDLE_DIR/$APP_NAME/Contents/MacOS/aiproviderd"
if [ ! -f "$TARGET" ]; then
    echo "ERROR: $TARGET not found." >&2
    echo "Expected the 'tauri build' output at: $TARGET" >&2
    exit 3
fi

cp "${FREE_BIN}.tauri-free" "$TARGET"
chmod +x "$TARGET"
rm -f "${FREE_BIN}.tauri-free"

# ---------------------------------------------------------------------------
# 4. Re-verify the substituted binary
# ---------------------------------------------------------------------------
matches_target=$(otool -L "$TARGET" | grep -icE 'WebKit|wry|gtk' || true)
echo "==> Bundled aiproviderd (post-substitution) WebKit/wry/gtk matches: $matches_target"
if [ "$matches_target" -ne 0 ]; then
    echo "ERROR: substitution produced a WebKit-linked binary." >&2
    otool -L "$TARGET" | grep -iE 'WebKit|wry|gtk' >&2
    exit 4
fi

echo ""
echo "OK — bundled aiproviderd is Tauri-free."
echo "    Source: $SRCTAURI_DIR/target/release/aiproviderd"
echo "    Bundle: $TARGET"
echo "    WebKit link count: $matches_target"
