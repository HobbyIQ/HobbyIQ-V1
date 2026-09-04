#!/usr/bin/env node
/**
 * CF-THE-LADDER-WAS-ON-THE-PAGE-ALL-ALONG (Drew, 2026-08-28: "do it and go
 * find it with what we have").
 *
 * baseballcardpedia is alive, and its flagship set pages carry the parallel
 * ladder the catalog is missing for 2016-2024 -- the years where 30k-row
 * spellings like tinsel and holo-foil have no checklist rung to resolve to.
 * The original scraper SKIPPED parallel sections on purpose ("they're
 * metadata"), which is how the ladders became per-card prose blobs instead of
 * rungs. This scraper reads ONLY what that one skipped.
 *
 * PAGE SHAPE (Vector-skin MediaWiki), measured on 2023_Topps:
 *
 *   <h2 id="Base_Set">   ... <li>1 Juan Soto</li> ...
 *   <h2 id="Parallels">
 *     <li>Royal Blue (Series One: 7025 copies)</li>     <- list rungs
 *     <h3 id="Golden_Mirror_Image">                     <- named-rung sections
 *   <h2 id="Inserts">                                   <- STOP. Insert
 *       parallels belong to their own insert's numbering; folding them into
 *       the base ladder is how Class Encounters #4 once overwrote Fleer #4.
 *
 * WHAT A RUNG IS NOT. The Parallels section also contains CARD LISTS (an SSP
 * variation lists its cards inline) and prose. A candidate is rejected when it
 * looks like a card line (starts with a card number), when it is longer than
 * 60 chars (prose), or when a heading is an umbrella ("... Parallels",
 * "... Factory Set") rather than a name.
 *
 * EXPANSION, the #1301 shape: rung x base cards -> canonical CSV rows. Base
 * rows are emitted with the literal "Base" -- these ARE the checklist's base
 * set, which is the one place "Base" is a statement of fact rather than a
 * default for a blank (see #1324 for the difference).
 *
 * STAGING ONLY. Emits canonical CSV + manifest per product; the ingest is a
 * separate, authority-checked step. Nothing here touches Cosmos.
 *
 * Args:
 *   --years=2016-2026         inclusive range
 *   --outDir=/tmp/bcp-ladders
 *   --delayMs=800             deliberately unhurried; this is a fan-run wiki
 *   --titles=A,B              explicit page titles instead of the template set
 *   --sport=baseball          the sport every emitted row carries
 *
 * CF-THE-SPORT-IS-AN-INPUT-NOT-A-CONSTANT (2026-08-31). The site is
 * baseballcardpedia, so `sport` was written as the literal "baseball" in the
 * two places it is emitted -- the product key that names each staged file
 * (`${year}-${setKey}-baseball`) and the manifest's own `sport` field. That
 * held only as long as every page fetched was a baseball page, and --titles
 * takes ARBITRARY page titles: the wiki carries football and basketball sets
 * too, and a run dispatched with BCP_TITLES pointing at one minted its rows
 * as baseball, into a baseball product key, with a manifest that said so.
 * Nothing downstream could tell the difference -- the sport was not wrong in a
 * field the ingest checks, it was wrong in the IDENTITY.
 *
 * So sport is a parameter, threaded from the acquisition inputs and stated
 * explicitly at both emission sites. The default stays baseball, because that
 * is what the source is; what changes is that a non-baseball scrape can now
 * SAY so, and the value it says is the one that reaches disk.
 */
const fs = require("node:fs");
const path = require("node:path");

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const YEARS = String(arg("years", "2016-2026"));
const OUT_DIR = arg("outDir", "C:/tmp/bcp-ladders");
const DELAY_MS = Number(arg("delayMs", "800"));
const TITLES = arg("titles", "");
// The sport every emitted row carries. A parameter, not a constant: see
// CF-THE-SPORT-IS-AN-INPUT-NOT-A-CONSTANT above. Normalized here so the value
// that reaches the product key and the manifest is the same one.
const normalizeSport = (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const SPORT = normalizeSport(arg("sport", "baseball")) || "baseball";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (n) => Number(n).toLocaleString();
const detag = (s) => String(s).replace(/<[^>]+>/g, " ")
  .replace(/&#8217;|&rsquo;|&#039;/g, "'").replace(/&amp;/g, "&")
  .replace(/&nbsp;|\u00a0/g, " ").replace(/&#8211;|&ndash;/g, "-").replace(/&quot;/g, '"')
  .replace(/\s+/g, " ").trim();
const csvEsc = (s) => { const v = String(s ?? ""); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };

async function get(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(45000) });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) { console.log(`   HTTP ${res.status} ${url.slice(0, 80)}`); return null; }
    return await res.text();
  } catch (e) {
    if (attempt < 3) { await sleep(3000 * (attempt + 1)); return get(url, attempt + 1); }
    console.log(`   fetch failed ${url.slice(0, 70)}: ${String(e.message).slice(0, 40)}`);
    return null;
  }
}

/**
 * Slice the body between a heading id and the next heading of the same-or-higher level.
 *
 * CF-THE-FOOTER-IS-NOT-THE-LAST-SECTION (2026-08-31). The LAST section of a
 * page has no following heading, so `$` ran the slice to end-of-document and
 * swallowed the MediaWiki chrome -- including the category footer, which is a
 * <ul> of <li> links. On 1993_Finest that put `<li>Topps</li>` and
 * `<li>1993</li>` inside the "Refractors" scope; "1993" was refused for its
 * leading digit but "Topps" read as a RUNG, and a rung expands over every base
 * card, so the page would have staged 199 phantom "Topps" parallel rows.
 * End the slice at the page chrome as well as at the next heading.
 */
const PAGE_CHROME = `<div id="catlinks|<div class="printfooter|<div id="mw-navigation|<footer`;
function section(html, id, level) {
  const re = new RegExp(`<h${level} id="${id}"[\\s\\S]*?(?=<h[2-${level}] id=|${PAGE_CHROME}|$)`);
  const m = html.match(re);
  return m ? m[0] : "";
}

/** "108" / "US150" / "BD-72" -> a card number; "Juan Soto" is not. */
const CARD_NUM = /^([A-Z]{0,4}-?\d+[a-z]?|[A-Z0-9]{1,6}-[A-Z0-9]{1,6})$/i;
/**
 * CF-A-CARD-IS-NOT-A-PARALLEL (D33, Drew 2026-08-30: the "Find this card"
 * picker showed "BD 154 Adley Rutschman" as a PARALLEL of BD-152).
 *
 * The old guard tested only `name.split(" ")[0]` against CARD_NUM, so it saw
 * the token "BD" in "BD 154 Adley Rutschman" -- which is not a card number --
 * and admitted the line as a rung. The prefix and the number are separated by
 * a SPACE on the rendered page as often as by a hyphen, so the test has to
 * read the whole line: an optional letter prefix, a hyphen OR a space, the
 * number, then a name. A parallel never has that shape; a card line always
 * does.
 *
 * Blast radius checked against real rung names that START WITH DIGITS and
 * must survive: "20 in '20" (an insert) and "1990 Bowman" (a retro subset)
 * are followed by a word, so the trailing \p{L} alone would catch them --
 * the year-guard below is what lets them through, and the pin in
 * bcpCardLineIsNotARung.test.ts holds it.
 */
const CARD_LINE = /^[A-Za-z]{0,5}[-\s]?\d{1,4}[a-z]?\s+\p{L}/u;
/** A 4-digit lead is a YEAR ("1990 Bowman"); a stop-word or finish word
 *  after the number means a parallel ("20 in '20", "3 Color Patch"). */
const isCardLine = (s) => { const v = String(s ?? "").trim(); if (!CARD_LINE.test(v)) return false; if (/^(?:19|20)\d{2}\s/.test(v)) return false; const after = v.replace(/^[A-Za-z]{0,5}[-\s]?\d{1,4}[a-z]?\s+/u, ""); if (/^(?:in|of|to|and|the|for|per|on|at|by)\b/i.test(after)) return false; if (!/^[A-Za-z]{1,5}[-\s]/.test(v) && /^(?:colou?r|tone|tool|of|piece|pc|patch|star|swatch|box|case|player|team|logo|letter|strand)\b/i.test(after)) return false; return true; };
/** An insert-style number carries letters: 90CB-1, UL-7, RS-12. A pure
 *  number inside an insert section would collide with the base set. */
const INSERT_NUM = /[A-Z]/i;

/**
 * CF-A-COMMA-BEFORE-JR-IS-NOT-A-TEAM (D33, Drew 2026-08-30: the picker listed
 * "Bobby Witt, Jr." and "Bobby Witt" as two different players).
 *
 * The line is "<li>BD-152 Bobby Witt, Jr. </li>" -- and the old code
 * stripped everything after the FIRST comma to drop ", Team", which silently
 * truncated every Jr./Sr./II/III in the set. Meanwhile the OTHER bcp scraper
 * kept the comma and wrote "Bobby Witt, Jr.". Two converters, two different
 * wrong spellings of one player, off one page.
 *
 * An honorific tail is part of the name and keeps its comma removed; any
 * other tail is the team and is dropped. Both suffixes can appear at once
 * ("Ronald Acuna, Jr., Braves"), so the tails are walked right to left.
 */
const HONORIFIC = /^(Jr|Sr|I{2,3}|IV)\.?$/i;
/**
 * CF-EXCH-IS-A-FULFILMENT-STATE-NOT-A-NAME (2026-09-04). BCP marks autograph
 * checklist lines whose card shipped as a REDEMPTION with a trailing "EXCH":
 *
 *   <li>173 Freddie Freeman EXCH</li>
 *
 * That is a statement about how the card was delivered, not about who signed
 * it, and carrying it into playerName would mint "Freddie Freeman EXCH" as a
 * player distinct from "Freddie Freeman" -- the same one-player-two-spellings
 * defect the comma/Jr. rule above exists to prevent. Stripped as a trailing
 * token only, so a real name is never touched.
 */
