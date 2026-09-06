#!/usr/bin/env node
// CF-SPORTSCARDCHECKLIST-VINTAGE-LANE (2026-09-04), built to the spec in
// backend/docs/checklists/2026-09-04-vintage-checklist-sources.md §6.
//
// THE SEVENTH LANE, and the only one that reaches vintage football, basketball
// and hockey. Lane B concluded on 2026-09-03 that no permissive vintage source
// existed for those cells; that was correct about the sources it probed and
// wrong about the universe. www.sportscardchecklist.com covers all seven target
// cells (~709,773 pool rows) and its robots.txt permits the paths we need.
//
// ── PERMISSION, QUOTED VERBATIM ─────────────────────────────────────────────
// https://www.sportscardchecklist.com/robots.txt, HTTP 200, 134 bytes, refetched
// in full on 2026-09-04 and byte-identical to the survey's copy:
//
//     # Sitemap
//     Sitemap: https://www.sportscardchecklist.com/site_maps/sitemap.xml
//
//     # All Bots
//     User-agent: *
//     Disallow: /?*
//     Disallow: /*.htm$
//
// Two disallows, NEITHER touching the checklist paths. The set pages are
// `/set-<id>/<slug>` -- no query string, no `.htm` suffix -- and the sitemap is
// explicitly advertised.
//
// `Disallow: /?*` RULES OUT THE SEARCH ENDPOINT (/search/?search_terms=...), so
// this file never touches it. That is not merely a compliance point: the site's
// own search is a false-negative machine. Querying "1972 topps football" returns
// 18 results, NONE of them the 1972 Topps Football set -- they are 2021 Topps X
// Trevor Lawrence cards whose CARD NAMES contain the string. The set exists at
// set-11959. Discovery is the sitemap, always (see discoverSportsCardChecklist-
// Sets.cjs).
//
// No terms document is served: 11 candidate paths return 404. The only ownership
// statement is a bare copyright reservation with no scraping, robots, data-mining
// or non-commercial clause -- the same posture this repo already treats as GO for
// Beckett. Source is attributed in card_catalog.source, as every ingest does.
//
// ── THE PAGE, AND WHY WE PARSE THE HEADER AND NOT THE SEARCH STRING ─────────
// Card rows are server-rendered; no JS execution is needed. Each card renders
// BOTH of these:
//
//   <h5 class="h4"><a ...>1972 Topps  </a> #13 John Riggins </h5>
//   <input type=hidden name="ebay_search" value="1972 Topps  13 John Riggins ">
//
// The survey suggested the hidden input. This parses the H5 HEADER instead,
// because the header carries an explicit `#` before the card number and the
// hidden input does not. Without that delimiter the parser has to guess which
// integer-looking token ends the set name and begins the number -- and the guess
// is wrong on exactly the rows that matter: "1979-80 O-Pee-Chee  1 Mike Bossy"
// opens with two integers that are not the card number, and the football set's
// leader cards trail with years ("... 1971 AFC Rushing Leaders"). `#` is the
// source's own boundary; use it. Both anchors are counted and disagreement is
// reported, so a page shape change is loud rather than silent.
//
// ── WHAT IS EMITTED, AND WHAT IS DELIBERATELY BLANK ─────────────────────────
// The one checklist CSV format (docs/reference/checklist-csv-contract.md):
//     category,cardNumber,parallel,isAuto,printRun,player,parallelNote,rarity
// plus a `.manifest.json` sidecar for product identity and a `.parallels.json`
// when the set is a ladder rung.
//
//   cardNumber  VERBATIM, as the checklist prints it, no `#` prefix.
//   parallel    BLANK unless the SLUG ITSELF names the rung (`-gold-`,
//               `-refractors-`). Never synthesised: every row traces to the
//               scraped page (feedback_no_synthetic_parallels_only_actuals).
//   printRun    BLANK. The page states none, and blank means unknown, never a
//               guess -- a well-formed wrong print run splits a comp pool and no
//               only-improve pass can ever see it.
//   isAuto      From CHECKLIST EVIDENCE ONLY -- an autograph badge or an
//               autograph word in the set name. All three sampled vintage sets
//               carry zero autograph evidence and emit isAuto=false throughout,
//               which is correct: certified autos are a 1990s-onward feature.
//
// ── SUBSET TAGS ARE NOT PARALLELS ───────────────────────────────────────────
// The trailing tag on a card line (LL, DP, AS, IA, RB, CL, TC, AP, UER, "Pro
// Action", "1971 AFC Rushing Leaders") names WHICH CARD this is within the set --
// a subset. A parallel names a FINISH of a card that also exists without it.
// Writing "LL" into the parallel column would mint a rung named after a subset
// and split the base pool, so tags go to `category` as `insert-<slug>` and never
// to `parallel`. The mutation test pins this: tagging as a parallel goes red.
//
// ── SPLIT-YEAR SLUGS ────────────────────────────────────────────────────────
// Basketball and hockey use split-year slugs (1979-80-o-pee-chee-, 1992-93-
// fleer-); football and baseball use single-year. A year-anchored regex assuming
// one form reports ZERO sets for basketball 1991-2009 and all of hockey -- the
// exact false negative that makes a live source look absent. `^(\d{4})(-\d{2})?-`
// is accepted and cardYear is the FIRST year, matching how the pool spells these.
// The mutation test pins this too: drop the split-year branch and it goes red.
//
// ── POLITENESS ──────────────────────────────────────────────────────────────
// One request at a time, >=2s between (SCC_DELAY_MS), a UA identifying HobbyIQ
// with a contact string, and 429/503 honoured with backoff. Set pages are
// 0.5-2 MB, so a whole cell is a multi-hour polite crawl: measure rows/s before
// any fleet dispatch (feedback_fleet_scripts_measure_throughput_before_dispatch).
//
//   node scripts/fetchSportsCardChecklist.cjs \
//     --url https://www.sportscardchecklist.com/set-11959/1972-topps-football-trading-card-checklist \
//     --out data/checklists/scraped/1972-topps-football.csv \
//     --year 1972 --set-key topps --set-name "1972 Topps Football" --sport football
//   node scripts/fetchSportsCardChecklist.cjs --html <cached.html> --out ... (offline)

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const HOST = "www.sportscardchecklist.com";
const UA = process.env.SCC_UA
  || "Mozilla/5.0 (compatible; HobbyIQ-checklist-fetch/1.0; +https://hobbyiq.app; contact: dvabulas@outlook.com)";
const DELAY_MS = Math.max(1000, Number(process.env.SCC_DELAY_MS || 2000));

const { challengeSignal, describeResponse, titleOf } =
  require(path.join(__dirname, "lib", "scc-block-detect.cjs"));

/**
 * CF-THE-POLITENESS-DELAY-WAS-NEVER-SPENT (2026-09-06, run 34044007926).
 *
 * The header of this file has promised ">=2s between requests" since the lane
 * shipped, and DELAY_MS existed to honour it -- but it was only ever read
 * inside the 429/503 backoff. This script fetches ONE page per invocation and
 * the driver invokes it once per entry, so consecutive entries hit the host
 * back to back with no delay at all. A lane that believed it was polite spent
 * thousands of requests today at whatever rate the runner could manage, and
 * then read the host's rate limiting as three dead pages.
 *
 * So the delay is spent HERE, before the request, where a one-shot process can
 * actually honour it. Jittered so a fleet does not synchronise into a pulse
 * that looks exactly like the burst we are trying not to send.
 */
const PAGE_DELAY_MIN_MS = Math.max(0, Number(process.env.SCC_PAGE_DELAY_MS || 2000));
const PAGE_DELAY_JITTER_MS = Math.max(0, Number(process.env.SCC_PAGE_JITTER_MS || 2000));

/** Retry waits before a no-checklist response is allowed to be a verdict. A
 *  soft block lifts on a minute scale; a dead id never does, so this costs a
 *  dead id two waits ONCE and buys back every entry a block would have closed. */
