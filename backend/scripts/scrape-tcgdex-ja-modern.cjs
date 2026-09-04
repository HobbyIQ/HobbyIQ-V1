#!/usr/bin/env node
/**
 * CF-JA-MODERN-PARALLEL-LADDER (gap doc 2026-09-03, row 5 / recommendation 5).
 *
 * `scrape-tcgdex-ja.cjs` staged the VINTAGE ja-exclusive titles (PMCG*, neo*)
 * and it staged them BASE-ONLY: every row it writes carries `parallel=""` and
 * `printRun=""`. The gap report is explicit that this does not close the cell:
 *
 *   "A base-only checklist does not unblock these comps. The acquisition
 *    target is the parallel ladder with print runs, per set-year."
 *
 * The 294,208 pool rows behind the 210 modern JA cells are waiting on the
 * PARALLEL axis, and for Japanese Pokemon the parallel axis IS THE RARITY
 * LADDER -- Art Rare, Special Art Rare, Ultra Rare, Character Rare. A JA
 * card's rarity is not a grade of scarcity bolted onto one print; it is the
 * separate physical card collectors buy and sell under its own name, so it
 * belongs in `parallel` exactly as the source spells it.
 *
 * WHAT THIS ADDS OVER THE VINTAGE LANE
 *   1. Scope is the MODERN codes (SV*, S*, M*, CS*) the vintage lane never
 *      queued -- the manifest holds only PMCG/neo titles plus a lone SV10.
 *   2. `parallel` carries the source's own rarity string, and the reverse-holo
 *      variant is emitted as its OWN row, because a reverse holo is a
 *      different card with a different price than the normal print.
 *   3. `printRun` stays EMPTY. tcgdex serves no print runs for JA sets and
 *      this lane will not invent one: blank means unknown, never "Base".
 *
 * SETKEY IS THE BARE OFFICIAL CODE -- sv8a, s12a, s8b -- per the ruling
 * CF-THE-JAPANESE-CODE-IS-THE-KEY (Drew, 2026-09-01, R1/R2/R3). The driver
 * derives it from the set id, and 176 of the 184 ja ids are already
 * `normalizeSetKey` fixed points; the 8 that are not (`sm1+`, `cs2.5`) are
 * punctuation cases OUTSIDE this lane's modern scope and are refused here
 * rather than silently reshaped.
 *
 * THE NAME BRIDGE is unchanged and still deterministic: dexId -> English
 * species via data/pokemon-dex-bridge.json. Trainers/Energy keep the source's
 * own Japanese name. A Pokemon card the source serves WITHOUT a dexId is
 * COUNTED AND SKIPPED -- never transliterated, never guessed.
 *
 * PERMISSIONS. api.tcgdex.net/robots.txt disallows crawlers and then says in
 * its own words: "Please note that this is for Crawlers only / You can
 * logically use robots to use the API". The data is MIT (tcgdex/cards-database
 * LICENSE). Real UA, ~130ms between calls, retry with backoff on 429/5xx.
 *
 * STAGING ONLY -- canonical CSV + manifest per set. Nothing reaches Cosmos
 * here; the authority-checked ingest is the only writer.
 *
 * Args: --outDir=C:/tmp/tcgdex-ja-modern --delayMs=130 --sets=SV8a,S12a --limit=0
 */
const fs = require("node:fs");
const path = require("node:path");

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const OUT_DIR = arg("outDir", "C:/tmp/tcgdex-ja-modern");
const DELAY = Number(arg("delayMs", "130"));
const LIMIT = Number(arg("limit", "0")) || Infinity;
const ONLY = arg("sets", "").split(",").map((s) => s.trim()).filter(Boolean);

const UA = "HobbyIQ-ChecklistBot/1.0 (+https://github.com/HobbyIQ/HobbyIQ-V1; checklist acquisition)";

/** The modern JA era this lane owns. The vintage lane keeps PMCG*, neo*, etc. */
const MODERN_ID = /^(SV|S\d|CS|M[0-9]|M-P|SVK|SVLN|SVLS)/i;

