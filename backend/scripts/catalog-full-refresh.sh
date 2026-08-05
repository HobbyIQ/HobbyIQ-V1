#!/usr/bin/env bash
# CF-CATALOG-FULL-REFRESH (Drew, 2026-08-05).
#
# ONE COMMAND to run the entire catalog data pipeline end-to-end.
# Replaces the piecemeal scripts (rerun-match-with-fix.sh,
# run-pipeline-tail-resume.sh, etc). Every step is idempotent and
# safe to re-run.
#
# STEPS:
#   0. Bump card_catalog RU/s 4K → 10K for the run (skipped if already)
#   1. BCCP scrape 2025..1900 → c:/tmp/bccp/            (~90 min, skip if
#                                                        soft-blocked)
#   2. CLC scrape all baseball URLs → c:/tmp/clc/       (~10 min)
#   3. CLC xlsx download → c:/tmp/clc-xlsx/             (~15 min)
#   4. Repair BCCP JSON (regex fix for [eiral]{4})     (~30 sec)
#   5. Import BCCP → card_catalog (bccp-product-structure)  (~5 sec)
#   6. Import CLC  → card_catalog (clc-product-structure)   (~3 sec)
#   7. Re-match every baseball year (union BCCP+CLC index)  (~15 min)
#   8. Attach salesSummary per year                     (~30 min)
#   9. Flag price anomalies (2015+)                     (~5 min)
#  10. Drop card_catalog RU/s 10K → 4K
#  11. Print final match-rate summary
#
# Skip patterns:
#   CATALOG_SKIP_SCRAPE=1  skips steps 1-3 (use cached data)
#   CATALOG_SKIP_XLSX=1    skips step 3 only
#   CATALOG_SKIP_BCCP=1    skips step 1 only (BCCP soft-blocked)
#   CATALOG_SKIP_SALES=1   skips step 8 (heavy)
#   CATALOG_SKIP_ANOM=1    skips step 9
#
# Requires COSMOS_CONNECTION_STRING in env, plus az CLI logged in
# for the RU bump.
set -eu

LOGDIR=/tmp/catalog-refresh-$(date +%Y%m%d-%H%M%S)
mkdir -p "$LOGDIR"
echo "==== CATALOG FULL REFRESH — logs in $LOGDIR ===="

if [ -z "${COSMOS_CONNECTION_STRING:-}" ]; then
  echo "ERROR: COSMOS_CONNECTION_STRING not set"
  exit 2
fi

years_recent="2026 2025 2024 2023 2022 2021 2020 2019 2018 2017 2016 2015"
years_all="2026 2025 2024 2023 2022 2021 2020 2019 2018 2017 2016 2015 2014 2013 2012 2011 2010 2009 2008 2007 2006 2005 2004 2003 2002 2001 2000 1999 1998 1997 1996 1995 1994 1993 1992 1991 1990 1989 1988 1987 1986 1985 1984 1983 1982 1981 1980 1979 1978 1977 1976 1975 1974 1973 1972 1971 1970 1969 1968 1967 1966 1965 1964 1963 1962 1961 1960 1959 1958 1957 1956 1955 1954 1953 1952 1951 1950"

step() { echo ""; echo "==== $1  $(date +%H:%M:%S) ===="; }
skip_if() { if [ -n "${1:-}" ]; then echo "  SKIP ($2)"; return 0; fi; return 1; }

step "Step 0: Bump card_catalog RU/s to 10K"
az cosmosdb sql container throughput update --account-name hobbyiq-comps --resource-group rg-hobbyiq-dev --database-name hobbyiq --name card_catalog --max-throughput 10000 > "$LOGDIR/0-ru-bump.log" 2>&1 || echo "  (already at 10K or command failed — continuing)"

step "Step 1: BCCP scrape (2025..1900)"
if skip_if "${CATALOG_SKIP_SCRAPE:-}${CATALOG_SKIP_BCCP:-}" "BCCP skipped by env"; then :;
else bash backend/scripts/run-all-bccp-scrape.sh > "$LOGDIR/1-bccp.log" 2>&1 || echo "  BCCP scrape errored — check $LOGDIR/1-bccp.log"; fi

step "Step 2: CLC scrape"
if skip_if "${CATALOG_SKIP_SCRAPE:-}" "CLC skipped by env"; then :;
else node backend/scripts/scrape-clc-checklist.mjs > "$LOGDIR/2-clc.log" 2>&1 || echo "  CLC scrape errored — check $LOGDIR/2-clc.log"; fi

