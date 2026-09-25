#!/usr/bin/env bash
#
# Gate: verify that the bundled `aiproviderd` does NOT link WebKit/wry/gtk.
#
# This is the fail-capable instrument D56 (dev-book) named: a check that can
# actually redden, replacing the BRE `grep -ci 'webkit|wry|gtk'` that printed
# 0 on any input.
#
# It runs `otool -L` on the bundled binary and exits non-zero if WebKit, wry,
# or gtk appear in the dylib list. Designed to be called from CI or locally
# after running `scripts/substitute-tauri-free-aiproviderd.sh`.
#
# Usage:
#   scripts/check-bundled-aiproviderd-links.sh
#
# Exit codes:
#   0  pass — no WebKit/wry/gtk linkage
#   2  fail — at least one of WebKit/wry/gtk is linked
#   3  binary not found

set -euo pipefail

SRCTAURI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../apps/desktop/src-tauri" && pwd)"
BUNDLE_BIN="$SRCTAURI_DIR/target/release/bundle/macos/AI-Provider Router.app/Contents/MacOS/aiproviderd"

if ! command -v otool &>/dev/null; then
    echo "ERROR: otool not found (this check requires macOS)." >&2
    exit 1
fi

if [ ! -f "$BUNDLE_BIN" ]; then
    echo "ERROR: $BUNDLE_BIN not found." >&2
    echo "Run 'pnpm tauri build' then 'scripts/substitute-tauri-free-aiproviderd.sh' first." >&2
    exit 3
fi

# The pattern is ERE (`-E`), so `|` is a real alternation and a WebKit match
# will actually count. BSD BRE `grep -c 'webkit\|wry\|gtk'` counts the literal
# string `webkit\|wry\|gtk`, which is what D56 flagged as a null instrument.
matches=$(otool -L "$BUNDLE_BIN" | grep -icE 'WebKit|wry|gtk' || true)

echo "==> otool -L on bundled aiproviderd"
echo "    Binary: $BUNDLE_BIN"
echo "    WebKit/wry/gtk dylib matches: $matches"

if [ "$matches" -ne 0 ]; then
    echo "FAIL: bundled aiproviderd still links WebKit/wry/gtk. The substitution did not run." >&2
    echo "The following lines are the offending matches:" >&2
    otool -L "$BUNDLE_BIN" | grep -iE 'WebKit|wry|gtk' >&2
    exit 2
fi

echo "PASS: bundled aiproviderd links no WebKit/wry/gtk."
