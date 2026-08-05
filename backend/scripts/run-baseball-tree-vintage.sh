#!/usr/bin/env bash
# CF-BUILD-BASEBALL-TREE-VINTAGE (Drew, 2026-08-05).
#
# Runs the tree builder for baseball years 2019 + 2017-1950. Runs in
# parallel with run-baseball-tree-modern.sh (2020-2026) — Cosmos
# card_catalog autoscales to 10K RU/s and each build consumes ~500 RU/s,
# so parallel is fine.

set -eu

if [ -z "${COSMOS_CONNECTION_STRING:-}" ]; then
  echo "ERROR: COSMOS_CONNECTION_STRING must be set" >&2
  exit 2
fi

LOGDIR=/tmp/tree-build-vintage
mkdir -p "$LOGDIR"

# Cascade: 2019 first (most recent), then walk back decade-by-decade.
YEARS="2019 2017 2016 2015 2014 2013 2012 2011 2010 2009 2008 2007 2006 2005 2004 2003 2002 2001 2000 1999 1998 1997 1996 1995 1994 1993 1992 1991 1990 1989 1988 1987 1986 1985 1984 1983 1982 1981 1980 1979 1978 1977 1976 1975 1974 1973 1972 1971 1970 1969 1968 1967 1966 1965 1964 1963 1962 1961 1960 1959 1958 1957 1956 1955 1954 1953 1952 1951 1950"

echo "==== Vintage baseball tree build start $(date +%H:%M:%S) ===="
for y in $YEARS; do
  echo "  y=$y start $(date +%H:%M:%S)"
  TREE_YEAR=$y TREE_SPORT=baseball TREE_APPLY=true \
    npx tsx backend/scripts/build-tree-nodes.ts > "$LOGDIR/tree-$y.log" 2>&1
  last=$(grep -oE "Card docs: +[0-9]+" "$LOGDIR/tree-$y.log" | tail -1)
  variants=$(grep -oE "Variant docs: +[0-9]+" "$LOGDIR/tree-$y.log" | tail -1)
  grades=$(grep -oE "Grade docs: +[0-9]+" "$LOGDIR/tree-$y.log" | tail -1)
  echo "  y=$y done  $(date +%H:%M:%S) — $last, $variants, $grades"
done
echo "==== Vintage baseball tree done $(date +%H:%M:%S) ===="
