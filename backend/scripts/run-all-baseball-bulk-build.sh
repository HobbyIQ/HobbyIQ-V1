#!/usr/bin/env bash
# CF-CATALOG-FIRST — Drew, 2026-08-04.
#
# Bulk-build canonical catalog rows for ALL baseball years, 3 in parallel
# per batch. Older decades (pre-1980) run 5-in-parallel because tuples-
# per-year is small enough that Cosmos throughput isn't the bottleneck.
#
# Expects COSMOS_CONNECTION_STRING already exported.
#
# Usage:
#   export COSMOS_CONNECTION_STRING=$(az webapp config appsettings list \
#     --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
#     --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)
#   bash backend/scripts/run-all-baseball-bulk-build.sh
set -eu

if [ -z "${COSMOS_CONNECTION_STRING:-}" ]; then
  echo "ERROR: COSMOS_CONNECTION_STRING must be set" >&2
  exit 2
fi

LOGDIR=/tmp/bulk-all-baseball
mkdir -p "$LOGDIR"

run_year() {
  local y=$1
  echo "  y=$y start $(date +%H:%M:%S)"
  npx tsx backend/scripts/bulk-build-catalog.ts --year "$y" --sport baseball --auto-approve \
    > "$LOGDIR/bulk-$y.log" 2>&1
  local last
  last=$(grep -oE "upserted [0-9]+, err [0-9]+ \([0-9]+/[0-9]+\)" "$LOGDIR/bulk-$y.log" | tail -1)
  echo "  y=$y done  $(date +%H:%M:%S) — $last"
}

run_batch() {
  local years=("$@")
  echo "== Batch [${years[*]}] start $(date +%H:%M:%S) =="
  local pids=()
  for y in "${years[@]}"; do
    run_year "$y" &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p"; done
  echo "== Batch done $(date +%H:%M:%S) =="
}

# Modern era: 3 concurrent (biggest per-year volume, most RU per process).
echo "=== 2010s baseball ==="
run_batch 2019 2018 2017
run_batch 2016 2015 2014
run_batch 2013 2012 2011
run_batch 2010

echo "=== 2000s baseball ==="
run_batch 2009 2008 2007
run_batch 2006 2005 2004
run_batch 2003 2002 2001
run_batch 2000

echo "=== 1990s baseball ==="
run_batch 1999 1998 1997 1996 1995
run_batch 1994 1993 1992 1991 1990

echo "=== 1980s baseball ==="
run_batch 1989 1988 1987 1986 1985
run_batch 1984 1983 1982 1981 1980

echo "=== 1970s baseball ==="
run_batch 1979 1978 1977 1976 1975
run_batch 1974 1973 1972 1971 1970

echo "=== 1960s baseball ==="
run_batch 1969 1968 1967 1966 1965
run_batch 1964 1963 1962 1961 1960

echo "=== 1950s baseball ==="
run_batch 1959 1958 1957 1956 1955
run_batch 1954 1953 1952 1951 1950

# Re-run 2020-2026 with fixed normalizer + brand field. Idempotent upsert
# — stamps brand on existing rows and creates canonical topps-* rows for
# any bare "Finest" etc that produced dupes on the first pass.
echo "=== 2020s baseball re-run (brand + fixed normalizer) ==="
run_batch 2026 2025 2024
run_batch 2023 2022 2021
run_year 2020

echo "=== ALL baseball bulk-build done $(date +%H:%M:%S) ==="
