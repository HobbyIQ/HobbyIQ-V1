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
 * carries dexId, and the 90s ja-exclusive era is Gen 1-2 -- a CLOSED
 * 251-species vocabulary, embedded below (fetched once from PokeAPI, the
 * canonical species registry). So the ja name never gets transliterated or
 * guessed: dex 23 IS ekans, deterministically. Trainer/Energy cards keep
 * their Japanese name verbatim -- the checklist's own words -- and rows the
 * bridge cannot key are counted, never invented.
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

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const OUT_DIR = arg("outDir", "C:/tmp/tcgdex-ja");
const DELAY = Number(arg("delayMs", "150"));
const LIMIT = Number(arg("limit", "0")) || Infinity;
const ONLY = arg("sets", "").split(",").map((s) => s.trim()).filter(Boolean);

/** Gen 1-2 species, index = dexId-1. PokeAPI canonical, fetched 2026-08-28. */
const GEN12 = ["bulbasaur","ivysaur","venusaur","charmander","charmeleon","charizard","squirtle","wartortle","blastoise","caterpie","metapod","butterfree","weedle","kakuna","beedrill","pidgey","pidgeotto","pidgeot","rattata","raticate","spearow","fearow","ekans","arbok","pikachu","raichu","sandshrew","sandslash","nidoran-f","nidorina","nidoqueen","nidoran-m","nidorino","nidoking","clefairy","clefable","vulpix","ninetales","jigglypuff","wigglytuff","zubat","golbat","oddish","gloom","vileplume","paras","parasect","venonat","venomoth","diglett","dugtrio","meowth","persian","psyduck","golduck","mankey","primeape","growlithe","arcanine","poliwag","poliwhirl","poliwrath","abra","kadabra","alakazam","machop","machoke","machamp","bellsprout","weepinbell","victreebel","tentacool","tentacruel","geodude","graveler","golem","ponyta","rapidash","slowpoke","slowbro","magnemite","magneton","farfetchd","doduo","dodrio","seel","dewgong","grimer","muk","shellder","cloyster","gastly","haunter","gengar","onix","drowzee","hypno","krabby","kingler","voltorb","electrode","exeggcute","exeggutor","cubone","marowak","hitmonlee","hitmonchan","lickitung","koffing","weezing","rhyhorn","rhydon","chansey","tangela","kangaskhan","horsea","seadra","goldeen","seaking","staryu","starmie","mr-mime","scyther","jynx","electabuzz","magmar","pinsir","tauros","magikarp","gyarados","lapras","ditto","eevee","vaporeon","jolteon","flareon","porygon","omanyte","omastar","kabuto","kabutops","aerodactyl","snorlax","articuno","zapdos","moltres","dratini","dragonair","dragonite","mewtwo","mew","chikorita","bayleef","meganium","cyndaquil","quilava","typhlosion","totodile","croconaw","feraligatr","sentret","furret","hoothoot","noctowl","ledyba","ledian","spinarak","ariados","crobat","chinchou","lanturn","pichu","cleffa","igglybuff","togepi","togetic","natu","xatu","mareep","flaaffy","ampharos","bellossom","marill","azumarill","sudowoodo","politoed","hoppip","skiploom","jumpluff","aipom","sunkern","sunflora","yanma","wooper","quagsire","espeon","umbreon","murkrow","slowking","misdreavus","unown","wobbuffet","girafarig","pineco","forretress","dunsparce","gligar","steelix","snubbull","granbull","qwilfish","scizor","shuckle","heracross","sneasel","teddiursa","ursaring","slugma","magcargo","swinub","piloswine","corsola","remoraid","octillery","delibird","mantine","skarmory","houndour","houndoom","kingdra","phanpy","donphan","porygon2","stantler","smeargle","tyrogue","hitmontop","smoochum","elekid","magby","miltank","blissey","raikou","entei","suicune","larvitar","pupitar","tyranitar","lugia","ho-oh","celebi"];

/** English names for the classic ja-exclusive sets; fallback is the tcgdex id. */
const SET_EN = {
  PMCG1: "Base Set", PMCG2: "Jungle", PMCG3: "Mystery of the Fossils",
  PMCG4: "Rocket Gang", PMCG5: "Gym Booster 1 Leaders Stadium",
  PMCG6: "Gym Booster 2 Challenge from the Darkness",
  neo1: "Neo Genesis", neo2: "Neo Discovery", neo3: "Neo Revelation", neo4: "Neo Destiny",
};

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
  const enIds = new Set(en.map((s) => s.id));
  let work = ja.filter((s) => !enIds.has(s.id));
  if (ONLY.length) work = work.filter((s) => ONLY.includes(s.id));
  console.log(`[tcgdex-ja] ${ja.length} ja sets, ${work.length} ja-EXCLUSIVE in scope\n`);

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
      if (dex && dex >= 1 && dex <= GEN12.length) { player = GEN12[dex - 1]; setBridged++; }
      else if (detail.category && detail.category !== "Pokemon") player = String(detail.name ?? "");
      if (!player) { unnamed++; continue; }
      rows++;
      lines.push(["base", csvEsc(String(detail.localId ?? c.localId)), "", "false", "", csvEsc(player)].join(","));
    }
    bridged += setBridged;
    const enName = SET_EN[s.id] ?? s.id;
    const key = `${year}-japanese-${enName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-pokemon`;
    fs.writeFileSync(path.join(OUT_DIR, `${key}.csv`), lines.join("\n") + "\n");
    fs.writeFileSync(path.join(OUT_DIR, `${key}.manifest.json`), JSON.stringify({
      year, sport: "pokemon", setName: `Japanese ${enName}`,
      sourceUrl: `https://api.tcgdex.net/v2/ja/sets/${s.id}`, tcgdexId: s.id,
    }, null, 1));
    staged++;
    process.stderr.write(`\r  ${done}/${Math.min(work.length, LIMIT)}  staged=${staged} rows=${rows}   `);
  }
  process.stderr.write("\n");
  console.log(`\n  sets staged        ${staged}`);
  console.log(`  card rows          ${rows}`);
  console.log(`  dex-bridged names  ${bridged}   <- Japanese species resolved to English, deterministically`);
  console.log(`  unnameable         ${unnamed}   <- no dexId, no category; counted, not guessed`);
  console.log(`  sets skipped       ${skippedSets}`);
  console.log(`\nSTAGING ONLY — nothing written to Cosmos.`);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e?.message); process.exit(1); });
