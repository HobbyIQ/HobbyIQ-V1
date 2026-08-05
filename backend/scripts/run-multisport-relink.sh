#!/usr/bin/env bash
# CF-RELINK-MULTISPORT (Drew, 2026-08-05).
#
# Walks football/basketball/pokemon and runs relink-sold-comps-to-tree.ts
# per year to stamp cardTreeId + variantId + gradeId. Runs in parallel
# with baseball relink; the sold_comps container autoscales up to
# 10K RU/s so multiple relink loops share throughput cleanly.
#
# The tree-pointer derivation is purely mechanical (parse hobbyiqCardId,
# append grade suffix) — doesn't require the corresponding tree Node
# docs to exist yet. That means we can relink in parallel with the tree
# build; the pointers resolve correctly once both jobs land.

set -eu

if [ -z "${COSMOS_CONNECTION_STRING:-}" ]; then
  echo "ERROR: COSMOS_CONNECTION_STRING must be set" >&2
  exit 2
fi

LOGDIR=/tmp/relink-multisport
mkdir -p "$LOGDIR"

YEARS="2026 2025 2024 2023 2022 2021 2020 2019 2018 2017 2016 2015 2014 2013 2012 2011 2010 2009 2008 2007 2006 2005 2004 2003 2002 2001"

for sport in football basketball pokemon; do
  echo ""
  echo "===================================================="
  echo "== $sport relink start $(date +%H:%M:%S) =="
  echo "===================================================="
  for y in $YEARS; do
    echo "  [$sport y=$y] start $(date +%H:%M:%S)"
    RELINK_YEAR=$y RELINK_SPORT=$sport RELINK_APPLY=true \
      npx tsx backend/scripts/relink-sold-comps-to-tree.ts > "$LOGDIR/relink-$sport-$y.log" 2>&1
    written=$(grep -oE "written: +[0-9,]+" "$LOGDIR/relink-$sport-$y.log" | tail -1)
    errs=$(grep -oE "errors: +[0-9,]+" "$LOGDIR/relink-$sport-$y.log" | tail -1)
    echo "  [$sport y=$y] done  $(date +%H:%M:%S) — $written, $errs"
  done
  echo "== $sport relink done $(date +%H:%M:%S) =="
done
echo ""
echo "==== ALL multisport relink done $(date +%H:%M:%S) ===="
