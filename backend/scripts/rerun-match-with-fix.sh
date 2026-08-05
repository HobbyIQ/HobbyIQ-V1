#!/usr/bin/env bash
# CF-BCCP-PARALLEL-REPAIR followup (Drew, 2026-08-05).
#
# After 5391b5e2 fixed the [eir]{4} → [eiral]{4} regex + repair-bccp-
# json-names.mjs cleaned c:/tmp/bccp cache, this replays the pipeline
# steps that consume BCCP parallel data:
#
#   1. Re-import cleaned BCCP → card_catalog (fast, ~5 sec for 3,075
#      product-structure docs)
#   2. Re-run match per baseball year (patches bccpMatched /
#      bccpParallelName / bccpPrintRun on every catalog row that now
#      finds a parallel match)
#
# Runs alongside the salesSummary attach the pipeline tail is doing
# on step 3 — different Cosmos writes (match patches bccpMatched fields,
# attach patches salesSummary), no contention.
#
# Expects COSMOS_CONNECTION_STRING in env.
set -eu

LOGDIR=/tmp/rerun-match
mkdir -p "$LOGDIR"

echo "== Step 1: Re-import cleaned BCCP into card_catalog =="
npx tsx backend/scripts/import-bccp-to-catalog.ts --all --auto-approve > "$LOGDIR/1-reimport.log" 2>&1
tail -3 "$LOGDIR/1-reimport.log"

echo ""
echo "== Step 2: Re-run match for every baseball year =="
YEARS="2026 2025 2024 2023 2022 2021 2020 2019 2018 2017 2016 2015 2014 2013 2012 2011 2010 2009 2008 2007 2006 2005 2004 2003 2002 2001 2000 1999 1998 1997 1996 1995 1994 1993 1992 1991 1990 1989 1988 1987 1986 1985 1984 1983 1982 1981 1980 1979 1978 1977 1976 1975 1974 1973 1972 1971 1970 1969 1968 1967 1966 1965 1964 1963 1962 1961 1960 1959 1958 1957 1956 1955 1954 1953 1952 1951 1950"
for y in $YEARS; do
  npx tsx backend/scripts/match-catalog-to-bccp.ts --year "$y" --sport baseball > "$LOGDIR/2-match-$y.log" 2>&1 || echo "  ! y=$y errored"
  summary=$(grep -oE "patched=[0-9]+, errors=[0-9]+" "$LOGDIR/2-match-$y.log" | tail -1)
  echo "  y=$y $(date +%H:%M:%S) — ${summary:-(no summary)}"
done

echo ""
echo "==== RE-MATCH COMPLETE $(date +%H:%M:%S) ===="
