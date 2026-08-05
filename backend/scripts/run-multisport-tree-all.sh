#!/usr/bin/env bash
# CF-BUILD-MULTISPORT-TREE (Drew, 2026-08-05).
#
# Builds Card→Variant→Grade tree for football, basketball, pokemon
# across all their modern years (2001-2026). Baseball already covered
# by run-baseball-tree-modern.sh and run-baseball-tree-vintage.sh.
#
# Order: modern first for each sport (highest transaction volume),
# then walks back through the 2000s. Every sport serially — Cosmos
# throughput is shared and running 3 sports × parallel would spike RU
# past the 10K autoscale ceiling.

set -eu

if [ -z "${COSMOS_CONNECTION_STRING:-}" ]; then
  echo "ERROR: COSMOS_CONNECTION_STRING must be set" >&2
  exit 2
fi

LOGDIR=/tmp/tree-build-multisport
mkdir -p "$LOGDIR"

YEARS="2026 2025 2024 2023 2022 2021 2020 2019 2018 2017 2016 2015 2014 2013 2012 2011 2010 2009 2008 2007 2006 2005 2004 2003 2002 2001"

for sport in football basketball pokemon; do
  echo ""
  echo "===================================================="
  echo "== $sport tree build start $(date +%H:%M:%S) =="
  echo "===================================================="
  for y in $YEARS; do
    echo "  [$sport y=$y] start $(date +%H:%M:%S)"
    TREE_YEAR=$y TREE_SPORT=$sport TREE_APPLY=true \
      npx tsx backend/scripts/build-tree-nodes.ts > "$LOGDIR/tree-$sport-$y.log" 2>&1
    cards=$(grep -oE "Card docs: +[0-9]+" "$LOGDIR/tree-$sport-$y.log" | tail -1)
    variants=$(grep -oE "Variant docs: +[0-9]+" "$LOGDIR/tree-$sport-$y.log" | tail -1)
    grades=$(grep -oE "Grade docs: +[0-9]+" "$LOGDIR/tree-$sport-$y.log" | tail -1)
    echo "  [$sport y=$y] done  $(date +%H:%M:%S) — $cards, $variants, $grades"
  done
  echo "== $sport tree build done $(date +%H:%M:%S) =="
done
echo ""
echo "==== ALL multisport trees done $(date +%H:%M:%S) ===="
