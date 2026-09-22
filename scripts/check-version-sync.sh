#!/usr/bin/env bash
# Assert every manifest agrees on ONE product version.
#
# Why this exists: the version was stated in six places and two of them had drifted — the root
# `package.json` and both workspace packages still said 0.0.0 while the app said 1.0.0. Nothing
# caught it, because nothing ever read more than one file. A release is exactly the moment that
# drift becomes a shipped artefact whose version disagrees with its own tag.
#
# `tauri.conf.json` is the authority: it is what Tauri stamps onto the bundle and what the gateway
# reports. Everything else is asserted against it rather than the other way round.
set -euo pipefail
cd "$(dirname "$0")/.."

AUTHORITY="apps/desktop/src-tauri/tauri.conf.json"

json_version() {
  # `node -p` rather than jq: node is already a hard prerequisite of this workspace, jq is not.
  node -p "require('./$1').version"
}

WANT="$(json_version "$AUTHORITY")"
if [ -z "$WANT" ] || [ "$WANT" = "undefined" ]; then
  echo "FAIL: no version found in $AUTHORITY" >&2
  exit 1
fi

FAILED=0
check() {
  local file="$1" got="$2"
  if [ "$got" != "$WANT" ]; then
    printf 'FAIL %s says %s; %s says %s\n' "$file" "${got:-<none>}" "$AUTHORITY" "$WANT" >&2
    FAILED=1
  else
    printf 'ok   %-46s %s\n' "$file" "$got"
  fi
}

for f in package.json \
         apps/desktop/package.json \
         packages/router-core/package.json \
         packages/adapter-spec/package.json; do
  check "$f" "$(json_version "$f")"
done

# Cargo.toml is not JSON. Anchored to the `[package]` block specifically — a bare search for
# `version` would also match every dependency's version key and silently pick the wrong one.
CARGO_VERSION="$(
  sed -n '/^\[package\]/,/^\[/p' apps/desktop/src-tauri/Cargo.toml \
    | sed -n 's/^version *= *"\(.*\)"/\1/p' \
    | head -1
)"
check "apps/desktop/src-tauri/Cargo.toml" "$CARGO_VERSION"

if [ "$FAILED" -ne 0 ]; then
  echo >&2
  echo "Version drift. Bump $AUTHORITY and the manifests above together." >&2
  exit 1
fi
echo "all manifests agree on $WANT"
