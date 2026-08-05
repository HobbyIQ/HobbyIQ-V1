#!/usr/bin/env bash
# CF-CATALOG-XLSX-MATCH-ALL (Drew, 2026-08-05).
#
# Runs the xlsx identity-match pass over every year that has parsed
# xlsx data on disk. Fast — <1 min per year since we're already-
# scanned rows and doing point patches.
set -eu

if [ -z "${COSMOS_CONNECTION_STRING:-}" ]; then
  echo "ERROR: COSMOS_CONNECTION_STRING not set"; exit 2
fi

LOGDIR=/tmp/xlsx-match-$(date +%H%M%S)
mkdir -p "$LOGDIR"
XLSX_ROOT="${1:-c:/tmp/clc-xlsx-parsed}"

years=$(ls "$XLSX_ROOT" 2>/dev/null | grep -E '^\d{4}$' | sort -r)
if [ -z "$years" ]; then echo "No xlsx-parsed years at $XLSX_ROOT"; exit 1; fi

echo "==== xlsx identity match across $(echo $years | wc -w) years  $(date +%H:%M:%S) ===="
for y in $years; do
  echo "  y=$y  $(date +%H:%M:%S)"
  npx tsx backend/scripts/match-catalog-to-xlsx.ts --year "$y" --sport baseball > "$LOGDIR/xlsx-$y.log" 2>&1 || echo "  ! errored"
  summary=$(grep -oE "patched=[0-9]+, errors=[0-9]+" "$LOGDIR/xlsx-$y.log" | tail -1)
  echo "     ${summary:-no-summary}"
done
echo ""
echo "==== xlsx match DONE  $(date +%H:%M:%S) ===="
