#!/usr/bin/env node
// CF-DEX-BRIDGE-ALL-GENERATIONS (Drew, 2026-09-02, gap-close verdict).
//
// Generates the dex-bridge: dexId -> English species slug, for EVERY generation
// tcgdex serves. This raises the ceiling that capped the tcgdexja lane.
//
// WHAT WAS CAPPED, AND BY WHOM. scrape-tcgdex-ja.cjs carried a hand-embedded
// 251-entry Gen 1-2 array (`GEN12`) and keyed a card only when
// `dex <= GEN12.length`. That was correct for its original scope — the 90s
// ja-exclusive vintage IS Gen 1-2 — but the ruled modern JA sets are not:
//
// Measured against sold_comps, staging the same tcgdex payloads under each
// regime (traded numbers = distinct cardNumbers our sales reference, the gap
// report's own denominator):
//
//     sv2a   216 traded   209/209 covered   96.8% -> 96.8%   (all Gen 1 already)
//     sv8a   238 traded    84 -> 166        35.3% -> 69.8%
//     s12a   230 traded    94 -> 222        40.9% -> 96.5%
//
// The remainder was refused BY OUR BRIDGE, not missing from the source. tcgdex
// serves those cards with a dexId; the array simply ended at 251 and every
// Gen 3-9 species fell through to `unnamed`. Pokellector was evaluated as an
// alternative source and REFUSED — its Terms prohibit automated retrieval.
// tcgdex is the legitimate API, so the fix is our ceiling, not the source.
//
// DERIVED, NEVER HAND-TYPED. A second hand-typed array would re-cap the lane
// the day Gen 10 ships. The vocabulary is derived FROM tcgdex itself:
//
//   1. GET /v2/en/dex-ids            -> every dexId the corpus knows (1025 today)
//   2. GET /v2/en/dex-ids/{n}        -> every ENGLISH card printed for species n
//   3. reduce each card's name to its species CORE and take the plurality
//
// Step 3 is the whole trick. A card name is a species wrapped in card-mechanic
// decoration — "Pikachu ex", "Galarian Mr. Mime", "Erika's Bulbasaur",
// "Ice Rider Calyrex VMAX" — so the raw plurality is not always the species
// (dex 1025 prints "Pecharunt ex" 5 times and bare "Pecharunt" 3). Stripping
// the mechanic suffixes, the possessive owner prefixes and the regional/forme
// adjectives first, THEN voting, lands the species every time.
//
// Two shapes are deliberately left alone:
//   - a suffix must be its own token. "Calyrex" and "Toxapex" end in the letters
//     "ex" and an unanchored strip truncated them to `calyr` / `toxap`.
//   - a name carrying "&" is two species on one card ("Mewtwo & Mew GX") and
//     votes for neither.
//
// THE REGRESSION THAT PINS IT. The derived Gen 1-2 rows are compared against the
// shipped GEN12 array and must match all 251 exactly — the generator REFUSES to
// write otherwise. So "extend to Gen 3-9" can never silently restate Gen 1.
//
// Output is committed, like every other generator artifact here: a site or API
// change breaks the next regeneration, never the running lane.
//
// Usage:
//   node backend/scripts/fetchPokemonDexBridge.cjs [--out=data/pokemon-dex-bridge.json]
//                                                  [--delayMs=110]

const fs = require("node:fs");
const path = require("node:path");

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : d;
};

