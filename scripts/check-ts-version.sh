#!/usr/bin/env bash
# Audit R6 guard: one TypeScript compiler across the whole workspace.
#
# Matching the versions by hand is not enough — nothing stops them drifting apart again, and
# the failure mode is silent: everything typechecks locally, then behaves differently per
# package. This asserts every workspace package declares the SAME pinned version, and that the
# lockfile resolves to exactly one TypeScript.
set -euo pipefail
cd "$(dirname "$0")/.."

STATUS=0

# Every package.json in the workspace that declares typescript at all.
MAP=$(find apps packages -name package.json -not -path '*/node_modules/*' -print0 |
  xargs -0 node -e '
    const fs = require("fs");
    const out = [];
    for (const f of process.argv.slice(1)) {
      const p = JSON.parse(fs.readFileSync(f, "utf8"));
      const v = (p.devDependencies && p.devDependencies.typescript) ||
                (p.dependencies && p.dependencies.typescript);
      if (v) out.push([f, v]);
    }
    for (const [f, v] of out) console.log(v + "\t" + f);
  ')

if [ -z "$MAP" ]; then
  echo "check-ts-version: no package declares typescript — is this still a TS workspace?" >&2
  exit 1
fi

# Distinct declared versions.
VERSIONS=$(echo "$MAP" | cut -f1 | sort -u)
COUNT=$(echo "$VERSIONS" | wc -l | tr -d ' ')

if [ "$COUNT" -ne 1 ]; then
  echo "$MAP" >&2
  echo "ERROR: TypeScript version split across the workspace ($COUNT distinct):" >&2
  echo "$VERSIONS" | sed 's/^/  - /' >&2
  STATUS=1
else
  V="$VERSIONS"
  echo "check-ts-version: all packages declare typescript $V"

  # Pinned exactly? A range (^/~) lets the resolved versions drift even when the
  # declarations match, which is the same bug one level down.
  case "$V" in
    ^*|~*|'*'|'>'*|'<'*) 
      echo "ERROR: typescript must be pinned exactly (got '$V'); ranges re-introduce drift" >&2
      STATUS=1
      ;;
  esac

  # The lockfile must resolve to that one version and no other.
  LOCKED=$(grep -oE '^  typescript@[0-9]+\.[0-9]+\.[0-9]+:' pnpm-lock.yaml |
    sed -E 's/^  typescript@//; s/:$//' | sort -u || true)
  LOCKCOUNT=$(echo "$LOCKED" | grep -c . || true)
  if [ "$LOCKCOUNT" -ne 1 ] || [ "$LOCKED" != "$V" ]; then
    echo "ERROR: pnpm-lock.yaml resolves TypeScript to [$LOCKED], expected only $V" >&2
    STATUS=1
  fi
fi

exit $STATUS
