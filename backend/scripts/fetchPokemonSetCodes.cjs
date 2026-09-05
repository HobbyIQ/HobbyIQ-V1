#!/usr/bin/env node
// CF-THE-SET-CODE-IS-THE-KEY (Drew's ask, 2026-09-05: "find other sites to fill
// the checklists; fix what else we can" -- the TCG lane).
//
// WHY THIS EXISTS, AND WHY IT IS NOT THE ALIAS TABLE WE ALREADY HAVE.
//
// pokemonSetAliases.ts maps a set NAME onto its code ("prismatic-evolutions"
// -> sv08-5), and #1801 made that table reachable from a TITLE. But sellers do
// not only write the name -- they write the CODE, and the unknown-setKey census
// (#1796, backend/docs/reports/unknown-setkey-2026-09-05.md) measured what that
// costs. Of the ~500k sales needing vocabulary, the Pokemon share is
// overwhelmingly promo and set-code spellings the name table cannot see:
//
//     mep en-me black star           2,877 rows  -> mep
//     sv black star promos           1,884       -> svp
//     japanese m3-nullifying zero    1,780       -> m3
//     japanese m5-abyss eye special  1,661       -> m5
//     swsh black star promo          1,631       -> swshp
//     sm black star promo            1,483       -> smp
//     svp en-sv black star           1,216       -> svp
//     japanese m2a-mega dream ex     1,142       -> m2a
//
// Every one of those codes is a REAL tcgdex set id. None is reachable from a
// name alias, because the title never spells the name.
//
// SOURCE: api.tcgdex.net (MIT, github.com/tcgdex/cards-database). Keyless, and
// its robots.txt says the Disallow is "for Crawlers only ... You can logically
// use robots to use the API". Verified 2026-09-05: /v2/en/sets returns 218 sets
// and /v2/ja/sets returns 184, each carrying id + name, and the per-set detail
// endpoint adds releaseDate, serie and cardCount.{official,total}.
//
// The two corroboration sources named in the ask were CHECKED AND REFUSED, and
// the reason is licensing, not quality:
//   pokemontcg.io  free tier is NON-COMMERCIAL only (dev.pokemontcg.io/terms);
//                  HobbyIQ is a commercial product, so it cannot be a source.
//                  (It also returned HTTP 502 when probed on 2026-09-05.)
//   Bulbapedia     CC BY-NC-SA 2.5 -- the NC clause forbids commercial reuse.
// Neither is used here. tcgdex alone is the source, and it is MIT.
//
// WHAT THIS EMITS. One map, CODE -> set name, in three parts:
//   EN     the English set ids (the catalog's own spelling: setKey IS the id)
//   PROMO  the Black Star / promo ids, which is where the census rows are
//   JA     the Japanese-only ids, which the Japanese branch owns
//
// The JA part deliberately EXCLUDES the ids that exist in BOTH markets
// (sm1..sm12, xy2..xy10, neo1..neo4, sv10). Those are different products with
// different prints and different prices -- EN sm1 is "Sun & Moon", JA sm1 is
// "Collection Sun" -- so a bare `sm1` in a title cannot be resolved to a market
// without saying which market, and this generator refuses to guess. They stay
// English-keyed, which is what the English branch already answers, and the
// Japanese branch reaches the Japanese product by NAME through
// japanesePokemonAliases.ts, exactly as CF-THE-JAPANESE-CODE-IS-THE-KEY
// requires.
//
// NO SYNTHETIC ANYTHING. Every entry traces to a set tcgdex asserts exists.
// No name is invented, no parallel is minted, and no key is authored that the
// catalog does not already use.
//
//   node scripts/fetchPokemonSetCodes.cjs --list
//   node scripts/fetchPokemonSetCodes.cjs --emit src/services/catalog/pokemonSetCodes.ts

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has = (f) => args.includes(f);

const UA = "Mozilla/5.0 (compatible; HobbyIQ-setcode-fetch/1.0)";

function getJson(url, attempt = 1) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": UA, Accept: "application/json" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(getJson(new URL(res.headers.location, url).toString(), attempt));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = ""; res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on("error", (e) => {
      if (attempt >= 4) return reject(e);
      setTimeout(() => resolve(getJson(url, attempt + 1)), 400 * attempt);
    });
  });
}

/** The same slugify the services use, so a code emitted here is the code they
 *  compare against. tcgdex writes `sv08.5`; every key in our catalog is
 *  `sv08-5`. */
const slug = (s) => String(s ?? "").toLowerCase().normalize("NFKD")
  .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const PROMO_RE = /promo|black star/i;

