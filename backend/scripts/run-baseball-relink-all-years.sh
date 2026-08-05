#!/usr/bin/env bash
# CF-RELINK-ALL-BASEBALL (Drew, 2026-08-05).
#
# Walks every baseball year and runs relink-sold-comps-to-tree.ts to
# stamp cardTreeId + variantId + gradeId on every row. 2018 already
# done (53,640 rows in 317s); expect ~2.8M remaining rows total.
#
# Serialized year-by-year so we don't blow the Cosmos autoscale
# ceiling. Skips 2018.

set -eu

if [ -z "${COSMOS_CONNECTION_STRING:-}" ]; then
  echo "ERROR: COSMOS_CONNECTION_STRING must be set" >&2
  exit 2
fi

LOGDIR=/tmp/relink-all-baseball
mkdir -p "$LOGDIR"

# Modern first (most user-facing traffic), then walk back through
# decades. Skip 2018 — already done.
YEARS="2026 2025 2024 2023 2022 2021 2020 2019 2017 2016 2015 2014 2013 2012 2011 2010 2009 2008 2007 2006 2005 2004 2003 2002 2001 2000 1999 1998 1997 1996 1995 1994 1993 1992 1991 1990 1989 1988 1987 1986 1985 1984 1983 1982 1981 1980 1979 1978 1977 1976 1975 1974 1973 1972 1971 1970 1969 1968 1967 1966 1965 1964 1963 1962 1961 1960 1959 1958 1957 1956 1955 1954 1953 1952 1951 1950"

echo "==== Baseball relink (all years except 2018) start $(date +%H:%M:%S) ===="
for y in $YEARS; do
  echo "  y=$y start $(date +%H:%M:%S)"
  RELINK_YEAR=$y RELINK_SPORT=baseball RELINK_APPLY=true \
    npx tsx backend/scripts/relink-sold-comps-to-tree.ts > "$LOGDIR/relink-$y.log" 2>&1
  summary=$(grep -oE "written: +[0-9,]+" "$LOGDIR/relink-$y.log" | tail -1)
  errs=$(grep -oE "errors: +[0-9,]+" "$LOGDIR/relink-$y.log" | tail -1)
  echo "  y=$y done  $(date +%H:%M:%S) — $summary, $errs"
done
echo "==== Baseball relink done $(date +%H:%M:%S) ===="
