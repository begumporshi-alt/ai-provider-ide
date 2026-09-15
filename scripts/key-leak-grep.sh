#!/usr/bin/env bash
# CI key-leak guard (acceptance criterion 5 stub, ARCHITECTURE.md invariants 1-2).
# Fails if anything resembling a raw provider key literal appears in shipped source.
# Real provider keys must live only in the OS keychain, referenced by secretRef.
set -euo pipefail
cd "$(dirname "$0")/.."

STATUS=0

# sk-… style literals hard-coded in source (allow test fixtures that clearly fake them)
if grep -rnE 'sk-[A-Za-z0-9]{20,}' \
    --include='*.ts' --include='*.tsx' --include='*.rs' \
    apps packages src scripts 2>/dev/null \
    | grep -vE '(fake|test|dummy|example|placeholder)' ; then
  echo "ERROR: possible hard-coded API key literal found (above)" >&2
  STATUS=1
fi

# any file that writes a secret to disk from the TS layer
if grep -rn 'Deno.writeTextFile\|writeFile.*secret' apps packages 2>/dev/null | grep -v node_modules; then
  echo "ERROR: suspicious secret write found" >&2
  STATUS=1
fi

echo "key-leak-grep: OK"
exit $STATUS
