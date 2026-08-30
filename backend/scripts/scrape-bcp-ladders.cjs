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

/** Slice the body between a heading id and the next heading of the same-or-higher level. */
function section(html, id, level) {
  const re = new RegExp(`<h${level} id="${id}"[\\s\\S]*?(?=<h[2-${level}] id=|$)`);
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
function cleanScrapedPlayer(raw) {
  const parts = String(raw ?? "").split(",").map((t) => t.trim()).filter(Boolean);
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

function parseLadder(parallelsBody, playerNames = new Set()) {
  const rungs = new Map();
  let rosterLines = 0;
  const put = (rawName, run, rawNote) => {
    const split = splitAnnotation(rawName);
    const name = split.name, note = rawNote ?? split.note ?? null;
    run = run ?? split.run ?? null;
    const k = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!k) return;
    if (playerNames.has(foldName(name)) || playerNames.has(foldRoster(name))) { rosterLines++; return; }
    if (!rungs.has(k)) rungs.set(k, { name, printRun: run ?? null, note });
    else { const r = rungs.get(k); if (run && !r.printRun) r.printRun = run; if (note && !r.note) r.note = note; }
  };

  // named-rung subsections; umbrella headings organize, they do not name a card
  for (const m of parallelsBody.matchAll(/<h[34] id="([^"]+?)(?:_\d+)?">/g)) {
    const name = detag(m[1].replace(/_/g, " "));
    if (/^series (one|two)/i.test(name) || UMBRELLA.test(name)) continue;
    if (name.length > 60) continue;
    const body = section(parallelsBody, m[1], m[0].includes("<h3") ? 3 : 4).slice(0, 2500);
    const run = detag(body).match(RUN_NOTE);
    const n = run ? Number((run[1] || run[2] || "").replace(/,/g, "")) : null;
    put(name, n && n >= 1 && n <= 100000 ? n : null);
  }

  // list rungs: <li>Name (note)</li>, rejecting card lines and prose
  for (const m of parallelsBody.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const text = detag(m[1]);
    if (!text || text.length > 60) continue;
    const paren = text.indexOf("(");
    const name = (paren > 0 ? text.slice(0, paren) : text).trim().replace(/[-–—:]$/, "").trim();
    if (!name || name.length > 45 || !/[A-Za-z]{2}/.test(name)) continue;
    // A card line, in either of the page's two spellings: "BD-121 Spencer
    // Torkelson" (caught by the first token) and "BD 121 Spencer Torkelson"
    // (whose first token is only the alpha prefix). CF-A-CARD-NUMBER-IS-NOT-A-RUNG.
    if (CARD_NUM.test(name.split(" ")[0]) || leadingCardNumber(name)) continue;
    const note = paren > 0 ? text.slice(paren) : "";
    const run = note.match(RUN_NOTE);
    const n = run ? Number((run[1] || run[2] || "").replace(/,/g, "")) : null;
    // an un-noted bare <li> in this section is usually prose fragment; require
    // either a note or a short multi-wordless name that reads like a rung
    if (!note && name.split(" ").length > 4) continue;
    put(name, n && n >= 1 && n <= 100000 ? n : null, note ? note.replace(/^\(|\)$/g, "").trim() || null : null);
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
  const { html = parallelsBody, setName = "", setKey = "", playerNames = new Set(), qualify = null } = opts;
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
    const rungs = cardList ? [] : parseLadder(ownBody, playerNames);
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

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const qualify = loadQualifier();
  const [y0, y1] = YEARS.split("-").map(Number);
  const work = [];
  // --titles ADDS pages to the per-year flagship list; it used to replace it,
  // so the 2005-2015 re-scrape (checklist B4) fetched 17 named pages and none
  // of the flagship years it was dispatched for.
  if (TITLES) for (const t of TITLES.split(",")) if (t.trim()) work.push(t.trim());
  // The page families holding scorecard v2's remaining unconfirmed rows.
  if (!String(arg("titlesOnly", "")).length) for (let y = y0; y <= (y1 || y0); y++) work.push(
    `${y}_Topps`, `${y}_Topps_Update`, `${y}_Topps_Chrome`, `${y}_Topps_Chrome_Update`,
    `${y}_Bowman`, `${y}_Bowman_Chrome`, `${y}_Bowman_Draft`, `${y}_Topps_Heritage`, `${y}_Panini_Prizm`,
  );

  console.log(`[bcp-ladders] ${work.length} pages  years=${YEARS}\nout: ${OUT_DIR}\n`);
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
    const scopes = parseScopedLadders(par, { html, setName, setKey: paperSetKey, playerNames: players, qualify });
    if (!cards.length) { noCards++; console.log(`  ${title}: 0 base cards — layout not understood, SKIPPED (not emitted)`); continue; }
    const ladderScopes = scopes.filter((s) => s.rungs.length);
    if (!ladderScopes.length) { noLadder++; console.log(`  ${title}: base ok (${cards.length}) but 0 rungs — nothing new to add`); continue; }

    const productKey = (sk) => `${year}-${sk}-baseball`;
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
      const lines = ["category,cardNumber,parallel,isAuto,printRun,player,parallelNote"];
      for (const c of scopeCards) {
        lines.push(["base", csvEsc(c.num), "Base", "false", "", csvEsc(c.player)].join(","));
        for (const r of sc.rungs) {
          const nm = sc.isOwnProduct ? rungNameInScope(r.name, sc.title) : r.name;
          lines.push(["base", csvEsc(c.num), csvEsc(nm), "false", r.printRun ?? "", csvEsc(c.player), csvEsc(r.note ?? "")].join(","));
        }
      }
      // Inserts belong to the page's own product, never to a qualified scope.
      let insertRows = 0, inserts = [];
      if (sc.isPaper) {
        inserts = parseInserts(html);
        for (const ins of inserts) {
          const cat = "insert:" + ins.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
          for (const c of ins.cards) {
            lines.push([csvEsc(cat), csvEsc(c.num), "", "false", "", csvEsc(c.player)].join(","));
            insertRows++;
            for (const r of ins.ladder) {
              lines.push([csvEsc(cat), csvEsc(c.num), csvEsc(r.name), "false", r.printRun ?? "", csvEsc(c.player), csvEsc(r.note ?? "")].join(","));
              insertRows++;
            }
          }
        }
      }
      // One file per SCOPE. A scope whose product move is refused shares the
      // paper setKey, so the scope name disambiguates the FILE -- without it
      // the Chrome CSV would silently overwrite the paper one and the paper
      // ladder would vanish.
      const key = productKey(sc.setKey) + (!sc.isPaper && !sc.isOwnProduct ? "--" + sc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "");
      if (sc.refused) for (const r of sc.refused) console.log(`   scope "${sc.title}": product move REFUSED by the vocabulary (${r.qualifier}) — ${r.reason}
     rows stay under ${sc.setKey} with prefix ${sc.prefix ?? "(paper)"}; this is a ruling for Drew, not a scraper decision`);
      fs.writeFileSync(path.join(OUT_DIR, `${key}.csv`), lines.join("\n") + "\n");
      fs.writeFileSync(path.join(OUT_DIR, `${key}.manifest.json`), JSON.stringify({
        year, sport: "baseball", setKey: sc.setKey,
        setName: `${year} ${setName}${sc.isOwnProduct ? " " + sc.title : ""}`,
        sourceUrl: url, scope: sc.title, scopeOfPage: setName,
        cardNumberPrefix: sc.prefix, prefixDerivedFrom: sc.prefixVia,
        prefixUnresolved: (sc.isOwnProduct || sc.prefix != null) && sc.prefix == null,
        ladder: sc.rungs.map((r) => ({ name: sc.isOwnProduct ? rungNameInScope(r.name, sc.title) : r.name, printRun: r.printRun })),
      }, null, 1));
      pageRows += lines.length - 1;
      perProduct.push(`${sc.setKey}${sc.prefix ? " " + sc.prefix : ""} ${scopeCards.length}x${sc.rungs.length + 1}=${f(lines.length - 1)}${insertRows ? " +" + f(insertRows) + " insert" : ""}`);
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
  main,
  parseCards, parseLadder, parseScopedLadders, section,
  splitScopes, derivePrefix, prefixesFromImages, prefixFromProse,
  isCardListScope, isCardLine, rungNameInScope, cleanScrapedPlayer,
  leadingCardNumber, foldRoster, foldName,
};

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(1); });
}
