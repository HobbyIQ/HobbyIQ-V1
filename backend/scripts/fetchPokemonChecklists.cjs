#!/usr/bin/env node
// CF-POKEMON-CHECKLISTS (Drew, 2026-08-16: "let's find the pokemon set lists
// somewhere to fill in gaps ... let's fix it and get the checklists to match.
// Do this right").
//
// WHY. 766,677 sold_comps rows carry a `hiq:pokemon:` slug and 564,103 of them
// (73.6%) have `setKey: unknown` — a well-formed slug that can never join a
// catalog row, so those sales roll up to nothing. Pokemon is not a fringe
// vertical in our pool; it is the single largest block of unmatched comps.
//
// SOURCE. tcgdex.net, free and keyless. One request per set returns every card
// with its number and name, plus a cardCount breakdown. 218 sets as of
// 2026-08-16. api.pokemontcg.io was the alternative and also works; TCGdex wins
// on requests-per-set and because it carries image URLs, which matter given
// only 2.8% of our catalog rows have a picture.
//
// SETKEY IS THE SET ID, NOT THE SET NAME. This is the whole point of "do this
// right". Our existing Pokemon slugs embed the year in the setKey —
//
//     hiq:pokemon:1999:1999-pokemon-base-set:...
//     hiq:pokemon:2023:2023-pokemon-scarlet-violet-151:...
//
// which duplicates the year segment and fragments a product across every way a
// seller might spell it. The convention the codebase actually documents
// (hobbyIqCardId.service.ts line 12) is `hiq:pokemon:2023:sv1:151:full-art:no-auto`
// — the stable TCG set id. Ids never change or localise; names do. So setKey is
// the slugified TCGdex id (`base1`, `sv03-5`), and pokemonSetAliases.ts maps the
// name forms sellers write back onto it so incoming comps join the checklist.
//
// NO SYNTHETIC PARALLELS. cardCount reports how many holo / reverse / normal /
// firstEd cards a SET contains — it does NOT say which cards exist in which
// finish. Multiplying cards by finishes would mint rows the source never
// asserts, which is the templating rejected on 2026-08-11 (memory: "No
// synthetic parallels — actuals only"). Cards are emitted once; the finish
// counts are parked beside the CSV as set-level metadata.
//
//   node scripts/fetchPokemonChecklists.cjs --list
//   node scripts/fetchPokemonChecklists.cjs --set base1 --out data/checklists/scraped/
//   node scripts/fetchPokemonChecklists.cjs --all --out data/checklists/scraped/
//   node scripts/fetchPokemonChecklists.cjs --all --emit-aliases src/services/catalog/pokemonSetAliases.ts

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has = (f) => args.includes(f);

const BASE = "https://api.tcgdex.net/v2/en";
const UA = "Mozilla/5.0 (compatible; HobbyIQ-checklist-fetch/1.0)";

function getJson(url, attempt = 1) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": UA, Accept: "application/json" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(getJson(new URL(res.headers.location, url).toString(), attempt));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on("error", (e) => {
      // The overnight image graft died on a bare ECONNRESET with no retry;
      // a 218-request sweep will hit transient resets, so back off and retry.
      if (attempt < 3) {
        setTimeout(() => resolve(getJson(url, attempt + 1)), 400 * attempt);
      } else reject(e);
    });
  });
}

const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Year from an ISO-ish releaseDate ("2023-09-22"). Null when absent or absurd,
 *  so a set with no date is SKIPPED rather than slugged under year 0. */
function yearOf(releaseDate) {
  const m = String(releaseDate ?? "").match(/^(\d{4})/);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 1995 && y <= 2035 ? y : null;
}

/**
 * The name forms a seller might write for this set, all mapping to its id.
 * Deliberately generous on the way IN (matching is where we want recall) and
 * exact on the way OUT (one canonical setKey per set).
 */
function aliasesFor(set) {
  const name = String(set.name ?? "").trim();
  const serie = String(set.serie?.name ?? "").trim();
  const year = yearOf(set.releaseDate);
  const out = new Set();
  const add = (s) => { const g = slug(s); if (g && g.length >= 3) out.add(g); };
  add(name);
  add(`pokemon ${name}`);
  if (serie) {
    add(`${serie} ${name}`);
    add(`pokemon ${serie} ${name}`);
  }
  if (year) {
    // The shapes already in our pool, so existing rows re-derive onto the id.
    add(`${year} pokemon ${name}`);
    add(`${year} ${name}`);
    if (serie) add(`${year} pokemon ${serie} ${name}`);
  }
  return [...out];
}

