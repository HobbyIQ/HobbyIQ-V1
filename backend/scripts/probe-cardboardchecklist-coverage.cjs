#!/usr/bin/env node
/**
 * CF-CARDBOARDCHECKLIST-COVERAGE (Drew, 2026-08-19: "search the web for other
 * places" -> "yes do it").
 *
 * Measures how much of our ORPHAN gap a NEW checklist source can actually close,
 * BEFORE any of it is ingested.
 *
 * WHY MEASURE FIRST. 196,031 Bowman comps sit under a (year, number, player)
 * that no checklist we own covers, so the conformance audit cannot judge them.
 * That number cannot improve on its own: cardboardconnection.com — the only
 * source wired into gap-fill — has been unreachable since 2026-08-17 (verified
 * again today; search engines still serve its cached pages, so it LOOKS alive).
 *
 * THE CANDIDATE. cardboardchecklist.com exposes a free, public, read-only MCP
 * server at https://www.cardboardchecklist.com/api/mcp — plain JSON-RPC over
 * HTTP, no key, covering 1987-2026 across eight sports. Structured access beats
 * scraping a dying site.
 *
 * WHAT IT DOES AND DOES NOT HAVE. Verified by probe:
 *
 *   list_cards -> cardNumber, player, team, type, rookie, subset
 *   NO print run. NO colour parallels. hasOdds:false on every Bowman set tried.
 *
 * So this is a COVERAGE source, answering "does this card exist in this set for
 * this player". It cannot supply the parallel ladder — bccp and beckett already
 * do that, and 7,835,597 of our catalog rows carry a printRun. Different jobs.
 *
 * IT ALREADY EARNED ITS KEEP ONCE. Asked about Walker Jenkins it returns
 * CPA-WJ under "Chrome Prospect Autographs I" in 2024 BOWMAN, and NO CPA- card
 * at all in 2024 Bowman Chrome — independent third-party confirmation of the
 * bowman-chrome -> bowman direction the conformance audit derived from our own
 * data, from a source we do not control.
 *
 * READ-ONLY. Writes nothing to Cosmos and nothing to the catalog. It reports
 * what an ingest WOULD close, so the ingest is a decision rather than a hope.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/probe-cardboardchecklist-coverage.cjs \
 *     [--sport=baseball] [--family=bowman] [--years=2019-2026] [--delayMs=250]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SPORT = arg("sport", "baseball");
const FAMILY = arg("family", "bowman");
const YEARS = arg("years", "2019-2026");
const DELAY_MS = Number(arg("delayMs", "250"));
const MCP = "https://www.cardboardchecklist.com/api/mcp";

/** Same normalisation the conformance audit uses, so the comparison is
 *  apples-to-apples. A different notion of "same card" would make this
 *  measurement meaningless. */