const REDEMPTION_TAIL = /\s+EXCH(?:ANGE)?\.?$/i;
function cleanScrapedPlayer(raw) {
  const parts = String(raw ?? "").replace(REDEMPTION_TAIL, "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!parts.length) return "";
  let out = parts[0];
  for (const tail of parts.slice(1)) {
    if (HONORIFIC.test(tail)) out += " " + tail;   // part of the name
    else break;                                     // ", Team" and anything after
  }
  return out.trim();
}

/** Base-set card lines: <li>NUM NAME[, Team]</li> */
function parseCards(body) {
  const cards = [];
  for (const m of body.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const text = detag(m[1]);
    const sp = text.indexOf(" ");
    if (sp < 1) continue;
    const num = text.slice(0, sp).trim();
    if (!CARD_NUM.test(num)) continue;
    let player = cleanScrapedPlayer(text.slice(sp + 1));
    if (!player || !/[A-Za-z]{2}/.test(player) || player.length > 60) continue;
    cards.push({ num, player });
  }
  return cards;
}

const RUN_NOTE = /(?:#'?d?\s*(?:to|\/)\s*|numbered\s+to\s+|:\s*)([\d,]+)\s*(?:cop(?:y|ies))?\b|\(([\d,]+)\s*cop(?:y|ies)\)/i;
// CF-A-SCOPE-HEADING-IS-NOT-A-RUNG (D33). "Chrome", "1st Edition",
// "Sapphire Edition" and "Chrome Gimmicks" name a SCOPE (a product or a
// sub-family), never a finish -- yet prod carries all four as literal
// parallelSlugs on BD-152. They join the umbrella list, which is matched at
// the END of a heading so "Sky Blue Refractor" is untouched.
const UMBRELLA = /(parallels|factory set|retail|club set|variations?|short prints?|\bsps?\b|photo variations?|checklist|chrome|chrome gimmicks|1st edition|first edition|sapphire edition|chrome prospects|1st edition prospects)$/i;
// CF-A-PLAYER-IS-NOT-A-RUNG (2026-08-29, B4 run 2). Older set pages list
// per-player short-print and variation rosters inside the Parallels section
// as bare <li>Jimmy Rollins</li> lines; the ladder parser took every one as a
// rung, and 2008 Topps got 26 "parallels" of which 18 were players (661 rows
// each). The base list is on the same page: any rung candidate that equals a
// player name of this product is a roster line, not a rung.
const foldName = (s) => String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// CF-A-CARD-NUMBER-IS-NOT-A-RUNG (D33, Drew 2026-08-30: "still a mess" on
// 2020 Bowman Draft BD-152). Both defences above are NUMBER-PREFIX-BLIND, and
// baseballcardpedia writes its card numbers SPACE-separated:
//
//   <li>BD 121 Spencer Torkelson</li>     <- a card line
//
// CARD_NUM tested only the first space-delimited token, which here is the bare
// alpha prefix "BD" -- not a card number, so the line was accepted as a RUNG
// and every card on the page became a "parallel" of every other card. The
// roster set missed it too: that set is built from parseCards' `player` field,
// the name AFTER the number, so it holds "spencer torkelson" while the
// candidate folds to "bd 121 spencer torkelson" and the two never compare
// equal. 47,267 catalog rows were minted this way (baseballcardpedia 28,776 +
// baseballcardpedia-graded 18,491) across 2,234 distinct cards.
//
// The fix closes both halves. `leadingCardNumber` recognises a card number in
// EITHER spelling -- the hyphen form "BD-121" that CARD_NUM already caught and
// the space form "BD 121" it could not -- and `foldRoster` strips one before
// folding, so a roster line is refused by name even when it arrives numbered.
//
// The alpha prefix is REQUIRED to be followed by digits, so a real rung whose
// first word happens to be short ("Sky Blue", "Gold Wave") is never mistaken
// for a number: "Sky" is not followed by a digit.
const LEADING_CARD_NUM = /^([A-Z]{1,5}[-\s]?\d+[a-z]?|\d+[a-z]?)\s+(?=\S)/i;
/** The card-number prefix of a line, or "" when the line does not start with one. */
const leadingCardNumber = (text) => (String(text ?? "").match(LEADING_CARD_NUM) || [""])[0].trim();
/** foldName with any leading card number removed -- so "BD 121 Spencer
 *  Torkelson" folds to the same key the base list's "Spencer Torkelson" does. */
const foldRoster = (s) => foldName(String(s ?? "").replace(LEADING_CARD_NUM, ""));
const PARALLEL_WORDS = new Set(["refractor","refractors","xfractor","x-fractor","fractor","prizm","prizms","mojo","wave","shimmer","foil","foilboard","holo","chrome","sapphire","superfractor","printing","plate","plates","black","gold","silver","blue","red","green","orange","purple","pink","yellow","aqua","teal","magenta","fuchsia","bronze","platinum","rainbow","atomic","lava","pattern","laser","crackle","mini","base","parallel","variation","variations","sp","ssp","auto","autograph","autographs","relic","patch","jersey","insert","inserts","checklist","1/1","numbered","border","camo","tie-dye","disco","cracked","ice","optic","velocity","hyper","speckle","sparkle","glitter","neon","negative","sepia","vintage","stock","paper","canvas","gilded","glossy","matte"]);
const isPersonName = (v) => { const t = foldName(v).split(" ").filter(Boolean); return t.length >= 2 && t.length <= 5 && !t.some((w) => PARALLEL_WORDS.has(w)) && !/^\d/.test(t[0]); };

/** Everything the Parallels section names, deduped by slug, run kept when found. */
// CF-THE-NAME-IS-NOT-THE-FOOTNOTE (Drew, 2026-08-29 "clean the names"). A
// heading id like "Refractor_-_Est._print_run_~4,000_to_6,000" is a rung name
// with the page's footnote glued on. The name is the text before the
// footnote; the footnote is kept verbatim as the rung's note (7th CSV column)
// and, when it is nothing but a print-run statement, as the print run. This
// scraper alone had minted 53,181 such rows; the repair pass
// (clean-parallel-annotations) moves the rows already written.
function splitAnnotation(rawName) {
  let name = String(rawName), note = null;
  const est = name.match(/^(.*?)\s*[-\u2013\u2014]?\s*Est\.?\s*print run\b(.*)$/i);
  if (est) { note = ("Est. print run" + est[2]).trim(); name = est[1]; }
  const par = name.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (par) { note = [par[2].trim(), note].filter(Boolean).join("; ") || null; name = par[1]; }
  name = name.replace(/[-\u2013\u2014:]\s*$/, "").trim();
  let run = null;
  if (note) {
    const m = note.match(/^(?:#\s*)?\/?\s*(\d[\d,]{0,6})\s*(?:copies|cards|made)?\.?$/i)
      || note.match(/^(?:serial\s+)?numbered to\s*(\d[\d,]{0,6})\.?$/i)
      || note.match(/^(?:series\s+\w+:\s*)?(\d[\d,]{0,6})\s*copies\.?$/i)
      || note.match(/^\d+\s*\/\s*(\d[\d,]{0,6})$/);
    if (m) run = Number(m[1].replace(/,/g, "")) || null;
  }
  return { name, note, run };
}

/**
 * CF-THE-H3-IS-A-PRODUCT-BOUNDARY (D33, Drew 2026-08-30: "still a mess" on
 * 2020 Bowman Draft BD-152).
 *
 * The Parallels section is NOT one ladder. It is the paper ladder, then a
 * run of h3 scopes -- "Chrome", "1st Edition", "Sapphire Edition" -- each of
 * which is a DIFFERENT PRODUCT with its own numbering. parseLadder used to
 * flatten all of them into one Map and main() cross-joined that over the
 * paper base cards, so BD-152 (paper) got Gold Refractor /50, Padparadscha
 * and SuperFractor hung off it: 38 rungs where the paper ladder has 9.
 *
 * Under D31 that is not a cosmetic mis-label. Paper "Blue /150" and chrome
 * "Blue Refractor /150" are two DIFFERENT CARDS that happen to share a print
 * run; folding them is exactly the destruction D31 forbids.
 *
 * The split is on the page and is read, never assumed: text ABOVE the first
 * h3 is the paper scope, and each h3 opens a new one.
 */
/** A scope's own body: everything before its first nested h4 subsection. */
function sliceBeforeSubsections(scopeBody) {
  const i = scopeBody.search(/<h4 id=/);
  return i > 0 ? scopeBody.slice(0, i) : scopeBody;
}

function splitScopes(parallelsBody) {
  const heads = [...parallelsBody.matchAll(/<h3 id="([^"]+?)(?:_\d+)?">/g)];
  const scopes = [{ title: null, body: heads.length ? parallelsBody.slice(0, heads[0].index) : parallelsBody }];
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].index : parallelsBody.length;
    scopes.push({ title: detag(heads[i][1].replace(/_/g, " ")), body: parallelsBody.slice(heads[i].index, end) });
  }
  return scopes;
}

/**
 * CF-THE-PAGE-STATES-ITS-OWN-PREFIX (D33). The brief that opened this task
 * said the chrome rows "belong at bdc-152". For 2020 that is FALSE and would
 * have moved 2,400 rows onto card numbers that do not exist: the 2020 page's
 * own images are Bowman-Draft---Chrome/BD-113, and Cardboard Connection
 * confirms BD-152 IS the 2020 chrome number. 2025 genuinely is BDC-. The
 * mapping is YEAR-DEPENDENT, so it is DERIVED from the page or not at all.
 *
 * Evidence, in order of authority:
 *   1. prose  -- '1st Edition cards are sequentially-numbered with a "BFE-"
 *                prefix' (2020 Bowman states it in words).
 *   2. images -- comc URLs carry product path + number as data:
 *                Bowman---Prospects/BP-25 beside
 *                Bowman---Chrome-Prospects/BCP-50 gives BP- -> BCP-.
 *   3. the scope's own card list, when it has one.
 *
 * When nothing resolves we DO NOT GUESS and DO NOT fall back to the paper
 * prefix: the rows keep the paper numbers under the scope's own setKey and
 * the run prints PREFIX UNRESOLVED. A wrong number is worse than a flagged
 * gap -- 2025 Bowman Draft has no comc image at all, and this is the branch
 * that keeps it honest.
 */
const PREFIX_PROSE = /numbered\s+with\s+an?\s+"?([A-Z]{2,5})-"?\s*prefix/i;

function prefixFromProse(scopeBody) {
  const m = detag(scopeBody).match(PREFIX_PROSE);
  return m ? m[1].toUpperCase() + "-" : null;
}

/** Group every comc image on the page by product path -> modal number prefix. */
function prefixesFromImages(html) {
  const byPath = new Map();
  // .../i/<Sport>/<year>/<Product-Path>/<NUM>/<Player-Name>.jpg -- the number
  // is the segment AFTER the product path, not the last one (a player-name
  // segment and the file name follow it).
  for (const m of html.matchAll(/comc\.com\/i\/[^"'?\s]*/g)) {
    const parts = m[0].split("/").slice(2);          // drop "comc.com","i"
    if (parts.length < 4) continue;
    const productPath = parts[2], num = parts[3];
    if (!productPath || !num) continue;
    const pre = (num.match(/^([A-Z]{1,6})-/i) || [])[1];
    const key = productPath.toLowerCase();
    if (!byPath.has(key)) byPath.set(key, new Map());
    const tally = byPath.get(key);
    const v = pre ? pre.toUpperCase() + "-" : "";          // "" = bare numbers
    tally.set(v, (tally.get(v) || 0) + 1);
  }
  const out = new Map();
  for (const [k, tally] of byPath) {
    let best = null, n = 0;
    for (const [v, c] of tally) if (c > n) { best = v; n = c; }
    out.set(k, best);
  }
  return out;
}

/** foldable token set of a product path / scope title, for matching the two. */
const pathTokens = (s) => new Set(String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

/**
 * The number prefix for one scope, from the page alone. `setName` is the
 * product ("Bowman Draft"); the scope title refines it ("Chrome"). The image
 * path that matches BOTH -- product words AND scope words -- wins.
 */
function derivePrefix(scope, html, setName, imgPrefixes) {
  const prose = prefixFromProse(scope.body);
  if (prose) return { prefix: prose, via: "prose" };

  const want = pathTokens(setName + " " + (scope.title || ""));
  const scopeWords = pathTokens(scope.title || "");
  let hit = null;
  for (const [pathKey, pre] of imgPrefixes) {
    if (pre == null) continue;
    const have = pathTokens(pathKey);
    // every word of the product+scope must appear in the image path, and for
    // a named scope the scope's own words must be there (so the paper path
    // never answers for Chrome).
    if (![...want].every((w) => have.has(w))) continue;
    if (scopeWords.size && ![...scopeWords].every((w) => have.has(w))) continue;
    // an autograph/insert path is a different checklist, not this scope
    if (/autograph|relic|buyback/.test(pathKey)) continue;
    if (hit && hit !== pre) return { prefix: null, via: "images:conflict" };
    hit = pre;
  }
  if (hit != null) return { prefix: hit, via: "images" };

  const own = parseCards(scope.body);
  if (own.length >= 3) {
    const tally = new Map();
    for (const c of own) {
      const pre = (c.num.match(/^([A-Z]{1,6})-/i) || [])[1];
      const v = pre ? pre.toUpperCase() + "-" : "";
      tally.set(v, (tally.get(v) || 0) + 1);
    }
    let best = null, n = 0;
    for (const [v, c] of tally) if (c > n) { best = v; n = c; }
    if (best != null) return { prefix: best, via: "scope-cards" };
  }
  return { prefix: null, via: "unresolved" };
}

/**
 * CF-A-CARD-LIST-IS-NOT-A-LADDER (D33). "Chrome Gimmicks" on the 2020 page
 * is 15 <li>BD-12 Emerson Hancock</li> lines sitting INSIDE Parallels -- the
 * exact shape that put "BD 154 Adley Rutschman" in the picker as a parallel
 * of BD-152. A scope whose list items are overwhelmingly card lines is a
 * CARD LIST, and it contributes zero rungs. Structural, not a name list.
 */
function isCardListScope(scopeBody) {
  const lis = [...scopeBody.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => detag(m[1])).filter(Boolean);
  if (lis.length < 3) return false;
  const cardish = lis.filter((t) => isCardLine(t)).length;
  return cardish / lis.length >= 0.8;
}

/**
 * ============================================================================
 * CF-A-PRINT-RUN-IS-A-FUNCTION-OF-(RANGE, PARALLEL) — #1571 §3.1, Drew
 * 2026-08-30 ("the exploded-spine signature").
 *
 * BCP states vintage print runs PER CARD-NUMBER RANGE, because the subsets
 * ARE the ranges:
 *
 *   Radiance Youth Movement   (cards 1-30 and 181-210; serial-numbered to 2500)
 *   Radiance Heroes of the Game (cards 171-180;        serial-numbered to 100)
 *
 * The emitter cross-joined every rung over every base card, so card #1 was
 * written as "Radiance Heroes of the Game /100" when Heroes is cards 171-180
 * ONLY. 360 cards x 4 rungs = 1,440 rows is the same cross-join signature as
 * the retired exploded spine (#1371), and a well-formed wrong printRun is
 * invisible to every later sweep -- it silently splits or merges a comp pool.
 *
 * A rung therefore carries the CARD NUMBERS it applies to. `cardRange` is
 * null when the page names no range, which means "the whole set" ONLY when
 * the page says so in words ("Each base card is available in..."); otherwise
 * the rung is emitted with a BLANK printRun rather than a set-wide guess.
 * Blank is unknown; a guessed default is a lie that outlives the sweep.
 */
/** "cards 1-30 and 181-210" / "cards 171-180" / "card 45" -> [[1,30],[181,210]].
 *  The clause runs from the word "card(s)" to the end of that clause (";" or
 *  ")" or a verb) and may hold SEVERAL spans joined by "and"/","; capturing
 *  only the first silently halved every split subset (Youth Movement is
 *  cards 1-30 AND 181-210). */
function parseCardRange(text) {
  const t = String(text ?? "");
  // CF-A-SUBSET-PARENTHETICAL-IS-A-RANGE (2026-08-31). 1993 Finest states the
  // Jumbos' scope without ever writing the word "cards":
  //
  //   "feature reproductions of 33 players from that set's All-Star subset (84-116)"
  //
  // The clause below required "card(s)", found nothing, and returned null --
  // which cardInRange reads as "the whole set", so a 33-card box-topper set
  // expanded over all 199 base cards. That is the exploded-spine signature
  // this very file was written to stop, arriving through a phrasing it did
  // not know. A bare "(lo-hi)" following a subset/set noun IS the range, and
  // the count stated alongside it ("33 players") must agree with the span's
  // width or we do not trust the read.
  const sub = t.match(/\b(?:subset|set|series|checklist)\b[^.()]{0,40}\(\s*(\d+)\s*[-–—]\s*(\d+)\s*\)/i);
  if (sub) {
    const lo = Number(sub[1]), hi = Number(sub[2]);
    const stated = t.match(/\b(\d{1,4})\s+(?:players?|cards?|subjects?)\b/i);
    const width = hi - lo + 1;
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo
        && (!stated || Number(stated[1]) === width)) return [[lo, hi]];
  }
  const m = t.match(/\bcards?\s+((?:#?\s*\d+(?:\s*[-–—]\s*\d+)?)(?:\s*,?\s*(?:and\s+)?#?\s*\d+(?:\s*[-–—]\s*\d+)?)*)/i);
  if (!m) return null;
  const spans = [];
  for (const s of m[1].matchAll(/#?\s*(\d+)\s*(?:[-–—]\s*(\d+))?/g)) {
    const lo = Number(s[1]), hi = s[2] === undefined ? Number(s[1]) : Number(s[2]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) continue;
    spans.push([lo, hi]);
  }
  return spans.length ? spans : null;
}

/** Does a card number fall inside any span? Bare-numeric numbers only; a
 *  lettered insert number ("UL-7") is never range-scoped. */
function cardInRange(num, spans) {
  if (!spans) return true;                       // unscoped rung = all cards
  const n = Number(String(num ?? "").replace(/^[A-Za-z]{0,5}[-\s]?/, ""));
  if (!Number.isFinite(n)) return false;
  return spans.some(([lo, hi]) => n >= lo && n <= hi);
}

/**
 * CF-THE-EXCEPT-BLOCK-IS-NOT-THE-RULE — #1571 §3.2.
 *
 * 1999 Black Diamond states the ladder, then states an EXCEPTION for three
 * players, and the exception's <li> lines come SECOND:
 *
 *   Each is serial-numbered to the following production figures EXCEPT the
 *   cards of Sammy Sosa, Ken Griffey, Jr., and Mark McGwire.
 *     Double (Red foil): short set, 3000; Debuts, 2500     <- the RULE
 *   For Sosa, Griffey, and McGwire their ... parallels are as follows.
 *     Double (serial-numbered to 1998)                     <- the EXCEPTION
 *     Triple (Sosa: 273 copies, Griffey: 350, McGwire: 457)
 *
 * The rule lines' "short set, 3000; Debuts, 2500" did not match RUN_NOTE, so
 * they set printRun=null -- and then `put`'s "fill an empty run" merge let the
 * EXCEPTION line overwrite it. Result: Double /1998, Triple /273, Quadruple
 * /66 stamped on all 120 cards. /273 is Sammy Sosa's career home-run total
 * written onto every player in the set, and it read as printRunFilled=360.
 *
 * The parser stops at this boundary the same way it already stops at
 * id="Inserts": everything after it is a DIFFERENT scope whose figures belong
 * to the named players' rows alone.
 */
/**
 * The EXCEPT sentence and the exception BLOCK are two different things.
 *
 *   "Each is serial-numbered to the following figures EXCEPT the cards of
 *    Sosa, Griffey, and McGwire."      <- NAMES the players; the rule follows
 *     Double (Red foil): short set, 3000 ...          <- still the RULE
 *   "For Sosa, Griffey, and McGwire their ... are as follows."  <- THE CUT
 *     Double (serial-numbered to 1998) ...            <- the EXCEPTION
 *
 * Cutting at the word EXCEPT put the rule lines on the exception side and
 * lost the real ladder. The cut is the "For X, Y and Z ... their" sentence;
 * EXCEPT only supplies the player names (and may appear before either).
 */
const EXCEPT_NAMES = /\bEXCEPT\b|\bwith the exception of\b/i;
const EXCEPT_BOUNDARY = /\bFor\s+[A-Z][\w.'-]+(?:\s*,\s*(?:and\s+)?[A-Z][\w.'-]+)*(?:\s+and\s+[A-Z][\w.'-]+)?[^.]{0,80}\btheir\b/;

/** Split a Parallels body at the exception boundary: { rule, exception }. */
function splitAtException(body) {
  // Work on the tag stream but locate the boundary in TEXT, then map back by
  // walking <li>/<p> blocks -- an offset in detagged text has no HTML index.
  const blocks = [...String(body).matchAll(/<(li|p)\b[\s\S]*?<\/\1>/g)];
  let cut = -1, names = "";
  for (const b of blocks) {
    const t = detag(b[0]);
    if (EXCEPT_NAMES.test(t) && !names) names = t;
    if (EXCEPT_BOUNDARY.test(t)) {
      // The boundary sentence INTRODUCES the exception; the exception rungs
      // are the blocks after it.
      cut = b.index + b[0].length;
      if (!names) names = t;
      break;
    }
  }
  if (cut < 0) return { rule: body, exception: "", players: [] };
  return { rule: String(body).slice(0, cut), exception: String(body).slice(cut), players: exceptionPlayers(names) };
}

/** The players an EXCEPT clause names, e.g. "Sammy Sosa, Ken Griffey, Jr.,
 *  and Mark McGwire" -> ["Sammy Sosa","Ken Griffey Jr.","Mark McGwire"].
 *  The sentence ends at a period NOT preceded by an honorific, so "Jr." does
 *  not truncate the list and silently drop Mark McGwire. */
function exceptionPlayers(text) {
  const t = String(text ?? "");
  const m = t.match(/(?:EXCEPT|exception of)\s+(?:the\s+cards\s+of\s+)?([\s\S]+?)(?<!\b(?:Jr|Sr|Dr|St))\.(?:\s|$)/i)
    || t.match(/\bFor\s+([\s\S]{0,120}?)\s+their\b/i);
  if (!m) return [];
  const out = [];
  for (const raw of m[1].split(/,|\s+and\s+/)) {
    const name = raw.trim().replace(/^the cards of\s+/i, "").trim();
    if (!name) continue;
    // ", Jr." arrives as its own comma-split fragment; glue it back on.
    if (/^(Jr|Sr|I{2,3}|IV)\.?$/i.test(name)) { if (out.length) out[out.length - 1] += " " + name; continue; }
    if (/[A-Za-z]{2}/.test(name) && name.split(/\s+/).length <= 4) out.push(name);
  }
  return out;
}

/**
 * Does a base-card player match one of the exception names?
 *
 * The page names the same three men two ways -- "Sammy Sosa, Ken Griffey,
 * Jr., and Mark McGwire" in the EXCEPT sentence and bare "Sosa", "Griffey",
 * "McGwire" in the per-player figures -- while the checklist writes "Ken
 * Griffey Jr.". A prefix test matches the first pair and MISSES the surname
 * form, which silently dropped every per-player rung. Compare on SURNAME:
 * the last non-honorific token of each side.
 */
function matchesExceptionPlayer(player, names) {
  const surname = (v) => {
    const t = foldName(v).split(" ").filter(Boolean).filter((w) => !/^(jr|sr|ii|iii|iv)$/.test(w));
    return t.length ? t[t.length - 1] : "";
  };
  const p = foldName(player), ps = surname(player);
  if (!ps) return false;
  return names.some((n) => { const f = foldName(n); return p === f || ps === surname(n); });
}

/**
 * CF-PACK-ODDS-ARE-NOT-A-PRINT-RUN (#1571 §5: "Odds must map to a rarity
 * field and must never be coerced into printRun").
 *
 * 1997 Finest predates serial numbering and publishes ODDS -- "the Bronze
 * Refractors are the easiest to pull (1:12/packs)". RUN_NOTE's ":\s*(\d+)"
 * arm read that as a print run and stamped /12 on all 350 Refractor rows.
 * A pre-serial product must emit BLANK, which is what "unknown" means.
 */
const ODDS = /\b1\s*:\s*\d/;
const hasOdds = (s) => ODDS.test(String(s ?? ""));

/**
 * CF-RARITY-IS-NOT-A-PRINT-RUN (Drew ruling, 2026-08-30). #1571 §5 said odds
 * "must map to a rarity field"; until now there was no such field, so every
 * figure the guards refuse was simply DROPPED.
 *
 * printRun stays SERIAL-ONLY TRUTH: a number stamped on the card itself. It is
 * blank whenever the page did not state one, and this field never fills it in.
 *
 * `rarity` is the descriptive companion -- a set-level production or scarcity
 * statement the page publishes that is NOT a per-card serial:
 *
 *   1987 Topps Tiffany   "approximately 30,000 sets produced"  -> set production
 *   1997 Finest          "the easiest to pull (1:12/packs)"    -> pack odds
 *   1996 Metal Universe  "inserted 1:24 packs"                 -> pack odds
 *
 * Descriptive ONLY. Nothing in valuation reads it: a rarity string must never
 * become a multiplier or a synthetic print run, because a set-production figure
 * ("30,000 sets") and a serial ("/30000") are different claims about different
 * objects, and conflating them is exactly the well-formed-wrong-row failure the
 * range scoping exists to prevent.
 */
/** A pack-odds statement, verbatim: "1:12/packs", "inserted 1:24 packs". */
const ODDS_PHRASE = /\b(?:inserted\s+)?1\s*:\s*\d[\d,]*(?:\s*(?:\/|\s)\s*(?:hobby |retail )?(?:packs?|boxes?|cases?))?/i;
/** A set-production statement: "approximately 30,000 sets produced". */
const SET_PRODUCTION = /(?:produced|made|printed|issued)\s+(?:approximately|approx\.?|about|~|an estimated|estimated)?\s*(\d[\d,]{2,})\s*(?:factory\s+)?sets?/i;
/** The reverse wording: "production run of 30,000 sets". */
const SET_PRODUCTION_ALT = /(?:approximately|approx\.?|est\.?|estimated|about|~)?\s*(\d[\d,]{2,})\s*(?:factory\s+)?sets?(?:\s+[^\d.]{0,40})?\s*(?:were|was)?\s*(?:produced|made|printed|issued)|(?:production|print)\s+(?:run|figure)\s+of\s*(?:approximately|approx\.?|about|~)?\s*(\d[\d,]{2,})\s*(?:sets?)?/i;

/**
 * The rarity statement a text carries, or null.
 *
 * Returns the page's OWN WORDS (trimmed), never a number we invented, so the
 * figure stays auditable back to the source sentence.
 */
function extractRarity(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const odds = t.match(ODDS_PHRASE);
  if (odds) return odds[0].trim();
  const prod = t.match(SET_PRODUCTION) || t.match(SET_PRODUCTION_ALT);
  if (prod) {
    const n = Number(String(prod[1] ?? prod[2]).replace(/,/g, ""));
    // A "set production" figure below a plausible factory-set run is far more
    // likely a serial statement caught by the wrong regex; refuse rather than
    // mislabel. Blank is unknown.
    if (Number.isFinite(n) && n >= 1000) return prod[0].trim();
  }
  return null;
}

/**
 * CF-A-NAMED-SUBSET-IS-A-RANGE (#1571 §3.2, the other half).
 *
 * Black Diamond states its rule runs by SUBSET NAME, not by card range:
 *
 *   Double (Red foil): short set, 3000; Debuts, 2500
 *
 * Two figures on one line. RUN_NOTE could read only one number, so the rung
 * got null and the EXCEPT block then filled it. Splitting the clause gives
 * two range-scoped rungs -- but only if the subset NAMES resolve to card
 * numbers, and those come from the page, never from a convention:
 *
 *   "The last 30 cards in the base set make up a Diamond Debuts subset"
 *   Insertion Ratios: short set 90 | Diamond Debut 30
 *
 * So short set = 1-90 and Debuts = 91-120 for a 120-card base. When the page
 * does NOT state the split, the subset does not resolve and the rung is
 * emitted BLANK rather than guessed -- unknown, not invented.
 */
const SUBSET_CLAUSE = /(short set|debuts?|diamond debuts?)\s*,\s*(\d[\d,]*)/gi;

/** Parse "short set, 3000; Debuts, 2500" -> [{subset,run}]; [] when absent. */
function parseSubsetRuns(note) {
  const out = [];
  for (const m of String(note ?? "").matchAll(SUBSET_CLAUSE)) {
    const run = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(run) || run < 1 || run > 100000) continue;
    out.push({ subset: /short/i.test(m[1]) ? "short set" : "debuts", run });
  }
  return out;
}

/**
 * The card-number span of each named subset, DERIVED from the page:
 * the base-card count plus a "last N cards ... subset" statement.
 * Returns {} when the page does not say -- the caller then emits blank.
 */
function subsetRanges(html, cardCount) {
  const t = detag(html);
  const m = t.match(/\blast\s+(\d{1,3})\s+cards?\b[^.]{0,80}?\bmake up\b[^.]{0,60}?\bsubset\b/i);
  if (!m || !cardCount) return {};
  const tail = Number(m[1]);
  if (!Number.isFinite(tail) || tail <= 0 || tail >= cardCount) return {};
  return { "short set": [[1, cardCount - tail]], debuts: [[cardCount - tail + 1, cardCount]] };
}

/**
 * "Sosa: 273 copies, Griffey: 350, McGwire: 457" -- one figure PER PLAYER on
 * one line. Taking the first (273, Sosa's career HR total) and applying it to
 * all three was the original defect one level down: Griffey's Triple is /350,
 * not /273. Returns [{player, run}]; [] when the line is not per-player.
 */
const PER_PLAYER = /([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+)?)\s*:\s*(\d[\d,]*)\s*(?:cop(?:y|ies))?/g;

function parsePerPlayerRuns(note) {
  const out = [];
  for (const m of String(note ?? "").matchAll(PER_PLAYER)) {
    const run = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(run) || run < 1 || run > 100000) continue;
    out.push({ player: m[1].trim(), run });
  }
  // One "Name: number" pair is a label, not a roster ("short set: 3000").
  return out.length >= 2 ? out : [];
}

/** Does this body state its print runs PER CARD RANGE? True when any list
 *  item names a card range alongside a run. When true, a rung of that body
 *  whose own range did not parse must NOT inherit a set-wide run. */
function hasRangeClause(body) {
  for (const m of String(body).matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const t = detag(m[1]);
    if (t.length <= 120 && parseCardRange(t)) return true;
  }
  return false;
}

/** "one-of-one" / "1/1" is a print run of 1 stated in words. */
const ONE_OF_ONE = /\bone[-\s]of[-\s]one\b|\b1\s*\/\s*1\b/i;
/**
 * CF-A-SPELLED-RUN-IS-STILL-A-RUN (2026-09-04). BCP writes small print runs
 * as WORDS as readily as digits -- 2011 Topps Chrome's auto ladder ends
 * "Atomic Refractor (serial-numbered to ten)" and the USA autos' Red is
 * "serial-numbered to five copies". RUN_NOTE reads digits only, so those
 * rungs were emitted with a BLANK print run: the rung is real, the number
 * the page states is right there, and we dropped it.
 *
 * ONE_OF_ONE already sets the precedent (it turns "one-of-one" into /1).
 * This is the same rule over the small words a print run actually uses, and
 * it is deliberately BOUNDED to one..twenty-five: past that BCP writes
 * digits, and a loose word-number would start reading prose.
 */
const SPELLED_RUNS = new Map([
  ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6],
  ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10], ["eleven", 11],
  ["twelve", 12], ["fifteen", 15], ["twenty", 20], ["twenty-five", 25],
]);
const SPELLED_RUN_RE = new RegExp(
  String.raw`(?:serial-)?numbered to\s+(` + [...SPELLED_RUNS.keys()].join("|") + String.raw`)\b`, "i");
/** The run a clause states in words, or null. Never guesses: the phrase must
 *  be the page's own "numbered to <word>". */
function spelledRun(text) {
  const m = SPELLED_RUN_RE.exec(String(text ?? ""));
  return m ? SPELLED_RUNS.get(m[1].toLowerCase()) ?? null : null;
}

/**
 * One ladder. Rungs carry the CARD NUMBERS they apply to (`cardRange`, null =
 * whole set) and, for an EXCEPT block, the PLAYERS they apply to (`players`).
 * Both are read off the page; neither is ever assumed.
 */
function parseLadder(parallelsBody, playerNames = new Set(), opts = {}) {
  const { players: scopePlayers = null, requireRange = false, subsetRuns = null } = opts;
  const rungs = new Map();
  let rosterLines = 0;
  const putFor = (rawName, run, rawNote, cardRange, players, rarity) => {
    const split = splitAnnotation(rawName);
    const name = split.name, note = rawNote ?? split.note ?? null;
    run = run ?? split.run ?? null;
    // Pack odds ("1:12/packs") are a rarity statement, not a print run.
    // The figure is no longer DROPPED: it moves to `rarity`, which is
    // descriptive and never feeds printRun. CF-RARITY-IS-NOT-A-PRINT-RUN.
    if (run != null && hasOdds(note)) run = null;
    rarity = rarity ?? extractRarity(note) ?? null;
    const k = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!k) return;
    if (playerNames.has(foldName(name)) || playerNames.has(foldRoster(name))) { rosterLines++; return; }
    // A rung whose print run is stated per-range but whose range did not
    // parse gets a BLANK run rather than the set-wide value. #1571 §3.1.
    if (requireRange && !cardRange) run = null;
    // Range-scoped and player-scoped rungs of the SAME name are distinct rows
    // (Radiance /2500 on 1-30 is not Radiance /100 on 171-180; Griffey's
    // Triple /350 is not Sosa's /273), so the key carries both scopes.
    // Without this the Map would keep only the first.
    const rk = k
      + (cardRange ? "@" + cardRange.map((s) => s.join("-")).join(",") : "")
      + (players && players.length ? "#" + players.map(foldName).join("+") : "");
    const rec = { name, printRun: run ?? null, note, cardRange: cardRange ?? null, players: players ?? null, rarity: rarity ?? null };
    if (!rungs.has(rk)) rungs.set(rk, rec);
    else { const r = rungs.get(rk); if (run && !r.printRun) r.printRun = run; if (note && !r.note) r.note = note; if (rarity && !r.rarity) r.rarity = rarity; }
  };
  const put = (rawName, run, rawNote, cardRange, rarity) => putFor(rawName, run, rawNote, cardRange, scopePlayers, rarity);

  // named-rung subsections; umbrella headings organize, they do not name a card
  for (const m of parallelsBody.matchAll(/<h[34] id="([^"]+?)(?:_\d+)?">/g)) {
    const name = detag(m[1].replace(/_/g, " "));
    if (/^series (one|two)/i.test(name) || UMBRELLA.test(name)) continue;
    if (name.length > 60) continue;
    const body = section(parallelsBody, m[1], m[0].includes("<h3") ? 3 : 4).slice(0, 2500);
    const text = detag(body);
    // CF-A-FAMILY-HEADING-IS-NOT-ITS-FIRST-RUNG. "Radiance" is an h3 whose
    // body is a LIST of range-scoped children ("Radiance Youth Movement
    // (cards 1-30 and 181-210; ... to 2500)", "Radiance Heroes of the Game
    // (cards 171-180; ... to 100)"). Reading RUN_NOTE over the whole body
    // handed the heading its first child's run -- Radiance /2500 on all 360
    // cards -- and emitting the heading at all re-created the 360-wide rung
    // the range scoping exists to remove: the children already tile the set,
    // so a bare "Radiance" row is a duplicate of whichever child owns that
    // card. A heading whose body states per-range runs NAMES A FAMILY; its
    // rungs are its children.
    if (hasRangeClause(body)) continue;
    const run = text.match(RUN_NOTE);
    const n = run ? Number((run[1] || run[2] || "").replace(/,/g, "")) : null;
    const ok = n && n >= 1 && n <= 100000 && !hasOdds(text);
    // The heading's own text may state pack odds or a set-production figure.
    // Those are refused as a print run and RECORDED as rarity.
    //
    // CF-A-HEADING-RUNG-IS-SCOPED-TOO (2026-08-31). This pass passed
    // cardRange=null unconditionally, so a rung that comes from a HEADING was
    // always set-wide even when the heading's own body stated its span. On
    // 1993 Finest the Jumbos are "33 players from that set's All-Star subset
    // (84-116)" -- 33 oversized box-toppers -- and the null expanded them over
    // all 199 base cards. The <li> rungs above already scope themselves; a
    // heading rung must too, or the ladder cross-joins exactly where #1571
    // says it must not.
    put(name, ok ? n : null, null, parseCardRange(text), extractRarity(text));
  }

  // list rungs: <li>Name (note)</li>, rejecting card lines and prose
  for (const m of parallelsBody.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const text = detag(m[1]);
    // The 60-char prose guard predates range clauses. A line that NAMES A
    // CARD RANGE is structured data, not prose -- "Radiance Cornerstones of
    // the Game (cards 351-360; serial-numbered to 100)" is 73 chars and is
    // the most precise rung on the page. Silently dropping it left SPx Finite
    // with 3 of its 8 Radiance rungs. Prose still has no range clause, so the
    // guard keeps its job; the allowance is capped so a paragraph that merely
    // mentions a card number cannot slip through.
    if (!text) continue;
    // The 60-char guard rejects prose. A line carrying a SCOPED RUN CLAUSE is
    // not prose: "Blue (Class 1, serial-numbered to 150; Class 2, ... 99;
    // Class 3, ... 50)" is 78 chars and is a real rung whose print run varies
    // by a scope this emitter cannot yet express in card numbers. Dropping it
    // lost the rung entirely; keeping it with a BLANK run records the rung and
    // says the number is unknown, which is the honest state. Its note keeps
    // the page's own wording so the figures are recoverable later.
    const ranged = text.length <= 160 && parseCardRange(text) != null;
    const scopedRun = text.length <= 200 && /serial-numbered to|numbered to|\bcopies\b/i.test(text)
      && /\b(class|series|tier|level)\s*\d|;/i.test(text);
    // CF-A-SERIAL-CLAUSE-IS-NOT-PROSE (2026-09-04, the shared-number auto
    // lane). The 60-char guard rejects PROSE, but a line that states its own
    // serial print run is the most structured thing on the page:
    //
    //   Black-Bordered Refractor (serial-numbered to 100 copies, Hobby only)
    //
    // is 68 chars, carries no card range and no "Class N" scope, so it fell
    // through all three allowances and was DROPPED -- silently, on the base
    // ladder as well as the auto one. It survives on the 2011 base ladder
    // only because that page also gives it an <h3>; inside the Autographs
    // section it is a bare <li> and vanished, taking the /100 rung out of a
    // nine-rung ladder. A single stated run makes the line data, not prose
    // (the multi-figure clause is still refused, below).
    const singleRun = text.length <= 200
      && /(?:serial-)?numbered to\s+[\d,]+|\bone-of-one\b|\(\s*[\d,]+\s*cop(?:y|ies)/i.test(text);
    if (text.length > 60 && !ranged && !scopedRun && !singleRun) continue;
    const paren = text.indexOf("(");
    const name = (paren > 0 ? text.slice(0, paren) : text).trim().replace(/[-–—:]$/, "").trim();
    if (!name || name.length > 45 || !/[A-Za-z]{2}/.test(name)) continue;
    // A card line, in either of the page's two spellings: "BD-121 Spencer
    // Torkelson" (caught by the first token) and "BD 121 Spencer Torkelson"
    // (whose first token is only the alpha prefix). CF-A-CARD-NUMBER-IS-NOT-A-RUNG.
    if (CARD_NUM.test(name.split(" ")[0]) || leadingCardNumber(name)) continue;
    const note = paren > 0 ? text.slice(paren) : "";
    // The range clause lives in the SAME parenthetical as the run:
    // "(cards 171-180; serial-numbered to 100)".
    const cardRange = parseCardRange(note) || parseCardRange(text);
    const run = note.match(RUN_NOTE);
    let n = run ? Number((run[1] || run[2] || "").replace(/,/g, "")) : null;
    if (n == null && ONE_OF_ONE.test(note)) n = 1;      // "one-of-one" is /1
    if (n == null) n = spelledRun(note);                // "numbered to ten" is /10
    if (hasOdds(note)) n = null;                        // 1:12 is odds, not a run
    // Whatever the guards refuse is still a fact the page stated. Keep it in
    // the descriptive field rather than dropping it. CF-RARITY-IS-NOT-A-PRINT-RUN.
    const rungRarity = extractRarity(note) || extractRarity(text);
    // CF-A-MULTI-FIGURE-CLAUSE-HAS-NO-SINGLE-RUN. "Blue (Class 1,
    // serial-numbered to 150; Class 2, ... 99; Class 3, ... 50)" states THREE
    // runs for three classes. RUN_NOTE returns the first (150), which would
    // stamp Class 1's number on all 100 cards -- the §3.1 cross-join in a
    // different costume. When a clause holds more than one figure and the
    // scope is not resolvable to card numbers, the run is UNKNOWN: blank.
    const figures = (note.match(/(?:numbered to|copies|:)\s*\d[\d,]*/gi) || []).length;
    if (figures > 1 && !cardRange) n = null;
    // an un-noted bare <li> in this section is usually prose fragment; require
    // either a note or a short multi-wordless name that reads like a rung
    if (!note && name.split(" ").length > 4) continue;
    const cleanNote = note ? note.replace(/^\(|\)$/g, "").trim() || null : null;
    // "short set, 3000; Debuts, 2500" is TWO range-scoped rungs, not one.
    // Emitted only when the page states where the subsets split; otherwise
    // the rung stays blank rather than taking one of the two numbers.
    // A per-player exception line is one rung PER PLAYER: Griffey's Triple
    // is /350, not Sosa's /273.
    const perPlayer = scopePlayers && scopePlayers.length ? parsePerPlayerRuns(note) : [];
    if (perPlayer.length) {
      for (const x of perPlayer) {
        const full = scopePlayers.find((n) => matchesExceptionPlayer(n, [x.player])) || x.player;
        putFor(name, x.run, cleanNote, null, [full]);
      }
      continue;
    }
    const subs = subsetRuns ? parseSubsetRuns(note) : [];
    if (subs.length && subs.some((x) => subsetRuns[x.subset])) {
      for (const x of subs) {
        const rng = subsetRuns[x.subset];
        if (!rng) continue;
        put(name, x.run, cleanNote, rng);
      }
      continue;
    }
    put(name, n && n >= 1 && n <= 100000 ? n : null, cleanNote, cardRange, rungRarity);
  }
  const out = [...rungs.values()];

  out.rosterLines = rosterLines;
  return out;
}

/**
 * The whole Parallels section, resolved into per-PRODUCT ladders.
 *
 * Returns one entry per scope: the setKey suffix the scope routes to, the
 * card-number prefix derived from the page (or null when the page does not
 * say), and the rungs that belong to that product alone.
 *
 * Scope -> product routing reuses the EXISTING vocabulary (D22/D23:
 * productQualifiers.PRODUCT_QUALIFIERS, productSetKeys) rather than inventing
 * a second table; `qualify` is injected so this file stays pure and testable
 * without a dist build. A scope that names a FINISH rather than a product
 * ("Camo Prospects", "Red 'RC' Icon") keeps its parent's setKey and its rungs
 * stay parallels of the paper card.
 */
function parseScopedLadders(parallelsBody, opts = {}) {
  const { html = parallelsBody, setName = "", setKey = "", playerNames = new Set(), qualify = null, subsetRuns = null } = opts;
  const imgPrefixes = prefixesFromImages(html);
  const out = [];
  for (const scope of splitScopes(parallelsBody)) {
    const isPaper = scope.title == null;
    // A scope's OWN rungs stop at its first nested h4. On 2025 Bowman Draft
    // the Chrome h3 nests Geometric / Variety / Chrome Gimmicks / Etched in
    // Glass / College Variations: reading the whole body pulled those in and
    // gave Chrome 35 rungs instead of its own 24 -- including the Chrome
    // Gimmicks CARD LIST, the (a) defect one level deeper.
    const ownBody = sliceBeforeSubsections(scope.body);
    // A card list inside Parallels is a roster, never a ladder.
    const cardList = !isPaper && isCardListScope(ownBody);
    // CF-THE-EXCEPT-BLOCK-IS-NOT-THE-RULE (#1571 §3.2). The rule ladder and
    // the EXCEPT ladder are parsed SEPARATELY and never merged: the exception
    // rungs carry the players they belong to, so they reach only those rows.
    // Parsing them as one Map is what let Triple /273 (Sosa's career HR total)
    // fill the rule line's empty printRun and stamp itself on all 120 cards.
    const parts = cardList ? null : splitAtException(ownBody);
    const ruleRungs = cardList ? [] : parseLadder(parts.rule, playerNames, { requireRange: hasRangeClause(parts.rule), subsetRuns });
    const exRungs = cardList || !parts.exception ? []
      : parseLadder(parts.exception, playerNames, { players: parts.players });
    const rungs = [...ruleRungs, ...exRungs];
    rungs.rosterLines = (ruleRungs.rosterLines || 0) + (exRungs.rosterLines || 0);
    // Route the scope title through the product vocabulary. No qualifier
    // match (or no injected resolver) means it is a finish, not a product.
    const decision = !isPaper && qualify ? qualify(setKey, scope.title) : null;
    const scopeSetKey = decision && decision.setKey && decision.setKey !== setKey ? decision.setKey : setKey;
    const isOwnProduct = scopeSetKey !== setKey;
    // CF-A-REFUSED-MOVE-IS-A-RULING-NOT-A-BUG. productQualifiers REFUSES
    // bowman -> bowman-chrome on purpose (the bcp-125 "NEEDS DREW" family
    // ruling). A scraper does not get to overrule a vocabulary decision, so
    // the refusal is carried out of here and REPORTED; the scope's rows stay
    // under the paper parent until Drew rules. Chrome rungs are still not
    // folded into the paper ladder -- they keep their own prefix and their
    // own "Refractor" names, which is what D31 protects.
    const refused = decision && decision.refused && decision.refused.length ? decision.refused : null;
    // Every NON-PAPER scope gets a derivation attempt. Restricting it to
    // known products / the word "Chrome" left an unrecognised scope with
    // via="paper", which reads as "the paper numbering is correct here" --
    // a silent assumption. An unknown scope must say "unresolved" instead.
    const { prefix, via } = isPaper ? { prefix: null, via: "paper" }
      : derivePrefix(scope, html, setName, imgPrefixes);
    out.push({
      title: scope.title, setKey: scopeSetKey, isPaper, isOwnProduct, cardList, refused,
      prefix: isPaper ? null : prefix, prefixVia: isPaper ? "paper" : via,
      cards: cardList ? parseCards(ownBody) : [],
      rungs,
    });
  }
  return out;
}

/** Literal-escape a scope title for use inside a RegExp. */
const escapeRe = (s) => String(s).split("").map((ch) => (".*+?^${}()|[]\\".includes(ch) ? "\\" + ch : ch)).join("");

/**
 * The parallel name as the PRODUCT's checklist says it. A rung inside the
 * "1st Edition" scope is named "1st Edition Blue" on the page only because
 * the page is flat; once the row carries setKey bowman-draft-1st-edition the
 * edition words are the product, and repeating them in the parallel is the
 * "2020 2020 Bowman Draft" defect one level down.
 */
function rungNameInScope(name, scopeTitle) {
  if (!scopeTitle) return name;
  const strip = new RegExp("^" + escapeRe(scopeTitle) + "\\s+", "i");
  const out = String(name).replace(strip, "").trim();
  return out || name;
}

/**
 * CF-INSERTS-ARE-THEIR-OWN-PRODUCT (Drew, 2026-08-28: "let's go get those
 * checklists topps chrome, topps"). Scorecard v2's remaining unconfirmed are
 * INSERTS -- UL, RS, GC, PX, FF prefixes on 2025 Chrome -- not base cards.
 * The base scraper stopped at the Inserts heading on purpose (Class
 * Encounters #4 once overwrote Fleer #4). This reads the section SAFELY:
 * only cards whose number carries letters are emitted, because a pure number
 * inside an insert set would collide with the base set's numbering. Each
 * insert's own ladder (its <li> rungs) expands over that insert's cards
 * alone.
 */
function parseInserts(html) {
  const body = section(html, "Inserts", 2);
  if (!body) return [];
  const out = [];
  for (const m of body.matchAll(/<h3 id="([^"]+?)(?:_\d+)?">/g)) {
    const name = detag(m[1].replace(/_/g, " "));
    const sub = section(body, m[1], 3);
    if (!sub) continue;
    const cards = parseCards(sub).filter((c) => INSERT_NUM.test(c.num));
    if (!cards.length) continue;
    // The section slice begins with its own <h3>, which parseLadder's heading
    // pass would read as a rung named after the insert itself. An insert is
    // not a parallel of itself.
    const selfSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const ladder = parseLadder(sub, new Set(cards.map((c) => c.player).filter(isPersonName).map(foldName))).filter((r) => r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") !== selfSlug);
    out.push({ name, cards, ladder });
  }
  return out;
}

/**
 * CF-AN-INITIALS-CARD-NUMBER-IS-A-CARD-NUMBER (2026-09-04).
 *
 * `CARD_NUM` requires a digit or a hyphen, so a card numbered by bare initials
 * is not a card to it:
 *
 *   <li>CE Carl Erskine</li>          2005 Topps Chrome, Dem Bums Autographs
 *   <li>AR Alex Rodriguez BAT A</li>  2005 Topps Chrome, The Game Relics
 *   <li>SS Sammy Sosa</li>            1999 Black Diamond
 *
 * That numbering is the NORM for autograph and relic subsets -- the card number
 * IS the player's initials -- so the whole of 2005 Topps Chrome's autograph
 * subset read as zero cards, and its relic subset kept only the two players
 * whose numbers happened to carry a digit (AD1, AD2). Across the seven
 * committed fixtures 43 real card lines are rejected this way.
 *
 * The widening is deliberately NOT applied to CARD_NUM itself. Inside
 * §Base_Set and §Parallels a bare two-letter token is far more likely to be
 * prose or a rung fragment than a card number, and widening there would change
 * the base ladder this lane has already staged -- the exact well-formed-wrong
 * class that no only-improve sweep can later see. It applies only inside a
 * typed card-type section, where the page has already told us these lines are
 * a checklist and the initials convention holds.
 *
 * `feedback_beckett_initials_card_numbers_collide` is why this is not enough on
 * its own to identify a card: initials collide across products. It is enough to
 * READ the line; the setKey and the category carry the rest of the identity.
 */
const INITIALS_NUM = /^[A-Z]{2,6}\d{0,2}$/;
/** A relic subset states the swatch type after the name: "Alex Rodriguez BAT A". */
const SWATCH_TAIL = /\s+(?:BAT|UNI|JSY|JER|PATCH|GU|CAP|BASE|GLOVE|SHOE)(?:\s+[A-Z])?$/i;
function parseTypedCards(body) {
  const cards = [];
  for (const m of body.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const text = detag(m[1]);
    const sp = text.indexOf(" ");
    if (sp < 1) continue;
    const num = text.slice(0, sp).trim();
    if (!CARD_NUM.test(num) && !INITIALS_NUM.test(num)) continue;
    // "A: 1:15/boxes" is an odds legend, not a card: it has no player.
    let player = cleanScrapedPlayer(text.slice(sp + 1)).replace(SWATCH_TAIL, "").trim();
    // The page annotates a card the collector still has to redeem. That is a
    // fact about the COPY, never part of the player's name -- left in, every
    // Freeman auto row would carry a player of "Freddie Freeman EXCH" and no
    // parsed sale title would ever match it.
    // RC / SP are NOT stripped: the base lane keeps them, and one player must
    // be spelled one way across both lanes of the same page.
    player = player.replace(/\s+(?:EXCH|EXCHANGE|REDEMPTION)\b/gi, "").trim();
    if (!player || !/[A-Za-z]{2}/.test(player) || player.length > 60) continue;
    if (!isPersonName(player)) continue;
    cards.push({ num, player });
  }
  return cards;
}

/**
 * CF-A-SECTION-CLASS-IS-A-CARD-TYPE (Drew, 2026-09-04: "find other checklists
 * that we have this issue with").
 *
 * 2011 Topps Chrome Freddie Freeman #173 is an AUTOGRAPH. The page says so, in
 * its own §Autographs > §Autographed Rookies, with its own nine-rung ladder
 * (Refractor /499 down to Super-Fractor 1/1). The catalog had no row for it,
 * so every sale of that card orphaned onto a :auto pool with no ladder to
 * price against -- and the reason is structural rather than a parsing miss:
 * `main` sliced only Base_Set, Parallels and Inserts, and hardcoded the string
 * "false" into the isAuto column of every row it emitted. The lane could not
 * mint a signed card even in principle.
 *
 * The page's own <h2> vocabulary is the card-type vocabulary. Across the
 * fixtures it is exactly:
 *
 *   Autographs | Autographed_Rookies      -> a signed card
 *   Autographed_Relics | Autograph_Relics -> a signed card that also carries memorabilia
 *   Autographs_&_Game-Used                -> a MIXED section: see below
 *   Relics | Game-Used | Memorabilia      -> memorabilia, NOT signed
 *   Inserts                               -> today's behaviour, unchanged
 *
 * Each is read the way §Inserts already is -- h3 subsections, each holding its
 * own <li> ladder and its own <li> card list -- because that is the page's one
 * layout, not three. The class decides two things and nothing else: the
 * category prefix (`auto-` vs `insert-`) and the isAuto column.
 *
 * CF-THE-SECTION-SAYS-SIGNED-OR-IT-IS-NOT (`autos only when the source says
 * signed`). isAuto is true ONLY where the section heading attests a signature.
 * A §Relics row is emitted with isAuto=false even though it sits beside an
 * autograph section, and "Autographs & Game-Used" -- one heading over two
 * different card types -- attests signature at the SUBSECTION level instead,
 * because on 2005 Topps Chrome that h2 covers both "The Game Relics" (unsigned)
 * and "Dem Bums Autographs" (signed). Reading the h2 alone would attest 42
 * relic cards as autographed; reading the h3 gets both right. Where neither
 * heading says, the honest answer is the unsigned one: a false isAuto splits a
 * pool in half and no only-improve sweep can see it.
 */
const SECTION_CLASSES = [
  // id on the page                     category prefix   the heading attests a signature
  { id: "Autographs",                   prefix: "auto",   signed: true  },
  { id: "Autographed_Rookies",          prefix: "auto",   signed: true  },
  { id: "Autographed_Relics",           prefix: "auto",   signed: true  },
  { id: "Autograph_Relics",             prefix: "auto",   signed: true  },
  { id: "Autographed_Game-Used",        prefix: "auto",   signed: true  },
  // One heading, two card types. Signature is decided per SUBSECTION.
  { id: "Autographs_&amp;_Game-Used",   prefix: null,     signed: null  },
  { id: "Autographs_&amp;_Relics",      prefix: null,     signed: null  },
  { id: "Relics",                       prefix: "insert", signed: false },
  { id: "Game-Used",                    prefix: "insert", signed: false },
  { id: "Memorabilia",                  prefix: "insert", signed: false },
];

/** A subsection heading that names a signature in its own words. */
const SIGNED_HEADING = /\bauto(?:graph(?:ed|s)?)?\b|\bsigned\b|\bsignatures?\b|\bink\b/i;
/** A subsection heading that names memorabilia. */
const RELIC_HEADING = /\brelics?\b|\bgame[-\s]?used\b|\bmemorabilia\b|\bpatch(?:es)?\b|\bjersey\b|\bbat\b|\bcloth\b|\bthreads?\b/i;

/**
 * CF-A-PRINTING-PLATE-IS-A-ONE-OF-ONE (Drew, 2026-09-04). The page writes
 * plates as "Printing Plates (four-for-each, Hobby only)" -- four plates,
 * cyan/magenta/yellow/black, each unique. RUN_NOTE sees no serial in
 * "four-for-each", so the rung landed with a BLANK print run, which reads as
 * unknown when the page in fact states the strongest scarcity claim it can
 * make. Four plates of one card is four DIFFERENT cards at /1, never one card
 * at /4: the "four" counts colours, not copies.
 *
 * Only the plate rung is touched, and only when the page's own words say
 * one-per-colour. A plate line stating an actual serial keeps it.
 */
const PLATE_RUNG = /printing\s+plates?/i;
const PLATE_ONE_EACH = /one[-\s]?of[-\s]?one|four[-\s]?for[-\s]?each|one\s+of\s+each|four\s+per|1\/1/i;
function platePrintRun(rung) {
  if (rung.printRun != null) return rung.printRun;
  if (!PLATE_RUNG.test(rung.name)) return null;
  return PLATE_ONE_EACH.test(String(rung.note ?? "")) ? 1 : null;
}

/**
 * Read one card-type section the way parseInserts reads §Inserts.
 *
 * Returns [] when the section is absent -- a page without an Autographs
 * heading yields no autograph rows, which is the whole point: the rows come
 * from the page or they do not exist. `no synthetic parallels -- actuals only`.
 */
function parseTypedSection(html, cls) {
  // Sections are named by their h2 id by default; an autograph subset found
  // hanging off another section is sliced at its own h3 level instead.
  const level = cls.level ?? 2;
  const body = section(html, cls.id, level);
  if (!body) return [];
  const out = [];
  // CF-THE-HEADING-TEXT-NAMES-THE-SCOPE (#1700, kept through the merge). An
  // id is a SLUG of the heading and may carry a disambiguating "_2" suffix or
  // be anything at all, so naming a subset from it -- and then asking
  // SIGNED_HEADING whether that name says "autograph" -- decides "is this
  // signed?" off a value that is not the page's own words. The text is.
  const heads = level >= 3 ? []
    : [...body.matchAll(/<h3 id="([^"]+?)(?:_\d+)?">([\s\S]*?)<\/h3>/g)];
  // The h2's own name, for a section whose cards sit directly under it with no
  // h3 at all. Its slug is the subset name in that case.
  const h2Name = detag(String(cls.id).replace(/_/g, " "));
  // CF-AN-H4-IS-ITS-OWN-CARD-LIST (2026-09-04). 2005 Topps Chrome nests a
  // fourth level: §The Game Relics holds 11 cards AND an <h4>Patch</h4> holding
  // 24 DIFFERENT cards, limited to 70 copies. Read as one unit the two lists
  // concatenate -- 35 cards with AR, JB, SS, TH and MPI appearing twice, which
  // is `one card, one row, one pool` broken inside a single subset, and the
  // Patch cards silently inherit the parent's odds instead of their own /70.
  //
  // An h4 is a subset of its h3 exactly the way an h3 is a subset of its h2, so
  // it is read the same way and named for both: "The Game Relics Patch".
  const unitsFor = (name, slice) => {
    const subs = [...slice.matchAll(/<h4 id="([^"]+?)(?:_\d+)?">/g)];
    if (!subs.length) return [{ name, leaf: name, body: slice }];
    // The parent keeps whatever sits ABOVE its first h4 -- its own card list.
    const cut = slice.search(/<div class="mw-heading mw-heading4"|<h4 id=/);
    const out = [{ name, leaf: name, body: cut > 0 ? slice.slice(0, cut) : "" }];
    for (const s of subs) {
      const leaf = detag(s[1].replace(/_/g, " "));
      out.push({ name: `${name} ${leaf}`.trim(), leaf, body: section(slice, s[1], 4) });
    }
    return out;
  };
  const units = heads.length
    ? heads.flatMap((m) => unitsFor(detag(m[2]) || detag(m[1].replace(/_/g, " ")), section(body, m[1], 3)))
    : unitsFor(h2Name, body);
  for (const u of units) {
    if (!u.body) continue;
    // Same guard §Inserts uses for an UNSIGNED subset: a pure number inside a
    // relic subset would collide with the base set's numbering. The autograph
    // sections are the exception the page itself makes -- 2011 Topps Chrome's
    // Autographed Rookies ARE the base numbers (#173 Freddie Freeman signed
    // carries the same number as #173 unsigned) -- and they do not collide,
    // because the row carries isAuto=true under an auto- category, which is a
    // different card in the catalog's own terms. That is exactly the card the
    // Freeman finding was missing, so requiring a letter here would re-open it.
    // CF-A-RELIC-SUBSECTION-UNDER-AN-AUTOGRAPHS-H2-IS-STILL-A-RELIC. The h2
    // attests for the subsections that do not speak for themselves, but a
    // subsection whose OWN heading names memorabilia and says nothing about a
    // signature has spoken: "Game-Used Relics" under an Autographs h2 is 42
    // unsigned cards, and attesting them from the h2 is the same pool-splitting
    // false isAuto the mixed-heading rule below exists to prevent. The h3 can
    // only ever REFUSE the h2's attestation, never manufacture one.
    const subsectionRefusesSignature = (n) => RELIC_HEADING.test(n) && !SIGNED_HEADING.test(n);
    const signedGuess = cls.signed != null
      ? (cls.signed && !subsectionRefusesSignature(u.name))
      : SIGNED_HEADING.test(u.name);
    const cards = parseTypedCards(u.body).filter((c) => signedGuess ? true : INSERT_NUM.test(c.num));
    if (!cards.length) continue;
    // A subset is not a parallel of itself: the slice starts with its own <h3>,
    // which the ladder's heading pass would otherwise read as a rung.
    const slugOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const selfSlug = slugOf(u.leaf ?? u.name);
    // CF-AN-INITIALS-CARD-LINE-IS-NOT-A-RUNG. parseLadder's card-line defences
    // are all NUMBER-based -- CARD_NUM and leadingCardNumber both require a
    // digit -- so the very lines parseTypedCards was widened to READ come back
    // through the ladder pass as RUNGS: "CE Carl Erskine" became a parallel of
    // CE, and 5 cards x 5 "rungs" is the cross-join this file has fixed three
    // times already under three different names.
    //
    // The roster defence is the right one, applied by card number rather than
    // by name: this subsection's own card lines are known exactly, because
    // parseTypedCards just parsed them. Any rung candidate that IS one of them
    // is a card line. Nothing outside this section is affected.
    const cardLineKeys = new Set(cards.map((c) => foldName(c.num + " " + c.player)));
    const ladder = parseLadder(u.body, new Set(cards.map((c) => c.player).filter(isPersonName).map(foldName)))
      .filter((r) => slugOf(r.name) !== selfSlug)
      .filter((r) => !cardLineKeys.has(foldName(r.name)))
      // An odds legend ("A: 1:15/boxes", "B: 1:2/boxes") states which swatch
      // group a card belongs to. It is a rarity statement about the SECTION,
      // never a finish, and as a rung it lands on every card in the subset as
      // a parallel named "A". parseLadder already routed its figure to
      // `rarity`; the row itself is the part that must not exist.
      .filter((r) => !/^[A-Z]\s*:/.test(r.name.trim()) && !/^[A-Z]$/.test(r.name.trim()))
      .map((r) => ({ ...r, printRun: platePrintRun(r) }));
    // A mixed heading defers to the subsection: "Dem Bums Autographs" is
    // signed, "The Game Relics" beside it is not.
    const signed = cls.signed != null
      ? (cls.signed && !subsectionRefusesSignature(u.name))
      : SIGNED_HEADING.test(u.name) ? true
      : RELIC_HEADING.test(u.name) ? false
      : false;
    // A section class only keeps its declared prefix while its attestation
    // holds; a subsection that refused the signature takes the unsigned lane.
    const prefix = (cls.prefix != null && signed === (cls.signed === true))
      ? cls.prefix
      : (signed ? "auto" : "insert");
    out.push({ name: u.name, cards, ladder, signed, prefix });
  }
  return out;
}

/**
 * Every card-type section the page carries, in one list, deduped by the
 * (category, subset) the rows will occupy.
 *
 * Dedup matters because the page's headings NEST by design: 2011 Topps Chrome's
 * §Autographs contains §Autographed Rookies, and `section()` resolves both ids,
 * so the same 29 cards would be emitted twice under two categories. The outer
 * heading is read first and the inner one is then a re-read of ground already
 * covered -- `one card, one row, one pool`.
 */
function parseTypedSections(html) {
  const out = [];
  const seen = new Set();
  // Dedup on the CARDS a scope occupies, not on its display name. The page's
  // headings nest by design (2011 Topps Chrome's §Autographs contains
  // §Autographed Rookies) and the h3 fallback pass below deliberately re-walks
  // ground the h2 pass already covered -- keyed on the name, the same 29 cards
  // would land twice under two spellings of one heading, which is exactly the
  // split pool `one card, one row, one pool` forbids.
  const cardKey = (u) => u.prefix + ":" + u.cards.map((c) => c.num + "|" + c.player).join(",");
  const take = (units) => {
    for (const u of units) {
      const key = cardKey(u);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(u);
    }
  };
  for (const cls of SECTION_CLASSES) take(parseTypedSection(html, cls));
  // CF-AN-AUTOGRAPH-SUBSET-NEED-NOT-LIVE-UNDER-AN-AUTOGRAPHS-H2 (#1700, kept
  // through the #1703 merge). SECTION_CLASSES anchors on the page's h2
  // vocabulary, but some layouts hang "Rookie Autographs" off §Inserts with no
  // Autographs h2 above it at all. Read from the page's whole h3 set, so a
  // signed subset is found wherever the page happens to put it -- the dedup
  // above means one already read under its h2 is not read twice.
  //
  // The heading TEXT names the scope, never the id: an id is a slug and may
  // carry a disambiguating suffix, so reading it would decide "is this
  // signed?" off a value that is not the page's own words.
  for (const m of html.matchAll(/<h3 id="([^"]+?)">([\s\S]*?)<\/h3>/g)) {
    const name = detag(m[2]) || detag(String(m[1]).replace(/_/g, " "));
    if (!SIGNED_HEADING.test(name)) continue;
    take(parseTypedSection(html, { id: m[1], prefix: "auto", signed: true, level: 3 }));
  }
  return out;
}

/**
 * Scope -> product routing reuses the EXISTING D22/D23 vocabulary rather
 * than inventing a second table: productQualifiers already maps
 * bowman-draft + "1st Edition" -> bowman-draft-1st-edition and
 * bowman-draft + "Sapphire" -> bowman-draft-sapphire, and productSetKeys
 * already declares both. Loaded from dist the way the other scripts load it
 * (repair-parallel-from-title.cjs:68). When dist is absent the scraper still
 * runs -- every scope simply stays a parallel of its paper parent, which is
 * today's behaviour, and the run says so rather than silently mis-routing.
 */
function loadQualifier() {
  try {
    const backend = path.resolve(__dirname, "..");
    const { qualifiedSetKeyFromTitle } = require(path.join(backend, "dist", "services", "catalog", "productQualifiers.js"));
    return (setKey, scopeTitle) => qualifiedSetKeyFromTitle(setKey, scopeTitle);
  } catch {
    console.log("   note: dist/productQualifiers.js not built — scopes stay parallels of their paper parent (no product routing this run)");
    return null;
  }
}

/** The page title's product, as a setKey. Mirrors normalizeSetKey's shape for
 *  the flagship families this scraper fetches; the qualifier table does the
 *  rest. */
function normalizeSetKeyLocal(setName) {
  return String(setName ?? "").toLowerCase().replace(/\bbaseball\b/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function main(opts = {}) {
  // The CLI values are the DEFAULTS, not the only source: a caller (the pins,
  // above all) drives the committed emission path directly rather than
  // reimplementing it. `sport` travels with outDir and years because it is
  // the same kind of thing -- a run input that decides what lands on disk.
  const outDir = opts.outDir ?? OUT_DIR;
  const years = String(opts.years ?? YEARS);
  const titles = opts.titles ?? TITLES;
  const sport = normalizeSport(opts.sport ?? SPORT) || "baseball";
  fs.mkdirSync(outDir, { recursive: true });
  const qualify = loadQualifier();
  const [y0, y1] = years.split("-").map(Number);
  const work = [];
  // --titles ADDS pages to the per-year flagship list; it used to replace it,
  // so the 2005-2015 re-scrape (checklist B4) fetched 17 named pages and none
  // of the flagship years it was dispatched for.
  if (titles) for (const t of String(titles).split(",")) if (t.trim()) work.push(t.trim());
  // The page families holding scorecard v2's remaining unconfirmed rows.
  if (!String(opts.titlesOnly ?? arg("titlesOnly", "")).length) for (let y = y0; y <= (y1 || y0); y++) work.push(
    `${y}_Topps`, `${y}_Topps_Update`, `${y}_Topps_Chrome`, `${y}_Topps_Chrome_Update`,
    `${y}_Bowman`, `${y}_Bowman_Chrome`, `${y}_Bowman_Draft`, `${y}_Topps_Heritage`, `${y}_Panini_Prizm`,
  );

  console.log(`[bcp-ladders] ${work.length} pages  years=${years}  sport=${sport}\nout: ${outDir}\n`);
  let pages = 0, staged = 0, rows = 0, noLadder = 0, noCards = 0, unreachable = 0;

  for (const title of work) {
    const url = `http://www.baseballcardpedia.com/index.php/${title}`;
    const html = await get(url);
    await sleep(DELAY_MS);
    if (!html) { unreachable++; continue; }
    pages++;

    const year = Number((title.match(/^(\d{4})/) || [])[1]);
    const setName = title.replace(/_/g, " ").replace(/^\d{4} /, "");
    const paperSetKey = normalizeSetKeyLocal(setName);
    const base = section(html, "Base_Set", 2);
    const par = section(html, "Parallels", 2);
    const cards = parseCards(base);
    const players = new Set(cards.map((c) => c.player).filter(isPersonName).map(foldName));
    // CF-THE-H3-IS-A-PRODUCT-BOUNDARY: one ladder PER PRODUCT, not one flat
    // ladder cross-joined over the paper cards.
    // Where the page names its subsets by name rather than by card range
    // ("short set, 3000; Debuts, 2500"), resolve those names to card numbers
    // from the page's own statement of the split. {} when it does not say.
    const subsetRuns = subsetRanges(html, cards.length);
    const scopes = parseScopedLadders(par, { html, setName, setKey: paperSetKey, playerNames: players, qualify, subsetRuns });
    if (!cards.length) { noCards++; console.log(`  ${title}: 0 base cards — layout not understood, SKIPPED (not emitted)`); continue; }
    const ladderScopes = scopes.filter((s) => s.rungs.length);
    if (!ladderScopes.length) { noLadder++; console.log(`  ${title}: base ok (${cards.length}) but 0 rungs — nothing new to add`); continue; }

    // The sport is part of the product key, so it is part of the IDENTITY of
    // every file staged here -- not decoration. It comes from the run input.
    const productKey = (sk) => `${year}-${sk}-${sport}`;
    let pageRows = 0;
    const perProduct = [];
    for (const sc of scopes) {
      if (!sc.rungs.length && !sc.cardList) continue;
      if (sc.cardList) {
        // A card list inside Parallels is a roster, never a ladder: it names
        // cards of its scope and contributes ZERO parallel rows.
        console.log(`   scope "${sc.title}": card list (${sc.cards.length} cards), 0 rungs — not a ladder`);
        continue;
      }
      // CF-THE-BARE-STEM-ALWAYS-LANDS (2026-09-04, found closing #1703).
      // Decided up front because it settles TWO things that must agree: which
      // FILE this scope writes, and whether it carries the page's own inserts
      // and typed sections. See the filename note further down.
      const stemOf = (o) => productKey(o.setKey);
      const stem = stemOf(sc);
      // Only scopes that actually EMIT can hold a filename. The loop's own two
      // guards above skip a rung-less scope and a card-list scope before they
      // ever write, and on 2022 Topps Chrome the paper scope is exactly that:
      // it exists, it is `isPaper`, and it has ZERO rungs, so it was elected
      // holder of the bare stem and then never reached the write. Electing a
      // scope that cannot write is how the file came to be written by nobody.
      const emits = (o) => (o.rungs && o.rungs.length) && !o.cardList;
      const onStem = scopes.filter((o) => stemOf(o) === stem && emits(o));
      const sharesStem = onStem.length > 1;
      // Exactly one emitting scope per stem holds it: the paper scope where the
      // page has one, otherwise the first on that stem in page order (so a
      // re-scrape writes the same filename as the run before it).
      const holdsBareStem = sc === (onStem.find((o) => o.isPaper) ?? onStem[0]);
      // The page's inserts and typed sections belong to the page's own
      // product. `sc.isPaper` was the proxy for that, and it fails on a page
      // whose only paper scope never emits -- so ask the question directly,
      // of the scopes that can actually carry them.
      const carriesPageSections = sc.isPaper || (holdsBareStem && !onStem.some((o) => o.isPaper));
      // The scope's cards. Its own numbering when the page states a prefix;
      // otherwise the paper numbers, loudly flagged rather than guessed.
      let scopeCards = cards;
      if (sc.isOwnProduct || sc.prefix) {
        if (sc.prefix == null) {
          console.log(`   PREFIX UNRESOLVED ${sc.title} — the page states no card-number prefix for this scope; rows keep the paper numbers under ${sc.setKey} and are flagged in the manifest`);
        } else {
          const paperPre = (cards[0]?.num.match(/^([A-Z]{1,6})-/i) || [])[1];
          const from = paperPre ? paperPre.toUpperCase() + "-" : "";
          if (sc.prefix !== from) scopeCards = cards.map((c) => ({ ...c, num: sc.prefix + c.num.replace(/^[A-Z]{1,6}-/i, "") }));
        }
      }
      // CF-RARITY-IS-NOT-A-PRINT-RUN: `rarity` is a new OPTIONAL trailing
      // column. printRun stays serial-only; a page figure that is production
      // or odds lands here instead of being dropped. See
      // backend/docs/reference/checklist-csv-contract.md.
      const lines = ["category,cardNumber,parallel,isAuto,printRun,player,parallelNote,rarity"];
      const setRarity = extractRarity(detag(section(html, "Parallels", 2))) || null;
      for (const c of scopeCards) {
        lines.push(["base", csvEsc(c.num), "Base", "false", "", csvEsc(c.player)].join(","));
        for (const r of sc.rungs) {
          // A rung reaches a card only where the PAGE says it does: its card
          // range (#1571 §3.1) and, for an EXCEPT block, its players (§3.2).
          // Emitting outside either is the cross-join that manufactured
          // "Radiance Heroes of the Game /100" on card #1 and Sosa's career
          // home-run total on all 120 Black Diamond cards.
          if (!cardInRange(c.num, r.cardRange)) continue;
          if (r.players && r.players.length && !matchesExceptionPlayer(c.player, r.players)) continue;
          const nm = sc.isOwnProduct ? rungNameInScope(r.name, sc.title) : r.name;
          lines.push(["base", csvEsc(c.num), csvEsc(nm), "false", r.printRun ?? "", csvEsc(c.player), csvEsc(r.note ?? ""), csvEsc(r.rarity ?? setRarity ?? "")].join(","));
        }
      }
      // The page's other card-type sections belong to the page's own product,
      // never to a qualified scope -- same rule §Inserts already follows.
      //
      // CF-THE-CATEGORY-PREFIX-IS-A-HYPHEN (2026-09-04). This emitted
      // "insert:<slug>" with a COLON, and ingest-scraped-checklist.cjs accepts
      // only "base", "insert-*" and "auto-*" -- so every insert row this lane
      // has ever staged hit the `else { skipped++; continue; }` arm and was
      // dropped at the door. The section was read, the CSV was written, and the
      // catalog never saw one of them. Both branches of the ingester agree on
      // the hyphen (convertBeckettChecklistXlsx.cjs:167, :234), so the colon was
      // this file's alone. Fixing it is what makes the sections below reach the
      // catalog at all.
      let insertRows = 0, autoRows = 0, subsets = [];
      // The page's own inserts and typed sections belong to the scope that
      // holds the bare stem -- the paper scope where the page has one, and
      // otherwise the single scope that claims the page's own product name.
      // Gating on `sc.isPaper` alone dropped them entirely on a page with no
      // paper scope at all (CF-THE-BARE-STEM-ALWAYS-LANDS, below).
      if (carriesPageSections) {
        subsets = [
          ...parseInserts(html).map((i) => ({ ...i, signed: false, prefix: "insert" })),
          ...parseTypedSections(html),
        ];
        for (const sub of subsets) {
          const cat = sub.prefix + "-" + sub.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
          // The section attests the signature, so it sets isAuto for the plain
          // card AND for every rung of that card's ladder: a Gold Refractor OF
          // an autograph is still an autograph. It is never inferred from the
          // rung name -- `isAuto boundary is cardNumber, not text`.
          const auto = sub.signed ? "true" : "false";
          for (const c of sub.cards) {
            lines.push([csvEsc(cat), csvEsc(c.num), "", auto, "", csvEsc(c.player)].join(","));
            sub.signed ? autoRows++ : insertRows++;
            for (const r of sub.ladder) {
              // The same range/player scoping the base ladder obeys. A rung
              // reaches a card only where the page says it does (#1571 §3.1/§3.2).
              if (!cardInRange(c.num, r.cardRange)) continue;
              if (r.players && r.players.length && !matchesExceptionPlayer(c.player, r.players)) continue;
              lines.push([csvEsc(cat), csvEsc(c.num), csvEsc(r.name), auto, r.printRun ?? "", csvEsc(c.player), csvEsc(r.note ?? ""), csvEsc(r.rarity ?? "")].join(","));
              sub.signed ? autoRows++ : insertRows++;
            }
          }
        }
      }
      // One file per SCOPE. A scope whose product move is refused shares the
      // paper setKey, so the scope name disambiguates the FILE -- without it
      // the Chrome CSV would silently overwrite the paper one and the paper
      // ladder would vanish.
      //
      // CF-ONE-FILE-PER-SCOPE (2026-08-31). `isOwnProduct` was the wrong test
      // for "the setKey already disambiguates". SEVERAL scopes of one page can
      // route to the SAME product: 1997_Finest sends Refractors, Embossed and
      // Embossed Refractors all to `topps-finest`, so all three were
      // isOwnProduct, all three dropped the suffix, and all three wrote the
      // same path -- the run reported "3,500 rows across 3 product(s)" while
      // 1,400 reached disk and the first two scopes vanished, manifest and all.
      // That is the very failure the paragraph above describes, arriving
      // through the other door.
      //
      // The suffix is about FILENAME COLLISION, so decide it that way: a scope
      // may go bare only if no other scope of this page shares its stem.
      //
      // CF-THE-BARE-STEM-ALWAYS-LANDS (2026-09-04, found closing #1703). The
      // suffix rule above is gated on `!sc.isPaper`, which quietly assumed
      // that a page always HAS a paper scope to take the bare stem. 2022 Topps
      // Chrome has none: its two scopes are "Standard Chrome" and "Sonic",
      // both non-paper and both sharing the stem `topps-chrome`, so both took
      // a suffix and `2022-topps-chrome-baseball.csv` was never written at all.
      //
      // That is not a cosmetic filename gap. The page's inserts and its typed
      // sections are emitted under `sc.isPaper` alone -- they belong to the
      // page's own product, never to a qualified scope -- so with no paper
      // scope on the page they had nowhere to go: 260 base cards, 273
      // typed-section cards (238 of them SIGNED, including three whole
      // autograph subsets) and 145 insert cards, read from the page, counted
      // in the run summary, and written to no file. The lane reported
      // "12,480 rows across 2 product(s)" while the entire autograph and
      // insert yield of the page evaporated.
      //
      // The fix keeps the collision rule exactly as it is and adds the
      // guarantee it was missing: exactly one scope of every page takes the
      // bare stem. Where no paper scope exists to claim it, the FIRST scope on
      // the stem does -- deterministic in page order, so a re-scrape writes
      // the same filename as the run before it -- and it also becomes the
      // scope that carries the page's inserts and typed sections.
      const key = stem + (!holdsBareStem && (!sc.isOwnProduct || sharesStem)
        ? "--" + sc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "");
      if (sc.refused) for (const r of sc.refused) console.log(`   scope "${sc.title}": product move REFUSED by the vocabulary (${r.qualifier}) — ${r.reason}
     rows stay under ${sc.setKey} with prefix ${sc.prefix ?? "(paper)"}; this is a ruling for Drew, not a scraper decision`);
      fs.writeFileSync(path.join(outDir, `${key}.csv`), lines.join("\n") + "\n");
      fs.writeFileSync(path.join(outDir, `${key}.manifest.json`), JSON.stringify({
        year, sport, setKey: sc.setKey,
        // CF-THE-PARALLEL-COLUMN-IS-THE-RUNG (2026-09-04). The CSV contract
        // says a BCP manifest names this flag, and the scraper never wrote it,
        // so the ingester took its OTHER branch: derive the parallel from the
        // category slug. For a base row that is harmless (the slug is "base"),
        // which is why it went unnoticed while §Inserts was being dropped at
        // the door anyway. It stops being harmless the moment auto- and
        // insert- rows arrive, because the derivation bakes the SUBSET NAME
        // into the rung -- "Autographed Rookies" instead of "Refractor" -- and
        // then the /499 Refractor auto and the /50 Gold Refractor auto collapse
        // onto one slug that no parsed sale title can match. This lane fills
        // the parallel column from the page's own ladder; say so.
        parallelColumnAuthoritative: true,
        setName: `${year} ${setName}${sc.isOwnProduct ? " " + sc.title : ""}`,
        sourceUrl: url, scope: sc.title, scopeOfPage: setName,
        cardNumberPrefix: sc.prefix, prefixDerivedFrom: sc.prefixVia,
        prefixUnresolved: (sc.isOwnProduct || sc.prefix != null) && sc.prefix == null,
        ladder: sc.rungs.map((r) => ({ name: sc.isOwnProduct ? rungNameInScope(r.name, sc.title) : r.name, printRun: r.printRun, rarity: r.rarity ?? null })),
        // The autograph and memorabilia subsets this page states, with THEIR
        // OWN ladders -- the record that a shared-number auto exists for these
        // cards, and the print runs that belong to it rather than to the base
        // (#1700's manifest contract). It is a VIEW over `sections` below
        // rather than a second parse: after the #1700/#1703 merge there is one
        // typed-section reader, and two readers over the same headings would
        // be two answers to "is this signed?" -- the split-pool shape both
        // PRs exist to close.
        autographs: subsets
          .filter((sub) => sub.prefix === "auto" || RELIC_HEADING.test(sub.name))
          .map((sub) => ({
            name: sub.name, type: sub.signed ? "auto" : "relic", isAuto: sub.signed,
            cards: sub.cards.length,
            ladder: sub.ladder.map((r) => ({ name: r.name, printRun: r.printRun })),
          })),
        setRarity,
        // Which card-type sections this page actually carried, and how each was
        // classified. A re-acquire plan reads this to know which entries gained
        // rows without re-fetching, and an auditor reads it to check that a
        // signed row traces to a heading that said so.
        sections: subsets.map((sub) => ({ name: sub.name, category: sub.prefix, isAuto: sub.signed, cards: sub.cards.length, rungs: sub.ladder.length })),
      }, null, 1));
      pageRows += lines.length - 1;
      perProduct.push(`${sc.setKey}${sc.prefix ? " " + sc.prefix : ""} ${scopeCards.length}x${sc.rungs.length + 1}=${f(lines.length - 1)}${insertRows ? " +" + f(insertRows) + " insert" : ""}${autoRows ? " +" + f(autoRows) + " auto" : ""}`);
      staged++;
    }
    rows += pageRows;
    console.log(`  ${title}: ${f(pageRows)} rows across ${perProduct.length} product(s) — ${perProduct.join(" | ")}`);
  }

  console.log(`\npages fetched     ${pages}`);
  console.log(`  staged          ${staged}   (${f(rows)} csv rows)`);
  console.log(`  no ladder       ${noLadder}`);
  console.log(`  no base cards   ${noCards}   <- layout gap, listed above, NOT silently emitted`);
  console.log(`  unreachable     ${unreachable}`);
  console.log(`\nSTAGING ONLY — nothing written to Cosmos.`);
}

// The parsing surface is exported so the pins can run it over saved
// fixtures; `main` is exported so a run can be driven over those fixtures
// with fetch stubbed, i.e. the COMMITTED emission path is what gets checked,
// not a reimplementation of it. D33 adds the card-line guard's own helpers
// (leadingCardNumber / foldRoster / foldName): the number-prefix defences the
// scrapeBcpLaddersCardLineGuard pins drive directly.
module.exports = {
  main, normalizeSport,
  parseCards, parseLadder, parseScopedLadders, section,
  // CF-A-SECTION-CLASS-IS-A-CARD-TYPE: the typed-section reader and the
  // classification table the pins drive directly.
  parseInserts, parseTypedSection, parseTypedSections, parseTypedCards, SECTION_CLASSES, platePrintRun,
  splitScopes, derivePrefix, prefixesFromImages, prefixFromProse,
  isCardListScope, isCardLine, rungNameInScope, cleanScrapedPlayer,
  leadingCardNumber, foldRoster, foldName,
  // #1571: the print-run scoping surface — range clauses, the EXCEPT
  // boundary, and the odds guard, each pinned directly by its own test.
  parseCardRange, cardInRange, splitAtException, exceptionPlayers, parseSubsetRuns, subsetRanges,
  matchesExceptionPlayer, hasRangeClause, hasOdds, splitAnnotation, detag, spelledRun,
  // CF-RARITY-IS-NOT-A-PRINT-RUN: the descriptive companion to printRun.
  extractRarity,
};

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(1); });
}
