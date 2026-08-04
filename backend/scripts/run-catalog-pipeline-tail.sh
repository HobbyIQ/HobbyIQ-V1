#!/usr/bin/env bash
# CF-CATALOG-PIPELINE (Drew, 2026-08-04).
#
# Tail of the catalog build pipeline. Runs AFTER the pool-based rollout
# (blv34o6vi) AND the BCCP scrape (bnwuyv0h2) finish. Blocks until both
# leave sentinel markers, then executes in this order:
#
#   1. import-bccp-to-catalog.ts --all — upserts every scraped product-
#      structure JSON into card_catalog.
#   2. match-catalog-to-bccp.ts per baseball year — stamps
#      bccpMatchedAs/bccpParallelName/bccpPrintRun onto every pool row.
#   3. attach-sales-summary-to-catalog.ts per baseball year — stamps
#      median30d/90d/180d + trend on every catalog row.
#   4. flag-price-anomalies.ts per year — marks sold_comps outside the
#      catalog's median band as priceAnomaly=true so they land in the
#      /api/verify/comps queue.
#   5. Drops card_catalog RU/s max back to 4K (was bumped to 10K).
#
# Expects COSMOS_CONNECTION_STRING already in the env.
set -eu

LOGDIR=/tmp/pipeline-tail
mkdir -p "$LOGDIR"
YEARS="2025 2024 2023 2022 2021 2020 2019 2018 2017 2016 2015 2014 2013 2012 2011 2010 2009 2008 2007 2006 2005 2004 2003 2002 2001 2000 1999 1998 1997 1996 1995 1994 1993 1992 1991 1990 1989 1988 1987 1986 1985 1984 1983 1982 1981 1980 1979 1978 1977 1976 1975 1974 1973 1972 1971 1970 1969 1968 1967 1966 1965 1964 1963 1962 1961 1960 1959 1958 1957 1956 1955 1954 1953 1952 1951 1950"

# Wait for pool rollout resume to finish (was be7oswgcf after battery
# crash forced a resume).
POOL_TASK_ID="${POOL_TASK_ID:-be7oswgcf}"
POOL_LOG="C:/Users/dvabu/AppData/Local/Temp/claude/c--Users-dvabu-OneDrive---Just-the-Boys-and-Cards-LLC-Desktop-HobbyIQ-V1--claude-worktrees-cf-cardsearch-firstpass/44ed1a3b-f8bb-43c5-948b-2d23cfb9d8f7/tasks/${POOL_TASK_ID}.output"
echo "== Waiting for pool rollout (${POOL_TASK_ID}) — sentinel: '==== POOL RESUME DONE' =="
until grep -q "==== POOL RESUME DONE" "$POOL_LOG" 2>/dev/null; do sleep 30; done
echo "== Pool rollout done $(date +%H:%M:%S) =="

# Wait for BCCP scrape to finish.
SCRAPE_TASK_ID="${SCRAPE_TASK_ID:-b44zvj52k}"
SCRAPE_LOG="C:/Users/dvabu/AppData/Local/Temp/claude/c--Users-dvabu-OneDrive---Just-the-Boys-and-Cards-LLC-Desktop-HobbyIQ-V1--claude-worktrees-cf-cardsearch-firstpass/44ed1a3b-f8bb-43c5-948b-2d23cfb9d8f7/tasks/${SCRAPE_TASK_ID}.output"
echo "== Waiting for BCCP scrape (${SCRAPE_TASK_ID}) — sentinel: '==== ALL YEARS DONE' =="
until grep -q "==== ALL YEARS DONE" "$SCRAPE_LOG" 2>/dev/null; do sleep 60; done
echo "== BCCP scrape done $(date +%H:%M:%S) =="

# Step 1: Import ALL BCCP data.
echo ""
echo "== Step 1: Import ALL BCCP product-structure docs to card_catalog =="
npx tsx backend/scripts/import-bccp-to-catalog.ts --all --auto-approve > "$LOGDIR/1-import.log" 2>&1
tail -5 "$LOGDIR/1-import.log"

# Step 2: Match per year.
echo ""
echo "== Step 2: Match card_catalog pool rows to BCCP structure — per year =="
for y in $YEARS; do
  echo "  y=$y $(date +%H:%M:%S)"
  npx tsx backend/scripts/match-catalog-to-bccp.ts --year "$y" --sport baseball > "$LOGDIR/2-match-$y.log" 2>&1 || echo "  ! y=$y errored"
  grep -oE "patched=[0-9]+, errors=[0-9]+" "$LOGDIR/2-match-$y.log" | tail -1 || echo "  (no summary line)"
done

# Step 3: Attach sales summary per year.
echo ""
echo "== Step 3: Attach sales summary to card_catalog — per year =="
for y in $YEARS; do
  echo "  y=$y $(date +%H:%M:%S)"
  npx tsx backend/scripts/attach-sales-summary-to-catalog.ts --year "$y" --sport baseball --auto-approve > "$LOGDIR/3-sales-$y.log" 2>&1 || echo "  ! y=$y errored"
  tail -3 "$LOGDIR/3-sales-$y.log" || true
done

# Step 4: Flag price anomalies per year (only recent years matter — thin
# catalog for pre-2000 years means anomaly bounds are wide/useless).
echo ""
echo "== Step 4: Flag price anomalies (2015+) =="
for y in 2025 2024 2023 2022 2021 2020 2019 2018 2017 2016 2015; do
  echo "  y=$y $(date +%H:%M:%S)"
  npx tsx backend/scripts/flag-price-anomalies.ts --year "$y" --sport baseball --auto-approve > "$LOGDIR/4-anom-$y.log" 2>&1 || echo "  ! y=$y errored"
  tail -6 "$LOGDIR/4-anom-$y.log" || true
done

# Step 5: Drop card_catalog RU/s back to 4K.
echo ""
echo "== Step 5: Drop card_catalog autoscale max 10K -> 4K =="
az cosmosdb sql container throughput update \
  --account-name hobbyiq-comps \
  --resource-group rg-hobbyiq-dev \
  --database-name hobbyiq \
  --name card_catalog \
  --max-throughput 4000 \
  --query "{new_autoscale: resource.autoscaleSettings.maxThroughput}" -o json > "$LOGDIR/5-ru-drop.log" 2>&1 || true
cat "$LOGDIR/5-ru-drop.log" || true

echo ""
echo "==== CATALOG PIPELINE TAIL COMPLETE $(date +%H:%M:%S) ===="
