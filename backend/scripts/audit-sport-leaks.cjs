#!/usr/bin/env node
/**
 * CF-SPORT-LEAK-AUDIT (Drew, 2026-08-18: "Football leaked in").
 *
 * Finds comps whose SLUG SPORT disagrees with the sport that player actually
 * plays, using the pool's own evidence rather than a name list.
 *
 * WHAT DREW SAW. The 1997 Skybox Metal Universe Chipper Jones #31 page showed
 * a $2.00 "Shannon Sharpe #31" in its comps. Sharpe is an NFL tight end. Metal
 * Universe shipped baseball AND football sets in 1997, both with a #31, so a
 * mis-sported football card lands on the baseball card's slug and prices it.
 *
 * THE SIGNAL. A player's dominant sport across ALL their comps:
 *
 *   Shannon Sharpe    186 football (90.7%)  |  4 baseball (2.0%)   <- leak
 *   Irving Fryar      187 football (95.9%)  |  4 baseball (2.1%)   <- leak
 *   Chipper Jones   18825 baseball (97.6%)  | 43 football (0.2%)   <- leaks the other way
 *
 * This needs no vocabulary and no curated roster — the pool already knows.
 *
 * WHY IT IS DELIBERATELY CONSERVATIVE. Some players really do appear in more
 * than one sport: Michael Jordan has genuine baseball cards, Bo Jackson and
 * Deion Sanders have both, and multi-sport sets exist as a category. A naive
 * "minority sport = wrong" rule would delete real cards.
 *
 * So a row is only flagged when ALL of these hold:
 *   - the player has enough history to judge (>= MIN_COMPS)
 *   - one sport is overwhelmingly dominant (>= DOMINANCE)
 *   - the row's sport is a tiny minority (<= MAX_MINORITY_SHARE)
 *   - the row's sport is not `multi-sport` (that IS the legitimate case)
 *
 * Known dual-sport names are excluded outright, because for them the minority
 * is real. That list is short and explicit rather than inferred.
 *
 * READ-ONLY. Repair means changing a row's sport, which changes segment 1 of
 * its slug and moves it between verticals — the same weight as a reslug, and it
 * gets the same treatment: report, review, then a separate deliberate pass.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-sport-leaks.cjs \
 *     [--setKey=skybox-metal-universe] [--minComps=25] [--dominance=0.85]
 *     [--maxMinority=0.10] [--top=40]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SETKEY = arg("setKey", "");
const MIN_COMPS = Number(arg("minComps", "25"));
const DOMINANCE = Number(arg("dominance", "0.85"));
const MAX_MINORITY = Number(arg("maxMinority", "0.10"));
const TOP = Number(arg("top", "40"));

/** Players who legitimately have cards in more than one sport. For these the
 *  minority is REAL, so the whole premise of the check fails and they are
 *  skipped rather than "corrected". */
