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
const SET_URL_RE =
  /\/set-(\d+)\/(\d{4})(?:-(\d{2}))?-(.+?)-(football|basketball|hockey|baseball)-trading-card-checklist\/?$/;

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
    rest: m[4],
    sport: m[5],
  };
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
const SLUG_PARALLEL_TAIL = [
  [/-printing-plates-(black|cyan|magenta|yellow)$/, (m) => `Printing Plate ${m[1][0].toUpperCase()}${m[1].slice(1)}`],
  [/-(?:framed-)?press-plates-(black|cyan|magenta|yellow)$/, (m) => `Printing Plate ${m[1][0].toUpperCase()}${m[1].slice(1)}`],
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
const PARENT_BRANDS = [
  "topps-chrome", "bowman-chrome", "bowman-sterling", "topps-finest",
  "topps-heritage", "topps-traded", "topps-stadium-club", "upper-deck",
  "o-pee-chee", "topps", "bowman", "fleer", "donruss", "score", "leaf", "panini",
];

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
  for (const b of PARENT_BRANDS) {
    if (r === b) return { parentSetKey: b, subset: "" };
    if (r.startsWith(b + "-")) {
      const tail = r.slice(b.length + 1);
      const words = tail.split("-").filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
      return { parentSetKey: b, subset: words.join(" ") };
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
function zeroCardReason(html, stats) {
  const h = String(html || "");
  const st = stats || {};

  // A set page always carries the card-list scaffolding: the per-card eBay
  // search inputs and the <h5> headers. Neither present means we were not
  // served a set page at all. Checked FIRST -- everything below assumes the
  // page is really ours.
  if (!st.headers && !st.hiddenRows) {
    const challenged = /cf-browser-verification|cf_chl|__cf_bm|Just a moment|Attention Required|Checking your browser|Access denied|Please enable (?:JS|JavaScript)/i.test(h);
    if (challenged) {
      return `no checklist on the page — the host served a challenge/interstitial page with HTTP 200 (${h.length} bytes)`;
    }
    // A real set page is ~100 KB at its smallest (the 10-card sets measured
    // 100,316 bytes). A body far under that carrying no scaffolding is a
    // truncated or error response, not a set with nothing in it.
    if (h.length < 40000 || !/set-\d+|trading-card-checklist/i.test(h)) {
      return `no checklist on the page — the host did not serve a set page with HTTP 200 (${h.length} bytes)`;
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

  const html = htmlFile ? fs.readFileSync(htmlFile, "utf8") : await get(url);

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
  SUBSET_TAGS, NOISE_TAGS, HEADER, SET_URL_RE,
};