(async () => {
  const sets = await getJson(`${BASE}/sets`);
  if (!Array.isArray(sets) || sets.length === 0) {
    console.error("no sets returned — the API shape may have changed");
    process.exit(1);
  }

  if (has("--list")) {
    console.log(JSON.stringify(sets.map((s) => ({
      id: s.id, name: s.name, total: s.cardCount?.total ?? null,
    })), null, 1));
    console.log(`\n${sets.length} sets`);
    return;
  }

  const only = val("--set", "");
  const outDir = val("--out", "");
  const wanted = only ? sets.filter((s) => s.id === only) : sets;
  if (wanted.length === 0) { console.error(`set not found: ${only}`); process.exit(1); }

  const aliasMap = {};
  let okCount = 0, skipped = 0, failed = 0, totalRows = 0;

  for (const stub of wanted) {
    let set;
    try { set = await getJson(`${BASE}/sets/${encodeURIComponent(stub.id)}`); }
    catch (e) { failed++; console.log(`  [${stub.id}] fetch failed: ${e.message}`); continue; }

    const year = yearOf(set.releaseDate);
    const setKey = slug(set.id);
    const cards = Array.isArray(set.cards) ? set.cards : [];
    if (!year || cards.length === 0) {
      skipped++;
      console.log(`  [${stub.id}] skipped — ${!year ? "no usable releaseDate" : "no cards"}`);
      continue;
    }

    const rows = [];
    const seen = new Set();
    for (const c of cards) {
      const num = String(c.localId ?? "").trim();
      const player = String(c.name ?? "").trim();
      if (!num || !player) continue;
      const key = `${num}|${player}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Every Pokemon card is a base-set card; there is no auto concept here,
      // and the finish tiers are set-level metadata, not per-card facts.
      rows.push({ category: "base", cardNumber: num, parallel: "Base", isAuto: false, printRun: "", player });
    }
    if (rows.length === 0) { skipped++; console.log(`  [${stub.id}] skipped — no usable cards`); continue; }

    for (const a of aliasesFor(set)) aliasMap[a] = setKey;
    okCount++; totalRows += rows.length;
    console.log(`  [${stub.id}] ${String(rows.length).padStart(4)} cards  ${year}  ${set.name}`);

    if (!outDir) continue;
    fs.mkdirSync(outDir, { recursive: true });
    const stem = path.join(outDir, `${year}-pokemon-${setKey}`);
    const header = "category,cardNumber,parallel,isAuto,printRun,player";
    const body = rows.map((r) => [r.category, r.cardNumber, r.parallel, r.isAuto, r.printRun, r.player]
      .map(csvCell).join(",")).join("\n");
    fs.writeFileSync(`${stem}.csv`, `${header}\n${body}\n`);
    fs.writeFileSync(`${stem}.manifest.json`, JSON.stringify({
      scrapedAt: new Date().toISOString(),
      sourceUrl: `${BASE}/sets/${set.id}`,
      sport: "pokemon",
      year,
      setName: set.name,
      productKey: `${year}-${setKey}`,
      setKey,
      rowCount: rows.length,
      sectionsReport: [{
        breadcrumb: `Checklist > ${set.name}`,
        category: "base",
        playerCount: rows.length,
        printRun: null,
      }],
    }, null, 1));
    // Finish counts are real published data; park them rather than expand them.
    if (set.cardCount) {
      fs.writeFileSync(`${stem}.parallels.json`, JSON.stringify({
        sourceUrl: `${BASE}/sets/${set.id}`,
        setId: set.id,
        cardCount: set.cardCount,
        note: "Set-level finish counts. NOT expanded into per-card rows — the source does not say which cards exist in which finish.",
      }, null, 1));
    }
  }

  console.log(`\nsets ok=${okCount} skipped=${skipped} failed=${failed}  rows=${totalRows}`);

  const aliasOut = val("--emit-aliases", "");
  if (aliasOut) {
    const entries = Object.entries(aliasMap).sort(([a], [b]) => a.localeCompare(b));
    const lines = entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
    fs.mkdirSync(path.dirname(aliasOut), { recursive: true });
    fs.writeFileSync(aliasOut, `// GENERATED by scripts/fetchPokemonChecklists.cjs — do not edit by hand.
//
// CF-POKEMON-CHECKLISTS (Drew, 2026-08-16). Maps the set-name forms sellers
// write onto the stable TCG set id we use as setKey, so a sale titled
// "1999 Pokemon Base Set" and one titled "Pokemon Base Set" both canonicalise
// to the same card as the checklist row.
//
// Source: api.tcgdex.net/v2/en/sets (${entries.length} aliases over ${okCount} sets).
export const POKEMON_SET_ALIASES: Readonly<Record<string, string>> = Object.freeze({
${lines}
});
`);
    console.log(`wrote ${aliasOut}  (${entries.length} aliases)`);
  }
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
