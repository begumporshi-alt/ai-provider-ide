#!/usr/bin/env bash
# Release-artifact verifier — proves a built macOS bundle is Developer ID signed, hardened,
# and notarized, before anyone can download it.
#
# Why this exists: `release.yml` used to build and attach a draft without ever checking what it
# had produced. Without the Apple secrets, `tauri build` still *succeeds* and emits an **ad-hoc
# signed** app. An ad-hoc build is worse than no build: it launches locally (where Gatekeeper
# does not assess it) and is refused on a user's machine. Nothing in the pipeline noticed.
#
# The trap this script is built around, measured 2026-09-23 on macOS 15:
#
#   codesign --verify --strict --verbose=2 /tmp/adhoc-test.app
#     -> "/tmp/adhoc-test.app: valid on disk"
#     -> "satisfies its Designated Requirement"
#     -> exit 0
#
# An ad-hoc signature IS a valid signature. `codesign --verify` proves the seal is internally
# consistent, not that it came from a Developer ID. A verifier that stops there is decoration.
# The discriminators that actually separate the two states are `spctl` (exit 3 vs 0),
# `stapler validate` (exit 65 vs 0), the CodeDirectory flags word, and the Authority chain.
#
# Usage:
#   scripts/verify-release-signature.sh <path-to-.app-or-.dmg> [expected-team-id]
#   scripts/verify-release-signature.sh                 # discovers bundles under target/
#
# Exit 0 only if every check passes. Every failure is reported, not just the first.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

TARGET_PATH="${1:-}"
EXPECTED_TEAM="${2:-${APPLE_TEAM_ID:-}}"

# ---------------------------------------------------------------------------
# Discover the bundle when no path was given. The universal build writes under
# target/universal-apple-darwin/; a single-arch build under target/<triple>/.
# Glob rather than hardcode: the artifact name carries the product version, and
# a hardcoded name silently stops matching on the next version bump.
# ---------------------------------------------------------------------------
discover() {
  local found
  # `! -name 'rw.*'` is load-bearing. A failed DMG build leaves hdiutil's scratch
  # read-write images behind, named `rw.<pid>.<Product>_<version>_<arch>.dmg`, sitting
  # in bundle/macos/ next to the .app. Measured 2026-09-23 on this machine: 13 of them,
  # every one unsigned, which reported 35 bogus failures and buried the one real
  # finding. They are not release artifacts and must not be assessed as if they were.
  found=$(find "$REPO_ROOT/apps/desktop/src-tauri/target" -maxdepth 6 \
            -path '*/release/bundle/*' \( -name '*.app' -o -name '*.dmg' \) \
            ! -name 'rw.*' 2>/dev/null | sort || true)
  if [ -z "$found" ]; then
    echo "FAIL: no .app or .dmg found under apps/desktop/src-tauri/target/*/release/bundle/" >&2
    echo "      Run a bundle build first (pnpm --filter ai-provider-router-desktop tauri build)." >&2
    exit 2
  fi
  printf '%s\n' "$found"
}

if [ -z "$TARGET_PATH" ]; then
  # NOT `mapfile` — macOS ships bash 3.2, which does not have it, and this script
  # runs on a macOS runner. Measured 2026-09-23: `mapfile: command not found`
  # under /usr/bin/env bash here. The read loop is bash-3.2 compatible and, unlike
  # an unquoted `for x in $(...)`, survives the spaces in "AI-Provider Router.app".
  TARGETS=()
  while IFS= read -r line; do
    [ -n "$line" ] && TARGETS+=("$line")
  done < <(discover)
else
  TARGETS=("$TARGET_PATH")
fi

# ---------------------------------------------------------------------------
# Capture output and exit status without a pipeline. `cmd | head` reports head's
# status, and PIPESTATUS is empty in zsh — both produced meaningless exit codes
# while this script was being written, so exit status is captured directly.
# ---------------------------------------------------------------------------
RC=0
OUT=""
run() { RC=0; OUT=$("$@" 2>&1) || RC=$?; }

