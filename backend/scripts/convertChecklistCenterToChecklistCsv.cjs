#!/usr/bin/env node
/**
 * convertChecklistCenterToChecklistCsv.cjs -- checklistcenter pages -> the one
 * canonical checklist CSV.
 *
 * CF-CHECKLISTCENTER-INTO-THE-GUARDED-PIPE (checklist D3). Reads the page
 * artifacts staged by scrape-checklistcenter-products.cjs and emits, per
 * product, `<year>-<setKey>-<sport>.csv` in the format the guarded ingest
 * consumes -- `category,cardNumber,parallel,isAuto,printRun,player,parallelNote`
 * -- plus a `.manifest.json`. Nothing here touches Cosmos.
 *
 * What the old ingesters got wrong, and what this does instead:
 *   - the ladder line was split on commas as well as semicolons, so a footnote
 *     "(*No DiMaggio, Sewell, Clemente)" shredded into rungs named Sewell and
 *     Clemente  -> split on ';' only; a parenthetical ANYWHERE in a rung name
 *     goes to parallelNote (clean(), the same rule as clean-parallel-annotations);
 *   - one paragraph carrying several labelled ladders ("Prime Number Parallels:",
 *     "Aspirations Parallels:") was captured to the first </p>, swallowing every
 *     later ladder into one 170-char name  -> each <strong>...Parallels:</strong>
 *     label is captured separately, bounded at the next <strong> or </p>;
 *   - prose fragments and roster lines became rungs  -> the scrape-bcp-ladders
 *     guards: no card lines, no names over 60 chars, no umbrella headings, and
 *     no rung that equals a player of the same product (CF-A-PLAYER-IS-NOT-A-RUNG);
 *   - the XLSX "Set" cell ("Base Chrome Prospects Lava Refractor") became the
 *     whole parallel  -> the section is the category, the finish is the parallel;
 *   - "Base" was emitted twice per parallel-less subset  -> once, as the literal
 *     the checklist's base set is;
 *   - the manifest omitted setKey, so the ingest fell to normalizeSetKey and every
 *     Leaf product collapsed onto `leaf`  -> setKey comes from the URL slug.
 *
 * CF-THE-LABEL-IS-PART-OF-THE-RUNG (2026-08-29, D3b). The html path is what
 * converts the 180 pages without a workbook (2018-2020 Bowman, 2024 Leaf Metal
 * ...), and four things it did to a page's own text were measured wrong:
 *   - a ladder labelled "Refractor Parallels: Refractor #/499; Purple #/250;
 *     Gold #/50 ..." emitted bare "Purple" and "Gold". The label is the finish
 *     family and the page states it once for the whole ladder; the workbook for
 *     the same product says "Purple Refractor". A bare colour and "<Colour>
 *     Refractor" are one card and the LONG form is kept (colour = refractor
 *     ruling), so the family is appended to every rung that does not already
 *     carry a finish of its own (SuperFractor, X-Fractor, Printing Plates stay).
 *     Only a label made of finish words applies (Refractor, Prizm, Wave, Lava,
 *     RayWave, Geometric, Ice, Flash ...): "Prime Number Parallels" names an
 *     insert set, not a finish, and its rungs stay as written;
 *   - "SuperFractor 1/1" came out as "SuperFractor 1" with NO print run: the
 *     "/1" was stripped as a run suffix and never read as one. "1/1" is a print
 *     run of one;
 *   - Topps Chrome's odds footnotes carry semicolons INSIDE the parentheses
 *     ("Refractor (1:3 Hobby; 1:1 Jumbo; 1:3.5 Value)") and the split made
 *     "1:1 Jumbo" a rung. The split now happens outside parentheses only;
 *   - 14 product URLs carry the sport twice ("2020-bowman-baseball-baseball")
 *     and the setKey kept one of them (`bowman-baseball`, `leaf-metal-baseball`),
 *     so those products landed under a setKey nothing else uses. Every trailing
 *     sport word comes off.
 * And on the xlsx path, Select's "Base Set - Concourse - Gold Prizms" lost its
 * qualifier but kept the separator ("- Gold Prizms"); the separator goes too.
 *
 * Pre-flight: a product over the ingest's explosion gate (150 distinct rungs or
 * 2,000 card numbers) is refused HERE, printed, and not written. A refusal you
 * see at convert time is a bug report; one at ingest time is a wasted budget.
 *
 * Every product prints one line -- `sections`, `laddersFound`, `ladderRows`
 * (the rows a section ladder added on top of the card list; 0 on the xlsx
 * path, where every row is a published line and nothing is expanded) -- so a
 * log says what the expansion did before the ingest gate judges it.
 *
 * Args: --pagesDir=C:/tmp/clc-pages  --outDir=C:/tmp/clc-csv  --limit=N
 *       --years=2020-2026  --onlyXlsx / --onlyHtml  --report (convert, count,
 *       write nothing)
 */
const fs = require("node:fs");
const path = require("node:path");

