#!/usr/bin/env node
// CF-POKEMON-CHECKLIST-FROM-API (Drew, 2026-08-13: "do it, ingest it from the
// api").
//
// TCG checklist acquisition from the pokemon-tcg-data dataset — free,
// structured and complete. No Beckett S3 filename probing, no HTML scraping.
//
// Sourced from GitHub rather than the api.pokemontcg.io REST API: that API
// returned HTTP 500 on every endpoint (including a bare /sets) when this was
// written. The GitHub dataset is the same project's data and is a better
// dependency anyway — no key, no rate limit, no downtime, versioned.
//
// WHY THIS IS THE HIGH-VALUE INGEST. Pokemon already MATCHES: 402,809 comps
// have promoted under hiq:pokemon:… against 48,094 catalog rows. The sets that
// fail are simply absent from the catalog:
//
//   set                      catalog rows   staged sales waiting
//   swsh10-astral-radiance         2              30,058
//   hidden-fates                  19               3,084
//   neo-genesis                   37               1,724
//
// So this is not a vertical problem, it is a coverage problem, and the coverage
// is free to acquire.
//
// MATCHING THE CONVENTIONS SALES ALREADY COMPUTE — the whole job. A checklist
// that does not reproduce these exactly would ingest cleanly and match nothing:
//
//   slug      hiq:pokemon:2022:swsh10-astral-radiance:072189:holofoil:no-auto
//   setKey    swsh10-astral-radiance   from title "SWSH10: Astral Radiance"
//   number    072189                   = 072/189 — zero-pad(3) + PRINTED total
//   parallel  holofoil                 the finish, from the title
//
// The denominator is `printedTotal`, NOT `total`: secret rares number ABOVE it
// (164/142 in SV07 Stellar Crown), which is exactly how the vendor writes them.
//
// One catalog row is emitted per FINISH the card exists in, because the finish
// is part of the identity — a Normal and a Holofoil of the same number are
// different cards at very different prices.
//
//   node scripts/fetchPokemonTcgChecklist.cjs --set-id swsh10 \
//     --set-key swsh10-astral-radiance --year 2022 \
//     --out data/checklists/scraped/2022-swsh10-astral-radiance.csv

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SET_ID = val("--set-id", "");
const SET_KEY = val("--set-key", "");
const YEAR = Number(val("--year", "0"));
const OUT = val("--out", "");
const QUIET = args.includes("--quiet");

if (!SET_ID || !OUT) { console.error("--set-id and --out are required"); process.exit(2); }
const log = (...a) => { if (!QUIET) console.log(...a); };

// The live API at api.pokemontcg.io returned HTTP 500 on every endpoint,
// including a bare /sets — the service, not our request. The same project
// publishes the identical dataset as static JSON on GitHub, which is the better
// source regardless: no rate limits, no key, no downtime, and versioned.
const DATA_BASE = "https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "HobbyIQ-checklist/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchJson(res.headers.location));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      let b = ""; res.setEncoding("utf8");
      res.on("data", (c) => { b += c; });
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

/**
 * Finishes a card exists in, DERIVED FROM RARITY.
 *
 * The static dataset carries no price/finish keys, but Pokemon set structure is
 * regular: Common / Uncommon / plain Rare are printed Normal and also appear as
 * Reverse Holofoil; anything "Rare Holo" and above is holo-only.
 *
 * Erring toward MORE finishes on purpose. A catalog row no sale ever matches is
 * harmless; a missing finish leaves real sales unmatched, which is the problem
 * we are here to fix.
 */
function finishesOf(card) {
  const rarity = String(card.rarity ?? "").trim();
  if (!rarity) return ["Normal"];
  if (/^(common|uncommon|rare)$/i.test(rarity)) return ["Normal", "Reverse Holofoil"];
  if (/holo|ultra|rainbow|secret|radiant|shiny|amazing|prime|legend|star|promo/i.test(rarity)) {
    return ["Holofoil"];
  }
  return ["Normal", "Reverse Holofoil"];
}