const API = "https://api.tcgdex.net/v2/en";
const DELAY = Number(arg("delayMs", "110"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Card-mechanic suffixes. Each must be its own token — see the header note on
 *  Calyrex/Toxapex, which END in the letters "ex" and are not ex cards. */
const SUFFIX = /(?:[\s-]+(?:ex|EX|GX|V|VMAX|VSTAR|V-UNION|BREAK|Star|Prism Star|LV\.X|Lv\.X)|\s*[δ◇])+\s*$/;
/** Possessive owner prefixes: "Erika's Bulbasaur", "Team Rocket's Porygon-Z". */
const OWNER = /^(?:[A-Z][\p{L}.'’\- ]*?['’]s)\s+/u;
/** Regional and forme adjectives printed ahead of the species. */
const FORME = /^(?:Galarian|Alolan|Hisuian|Paldean|Radiant|Shining|Dark|Light|Ultra|Mega|Primal|Origin Forme|Ice Rider|Shadow Rider|Dawn Wings|Dusk Mane|White Kyurem|Black Kyurem|Teal Mask|Hearthflame Mask|Wellspring Mask|Cornerstone Mask|Bloodmoon)\s+/;

/** Reduce a printed card name to the species it names, or null if it names
 *  more than one. */
function speciesCore(raw) {
  let s = String(raw).replace(/’/g, "'").trim();
  if (/[&＆]/.test(s)) return null;
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(SUFFIX, "").trim();
    s = s.replace(OWNER, "").trim();
    s = s.replace(FORME, "").trim();
    if (s === before) break;
  }
  return s || null;
}

/** PokeAPI's species-slug convention, which the shipped GEN12 array follows:
 *  accents folded, apostrophes DROPPED (farfetchd, sirfetchd), the gender signs
 *  spelled (-f / -m), everything else hyphenated. */
const slugSpecies = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/'/g, "")
  .replace(/♀/g, "-f").replace(/♂/g, "-m")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** RULED overrides. Applied AFTER the derivation, so a re-scrape cannot restore
 *  a spelling Drew has ruled against — the same discipline as `RULED` in
 *  fetchJapanesePokemonAliases.cjs. Empty today: the derivation agrees with the
 *  shipped Gen 1-2 vocabulary on all 251 rows, so nothing has needed ruling. */
const RULED = {};

async function get(url, attempt = 0) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    if (attempt < 3) { await sleep(1500 * (attempt + 1)); return get(url, attempt + 1); }
    throw new Error(`tcgdex unreachable: ${url} (${e.message})`);
  }
}

(async () => {
  const out = arg("out", "data/pokemon-dex-bridge.json");

  const dexIds = await get(`${API}/dex-ids`);
  if (!Array.isArray(dexIds) || dexIds.length < 251) {
    throw new Error(`only ${dexIds?.length ?? 0} dexIds served — API shape likely changed`);
  }
  console.log(`[dex-bridge] ${dexIds.length} dexIds in the tcgdex corpus`);

  const species = {};
  let done = 0, unresolved = 0;
  for (const d of dexIds) {
    const doc = await get(`${API}/dex-ids/${d}`);
    await sleep(DELAY);
    done++;
    const names = Array.isArray(doc?.cards) ? doc.cards.map((c) => c.name).filter(Boolean) : [];
    const votes = new Map();
    for (const n of names) {
      const core = speciesCore(n);
      if (core) votes.set(core, (votes.get(core) || 0) + 1);
    }
    // Plurality; ties break to the SHORTER name, which is the undecorated one.
    const top = [...votes.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0];
    if (top) species[String(d)] = slugSpecies(top[0]);
    else unresolved++;
    if (done % 100 === 0) process.stderr.write(`\r  ${done}/${dexIds.length}`);
  }
  process.stderr.write("\n");

  for (const [k, v] of Object.entries(RULED)) species[k] = v;

  // THE GEN 1-2 REGRESSION. The bridge this replaces was a 251-entry array; the
  // derivation must reproduce it exactly or the extension has changed the
  // vocabulary it was only supposed to extend.
  const legacy = require("./lib/gen12-legacy.json").species;
  const drift = legacy
    .map((want, i) => ({ dex: i + 1, want, got: species[String(i + 1)] }))
    .filter((r) => r.got !== r.want);
  if (drift.length) {
    console.error(`REFUSE: ${drift.length} Gen 1-2 rows drifted from the shipped vocabulary:`);
    for (const r of drift.slice(0, 20)) console.error(`  dex ${r.dex}: derived=${r.got} shipped=${r.want}`);
    process.exit(1);
  }

  const maxDex = Math.max(...Object.keys(species).map(Number));
  const doc = {
    generatedAt: new Date().toISOString(),
    source: `${API}/dex-ids`,
    dexIdsServed: dexIds.length,
    resolved: Object.keys(species).length,
    unresolved,
    maxDexId: maxDex,
    ruledOverrides: Object.keys(RULED).length,
    note: "GENERATED by scripts/fetchPokemonDexBridge.cjs — do not edit by hand. "
      + "dexId -> English species slug, derived from the tcgdex EN corpus. "
      + "Gen 1-2 rows are regression-pinned to the vocabulary the lane shipped with.",
    species,
  };
  const dest = path.join(__dirname, "..", out);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(doc, null, 1) + "\n");

  console.log(`wrote ${dest}`);
  console.log(`  species resolved   ${Object.keys(species).length} / ${dexIds.length}   (max dexId ${maxDex})`);
  console.log(`  unresolved         ${unresolved}`);
  console.log(`  Gen 1-2 regression 251/251 exact — vocabulary extended, never restated`);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
