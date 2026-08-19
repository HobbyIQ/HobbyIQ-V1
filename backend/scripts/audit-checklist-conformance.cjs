#!/usr/bin/env node
/**
 * CF-CHECKLIST-CONFORMANCE (Drew, 2026-08-19: "No bowman Draft is mixed in with
 * chrome? we need all bowman to match checklists").
 *
 * Asks one question of every comp in a product family: does the CHECKLIST for
 * the setKey this comp claims actually contain this card number, for this
 * player? If not, which setKey's checklist does?
 *
 * WHY THIS IS THE RIGHT QUESTION. Every earlier audit could only produce
 * candidates. Shared player + shared number looks identical whether it is one
 * card mis-filed or two real products reusing a number — Ohtani #17 exists in
 * Bowman, Bowman Chrome, Mega Box AND Sapphire, and merging those would flatten
 * a $500 Sapphire into a $5 paper base. Price-at-equal-grade ranks a candidate
 * but cannot prove it. The checklist is the only authority that can, because it
 * is a transcription of what was actually printed.
 *
 * SOURCES ARE NOT EQUAL, AND THE TEST MUST BE A PATTERN. Only transcriptions count
 * as evidence. A vendor's own catalog records how the VENDOR types, not what
 * the manufacturer printed, and vendor rows are exactly where the bad spellings
 * live — 41,638 vendor rows say BCP109 while checklist rows say BCP-109 every
 * single time. `ingest-auto-seed` is worse than useless here: it is our own
 * guesses written back as if they were evidence, so a mis-slugged comp would
 * vote to confirm itself.
 *
 * PLAYER MUST MATCH TOO. Finding the number in another set's checklist is not
 * enough — 2,633 numbers in the Bowman family are shared by DIFFERENT players.
 * Moving on number alone would file a card under someone else's name. A move is
 * only proposed when the target checklist has that number AND the same player.
 *
 * FOUR VERDICTS:
 *   CONFORMANT  the claimed setKey's checklist has this number + player
 *   MOVE        exactly ONE other setKey in the family matches — unambiguous
 *   AMBIGUOUS   several setKeys match; the checklist cannot choose
 *   ORPHAN      no checklist in the family has it (missing checklist, a parse
 *               error, or a number we invented) — needs a human, never a move
 *
 * Only MOVE is ever written. AMBIGUOUS and ORPHAN are left exactly as they are.
 *
 * The write lives HERE rather than in reslug-setkey-segment because the target
 * is decided per ROW, not per setKey pair: the same claimed setKey sends
 * different cards to different homes depending on which checklist lists their
 * number. Expressing 176,869 such decisions as a mapping table would mean
 * re-deriving them, and a second derivation is a second chance to get the
 * direction wrong.
 *
 * Segment 3 only. The checklist proves which SET a card belongs to; it says
 * nothing about parallel, auto or serial, and those are already correct on the
 * row. A full re-derive risks losing a parallel the slug captured but the
 * vendor title never mentioned.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-checklist-conformance.cjs \
 *     [--family=bowman] [--sport=baseball] [--top=40] [--minComps=3]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const FAMILY = arg("family", "bowman");
const SPORT = arg("sport", "baseball");
const TOP = Number(arg("top", "40"));
const MIN_COMPS = Number(arg("minComps", "3"));
const APPLY = process.argv.includes("--apply");
const POOL = Math.max(1, Number(arg("pool", "8")));

/**
 * Is this source a transcription of a printed checklist?
 *
 * MATCHED BY PATTERN, NOT BY AN EXACT LIST — and that distinction is the whole
 * lesson here. The first version hardcoded five exact strings and reported that
 * only 6.1% of Bowman catalog rows were checklist-backed, which read as a
 * catastrophic data gap. The real figure is 87.8%. The allowlist was wrong, not
 * the data.
 *
 * What it silently discarded:
 *   baseballcardpedia   918,828 rows   the single largest checklist source
 *   bccp                375,722        (the same site, abbreviated)
 *   checklistcenter-html 35,972        a spelling variant of an allowed source
 *   checklist            20,219
 *   beckett-scraped-2026-08-13/-17/-18  only the -19 run was listed
 *   ...and the "-graded" twin of every one of them
 *
 * Dated scrape runs and `-graded` variants mint a NEW source string every time,
 * so an exact list silently rots with each run. An audit whose authority set
 * decays is worse than no audit: it reports a shrinking evidence base as if it
 * were a growing data problem.
 *
 * The exclusions are what matter and they are explicit: a vendor catalog
 * records how the VENDOR types, and `ingest-auto-seed` / `sold-comps-stub` /
 * `catalog-explode` are our own inferences written back — a mis-slugged comp
 * would vote to confirm itself.
 */