FAILURES=0
note()  { printf '  %s\n' "$1"; }
ok()    { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()   { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

verify_one() {
  local path="$1"
  local is_dmg=0
  case "$path" in *.dmg) is_dmg=1 ;; esac

  printf '\n== %s\n' "$path"

  if [ ! -e "$path" ]; then
    bad "path does not exist"
    return
  fi

  # --- 1. The seal is internally consistent. NECESSARY BUT NOT SUFFICIENT. ---
  # An ad-hoc signature passes this. Kept because a broken seal is a distinct
  # failure worth naming, and because the later checks assume a readable signature.
  run codesign --verify --deep --strict --verbose=2 "$path"
  if [ "$RC" -eq 0 ]; then
    ok "codesign --verify --deep --strict (seal is consistent)"
  else
    bad "codesign --verify --deep --strict failed (exit $RC)"
    printf '%s\n' "$OUT" | sed 's/^/        /'
  fi

  # --- 2. Signature details: authority, ad-hoc markers, hardened runtime, team. ---
  run codesign -dv --verbose=4 "$path"
  local details="$OUT"
  local details_rc="$RC"

  if [ "$details_rc" -ne 0 ]; then
    bad "codesign -dv could not read the signature (exit $details_rc)"
    return
  fi

  # 2a. Ad-hoc. Two independent markers; either one is disqualifying.
  if printf '%s\n' "$details" | grep -q '^Signature=adhoc'; then
    bad "ad-hoc signed (Signature=adhoc) — no Developer ID certificate was applied"
  elif printf '%s\n' "$details" | grep -Eq 'flags=0x[0-9a-f]+\([^)]*\badhoc\b'; then
    bad "ad-hoc signed (CodeDirectory flags carry the adhoc bit)"
  else
    ok "not ad-hoc signed"
  fi

  # 2b. Developer ID authority chain.
  local authority
  authority=$(printf '%s\n' "$details" | grep -m1 '^Authority=Developer ID Application:' || true)
  if [ -n "$authority" ]; then
    ok "${authority#Authority=}"
  else
    bad "no 'Authority=Developer ID Application:' in the signature"
  fi

  # 2c. Hardened runtime — the flag notarization requires. Assert the numeric
  #     bit (authoritative) rather than only the keyword inside the parentheses.
  local cd_line hex
  cd_line=$(printf '%s\n' "$details" | grep -m1 '^CodeDirectory' || true)
  hex=$(printf '%s' "$cd_line" | sed -n 's/.*flags=0x\([0-9a-fA-F]*\).*/\1/p')
  if [ -n "$hex" ] && [ "$(( 0x$hex & 0x10000 ))" -ne 0 ]; then
    ok "hardened runtime enabled (CodeDirectory flags 0x$hex)"
  else
    bad "hardened runtime NOT enabled (CodeDirectory flags=${hex:-unreadable}; bit 0x10000 clear)"
  fi

  # 2d. Team identifier present and, when known, correct.
  local team
  team=$(printf '%s\n' "$details" | sed -n 's/^TeamIdentifier=//p' | head -1)
  if [ -z "$team" ] || [ "$team" = "not set" ]; then
    bad "TeamIdentifier=${team:-<absent>} — an ad-hoc signature has no team"
  elif [ -n "$EXPECTED_TEAM" ] && [ "$team" != "$EXPECTED_TEAM" ]; then
    bad "TeamIdentifier=$team does not match the expected team $EXPECTED_TEAM"
  else
    ok "TeamIdentifier=$team"
  fi

  # --- 3. Gatekeeper assessment. This is the check that rejects ad-hoc. ---
  # -t exec for an .app, -t open for a disk image.
  local assess_type="exec"
  [ "$is_dmg" -eq 1 ] && assess_type="open"
  run spctl -a -vvv -t "$assess_type" "$path"
  if [ "$RC" -eq 0 ] && printf '%s\n' "$OUT" | grep -q 'accepted'; then
    ok "spctl accepted ($(printf '%s\n' "$OUT" | sed -n 's/^source=//p' | head -1))"
    if printf '%s\n' "$OUT" | grep -q 'source=Notarized Developer ID'; then
      ok "Gatekeeper reports 'Notarized Developer ID'"
    else
      bad "spctl accepted but not as 'Notarized Developer ID' — signed, not notarized"
    fi
  else
    bad "spctl rejected (exit $RC)"
    printf '%s\n' "$OUT" | sed 's/^/        /'
  fi

  # --- 4. The notarization ticket is stapled, so the app validates offline. ---
  run xcrun stapler validate "$path"
  if [ "$RC" -eq 0 ]; then
    ok "notarization ticket is stapled"
  else
    bad "no stapled notarization ticket (exit $RC)"
    printf '%s\n' "$OUT" | sed 's/^/        /'
  fi

  # --- 5. Every Mach-O *inside* the bundle carries the same signature. ---
  # Checks 1-4 all describe the bundle, which means they describe the *main* executable.
  # A second binary sitting beside it in Contents/MacOS/ is invisible to every one of them.
  #
  # Measured 2026-09-23: adding a second `[[bin]]` to the package makes `tauri build` copy it
  # into Contents/MacOS/ with nothing declaring it (dev-book §10 §2.1.1, deviation 4). Both
  # binaries then report `Signature=adhoc` / `TeamIdentifier=not set` on a dev build, and
  # `codesign -dv` on the .app reports only the main binary's signature.
  #
  # `--deep --strict` in check 1 is the only check that could reach it, and it cannot be shown
  # to: on this bundle it exits 1 for an unrelated reason ("code has no resources but signature
  # indicates they must be present") and its output is *byte-identical* whether the nested
  # binary is signed or has had its signature removed. Two failures masking each other, so the
  # nested state was never actually measured. Reading each Mach-O explicitly removes the doubt.
  #
  # What this does NOT do is replace notarization, which remains the primary guard: Apple's
  # notary service rejects a bundle containing improperly signed nested code, so an unsigned
  # second binary would fail the release anyway. This makes the verifier's own claim complete
  # and names the offending file, instead of leaving it to a notary error to explain.
  #
  # `find` rather than a hardcoded list: which binaries are in the bundle is a property of
  # Cargo.toml's `[[bin]]` section, and a hardcoded list silently stops covering the next
  # binary anyone adds — which is exactly how this gap opened.
  if [ "$is_dmg" -eq 0 ]; then
    while IFS= read -r nested; do
      [ -z "$nested" ] && continue
      # Only Mach-O carries a code signature worth reading; Info.plist and friends do not.
      case "$(file -b "$nested" 2>/dev/null)" in
        Mach-O*) : ;;
        *) continue ;;
      esac

      note "nested Mach-O: ${nested#$path/}"
      run codesign -dv --verbose=4 "$nested"
      if [ "$RC" -ne 0 ]; then
        bad "  no readable signature (exit $RC)"
        continue
      fi
      local ndetails="$OUT"

      if printf '%s\n' "$ndetails" | grep -q '^Signature=adhoc' \
         || printf '%s\n' "$ndetails" | grep -Eq 'flags=0x[0-9a-f]+\([^)]*\badhoc\b'; then
        bad "  ad-hoc signed — every Mach-O in the bundle needs the Developer ID signature"
      else
        ok "  not ad-hoc signed"
      fi

      if printf '%s\n' "$ndetails" | grep -q '^Authority=Developer ID Application:'; then
        ok "  Developer ID authority present"
      else
        bad "  no 'Authority=Developer ID Application:'"
      fi

      local ncd nhex
      ncd=$(printf '%s\n' "$ndetails" | grep -m1 '^CodeDirectory' || true)
      nhex=$(printf '%s' "$ncd" | sed -n 's/.*flags=0x\([0-9a-fA-F]*\).*/\1/p')
      if [ -n "$nhex" ] && [ "$(( 0x$nhex & 0x10000 ))" -ne 0 ]; then
        ok "  hardened runtime enabled (CodeDirectory flags 0x$nhex)"
      else
        bad "  hardened runtime NOT enabled (flags=${nhex:-unreadable}; bit 0x10000 clear)"
      fi
    done < <(find "$path/Contents/MacOS" "$path/Contents/Frameworks" -type f 2>/dev/null || true)
  fi
}

for t in "${TARGETS[@]}"; do
  verify_one "$t"
done

printf '\n'
if [ "$FAILURES" -eq 0 ]; then
  echo "verify-release-signature: OK — every artifact is Developer ID signed and notarized."
  exit 0
fi
echo "verify-release-signature: $FAILURES check(s) FAILED — do NOT publish this release." >&2
exit 1
