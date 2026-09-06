#!/usr/bin/env node
// CF-THE-SITEMAP-IS-THE-DISCOVERY (2026-09-04). Companion to
// fetchSportsCardChecklist.cjs; spec in
// backend/docs/checklists/2026-09-04-vintage-checklist-sources.md §6.2.
//
// Lists the sets www.sportscardchecklist.com serves for the seven target cells
// (plus the hockey/topps bonus cell) and APPENDS manifest entries to
// backend/data/ingest-universe.json under lane `sportscardchecklist`.
//
// ENTRIES ONLY. This mints addresses, never rows: no page fetch beyond the
// sitemaps, no Cosmos access, no ingest. The driver does the acquiring, one
// entry at a time, with a verdict each.
//
// ── WHY THE SITEMAP AND NOT THE SEARCH ──────────────────────────────────────
// robots.txt (HTTP 200, 134 bytes, verbatim):
//
//     # Sitemap
//     Sitemap: https://www.sportscardchecklist.com/site_maps/sitemap.xml
//
//     # All Bots
//     User-agent: *
//     Disallow: /?*
//     Disallow: /*.htm$
//
// `Disallow: /?*` covers /search/?search_terms=..., so the search endpoint is
// off-limits — and it is also WRONG: the survey measured "1972 topps football"
// returning 18 results, none of them the set, which lives at set-11959. The
// sitemap is both the sanctioned path and the accurate one. It is advertised in
// robots.txt itself.
//
// ── THE SPLIT-YEAR TRAP ─────────────────────────────────────────────────────
// Basketball and hockey slugs carry a season (1979-80-o-pee-chee-, 1992-93-
// fleer-); football and baseball carry a single year. A year-anchored regex
// assuming one form reports ZERO sets for basketball 1991-2009 and for all of
// hockey — which is exactly the false negative that makes a live source look
// absent. Both forms are accepted and the FIRST year is the cell year.
//
//   node scripts/discoverSportsCardChecklistSets.cjs                  # report only
//   node scripts/discoverSportsCardChecklistSets.cjs --apply          # append entries
//   node scripts/discoverSportsCardChecklistSets.cjs --cache <dir>    # reuse fetched sitemaps

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const backend = path.join(__dirname, "..");
/**
 * CF-EVERY-EMITTED-SETKEY-IS-A-FIXED-POINT (2026-09-04).
 *
 * setKeyFor() derives a key from the set NAME, and on this source that name is
 * a slug remainder: "1992-93 Fleer All-Stars Basketball" derives
 * "fleer-all-stars". normalizeSetKey collapses that to "fleer" -- so an entry
 * carrying the derived key would be verified against a key the catalog never
 * uses, and rows minted under it land UNFINDABLE (#1614, and the
 * checklist-ingest-leaves-rows-unfindable ruling).
 *
 * Measured over all 5,851 discovered sets: 4,859 of the 4,884 distinct derived
 * keys are NOT fixed points. Passing each through normalizeSetKey IS the fix and
 * is provably safe here -- normalizeSetKey is idempotent on every one of those
 * 4,884 keys (0 exceptions), so its output is a fixed point by construction.
 * The entry records BOTH: setKey is the canonical key the catalog uses, and
 * derivedSetKey keeps the source's own spelling for audit.
 *
 * This is deliberately NOT a new vocabulary. Where a specialized product is
 * already known (topps-chrome, skybox-premium, upper-deck-mvp -- 25 of them) the
 * key survives untouched; where it is not, the set nests under its flagship
 * rather than minting a product nobody can find. Naming the unknown ones is a
 * vocabulary ruling, not a discovery-script decision -- derivedSetKey is what a
 * later ruling reads to find every set that nested.
 */
const { normalizeSetKey } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { setKeyFor } = require(path.join(__dirname, "ingest-universe-driver.cjs"));

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has = (f) => args.includes(f);

const APPLY = has("--apply");
const BASE = "https://www.sportscardchecklist.com";
const SITEMAP_INDEX = `${BASE}/site_maps/sitemap.xml`;
const UA = process.env.SCC_UA
  || "Mozilla/5.0 (compatible; HobbyIQ-checklist-fetch/1.0; +https://hobbyiq.app; contact: dvabulas@outlook.com)";
const DELAY_MS = Math.max(1000, Number(process.env.SCC_DELAY_MS || 1100));
const MANIFEST_PATH = process.env.MANIFEST_PATH
  || path.join(__dirname, "..", "data", "ingest-universe.json");
