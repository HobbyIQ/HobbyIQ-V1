#!/usr/bin/env node
// CF-JAPANESE-POKEMON-ALIASES (Drew, 2026-08-17, supplying pokelenz.com).
//
// Generates the Japanese-Pokemon set alias table. This unblocks the population
// I twice reported as blocked: ~202,500 sold_comps rows (~49,000/day) whose
// setName names a Japanese set no source I could find carried in romanized form.
//
// WHY THE OTHER SOURCES FAILED, so nobody re-treads it:
//   tcgdex /v2/ja/sets   229 sets, all Japanese-script names, zero ASCII, and
//                        ?lang=en is ignored. The EN endpoint will not serve a
//                        JA set id.
//   pokemontcg.io        lists Japanese sets as a FUTURE feature.
//   apitcg.com           requires an API key.
// And the two largest sets by volume (Terastal Festival ex, VSTAR Universe) are
// Japan-exclusive, so there is no English sibling whose id could be borrowed.
//
// pokelenz.com/database/japanese carries 229 sets with BOTH the romanized name
// and the canonical set code (sv2a, swsh12a, sm8b) in one statically rendered
// page. Codes match the standard scheme the rest of the ecosystem uses.
//
// MEASURED BEFORE BUILDING, against the setNames actually present in our
// unkeyed rows: 89.9% of Japanese sales match (182,097 of 202,535).
//
// SCRAPED, NOT AN API. The page is server-rendered HTML with no JSON endpoint,
// so this parses anchors. That makes it fragile to a redesign by design — the
// generator is run on demand and its OUTPUT is committed, so a site change
// breaks the next regeneration and never the running service.
//
// Usage:
//   node backend/scripts/fetchJapanesePokemonAliases.cjs \
//     [--out=src/services/catalog/japanesePokemonAliases.ts]

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : d;
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const slug = (s) => String(s).toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ]/g, "")           // é -> e, so "Pokémon" matches "Pokemon"
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": UA, Accept: "text/html" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchHtml(new URL(res.headers.location, url).toString()));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => resolve(Buffer.concat(c).toString("utf8")));
    }).on("error", reject);
  });
}

/** Vendor spellings the page does not carry verbatim. Each verified against the
 *  set list above; these were the largest remaining misses at 89.9%. */
const MANUAL = {
  "base-set": "base",
  "cd-promo": "miscp",
  "neo-gold-silver-new-world": "neo1",
};

/** CF-THE-JAPANESE-CODE-IS-THE-KEY (Drew, 2026-09-01, R1 + R2 + R3). Applied
 *  AFTER MANUAL and after the scrape, so a re-run cannot restore the wrong
 *  code.
 *
 *  All three entries were scraped wrong and all three pointed a JAPANESE set at
 *  an ENGLISH product's key, which is the one mistake that silently merges two
 *  pools:
 *
 *    rocket-gang      the source lists the 1997 JA Rocket Gang set against
 *                     `base4`, which is EN Base Set 2 (2000). 43,724 JA sales
 *                     were minted onto the EN key before this was caught.
 *    vstar-universe   `swsh12a` is not a real code; the JA code is `s12a`. The
 *                     swsh-prefix also invites collision with the EN Sword &
 *                     Shield codes (swsh12 IS Silver Tempest).
 *    paradigm-trigger the source lists the JA Paradigm Trigger set against
 *                     `swsh12`, which IS EN Silver Tempest — so the JA set and
 *                     the EN set answered with one key and shared one pool
 *                     (22,585 live rows). The JA code is the bare `s12`.
 *
 *  Note the source's systematic failure mode, visible in the neighbours: it
 *  hands a Japanese set its contemporaneous ENGLISH counterpart's code
 *  (lost-abyss -> swsh11, dark-phantasma -> swsh10a). The SWSH-era block below
 *  rules those twelve; others stay as scraped until ruled.
 *
 *  Keep these until the upstream page is corrected; a scrape that already
 *  agrees leaves them as no-ops. */
