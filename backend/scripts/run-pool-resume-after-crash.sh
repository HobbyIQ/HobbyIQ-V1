#!/usr/bin/env bash
# CF-CATALOG-FIRST resume (Drew, 2026-08-04, post battery-out crash).
#
# Cosmos card_catalog audit showed these years still need work after the
# 19:18 crash:
#   - y=1990 has only 300 rows (was mid-upsert when process died)
#   - 1989..1950: not present
#   - pre-1950: not present
#   - 2020..2026: were built with pre-normalizer-fix code, need re-run for
#     the brand/parentSetKey fields (b2545984 + b9b5297c)
#
# Everything 1991-1999, 2000-2019, and 1994 are complete — skip them.
#
# 3-year parallel batches (safe under 10K RU/s cap based on prior runs).
set -eu

LOGDIR=/tmp/pool-resume
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

echo "=== y=1990 re-run (was incomplete) ==="
run_year 1990

echo ""
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

echo "=== pre-1950 baseball ==="
run_batch 1949 1948 1947 1946 1945
run_batch 1944 1943 1942 1941 1940
run_batch 1939 1938 1937 1936 1935
run_batch 1934 1933 1932 1931 1930
run_batch 1929 1928 1927 1926 1925
run_batch 1924 1923 1922 1921 1920
run_batch 1919 1918 1917 1916 1915
run_batch 1914 1913 1912 1911 1910
run_batch 1909 1908 1907 1906 1905 1904 1903 1902 1901 1900

echo ""
echo "=== 2020s re-run (fixed normalizer + brand + parentSetKey stamp) ==="
run_batch 2026 2025 2024
run_batch 2023 2022 2021
run_year 2020

echo ""
echo "==== POOL RESUME DONE $(date +%H:%M:%S) ===="
