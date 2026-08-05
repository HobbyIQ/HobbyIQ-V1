#!/usr/bin/env bash
# CF-CATALOG-MULTISPORT (Drew, 2026-08-05).
#
# Bulk-build catalog rows for football + basketball + pokemon parity
# with baseball. sold_comps has ~400K football, ~386K basketball, ~157K
# pokemon rows; canonical catalog entries lag most of those, so the
# sold-comps → catalog linkage rate for non-baseball is worse than
# baseball. This run closes that gap.
#
# Modern era only (2010+) — most non-baseball transaction volume is in
# modern cards, and running vintage would spend RUs without matching
# many pool tuples. Add older decades later if needed.
#
# 3-year batches in parallel. Idempotent upserts.

set -eu

if [ -z "${COSMOS_CONNECTION_STRING:-}" ]; then
  echo "ERROR: COSMOS_CONNECTION_STRING must be set" >&2
  exit 2
fi

LOGDIR=/tmp/bulk-all-multisport
mkdir -p "$LOGDIR"

run_year() {
  local sport=$1
  local y=$2
  echo "  [$sport y=$y] start $(date +%H:%M:%S)"
  npx tsx backend/scripts/bulk-build-catalog.ts --year "$y" --sport "$sport" --auto-approve \
    > "$LOGDIR/bulk-$sport-$y.log" 2>&1
  local last
  last=$(grep -oE "upserted [0-9]+, err [0-9]+ \([0-9]+/[0-9]+\)" "$LOGDIR/bulk-$sport-$y.log" | tail -1)
  echo "  [$sport y=$y] done  $(date +%H:%M:%S) — $last"
}

run_batch() {
  local sport=$1
  shift
  local years=("$@")
  echo "== [$sport] Batch [${years[*]}] start $(date +%H:%M:%S) =="
  local pids=()
  for y in "${years[@]}"; do
    run_year "$sport" "$y" &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p"; done
  echo "== [$sport] Batch done $(date +%H:%M:%S) =="
}

for sport in football basketball pokemon; do
  echo ""
  echo "=========================================="
  echo "===== $sport BULK-BUILD START ====="
  echo "=========================================="
  run_batch "$sport" 2026 2025 2024
  run_batch "$sport" 2023 2022 2021
  run_batch "$sport" 2020 2019 2018
  run_batch "$sport" 2017 2016 2015
  run_batch "$sport" 2014 2013 2012
  run_batch "$sport" 2011 2010
  echo "===== $sport DONE $(date +%H:%M:%S) ====="
done

echo ""
echo "=== ALL multi-sport bulk-build done $(date +%H:%M:%S) ==="
