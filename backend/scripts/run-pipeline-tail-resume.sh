#!/usr/bin/env bash
# CF-CATALOG-PIPELINE resume (Drew, 2026-08-05).
#
# The initial pipeline tail (byzelafwo) got orphaned when the previous
# Claude session ended. It had completed:
#   step 1 — BCCP import (all 3,075 products)
#   step 2 — match, years 2025..2002 (patched=every year, err=0)
#
# What still needs to run:
#   step 2 — match, years 2001..1900 (small tuple counts each)
#   step 3 — attach-sales-summary for every year
#   step 4 — flag price anomalies for 2015+
#   step 5 — drop card_catalog RU/s max 10K → 4K
#
# Expects COSMOS_CONNECTION_STRING already in the env.
set -eu

LOGDIR=/tmp/pipeline-resume
mkdir -p "$LOGDIR"

# Years we still need to match (2001 down to 1900).
MATCH_YEARS_REMAINING="2001 2000 1999 1998 1997 1996 1995 1994 1993 1992 1991 1990 1989 1988 1987 1986 1985 1984 1983 1982 1981 1980 1979 1978 1977 1976 1975 1974 1973 1972 1971 1970 1969 1968 1967 1966 1965 1964 1963 1962 1961 1960 1959 1958 1957 1956 1955 1954 1953 1952 1951 1950 1949 1948 1947 1946 1945 1944 1943 1942 1941 1940 1939 1938 1937 1936 1935 1934 1933 1932 1931 1930 1929 1928 1927 1926 1925 1924 1923 1922 1921 1920 1919 1918 1917 1916 1915 1914 1913 1912 1911 1910 1909 1908 1907 1906 1905 1904 1903 1902 1901 1900"

# All years for attach-sales-summary — full baseball history.
ALL_YEARS="2026 2025 2024 2023 2022 2021 2020 2019 2018 2017 2016 2015 2014 2013 2012 2011 2010 2009 2008 2007 2006 2005 2004 2003 2002 2001 2000 1999 1998 1997 1996 1995 1994 1993 1992 1991 1990 1989 1988 1987 1986 1985 1984 1983 1982 1981 1980 1979 1978 1977 1976 1975 1974 1973 1972 1971 1970 1969 1968 1967 1966 1965 1964 1963 1962 1961 1960 1959 1958 1957 1956 1955 1954 1953 1952 1951 1950"
ANOM_YEARS="2026 2025 2024 2023 2022 2021 2020 2019 2018 2017 2016 2015"

echo "== Step 2 continued: match years 2001..1900 =="
for y in $MATCH_YEARS_REMAINING; do
  echo "  y=$y $(date +%H:%M:%S)"
  npx tsx backend/scripts/match-catalog-to-bccp.ts --year "$y" --sport baseball > "$LOGDIR/2-match-$y.log" 2>&1 || echo "  ! y=$y errored"
  grep -oE "patched=[0-9]+, errors=[0-9]+" "$LOGDIR/2-match-$y.log" | tail -1 || echo "  (no summary line)"
done

echo ""
echo "== Step 3: Attach salesSummary per year =="
for y in $ALL_YEARS; do
  echo "  y=$y $(date +%H:%M:%S)"
  npx tsx backend/scripts/attach-sales-summary-to-catalog.ts --year "$y" --sport baseball --auto-approve > "$LOGDIR/3-sales-$y.log" 2>&1 || echo "  ! y=$y errored"
  tail -2 "$LOGDIR/3-sales-$y.log" | grep -oE "Done in [0-9]+s.*" || tail -1 "$LOGDIR/3-sales-$y.log" || true
done

echo ""
echo "== Step 4: Flag price anomalies (2015+) =="
for y in $ANOM_YEARS; do
  echo "  y=$y $(date +%H:%M:%S)"
  npx tsx backend/scripts/flag-price-anomalies.ts --year "$y" --sport baseball --auto-approve > "$LOGDIR/4-anom-$y.log" 2>&1 || echo "  ! y=$y errored"
  tail -6 "$LOGDIR/4-anom-$y.log" | grep -E "flagged|errors" || true
done

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
echo "==== CATALOG PIPELINE TAIL RESUME COMPLETE $(date +%H:%M:%S) ===="
