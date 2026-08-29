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
/** An insert-style number carries letters: 90CB-1, UL-7, RS-12. A pure
 *  number inside an insert section would collide with the base set. */
const INSERT_NUM = /[A-Z]/i;

/** Base-set card lines: <li>NUM NAME[, Team]</li> */
function parseCards(body) {
  const cards = [];
  for (const m of body.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const text = detag(m[1]);
    const sp = text.indexOf(" ");
    if (sp < 1) continue;
    const num = text.slice(0, sp).trim();
    if (!CARD_NUM.test(num)) continue;
    let player = text.slice(sp + 1).trim();
    const comma = player.indexOf(",");
    if (comma > 0) player = player.slice(0, comma).trim();   // strip ", Team"
    if (!player || !/[A-Za-z]{2}/.test(player) || player.length > 60) continue;
    cards.push({ num, player });
  }
  return cards;
}

const RUN_NOTE = /(?:#'?d?\s*(?:to|\/)\s*|numbered\s+to\s+|:\s*)([\d,]+)\s*(?:cop(?:y|ies))?\b|\(([\d,]+)\s*cop(?:y|ies)\)/i;
const UMBRELLA = /(parallels|factory set|retail|club set|variations?|short prints?|\bsps?\b|photo variations?|checklist)$/i;
// CF-A-PLAYER-IS-NOT-A-RUNG (2026-08-29, B4 run 2). Older set pages list
// per-player short-print and variation rosters inside the Parallels section
// as bare <li>Jimmy Rollins</li> lines; the ladder parser took every one as a
// rung, and 2008 Topps got 26 "parallels" of which 18 were players (661 rows
// each). The base list is on the same page: any rung candidate that equals a
// player name of this product is a roster line, not a rung.
const foldName = (s) => String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

function parseLadder(parallelsBody, playerNames = new Set()) {
  const rungs = new Map();
  let rosterLines = 0;
  const put = (rawName, run, rawNote) => {
    const split = splitAnnotation(rawName);
    const name = split.name, note = rawNote ?? split.note ?? null;
    run = run ?? split.run ?? null;
    const k = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!k) return;
    if (playerNames.has(foldName(name))) { rosterLines++; return; }
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
    if (CARD_NUM.test(name.split(" ")[0])) continue;          // a card line
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

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
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
    const base = section(html, "Base_Set", 2);
    const par = section(html, "Parallels", 2);
    const cards = parseCards(base);
    const ladder = parseLadder(par, new Set(cards.map((c) => c.player).filter(isPersonName).map(foldName)));
    if (ladder.rosterLines) console.log(`   ${ladder.rosterLines} roster line(s) in the Parallels section refused as rungs (player names of this set)`);
    if (!cards.length) { noCards++; console.log(`  ${title}: 0 base cards — layout not understood, SKIPPED (not emitted)`); continue; }
    if (!ladder.length) { noLadder++; console.log(`  ${title}: base ok (${cards.length}) but 0 rungs — nothing new to add`); continue; }

    const lines = ["category,cardNumber,parallel,isAuto,printRun,player,parallelNote"];
    for (const c of cards) {
      lines.push(["base", csvEsc(c.num), "Base", "false", "", csvEsc(c.player)].join(","));
      for (const r of ladder) {
        lines.push(["base", csvEsc(c.num), csvEsc(r.name), "false", r.printRun ?? "", csvEsc(c.player), csvEsc(r.note ?? "")].join(","));
      }
    }
    const inserts = parseInserts(html);
    let insertRows = 0;
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
    const key = `${year}-${setName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-baseball`;
    fs.writeFileSync(path.join(OUT_DIR, `${key}.csv`), lines.join("\n") + "\n");
    fs.writeFileSync(path.join(OUT_DIR, `${key}.manifest.json`), JSON.stringify({
      year, sport: "baseball", setName: `${year} ${setName}`, sourceUrl: url,
      ladder: ladder.map((r) => ({ name: r.name, printRun: r.printRun })),
    }, null, 1));
    staged++;
    rows += lines.length - 1;
    console.log(`  ${title}: ${cards.length} cards x ${ladder.length + 1} rungs + ${inserts.length} inserts (${f(insertRows)} rows) -> ${f(lines.length - 1)} rows`);
  }

  console.log(`\npages fetched     ${pages}`);
  console.log(`  staged          ${staged}   (${f(rows)} csv rows)`);
  console.log(`  no ladder       ${noLadder}`);
  console.log(`  no base cards   ${noCards}   <- layout gap, listed above, NOT silently emitted`);
  console.log(`  unreachable     ${unreachable}`);
  console.log(`\nSTAGING ONLY — nothing written to Cosmos.`);
}

module.exports = { parseCards, parseLadder, section };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(1); });
}