(async () => {
  log(`fetching set ${SET_ID} from pokemon-tcg-data`);
  const allSets = await fetchJson(`${DATA_BASE}/sets/en.json`);
  const set = allSets.find((s) => String(s.id) === SET_ID);
  if (!set) { console.error(`set id "${SET_ID}" not found among ${allSets.length} sets`); process.exit(1); }

  // printedTotal is the denominator the hobby (and our vendor titles) use.
  const denom = set.printedTotal ?? set.total;
  const year = YEAR || Number(String(set.releaseDate || "").slice(0, 4));
  const setKey = SET_KEY || String(set.id);
  log(`  ${set.name}  released ${set.releaseDate}  printedTotal=${denom}  total=${set.total}`);

  const cards = await fetchJson(`${DATA_BASE}/cards/en/${encodeURIComponent(SET_ID)}.json`);
  log(`  ${cards.length} cards`);
  if (cards.length === 0) { console.error("no cards returned"); process.exit(1); }

  const q = (s) => (/[",]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const rows = [];
  const byFinish = {};
  for (const c of cards) {
    // "72" -> "072"; alphanumeric promos (TG08, SV07) keep their form.
    const raw = String(c.number ?? "").trim();
    const num = /^\d+$/.test(raw) ? raw.padStart(3, "0") : raw.toUpperCase();
    const cardNumber = `${num}${denom}`;
    for (const finish of finishesOf(c)) {
      byFinish[finish] = (byFinish[finish] ?? 0) + 1;
      // THE FINISH MUST RIDE IN `category`, NOT `parallel`.
      //
      // ingest-scraped-checklist derives the parallel from the CATEGORY
      // (CF-CHECKLIST-SECTION-IS-THE-PARALLEL) and ignores the CSV's parallel
      // column outright: category "base" always yields parallel "Base". The
      // first pass put finishes in the parallel column, so all 324 rows
      // collapsed onto `:base:` — a Holofoil Machamp V and a Normal Scyther
      // landing on the same slug, which is the exact collision that rule exists
      // to prevent.
      //
      // "Normal" IS the base card and stays category=base, which is also what
      // the sales compute (a Normal sale slugs to `:base:`). Every other finish
      // becomes an insert- section, and sectionLabel turns it back into the
      // parallel label: insert-holofoil -> "Holofoil" -> `:holofoil:`.
      const category = /^normal$/i.test(finish)
        ? "base"
        : `insert-${finish.toLowerCase().replace(/\s+/g, "-")}`;
      rows.push({
        category,
        cardNumber,
        parallel: finish,   // carried for readability; the ingest reads category
        isAuto: "false",
        printRun: "",
        player: c.name ?? "",
      });
    }
  }

  // Same duplicate guard the other converters use — identical
  // category+number+parallel+player twice would upsert over itself.
  const seen = new Set();
  const kept = rows.filter((r) => {
    const k = `${r.cardNumber}|${r.parallel}|${r.player}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  const csv = ["category,cardNumber,parallel,isAuto,printRun,player"];
  for (const r of kept) csv.push([r.category, r.cardNumber, q(r.parallel), r.isAuto, r.printRun, q(r.player)].join(","));
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(path.resolve(OUT), csv.join("\n") + "\n");

  fs.writeFileSync(path.resolve(OUT).replace(/\.csv$/, ".manifest.json"), JSON.stringify({
    source: "pokemon-tcg-data",
    sourceUrl: `${DATA_BASE}/cards/en/${SET_ID}.json`,
    // sport is the legacy field name for the VERTICAL — see
    // resolveVertical.service.ts. It must be `pokemon` so these rows land at
    // hiq:pokemon:… where the sales compute.
    sport: "pokemon",
    year,
    setKey,
    setName: set.name,
    printedTotal: denom,
    rows: kept.length,
    deduped: rows.length - kept.length,
    finishes: byFinish,
    fetchedAt: new Date().toISOString(),
  }, null, 2));

  log(`rows=${kept.length} (deduped ${rows.length - kept.length})  finishes=${JSON.stringify(byFinish)}`);
  log(`sample slug it should produce: hiq:pokemon:${year}:${setKey}:${kept[0].cardNumber}:${String(kept[0].parallel).toLowerCase().replace(/\s+/g, "-")}:no-auto`);
  log(`wrote ${OUT}`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