const RETRY_WAITS_MS = String(process.env.SCC_RETRY_WAITS_MS || "60000,180000")
  .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);

const jitteredPageDelay = () =>
  PAGE_DELAY_MIN_MS + Math.floor(Math.random() * (PAGE_DELAY_JITTER_MS + 1));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One GET, polite. 429/503 back off and retry -- a source that asks us to slow
 * down is telling us the rate, and hammering through it is how a GO becomes a
 * block. Anything else fails fast so the driver records a verdict for THIS entry
 * rather than retrying a 404 five times.
 */
async function get(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": UA, Accept: "text/html" } }, (res) => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), attempt));
      }
      if (code === 429 || code === 503) {
        res.resume();
        if (attempt >= 4) return reject(new Error(`HTTP ${code} after ${attempt} retries`));
        const wait = Number(res.headers["retry-after"]) * 1000 || DELAY_MS * Math.pow(2, attempt + 1);
        return sleep(wait).then(() => resolve(get(url, attempt + 1)));
      }
      if (code !== 200) { res.resume(); return reject(new Error(`HTTP ${code}`)); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

const slugify = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Undo the page's own escaping. Values arrive inside an HTML attribute AND
 *  through a PHP addslashes pass, so "Jim O'Brien" is served as `Jim O\'Brien`
 *  -- 351 of 351 rows on the football set carry the backslash form. Left in, the
 *  player name is wrong on every apostrophe name in the catalog. */
function unescapeCell(s) {
  return String(s ?? "")
    .replace(/\\(['"\\])/g, "$1")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * THE SLUG IS THE CELL. Accepts BOTH year forms; `year2` present means a split
 * season and `year` is the FIRST year.
 *
 * Returns { setId, year, year2, seasonLabel, rest, sport } or null.
 */
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
 * CF-THE-ADDSLASHES-LEAK-IS-IN-THE-URL-TOO (2026-09-06).
 *
 * This source's PHP addslashes pass leaks into the URL itself: it slugs
 * Bowman's Best as `1994-bowman\s-best` and McDonald's as `mcdonald\s`, and
 * 60 manifest entries carry that backslash in `sourceRef` today.
 *
 * The escape is invisible to the RUNG reader -- `bowman\s-best-atomic-refractors`
 * still ends in `-atomic-refractors`, so `parallelFromSlug` returns "Atomic
 * Refractor" and everything looks fine -- and fatal to the PARENT reader, whose
 * brand list is matched against the slug HEAD:
 *
 *   splitParentAndSubset("bowman\s-best-atomic-refractors") -> parentSetKey ""
 *
 * No parent claim means `parallelOfParent: false`, and a rung page with no base
 * cards and no parent to attach them to is refused by the driver's zero-base
 * gate. Measured on run of 2026-09-06: `intended 2 = written 0 + failed 2` for
 * set-13670 and set-13671. The same miss is why those rows carried
 * `setKey: bowman` -- `bowman\s-best` never matched `bowmans-best` in
 * PARENT_BRANDS, so the walk fell through to the bare brand.
 *
 * NOT A 404. Verified by fetch on 2026-09-06, the escaped, apostrophe-dropped
 * and hyphenated forms ALL return HTTP 200, because the server keys on
 * `set-<id>`. The host was always willing; our slug readers were not.
 *
 * Canonicalised HERE, in the parser, and not only in the discovery script, so
 * the 60 entries already in the manifest heal on their next fetch without a
 * re-crawl. The apostrophe is DROPPED, never turned into a separator:
 * `bowmans-best` is the spelling the catalog rules and PARENT_BRANDS carries;
 * `bowman-s-best` would match neither and leave the bug wearing a tidier slug.
 */
function unescapeAddslashes(s) {
  return String(s ?? "").replace(/\\(.)/g, "$1");
}

function canonicalSlug(rest) {
  return unescapeAddslashes(rest).replace(/'/g, "");
}

function parseSetUrl(url) {
  const m = SET_URL_RE.exec(String(url || "").split("?")[0].split("#")[0]);
  if (!m) return null;
  const year = Number(m[2]);
  const year2 = m[3] ? Number(m[3]) : null;
  return {
    setId: m[1],
    year,                                   // the FIRST year, always
    year2,
    seasonLabel: year2 == null ? String(year) : `${year}-${m[3]}`,
    // The slug the SITE canonically spells, so the rung reader and the brand
    // walk see the same text the catalog does.
    rest: canonicalSlug(m[4]),
    // What the sitemap actually served, kept so an escaped source stays
    // auditable rather than silently rewritten.
    restRaw: m[4],
    sport: canonicalSport(m[5]),
    sportRaw: m[5],
  };
}

/** The set URL with its slug canonicalised; `set-<id>` untouched. Used for the
 *  live GET so the request carries the spelling the site's own links use. */
function canonicalSetUrl(url) {
  const u = String(url ?? "");
  const m = SET_URL_RE.exec(u.split("?")[0].split("#")[0]);
  if (!m) return u;
  const season = m[3] ? `${m[2]}-${m[3]}` : m[2];
  const base = u.slice(0, u.indexOf(`/set-${m[1]}/`));
  return `${base}/set-${m[1]}/${season}-${canonicalSlug(m[4])}-${m[5]}-trading-card-checklist`;
}

/**
 * A parallel is named by the SLUG, or it is blank. This recognises only rungs
 * the slug states outright; anything unrecognised stays blank, because blank
 * means unknown and a guessed rung is worse than no rung at all.
 *
 * Deliberately NOT a general vocabulary sweep: `-gold-` in
 * `1998-99-topps-golden-greats` is part of a product name, so the match is
 * anchored to the slug TAIL, which is where this site puts a rung.
 */
// LONGEST TAIL FIRST. This list is scanned in order and the FIRST match wins,
// so a compound rung has to be offered before either of its halves. Measured on
// the 76 refused pages of run 33875264485: `-refractors-gold` and
// `-refractors-black` (19 pages between them) matched the bare `-gold$` /
// `-black$` entries below and emitted "Gold"/"Black" -- dropping the Refractor
// from a Gold Refractor, which is a DIFFERENT rung and a different pool.
//
// This site spells the compound rung BOTH ways -- `-gold-refractors` and
// `-refractors-gold` -- and both name the same card, so both map to the one
// label the pool already uses.
/**
 * CF-A-QUALIFIED-REFRACTOR-IS-NOT-A-REFRACTOR (2026-09-05, from Drew's two
 * withheld 1997 Bowman's Best Preview Jeter holdings).
 *
 * The entries below the plates are ordered LONGEST TAIL FIRST for a reason the
 * `-refractors-gold` note already states, and the list was missing the rung
 * this hobby names most often. Measured on the shipped fetcher against the
 * manifest's own 10,359 sportscardchecklist entries:
 *
 *   bowmans-best-atomic-refractors               -> parallel "Refractor"
 *   bowman-bowmans-best-preview-atomic-refractor -> parallel "Refractor"
 *   bowmans-best-mirror-image-atomic-refractors  -> parallel "Refractor"
 *   bowmans-best-jumbo-refractors                -> parallel "Refractor"
 *   bowman-chrome-golden-anniversary-refractors  -> parallel "Refractor"
 *
 * 24 rung pages in all, 21 of them Atomic. Every one fell through to the bare
 * `-refractors?$` entry, which threw the SPECIFIC half of the name away and
 * landed the card on its family rung -- and, worse, moved the discarded word
 * into `subset` ("Atomic"), so the page reads as a subset of the base product
 * rather than a rung of it.
 *
 * THAT IS A SPLIT POOL, AND THE REPO HAS ALREADY RULED ON IT. rematch-classify's
 * V3 genericization rule names this exact pair in its own header -- "Atomic
 * Refractor -> Refractor ... Pooling an Atomic Refractor with a plain Refractor
 * is one card, two rows, a split pool, a wrong FMV" -- and refuses it as a LOSS
 * on 285k stored rows. parallelLadders.ts declares "Atomic Refractor" a rung of
 * its own at /100. The vocabulary was settled everywhere except the one reader
 * that mints the rows, so this file was the last place still disagreeing.
 *
 * These are the qualifiers the SOURCE actually spells on this lane, and nothing
 * more: a vocabulary sweep would guess, and a guessed rung is worse than none
 * (feedback_no_synthetic_parallels_only_actuals). `atomic` is 21 of the 24;
 * `jumbo`, `golden-anniversary` and `inverted` are the remaining three, each
 * measured on a real manifest slug and each a rung the catalog already spells.
 *
 * The BARE entry stays exactly where it is, immediately below. A slug that
 * names no qualifier is still a plain Refractor, and this narrows nothing for
 * it -- which is what the mutation pin proves by deleting these lines and
 * watching the Atomic Refractor rows collapse back onto "Refractor".
 */
const QUALIFIED_REFRACTOR = [
  ["atomic", "Atomic Refractor"],
  ["jumbo", "Jumbo Refractor"],
  ["golden-anniversary", "Golden Anniversary Refractor"],
  ["inverted", "Inverted Refractor"],
];

const SLUG_PARALLEL_TAIL = [
  [/-printing-plates-(black|cyan|magenta|yellow)$/, (m) => `Printing Plate ${m[1][0].toUpperCase()}${m[1].slice(1)}`],
  [/-(?:framed-)?press-plates-(black|cyan|magenta|yellow)$/, (m) => `Printing Plate ${m[1][0].toUpperCase()}${m[1].slice(1)}`],
  // The QUALIFIED rungs, ahead of every bare one. A compound tail has to be
  // offered before either of its halves or the first match wins with the wrong,
  // shorter name -- the same ordering rule the `-refractors-gold` note above
  // was written for, applied to the qualifier that sits on the other side.
  ...QUALIFIED_REFRACTOR.map(([slug, label]) => [
    new RegExp(`-${slug}-refractors?$`), label,
  ]),
  [/-gold-refractors?$/, "Gold Refractor"],
  [/-refractors?-gold$/, "Gold Refractor"],
  [/-black-refractors?$/, "Black Refractor"],
  [/-refractors?-black$/, "Black Refractor"],
  [/-refractors?$/, "Refractor"],
  [/-gold$/, "Gold"],
  [/-silver$/, "Silver"],
  [/-black$/, "Black"],
  [/-blue-foil$/, "Blue Foil"],
  [/-gold-foil$/, "Gold Foil"],
  [/-green-foil$/, "Green Foil"],
  [/-artist-proof$/, "Artist Proof"],
  [/-press-proof$/, "Press Proof"],
];

/**
 * CF-A-PARALLEL-SET-BELONGS-TO-ITS-PARENT (2026-09-04, run 33875264485).
 *
 * This site publishes a product's rungs and inserts as SEPARATE set pages:
 *
 *   /set-151054/2000-01-topps-chrome-aptitude-for-altitude-basketball-...
 *   /set-151055/2000-01-topps-chrome-aptitude-for-altitude-refractors-basketball-...
 *
 * The second is not a product. It is the Refractor rung of the first, and the
 * doctrine is settled: a named parallel is a distinct CARD that belongs to the
 * PARENT product's setKey with `parallel` set -- never a product key of its own
 * (project_normalizesetkey_collapses_products, feedback_one_card_one_row_one_pool).
 *
 * The driver passes `--set-key` derived from the page's DISPLAY NAME, so all 76
 * refused pages carried a key like `topps-chrome-refractors-gold` or
 * `topps-chrome-johnson-reprints-refractors` -- 57 distinct invented products.
 * normalizeSetKey collapses every one of them to `topps-chrome`, which is the
 * catalog agreeing with the doctrine; but the ingest child uses the manifest's
 * setKey VERBATIM when one is given (productOf), so that collapse never runs and
 * 57 phantom products sat one admitted gate away from being minted.
 *
 * So the fetcher states the parent itself, derived from the SAME slug the rung
 * came from, so the two can never disagree.
 */
/**
 * CF-A-RUNG-PAGE-OF-AN-UNLISTED-BRAND-IS-STILL-A-RUNG-PAGE (2026-09-04).
 *
 * The list below is what `parallelOfParent` is derived from, and a page whose
 * brand is absent from it gets NO parent claim -- so the driver's zero-base
 * gate refuses it, because a baseless single-rung page is admissible only on
 * the fetcher's attestation. Measured against the 35 `zero base cards` control
 * docs on main today, every one is a brand this list never named:
 *
 *   Bowman's Best  29 + 4   1999 Bowmans Best Refractors / Atomic Refractors /
 *                            Mirror Image Refractors, 1997-2005
 *   Select          3       Score Select rung pages
 *   Pacific         2       1996 Pacific Prisms Gold, 1997 Pacific Crown
 *                            Collection Silver -- parallel-only pages of the
 *                            products #1766 had just added
 *
 * Re-fetched today, `1996-pacific-prisms-gold` reads `parallel=Gold` and
 * `parentSetKey=(none)`, so `parallelOfParent=false` and the rung has nowhere
 * to land. Not one of these is a cross-join; each is exactly the shape #1741
 * wrote the admission for, on a brand nobody had added yet.
 *
 * THE ENTRIES ARE PRODUCTS THE CATALOG ALREADY SPELLS, so this invents no
 * vocabulary: `bowmans-best`, `pacific-prism`, `pacific-crown-collection` and
 * `score-select` are all declared in productSetKeys.ts with the parents named
 * here, and the pin below asserts every entry against that table so the local
 * list and the product vocabulary cannot drift.
 *
 * LONGEST FIRST is load-bearing and now doubly so: `bowmans-best` must be
 * matched before `bowman`, or a Bowman's Best rung page lands on flagship
 * Bowman -- the same two-products-one-pool collapse #1666 documented.
 */
const PARENT_BRANDS = [
  // Multi-word products first, longest to shortest, so a specific product is
  // never shadowed by the brand its name opens with.
  "pacific-crown-collection", "topps-stadium-club", "bowman-sterling",
  // `pacific-prisms` is the SLUG THE SITE SERVES; `pacific-prism` (singular) is
  // the key productSetKeys rules (see its own note: three authorities agree the
  // singular is correct). Both spellings must MATCH here, and both resolve to
  // the ruled singular below, or a Prisms rung page splits from its own product.
  "pacific-prisms", "pacific-prism", "bowman-chrome", "topps-chrome", "topps-heritage",
  "topps-finest", "topps-traded", "bowmans-best", "score-select",
  "upper-deck", "o-pee-chee",
  "topps", "bowman", "fleer", "donruss", "score", "leaf", "panini", "pacific",
];

/**
 * A brand slug the SITE serves mapped to the key the CATALOG rules, where the
 * two spellings differ. Only productSetKeys may decide this; the entry exists
 * because `pacific-prism` carries `names: ["pacific-prisms"]` there, and the
 * pin asserts the mapping against that table.
 */
const BRAND_CANONICAL = { "pacific-prisms": "pacific-prism" };

/**
 * CF-A-TIFFANY-IS-NOT-A-SUBSET (2026-09-04, follow-on to #1741 and #1719).
 *
 * #1741 ruled that a page whose slug extends a known brand belongs to that
 * brand's product -- correct for `topps-chrome-cards-that-never-were`, which is
 * an INSERT inside Topps Chrome and has no pool of its own. Applied without an
 * exception it also swallows the products this repo has already RULED are their
 * own: measured on main today, re-fetching the URL #1719 shipped from,
 *
 *   set-138544/1990-topps-tiffany-traded-baseball...
 *     -> parentSetKey=topps  subset="Tiffany Traded"
 *
 * writes `setKey: "topps"` over a checklist that shipped as
 * `topps-traded-tiffany`, folding 132 Tiffany cards into flagship Topps. That is
 * the split pool in reverse -- two products, one row -- and #1743 is the record
 * of a recheck re-breaking 1991 Tiffany by exactly this shape.
 *
 * A GLOSS IS A PRINTING, NOT A SUBSET. Topps Tiffany, Bowman Tiffany, Fleer
 * Tiffany and Fleer Glossy each reprint the parent's FULL checklist on coated
 * stock, at the parent's own numbers, and each trades at its own price. They
 * are declared products in src/services/catalog/productSetKeys.ts, so
 * normalizeSetKey returns them unchanged (CF-A-RULED-KEY-IS-A-FIXED-POINT) --
 * and a fetcher that reparents them puts the manifest and the catalog
 * vocabulary into direct disagreement.
 *
 * KEPT AS A LOCAL LIST, DELIBERATELY. This file requires nothing but node
 * builtins so it runs offline against cached HTML and never depends on a stale
 * dist/ (project_bowman_nscc_is_its_own_product). The pin below asserts this
 * list against the real product table, so the two cannot drift silently.
 */
const PRODUCT_TAIL_RE = /(?:^|-)(tiffany|glossy)(?:-|$)/;

/**
 * CF-A-JUNK-WAX-PRODUCT-IS-NOT-A-SUBSET-OF-ITS-BRAND (2026-09-04, IMPROVE gate
 * audit of #1758).
 *
 * The same collapse #1748 fixed for the coated reprints, one era later. Measured
 * on the shipped fetcher, staging the products the ~61k stranded 1990s baseball
 * sales name:
 *
 *   set-12553/1991-score-rookie-and-traded-baseball...
 *     --set-key score-rookie-and-traded  ->  setKey "score", subset "Rookie And Traded"
 *   set-19948/1992-upper-deck-minors-baseball...
 *     --set-key upper-deck-minor-league  ->  setKey "upper-deck", subset "Minors"
 *
 * Both are WRONG in the way that costs a pool. Score Rookie & Traded is a
 * separate 110-card boxed set with its OWN numbering (`58T`, `100T` -- the `T`
 * suffix is the giveaway) that no flagship Score card carries; Upper Deck Minors
 * is a different licence, different players, its own run. Folding either onto
 * the flagship puts two products in one pool at colliding numbers, which is the
 * split pool in reverse -- and BOTH the pool and the catalog already spell them
 * apart: `1991 Score Rookie & Traded Baseball #58T` is how the sales read, and
 * `upper-deck-minors` holds 300/300 baseballcardpedia-backed catalog rows at
 * 1992/1994/1995 (sampled 2026-09-04) while `upper-deck` is the flagship.
 *
 * The `-refractors` / `-cards-that-never-were` rule #1741 wrote is still right
 * for what it was written about: a rung or an insert INSIDE a product, with no
 * pool of its own. It is wrong for a separately-issued product whose slug merely
 * begins with its brand's name, and the brand-prefix test cannot tell the two
 * apart from the slug alone. Only a ruling can, so the ruled ones are named.
 *
 * KEPT AS A LOCAL LIST for the same reason PRODUCT_TAIL_RE is (this file must
 * run offline against cached HTML with no dist/), and pinned against
 * productSetKeys.ts by the same test, so the two cannot drift.
 */
const RULED_PRODUCT_SLUGS = [
  /^score-rookie-(?:and-|&-)?traded(?:-|$)/,
  /^upper-deck-minors?(?:-|$)/,
  /^upper-deck-minor-league(?:-|$)/,
];

/**
 * CF-A-PREVIEW-INSERT-KEEPS-THE-PREVIEWED-PRODUCTS-KEY (2026-09-05).
 *
 * The brand-prefix split reads a slug LEFT TO RIGHT and stops at the first
 * brand it recognises, which is right for `topps-chrome-cards-that-never-were`
 * and wrong for the shape this site uses to publish a preview insert:
 *
 *   bowman-bowmans-best-preview-atomic-refractor
 *     -> parentSetKey `bowman`, subset "Bowmans Best Preview Atomic"
 *
 * The cards were PACKED OUT in 1997 Bowman, so the leading brand is a true
 * statement about where they came from -- and it is not the product they are
 * priced as. THE POOL IS UNAMBIGUOUS. Every "Bowman's Best Preview" sale in
 * sold_comps carries a `BBP<n>` card number, which no flagship Bowman card has,
 * and the resolver already lands them on `bowmans-best` (measured 2026-09-05,
 * COUNT by hobbyiqCardId over the 1996/1997 Preview sales):
 *
 *   hiq:baseball:1997:bowmans-best:bbp2:atomic-refractor:no-auto    17
 *   hiq:baseball:1997:bowmans-best:bbp16:atomic-refractor:no-auto    8
 *   hiq:baseball:1996:bowmans-best:bbp8:atomic-refractor:no-auto    11
 *
 * ...against a smaller stray population the flagship split already produced:
 *
 *   hiq:baseball:1997:bowman:bbp4:atomic-refractor:no-auto          12
 *   hiq:baseball:1996:bowman:bbp30:atomic-refractor:no-auto         17
 *
 * That IS the split pool, live, in both directions: one card, two rows, and the
 * checklist is what settles which is canonical. Minting the checklist at
 * `bowman` would not merely leave the split -- it would put a CHECKLIST-BACKED
 * row on the wrong side of it and make the wrong key the authority.
 *
 * So a slug carrying a nested product name keeps THAT product's key, and the
 * previewed product's own name is the subset. This is the same claim
 * PRODUCT_TAIL_RE makes for a coated reprint, on a product whose name happens
 * to sit in the middle of the slug rather than at its end.
 *
 * NARROW BY CONSTRUCTION. Only a nested name the catalog ALREADY RULES may win,
 * and the pin asserts each against productSetKeys.ts, so this invents no
 * vocabulary and cannot creep: a slug naming no nested product falls straight
 * through to the brand-prefix split, unchanged.
 */
/**
 * SCOPED TO THE HOST BRAND, because the same insert name means a DIFFERENT
 * product behind a different one. Measured on the same 2026-09-05 pool read,
 * the Stadium Club edition of this very insert resolves the other way:
 *
 *   1997-98 Stadium Club ... Bowman's Best Preview Refractor #BBP10
 *     -> hiq:basketball:1997:topps-stadium-club:bbp10:refractor:no-auto
 *
 * Those are basketball and football cards packed out in Topps Stadium Club, and
 * `topps-stadium-club` is the key their pool already carries. A rule keyed on
 * the insert name alone would drag them onto `bowmans-best` -- inventing a
 * baseball product's key for a basketball card and creating exactly the split
 * this fix exists to close, one product over.
 *
 * So the LEADING brand is part of the match: only `bowman-bowmans-best-...`
 * reparents. `topps-stadium-club-bowmans-best-...` falls through to the
 * brand-prefix split and keeps `topps-stadium-club`, which is correct, and the
 * pin below asserts both directions.
 */
const NESTED_PRODUCT_SLUGS = [
  [/^bowman-(bowmans-best)(?:-|$)/, "bowmans-best"],
];

/** The ruled product named INSIDE this slug, and what remains as the subset. */
function nestedProduct(rest) {
  const r = String(rest || "");
  for (const [re, key] of NESTED_PRODUCT_SLUGS) {
    const m = re.exec(r);
    if (!m) continue;
    // Everything after the nested product name is the subset ("Preview"); the
    // brand before it is where the cards were packed out, which the manifest
    // already records in sourceUrl and which is not the pricing identity.
    const tail = r.slice(m.index + m[0].length).replace(/^-+|-+$/g, "");
    const words = tail.split("-").filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
    return { parentSetKey: key, subset: words.join(" ") };
  }
  return null;
}


/** The rung tail this slug matched, or null. Returned separately from the LABEL
 *  so the parent split can strip exactly what was recognised. */
function parallelTailOf(rest) {
  const r = String(rest || "");
  for (const entry of SLUG_PARALLEL_TAIL) if (entry[0].test(r)) return entry[0];
  return null;
}

/**
 * The parent PRODUCT this page's cards belong to, and the SUBSET within it.
 *
 * `2000-01-topps-chrome-aptitude-for-altitude-refractors`
 *   -> parentSetKey `topps-chrome`, subset "Aptitude For Altitude"
 *
 * The brand list is matched LONGEST FIRST (`topps-chrome` before `topps`), so a
 * Chrome page never lands on flagship Topps -- they are different products with
 * different pools, and collapsing them is the exact harm #1666 documented.
 * A slug naming no known brand returns the slug unchanged and NO parent claim,
 * so an unrecognised product is never silently reparented.
 */
function splitParentAndSubset(rest, tailRe) {
  let r = String(rest || "");
  if (tailRe) r = r.replace(tailRe, "");
  // THE RULED PRODUCT WINS OVER THE BRAND SPLIT. A remainder naming a coated
  // reprint (`fleer-tiffany`, `topps-tiffany-traded`, `fleer-update-glossy`) is
  // its OWN product; splitting it would reparent it onto the paper set whose
  // numbers it shares, which is the one collapse this lane must never make.
  if (PRODUCT_TAIL_RE.test(r)) return { parentSetKey: "", subset: "" };
  // A separately-issued product whose slug opens with its brand's name keeps its
  // own key, for the same reason a coated reprint does: the brand-prefix test
  // below would make it a subset of the flagship and merge two pools that share
  // no numbering.
  if (RULED_PRODUCT_SLUGS.some((re) => re.test(r))) return { parentSetKey: "", subset: "" };
  // A RULED PRODUCT NAMED INSIDE THE SLUG WINS OVER THE BRAND IT SITS BEHIND.
  // Checked before the left-to-right brand walk, which would otherwise stop at
  // the packed-out brand and mint the preview onto the flagship's pool.
  const nested = nestedProduct(r);
  if (nested) return nested;
  for (const b of PARENT_BRANDS) {
    if (r === b) return { parentSetKey: BRAND_CANONICAL[b] || b, subset: "" };
    if (r.startsWith(b + "-")) {
      const tail = r.slice(b.length + 1);
      const words = tail.split("-").filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
      return { parentSetKey: BRAND_CANONICAL[b] || b, subset: words.join(" ") };
    }
  }
  return { parentSetKey: "", subset: "" };
}

function parallelFromSlug(rest) {
  const r = String(rest || "");
  for (const [re, label] of SLUG_PARALLEL_TAIL) {
    const m = re.exec(r);
    if (m) return typeof label === "function" ? label(m) : label;
  }
  return "";
}

/**
 * SUBSET TAGS. A trailing token on a card line names the card's SUBSET, not a
 * finish. The abbreviations are this hobby's, measured on the three sampled sets:
 * IA(42) AP(24) DP(47) LL(8) AS(12) CL(18) RB(4) TC(3) UER(7).
 *
 * UER ("uncorrected error") is deliberately ABSENT from the expansion map and
 * from the subset column: it describes a printing mistake on a card that is
 * otherwise the same card, not a different card. Folding it into the category
 * would split the base pool in two.
 */
const SUBSET_TAGS = new Map([
  ["LL", "League Leaders"],
  ["DP", "Double Print"],
  ["AS", "All-Star"],
  ["IA", "In Action"],
  ["AP", "Pro Action"],
  ["RB", "Record Breaker"],
  ["CL", "Checklist"],
  ["TC", "Team Checklist"],
  ["HL", "Highlight"],
  ["SA", "Super Action"],
]);

/** Tags that describe the PRINTING, not the card. Stripped from the player name
 *  and filed nowhere -- see the UER note above. */
const NOISE_TAGS = new Set(["UER", "COR", "ERR"]);

/**
 * Multi-word trailing phrases the source spells out. These are real subsets
 * ("1971 AFC Rushing Leaders", "AFC Semi-Final"), so they are recognised as a
 * TRAILING PHRASE and moved to the category. Anchored to the end and required to
 * begin at a phrase boundary so a player surname is never eaten.
 */
const SUBSET_PHRASE_RE =
  /\s+((?:19|20)\d{2}\s+)?((?:AFC|NFC|AFL|NFL|NBA|NHL|ABA|WHA)\s+)?((?:Rushing|Passing|Receiving|Scoring|Punting|Interception|Kickoff|Assist|Rebound|Goals?|Points?|Penalty)\s+Leaders|League Leaders|Semi-Final|Championship(?: Game)?|Playoffs?|Conference Final|All-Stars?|Record Breakers?|Team Leaders?|In Action|Pro Action|Super Action|Highlights?)\s*$/i;

/**
 * Split one rendered card header into { cardNumber, player, subset }.
 *
 * `raw` is what sits after the `#`: "13 John Riggins", "1 Nat Clifton DP",
 * "1 Floyd Little/Larry Csonka/Marv Hubbard 1971 AFC Rushing Leaders".
 *
 * CARD NUMBER IS VERBATIM -- whatever the source prints up to the first space,
 * so an alphanumeric ("BNR-1", "12a") survives unchanged. No normalisation, no
 * zero-stripping: the number IS part of card identity.
 */
function splitCardHeader(raw) {
  const text = unescapeCell(raw);
  const m = /^(\S+)\s+([\s\S]*)$/.exec(text);
  if (!m) return null;
  const cardNumber = m[1];
  let rest = m[2].trim();
  if (!rest) return null;

  let subset = "";

  // A spelled-out trailing phrase wins over a bare abbreviation, because it is
  // longer and unambiguous.
  const p = SUBSET_PHRASE_RE.exec(rest);
  if (p) {
    subset = rest.slice(p.index).trim().replace(/\s+/g, " ");
    rest = rest.slice(0, p.index).trim();
  } else {
    // Bare abbreviation, and only as the LAST token: "AS" mid-name is a name.
    const t = /\s([A-Z]{2,3})$/.exec(rest);
    if (t) {
      const tag = t[1];
      if (SUBSET_TAGS.has(tag)) { subset = SUBSET_TAGS.get(tag); rest = rest.slice(0, t.index).trim(); }
      else if (NOISE_TAGS.has(tag)) { rest = rest.slice(0, t.index).trim(); }
    }
  }

  // A second trailing noise tag ("... UER DP") -- strip once more.
  const t2 = /\s([A-Z]{2,3})$/.exec(rest);
  if (t2 && NOISE_TAGS.has(t2[1])) rest = rest.slice(0, t2.index).trim();

  return { cardNumber, player: rest.replace(/\s+/g, " ").trim(), subset };
}

/**
 * CF-ZERO-ROWS-MUST-NAME-WHY (2026-09-04, run 33902098944).
 *
 * The vintage/1990s walker aborted after three consecutive
 *
 *   "!! 0 rows — refusing to write an empty checklist"   (exit 9)
 *
 * on set-20411, set-29386 and set-20412 (1993-94 Topps Finest base, Main
 * Attractions and Refractors), stranding 1,246 entries of the era.
 *
 * PROBED DIRECTLY (2026-09-04, polite fetch, HobbyIQ UA):
 *
 *   set-20411  HTTP 200  1,148,623 bytes  220 <h5> headers  220 hidden inputs
 *   set-29386  HTTP 200    180,371 bytes   27 <h5> headers   27 hidden inputs
 *   set-20412  HTTP 200  1,010,228 bytes  220 <h5> headers  220 hidden inputs
 *
 * All three parse to a FULL checklist through the existing H5_RE, with zero
 * skipped rows and both anchors agreeing. Twenty more entries spread across
 * 1990-1999 were probed the same way: 20/20 served 200 with a populated header
 * list and 20/20 parsed. THERE IS NO SECOND LAYOUT on this lane and no empty
 * set page at the source -- the era's markup is uniform.
 *
 * So the zero-row run was TRANSIENT: the source served a short or partial body
 * to a walker running concurrency=16, whose politeness delay is per-process and
 * therefore not a rate limit at all. What is NOT transient is that the fetcher
 * refused with one sentence for every possible cause, so the driver could not
 * tell a degraded response from a layout we cannot read from a set the source
 * genuinely does not card. "0 rows" is an observation, never a diagnosis, and a
 * lane that cannot name the cause classifies all three the same way -- which is
 * how three transient bodies took an era down.
 *
 * Named on the same terms hobbymonitor's zeroCardReason uses, so the driver
 * classifies on the fetcher's own words:
 *
 *   CHALLENGE      no checklist scaffolding at all: an interstitial, an error
 *      body or a truncated response served with a 200. The host is not serving
 *      us; terminal for the entry, and a STREAK of them is the lane being
 *      blocked, which is exactly when the tripwire should fire.
 *   EMPTY AT SOURCE the page IS a set page -- it has the card-list scaffolding
 *      -- and carries no card rows. A verdict about the set, not our pipe.
 *   UNKNOWN LAYOUT  headers are present but none parsed, or the anchors
 *      disagree. OUR parser, and it stays a lane fault so someone comes back.
 */
/**
 * The host's own not-found marker. It renders the phrase in the <title>, in two
 * meta tags and in the page body, so any one of them is enough; the alternation
 * is anchored to the phrase rather than to a layout that may be restyled.
 */
/**
 * CF-A-STALE-STAGED-FILE-MUST-NOT-OUTLIVE-ITS-CONVERTER (2026-09-06).
 *
 * A staged CSV WINS over a live fetch (CF-A-STAGED-FILE-WINS), which is right
 * while the converter that wrote it is the converter we still believe in. It is
 * wrong the moment a converter defect is fixed: the entry keeps re-ingesting the
 * hollow file the broken converter produced, the verdict never moves, and the
 * only way back is an operator remembering MODE=refetch by hand -- for entries
 * nobody has yet identified as stale.
 *
 * That is exactly how the 1956 Topps recheck could have looked like a source
 * problem forever. So every manifest this fetcher writes STAMPS the converter
 * version, and the driver refuses to let a staged file whose stamp is older
 * than the current one win. Bump this whenever a change alters the ROWS this
 * converter emits or the verdict it reaches -- the stamp is a claim about
 * output, not a build number.
 *
 * WHAT COUNTS AS "THIS CONVERTER". The staged CSV is produced by THIS file, but
 * what a re-ingest of that CSV actually LANDS is decided downstream by
 * ingest-checklist-csv-to-catalog.cjs and the clash/merge rules it reads from
 * lib/subset-identity.cjs. A change to either of those changes the ROWS a stale
 * verdict was recorded against just as surely as a change to the parser does,
 * so THE VERSION COVERS THE WHOLE PIPE, not this file alone.
 *
 * That is not a theoretical scope note. v2 was stamped for two defects in this
 * file, and the very next writer fix (#1878) left every stale verdict closed
 * because nothing here had changed -- a pending-only walk for 1957 baseball
 * reported "nothing intended" against entries the fix was written to re-open.
 * The stamp existed precisely to prevent that and did not, because its scope
 * was drawn around one file instead of one OUTPUT.
 *
 * BUMP THIS WHENEVER any of these change what a re-ingest produces:
 *   - this file's parsing, slug canonicalisation, or zero-row verdicts
 *   - ingest-checklist-csv-to-catalog.cjs's clash / merge / write rules
 *   - lib/subset-identity.cjs's claim and rung-key rules
 * The pin in tests/sccConverterVersionCoversTheWholePipe.test.ts hashes the
 * functions that decide those things and fails when they move without a bump,
 * so this comment cannot quietly become untrue.
 *
 * 1  original vintage lane
 * 2  2026-09-06: the addslashes URL leak (#1848) and the "Checklist Not Found"
 *    page no longer reported as an empty set (#1875).
 * 3  2026-09-06: "Base Set" is a page heading, not a subset (#1878) -- the
 *    writer's clash test now compares CLAIMS, so 407 checklist rows per product
 *    that were refused against themselves now land. Stale `partial` verdicts
 *    recorded under the old rule have to be re-attempted, which is what this
 *    bump is for.
 * 4  2026-09-06: "Inserts" is a page heading, not a subset name (#1894) -- the
 *    same fold as v3, one heading over. Eight 1998/1999 SP Authentic insert
 *    pages were refused ENTIRELY (read 42, wrote 0, REFUSED 42) against 56 +
 *    130 baseballcardpedia rows tagged with the literal section word
 *    "Inserts". Those verdicts were recorded under v3 and must re-open.
 * 5  2026-09-06: the soft-block work (#1898), landing alongside the "Inserts"
 *    fold that took v4 (#1899). An empty response is retried at 60s and 180s
 *    before any verdict, and a challenge/rate-limit page is named as one rather
 *    than reported as "did not serve a set page" -- so an entry a rate limit
 *    closed as `unreachable` reaches a different verdict on a re-walk. The URL
 *    reader also admits the `non-sport` vertical. Both change what a re-attempt
 *    PRODUCES, which is the test this version answers.
 */
const CONVERTER_VERSION = 5;

const NOT_FOUND_RE = /Checklist Not Found|NOT FOUND\s*-\s*https?:\/\//i;

function zeroCardReason(html, stats) {
  const h = String(html || "");
  const st = stats || {};

  // A set page always carries the card-list scaffolding: the per-card eBay
  // search inputs and the <h5> headers. Neither present means we were not
  // served a set page at all. Checked FIRST -- everything below assumes the
  // page is really ours.
  if (!st.headers && !st.hiddenRows) {
    // CF-A-SOFT-BLOCK-IS-NOT-A-DEAD-ID. The marker set lives in
    // lib/scc-block-detect.cjs and is paired with "no checklist found", never
    // used alone: this host's ORDINARY healthy pages carry Cloudflare strings
    // (18 matches on the live 200-header 2000-01 Topps Chrome page), so a bare
    // CDN test would declare every good page a challenge.
    const sig = challengeSignal(h, false);
    if (sig) {
      return `no checklist on the page — the host served a challenge/rate-limit page with HTTP 200 ` +
        `(${h.length} bytes, title=${sig.title ? JSON.stringify(sig.title.slice(0, 60)) : "(none)"}, marker=${JSON.stringify(sig.marker)})`;
    }
    // A real set page is ~100 KB at its smallest (the 10-card sets measured
    // 100,316 bytes). A body far under that carrying no scaffolding is a
    // truncated or error response, not a set with nothing in it.
    if (h.length < 40000 || !/set-\d+|trading-card-checklist/i.test(h)) {
      // THE LOG NAMES WHAT ARRIVED. The run that lost three live entries could
      // not tell a truncation from a block from a dead id out of its own
      // output; the title and byte count are what make that answerable.
      return `no checklist on the page — the host did not serve a set page with HTTP 200 (${describeResponse(h)})`;
    }
    // CF-A-404-IN-A-200-IS-NOT-AN-EMPTY-SET (2026-09-06, from the 1956 Topps
    // baseball recheck, runs 34025742030 / 34025851336).
    //
    // This host serves its NOT-FOUND page with HTTP 200 and a `<title>` of
    // "Checklist Not Found", echoing the requested URL in the body:
    //
    //   NOT FOUND - https://www.sportscardchecklist.com/set-11611/1956-topps-...
    //
    // Both guards above wave it through. It is 56,371 bytes, comfortably over
    // the 40 KB floor, and the echoed URL makes `/trading-card-checklist/`
    // match -- so a page that says "this set does not exist" fell to the branch
    // below and was reported as "the source lists this set and carries no cards
    // for it". The driver reads that as `emptyAtSource`, and `empty` is
    // TERMINAL: the entry is closed against a claim the source never made.
    //
    // MEASURED, crawl_state, lane sportscardchecklist, 2026-09-06: all 16
    // `empty` verdicts carry a 56-62 KB body in their reason string -- 16 of 16
    // are this page, not one is a real empty set. They span basketball 1990s
    // (6), baseball 1990s (6), baseball 1970s (2), 1980s (1) and 1950s (1).
    //
    // WHY THE SET IS MISSING AT ALL: the server keys on `set-<id>` and ignores
    // the slug entirely (probed today -- set-11608 serves 1955 Topps, set-11614
    // serves 1957, and set-11611 between them serves the not-found page). The
    // sitemap advertised an id the site itself does not card. That is a real
    // gap in the SOURCE, and it deserves its own verdict -- `unreachable`,
    // which is terminal but recheckable -- rather than a false statement that
    // the set exists and is empty.
    //
    // THE VINTAGE PAGE SHAPE IS FINE, and this is the other half of the
    // finding: 1952, 1953, 1954 and 1957 Topps baseball all serve the SAME
    // H5-header + hidden-input layout the 1990s pages use, and the converter
    // parses them whole (1957: 417 headers, 417 hidden rows, 417 rows, Ted
    // Williams at #1, 21 Double Print subsets). There is no second layout to
    // teach it; there was a dead id being read as an empty set.
    if (NOT_FOUND_RE.test(h)) {
      return `the host served its "Checklist Not Found" page with HTTP 200 — this set id is not carded at the source (${h.length} bytes)`;
    }
    // Scaffolding absent on a page that IS ours: the source lists this set and
    // carries no cards for it. A verdict about the set -- nothing new to add.
    return `the set page carries no cards at the source — nothing new to add (${h.length} bytes)`;
  }

  // Scaffolding IS there. Anything that got this far is our reader.
  if (st.anchorMismatch) {
    return `0 rows — ${st.headers} card headers and ${st.hiddenRows} hidden rows disagree; layout not understood`;
  }
  return `0 rows — ${st.headers} card headers are on the page but none parsed; layout not understood`;
}

/** Every card header on the page, in document order. */
const H5_RE = /<h5[^>]*>[\s\S]*?<\/a>\s*#([^<]*)<\/h5>/g;
const HIDDEN_RE = /name="ebay_search"[^>]*value="([^"]*)"/g;

function extractCardHeaders(html) {
  const out = [];
  let m;
  H5_RE.lastIndex = 0;
  while ((m = H5_RE.exec(html)) !== null) out.push(m[1]);
  return out;
}

function countHiddenRows(html) {
  let n = 0;
  HIDDEN_RE.lastIndex = 0;
  while (HIDDEN_RE.exec(html) !== null) n++;
  return n;
}

/** Autograph evidence, and nothing else. A badge the page renders, or the set
 *  name saying so. Never inferred from an era or a card number. */
function autoEvidence(html, setName) {
  if (/\bautograph/i.test(String(setName || ""))) return true;
  return /class="badge[^"]*"[^>]*>\s*(?:AU|AUTO)\s*<\/div>/i.test(html);
}

/**
 * Build the canonical rows for one set page.
 *
 * Returns { rows, stats }. Exported for the tests -- the fixtures assert exact
 * counts, first/last card and subset tags on all three sampled sets.
 */
function buildRows(html, opts) {
  const o = opts || {};
  const parallel = o.parallel || "";
  const isAuto = o.isAuto === true;
  const headers = extractCardHeaders(html);
  const hiddenCount = countHiddenRows(html);

  const rows = [];
  const stats = {
    headers: headers.length,
    hiddenRows: hiddenCount,
    anchorMismatch: headers.length !== hiddenCount,
    parsed: 0,
    skipped: 0,
    withSubset: 0,
    subsets: new Map(),
  };

  for (const raw of headers) {
    const c = splitCardHeader(raw);
    if (!c || !c.cardNumber || !c.player) { stats.skipped++; continue; }
    stats.parsed++;
    const category = c.subset ? `insert-${slugify(c.subset)}` : "base";
    if (c.subset) {
      stats.withSubset++;
      stats.subsets.set(c.subset, (stats.subsets.get(c.subset) || 0) + 1);
    }
    rows.push({
      category,
      cardNumber: c.cardNumber,
      parallel,                 // blank unless the slug named one
      isAuto: isAuto ? "true" : "false",
      printRun: "",             // the page states none; blank means unknown
      player: c.player,
      parallelNote: "",
      rarity: "",
      subset: c.subset,
    });
  }
  return { rows, stats };
}

const HEADER = "category,cardNumber,parallel,isAuto,printRun,player,parallelNote,rarity";

function toCsv(rows) {
  const body = rows.map((r) => [r.category, r.cardNumber, r.parallel, r.isAuto,
    r.printRun, r.player, r.parallelNote, r.rarity].map(csvCell).join(",")).join("\n");
  return `${HEADER}\n${body}\n`;
}

async function main() {
  const url = val("--url", "");
  const htmlFile = val("--html", "");
  const out = val("--out", "");
  if (!url && !htmlFile) {
    console.error("usage: fetchSportsCardChecklist.cjs --url <set url> --out <csv> [--year --set-key --set-name --sport]");
    console.error("       (--html <file> parses a cached page offline)");
    process.exit(2);
  }
  if (url && !url.includes(HOST)) {
    console.error(`refusing: --url is not ${HOST} (${url})`);
    process.exit(2);
  }

  const parsedUrl = url ? parseSetUrl(url) : null;
  if (url && !parsedUrl) {
    // Loud, because a slug this cannot read is exactly the split-year false
    // negative the survey recorded -- silence would look like an absent source.
    console.error(`refusing: --url is not a /set-<id>/<slug> checklist page: ${url}`);
    process.exit(2);
  }

  // FETCH THE CANONICAL SPELLING. The manifest may still carry the source's
  // addslashes escape in this URL; the server tolerates it, but requesting the
  // canonical form keeps the request, the parse and the manifest in agreement.
  const fetchUrl = url ? canonicalSetUrl(url) : "";
  /**
   * FETCH, THEN GIVE THE HOST A SECOND AND A THIRD CHANCE BEFORE JUDGING IT.
   *
   * A response with no card scaffolding is ambiguous at the moment it arrives:
   * it is a dead id, a truncation, or the host asking us to slow down. The old
   * code resolved that ambiguity immediately and always the same way, which is
   * how a rate limit closed live entries as `unreachable`.
   *
   * A soft block lifts on a minute scale. A dead id never lifts. So an empty
   * response is RETRIED after 60s and 180s before any verdict is reached: a
   * blocked page comes back, a dead id costs two waits once and is then
   * correctly closed. `--html` (offline) skips all of it.
   */
  let html;
  if (htmlFile) {
    html = fs.readFileSync(htmlFile, "utf8");
  } else {
    // The politeness delay, actually spent -- see the note on PAGE_DELAY_MIN_MS.
    const firstWait = jitteredPageDelay();
    if (firstWait) await sleep(firstWait);
    html = await get(fetchUrl);
    for (let i = 0; i < RETRY_WAITS_MS.length; i++) {
      const looksEmpty = extractCardHeaders(html).length === 0 && countHiddenRows(html) === 0;
      // A "Checklist Not Found" page is a definite answer, not a symptom.
      // Retrying it would spend four minutes relearning what the host already
      // told us plainly.
      if (!looksEmpty || NOT_FOUND_RE.test(html)) break;
      const sig = challengeSignal(html, false);
      console.log(`  no checklist on attempt ${i + 1} — ${describeResponse(html)}` +
        `${sig ? ` challenge=${JSON.stringify(sig.marker)}` : " challenge=(none detected)"}` +
        `; waiting ${Math.round(RETRY_WAITS_MS[i] / 1000)}s and retrying`);
      await sleep(RETRY_WAITS_MS[i]);
      html = await get(fetchUrl);
    }
  }

  // Sport is an INPUT: the slug states it, and --sport overrides for a driver
  // entry that already knows. Never guessed from the set name.
  const sport = val("--sport", "") || (parsedUrl ? parsedUrl.sport : "");
  const year = Number(val("--year", "")) || (parsedUrl ? parsedUrl.year : null);
  const setKey = val("--set-key", "");
  const setName = val("--set-name", "");
  const parallel = parsedUrl ? parallelFromSlug(parsedUrl.rest) : "";
  // CF-A-PARALLEL-SET-BELONGS-TO-ITS-PARENT. The rung and the parent product
  // come from the SAME slug, so they cannot disagree. `--set-key` from the
  // driver is the DISPLAY-NAME slug and is not trusted on a rung page: it is
  // the invented `topps-chrome-refractors-gold` shape this fix exists to stop.
  const parentSplit = parsedUrl
    ? splitParentAndSubset(parsedUrl.rest, parallelTailOf(parsedUrl.rest))
    : { parentSetKey: "", subset: "" };
  const isAuto = autoEvidence(html, setName || (parsedUrl ? parsedUrl.rest : ""));

  const { rows, stats } = buildRows(html, { parallel, isAuto });

  console.log(url || htmlFile);
  console.log(`  season=${parsedUrl ? parsedUrl.seasonLabel : "?"} year=${year} sport=${sport}` +
    `  parallel=${parallel || "(blank)"} isAuto=${isAuto}`);
  // THE BANNER PROVES THE BINDING. A rung page landing on its own key is the
  // defect this fix is about, and printing the key that will be written is the
  // only way to see it before the ingest runs.
  console.log(`  parentSetKey=${parentSplit.parentSetKey || "(none)"} subset=${parentSplit.subset || "(none)"}` +
    `  parallelOfParent=${Boolean(parallel && parentSplit.parentSetKey)}`);
  console.log(`  card headers=${stats.headers} hidden ebay_search rows=${stats.hiddenRows}` +
    (stats.anchorMismatch ? "  !! ANCHOR MISMATCH — page shape changed" : "  (anchors agree)"));
  console.log(`  rows=${rows.length} parsed=${stats.parsed} skipped=${stats.skipped} withSubset=${stats.withSubset}`);
  if (stats.subsets.size) {
    console.log(`  subsets: ${[...stats.subsets.entries()].map((e) => `${e[0]}=${e[1]}`).join(" | ")}`);
  }
  if (!rows.length) {
    // THE REFUSAL NAMES ITS CAUSE. Same exit code, but the sentence is what the
    // driver classifies on -- see CF-ZERO-ROWS-MUST-NAME-WHY above.
    console.error(`  !! ${zeroCardReason(html, stats)}`);
    process.exit(9);
  }
  if (!rows.some((r) => r.category === "base")) {
    console.log("  !! NO BASE CATEGORY — the driver's zero-base gate will refuse this set.");
  }

  if (!out) { console.log(toCsv(rows)); return; }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, toCsv(rows));
  console.log(`  wrote ${out}`);

  if (!year || !setKey) {
    console.log("  NOTE: --year and --set-key required for a manifest; CSV written without one.");
  } else {
    // THE PARENT IS THE PRODUCT FOR BOTH SHAPES. A rung page ("...Refractors")
    // and an INSERT page ("...Cards That Never Were") are both pages of cards
    // belonging to the flagship product; they differ only in whether the slug
    // named a finish. So both land on the parent's setKey -- the rung with
    // `parallel` set, the insert with `parallel` BLANK and the insert name
    // carried as the subset. `topps-chrome-cards-that-never-were` as a product
    // key is the same phantom `topps-chrome-refractors-gold` is, and
    // normalizeSetKey collapses it to `topps-chrome` for the same reason.
    //
    // The parent claim only exists when the slug named a KNOWN brand, so an
    // unrecognised product keeps the key the driver derived and is never
    // silently reparented.
    const effectiveSetKey = parentSplit.parentSetKey || setKey;
    const mPath = out.replace(/[.]csv$/, "") + ".manifest.json";
    fs.writeFileSync(mPath, JSON.stringify({
      scrapedAt: new Date().toISOString(),
      source: "sportscardchecklist",
      sourceUrl: url || `file:${path.basename(htmlFile)}`,
      sport,
      year,
      // The season as the source spells it ("1979-80"), kept beside the numeric
      // year so a split season is auditable and never re-derived by guess.
      season: parsedUrl ? parsedUrl.seasonLabel : String(year),
      setName: setName || setKey,
      // THE PARENT KEY WINS ON A RUNG PAGE. `setKey` here is what the ingest
      // child writes VERBATIM (productOf), so a rung page must state the parent
      // product or it mints a phantom one. A page that is not a rung keeps the
      // key it was given, so this narrows nothing for base and insert pages.
      productKey: `${year}-${effectiveSetKey}`,
      setKey: effectiveSetKey,
      // The key as the driver derived it, kept so a wrong parent split is
      // auditable rather than silently overwritten.
      setKeyRequested: setKey,
      // Read by the driver gate: a file whose every row carries ONE rung is
      // admissible ONLY because this says the page IS that rung of a parent,
      // not a ladder with nothing to attach to. Drop the flag and the
      // zero-base refusal stands -- which is what the mutation test pins.
      parallelOfParent: Boolean(parallel && parentSplit.parentSetKey),
      parallelName: parallel || null,
      subset: parentSplit.subset || null,
      rowCount: rows.length,
      // The rung is in the parallel column already (from the slug) or blank.
      // Without this the ingest re-derives a label from the category slug and
      // turns "insert-league-leaders" into a PARALLEL named "League Leaders" --
      // a subset minted as a finish, which is the exact split this lane avoids.
      parallelColumnAuthoritative: true,
      // Read by the driver: a staged file written by an OLDER converter no
      // longer wins over a live fetch. See CF-A-STALE-STAGED-FILE-MUST-NOT-
      // OUTLIVE-ITS-CONVERTER.
      converterVersion: CONVERTER_VERSION,
      cardRows: rows.length,
      ladderRows: 0,
      subsetRows: stats.withSubset,
      printRunsFound: 0,
      sectionsReport: [...stats.subsets.entries()].map((e) => ({
        breadcrumb: `Checklist > ${e[0]}`,
        category: `insert-${slugify(e[0])}`,
        playerCount: e[1],
        rungs: 0,
        rowCount: e[1],
        refused: false,
        printRun: null,
      })),
    }, null, 1));
    console.log(`  wrote ${mPath}`);
  }

  // A ladder sidecar only when this set IS a rung -- these pages publish one
  // parallel per set URL rather than a ladder per card, so the sidecar records
  // which rung this file is, not an invented list.
  if (parallel) {
    const side = out.replace(/\.csv$/, "") + ".parallels.json";
    fs.writeFileSync(side, JSON.stringify({
      sourceUrl: url || null,
      note: "This set page IS one rung; the parallel is named by the slug tail.",
      groups: [{ cardSet: setName || setKey, cardType: "base", parallels: [{ name: parallel, printRun: null, isOneOfOne: false, odds: null }] }],
    }, null, 1));
    console.log(`  wrote ${side}`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
}

module.exports = {
  zeroCardReason, parseSetUrl, parallelFromSlug, parallelTailOf, splitParentAndSubset, splitCardHeader, buildRows, toCsv,
  extractCardHeaders, countHiddenRows, autoEvidence, unescapeCell,
  SUBSET_TAGS, NOISE_TAGS, HEADER, SET_URL_RE, NOT_FOUND_RE, CONVERTER_VERSION,
  unescapeAddslashes, canonicalSlug, canonicalSetUrl,
  QUALIFIED_REFRACTOR, NESTED_PRODUCT_SLUGS, nestedProduct, SLUG_PARALLEL_TAIL, PARENT_BRANDS,
};
