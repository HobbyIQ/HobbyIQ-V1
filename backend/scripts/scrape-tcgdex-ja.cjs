#!/usr/bin/env node
/**
 * CF-JAPANESE-POKEMON-FROM-TCGDEX (Drew, 2026-08-28: "do a website for
 * Japanese Pokemon or whatever we can use").
 *
 * The 593 no-match pokemon keys (64,991 rows) are mostly JAPANESE-EXCLUSIVE
 * sets no held source covered. tcgdex serves them as a free JSON API: 184
 * Japanese sets including the exact vintage the no-match list names --
 * PMCG3 = Mystery of the Fossils, PMCG4 = Rocket Gang (1997-11-21).
 *
 * THE NAME BRIDGE. Ja-exclusive sets carry no English names and their card
 * names are Japanese, which slugify to nothing. But every Pokemon card
 * carries dexId, so the ja name never gets transliterated or guessed:
 * dex 23 IS ekans, deterministically. Trainer/Energy cards keep their
 * Japanese name verbatim -- the checklist's own words -- and rows the bridge
 * cannot key are counted, never invented.
 *
 * CF-DEX-BRIDGE-ALL-GENERATIONS (Drew, 2026-09-02, gap-close verdict). The
 * bridge USED TO BE a 251-entry Gen 1-2 array embedded right here, keyed
 * `dex <= GEN12.length`. That fit the 90s ja-exclusive vintage it was written
 * for, but it became the CEILING on every modern ruled JA set: sv8a staged 71
 * of 249 traded numbers, s12a 73 of 244 -- the remainder refused by OUR array,
 * not missing from tcgdex, which serves those cards with a dexId.
 *
 * The vocabulary now comes from data/pokemon-dex-bridge.json, DERIVED from the
 * tcgdex EN corpus by scripts/fetchPokemonDexBridge.cjs and regression-pinned
 * to those same 251 Gen 1-2 rows. Re-running the generator picks up whatever
 * generations tcgdex has grown, so a new generation never re-caps this lane.
 *
 * SCOPE: ja sets ABSENT from the EN catalog only. A set that exists in EN
 * (sv-151 etc.) is already served by the EN pipeline, and ingesting its ja
 * twin would mint duplicate vocabulary -- the twin-key disease this week
 * spent a day unifying.
 *
 * STAGING ONLY -- canonical CSV + manifest per set; the authority-checked
 * ingest is the only writer. ~150ms between calls; it is a free public API
 * run by volunteers.
 *
 * Args: --outDir=C:/tmp/tcgdex-ja  --delayMs=150  --limit=0  --sets=PMCG4,...
 */
const fs = require("node:fs");
const path = require("node:path");
const { jaSetKeyFor } = require("./lib/tcgdex-ja-set-key.cjs");
const { ruledKeyForJaSourceId, sameProductAsEnglishSet } = require("./lib/tcgdex-ja-source-id-map.cjs");

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const OUT_DIR = arg("outDir", "C:/tmp/tcgdex-ja");
const DELAY = Number(arg("delayMs", "150"));
const LIMIT = Number(arg("limit", "0")) || Infinity;
const ONLY = arg("sets", "").split(",").map((s) => s.trim()).filter(Boolean);

/** dexId -> English species slug, ALL generations tcgdex serves. Derived, not
 *  typed: see scripts/fetchPokemonDexBridge.cjs. Refuses to run without it
 *  rather than silently falling back to a narrower vocabulary, which is exactly
 *  the failure this replaced. */
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

/** LEGACY, kept only so the Gen 1-2 vocabulary this lane shipped with stays
 *  readable next to the derivation that reproduces it. Not consulted. */