const RULED = {
  "rocket-gang": "japanese-rocket-gang",
  "vstar-universe": "s12a",
  "paradigm-trigger": "s12",
  // CF-THE-JAPANESE-CODE-IS-THE-KEY, the SWSH era (2026-09-04). The same
  // failure the three above name, applied to the twelve sets the tcgdex-ja
  // modern lane stages -- each one is the JA set whose romanized title this
  // source files under the EN-era `swsh` spelling of its own code.
  //
  // WHY THESE TWELVE AND NOT THE OTHER SEVENTEEN swsh-valued aliases. Every
  // one of these has a staged checklist in
  // data/checklists/tcgdex-ja-modern/, whose setKey is the bare official code
  // -- so the catalog spelling and the resolver output disagreed and 29,075
  // live pool rows could not reach their own checklist. The other seventeen
  // (eevee-heroes, time-gazer, shiny-star-v, ...) are the same defect and will
  // be ruled the same way when their checklists land; a key with no checklist
  // behind it is not yet a key this lane may move.
  //
  // PROVEN PER SET, NOT PATTERN-MATCHED (2026-09-04, api.tcgdex.net/v2/ja/sets,
  // 184 JA sets). NO `swsh*` id exists anywhere in the Japanese universe --
  // the prefix is EN-era by construction -- and each bare code below is a real
  // JA set whose name is the Japanese name of the title on the left:
  //
  //   s9a  バトルリージョン (Battle Region)      s11   ロストアビス (Lost Abyss)
  //   s10a ダークファンタズマ (Dark Phantasma)    s6h   白銀のランス (Silver Lance)
  //   s8   フュージョンアーツ (Fusion Arts)      s5i   一撃マスター (Single Strike Master)
  //   s11a 白熱のアルカナ (Incandescent Arcana)  s7d   摩天パーフェクト (Skyscraping Perfection)
  //   s6k  漆黒のガイスト (Jet-Black Spirit)     s10p  スペースジャグラー (Space Juggler)
  //   s9   スターバース (Star Birth)             s8b   VMAXクライマックス (VMAX Climax)
  //
  // NOT A BLANKET swsh->s REWRITE, though it holds for 28 of the 29: `swshp`
  // is the exception that forbids the general rule as a rewrite. Its bare form
  // `sp` names NO Japanese set -- the JA promo lines are S-P, SV-P and M-P --
  // so a mechanical strip would mint a key for a product that does not exist.
  // An exact-token table cannot make that mistake; a pattern can.
  "battle-region": "s9a",
  "dark-phantasma": "s10a",
  "fusion-arts": "s8",
  "incandescent-arcana": "s11a",
  "jet-black-spirit": "s6k",
  "lost-abyss": "s11",
  "silver-lance": "s6h",
  "single-strike-master": "s5i",
  "skyscraping-perfection": "s7d",
  "space-juggler": "s10p",
  "star-birth": "s9",
  "vmax-climax": "s8b",
};

(async () => {
  const out = arg("out", "src/services/catalog/japanesePokemonAliases.ts");
  const html = await fetchHtml("https://pokelenz.com/database/japanese");

  // <a href="/sets/ja-<code>_ja"><img ... alt="<romanized name>"
  const re = /href="\/sets\/ja-([a-z0-9-]+)_ja"><img[^>]*alt="([^"]+)"/gi;
  const sets = new Map();
  let m;
  while ((m = re.exec(html))) if (!sets.has(m[1])) sets.set(m[1], m[2]);
  if (sets.size < 100) throw new Error(`only ${sets.size} sets parsed — page shape likely changed`);

  const table = {};
  for (const [code, name] of sets) {
    const k = slug(name);
    if (k && !(k in table)) table[k] = code;
  }
  for (const [k, v] of Object.entries(MANUAL)) table[k] = v;
  // The rulings win over both the scrape and MANUAL — see RULED above.
  for (const [k, v] of Object.entries(RULED)) table[k] = v;

  const entries = Object.entries(table).sort(([a], [b]) => a.localeCompare(b));
  const body = `// GENERATED by scripts/fetchJapanesePokemonAliases.cjs — do not edit by hand.
//
// CF-JAPANESE-POKEMON-ALIASES (Drew, 2026-08-17). Maps the romanized Japanese
// set names sellers write onto the canonical Japanese set code, so a Japanese
// Pokemon sale gets a real identity instead of a year-prefixed one-off that
// slugGuard then refuses.
//
// Source: pokelenz.com/database/japanese (${sets.size} sets). Scraped, not an
// API — see the generator header for why every JSON source was unusable.
//
// Keys are the slugified romanized name with accents folded, WITHOUT year,
// "Pokemon", "Japanese" or the series prefix — the resolver strips those before
// lookup, so one entry covers every vendor spelling.
//
// Three entries are RULED overrides, not scraped (see \`RULED\` in the
// generator): "rocket-gang" -> japanese-rocket-gang, "vstar-universe" -> s12a
// and "paradigm-trigger" -> s12. The source page pointed all three Japanese
// sets at an English product's code.

export const JAPANESE_POKEMON_SET_ALIASES: Readonly<Record<string, string>> = Object.freeze({
${entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}
});
`;
  const dest = path.join(__dirname, "..", out);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  console.log(`wrote ${dest}`);
  console.log(`  JAPANESE_POKEMON_SET_ALIASES ${entries.length} (from ${sets.size} sets)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
