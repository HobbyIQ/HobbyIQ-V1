#!/usr/bin/env node
/**
 * CF-SPORT-LEAK-SWEEP (Drew, 2026-08-18: "Football leaked in ... this is a BIG
 * BIG problem. Do a full sweep on ALL cards to fix this").
 *
 * Finds and repairs comps whose SLUG SPORT contradicts the sport that player
 * actually plays — at whole-container scale.
 *
 * WHAT IT FIXES. The 1997 Skybox Metal Universe Chipper Jones #31 page priced
 * off a $2.00 "Shannon Sharpe #31" — Sharpe is an NFL tight end. Metal Universe
 * shipped baseball AND football in 1997, both with a #31, so a mis-sported
 * football card lands on the baseball card's slug and drags its price. The
 * damage is silent: every field looks well-formed.
 *
 * WHY THE EARLIER AUDIT COULD NOT SCALE. audit-sport-leaks.cjs asks Cosmos for
 * each player's history individually. That is fine for 416 players in one set
 * and impossible for the container. This makes ONE pass, building the
 * player -> sport histogram in memory, then a SECOND pass that repairs only
 * rows the histogram condemns. Two scans, no per-player queries.
 *
 * THE SIGNAL, AND WHY IT NEEDS NO ROSTER. A player's dominant sport across all
 * their comps:
 *
 *   Shannon Sharpe    186 football (90.7%)  |  4 baseball (2.0%)   <- leak
 *   Irving Fryar      187 football (95.9%)  |  4 baseball (2.1%)   <- leak
 *   Chipper Jones   18825 baseball (97.6%)  | 43 football (0.2%)   <- leaks the other way
 *
 * DELIBERATELY CONSERVATIVE, because a minority sport is often REAL:
 *   - Michael Jordan has genuine baseball cards; Bo Jackson and Deion Sanders
 *     have both. Those names are excluded outright.
 *   - `multi-sport` is a legitimate vertical, never a leak.
 *   - A row is only condemned when the player has >= MIN_COMPS of history, one
 *     sport holds >= DOMINANCE, and the row's sport holds <= MAX_MINORITY.
 *
 * A first version of this check computed dominance WITHIN the target set and
 * flagged Wayne Gretzky for a hockey row — his in-set history was 11 multi-sport
 * rows, so "hockey" looked like the minority. Dominance must come from the
 * player's whole history; only the REPORTING is ever scoped.
 *
 * THE REPAIR REWRITES SEGMENT 1 AND NOTHING ELSE. Sport is the slug's
 * namespace, so correcting it moves the row to the right vertical while
 * preserving set, number, parallel and auto exactly. sportBefore and
 * hobbyiqCardIdBefore make it reversible.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/sweep-sport-leaks.cjs \
 *     [--apply] [--minComps=25] [--dominance=0.85] [--maxMinority=0.10]
 *     [--pool=8] [--top=40] [--limit=N]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const MIN_COMPS = Number(arg("minComps", "25"));
const DOMINANCE = Number(arg("dominance", "0.85"));
const MAX_MINORITY = Number(arg("maxMinority", "0.10"));
const POOL = Math.max(1, Number(arg("pool", "8")));
const TOP = Number(arg("top", "40"));
const LIMIT = Number(arg("limit", "0")) || Infinity;

/** Players who legitimately hold cards in more than one sport. For these the
 *  minority is REAL and the premise of the check fails, so they are skipped
 *  rather than "corrected". */