const CACHE_DIR = val("--cache", "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (n) => Number(n).toLocaleString();

function get(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": UA, Accept: "application/xml,text/xml" } }, (res) => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), attempt));
      }
      if ((code === 429 || code === 503) && attempt < 4) {
        res.resume();
        return sleep(DELAY_MS * Math.pow(2, attempt + 1)).then(() => resolve(get(url, attempt + 1)));
      }
      if (code !== 200) { res.resume(); return reject(new Error(`HTTP ${code} for ${url}`)); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

const locs = (xml) => {
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
};

/**
 * THE SEVEN TARGET CELLS, plus the hockey/topps bonus PR #1689 listed
 * "NOT QUEUED". A cell is (sport, setKey, year range) and the setKey is the
 * catalog's own word for the brand — the same string setKeyFor() derives from
 * the set name, so a manifest entry and its verification agree.
 */
const CELLS = [
  /**
   * CF-NON-SPORT-IS-A-VERTICAL (2026-09-06). The regex above now admits the
   * source's `nonsport` word and maps it to the ruled `non-sport`; a cell is
   * what turns that into ENTRIES. Measured on the sitemap: 5,163 non-sport set
   * URLs, 21 of them 1948-1962, and the brands are the ones already ruled here
   * -- Topps (15), Bowman (2), Fleer (2), plus two oddball issuers a brand rule
   * does not name and which therefore stay unminted rather than being guessed.
   *
   * The window matches the vintage cells beside it. Nothing later is claimed:
   * the modern non-sport universe is thousands of sets and is a scoping
   * decision, not a discovery-script one.
   */
  { sport: "non-sport", setKey: "topps",      from: 1948, to: 1969, label: "non-sport/topps/1948-1969" },
  { sport: "non-sport", setKey: "bowman",     from: 1948, to: 1969, label: "non-sport/bowman/1948-1969" },
  { sport: "non-sport", setKey: "fleer",      from: 1948, to: 1969, label: "non-sport/fleer/1948-1969" },
  { sport: "football",   setKey: "topps",      from: 1948, to: 1989, label: "football/topps/1948-1989" },
  { sport: "basketball", setKey: "topps",      from: 1948, to: 1988, label: "basketball/topps/1948-1988" },
  { sport: "basketball", setKey: "topps",      from: 1991, to: 2009, label: "basketball/topps/1991-2009" },
  { sport: "basketball", setKey: "upper-deck", from: 1991, to: 2009, label: "basketball/upper-deck/1991-2009" },
  { sport: "basketball", setKey: "fleer",      from: 1990, to: 2009, label: "basketball/fleer/1990-2009" },
  { sport: "basketball", setKey: "skybox",     from: 1991, to: 2008, label: "basketball/skybox/1991-2008" },
  { sport: "hockey",     setKey: "o-pee-chee", from: 1933, to: 1989, label: "hockey/o-pee-chee/1933-1989" },
  { sport: "hockey",     setKey: "topps",      from: 1900, to: 1989, label: "hockey/topps/pre-1990", bonus: true },
  /**
   * CF-THE-DISCOVERY-NEVER-KNEW-ABOUT-BASEBALL (2026-09-04).
   *
   * The seven target cells were chosen because no other lane reached them, and
   * all seven are football/basketball/hockey. So the sitemap pass classified
   * every baseball set URL as `null` and minted nothing for the sport this
   * catalog is most of. Measured on the same 141,482-URL sitemap the survey
   * cached: 40,699 of them are baseball, and NOT ONE was ever offered.
   *
   * The eight #1719 Topps Traded Tiffany entries are what exposed it. They had
   * to be hand-written into the manifest, one at a time, because the discovery
   * that mints entries for exactly this source could not see them -- and the
   * source serves the whole family: 1984-1990 `topps-tiffany-traded`, plus
   * `topps-tiffany` for 1984-1991 and `bowman-tiffany` for 1989-1990, none of
   * which the manifest holds.
   *
   * SCOPED TO TOPPS AND BOWMAN, 1980-1999, deliberately. This is the Tiffany /
   * Traded / flagship window the goal names, and it is where the checklist gap
   * behind the vintage comps sits. Opening baseball to every brand and every
   * year would mint tens of thousands of entries in one commit, which is a
   * queue nobody has budgeted and a review nobody can read. The remaining
   * baseball cells are a later, deliberate widening -- and this file is now the
   * place that widening happens, which it was not before.
   *
   * ENTRIES ONLY, as ever: this mints addresses, and the driver's per-entry
   * verdict is what settles any of them.
   */
  { sport: "baseball",   setKey: "topps",      from: 1980, to: 1999, label: "baseball/topps/1980-1999" },
  { sport: "baseball",   setKey: "bowman",     from: 1980, to: 1999, label: "baseball/bowman/1980-1999" },
  /**
   * CF-THE-FLEER-COATED-REPRINTS-WERE-INVISIBLE-TOO (2026-09-04).
   *
   * The note above says the remaining baseball cells are "a later, deliberate
   * widening -- and this file is now the place that widening happens". This is
   * that widening, and #1745 is what forced it: its repair lane gates 1,339
   * catalog rows and 994 comps on Fleer Tiffany / Fleer Glossy products that
   * the catalog had never minted, and NEITHER key was reachable from here
   * because baseball was scoped to Topps and Bowman.
   *
   * The source serves all of them -- 1987/1988/1989 Fleer Glossy, 1987/1988
   * Fleer Update Glossy, 1996 Fleer Tiffany, 1996 Fleer Update Tiffany, 1997
   * Fleer Tiffany, 2002 Fleer Tiffany -- and every one had to be found by
   * grepping a cached sitemap by hand, which is the same "the discovery never
   * knew about it" failure this cell list already carries a note about.
   *
   * 1985-2003 covers the Glossy Tin run (1987-1989) at its front and Fleer
   * Tradition at its back; `fleer` is anchored at the head of the slug
   * remainder, so `1996-97-skybox-e-x2000-fleer-...` stays out.
   */
  { sport: "baseball",   setKey: "fleer",      from: 1985, to: 2003, label: "baseball/fleer/1985-2003" },
  /**
   * CF-THE-1990S-BRANDS-THE-REMATCH-CANNOT-PLACE (2026-09-04, IMPROVE gate audit
   * of #1758).
   *
   * The two notes above each say the same thing twice: the remaining baseball
   * cells are "a later, deliberate widening -- and this file is now the place
   * that widening happens". This is that widening, and the #1758 audit is what
   * forced it. ~61k 1990s baseball sales cannot be placed because the products
   * they name hold ZERO card_catalog rows, and NOT ONE of those products was
   * reachable from here: baseball was scoped to Topps, Bowman and Fleer, and the
   * junk-wax era is Pacific, Pinnacle, Score, Donruss, Leaf, Studio, Select,
   * Stadium Club, SP and Bowman's Best.
   *
   * Every blocking product had to be found by grepping a cached sitemap by
   * hand -- for the THIRD time in this file's short history. The cells below are
   * the standing fix: the brands are named once, at the year range the pool
   * actually holds, so the next gap is a discovery run and not another hand-grep.
   *
   * 1990-1999 ON EVERY CELL, deliberately. These brands are a decade-shaped
   * phenomenon -- Pacific's licence runs 1994-2000, SP starts 1993, Studio and
   * Select are Pinnacle-era, Metal Universe is 1996-1998 -- and a per-brand
   * hand-tuned range would encode guesses about start years the sitemap can
   * settle for free. A cell that matches nothing costs one line and reports 0.
   *
   * `sp` IS ITS OWN CELL AND ITS OWN BRAND. The source slugs Upper Deck's SP as
   * `1993-sp`, `1995-sp-championship`, `1998-sp-authentic` -- never
   * `upper-deck-sp` -- so the upper-deck cell cannot reach it (the brand rule is
   * anchored at the slug HEAD, correctly). Measured: 59 sets in the window.
   *
   * `metal-universe` LIKEWISE. Fleer's Metal is slugged `1996-metal-universe`,
   * with no `fleer-` prefix, so the fleer cell above never saw its 23 sets.
   *
   * ENTRIES ONLY, as ever.
   */
  { sport: "baseball",   setKey: "pacific",        from: 1990, to: 1999, label: "baseball/pacific/1990-1999" },
  { sport: "baseball",   setKey: "upper-deck",     from: 1990, to: 1999, label: "baseball/upper-deck/1990-1999" },
  { sport: "baseball",   setKey: "sp",             from: 1990, to: 1999, label: "baseball/sp/1990-1999" },
  { sport: "baseball",   setKey: "score",          from: 1990, to: 1999, label: "baseball/score/1990-1999" },
  { sport: "baseball",   setKey: "pinnacle",       from: 1990, to: 1999, label: "baseball/pinnacle/1990-1999" },
  { sport: "baseball",   setKey: "donruss",        from: 1990, to: 1999, label: "baseball/donruss/1990-1999" },
  { sport: "baseball",   setKey: "leaf",           from: 1990, to: 1999, label: "baseball/leaf/1990-1999" },
  { sport: "baseball",   setKey: "studio",         from: 1990, to: 1999, label: "baseball/studio/1990-1999" },
  { sport: "baseball",   setKey: "select",         from: 1990, to: 1999, label: "baseball/select/1990-1999" },
  { sport: "baseball",   setKey: "stadium-club",   from: 1990, to: 1999, label: "baseball/stadium-club/1990-1999" },
  { sport: "baseball",   setKey: "bowmans-best",   from: 1990, to: 1999, label: "baseball/bowmans-best/1990-1999" },
  { sport: "baseball",   setKey: "metal-universe", from: 1990, to: 1999, label: "baseball/metal-universe/1990-1999" },
  /**
   * CF-THE-VINTAGE-CELLS-THE-CENSUS-CALLED-SOURCELESS (2026-09-05, checklist-gap
   * census top-50 pass).
   *
   * FOURTH widening, and the notes above have now predicted it three times:
   * "the remaining baseball cells are a later, deliberate widening -- and this
   * file is now the place that widening happens". This is that widening for the
   * PRE-1980 cells, and the gap census is what forced it.
   *
   * WHAT THE CENSUS SAID, AND WHY IT WAS WRONG. The 2026-09-05 census ranked
   * four pre-1980 baseball products in its top 50 and marked every one
   * "not-enumerated / source gap -- check the sportscardchecklist sitemap":
   *
   *     baseball 1933 goudey    11,256 rows   $3,733,108
   *     baseball 1948 leaf        3,156 rows   $4,432,015
   *     baseball 1909 t206        6,578 rows   $1,389,491
   *     baseball 1948 bowman      4,516 rows   $1,129,357
   *
   * The source serves ALL FOUR, and has all along. They were invisible from
   * here because baseball was scoped 1980-2003: the cells above open at 1980
   * (Topps/Bowman), 1985 (Fleer) and 1990 (the junk-wax brands), so a 1933 set
   * URL classified as `null` and no entry was ever minted. "No permissive
   * source" was a statement about THIS FILE'S CELL LIST, not about the web.
   *
   * MEASURED ON THE 2026-09-05 SITEMAP (141,583 URLs, 30 child sitemaps, all
   * lastmod 2026-09-05), pre-1980 baseball by brand:
   *
   *     topps 122 (1948-1979)   fleer 21 (1959-1979)   o-pee-chee 20 (1960-1979)
   *     bowman 11 (1948-1955)   goudey 8 (1933-1941)   leaf 3 (1948-1960)
   *     t206 1 (1909)
   *
   * All four gap sets were fetched and parsed offline through this lane's own
   * fetcher before this cell list was touched -- both parse anchors agree on
   * every one, 0 rows skipped:
   *
   *     1909-11 T206      524 rows   (the canonical T206 count)
   *     1933 Goudey       241 rows
   *     1948-49 Leaf      101 rows   (skip-numbered: #2 absent, correctly)
   *     1948 Bowman        50 rows
   *
   * THE SPLIT-YEAR TRAP, AGAIN, AND IT BIT THE BRANDS. Two of the four carry a
   * split-year slug -- `1948-49-leaf-baseball-` and `1909-11-t206-baseball-`.
   * This file's SET_URL_RE has accepted both year forms since 2026-09-04, so
   * discovery is safe; but the cell year is the FIRST year (1948, 1909), which
   * is how the pool spells them, and a cell range that opened at 1949 or 1910
   * would miss both. The ranges below are anchored on the first year.
   *
   * `goudey`, `leaf` AND `t206` ARE THEIR OWN BRANDS. Goudey and Leaf are not
   * Topps products and no existing cell reaches them; T206 is a tobacco issue
   * whose "brand" is the ACC designation itself, which is exactly how both the
   * source and our own pool key it (`hiq:baseball:1909:t206:`). Each needs its
   * own BRAND_RE entry or the cell matches nothing -- the load-time guard below
   * catches that, and it is why these three appear there.
   *
   * SCOPED 1900-1979 AND TO SIX BRANDS, deliberately. The source serves 523
   * pre-1980 baseball sets across a long oddball tail (Kahn's Wieners, Bazooka,
   * Kellogg's, Hostess, Milton Bradley, ...). Opening all of them mints a queue
   * nobody budgeted, which is the objection the 1980-1999 note above already
   * records. These six are the brands that back the census's own gap rows.
   */
  { sport: "baseball",   setKey: "topps",      from: 1948, to: 1979, label: "baseball/topps/1948-1979" },
  { sport: "baseball",   setKey: "bowman",     from: 1948, to: 1979, label: "baseball/bowman/1948-1979" },
  { sport: "baseball",   setKey: "fleer",      from: 1959, to: 1979, label: "baseball/fleer/1959-1979" },
  { sport: "baseball",   setKey: "o-pee-chee", from: 1960, to: 1979, label: "baseball/o-pee-chee/1960-1979" },
  { sport: "baseball",   setKey: "goudey",     from: 1933, to: 1941, label: "baseball/goudey/1933-1941" },
  { sport: "baseball",   setKey: "leaf",       from: 1948, to: 1960, label: "baseball/leaf/1948-1960" },
  { sport: "baseball",   setKey: "t206",       from: 1909, to: 1911, label: "baseball/t206/1909-1911" },
  /**
   * CF-THE-HOCKEY-CELLS-THE-CENSUS-CALLED-SOURCELESS (2026-09-05, same pass).
   *
   * The census marked hockey 2005 and 2015 Upper Deck "no permissive source;
   * hobbymonitor /release/* is the only modern candidate". The source serves
   * 308 Upper Deck sets for 2005-06 and 875 for 2015-16 -- measured on the same
   * sitemap -- and neither was reachable because hockey was scoped to
   * o-pee-chee/topps pre-1990.
   *
   * TWO YEARS, NOT THE WHOLE RUN. The source carries 7,082 hockey Upper Deck
   * sets across 1990-2018. Minting all of them is the un-budgeted queue this
   * file keeps refusing; these are the two years the census ranks, and the rest
   * is a later widening on the same evidence standard.
   *
   * These two cells are NOT the fix for the 2020-2025 hockey Upper Deck gaps in
   * the same census (13,907 + 9,633 + 9,127 + 8,723 + 5,874 rows). The source
   * stops at 2018 for this brand, and those rows are a DIFFERENT defect anyway:
   * their sales titles state `Series 1` / `Series 2` / `Young Guns` and the pool
   * flattened all of them to a bare `upper-deck` key, while checklistinsider has
   * already ingested `upper-deck-series-1` / `upper-deck-series-2` for exactly
   * those years. That is a rekey, not an acquisition, and it is reported in
   * docs/reports/checklist-gaps-my-domain-2026-09-05.md rather than fixed here.
   */
  { sport: "hockey",     setKey: "upper-deck", from: 2005, to: 2005, label: "hockey/upper-deck/2005" },
  { sport: "hockey",     setKey: "upper-deck", from: 2015, to: 2015, label: "hockey/upper-deck/2015" },
];

/**
 * A brand matches at the HEAD of the slug remainder, anchored. `fleer` must not
 * match `1996-97-skybox-e-x2000-fleer-...`, and an unanchored test would put a
 * SkyBox set in the Fleer cell — a mis-filed cell is a mis-filed product.
 */
const BRAND_RE = {
  "topps": /^topps(?:-|$)/,
  "o-pee-chee": /^o-pee-chee(?:-|$)/,
  "fleer": /^fleer(?:-|$)/,
  "upper-deck": /^upper-deck(?:-|$)/,
  "skybox": /^skybox(?:-|$)/,
  "bowman": /^bowman(?:-|$)/,
  "pacific": /^pacific(?:-|$)/,
  "score": /^score(?:-|$)/,
  "pinnacle": /^pinnacle(?:-|$)/,
  "donruss": /^donruss(?:-|$)/,
  "leaf": /^leaf(?:-|$)/,
  "studio": /^studio(?:-|$)/,
  "select": /^select(?:-|$)/,
  "stadium-club": /^stadium-club(?:-|$)/,
  "metal-universe": /^metal-universe(?:-|$)/,
  /**
   * THE THREE PRE-1980 BRANDS THAT ARE NOT A MODERN MAKER. Goudey (1933-1941)
   * and Leaf (1948-1960) are their own issuers, and `t206` is an ACC
   * designation rather than a maker name -- the source slugs it `1909-11-t206-`
   * and our own pool keys it `hiq:baseball:1909:t206:`, so the designation IS
   * the brand word here. Anchored like every other entry: `leaf` must not match
   * `1990-leaf-donruss-previews` into the wrong cell, and the year ranges above
   * keep the vintage Leaf cell clear of the 1990-1999 Leaf cell.
   */
  "goudey": /^goudey(?:-|$)/,
  "t206": /^t206(?:-|$)/,
  /**
   * SP, AND WHY IT IS NOT `sp-?`. Anchored with a boundary so `1993-sp` and
   * `1995-sp-championship` match while `1998-spx` and `1997-sp-spx-force` do
   * not get swallowed by a prefix test -- SPx is a DIFFERENT Upper Deck product
   * with its own pool, and `/^sp/` would file it under SP.
   */
  "sp": /^sp(?:-|$)/,
  /**
   * BOWMAN'S BEST CARRIES A LITERAL BACKSLASH. The source slugs it
   * `1994-bowman\s-best` -- a PHP addslashes pass leaking into the URL itself,
   * verified byte-for-byte in the sitemap:
   *
   *     https://www.sportscardchecklist.com/set-12825/1994-bowman\s-best-baseball-...
   *
   * A pattern spelling the apostrophe the obvious way (`bowman-s-best`, or an
   * unescaped `'`) matches ZERO of the 63 sets in the window and reports the
   * product absent -- this file's own founding false negative, in a new costume.
   * Both forms are accepted so a source that later fixes its escaping keeps
   * working.
   */
  "bowmans-best": /^bowman(?:\\s|'s|s)?-best(?:-|$)/,
};

/**
 * A CELL WHOSE BRAND HAS NO PATTERN MATCHES NOTHING, SILENTLY. classify()
 * skips a cell when BRAND_RE has no entry for its setKey -- which reads
 * exactly like "the source serves no such sets", the false negative this
 * file's own split-year note was written about. Adding a cell and forgetting
 * its pattern is a one-line mistake that costs a whole survey, so it fails at
 * load instead.
 */
for (const cell of CELLS) {
  if (!BRAND_RE[cell.setKey]) {
    throw new Error(`discoverSportsCardChecklistSets: cell ${cell.label} names brand "${cell.setKey}" with no BRAND_RE pattern — it would match nothing and report zero sets`);
  }
}

// Both year forms. `year2` present = split season; the FIRST year is the cell year.
/**
 * CF-NON-SPORT-IS-A-VERTICAL-THE-REGEX-NEVER-ADMITTED (2026-09-06).
 *
 * A walk for `sports=non-sport years=1948-1962` found 0 eligible entries, and
 * the manifest is the reason: this regex alternated four sports, so every
 * `-nonsport-trading-card-checklist` URL failed to parse, classify() returned
 * null, and 5,163 non-sport sets -- 21 of them in 1948-1962 -- were never
 * minted as entries at all. Not dropped by a cell rule, never seen.
 *
 * The source spells the vertical `nonsport`, one word. The catalog spells it
 * `non-sport`, and slugGuard's CANONICAL_SPORTS already rules that spelling
 * with `"nonsport": "non-sport"` among its aliases -- so this admits a vertical
 * the system already knows and invents no vocabulary. sportOf() below maps the
 * source's word to the ruled one at the boundary, so nothing downstream ever
 * sees `nonsport`.
 *
 * The sets are real and famous: 1952 Topps Wings, 1953 Fighting Marines, 1953-55
 * World on Wheels, 1955 Rails and Sails, 1956 Flags of the World, 1956 Davy
 * Crockett (both backs).
 */
/**
 * The source's sport word, mapped to the vertical the CATALOG rules.
 * `nonsport` -> `non-sport` is slugGuard's own alias (CANONICAL_SPORTS), so
 * this adopts a ruled spelling rather than inventing one, and nothing
 * downstream ever sees the source's form.
 */
const SPORT_FROM_SLUG = { nonsport: "non-sport" };
const canonicalSport = (s) => SPORT_FROM_SLUG[String(s || "")] || String(s || "");

const SET_URL_RE =
  /\/set-(\d+)\/(\d{4})(?:-(\d{2}))?-(.+?)-(football|basketball|hockey|baseball|nonsport)-trading-card-checklist\/?$/;

/**
 * CF-THE-ADDSLASHES-LEAK-IS-IN-THE-URL-TOO (2026-09-06, from the refused
 * re-ingest of 1997 Bowman's Best set-13670 and set-13671).
 *
 * The BRAND_RE note above records that this source slugs Bowman's Best as
 * `1994-bowman\s-best` -- a PHP addslashes pass leaking into the URL. That note
 * made the brand PATTERN accept the backslash, which was right and not enough:
 * the escaped remainder was then carried VERBATIM into `setName`, `sourceRef`
 * and `derivedSetKey`, and every consumer downstream inherited it.
 *
 * WHAT IT COST, measured on the manifest today: 60 entries -- 45 `Bowman\s`
 * and 15 `Mcdonald\s`, across baseball 1990s, hockey 2000s and basketball
 * 1990s-2000s. On the two rung pages the coordinator dispatched:
 *
 *   rest = "bowman\s-best-atomic-refractors"
 *     parallelFromSlug  -> "Atomic Refractor"      (correct)
 *     splitParentAndSubset -> parentSetKey ""      (NO BRAND MATCHED)
 *     => parallelOfParent = false
 *
 * and a rung page with no parent claim carries zero base cards, so the driver's
 * zero-base gate refuses the whole file. That is the reconciliation the run
 * printed: `intended 2 = written 0 + failed 2`. It is ALSO why these rows
 * carried `setKey: bowman` -- `bowman\s-best` never matched the `bowmans-best`
 * entry in PARENT_BRANDS, so the brand walk fell through to bare `bowman`. One
 * cause, three symptoms.
 *
 * THE SITE ITSELF DROPS THE APOSTROPHE. Verified by fetch on 2026-09-06, all
 * three forms return HTTP 200 because the server keys on `set-<id>` and is
 * lenient about the slug -- so this is NOT a 404 fix. It is a fix for OUR
 * parsers, which key on the slug text and are not lenient at all. The
 * apostrophe-dropped spelling is the one the site's own canonical links use and
 * the one the catalog already spells (`bowmans-best`), so that is what we store.
 *
 * `\'` and `\"` are stripped for the same reason: they are the other two escapes
 * an addslashes pass emits, and a source that starts serving them would
 * reproduce this bug in a new costume. `\\` collapses to a single backslash
 * first so an already-doubled escape is not half-unescaped.
 */
function unescapeAddslashes(s) {
  return String(s ?? "").replace(/\\(.)/g, "$1");
}

/**
 * The slug as the SITE canonically spells it: addslashes undone, then the
 * apostrophe DROPPED rather than turned into a separator.
 *
 * `bowman\s-best` -> `bowmans-best`, never `bowman-s-best`. The distinction is
 * load-bearing: `bowman-s-best` is not what the catalog spells and would not
 * match `bowmans-best` in PARENT_BRANDS either, so it would leave the same
 * three symptoms with a tidier-looking slug.
 */
function canonicalSlug(rest) {
  return unescapeAddslashes(rest).replace(/'/g, "");
}

/** The whole set URL with its slug canonicalised; the `set-<id>` is untouched. */
function canonicalSetUrl(url) {
  const u = String(url ?? "");
  const m = SET_URL_RE.exec(u);
  if (!m) return unescapeAddslashes(u).replace(/'/g, "");
  const rest = canonicalSlug(m[4]);
  const season = m[3] ? `${m[2]}-${m[3]}` : m[2];
  const base = u.slice(0, u.indexOf(`/set-${m[1]}/`));
  return `${base}/set-${m[1]}/${season}-${rest}-${m[5]}-trading-card-checklist`;
}

function classify(url) {
  const m = SET_URL_RE.exec(url);
  if (!m) return null;
  const year = Number(m[2]);
  // CANONICALISE AT THE BOUNDARY. Everything this function returns -- the slug
  // remainder, the set name derived from it, the URL the lane will fetch --
  // flows from `rest`, so undoing the escape here fixes all three at once and
  // nothing downstream has to remember to.
  const rest = canonicalSlug(m[4]);
  const sport = canonicalSport(m[5]);
  for (const cell of CELLS) {
    if (cell.sport !== sport) continue;
    if (year < cell.from || year > cell.to) continue;
    const re = BRAND_RE[cell.setKey];
    if (!re || !re.test(rest)) continue;
    return {
      cell,
      setId: m[1],
      year,
      season: m[3] ? `${year}-${m[3]}` : String(year),
      rest,
      sport,
      // THE URL THE LANE WILL FETCH, canonical. Storing the raw sitemap string
      // here is what put the backslash into 60 manifest `sourceRef`s, and the
      // fetcher parses that string to derive the rung and the parent product.
      url: canonicalSetUrl(url),
      // The sitemap's own spelling, kept so an escaped source is auditable
      // rather than silently rewritten.
      sourceUrlRaw: url,
    };
  }
  return null;
}

/** Title-case a slug remainder back into a set name the catalog can key off.
 *  `setKeyFor()` strips the year and the trailing sport, so the name is spelled
 *  the way the other lanes spell theirs: "<season> <Brand ...> <Sport>". */
const TITLE_EXC = new Set(["o", "pee", "chee"]);
function setNameFrom(season, rest, sport) {
  const words = rest.split("-").map((w) => {
    if (!w) return w;
    if (/^\d+$/.test(w)) return w;
    return w[0].toUpperCase() + w.slice(1);
  });
  const brandish = words.join(" ").replace(/\bO Pee Chee\b/i, "O-Pee-Chee").replace(/\bUpper Deck\b/i, "Upper Deck");
  const sportWord = sport[0].toUpperCase() + sport.slice(1);
  return `${season} ${brandish} ${sportWord}`.replace(/\s+/g, " ").trim();
}

async function main() {
  // ── 1. discovery ──────────────────────────────────────────────────────────
  let sitemapXmls = [];
  if (CACHE_DIR && fs.existsSync(CACHE_DIR)) {
    const files = fs.readdirSync(CACHE_DIR).filter((n) => n.endsWith(".xml") && /sitemap\d+/.test(n));
    sitemapXmls = files.map((n) => fs.readFileSync(path.join(CACHE_DIR, n), "utf8"));
    console.log(`sitemaps: ${files.length} from cache ${CACHE_DIR}`);
  } else {
    const idx = await get(SITEMAP_INDEX);
    const children = locs(idx);
    console.log(`sitemap index: ${children.length} child sitemaps`);
    for (const c of children) {
      sitemapXmls.push(await get(c));
      await sleep(DELAY_MS);          // one at a time, >=1s apart
    }
    if (CACHE_DIR) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      sitemapXmls.forEach((x, i) => fs.writeFileSync(path.join(CACHE_DIR, `sitemap${i + 1}.xml`), x));
    }
  }

  const all = new Set();
  for (const xml of sitemapXmls) for (const u of locs(xml)) if (/\/set-\d+\//.test(u)) all.add(u);
  console.log(`set URLs: ${f(all.size)}`);

  // ── 2. cell classification ────────────────────────────────────────────────
  const perCell = new Map(CELLS.map((c) => [c.label, []]));
  for (const u of all) {
    const c = classify(u);
    if (c) perCell.get(c.cell.label).push(c);
  }

  console.log("\n── candidate sets per cell ──");
  let total = 0;
  for (const cell of CELLS) {
    const n = perCell.get(cell.label).length;
    total += n;
    console.log(`  ${String(n).padStart(6)}  ${cell.label}${cell.bonus ? "   [bonus]" : ""}`);
  }
  console.log(`  ${String(total).padStart(6)}  TOTAL`);

  // ── 3. manifest entries ───────────────────────────────────────────────────
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const existing = new Set(manifest.entries.map((e) => e.id));
  const added = [];
  let dup = 0, unkeyed = 0, notFixed = 0;

  for (const cell of CELLS) {
    for (const c of perCell.get(cell.label).sort((a, b) => a.year - b.year || a.rest.localeCompare(b.rest))) {
      const id = `sportscardchecklist::${c.url}`;
      if (existing.has(id)) { dup++; continue; }
      existing.add(id);
      const setName = setNameFrom(c.season, c.rest, c.sport);
      const derived = setKeyFor({ setName, year: c.year, lane: "sportscardchecklist" });
      const canonical = derived ? normalizeSetKey(derived) : null;
      // An entry whose key is not derivable is UNVERIFIABLE, and the driver
      // treats unverifiable as failed. Refuse it here rather than seeding a
      // verdict nobody can settle.
      if (!canonical) { unkeyed++; continue; }
      if (normalizeSetKey(canonical) !== canonical) { notFixed++; continue; }
      added.push({
        id,
        lane: "sportscardchecklist",
        sourceRef: c.url,
        sport: c.sport,
        year: c.year,
        setName,
        setKey: canonical,
        derivedSetKey: derived !== canonical ? derived : undefined,
        estimatedCards: null,
        // Seeded MISSING, never "partial": nothing here has been fetched, so
        // claiming a partial state would assert a measurement nobody made. The
        // driver's own verdict is what settles it.
        seededStatus: "missing",
        seededNote:
          `sitemap-discovered ${new Date().toISOString().slice(0, 10)}; cell ${cell.label}` +
          (cell.bonus ? " (bonus cell, PR #1689 NOT QUEUED)" : "") +
          `; season=${c.season}; set-${c.setId}; not yet fetched`,
      });
    }
  }

  console.log(`\nmanifest: ${f(manifest.entries.length)} entries now, +${f(added.length)} new` +
    (dup ? `, ${f(dup)} already present` : "") +
    (unkeyed ? `, ${f(unkeyed)} REFUSED (no derivable setKey — unverifiable)` : "") +
    (notFixed ? `, ${f(notFixed)} REFUSED (setKey not a normalizeSetKey fixed point)` : ""));
  const nested = added.filter((e) => e.derivedSetKey).length;
  if (nested) {
    console.log(`  ${f(nested)} sets nest under a flagship key (their derived key is not in the` +
      ` vocabulary); ${f(added.length - nested)} keep their own product key.`);
  }

  // The unreachable list travels with the manifest so the driver never re-probes
  // what a 404 settled. Seven of its eight marks are football/basketball/hockey
  // cells THIS SOURCE COVERS -- 1972 Topps Football among them, proven at 351
  // cards. They are re-pointed, never deleted: the mark records that hobbymonitor
  // could not reach the set, which is still true of hobbymonitor.
  const covered = (manifest.unreachable || []).filter((u) =>
    CELLS.some((c) => c.sport === u.sport && c.setKey === u.setKey && u.year >= c.from && u.year <= c.to));
  if (covered.length) {
    console.log(`\nunreachable marks now covered by this source: ${covered.length}`);
    for (const u of covered) console.log(`  ${u.sport} ${u.year} ${u.setKey}  (${f(u.comps)} comps, ${f(u.uncovered)} uncovered)`);
  }

  if (!APPLY) {
    console.log("\nREPORT ONLY — pass --apply to append these entries to the manifest.");
    if (added.length) {
      console.log("sample entries:");
      for (const e of added.slice(0, 3)) console.log("  " + JSON.stringify(e));
    }
    return;
  }

  manifest.entries.push(...added);
  for (const u of covered) {
    u.nowCoveredBy = "sportscardchecklist";
    u.note = `${u.note ? u.note + "; " : ""}reachable at sportscardchecklist (2026-09-04 sitemap survey); the mark records that the ORIGINAL lane could not reach it`;
  }
  manifest.totals = manifest.totals || {};
  manifest.totals.entries = manifest.entries.length;
  manifest.totals.byLane = manifest.totals.byLane || {};
  const seeded = {};
  for (const e of manifest.entries) if (e.lane === "sportscardchecklist") seeded[e.seededStatus] = (seeded[e.seededStatus] || 0) + 1;
  manifest.totals.byLane.sportscardchecklist = {
    total: manifest.entries.filter((e) => e.lane === "sportscardchecklist").length,
    seeded,
  };
  manifest.mintedAt = new Date().toISOString();

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 1) + "\n");
  console.log(`\nwrote ${MANIFEST_PATH}  (${f(manifest.entries.length)} entries)`);
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
}

module.exports = { classify, setNameFrom, CELLS, BRAND_RE, SET_URL_RE, locs,
  unescapeAddslashes, canonicalSlug, canonicalSetUrl };