step "Step 3: CLC xlsx download"
if skip_if "${CATALOG_SKIP_SCRAPE:-}${CATALOG_SKIP_XLSX:-}" "xlsx skipped by env"; then :;
else node backend/scripts/download-clc-xlsx.mjs > "$LOGDIR/3-xlsx.log" 2>&1 || echo "  xlsx download errored — check $LOGDIR/3-xlsx.log"; fi

step "Step 4: Repair BCCP JSON regex fixes"
node backend/scripts/repair-bccp-json-names.mjs > "$LOGDIR/4-repair.log" 2>&1 || true
tail -2 "$LOGDIR/4-repair.log"

step "Step 5: Import BCCP → card_catalog"
npx tsx backend/scripts/import-bccp-to-catalog.ts --all --auto-approve > "$LOGDIR/5-bccp-import.log" 2>&1 || true
tail -3 "$LOGDIR/5-bccp-import.log"

step "Step 6: Import CLC → card_catalog"
npx tsx backend/scripts/import-clc-to-catalog.ts --all --auto-approve > "$LOGDIR/6-clc-import.log" 2>&1 || true
tail -3 "$LOGDIR/6-clc-import.log"

step "Step 7: Re-match every baseball year"
for y in $years_all; do
  npx tsx backend/scripts/match-catalog-to-bccp.ts --year "$y" --sport baseball > "$LOGDIR/7-match-$y.log" 2>&1 || true
  summary=$(grep -oE "patched=[0-9]+, errors=[0-9]+" "$LOGDIR/7-match-$y.log" | tail -1)
  echo "  y=$y  ${summary:-no-summary}"
done

step "Step 8: Attach salesSummary per year"
if skip_if "${CATALOG_SKIP_SALES:-}" "salesSummary skipped by env"; then :;
else for y in $years_all; do
  npx tsx backend/scripts/attach-sales-summary-to-catalog.ts --year "$y" --sport baseball --auto-approve > "$LOGDIR/8-sales-$y.log" 2>&1 || true
  summary=$(grep -oE "Done in [0-9]+s" "$LOGDIR/8-sales-$y.log" | tail -1)
  echo "  y=$y  ${summary:-no-summary}"
done
fi

step "Step 9: Flag price anomalies (2015+)"
if skip_if "${CATALOG_SKIP_ANOM:-}" "anomalies skipped by env"; then :;
else for y in $years_recent; do
  npx tsx backend/scripts/flag-price-anomalies.ts --year "$y" --sport baseball --auto-approve > "$LOGDIR/9-anom-$y.log" 2>&1 || true
  summary=$(grep -oE "flagged too-(low|high): +[0-9]+" "$LOGDIR/9-anom-$y.log" | tr '\n' ' ')
  echo "  y=$y  ${summary:-no-summary}"
done
fi

step "Step 10: Drop card_catalog RU/s back to 4K"
az cosmosdb sql container throughput update --account-name hobbyiq-comps --resource-group rg-hobbyiq-dev --database-name hobbyiq --name card_catalog --max-throughput 4000 > "$LOGDIR/10-ru-drop.log" 2>&1 || echo "  RU drop failed — check $LOGDIR/10-ru-drop.log"

step "Step 11: Final match-rate summary"
node -e "
const {CosmosClient} = require('@azure/cosmos');
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cat = c.database('hobbyiq').container('card_catalog');
  const t = (await cat.items.query({query:\"SELECT VALUE COUNT(1) FROM c WHERE c.sport='baseball' AND c.source='bulk-build-from-pool'\"}).fetchAll()).resources[0];
  const b = await cat.items.query({query:\"SELECT c.bccpMatchedAs, COUNT(1) AS n FROM c WHERE c.sport='baseball' AND c.source='bulk-build-from-pool' GROUP BY c.bccpMatchedAs\"}).fetchAll();
  const rows = b.resources.map(r=>({k:r.bccpMatchedAs||'null',n:r.n})).sort((a,b)=>b.n-a.n);
  const confirmed = rows.filter(r=>['base','parallel','insert','auto','gameUsed','gimmick'].includes(r.k)).reduce((a,r)=>a+r.n,0);
  console.log('POOL total: ' + t.toLocaleString());
  for (const r of rows) console.log('  ' + r.k.padEnd(22) + String(r.n).padStart(9) + '  ' + Math.round(100*r.n/t*10)/10 + '%');
  console.log('CONFIRMED: ' + confirmed.toLocaleString() + ' (' + Math.round(100*confirmed/t*10)/10 + '%)');
})();
"

echo ""
echo "==== FULL REFRESH COMPLETE  $(date +%H:%M:%S) ===="
echo "Logs: $LOGDIR"