const GEN12_LEGACY_UNUSED = ["bulbasaur","ivysaur","venusaur","charmander","charmeleon","charizard","squirtle","wartortle","blastoise","caterpie","metapod","butterfree","weedle","kakuna","beedrill","pidgey","pidgeotto","pidgeot","rattata","raticate","spearow","fearow","ekans","arbok","pikachu","raichu","sandshrew","sandslash","nidoran-f","nidorina","nidoqueen","nidoran-m","nidorino","nidoking","clefairy","clefable","vulpix","ninetales","jigglypuff","wigglytuff","zubat","golbat","oddish","gloom","vileplume","paras","parasect","venonat","venomoth","diglett","dugtrio","meowth","persian","psyduck","golduck","mankey","primeape","growlithe","arcanine","poliwag","poliwhirl","poliwrath","abra","kadabra","alakazam","machop","machoke","machamp","bellsprout","weepinbell","victreebel","tentacool","tentacruel","geodude","graveler","golem","ponyta","rapidash","slowpoke","slowbro","magnemite","magneton","farfetchd","doduo","dodrio","seel","dewgong","grimer","muk","shellder","cloyster","gastly","haunter","gengar","onix","drowzee","hypno","krabby","kingler","voltorb","electrode","exeggcute","exeggutor","cubone","marowak","hitmonlee","hitmonchan","lickitung","koffing","weezing","rhyhorn","rhydon","chansey","tangela","kangaskhan","horsea","seadra","goldeen","seaking","staryu","starmie","mr-mime","scyther","jynx","electabuzz","magmar","pinsir","tauros","magikarp","gyarados","lapras","ditto","eevee","vaporeon","jolteon","flareon","porygon","omanyte","omastar","kabuto","kabutops","aerodactyl","snorlax","articuno","zapdos","moltres","dratini","dragonair","dragonite","mewtwo","mew","chikorita","bayleef","meganium","cyndaquil","quilava","typhlosion","totodile","croconaw","feraligatr","sentret","furret","hoothoot","noctowl","ledyba","ledian","spinarak","ariados","crobat","chinchou","lanturn","pichu","cleffa","igglybuff","togepi","togetic","natu","xatu","mareep","flaaffy","ampharos","bellossom","marill","azumarill","sudowoodo","politoed","hoppip","skiploom","jumpluff","aipom","sunkern","sunflora","yanma","wooper","quagsire","espeon","umbreon","murkrow","slowking","misdreavus","unown","wobbuffet","girafarig","pineco","forretress","dunsparce","gligar","steelix","snubbull","granbull","qwilfish","scizor","shuckle","heracross","sneasel","teddiursa","ursaring","slugma","magcargo","swinub","piloswine","corsola","remoraid","octillery","delibird","mantine","skarmory","houndour","houndoom","kingdra","phanpy","donphan","porygon2","stantler","smeargle","tyrogue","hitmontop","smoochum","elekid","magby","miltank","blissey","raikou","entei","suicune","larvitar","pupitar","tyranitar","lugia","ho-oh","celebi"];

/**
 * English names for the classic ja-exclusive sets; fallback is the tcgdex id.
 *
 * E1/E2/E3 are NOT typed here. They are the e-Card sets the source-id map
 * already carries an `enName` for, and a second hand-maintained copy of a name
 * is a copy that drifts -- so `enNameFor` reads the map first and this table is
 * only the vocabulary the map does not cover (PMCG4 Rocket Gang has no English
 * twin at all, and the neo names are the localisation the map does not state
 * because `jaSetKeyFor`, not the map, addresses those sets).
 */
const SET_EN = {
  PMCG4: "Rocket Gang",
  neo1: "Neo Genesis", neo2: "Neo Discovery", neo3: "Neo Revelation", neo4: "Neo Destiny",
};

/**
 * The English name for a JA set id. The map is authoritative where it speaks.
 *
 * Falling through to the bare id is what gave E1 the setName "Japanese E1" --
 * a catalog row named after its own id, which is the provenance loss the modern
 * lane's manifest comment spells out at length. The fallback REMAINS, because
 * inventing a name is worse, but it now applies only where nothing knows one.
 */
