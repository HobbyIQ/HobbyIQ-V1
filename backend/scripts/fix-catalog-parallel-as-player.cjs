#!/usr/bin/env node
// CF-FIX-PARALLEL-AS-PLAYER (Drew, 2026-08-02).
//
// CardHedge's catalog occasionally delivers rows with the PARALLEL
// word stored in the `player` field (Superfractor, Sunflower Seeds,
// Pop Corn, Peanuts, Gum Ball, Sparkle, Red Lava, Mini Diamond,
// Refractor, etc.). Extremely common in 2025 Bowman Draft Chrome's
// snack-themed patterned refractor series.
//
// Real player name is the SAME across all variants of a physical
// card. So for any (year, cardNumber) group that has BOTH bad
// (parallel-word) and good (real name) rows, we can pick the real
// name from the good rows and rewrite the bad ones.
//
// Idempotent via __playerFixedAt marker.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   BACKFILL_MAX_MINUTES       per-slice cap (default 25)
//   BACKFILL_CONCURRENCY       parallel workers (default 8)

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.BACKFILL_APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.BACKFILL_MAX_MINUTES || 25));
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

const START = Date.now();
function timeExpired() { return (Date.now() - START) / 60000 > MAX_MINUTES; }

// Known parallel words that vendor rows sometimes put in the `player` field.
// Case-insensitive comparison.
const PARALLEL_WORDS = new Set([
  "superfractor", "refractor", "sapphire", "mini diamond", "x-fractor", "xfractor",
  "speckle", "wave", "ray wave", "shimmer", "lava", "grass",
  "mojo refractor", "mojo", "lazer refractor", "lazer",
  "sunflower seeds", "pop corn", "popcorn", "peanuts", "gum ball", "gumball", "sparkle",
  "red lava", "blue lava", "green lava", "gold lava", "orange lava", "purple lava",
  "red shimmer", "blue shimmer", "green shimmer", "gold shimmer", "orange shimmer",
  "red wave", "blue wave", "green wave", "gold wave", "orange wave", "purple wave", "aqua wave",
  "red ray wave", "blue ray wave", "green ray wave", "gold ray wave", "orange ray wave",
  "red speckle", "blue speckle", "green speckle", "gold speckle", "orange speckle",
  "chrome", "autograph", "base", "rookie", "image variation", "sterling",
  // Single color words are ambiguous (some real players like "Nick Silver") — still
  // flag but only "fix" when we find a clear alternate in the same group.
  "blue", "red", "gold", "orange", "green", "purple", "pink", "yellow", "aqua", "black", "silver",
].map(s => s.toLowerCase()));

function isParallelWord(name) {
  if (!name || typeof name !== "string") return false;
  return PARALLEL_WORDS.has(name.trim().toLowerCase());
}

async function withRetry(fn, attempts = 5, baseMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      if (i === attempts - 1) throw e;
      if (!(e?.code === 429 || e?.statusCode === 429)) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 150));
    }
  }
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  console.log(`[fix-catalog-parallel-as-player] apply=${APPLY} concurrency=${CONCURRENCY} maxMinutes=${MAX_MINUTES}`);

  console.log("Step 1: scan card_catalog to build (year, cardNumber) → { players: Map<name, count>, badRows: [ids] } ...");
  const groups = new Map();
  const iter = cc.items.query({
    query: "SELECT c.id, c.cardId, c.year, c.number, c.cardNumber, c.player, c.playerName, c.setName FROM c " +
           "WHERE c.source IN ('cardhedge', 'cardsight', 'canonical') " +
           "AND (IS_DEFINED(c.year) AND c.year != null) " +
           "AND (IS_DEFINED(c.number) OR IS_DEFINED(c.cardNumber))"
  }, { maxItemCount: 1000 });

  let scanned = 0;
  while (iter.hasMoreResults()) {
    if (timeExpired()) { console.log("⏰ scan time cap"); break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      scanned++;
      const cn = String(r.number ?? r.cardNumber ?? "").trim().toUpperCase();
      const yr = String(r.year ?? "");
      if (!cn || !yr) continue;
      const player = String(r.player ?? r.playerName ?? "").trim();
      if (!player) continue;
      const key = `${yr}::${cn}`;
      let g = groups.get(key);
      if (!g) { g = { players: new Map(), badRows: [] }; groups.set(key, g); }
      if (isParallelWord(player)) {
        g.badRows.push({ id: r.id, cardId: r.cardId, player });
      } else {
        g.players.set(player, (g.players.get(player) || 0) + 1);
      }
      if (scanned % 200000 === 0) console.log(`  scanned=${scanned}  groups=${groups.size}`);
    }
  }
  console.log(`  Scan done: ${scanned} rows in ${groups.size} groups`);

  // Step 2: for each group with badRows AND at least one good player, pick the majority good player and fix.
  let fixable = 0, unfixable = 0, groupsWithBad = 0;
  const fixPlan = [];
  for (const [key, g] of groups) {
    if (g.badRows.length === 0) continue;
    groupsWithBad++;
    if (g.players.size === 0) { unfixable += g.badRows.length; continue; }
    // Majority-vote real player
    const winner = [...g.players.entries()].sort((a, b) => b[1] - a[1])[0][0];
    for (const bad of g.badRows) {
      fixPlan.push({ id: bad.id, cardId: bad.cardId, oldPlayer: bad.player, newPlayer: winner, key });
      fixable++;
    }
  }
  console.log(`\n  Groups with bad rows: ${groupsWithBad}`);
  console.log(`  Bad rows FIXABLE (has real name in group): ${fixable}`);
  console.log(`  Bad rows UNFIXABLE (no real name to inherit): ${unfixable}`);

  if (!APPLY) {
    console.log(`\n  (dry run — set BACKFILL_APPLY=true to persist)`);
    console.log(`  Sample fixes:`);
    for (const f of fixPlan.slice(0, 10)) console.log(`    ${f.key.padEnd(20)}  ${f.oldPlayer.padEnd(20)} → ${f.newPlayer}`);
    console.log(`RELAUNCH_NEEDED=${timeExpired() ? "true" : "false"}`);
    return;
  }

  console.log(`\nStep 3: apply fixes...`);
  let applied = 0, errors = 0;
  const inFlight = [];
  async function applyOne(f) {
    try {
      const { resource } = await cc.item(f.id, f.cardId).read();
      if (!resource) { errors++; return; }
      resource.__playerFixedAt = new Date().toISOString();
      resource.__playerFixedFrom = f.oldPlayer;
      resource.player = f.newPlayer;
      resource.playerName = f.newPlayer;
      await withRetry(() => cc.items.upsert(resource));
      applied++;
    } catch { errors++; }
  }
  for (const f of fixPlan) {
    if (timeExpired()) { console.log("⏰ apply time cap"); break; }
    inFlight.push(applyOne(f));
    if (inFlight.length >= CONCURRENCY) {
      await Promise.race(inFlight);
      for (let i = inFlight.length - 1; i >= 0; i--) {
        const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
        if (s !== "PENDING") inFlight.splice(i, 1);
      }
    }
    if (applied % 500 === 0 && applied > 0) console.log(`  applied=${applied}  errors=${errors}`);
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  applied:   ${applied}`);
  console.log(`  errors:    ${errors}`);
  console.log(`RELAUNCH_NEEDED=${timeExpired() ? "true" : "false"}`);
}

main().catch(e => { console.error(e); console.log("RELAUNCH_NEEDED=true"); process.exit(0); });
