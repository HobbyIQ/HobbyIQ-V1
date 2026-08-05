#!/usr/bin/env bash
# CF-CATALOG-2001-2009 (Drew, 2026-08-05).
#
# Fills 2001-2009 pool-from-slug rows for football, basketball, pokemon,
# and baseball. Baseball was fully scoped by run-all-baseball-bulk-build.sh
# already; run there is idempotent so a re-run just no-ops on
# already-seen tuples. Non-baseball sports had only 2010+ in the earlier
# multisport run. Vintage sales volume is smaller, so 3-year batches
# hold up fine.

set -eu

if [ -z "${COSMOS_CONNECTION_STRING:-}" ]; then
  echo "ERROR: COSMOS_CONNECTION_STRING must be set" >&2
  exit 2
fi

LOGDIR=/tmp/bulk-2001-2009
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
  echo "===== $sport 2001-2009 START ====="
  run_batch "$sport" 2009 2008 2007
  run_batch "$sport" 2006 2005 2004
  run_batch "$sport" 2003 2002 2001
  echo "===== $sport DONE $(date +%H:%M:%S) ====="
done

echo ""
echo "=== ALL 2001-2009 multi-sport done $(date +%H:%M:%S) ==="
