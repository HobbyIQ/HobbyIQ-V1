#!/usr/bin/env bash
# CF-CATALOG-BCCP-FULL (Drew, 2026-08-05).
#
# Full BCCP re-scrape 2001-2026. Sequential year-by-year (BCCP scraper
# already parallelizes product-page fetches per year, so serializing at
# the year level keeps politeness in check). Idempotent — skips year
# folders that already have products.json unless BCCP_FORCE=true.

set -eu

LOGDIR=/tmp/bccp-scrape-all
mkdir -p "$LOGDIR"

for y in $(seq 2026 -1 2001); do
  DEST="c:/tmp/bccp/$y/products.json"
  if [ -z "${BCCP_FORCE:-}" ] && [ -f "$DEST" ]; then
    echo "  y=$y skip (exists)"
    continue
  fi
  echo "  y=$y start $(date +%H:%M:%S)"
  npx tsx backend/scripts/scrape-bccp-year.ts --year "$y" > "$LOGDIR/bccp-$y.log" 2>&1 || echo "    ! failed"
  last=$(tail -3 "$LOGDIR/bccp-$y.log" | tr '\n' ' ')
  echo "  y=$y done  $(date +%H:%M:%S) — $(echo $last | cut -c1-140)"
done

echo ""
echo "=== BCCP 2001-2026 scrape done $(date +%H:%M:%S) ==="