const arg = (n, d) => { const hit = process.argv.find((a) => a.startsWith(`--${n}=`)); return hit ? hit.slice(n.length + 3) : d; };
const PAGES_DIR = arg("pagesDir", "C:/tmp/clc-pages");
const OUT_DIR = arg("outDir", "C:/tmp/clc-csv");
const LIMIT = Number(arg("limit", "0"));
const YEARS = String(arg("years", ""));
const ONLY = process.argv.includes("--onlyXlsx") ? "xlsx" : process.argv.includes("--onlyHtml") ? "html" : "";
const REPORT = process.argv.includes("--report");
// CF-THE-WORK-LIST-IS-AN-INPUT (D38, 2026-09-01). Mirrors the same override in
// scrape-checklistcenter-products.cjs: the converter must read the SAME work
// list the scraper staged, or a per-entry acquisition stages one page and then
// converts the committed 547. Unset, the behaviour is exactly what it was.
const LIST = process.env.CLC_LIST || path.join(__dirname, "..", "data", "checklistcenter-products.json");
const PAR_MAX = 150, NUM_MAX = 2000;
const f = (n) => Number(n).toLocaleString();
const csvEsc = (s) => { const v = String(s ?? ""); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
const decodeHtml = (s) => String(s).replace(/&#8211;|&ndash;/g, "-").replace(/&#8217;|&rsquo;|&#039;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&nbsp;|\u00a0/g, " ");
const detag = (s) => decodeHtml(String(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const foldName = (s) => String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const slugify = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const PARALLEL_WORDS = new Set(["refractor","refractors","xfractor","x-fractor","fractor","prizm","prizms","mojo","wave","shimmer","foil","foilboard","holo","chrome","sapphire","superfractor","printing","plate","plates","black","gold","silver","blue","red","green","orange","purple","pink","yellow","aqua","teal","magenta","fuchsia","bronze","platinum","rainbow","atomic","lava","pattern","laser","crackle","mini","base","parallel","variation","variations","sp","ssp","auto","autograph","autographs","relic","patch","jersey","insert","inserts","checklist","1/1","numbered","border","camo","tie-dye","disco","cracked","ice","optic","velocity","hyper","speckle","sparkle","glitter","neon","negative","sepia","vintage","stock","paper","canvas","gilded","glossy","matte","prismatic","crystal","super"]);
const isPersonName = (v) => { const t = foldName(v).split(" ").filter(Boolean); return t.length >= 2 && t.length <= 5 && !t.some((w) => PARALLEL_WORDS.has(w)) && !/^\d/.test(t[0]); };
const SPORTS = "baseball|football|basketball|hockey|soccer|wrestling|golf|racing|mma|pokemon";
/** Colour and finish words: a name ENDING in one names a rung, never a set or
 *  a card type ("Prizms Gold" is a finish; "Chrome Prospects", "Silver Packs"
 *  and "1991 Gold Leaf Prospects" are not). */
const RUNG_WORDS = new Set(["black","gold","silver","blue","red","green","orange","purple","pink","yellow","aqua","teal","magenta","fuchsia","bronze","platinum","white","rainbow","refractor","refractors","superfractor","xfractor","x-fractor","prizm","prizms","wave","shimmer","lava","mojo","holo","foil","foilboard","sapphire","speckle","sparkle","atomic","pulsar","ice","flash","geometric","raywave","sepia","negative","mini","plates","plate","printing","camo","disco","cracked","neon","vinyl","finite","laser","crackle","glitter","velocity","hyper","1/1"]);
const endsInRung = (v) => RUNG_WORDS.has(String(v).trim().split(" ").pop().toLowerCase());

/** name / note / printRun -- the clean-parallel-annotations rule: a parenthetical
 *  anywhere and an "Est. print run" tail are footnotes, never part of the name;
 *  a print run is taken only when the whole footnote is a print-run statement. */
function clean(raw) {
  let name = String(raw ?? ""), note = null;
  const est = name.match(/^(.*?)\s*[-\u2013\u2014]?\s*Est\.?\s*print run\b(.*)$/i);
  if (est) { note = ("Est. print run" + est[2]).trim(); name = est[1]; }
  const parens = [];
  name = name.replace(/\s*\(([^()]*)\)/g, (_, inner) => { if (inner.trim()) parens.push(inner.trim()); return " "; });
  if (parens.length) note = [parens.join("; "), note].filter(Boolean).join("; ");
  name = name.replace(/\s+/g, " ").replace(/[-\u2013\u2014:]\s*$/, "").trim();
  let printRun = null;
  // "Red #/25 or Less" (2020 Topps Series 1's auto sets): the qualifier sits
  // AFTER the run, and stripping it last left "Red #/25" with no run at all.
  name = name.replace(/\s+or less$/i, "").trim();
  // "SuperFractor 1/1", "Platinum 1/1", "Gold Vinyl 1/1": a print run of one.
  const oneOfOne = name.match(/^(.*?\S)\s+1\s*\/\s*1$/);
  if (oneOfOne) { printRun = 1; name = oneOfOne[1]; }
  // "#/-5" (2025 Topps Chrome FrozenFractor): a stray dash before the run.
  const runSrc = printRun ? [] : [name.match(/#?\s*\/\s*-?(\d[\d,]{0,6})\s*$/) ? name : null, note].filter(Boolean);
  for (const src of runSrc) {
    const m = String(src).match(/(?:^|\s)#?\s*\/\s*-?(\d[\d,]{0,6})\s*$/) || String(src).match(/^(?:#\s*)?\/?\s*(\d[\d,]{0,6})\s*(?:copies|cards|made)?\.?$/i) || String(src).match(/^(?:serial\s+)?numbered to\s*(\d[\d,]{0,6})\.?$/i) || String(src).match(/^\d+\s*\/\s*(\d[\d,]{0,6})$/);
    if (m) { printRun = Number(m[1].replace(/,/g, "")) || null; break; }
  }
  name = name.replace(/\s*#?\s*\/\s*-?\d[\d,]{0,6}\s*$/, "").trim();        // "Gold /50" -> "Gold", run kept
  return { name, note, printRun };
}

const { variationFinishOfSection, isVariationSection } = require("./lib/variationSections.cjs");

/** CF-THE-WHOLE-SECTION-NAME-REACHES-THE-AUTO-DECISION (2026-09-05). THE one
 *  vocabulary that says a checklist named a signed card, shared by every path
 *  that decides isAuto -- the html subset title, the xlsx section, the xlsx
 *  qualifier and the xlsx finish. It used to be written out four times with
 *  three different word lists, and the finish's list was the short one: it
 *  knew "auto" and "autograph" and not "signature", which is how 823 rows
 *  reading "Signature Swatches Gold Prizm" staged unsigned.
 *
 *  A whole word, always: "Signature"/"Signatures" (Panini's usual spelling),
 *  "Penmanship" (Prizm BK's), "Ink"/"Inscriptions" (Panini high end),
 *  "Signing(s)", "Autograph(s)"/"Auto(s)"/"Autographed". Whole-word only, so
 *  "Autumn" and "Inkjet" are not autographs and a substring can never mint one.
 *
 *  NOT in this list, deliberately: "Relic", "Patch", "Swatch", "Material",
 *  "Jersey", "Memorabilia". A memorabilia card is not a signed card, and a
 *  section that pairs the two ("Signature Swatches") is caught by the
 *  signature word it already carries -- never by the swatch. */
const AUTO_WORDS = /\b(auto|autos|autograph|autographs|autographed|signature|signatures|signing|signings|signed|penmanship|inscription|inscriptions|ink)\b/i;
const namesAnAuto = (text) => AUTO_WORDS.test(String(text ?? ""));

const UMBRELLA = /(parallels?|factory set|retail|club set|variations?|short prints?|\bsps?\b|photo variations?|checklist)$/i;
const CARD_LINE = /^\d+[a-z]?\s+[A-Za-z]/;
const EXCLUSION = /^\(?\*?\s*no\b/i;

/** The rung guards, applied to every candidate from either path. */
function acceptRung(name, playerNames, rejected, why) {
  if (!name) return false;
  if (name.length > 60) { rejected.push([why, "over 60 chars", name]); return false; }
  if (!/[A-Za-z]{2}/.test(name)) { rejected.push([why, "no letters", name]); return false; }
  if (CARD_LINE.test(name)) { rejected.push([why, "card line", name]); return false; }
  if (UMBRELLA.test(name) && name.split(" ").length <= 2) { rejected.push([why, "umbrella heading", name]); return false; }
  if (EXCLUSION.test(name)) { rejected.push([why, "exclusion fragment", name]); return false; }
  if (playerNames.has(foldName(name))) { rejected.push([why, "player of this product", name]); return false; }
  return true;
}

/** Split a ladder on ';' -- outside parentheses only. "Refractor (1:3 Hobby;
 *  1:1 Jumbo)" is one rung with a footnote, not three. */
function splitRungs(text) {
  const out = []; let depth = 0, cur = "";
  for (const ch of String(text)) {
    if (ch === "(") depth++; else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** The finish family a ladder label states for every rung under it.
 *  "Refractor Parallels" -> "Refractor"; "Prizms Parallels" -> "Prizm";
 *  "Ice Prizm Parallels" -> "Ice Prizm"; "Parallels" -> "" (no family);
 *  "Prime Number Parallels" -> "" (an insert set's name, not a finish). */
const FAMILY_WORDS = new Set(["refractor", "refractors", "prizm", "prizms", "wave", "raywave", "lava", "geometric", "ice", "flash", "shimmer", "holo", "foil", "pulsar", "mojo", "sapphire", "x-fractor", "xfractor", "speckle", "sparkle", "mini-diamond", "reptilian"]);
function ladderFamily(label) {
  const fam = String(label ?? "").replace(/:$/, "").replace(/\s*parallels?$/i, "").replace(/\s+/g, " ").trim();
  if (!fam) return "";
  const words = fam.toLowerCase().split(" ");
  if (!words.every((w) => FAMILY_WORDS.has(w))) return "";
  return fam.replace(/\bPrizms\b/gi, "Prizm").replace(/\bRefractors\b/gi, "Refractor");
}

/** "Gold" under "Refractor Parallels" -> "Gold Refractor". A rung that already
 *  names its finish (Refractor, SuperFractor, X-Fractor, Printing Plates, "Blue
 *  Prizm") is left as written; "Ice" under "Ice Prizm" is the family itself. */
function applyFamily(name, family) {
  if (!family || !name) return name;
  const n = name.toLowerCase(), fam = family.toLowerCase();
  if (n === fam || n.endsWith(" " + fam)) return name;
  if (fam.startsWith(n + " ")) return family;
  if (/fractor|\bplates?\b|\bprizms?\b/.test(n)) return name;
  return `${name} ${family}`;
}

/** One ladder string ("Red #/99; Gold /50 (Hobby only); Superfractor 1/1") -> rungs. */
function parseLadderText(text, playerNames, rejected, label) {
  const out = [];
  const family = ladderFamily(label);
  for (const piece of splitRungs(text)) {
    const raw = piece.replace(/\s+/g, " ").trim();
    if (!raw) continue;
    const { name, note, printRun } = clean(raw);
    if (!acceptRung(name, playerNames, rejected, label)) continue;
    out.push({ name: applyFamily(name, family), note, printRun });
  }
  return out;
}

/** Every labelled ladder in a subset body, each bounded at the next label or </p>. */
function parseLadders(body, playerNames, rejected) {
  const ladders = [];   // { label, rungs }
  const rx = /<strong>\s*([^<]*?Parallels?:?)\s*<\/strong>\s*([\s\S]*?)(?=<strong>|<\/p>)/gi;
  let m;
  while ((m = rx.exec(body))) {
    const label = detag(m[1]).replace(/:$/, "").trim();
    const text = detag(m[2]);
    if (!text) continue;
    ladders.push({ label, rungs: parseLadderText(text, playerNames, rejected, label) });
  }
  return ladders;
}

/** CF-THE-SECTION-STATES-ITS-PRINT-RUN (D3e, 2026-09-04). A checklistcenter
 *  section head is one line of the form "<N> Cards - Serial Numbered #/25",
 *  "1 Card - Serial Numbered 1/1", "26 Cards - Serial Numbered #/15 or as
 *  Noted", "18 Cards - Serial Numbered as Noted", "25 Cards - 1:16 Packs".
 *  It is the print run of every card in the section, and the converter read
 *  none of it: on 7 real high-end pages 43 of 53 Flawless sections state a
 *  run and every plain row came out with printRun blank.
 *
 *  A print run is part of the canonical id (`hiq:...:num-25`), so a blank run
 *  mints a DIFFERENT card than the numbered sale resolves to -- the orphaned
 *  auto/relic pools the census measured.
 *
 *  The readings, and what each is NOT:
 *   - "Serial Numbered #/25" / "1/1" -> 25 / 1, the section's run;
 *   - "as Noted" / "or as Noted" / "or Less" -> the run VARIES per card. The
 *     section states no run at all (`null`); each card line may carry its own
 *     (parseCardLine). "#/15 or as Noted" keeps 15 as the DEFAULT for lines
 *     that state nothing, because the page says so;
 *   - "1:16 Packs" is pack odds, never a print run;
 *   - a parenthetical ("(*No Olivares, Fulmer)") is an exclusion footnote and
 *     is read for neither.
 *  Returns { printRun, varies } -- printRun is the default for the section. */
function sectionPrintRun(headText) {
  const t = String(headText ?? "").replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return { printRun: null, varies: false };
  const sn = t.match(/\bserial\s+numbered\b([\s\S]*)$/i);
  if (!sn) return { printRun: null, varies: false };
  const tail = sn[1].trim();
  const varies = /\bas noted\b|\bor less\b/i.test(tail);
  let printRun = null;
  if (/^1\s*\/\s*1\b/.test(tail)) printRun = 1;
  else { const m = tail.match(/^#?\s*\/\s*(\d[\d,]*)/); if (m) printRun = Number(m[1].replace(/,/g, "")) || null; }
  return { printRun, varies };
}

/** The first text line of a subset body -- the "N Cards - ..." head. */
function sectionHeadLine(body) {
  const m = String(body ?? "").match(/<p[^>]*>([\s\S]*?)(?:<br\s*\/?>|<\/p>)/i);
  return m ? detag(m[1]) : "";
}

/** "BCP-12 Roman Anthony - Boston Red Sox" / "12 Juan Soto, Yankees" -> { num, player }.
 *  CF-THE-SECTION-STATES-ITS-PRINT-RUN (D3e): a line may state its OWN run
 *  after the team ("2 Aaron Judge - New York Yankees #/25", "... 1/1") --
 *  1,385 of 7,833 card lines on the probe pages do. It overrides the
 *  section's default; the section's default is not invented where the line
 *  is silent and the section states nothing. */
function parseCardLine(text) {
  const t = detag(text);
  const m = t.match(/^#?([A-Z]{0,6}-?\d{1,4}[a-z]?|[A-Z0-9]{1,6}-[A-Z0-9]{1,6})\s+(.+)$/i);
  if (!m) return null;
  const num = m[1].replace(/^#/, "");
  let rest = m[2].trim();
  let printRun = null;
  const own = rest.match(/\s(?:#\s*\/\s*(\d[\d,]*)|(1)\s*\/\s*1)\s*$/);
  if (own) { printRun = Number(String(own[1] ?? "1").replace(/,/g, "")) || 1; rest = rest.slice(0, own.index).trim(); }
  const dash = rest.lastIndexOf(" - ");
  if (dash > 0) rest = rest.slice(0, dash).trim();
  const comma = rest.indexOf(",");
  if (comma > 0) rest = rest.slice(0, comma).trim();
  if (!rest || !/[A-Za-z]{2}/.test(rest) || rest.length > 60) return null;
  return { num, player: rest, printRun };
}

function parseHtml(html, product) {
  const rejected = [];
  const subsets = [];
  const rx = /<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3[^>]*>|$)/gi;
  let m;
  const all = [];
  while ((m = rx.exec(html))) all.push({ title: detag(m[1]), body: m[2] });
  for (const sub of all) {
    const cards = [];
    const seen = new Set();
    const take = (line) => { const c = parseCardLine(line); if (!c) return; const k = c.num + "\u0000" + c.player; if (seen.has(k)) return; seen.add(k); cards.push(c); };
    const colRx = /<div[^>]*class="[^"]*csColumn[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let cm;
    while ((cm = colRx.exec(sub.body))) {
      const pRx = /<p[^>]*>([\s\S]*?)<\/p>/gi; let pm;
      while ((pm = pRx.exec(cm[1]))) for (const line of pm[1].split(/<br\s*\/?>/i)) take(line);
    }
    // CF-A-CARD-LINE-IS-A-CARD-LINE (D3e, 2026-09-04). checklistcenter serves
    // card lists in TWO markups: <p>…<br>… inside a csColumn, and one
    // <div class="cm-line"> per card. The reader knew only the first, so a
    // page written the second way lost its whole checklist SILENTLY -- the
    // subset had no cards and was dropped without a word. 2023 Panini
    // National Treasures loses 16 sections / 410 card lines that way, every
    // one of them an auto or relic parallel set (Rookie Material Signatures
    // Midnight #/25, Century Signatures Holo Gold #/15, ...). Both markups
    // are read, and a line that appears in both is taken once.
    for (const lm of sub.body.matchAll(/<div[^>]*class="[^"]*cm-line[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)) take(lm[1]);
    if (!cards.length) continue;
    const playerNames = new Set(cards.map((c) => c.player).filter(isPersonName).map(foldName));
    const ladders = parseLadders(sub.body, playerNames, rejected);
    const head = sectionPrintRun(sectionHeadLine(sub.body));
    subsets.push({ title: sub.title, cards, ladders, printRun: head.printRun, printRunVaries: head.varies });
  }
  return { subsets, rejected };
}

/** The first sheet of a CLC workbook as a 2-D array (header row first). */
function readXlsxRows(xlsxPath) {
  const XLSX = require("xlsx");
  const wb = XLSX.readFile(xlsxPath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
}

function parseXlsxRows(rows) {
  const header = (rows[0] || []).map((h) => String(h).trim().toLowerCase());
  const iSet = header.indexOf("set"), iNum = header.indexOf("number"), iName = header.indexOf("name"), iPR = header.indexOf("print run");
  if (iSet < 0 || iNum < 0 || iName < 0) return null;
  // group by Set cell; a Set cell reads "<section> <finish>"; the section is the
  // longest prefix shared by many rows of the same product (its base-set name),
  // the finish is what follows it.
  const bySet = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const setValue = String(r[iSet] ?? "").trim(), num = String(r[iNum] ?? "").trim(), player = String(r[iName] ?? "").trim();
    if (!setValue || !num || !player) continue;
    const pr = iPR >= 0 ? (String(r[iPR] ?? "").match(/\d[\d,]*/) || [null])[0] : null;
    const g = bySet.get(setValue) ?? []; g.push({ num, player, printRun: pr ? Number(String(pr).replace(/,/g, "")) : null }); bySet.set(setValue, g);
  }
  return { bySet };
}

function parseXlsx(xlsxPath) { return parseXlsxRows(readXlsxRows(xlsxPath)); }

/** CF-THE-SECTION-IS-THE-PLAIN-SET-VALUE (2026-08-30, D3c). A workbook
 *  names a section by its plain Set cell -- "Base", "Home Run Challenge Code",
 *  "Bomb Squad" -- and every parallel of it extends that cell: "Bomb Squad
 *  Blue Ice". The first cut took the first TWO words as the section, so a
 *  three-word section with no parallels became a parallel of its own first
 *  two words: 2024 Topps Series 1 emitted "Challenge Code" on every Home Run
 *  Challenge Code card and "Topps Baseball" on every Oversized 2024 Topps
 *  Baseball card, 2025 Donruss "Recollection Collection" on the 1985 Donruss
 *  Recollection Collection (23 rows under that "parallel" in Cosmos), 2025
 *  Topps Update "Image Variation" on the Golden Mirror Image Variations, and
 *  Leaf Metal "White" for Tritanium Prismatic White.
 *  Readings, in order:
 *   1. a "Base ..." value belongs to Base (the type qualifier -- "Rated
 *      Prospects", "Set - Concourse", "Paper Prospects" -- comes off per card);
 *   2. the SHORTEST other Set value that is a whole-word prefix of this one
 *      ("Stars of MLB" for "Stars of MLB Chrome Black", not the longer "Stars
 *      of MLB Chrome");
 *   3. a value other values extend heads its own section ("Signature Tunes
 *      Dual Autographs" heads "... Autographs Red"), finish blank -- a head
 *      ending in a colour or finish word needs a ladder of at least two under
 *      it ("Black Gold" heads Pink Foil / Blue Foil / ...; "Autographs Prizms
 *      Gold" beside "... Gold Vinyl" alone is a finish of "Autographs");
 *   4. with siblings under the same first two words, the words they all
 *      share, less any finish words at the end ("Tritanium" for "Tritanium
 *      Prismatic White" beside "Tritanium Prismatic Gold"; "Bowman Prospects
 *      Mega" for "... Mega Autographs Chrome Gold Mojo Refractor"; "1991 Gold
 *      Leaf Prospects" keeps its Gold; "Bursting With Talent" for Leaf's
 *      "Bursting With Talent Base Laser Black" -- the Base/Auto marker comes
 *      off below);
 *   5. alone: a "... Variation(s)" whose numbers are all base numbers is a
 *      Base finish (the variation IS the parallel); a tail of finish words
 *      after the set words is the finish ("Mega Futures" + "Chrome Mojo";
 *      "Tritanium" + "Red Flood" when other Tritanium values exist, else two
 *      set words are needed); anything else is its own section, finish blank.
 *  Returns Set value -> { section, finish }. */
function sectionsOf(setValues, numbersOf = () => []) {
  const values = [...setValues];
  const out = new Map();
  const wordsOf = (sv) => sv.split(" ");
  const isRung = (w) => PARALLEL_WORDS.has(String(w).toLowerCase());
  const byFirst = new Map(), byTwo = new Map();
  for (const sv of values) {
    const w = wordsOf(sv);
    const k1 = w[0].toLowerCase(), k2 = w.slice(0, 2).join(" ").toLowerCase();
    (byFirst.get(k1) ?? byFirst.set(k1, []).get(k1)).push(sv);
    (byTwo.get(k2) ?? byTwo.set(k2, []).get(k2)).push(sv);
  }
  const baseNums = new Set(numbersOf(values.find((v) => /^base$/i.test(v)) ?? "").map(String));
  const extensionsOf = (v) => values.filter((o) => o !== v && o.startsWith(v + " ")).length;
  const isHead = (v) => !endsInRung(v) || extensionsOf(v) >= 2;
  const split = (sv, section) => ({ section, finish: sv === section ? "" : sv.startsWith(section + " ") ? sv.slice(section.length + 1).trim() : sv });
  // CF-A-VARIATION-IS-A-CARD (D22, Drew 2026-08-30: "image variations are
  // typical in card sets, so we need to fix that"). A Set value that names a
  // variation ("Image Variations", "Image Variations SuperFractor", "Base
  // Golden Mirror Variations", "Etched in Glass Variations") is a VARIATION OF
  // the section whose numbers hold all of its numbers — the plain card it
  // varies — and its finish is the vocabulary's spelling, never blank and
  // never "Base". Measured on 29 real pages: 101 variation (section|finish)
  // keys, 30 of them emitted blank under an "insert:image-variations"
  // category — the same id as the plain card, the collision the D3c residue
  // named. The anchor is the value's own prefix section when it has one
  // ("Etched in Glass" for "Etched in Glass Variations"), else Base, else the
  // smallest containing section; with no containing section the value keeps
  // the readings below (its own section, as before).
  // The anchor is decided PER NUMBER: 2024 Bowman Chrome's "Image Variations"
  // list rookies (Base, 1–100) and prospects (Chrome Prospects, BCP-) in one
  // section, so each card folds onto the section that holds ITS number. A
  // number no section holds keeps the value's own section, as before.
  const numsCache = new Map();
  const numsOf = (v) => { let n = numsCache.get(v); if (!n) { n = new Set(numbersOf(v).map(String)); numsCache.set(v, n); } return n; };
  const plainValues = values.filter((v) => !isVariationSection(v));
  const anchorForNumber = (sv, num) => {
    const holds = (v) => v !== sv && numsOf(v).has(num);
    const prefix = plainValues.filter((v) => holds(v) && sv.toLowerCase().startsWith(v.toLowerCase() + " ")).sort((a, b) => b.length - a.length)[0];
    if (prefix) return prefix;
    const base = plainValues.find((v) => /^base$/i.test(v) && holds(v));
    if (base) return base;
    return plainValues.filter(holds).sort((a, b) => numsOf(a).size - numsOf(b).size)[0] ?? null;
  };
  for (const sv of values) {
    const w = wordsOf(sv);
    let section = null;
    if (isVariationSection(sv)) {
      const anchorByNum = new Map();
      for (const num of numsOf(sv)) { const a = anchorForNumber(sv, num); if (a) anchorByNum.set(num, { section: a, finish: variationFinishOfSection(sv, a) ?? sv }); }
      if (anchorByNum.size) {
        const counts = new Map();
        for (const { section: a } of anchorByNum.values()) counts.set(a, (counts.get(a) || 0) + 1);
        const common = [...counts.entries()].sort((p, q) => q[1] - p[1])[0][0];
        out.set(sv, { section: common, finish: variationFinishOfSection(sv, common) ?? sv, anchorByNum, own: anchorByNum.size < numsOf(sv).size ? { section: sv, finish: "" } : null });
        continue;
      }
    }
    if (/^base(\s|$)/i.test(sv)) section = "Base";
    // a head ending in a rung word needs a ladder under it: "Black Gold" heads
    // Pink Foil / Blue Foil / Green Foil ..., while "Autographs Prizms Gold"
    // listed beside "... Gold Vinyl" alone is a finish, not a section
    if (!section) for (const cand of values) if (cand !== sv && sv.startsWith(cand + " ") && isHead(cand) && (!section || cand.length < section.length)) section = cand;
    if (!section && isHead(sv) && extensionsOf(sv) > 0) section = sv;
    if (!section) {
      const group = byTwo.get(w.slice(0, 2).join(" ").toLowerCase()) ?? [sv];
      if (group.length > 1) {
        let k = 0;
        while (k < w.length && group.every((g) => wordsOf(g)[k] === w[k])) k++;
        // "... Manufactured Relic Autographs" beside "... Manufactured Relics":
        // the words part at Relic/Relics, one set and its autographed twin,
        // not a "Relic Autographs" finish of "... Manufactured"
        const sib = (x, y) => x && y && x !== y && (x + "s" === y || y + "s" === x);
        if (k < w.length && group.some((g) => sib(String(w[k]).toLowerCase(), String(wordsOf(g)[k] ?? "").toLowerCase()))) { out.set(sv, { section: sv, finish: "" }); continue; }
        // a finish word every sibling shares is still a finish ("Tritanium
        // Prismatic White" / "... Gold" share "Prismatic"); a set word that
        // happens to be a colour is not ("1991 Gold Leaf Prospects ...")
        while (k > 1 && isRung(w[k - 1])) k--;
        section = w.slice(0, Math.max(1, k)).join(" ");
      } else {
        const nums = numbersOf(sv).map(String);
        if (/variations?$/i.test(w[w.length - 1]) && nums.length && baseNums.size && nums.every((n) => baseNums.has(n))) { out.set(sv, { section: "Base", finish: sv }); continue; }
        // "Tritanium Red Flood" beside "Tritanium Prismatic ..." names its set in
        // one word; with no such sibling two set words are needed ("Black Gold"
        // is an insert set, not a Black section)
        const named = (byFirst.get(w[0].toLowerCase()) ?? []).length > 1;
        const firstRung = w.findIndex((x, i) => i >= (named ? 1 : 2) && isRung(x));
        // "Next Day Autographs" alone is the set's name, not an Autographs finish of "Next Day"
        const tail = firstRung > 0 ? w.slice(firstRung) : [];
        section = firstRung > 0 && !tail.every((x) => /^(auto|autos|autograph|autographs|autographed)$/i.test(x)) && (named || tail.every(isRung)) ? w.slice(0, firstRung).join(" ") : sv;
      }
    }
    out.set(sv, split(sv, section));
  }
  return out;
}

function sectionSplit(setValue, sections, num = null) {
  // sections: Set value -> { section, finish } (sectionsOf); a variation value
  // carries `anchorByNum` (D22) — the section that holds THIS number — and
  // `own` for numbers no plain section holds.
  const hit = sections instanceof Map ? sections.get(setValue) : null;
  if (hit) {
    if (num !== null && hit.anchorByNum) return hit.anchorByNum.get(String(num)) ?? hit.own ?? { section: hit.section, finish: hit.finish };
    return { section: hit.section, finish: hit.finish };
  }
  return { section: setValue, finish: "" };
}

function categoryOf(section) {
  const s = slugify(section);
  if (!s || /^(base|base-set|base-cards)$/.test(s)) return "base";
  // CF-A-VARIATION-IS-A-CARD (D22). Bowman Draft's html pages name the base
  // sets by stock — "Base Paper Set" (BD-) and "Base Chrome Set" (BDC-) —
  // and both are the base set; the stock lives in the number prefix. Filed
  // as inserts they minted no plain base row at all (2020 #BD-152 had ten
  // bccp parallels and no base card), and a "Base Image Variation" could
  // not anchor onto them.
  if (/^base-(paper|chrome)$/.test(s)) return "base";
  return "insert:" + s;
}

/** The html path: a subset's ladder applied to that subset's own cards.
 *  Returns the CSV rows and the counters; writes nothing. */
function convertHtml(html, product) {
  const { subsets, rejected } = parseHtml(html, product);
  if (!subsets.length) return null;
  const rowsOut = [];
  let baseEmitted = false, refusedSubsets = 0, laddersFound = 0, ladderRows = 0;
  const pars = new Set(), nums = new Set(); // product-wide, for the report only -- the gate is per subset
  // CF-RIGHT-GUARD-RIGHT-SCOPE (2026-08-29, D3 dry run). Each subset's ladder
  // lands on that subset's own cards, so a product's distinct-rung count grows
  // with its insert sets (2025 Topps Series 1: 514 across ~20 sets) and says
  // nothing about a cross-join. The gate is per subset: a subset whose ladder
  // exceeds PAR_MAX rungs or whose card list exceeds NUM_MAX numbers is what a
  // roster-for-ladder mistake looks like, and only that subset is refused.
  const plainTitle = (s) => s.title.replace(/^\d{4}\s+/, "").replace(/\s+(Set|Checklist)$/i, "").replace(/^[^-]*-\s*/, "");
  const numsOf = (s) => new Set(s.cards.map((c) => c.num));
  for (const sub of subsets) {
    let category = sub.category ?? categoryOf(plainTitle(sub));
    // CF-A-VARIATION-IS-A-CARD (D22). A subset titled "Base Image Variation
    // Set" / "Base Golden Mirror Image Variation" / "Image Variations" is the
    // VARIATION of the subset whose numbers hold all of its numbers (Base
    // first), and every one of its rows carries that finish — 2020 Bowman
    // Draft emitted these as `insert:base-image-variation` with a blank
    // parallel, the plain card's own id. "… Auto" on the title is the flag.
    const variationFinish = (variationFinishOfSection(plainTitle(sub)) ?? "").replace(/\s+(auto|autos|autograph|autographs)$/i, "").trim() || null;
    const plainSubsets = subsets.filter((o) => o !== sub && !isVariationSection(plainTitle(o)));
    const anchorFor = (num) => plainSubsets.find((o) => /^base(\s|$)/i.test(plainTitle(o)) && numsOf(o).has(num))
      ?? plainSubsets.filter((o) => numsOf(o).has(num)).sort((a, b) => numsOf(a).size - numsOf(b).size)[0] ?? null;
    const isAuto = namesAnAuto(sub.title) ? "true" : "false";
    const rungs = sub.ladders.flatMap((l) => l.rungs);
    const subPars = new Set(rungs.map((r) => r.name)), subNums = new Set(sub.cards.map((c) => c.num));
    if (subPars.size > PAR_MAX || subNums.size > NUM_MAX) {
      console.log(`!! REFUSED subset ${product.sourceSlug} [${sub.title}]: distinct rungs=${subPars.size} cardNumbers=${subNums.size} (gate ${PAR_MAX}/${NUM_MAX})`);
      refusedSubsets++; continue;
    }
    laddersFound += sub.ladders.length;
    for (const r of rungs) pars.add(r.name);
    for (const c of sub.cards) {
      nums.add(c.num);
      // a variation subset's card sits on the subset that holds ITS number
      const anchor = variationFinish ? anchorFor(c.num) : null;
      const cat = anchor ? (anchor.category ?? categoryOf(plainTitle(anchor))) : category;
      const finish = anchor ? variationFinish : null;
      // CF-THE-SECTION-STATES-ITS-PRINT-RUN (D3e). The plain row's run is the
      // card's own where the line states one, else the section's default.
      // "as Noted" with no default states nothing, and nothing is invented.
      // A ladder rung states its own run for the whole rung and keeps it; a
      // rung silent about its run inherits nothing -- a "Gold" under a #/25
      // section is not itself /25 unless the page says so.
      const plainRun = c.printRun ?? sub.printRun ?? "";
      rowsOut.push([cat, c.num, finish ?? (cat === "base" ? "Base" : ""), isAuto, plainRun, c.player, ""]);
      for (const r of rungs) { rowsOut.push([cat, c.num, finish ? `${finish} ${r.name}` : r.name, isAuto, r.printRun ?? "", c.player, r.note ?? ""]); ladderRows++; }
    }
    if (category === "base") baseEmitted = true;
  }
  if (!rowsOut.length) {
    console.log(`!! REFUSED ${product.sourceSlug}: every subset over the gate (${refusedSubsets} refused)`);
    return null;
  }
  return { rows: rowsOut, rejected, stats: { sections: subsets.length, laddersFound, ladderRows, refusedSubsets, pars: pars.size, nums: nums.size, baseEmitted } };
}

/** Write the canonical CSV + manifest for one product. Shared by the html
 *  path (a ladder applied to a subset's cards) and the xlsx path (one row per
 *  published line). */
function writeOut(product, rowsOut, rejected, srcKind, stats) {
  const meta = productMeta(product);
  const stem = `${meta.year}-${meta.setKey}-${meta.sport}`;
  if (!REPORT) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, `${stem}.csv`), ["category,cardNumber,parallel,isAuto,printRun,player,parallelNote", ...rowsOut.map((r) => r.map(csvEsc).join(","))].join("\n") + "\n");
    fs.writeFileSync(path.join(OUT_DIR, `${stem}.manifest.json`), JSON.stringify({ scrapedAt: new Date().toISOString(), sourceUrl: product.url, sport: meta.sport, year: meta.year, setName: product.productName ?? meta.setName, productKey: stem, setKey: meta.setKey, rowCount: rowsOut.length, parallelColumnAuthoritative: true, source: srcKind, sections: stats.sections, laddersFound: stats.laddersFound, ladderRows: stats.ladderRows, rejected: rejected.slice(0, 50) }, null, 1));
  }
  return { stem, rows: rowsOut.length, ...stats, rejected: rejected.length };
}

/** sport / year / setKey from the URL slug -- never normalizeSetKey (D6).
 *  Every trailing sport word comes off: "2020-bowman-baseball-baseball" is
 *  `bowman`, not `bowman-baseball`. */
function productMeta(product) {
  const slug = String(product.sourceSlug || "").replace(/-card-checklist$/, "").replace(/-checklist$/, "");
  const ym = slug.match(/^(19|20)\d{2}(?:-\d{2})?/);
  const year = product.year || (ym ? Number(ym[0].slice(0, 4)) : null);
  let rest = slug.replace(/^(19|20)\d{2}(?:-\d{2})?-/, "");
  const sportRx = new RegExp(`-(${SPORTS})$`);
  let sport = product.sport || null;
  for (let m = rest.match(sportRx); m; m = rest.match(sportRx)) { sport = sport || m[1]; rest = rest.slice(0, -m[0].length); }
  return { year, sport: sport || "baseball", setKey: rest, setName: rest.replace(/-/g, " ") };
}

/** CF-THE-XLSX-ALREADY-SAYS-WHICH-CARD (2026-08-29, D3 dry run #4). A CLC
 *  xlsx is the manufacturer's own list: every row is one (card, finish) pair.
 *  The first converter grouped rows by section, pooled every finish seen in
 *  the section into one ladder and multiplied it onto every card -- a
 *  cross-join it built itself: 2025 Topps Series 1 base became 350 cards x 360
 *  "rungs" ("Team Card Holo Foil" on Mike Trout #1), 2026 Bowman base #1 got
 *  "Chrome Prospects Gold Refractor" and BCP-1 got "Gold Pattern Refractor".
 *  So: one CSV row per xlsx line, nothing multiplied, no count gate (nothing
 *  can explode). Two per-card rules on the finish text:
 *   - a TYPE qualifier is stripped: when a card's finishes are "Future Stars",
 *     "Future Stars Gold /2025", ... the bare label every other finish extends
 *     is the card's type (Future Stars, Chrome Prospects, Paper Prospects),
 *     not a parallel; the bare one is the base version, the rest lose the
 *     prefix. Without a bare label, the longest common leading words are
 *     stripped only when none of them is a parallel word ("Gold Refractor" /
 *     "Gold Shimmer Refractor" keep their Gold).
 *   - auto comes from the finish as well as the section: "Auto Silver
 *     Prismatic" (Leaf) / "... Retail Autographs Purple Border" mark the row
 *     isAuto and lose the auto word from the parallel name.
 *  Returns the CSV rows and the counters; writes nothing. */
function convertXlsx(rows2d, product) {
  const x = parseXlsxRows(rows2d);
  if (!x) return null;
  const setValues = [...x.bySet.keys()];
  const sections = sectionsOf(setValues, (sv) => (x.bySet.get(sv) ?? []).map((c) => c.num));
  // (section, num) -> { player, category, finishes: [{ name, note, printRun }] }
  const byCard = new Map();
  for (const [sv, cards] of x.bySet) {
    for (const c of cards) {
      const { section, finish } = sectionSplit(sv, sections, c.num);
      const category = categoryOf(section);
      const sectionAuto = namesAnAuto(section);
      const key = section + "\u0000" + c.num;
      const card = byCard.get(key) ?? { section, category, sectionAuto, num: c.num, player: c.player, finishes: [] };
      if (finish) { const { name, note, printRun } = clean(finish); card.finishes.push({ name, note, printRun: printRun ?? c.printRun ?? null }); }
      else card.finishes.push({ name: "", note: null, printRun: c.printRun ?? null });
      byCard.set(key, card);
    }
  }
  const rowsOut = [];
  const pars = new Set(), nums = new Set();
  let baseEmitted = false;
  const AUTO_RX = /^(auto|autos|autograph|autographs)\s+|\s+(auto|autos|autograph|autographs)$/i;
  for (const card of byCard.values()) {
    const names = card.finishes.map((r) => r.name);
    const nonEmpty = names.filter(Boolean);
    // rule 1: a bare label every other finish extends
    // the bare label MOST other finishes extend (BCP-1 carries 64 "Chrome
    // Prospects ..." and 20 "Mega Chrome Prospects ...": the mega-box family
    // keeps its own name, the card type still comes off the rest)
    const extendsOf = (t) => nonEmpty.filter((o) => o !== t && o.startsWith(t + " ")).length;
    // a label ending in a rung word is a finish, not a type: "Prizms Gold"
    // beside "Prizms Gold Vinyl" must not turn Gold Vinyl into "Vinyl" (2025
    // Prizm Prospect Dual Autographs). Chrome Prospects / Paper Prospects /
    // Chrome Base Silver Packs (2022 Update) stay types.
    const isType = (t) => !RUNG_WORDS.has(t.split(" ").pop().toLowerCase());
    let qualifier = nonEmpty.length > 1 ? (nonEmpty.filter((t) => isType(t) && extendsOf(t) * 2 >= nonEmpty.length - 1).sort((p, q) => extendsOf(q) - extendsOf(p))[0] ?? null) : null;
    // rule 2: longest common leading words, none of them a parallel word
    if (!qualifier && nonEmpty.length > 1) {
      const words = nonEmpty.map((n) => n.split(" "));
      let k = 0;
      while (words.every((w) => w.length > k + 1 && w[k] === words[0][k])) k++;
      if (k > 0) { const lead = words[0].slice(0, k); if (!lead.some((w) => PARALLEL_WORDS.has(w.toLowerCase()))) qualifier = lead.join(" "); }
    }
    nums.add(card.num);
    for (const r of card.finishes) {
      let name = r.name;
      // "Set - Concourse - Gold Prizms" minus its qualifier "Set - Concourse" is
      // "Gold Prizms", not "- Gold Prizms": the separator goes with it.
      if (qualifier && !isVariationSection(name)) name = name === qualifier ? "" : name.startsWith(qualifier + " ") ? name.slice(qualifier.length + 1).replace(/^[-\u2013\u2014:]\s*/, "") : name;
      // CF-THE-WHOLE-SECTION-NAME-REACHES-THE-AUTO-DECISION (2026-09-05, the
      // defect #1823 pinned). The flag was read off the SECTION and the
      // qualifier only, and the word that says the card is signed does not
      // always survive into either. 2022 Panini Select publishes "Jumbo Rookie
      // Signature Swatches Gold Prizm": sectionsOf splits it CORRECTLY -- "Jumbo
      // Rookie" is the section, "Signature Swatches Gold Prizm" is the finish --
      // so no word was truncated off the page; the auto word simply ended up on
      // the side of the split nobody asked. 823 rows whose parallel literally
      // reads "Signature Swatches Gold Prizm" staged isAuto=false: autographs
      // minted as unsigned twins of themselves, on the one axis no only-improve
      // pass can ever see, because every other column is well-formed.
      //
      // The finish path did have two rules of its own, but its vocabulary was a
      // strict SUBSET of the section's -- it never knew the word "signature".
      // So this is not a new heuristic; it is the SAME vocabulary applied to the
      // same sentence the checklist wrote. The flag is raised from the whole Set
      // value -- section AND finish -- however sectionsOf happened to cut it.
      //
      // FLAGGING IS NOT STRIPPING. AUTO_RX below still removes only a bare
      // leading/trailing auto word; "Signature Swatches" is the name of a
      // memorabilia family and stays in the parallel verbatim. Widening the flag
      // while leaving the name alone is deliberate: the CHECKLIST decides the
      // flag (feedback_isauto_boundary_is_cardnumber_not_text), and the
      // checklist's own words stay the checklist's own words.
      // Read `r.name` -- the finish AS PUBLISHED -- not the `name` the qualifier
      // strip has already shortened. Both are checked anyway, but reading the
      // unstripped text means the flag can never depend on where a LATER
      // cosmetic rule happened to cut, which is the whole shape of this bug.
      let isAuto = card.sectionAuto || namesAnAuto(r.name) || namesAnAuto(name)
        || (qualifier ? namesAnAuto(qualifier) : false);
      if (AUTO_RX.test(name)) { isAuto = true; name = name.replace(AUTO_RX, "").trim(); }
      // a finish that is only the auto word ("2023 Greatest Hits Autographs"
      // under "2023 Greatest Hits") marks the row auto and names no parallel
      if (/^(auto|autos|autograph|autographs)$/i.test(name)) { isAuto = true; name = ""; }
      // Leaf writes the plain/auto marker INTO the finish ("Base Laser Black"
      // beside "Auto Laser Black"): "Base" leading a finish is that marker,
      // never a parallel word, and the parallel is what follows it.
      if (/^base\s+\S/i.test(name)) name = name.replace(/^base\s+/i, "").trim();
      // (the old trailing `/autograph/i.test(name)` catch-all is gone: it was a
      // second, narrower spelling of the flag rule, and namesAnAuto above now
      // reads the same text with the whole vocabulary. One rule, one place.)
      if (!name) name = card.category === "base" ? "Base" : "";
      if (name) pars.add(name);
      rowsOut.push([card.category, card.num, name, isAuto ? "true" : "false", r.printRun ?? "", card.player, r.note ?? ""]);
    }
    if (card.category === "base") baseEmitted = true;
  }
  if (!rowsOut.length) return null;
  return { rows: rowsOut, rejected: [], stats: { sections: new Set([...sections.values()].map((v) => v.section)).size, laddersFound: 0, ladderRows: 0, refusedSubsets: 0, pars: pars.size, nums: nums.size, baseEmitted } };
}

function main() {
  const list = JSON.parse(fs.readFileSync(LIST, "utf8"));
  let products = list.products;
  if (YEARS) { const [a, b] = YEARS.split("-").map(Number); products = products.filter((p) => p.year >= a && p.year <= (b || a)); }
  if (LIMIT) products = products.slice(0, LIMIT);
  console.log(`[clc-convert] ${f(products.length)} products  pages: ${PAGES_DIR}  out: ${REPORT ? "(report only, nothing written)" : OUT_DIR}\n`);
  let written = 0, refused = 0, noPage = 0, viaXlsx = 0, viaHtml = 0, rows = 0, rejectedTotal = 0, ladderRowsTotal = 0;
  for (const p of products) {
    const year = String(p.year || "unknown");
    const hPath = path.join(PAGES_DIR, "html", year, `${p.sourceSlug}.html`), xPath = path.join(PAGES_DIR, "xlsx", year, `${p.sourceSlug}.xlsx`);
    let result = null, srcKind = "";
    if (ONLY !== "html" && fs.existsSync(xPath)) {
      try {
        const out = convertXlsx(readXlsxRows(xPath), p);
        if (out) { result = writeOut(p, out.rows, out.rejected, "xlsx", out.stats); srcKind = "xlsx"; viaXlsx++; }
      } catch (e) { console.log(`   xlsx parse failed ${p.sourceSlug}: ${String(e.message).slice(0, 60)}`); }
    }
    if (!result && ONLY !== "xlsx" && fs.existsSync(hPath)) {
      const out = convertHtml(fs.readFileSync(hPath, "utf8"), p);
      if (out) { result = writeOut(p, out.rows, out.rejected, "html", out.stats); srcKind = "html"; viaHtml++; rejectedTotal += out.rejected.length; }
    }
    if (!fs.existsSync(hPath) && !fs.existsSync(xPath)) { noPage++; continue; }
    if (!result) { refused++; continue; }
    written++; rows += result.rows; ladderRowsTotal += result.ladderRows;
    console.log(`  ${result.stem.padEnd(48)} ${srcKind.padEnd(4)} rows=${String(f(result.rows)).padStart(8)}  sections=${String(result.sections).padStart(3)}  laddersFound=${String(result.laddersFound).padStart(3)}  ladderRows=${String(f(result.ladderRows)).padStart(8)}  rungs=${result.pars}  numbers=${result.nums}${result.refusedSubsets ? `  REFUSED subsets=${result.refusedSubsets}` : ""}`);
  }
  console.log(`\n[clc-convert] ${REPORT ? "would write" : "written"}=${f(written)} (xlsx ${f(viaXlsx)}, html ${f(viaHtml)})  rows=${f(rows)}  ladderRows=${f(ladderRowsTotal)}  refused-or-empty=${f(refused)}  no page cached=${f(noPage)}  rung candidates rejected=${f(rejectedTotal)}`);
}

module.exports = { namesAnAuto, AUTO_WORDS, clean, splitRungs, ladderFamily, applyFamily, sectionPrintRun, sectionHeadLine, parseCardLine, parseLadderText, parseLadders, parseHtml, convertHtml, parseXlsxRows, readXlsxRows, parseXlsx, convertXlsx, sectionsOf, sectionSplit, productMeta, categoryOf };

if (require.main === module) main();