function enNameFor(jaId) {
  const product = sameProductAsEnglishSet(jaId);
  if (product && product.enName) return product.enName;
  return SET_EN[jaId] ?? jaId;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const csvEsc = (s) => { const v = String(s ?? ""); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };

async function get(url, attempt = 0) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
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
  // A SHARED CODE IS NOT A SHARED CARD (#1959). The old `!enIds.has(s.id)`
  // dropped every JA set an EN set names -- neo1..neo4 among them, 323 cards
  // that were never staged -- because it was written before the ruling gave
  // those sets the `ja-<code>` address. The scope is now every JA set, and
  // since CF-THE-JAPANESE-SET-IS-REACHED-BY-ITS-JAPANESE-ID the KEY is the
  // ruled one rather than a slug of the English display name.
  const enIds = new Set(en.map((s) => s.id));
  let work = ja.slice();
  if (ONLY.length) work = work.filter((s) => ONLY.includes(s.id));
  console.log(`[tcgdex-ja] ${ja.length} ja sets, ${work.length} in scope (shared-code sets included since #1959)`);
  console.log(`[dex-bridge] ${Object.keys(DEX_SPECIES).length} species, dexId 1..${DEX_MAX}\n`);

  let staged = 0, rows = 0, bridged = 0, unnamed = 0, skippedSets = 0, done = 0;
  for (const s of work) {
    if (done >= LIMIT) break;
    done++;
    const d = await get(`https://api.tcgdex.net/v2/ja/sets/${s.id}`);
    await sleep(DELAY);
    if (!d || !Array.isArray(d.cards) || !d.cards.length) { skippedSets++; continue; }
    const year = Number(String(d.releaseDate ?? "").slice(0, 4));
    if (!year) { skippedSets++; console.log(`  ${s.id}: no releaseDate — SKIPPED, not guessed`); continue; }

    const lines = ["category,cardNumber,parallel,isAuto,printRun,player"];
    let setBridged = 0;
    for (const c of d.cards) {
      const detail = await get(`https://api.tcgdex.net/v2/ja/cards/${c.id}`);
      await sleep(DELAY);
      if (!detail) continue;
      let player = null;
      const dex = Array.isArray(detail.dexId) ? detail.dexId[0] : null;
      // The ceiling is now whatever tcgdex itself knows, not a typed array's
      // length. An unknown dexId still falls through to `unnamed` and is
      // counted -- never guessed, never transliterated.
      if (dex && DEX_SPECIES[String(dex)]) { player = DEX_SPECIES[String(dex)]; setBridged++; }
      else if (detail.category && detail.category !== "Pokemon") player = String(detail.name ?? "");
      if (!player) { unnamed++; continue; }
      rows++;
      lines.push(["base", csvEsc(String(detail.localId ?? c.localId)), "", "false", "", csvEsc(player)].join(","));
    }
    bridged += setBridged;
    const enName = enNameFor(s.id);
    /**
     * THE SETKEY IS THE RULED ADDRESS, AND THE MANIFEST MUST STATE IT.
     *
     * This lane used to key by NAME alone -- `1997-japanese-jungle-pokemon` --
     * and state no `setKey` at all, so the ingest fell through to
     * `normalizeSetKey(setName)` and the driver's verification to a slug of the
     * display name. R5 (#1959) has since given these sets a ruled address, and
     * two different derivations of the same thing are how #1741's whole
     * "short ingest" class happened. So the key is derived ONCE, here, and
     * WRITTEN DOWN: `ingest-checklist-csv-to-catalog.cjs` honours a stated
     * `setKey` verbatim (`m.setKey || normalizeSetKey(m.setName)`), and the
     * driver's `manifestSetKeys` reads the manifest first.
     *
     * Two derivations feed it, in this order, and neither guesses:
     *
     *   ruledKeyForJaSourceId  the set tcgdex serves under its OWN Japanese id
     *                          (PMCG2 IS the Japanese Jungle). `pmcg2` collides
     *                          with no English code, so jaSetKeyFor would key it
     *                          `pmcg2` -- an address the resolver never answers.
     *                          The map states the product identity, with its
     *                          evidence, and R5 spells the address.
     *
     *   jaSetKeyFor            the set tcgdex serves under an id that case-folds
     *                          onto an English one (neo1..neo4). #1971 already
     *                          made this the modern lane's rule; the vintage
     *                          lane was keying by name and never used it.
     *
     * An id that is neither -- PMCG4, the ja-exclusive Rocket Gang -- falls to
     * its own bare code, which is exactly the doctrine "a bare JA code wins
     * where one exists" and is what this lane has always effectively produced.
     */
    const setKey = ruledKeyForJaSourceId(s.id) ?? jaSetKeyFor(s.id, enIds);
    if (!setKey) { skippedSets++; console.log(`  ${s.id}: no derivable setKey — SKIPPED, not guessed`); continue; }
    const key = `${year}-${setKey}-pokemon`;
    fs.writeFileSync(path.join(OUT_DIR, `${key}.csv`), lines.join("\n") + "\n");
    fs.writeFileSync(path.join(OUT_DIR, `${key}.manifest.json`), JSON.stringify({
      productKey: `${year}-${setKey}`,
      year, sport: "pokemon", setKey, setName: `Japanese ${enName}`,
      source: "tcgdex-ja",
      sourceUrl: `https://api.tcgdex.net/v2/ja/sets/${s.id}`, tcgdexId: s.id,
    }, null, 1));
    staged++;
    process.stderr.write(`\r  ${done}/${Math.min(work.length, LIMIT)}  staged=${staged} rows=${rows}   `);
  }
  process.stderr.write("\n");
  console.log(`\n  sets staged        ${staged}`);
  console.log(`  card rows          ${rows}`);
  console.log(`  dex-bridged names  ${bridged}   <- Japanese species resolved to English, deterministically`);
  // The residual after the bridge was uncapped is a SOURCE limit, not ours:
  // tcgdex serves some cards (SV8a's ex cards, notably) as category "Pokemon"
  // with no dexId field at all. Those stay counted and unstaged -- inventing a
  // name from the Japanese text is the one thing this lane must never do.
  console.log(`  unnameable         ${unnamed}   <- no dexId served by the source; counted, not guessed`);
  console.log(`  sets skipped       ${skippedSets}`);
  console.log(`\nSTAGING ONLY — nothing written to Cosmos.`);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e?.message); process.exit(1); });
