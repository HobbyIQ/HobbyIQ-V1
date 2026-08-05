#!/usr/bin/env bash
# CF-BUILD-BASEBALL-TREE-MODERN (Drew, 2026-08-05).
#
# Runs the tree builder for baseball years 2020-2026 (already ran 2018
# separately as the pilot). At ~5 cards/sec observed and ~4-8K cards
# per year, expect ~2-3h wall total for the modern span.
#
# Expects COSMOS_CONNECTION_STRING already exported.

set -eu

if [ -z "${COSMOS_CONNECTION_STRING:-}" ]; then
  echo "ERROR: COSMOS_CONNECTION_STRING must be set" >&2
  exit 2
fi

LOGDIR=/tmp/tree-build-modern
mkdir -p "$LOGDIR"

echo "==== Modern baseball tree build (2020-2026) start $(date +%H:%M:%S) ===="
for y in 2020 2021 2022 2023 2024 2025 2026; do
  echo "  y=$y start $(date +%H:%M:%S)"
  TREE_YEAR=$y TREE_SPORT=baseball TREE_APPLY=true \
    npx tsx backend/scripts/build-tree-nodes.ts > "$LOGDIR/tree-$y.log" 2>&1
  last=$(grep -oE "Card docs: +[0-9]+" "$LOGDIR/tree-$y.log" | tail -1)
  variants=$(grep -oE "Variant docs: +[0-9]+" "$LOGDIR/tree-$y.log" | tail -1)
  grades=$(grep -oE "Grade docs: +[0-9]+" "$LOGDIR/tree-$y.log" | tail -1)
  echo "  y=$y done  $(date +%H:%M:%S) — $last, $variants, $grades"
done
echo "==== Modern baseball tree done $(date +%H:%M:%S) ===="