const DUAL_SPORT = new Set([
  "michael jordan", "bo jackson", "deion sanders", "brian jordan", "kyler murray",
  "russell wilson", "tim tebow", "jim thorpe", "danny ainge", "dave winfield",
  "john elway", "drew henson", "chris weinke", "ricky williams", "charlie ward",
]);

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  // DOMINANCE MUST COME FROM THE PLAYER'S WHOLE HISTORY, NOT THE TARGET SET.
  //
  // The first cut scoped BOTH the histogram and the reporting to --setKey, and
  // it collapsed: inside one set most players have a handful of comps, so 372
  // of 416 were skipped as too-thin and the single "finding" was a false
  // positive — Wayne Gretzky flagged for a HOCKEY row, which is obviously his
  // real sport, because his in-set history was 11 multi-sport rows.
  //
  // Shannon Sharpe reads 90.7% football only across all 205 of his comps. So:
  // phase 1 collects the candidate rows (optionally set-scoped), phase 2 asks
  // the pool for each player's FULL sport distribution.
  const where = ["IS_DEFINED(c.hobbyiqCardId)", "NOT IS_NULL(c.hobbyiqCardId)", "IS_DEFINED(c.playerName)"];
  if (SETKEY) where.push(`CONTAINS(c.hobbyiqCardId, ":${SETKEY}:")`);

  const iter = sold.items.query(
    `SELECT c.id, c.cardId, c.playerName, c.hobbyiqCardId, c.price FROM c WHERE ${where.join(" AND ")}`,
    { maxItemCount: 2000 },
  );

  const candidateRows = new Map();   // player -> rows IN SCOPE
  let scanned = 0;
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources || []) {
      scanned++;
      const player = norm(r.playerName);
      if (!player || !String(r.hobbyiqCardId).split(":")[1]) continue;
      let arr = candidateRows.get(player);
      if (!arr) candidateRows.set(player, (arr = []));
      arr.push(r);
    }
    if (scanned % 200000 < 2000) process.stderr.write(`\r  scanned=${scanned} players=${candidateRows.size}   `);
  }
  process.stderr.write("\n");

  // Phase 2: global sport histogram per candidate player.
  const byPlayer = new Map();
  let done = 0;
  for (const [player, rows] of candidateRows) {
    const { resources } = await sold.items.query({
      query: "SELECT c.hobbyiqCardId FROM c WHERE LOWER(c.playerName) = @p",
      parameters: [{ name: "@p", value: player }],
    }).fetchAll();
    const m = new Map();
    for (const g of resources) {
      const s = String(g.hobbyiqCardId || "").split(":")[1] || "";
      if (!s) continue;
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    // Attach the in-scope rows so findings can point at real documents.
    byPlayer.set(player, { hist: m, rows });
    if (++done % 50 === 0) process.stderr.write(`\r  player histories ${done}/${candidateRows.size}   `);
  }
  process.stderr.write("\n");

  const findings = [];
  let skippedDual = 0, skippedThin = 0;
  for (const [player, { hist, rows }] of byPlayer) {
    if (DUAL_SPORT.has(player)) { skippedDual++; continue; }
    const total = [...hist.values()].reduce((s, n) => s + n, 0);
    if (total < MIN_COMPS) { skippedThin++; continue; }
    const ranked = [...hist.entries()].sort((a, b) => b[1] - a[1]);
    const [domSport, domCount] = ranked[0];
    if (domCount / total < DOMINANCE) continue;             // no clear home sport
    // Report only the IN-SCOPE rows that sit outside the player's home sport.
    const strays = rows.filter((r) => {
      const s = String(r.hobbyiqCardId).split(":")[1];
      if (s === domSport || s === "multi-sport" || !s) return false;
      const share = (hist.get(s) ?? 0) / total;
      return share <= MAX_MINORITY;
    });
    if (!strays.length) continue;
    const straySport = String(strays[0].hobbyiqCardId).split(":")[1];
    findings.push({
      player, domSport, domCount, total,
      sport: straySport, rows: strays,
      share: (hist.get(straySport) ?? 0) / total,
    });
  }
  findings.sort((a, b) => b.rows.length - a.rows.length);

  const leakedRows = findings.reduce((s, f) => s + f.rows.length, 0);
  console.log(`\nscanned=${scanned.toLocaleString()} players=${byPlayer.size.toLocaleString()}`);
  console.log(`skipped: dual-sport ${skippedDual}, too-thin ${skippedThin}\n`);
  console.log(`players with a leaked sport : ${findings.length.toLocaleString()}`);
  console.log(`comps sitting in the wrong vertical : ${leakedRows.toLocaleString()}\n`);
  for (const f of findings.slice(0, TOP)) {
    console.log(`  ${f.player}  — home=${f.domSport} (${f.domCount}/${f.total})`);
    console.log(`     ${f.rows.length} comp(s) on ${f.sport} (${(f.share * 100).toFixed(1)}%)`);
    for (const r of f.rows.slice(0, 3)) console.log(`        $${String(r.price).padEnd(9)} ${r.hobbyiqCardId}`);
  }
  console.log("\nREAD-ONLY — changing a row's sport moves it between verticals and gets its own reviewed pass.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