const DUAL_SPORT = new Set([
  "michael jordan", "bo jackson", "deion sanders", "brian jordan", "kyler murray",
  "russell wilson", "tim tebow", "jim thorpe", "danny ainge", "dave winfield",
  "john elway", "drew henson", "chris weinke", "ricky williams", "charlie ward",
  "dave debusschere", "gene conley", "mark hendrickson", "jeff samardzija",
]);

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const sportOf = (slug) => String(slug ?? "").split(":")[1] || "";

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[sweep-sport-leaks] mode=${APPLY ? "APPLY" : "DRY-RUN"} minComps=${MIN_COMPS} dominance=${DOMINANCE} maxMinority=${MAX_MINORITY}\n`);

  // ── PASS 1: player -> sport histogram, whole container ────────────────────
  // Counts only. Row identities are NOT held here — 13M ids would not fit.
  const hist = new Map();   // player -> Map(sport -> count)
  let scanned = 0;
  {
    const iter = sold.items.query(
      `SELECT c.playerName, c.hobbyiqCardId FROM c
        WHERE IS_DEFINED(c.hobbyiqCardId) AND NOT IS_NULL(c.hobbyiqCardId) AND IS_DEFINED(c.playerName)`,
      { maxItemCount: 2000 },
    );
    while (iter.hasMoreResults() && scanned < LIMIT) {
      const { resources } = await iter.fetchNext();
      for (const r of resources || []) {
        if (scanned >= LIMIT) break;
        scanned++;
        const player = norm(r.playerName);
        const sport = sportOf(r.hobbyiqCardId);
        if (!player || !sport) continue;
        let m = hist.get(player);
        if (!m) hist.set(player, (m = new Map()));
        m.set(sport, (m.get(sport) ?? 0) + 1);
      }
      if (scanned % 500000 < 2000) process.stderr.write(`\r  pass1 scanned=${scanned} players=${hist.size}   `);
    }
  }
  process.stderr.write("\n");

  // ── Decide each player's home sport, and which sports are strays ──────────
  const homeOf = new Map();     // player -> { home, strays:Set }
  let skippedDual = 0, skippedThin = 0, skippedNoDominance = 0;
  for (const [player, m] of hist) {
    if (DUAL_SPORT.has(player)) { skippedDual++; continue; }
    const total = [...m.values()].reduce((s, n) => s + n, 0);
    if (total < MIN_COMPS) { skippedThin++; continue; }
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const [home, homeCount] = ranked[0];
    if (homeCount / total < DOMINANCE) { skippedNoDominance++; continue; }
    const strays = new Set();
    for (const [sport, n] of ranked.slice(1)) {
      if (!sport || sport === "multi-sport") continue;
      if (n / total <= MAX_MINORITY) strays.add(sport);
    }
    if (strays.size) homeOf.set(player, { home, strays, total, homeCount });
  }

  console.log(`pass1 scanned=${scanned.toLocaleString()} players=${hist.size.toLocaleString()}`);
  console.log(`  skipped: dual-sport ${skippedDual}, thin ${skippedThin.toLocaleString()}, no-dominance ${skippedNoDominance.toLocaleString()}`);
  console.log(`  players with at least one stray sport: ${homeOf.size.toLocaleString()}\n`);
  if (homeOf.size === 0) { console.log("nothing to repair."); return 0; }

  // ── PASS 2: collect the actual stray rows ────────────────────────────────
  const work = [];
  let scanned2 = 0;
  {
    const iter = sold.items.query(
      `SELECT c.id, c.cardId, c.playerName, c.hobbyiqCardId, c.sport, c.price FROM c
        WHERE IS_DEFINED(c.hobbyiqCardId) AND NOT IS_NULL(c.hobbyiqCardId) AND IS_DEFINED(c.playerName)`,
      { maxItemCount: 2000 },
    );
    while (iter.hasMoreResults() && scanned2 < LIMIT) {
      const { resources } = await iter.fetchNext();
      for (const r of resources || []) {
        if (scanned2 >= LIMIT) break;
        scanned2++;
        const info = homeOf.get(norm(r.playerName));
        if (!info) continue;
        const sport = sportOf(r.hobbyiqCardId);
        if (!info.strays.has(sport)) continue;
        const parts = String(r.hobbyiqCardId).split(":");
        parts[1] = info.home;
        work.push({ r, next: parts.join(":"), from: sport, to: info.home });
      }
      if (scanned2 % 500000 < 2000) process.stderr.write(`\r  pass2 scanned=${scanned2} strays=${work.length}   `);
    }
  }
  process.stderr.write("\n");

  const byMove = new Map();
  for (const w of work) {
    const k = `${w.from} -> ${w.to}`;
    byMove.set(k, (byMove.get(k) ?? 0) + 1);
  }
  console.log(`stray comps found: ${work.length.toLocaleString()}\n`);
  console.log("moves:");
  for (const [k, n] of [...byMove.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
    console.log(`   ${String(n).padStart(7)}  ${k}`);
  }
  console.log("\nexamples:");
  for (const w of work.slice(0, Math.min(TOP, 12))) {
    console.log(`   $${String(w.r.price).padEnd(9)} ${w.r.playerName}`);
    console.log(`      ${w.r.hobbyiqCardId}\n      -> ${w.next}`);
  }

  // ── Repair ───────────────────────────────────────────────────────────────
  let done = 0, failed = 0, cursor = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (cursor < work.length) {
      const w = work[cursor++];
      if (!APPLY) { done++; continue; }
      try {
        await sold.item(w.r.id, w.r.cardId).patch([
          { op: "add", path: "/sportBefore", value: w.r.sport ?? null },
          { op: "add", path: "/hobbyiqCardIdBefore", value: w.r.hobbyiqCardId },
          { op: "set", path: "/sport", value: w.to },
          { op: "set", path: "/hobbyiqCardId", value: w.next },
        ]);
        done++;
      } catch (e) {
        failed++;
        if (failed <= 5) console.log(`   patch failed ${w.r.id}: ${String(e.message).slice(0, 90)}`);
      }
    }
  }));

  console.log(`\n${APPLY ? "repaired" : "would repair"}=${done} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
