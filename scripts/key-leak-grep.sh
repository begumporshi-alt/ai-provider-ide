#!/usr/bin/env bash
# CI key-leak guard (acceptance criterion 5, ARCHITECTURE.md invariants 1-2).
# Fails if anything resembling a raw provider key literal appears in shipped source.
# Real provider keys must live only in the OS keychain, referenced by secretRef.
# Exemptions are PATH-based (test/fixture files only) — a substring filter would
# exempt any line containing "latest"/"greatest" (diff-review m7).
set -euo pipefail
cd "$(dirname "$0")/.."

STATUS=0

# sk-… style literals in shipped source; tests/fixtures may use obvious fakes.
HITS=$(grep -rnE 'sk-[A-Za-z0-9]{20,}' \
    --include='*.ts' --include='*.tsx' --include='*.rs' \
    --exclude='*.test.ts' --exclude='fakes.ts' --exclude='fakes.tsx' \
    --exclude-dir=node_modules --exclude-dir=target --exclude-dir=dist \
    apps packages scripts 2>/dev/null || true)
if [ -n "$HITS" ]; then
  echo "$HITS" >&2
  echo "ERROR: possible hard-coded API key literal found (above)" >&2
  STATUS=1
fi

# any file that writes a secret to disk from the TS layer
if grep -rn 'writeFile.*secret' apps packages --include='*.ts' --include='*.tsx' --exclude-dir=node_modules 2>/dev/null; then
  echo "ERROR: suspicious secret write found" >&2
  STATUS=1
fi

echo "key-leak-grep: OK"
exit $STATUS