function isChecklistSource(source) {
  const s = String(source ?? "").toLowerCase().replace(/-graded$/, "");
  if (/^(cardhedge|cardsight|ebay|ingest-auto-seed|sold-comps-stub|tree-builder|catalog-explode|user-verified)/.test(s)) return false;
  if (/-product-structure$/.test(s)) return false;
  return /checklist|beckett|cardpedia|bccp|cardboard.?connection|almanac|hobbymonitor/.test(s);
}

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

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");

  console.log(`[checklist-conformance] family=${FAMILY} sport=${SPORT}\n`);

  // ── 1. The checklist, as (year|number) -> setKey -> Set(player cores) ─────
  // Numbers are compared with punctuation stripped so BCP109 and BCP-109 are
  // the same key here. Conformance must not depend on a spelling defect that
  // repair-cardnumber-hyphen is separately fixing.
  const checklist = new Map();
  const setsInFamily = new Set();
  {
    const iter = db.container("card_catalog").items.query({
      query: `SELECT c.setKey, c.cardNumber, c.playerName, c.year, c.source FROM c
               WHERE IS_STRING(c.cardNumber) AND c.cardNumber <> "" AND STARTSWITH(c.setKey, @f)`,
      parameters: [{ name: "@f", value: FAMILY }],
    }, { maxItemCount: 2000 });
    let n = 0, kept = 0;
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      for (const r of resources || []) {
        n++;
        if (!isChecklistSource(r.source)) continue;
        const num = numKey(r.cardNumber);
        const p = core(r.playerName);
        if (!num || !p || !r.year) continue;
        kept++;
        setsInFamily.add(r.setKey);
        const k = `${r.year}|${num}`;
        let bySet = checklist.get(k);
        if (!bySet) checklist.set(k, (bySet = new Map()));
        let players = bySet.get(r.setKey);
        if (!players) bySet.set(r.setKey, (players = new Set()));
        players.add(p);
      }
      if (n % 250000 < 2000) process.stderr.write(`\r  catalog scanned=${n} kept=${kept} keys=${checklist.size}   `);
    }
    process.stderr.write("\n");
    console.log(`checklist-backed rows kept : ${kept.toLocaleString()} of ${n.toLocaleString()} catalog rows`);
    console.log(`distinct (year, number)    : ${checklist.size.toLocaleString()}`);
    console.log(`setKeys with a checklist   : ${setsInFamily.size}\n`);
    if (!kept) { console.log("no checklist-backed rows — cannot adjudicate."); return 0; }
  }

  // ── 2. Judge every comp ──────────────────────────────────────────────────
  const work = [];              // rows the checklist condemns, with their target
  const moves = new Map();      // "from -> to" -> { comps, cards:Set }
  const stats = { conformant: 0, move: 0, ambiguous: 0, orphan: 0, unjudgeable: 0 };
  const orphanBySet = new Map();
  const moveExamples = new Map();
  {
    const iter = db.container("sold_comps").items.query({
      query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.playerName FROM c
               WHERE STARTSWITH(c.hobbyiqCardId, @p) AND CONTAINS(c.hobbyiqCardId, @f)`,
      parameters: [{ name: "@p", value: `hiq:${SPORT}:` }, { name: "@f", value: `:${FAMILY}` }],
    }, { maxItemCount: 2000 });
    let n = 0;
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      for (const r of resources || []) {
        n++;
        const parts = String(r.hobbyiqCardId).split(":");
        if (parts.length < 7) { stats.unjudgeable++; continue; }
        const [, , year, setKey, rawNum] = parts;
        const num = numKey(rawNum);
        const player = core(r.playerName);
        if (!num || !player || !setKey.startsWith(FAMILY)) { stats.unjudgeable++; continue; }

        const bySet = checklist.get(`${year}|${num}`);
        if (!bySet) { stats.orphan++; orphanBySet.set(setKey, (orphanBySet.get(setKey) ?? 0) + 1); continue; }

        // Which setKeys list this number for THIS player?
        const hits = [];
        for (const [sk, players] of bySet) if (players.has(player)) hits.push(sk);
        if (!hits.length) { stats.orphan++; orphanBySet.set(setKey, (orphanBySet.get(setKey) ?? 0) + 1); continue; }
        if (hits.includes(setKey)) { stats.conformant++; continue; }
        if (hits.length > 1) { stats.ambiguous++; continue; }

        stats.move++;
        // Segment 3 ONLY. The checklist proved WHICH SET this card belongs to;
        // it says nothing about the parallel, auto or serial, and those are
        // already correct on the row. A full re-derive would risk losing a
        // parallel the slug captured but the title never mentioned.
        {
          const next = [...parts];
          next[3] = hits[0];
          work.push({ id: r.id, cardId: r.cardId, before: r.hobbyiqCardId, next: next.join(":") });
        }
        const k = `${setKey}  ->  ${hits[0]}`;
        let agg = moves.get(k);
        if (!agg) moves.set(k, (agg = { comps: 0, cards: new Set() }));
        agg.comps++; agg.cards.add(`${year}|${num}`);
        if (!moveExamples.has(k)) moveExamples.set(k, `${year} #${rawNum} ${r.playerName}`);
      }
      if (n % 250000 < 2000) process.stderr.write(`\r  comps scanned=${n}   `);
    }
    process.stderr.write("\n");
  }

  const total = stats.conformant + stats.move + stats.ambiguous + stats.orphan + stats.unjudgeable;
  const pct = (x) => `${((x / Math.max(total, 1)) * 100).toFixed(1)}%`;
  console.log(`comps judged: ${total.toLocaleString()}\n`);
  console.log(`  CONFORMANT   claimed set's checklist has it : ${String(stats.conformant).padStart(9)}  ${pct(stats.conformant)}`);
  console.log(`  MOVE         exactly one other set matches  : ${String(stats.move).padStart(9)}  ${pct(stats.move)}`);
  console.log(`  AMBIGUOUS    several sets match             : ${String(stats.ambiguous).padStart(9)}  ${pct(stats.ambiguous)}`);
  console.log(`  ORPHAN       no checklist has it            : ${String(stats.orphan).padStart(9)}  ${pct(stats.orphan)}`);
  console.log(`  unjudgeable  malformed slug / no player     : ${String(stats.unjudgeable).padStart(9)}  ${pct(stats.unjudgeable)}\n`);

  console.log("── UNAMBIGUOUS MOVES, by comps ──");
  for (const [k, v] of [...moves.entries()].sort((a, b) => b[1].comps - a[1].comps).slice(0, TOP)) {
    if (v.comps < MIN_COMPS) continue;
    console.log(`  ${String(v.comps).padStart(7)} comps  ${String(v.cards.size).padStart(5)} cards   ${k}`);
    console.log(`            e.g. ${moveExamples.get(k)}`);
  }

  console.log("\n── ORPHANS by claimed setKey (no checklist covers them) ──");
  for (const [k, v] of [...orphanBySet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(v).padStart(8)}  ${k}`);
  }

  if (!APPLY) {
    console.log("\nDRY-RUN. MOVE is the only actionable verdict; ORPHAN usually means a");
    console.log("checklist we do not own yet, not a card that is filed wrongly.");
    console.log("Re-run with --apply to write MOVE rows. AMBIGUOUS and ORPHAN are never touched.");
    return 0;
  }

  // Only rows a checklist POSITIVELY reassigned reach this point. AMBIGUOUS
  // (several sets list the number) and ORPHAN (no checklist has it) are left
  // exactly as they are — ORPHAN in particular is usually a checklist we have
  // not acquired, and treating a gap in our evidence as a filing error would be
  // the largest bad write available here.
  const sold = db.container("sold_comps");
  let done = 0, failed = 0, cursor = 0;
  console.log(`\napplying ${work.length.toLocaleString()} checklist-proven moves...`);
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (cursor < work.length) {
      const w = work[cursor++];
      try {
        await sold.item(w.id, w.cardId).patch([
          { op: "add", path: "/hobbyiqCardIdBefore", value: w.before },
          { op: "set", path: "/hobbyiqCardId", value: w.next },
          { op: "add", path: "/reslugReason", value: "CF-CHECKLIST-CONFORMANCE" },
        ]);
        done++;
        if (done % 5000 === 0) process.stderr.write(`\r  patched ${done}/${work.length}   `);
      } catch (e) {
        failed++;
        if (failed <= 5) console.log(`   patch failed ${w.id}: ${String(e.message).slice(0, 80)}`);
      }
    }
  }));
  console.log(`\nrepaired=${done} failed=${failed}`);
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