/** dexId -> English species slug, ALL generations tcgdex serves. */
const BRIDGE_PATH = path.join(__dirname, "..", "data", "pokemon-dex-bridge.json");
let DEX_SPECIES, DEX_MAX;
try {
  const doc = JSON.parse(fs.readFileSync(BRIDGE_PATH, "utf8"));
  DEX_SPECIES = doc.species || {};
  DEX_MAX = Number(doc.maxDexId) || 0;
  if (Object.keys(DEX_SPECIES).length < 251) throw new Error(`only ${Object.keys(DEX_SPECIES).length} species`);
} catch (e) {
  console.error(`FATAL: dex-bridge unusable at ${BRIDGE_PATH} (${e.message})`);
  console.error("       regenerate with: node backend/scripts/fetchPokemonDexBridge.cjs");
  process.exit(1);
}

/**
 * A rarity string that names NO distinct card. tcgdex uses "None" (and
 * occasionally an absent field) for the ordinary print in sets whose ladder it
 * has not fully typed. Those rows are the BASE print, and per the one checklist
 * format an unknown parallel is written BLANK -- never the literal "Base",
 * which would assert a parallel name the source never said.
 */
const NON_PARALLEL_RARITY = new Set(["", "none", "common", "uncommon", "rare"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const csvEsc = (s) => { const v = String(s ?? ""); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };

/**
 * The one card -> the checklist rows it produces. Pure, so the format rules it
 * enforces are testable without a network: blank parallel for an unnamed print,
 * the source's own rarity spelling for a named one, a SEPARATE row for the
 * reverse holo, never an auto, never a print run.
 *
 * Returns [] for a card the dex bridge cannot name -- the caller counts those.
 */
function rowsForCard(detail, dexSpecies) {
  const out = [];
  let player = null;
  const dex = Array.isArray(detail?.dexId) ? detail.dexId[0] : null;
  if (dex && dexSpecies[String(dex)]) player = dexSpecies[String(dex)];
  else if (detail?.category && detail.category !== "Pokemon") player = String(detail.name ?? "");
  if (!player) return out;

  const num = String(detail?.localId ?? "").trim();
  if (!num) return out;

  const rawRarity = String(detail?.rarity ?? "").trim();
  const isParallel = !NON_PARALLEL_RARITY.has(rawRarity.toLowerCase());
  const parallel = isParallel ? rawRarity : "";

  out.push({ category: "base", cardNumber: num, parallel, isAuto: false, printRun: "", player });

  // A reverse holo is a different card with its own pool and its own price --
  // stated by the source per card, and only for a print that is not already a
  // named parallel (a Special Art Rare has no reverse twin).
  if (detail?.variants && detail.variants.reverse === true && !isParallel) {
    out.push({ category: "base", cardNumber: num, parallel: "Reverse Holo", isAuto: false, printRun: "", player });
  }
  return out;
}

const csvLine = (r) => [r.category, csvEsc(r.cardNumber), csvEsc(r.parallel), String(r.isAuto), csvEsc(r.printRun), csvEsc(r.player)].join(",");

async function get(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) { console.log(`   HTTP ${res.status} ${url.slice(0, 80)}`); return null; }
    return await res.json();
  } catch (e) {
    if (attempt < 3) { await sleep(2000 * (attempt + 1)); return get(url, attempt + 1); }
    console.log(`   fetch failed ${url.slice(0, 70)}: ${String(e.message).slice(0, 40)}`);
    return null;
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const [ja, en] = await Promise.all([
    get("https://api.tcgdex.net/v2/ja/sets"),
    get("https://api.tcgdex.net/v2/en/sets"),
  ]);
  if (!ja || !en) { console.error("FATAL: set catalogs unreachable"); process.exit(1); }
  const enIds = new Set(en.map((s) => s.id));

  // ja-EXCLUSIVE only: a set that exists in EN is served by the EN pipeline and
  // ingesting its ja twin would mint duplicate vocabulary.
  let work = ja.filter((s) => !enIds.has(s.id) && MODERN_ID.test(s.id));
  if (ONLY.length) {
    const want = new Set(ONLY.map((s) => s.toLowerCase()));
    work = ja.filter((s) => want.has(s.id.toLowerCase()));
  }

  console.log(`[tcgdex-ja-modern] ${ja.length} ja sets -> ${work.length} modern ja-exclusive in scope`);
  console.log(`[dex-bridge] ${Object.keys(DEX_SPECIES).length} species, dexId 1..${DEX_MAX}`);
  console.log(`[permissions] MIT (tcgdex/cards-database); robots.txt permits API use; ${DELAY}ms between calls\n`);

  const report = [];
  let staged = 0, totalRows = 0, unnamed = 0, skippedSets = 0, done = 0;

  for (const s of work) {
    if (done >= LIMIT) break;
    done++;
    const d = await get(`https://api.tcgdex.net/v2/ja/sets/${s.id}`);
    await sleep(DELAY);

    // A set the source serves with no card array is a SOURCE limit. Counted and
    // reported, never padded out with the cardCount the index claimed.
    if (!d || !Array.isArray(d.cards) || !d.cards.length) {
      skippedSets++;
      report.push({ setId: s.id, staged: false, reason: "source serves no cards" });
      console.log(`  ${s.id.padEnd(7)} SKIPPED -- source serves no card array`);
      continue;
    }
    const year = Number(String(d.releaseDate ?? "").slice(0, 4));
    if (!year) {
      skippedSets++;
      report.push({ setId: s.id, staged: false, reason: "no releaseDate" });
      console.log(`  ${s.id.padEnd(7)} SKIPPED -- no releaseDate, not guessed`);
      continue;
    }

    const lines = ["category,cardNumber,parallel,isAuto,printRun,player"];
    const ladder = new Map();
    let rows = 0, setUnnamed = 0, reverseRows = 0;

    for (const c of d.cards) {
      const detail = await get(`https://api.tcgdex.net/v2/ja/cards/${c.id}`);
      await sleep(DELAY);
      if (!detail) continue;

      // A Pokemon card with no dexId served: counted, never invented.
      const produced = rowsForCard({ ...detail, localId: detail.localId ?? c.localId }, DEX_SPECIES);
      if (!produced.length) { unnamed++; setUnnamed++; continue; }

      for (const r of produced) {
        lines.push(csvLine(r));
        rows++;
        if (r.parallel === "Reverse Holo") reverseRows++;
        ladder.set(r.parallel || "(base)", (ladder.get(r.parallel || "(base)") ?? 0) + 1);
      }
    }

    if (!rows) {
      skippedSets++;
      report.push({ setId: s.id, staged: false, reason: "no nameable rows" });
      console.log(`  ${s.id.padEnd(7)} SKIPPED -- 0 nameable rows (${setUnnamed} unbridgeable)`);
      continue;
    }

    // SETKEY = THE BARE OFFICIAL CODE (ruling R1/R2/R3, 2026-09-01).
    const setKey = s.id.toLowerCase();
    const file = `${year}-${setKey}-pokemon`;
    fs.writeFileSync(path.join(OUT_DIR, `${file}.csv`), lines.join("\n") + "\n");
    fs.writeFileSync(path.join(OUT_DIR, `${file}.csv.meta.json`), JSON.stringify({
      productKey: `${year}-${setKey}`,
      sport: "pokemon",
      year,
      setKey,
      source: "tcgdex-ja-modern",
      confidence: 0.9,
      provenance: `api.tcgdex.net/v2/ja/sets/${s.id} (MIT, tcgdex/cards-database) fetched ${new Date().toISOString().slice(0, 10)} -- ${rows} rows, ${ladder.size} ladder entries`,
      setName: `Japanese ${d.name ?? s.id}`,
      tcgdexId: s.id,
      sourceUrl: `https://api.tcgdex.net/v2/ja/sets/${s.id}`,
    }, null, 2) + "\n");

    staged++; totalRows += rows;
    report.push({
      setId: s.id, setKey, year, staged: true, rows,
      sourceCards: d.cards.length, reverseRows, unbridgeable: setUnnamed,
      ladder: [...ladder.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ parallel: k, rows: n })),
    });
    console.log(`  ${s.id.padEnd(7)} y=${year} rows=${String(rows).padEnd(4)} ladder=${String(ladder.size).padEnd(2)} rev=${String(reverseRows).padEnd(4)} unbridged=${setUnnamed}`);
  }

  fs.writeFileSync(path.join(OUT_DIR, "_staging-report.json"), JSON.stringify(report, null, 1) + "\n");

  console.log(`\n  sets staged        ${staged}`);
  console.log(`  card rows          ${totalRows}`);
  console.log(`  unnameable         ${unnamed}   <- no dexId served by the source; counted, not guessed`);
  console.log(`  sets skipped       ${skippedSets}   <- source served no cards / no releaseDate`);
  console.log(`  printRun           0 written -- tcgdex serves none for JA; blank means unknown`);
  console.log(`\nSTAGING ONLY -- nothing written to Cosmos.`);
}

module.exports = { rowsForCard, csvLine, MODERN_ID, NON_PARALLEL_RARITY };

// Only crawl when RUN as a script; a `require` from the tests must not fetch.
if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack ?? e?.message); process.exit(1); });
}