const NOISE = new Set([
  "au", "auto", "autos", "autograph", "autographs", "on", "card", "true", "mini", "rc", "rookie",
  "gold", "blue", "green", "orange", "yellow", "aqua", "purple", "pink", "red", "black", "white",
  "silver", "teal", "bronze", "lava", "ice", "sepia", "refractor", "refractors", "xfractor",
  "prizm", "shimmer", "speckle", "mojo", "wave", "atomic", "sapphire", "superfractor", "grass",
  "redemption", "redeemed", "sealed", "first", "1st", "choice", "hta", "psa", "bgs", "sgc",
  "graded", "raw", "lot", "the", "of", "and", "jr", "sr", "ii", "iii",
]);
const core = (s) => String(s ?? "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/)
  .filter((w) => w.length > 1 && !NOISE.has(w)).slice(0, 2).join(" ");
const numKey = (n) => String(n ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rpcId = 0;
async function mcp(name, args, attempt = 0) {
  try {
    const res = await fetch(MCP, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const text = json?.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : null;
  } catch (e) {
    // A public free service deserves patience, not hammering.
    if (attempt < 3) { await sleep(1500 * (attempt + 1)); return mcp(name, args, attempt + 1); }
    console.log(`   mcp ${name} failed: ${String(e.message).slice(0, 70)}`);
    return null;
  }
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const [y0, y1] = YEARS.split("-").map(Number);

  console.log(`[cardboardchecklist-coverage] sport=${SPORT} family=${FAMILY} years=${y0}-${y1}\n`);

  // ── 1. Pull what the new source knows ────────────────────────────────────
  const theirs = new Map();   // "year|numKey" -> Set(player core)
  const setsSeen = [];
  for (let year = y0; year <= y1; year++) {
    const found = await mcp("search_checklists", { query: FAMILY, sport: SPORT, year: String(year), limit: 40 });
    await sleep(DELAY_MS);
    for (const s of found?.results ?? []) {
      const cards = await mcp("list_cards", { slug: s.slug, limit: 100000 });
      await sleep(DELAY_MS);
      const list = cards?.cards ?? [];
      setsSeen.push({ slug: s.slug, year, cards: list.length, total: cards?.totalMatched ?? list.length });
      for (const c of list) {
        const k = `${year}|${numKey(c.cardNumber)}`;
        const p = core(c.player);
        if (!k.endsWith("|") && p) {
          if (!theirs.has(k)) theirs.set(k, new Set());
          theirs.get(k).add(p);
        }
      }
      process.stderr.write(`\r  ${year} ${s.slug.padEnd(34)} ${String(list.length).padStart(5)} cards, keys=${theirs.size}   `);
    }
  }
  process.stderr.write("\n");
  console.log(`sets pulled            : ${setsSeen.length}`);
  console.log(`distinct (year, number): ${theirs.size.toLocaleString()}`);
  const truncated = setsSeen.filter((s) => s.total > s.cards);
  if (truncated.length) {
    console.log(`WARNING: ${truncated.length} set(s) returned fewer cards than totalMatched — coverage below is a FLOOR:`);
    for (const s of truncated.slice(0, 5)) console.log(`   ${s.slug} ${s.cards}/${s.total}`);
  }
  console.log("");

  // ── 2. What do WE already have, and what is orphaned? ────────────────────
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");

  const ours = new Map();     // "year|numKey" -> Set(player core), checklist-backed only
  {
    const iter = db.container("card_catalog").items.query({
      query: `SELECT c.cardNumber, c.playerName, c.year, c.source FROM c
               WHERE IS_STRING(c.cardNumber) AND c.cardNumber <> "" AND STARTSWITH(c.setKey, @f)`,
      parameters: [{ name: "@f", value: FAMILY }],
    }, { maxItemCount: 2000 });
    let n = 0;
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      for (const r of resources || []) {
        n++;
        const s = String(r.source ?? "").toLowerCase().replace(/-graded$/, "");
        if (/^(cardhedge|cardsight|ebay|ingest-auto-seed|sold-comps-stub|tree-builder|catalog-explode|user-verified)/.test(s)) continue;
        if (!/checklist|beckett|cardpedia|bccp|cardboard.?connection|almanac|hobbymonitor/.test(s)) continue;
        const y = Number(r.year);
        if (!(y >= y0 && y <= y1)) continue;
        const k = `${y}|${numKey(r.cardNumber)}`;
        const p = core(r.playerName);
        if (!p) continue;
        if (!ours.has(k)) ours.set(k, new Set());
        ours.get(k).add(p);
      }
      if (n % 500000 < 2000) process.stderr.write(`\r  our catalog scanned=${n} keys=${ours.size}   `);
    }
    process.stderr.write("\n");
  }
  console.log(`our checklist-backed (year, number) in range: ${ours.size.toLocaleString()}\n`);

  // ── 3. Judge our comps against BOTH ──────────────────────────────────────
  let comps = 0, coveredByUs = 0, orphanNow = 0, closedByThem = 0, stillOrphan = 0;
  const closedExamples = [], stillExamples = [];
  {
    const iter = db.container("sold_comps").items.query({
      query: `SELECT c.hobbyiqCardId, c.playerName FROM c
               WHERE STARTSWITH(c.hobbyiqCardId, @p) AND CONTAINS(c.hobbyiqCardId, @f)`,
      parameters: [{ name: "@p", value: `hiq:${SPORT}:` }, { name: "@f", value: `:${FAMILY}` }],
    }, { maxItemCount: 2000 });
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      for (const r of resources || []) {
        const parts = String(r.hobbyiqCardId).split(":");
        if (parts.length < 7) continue;
        const y = Number(parts[2]);
        if (!(y >= y0 && y <= y1)) continue;
        const p = core(r.playerName);
        if (!p) continue;
        comps++;
        const k = `${y}|${numKey(parts[4])}`;
        if (ours.get(k)?.has(p)) { coveredByUs++; continue; }
        orphanNow++;
        if (theirs.get(k)?.has(p)) {
          closedByThem++;
          if (closedExamples.length < 8) closedExamples.push(`${y} #${parts[4]} ${r.playerName}`);
        } else {
          stillOrphan++;
          if (stillExamples.length < 8) stillExamples.push(`${y} #${parts[4]} ${r.playerName}`);
        }
      }
      if (comps % 250000 < 2000) process.stderr.write(`\r  comps judged=${comps}   `);
    }
    process.stderr.write("\n");
  }

  const pct = (x) => `${((x / Math.max(orphanNow, 1)) * 100).toFixed(1)}%`;
  console.log(`comps in range              : ${comps.toLocaleString()}`);
  console.log(`  already covered by us     : ${coveredByUs.toLocaleString()}`);
  console.log(`  ORPHAN today              : ${orphanNow.toLocaleString()}\n`);
  console.log(`  -> closed by the new source: ${closedByThem.toLocaleString()}  ${pct(closedByThem)}`);
  console.log(`  -> still orphan            : ${stillOrphan.toLocaleString()}  ${pct(stillOrphan)}\n`);
  console.log("examples it WOULD close:");
  for (const e of closedExamples) console.log(`   ${e}`);
  console.log("\nexamples still uncovered (these need another source):");
  for (const e of stillExamples) console.log(`   ${e}`);
  console.log("\nREAD-ONLY. Nothing written. Ingest is a separate, reviewed step.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
