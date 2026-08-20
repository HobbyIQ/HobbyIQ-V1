#!/usr/bin/env node
/**
 * CF-SETKEY-DRIFT-AUDIT (Drew, 2026-08-18: "should we run a scan to see and
 * fix this? and we need to run sweeps").
 *
 * Answers "WHICH sweeps, and what will each one actually move?" in ONE pass.
 *
 * Until now the only way to size a sweep was to dry-run it, and a dry-run
 * scans every row carrying that setKey — 3,055,051 rows for `topps` alone.
 * Sizing ten keys meant ten full scans. Worse, you had to GUESS the ten keys
 * first, so a mis-filed product nobody thought to name stayed invisible. That
 * is how 1987 Topps Traded Tiffany sat pooled with base Traded: `topps` was
 * simply never on anyone's list.
 *
 * This reads each row once, re-derives the setKey from the row's own setName
 * through the SHIPPED resolver, and tallies (current -> derived). The output
 * IS the sweep plan, ranked by how many rows each --from would move.
 *
 * IT APPLIES THE SAME GUARDS THE SWEEP DOES — isUseless and the ancestor
 * demotion check — so the counts are what a sweep would really write, not an
 * upper bound it will never reach. Rows the sweep would refuse are reported
 * separately: a large demotionsBlocked is itself a finding, because it means
 * vendor setNames are actively disagreeing with good slugs we already hold.
 *
 * READ-ONLY.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-setkey-drift.cjs \
 *     [--limit=N] [--top=40] [--minRows=25]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const {
  resolveSetKeyForSlug,
  deriveParentSetKey,
} = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const LIMIT = Number(arg("limit", "0")) || Infinity;
const TOP = Number(arg("top", "40"));
const MIN_ROWS = Number(arg("minRows", "25"));

const BARE_MANUFACTURER = new Set(["panini", "fleer", "unknown", ""]);
const isYearPrefixed = (k) => /^(19|20)\d{2}-/.test(k);
const isUseless = (k) => BARE_MANUFACTURER.has(k) || isYearPrefixed(k);

/** Same rule as reslug-setkey-from-setname.cjs isDemotion(). */
function isDemotion(current, next) {
  const seen = new Set([current]);
  let p = deriveParentSetKey(current);
  while (p && !seen.has(p)) {
    if (p === next) return true;
    seen.add(p);
    p = deriveParentSetKey(p);
  }
  return false;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  const iter = sold.items.query(
    `SELECT c.hobbyiqCardId, c.setName FROM c
      WHERE IS_DEFINED(c.hobbyiqCardId) AND NOT IS_NULL(c.hobbyiqCardId)`,
    { maxItemCount: 2000 },
  );

  const movesFrom = new Map();   // fromKey -> total rows a sweep would move
  const pairs = new Map();       // "from -> to" -> count
  const blocked = new Map();     // fromKey -> rows refused as a demotion
  let scanned = 0, noSetName = 0, alreadyRight = 0, wouldMove = 0, refused = 0;

  while (iter.hasMoreResults() && scanned < LIMIT) {
    const { resources } = await iter.fetchNext();
    for (const r of resources || []) {
      if (scanned >= LIMIT) break;
      scanned++;
      const p = String(r.hobbyiqCardId).split(":");
      if (p.length < 7) continue;
      if (!r.setName) { noSetName++; continue; }

      const cur = p[3];
      const next = resolveSetKeyForSlug(p[1], String(r.setName), Number(p[2]) || 0);
      if (!next || next === cur || isUseless(next)) { alreadyRight++; continue; }
      if (isDemotion(cur, next)) {
        refused++;
        blocked.set(cur, (blocked.get(cur) || 0) + 1);
        continue;
      }
      wouldMove++;
      movesFrom.set(cur, (movesFrom.get(cur) || 0) + 1);
      const k = `${cur} -> ${next}`;
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
    if (scanned % 250000 < 2000) process.stderr.write(`\r  scanned=${scanned} wouldMove=${wouldMove}   `);
  }
  process.stderr.write("\n");

  console.log(`\nscanned=${scanned} noSetName=${noSetName} alreadyCorrect=${alreadyRight} wouldMove=${wouldMove} demotionsRefused=${refused}`);

  console.log(`\n${"=".repeat(74)}\nTHE SWEEP PLAN — dispatch "Re-slug setKey from setName" with these keys\n`);
  const plan = [...movesFrom.entries()].filter(([, n]) => n >= MIN_ROWS).sort((a, b) => b[1] - a[1]);
  for (const [key, n] of plan.slice(0, TOP)) console.log(`  ${String(n).padStart(8)} rows   --from=${key}`);
  console.log(`\n  keys input: ${plan.slice(0, TOP).map(([k]) => k).join(",")}`);

  console.log(`\n${"=".repeat(74)}\nTOP MOVES (from -> to)\n`);
  for (const [k, n] of [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
    console.log(`  ${String(n).padStart(8)}  ${k}`);
  }

  if (blocked.size) {
    console.log(`\n${"=".repeat(74)}\nDEMOTIONS REFUSED — vendor setNames disagreeing with slugs we already hold\n`);
    for (const [k, n] of [...blocked.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  ${String(n).padStart(8)}  rows on ${k} whose setName resolves to an ANCESTOR (left alone)`);
    }
  }
  console.log("\nREAD-ONLY — nothing was written.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
