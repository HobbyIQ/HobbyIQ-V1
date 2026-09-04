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
const SLUG_PARALLEL_TAIL = [
  [/-refractors?$/, "Refractor"],
  [/-gold-refractors?$/, "Gold Refractor"],
  [/-printing-plates-(black|cyan|magenta|yellow)$/, (m) => `Printing Plate ${m[1][0].toUpperCase()}${m[1].slice(1)}`],
  [/-gold$/, "Gold"],
  [/-silver$/, "Silver"],
  [/-black$/, "Black"],
  [/-blue-foil$/, "Blue Foil"],
  [/-gold-foil$/, "Gold Foil"],
  [/-green-foil$/, "Green Foil"],
  [/-artist-proof$/, "Artist Proof"],
  [/-press-proof$/, "Press Proof"],
];

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
  const isAuto = autoEvidence(html, setName || (parsedUrl ? parsedUrl.rest : ""));

  const { rows, stats } = buildRows(html, { parallel, isAuto });

  console.log(url || htmlFile);
  console.log(`  season=${parsedUrl ? parsedUrl.seasonLabel : "?"} year=${year} sport=${sport}` +
    `  parallel=${parallel || "(blank)"} isAuto=${isAuto}`);
  console.log(`  card headers=${stats.headers} hidden ebay_search rows=${stats.hiddenRows}` +
    (stats.anchorMismatch ? "  !! ANCHOR MISMATCH — page shape changed" : "  (anchors agree)"));
  console.log(`  rows=${rows.length} parsed=${stats.parsed} skipped=${stats.skipped} withSubset=${stats.withSubset}`);
  if (stats.subsets.size) {
    console.log(`  subsets: ${[...stats.subsets.entries()].map((e) => `${e[0]}=${e[1]}`).join(" | ")}`);
  }
  if (!rows.length) {
    console.error("  !! 0 rows — refusing to write an empty checklist");
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
      productKey: `${year}-${setKey}`,
      setKey,
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
  parseSetUrl, parallelFromSlug, splitCardHeader, buildRows, toCsv,
  extractCardHeaders, countHiddenRows, autoEvidence, unescapeCell,
  SUBSET_TAGS, NOISE_TAGS, HEADER, SET_URL_RE,
};