(async () => {
  const [en, ja] = await Promise.all([
    getJson("https://api.tcgdex.net/v2/en/sets"),
    getJson("https://api.tcgdex.net/v2/ja/sets"),
  ]);
  if (!Array.isArray(en) || !en.length || !Array.isArray(ja) || !ja.length) {
    console.error("no sets returned — the API shape may have changed");
    process.exit(1);
  }

  const enByCode = new Map();
  for (const s of en) { const c = slug(s.id); if (c) enByCode.set(c, s); }
  const jaByCode = new Map();
  for (const s of ja) { const c = slug(s.id); if (c) jaByCode.set(c, s); }

  // The ambiguity that decides the whole design: a code both markets use.
  const ambiguous = [...enByCode.keys()].filter((c) => jaByCode.has(c)).sort();

  const EN = {}, PROMO = {}, JA = {};
  for (const [code, s] of enByCode) {
    (PROMO_RE.test(String(s.name ?? "")) ? PROMO : EN)[code] = String(s.name ?? "");
  }
  for (const [code, s] of jaByCode) {
    if (enByCode.has(code)) continue;      // ambiguous -> English keeps it
    JA[code] = String(s.name ?? "");
  }

  if (has("--list")) {
    console.log(JSON.stringify({
      en: Object.keys(EN).length, promo: Object.keys(PROMO).length,
      ja: Object.keys(JA).length, ambiguous,
    }, null, 1));
    return;
  }

  const out = val("--emit", "");
  if (!out) { console.error("nothing to do: pass --list or --emit <file>"); process.exit(2); }

  const lit = (o) => Object.keys(o).sort().map((k) =>
    `  ${/^[a-z][a-z0-9]*$/.test(k) ? k : JSON.stringify(k)}: ${JSON.stringify(o[k])},`).join("\n");

  const header = `// GENERATED by scripts/fetchPokemonSetCodes.cjs — do not edit by hand.
//
// CF-THE-SET-CODE-IS-THE-KEY (2026-09-05). Sellers write the set CODE as often
// as the set NAME — "SVP EN-SV Black Star", "Japanese M5-Abyss Eye", "SWSH12.5"
// — and the name-keyed table (pokemonSetAliases.ts) cannot see any of them.
// The unknown-setKey census (#1796) measured the cost: the Pokemon half of the
// ~500k "needs vocabulary" bucket is overwhelmingly promo and code spellings.
//
// Source: api.tcgdex.net (MIT). ${en.length} English sets, ${ja.length} Japanese, read
// ${new Date().toISOString().slice(0, 10)}. Codes are slugified — tcgdex writes \`sv08.5\`, the
// catalog is keyed \`sv08-5\`.
//
// THE VALUE IS THE SET NAME, AND IT IS DOCUMENTATION, NOT A KEY. The KEY of
// each record is the canonical setKey; the value is what tcgdex calls that set,
// kept so a reader can tell \`me02\` from \`me02-5\` without a second lookup.
//
// AMBIGUOUS CODES ARE NOT IN THE JA MAP, and that omission is the load-bearing
// part. ${ambiguous.length} ids exist in BOTH markets naming DIFFERENT products:
//
${ambiguous.map((c) => `//   ${c.padEnd(6)} EN ${JSON.stringify(enByCode.get(c).name)} vs JA ${JSON.stringify(jaByCode.get(c).name)}`).join("\n")}
//
// A bare \`sm1\` in a title says nothing about which of those two cards it is,
// and they are different prints with different markets and different prices.
// So they are keyed ENGLISH (which is what the English branch already answers)
// and the Japanese products are reached by NAME through
// japanesePokemonAliases.ts — the same rule CF-THE-JAPANESE-CODE-IS-THE-KEY
// states, applied to codes.`;

  const body = `${header}

/** English set codes — the catalog's own setKey spelling. */
export const POKEMON_EN_SET_CODES: Readonly<Record<string, string>> = Object.freeze({
${lit(EN)}
});

/** English promo / Black Star codes. The census's largest Pokemon spellings. */
export const POKEMON_PROMO_SET_CODES: Readonly<Record<string, string>> = Object.freeze({
${lit(PROMO)}
});

/** Japanese-only set codes. Codes shared with an English set are absent by
 *  construction — see the header. */
export const POKEMON_JA_SET_CODES: Readonly<Record<string, string>> = Object.freeze({
${lit(JA)}
});

/** The ${ambiguous.length} codes both markets use for different products. Exported so the
 *  resolver can REFUSE them from a bare code and the tests can pin that. */
export const AMBIGUOUS_MARKET_CODES: ReadonlySet<string> = Object.freeze(
  new Set(${JSON.stringify(ambiguous)}),
) as ReadonlySet<string>;
`;

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, body);
  console.log(`wrote ${out}: ${Object.keys(EN).length} en, ${Object.keys(PROMO).length} promo, ${Object.keys(JA).length} ja, ${ambiguous.length} ambiguous`);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
