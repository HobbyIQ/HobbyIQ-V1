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
 * Pre-flight: a product over the ingest's explosion gate (150 distinct rungs or
 * 2,000 card numbers) is refused HERE, printed, and not written. A refusal you
 * see at convert time is a bug report; one at ingest time is a wasted budget.
 *
 * Args: --pagesDir=C:/tmp/clc-pages  --outDir=C:/tmp/clc-csv  --limit=N
 *       --years=2020-2026  --onlyXlsx / --onlyHtml
 */
const fs = require("node:fs");
const path = require("node:path");

const arg = (n, d) => { const hit = process.argv.find((a) => a.startsWith(`--${n}=`)); return hit ? hit.slice(n.length + 3) : d; };
const PAGES_DIR = arg("pagesDir", "C:/tmp/clc-pages");
const OUT_DIR = arg("outDir", "C:/tmp/clc-csv");
const LIMIT = Number(arg("limit", "0"));
const YEARS = String(arg("years", ""));
const ONLY = process.argv.includes("--onlyXlsx") ? "xlsx" : process.argv.includes("--onlyHtml") ? "html" : "";
const LIST = path.join(__dirname, "..", "data", "checklistcenter-products.json");
const PAR_MAX = 150, NUM_MAX = 2000;
const f = (n) => Number(n).toLocaleString();
const csvEsc = (s) => { const v = String(s ?? ""); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
const decodeHtml = (s) => String(s).replace(/&#8211;|&ndash;/g, "-").replace(/&#8217;|&rsquo;|&#039;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&nbsp;|\u00a0/g, " ");
const detag = (s) => decodeHtml(String(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const foldName = (s) => String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const slugify = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const PARALLEL_WORDS = new Set(["refractor","refractors","xfractor","x-fractor","fractor","prizm","prizms","mojo","wave","shimmer","foil","foilboard","holo","chrome","sapphire","superfractor","printing","plate","plates","black","gold","silver","blue","red","green","orange","purple","pink","yellow","aqua","teal","magenta","fuchsia","bronze","platinum","rainbow","atomic","lava","pattern","laser","crackle","mini","base","parallel","variation","variations","sp","ssp","auto","autograph","autographs","relic","patch","jersey","insert","inserts","checklist","1/1","numbered","border","camo","tie-dye","disco","cracked","ice","optic","velocity","hyper","speckle","sparkle","glitter","neon","negative","sepia","vintage","stock","paper","canvas","gilded","glossy","matte"]);
const isPersonName = (v) => { const t = foldName(v).split(" ").filter(Boolean); return t.length >= 2 && t.length <= 5 && !t.some((w) => PARALLEL_WORDS.has(w)) && !/^\d/.test(t[0]); };

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
  const runSrc = [name.match(/#?\s*\/\s*(\d[\d,]{0,6})\s*$/) ? name : null, note].filter(Boolean);
  for (const src of runSrc) {
    const m = String(src).match(/(?:^|\s)#?\s*\/\s*(\d[\d,]{0,6})\s*$/) || String(src).match(/^(?:#\s*)?\/?\s*(\d[\d,]{0,6})\s*(?:copies|cards|made)?\.?$/i) || String(src).match(/^(?:serial\s+)?numbered to\s*(\d[\d,]{0,6})\.?$/i) || String(src).match(/^\d+\s*\/\s*(\d[\d,]{0,6})$/);
    if (m) { printRun = Number(m[1].replace(/,/g, "")) || null; break; }
  }
  name = name.replace(/\s*#?\s*\/\s*\d[\d,]{0,6}\s*$/, "").trim();          // "Gold /50" -> "Gold", run kept
  name = name.replace(/\s+or less$/i, "").trim();                           // "Red #/99 or Less" -> "Red"
  return { name, note, printRun };
}

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

/** One ladder string ("Red #/99; Gold /50 (Hobby only); Superfractor 1/1") -> rungs. */
function parseLadderText(text, playerNames, rejected, label) {
  const out = [];
  for (const piece of String(text).split(";")) {
    const raw = piece.replace(/\s+/g, " ").trim();
    if (!raw) continue;
    const { name, note, printRun } = clean(raw);
    if (!acceptRung(name, playerNames, rejected, label)) continue;
    out.push({ name, note, printRun });
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

/** "BCP-12 Roman Anthony - Boston Red Sox" / "12 Juan Soto, Yankees" -> { num, player }. */
function parseCardLine(text) {
  const t = detag(text);
  const m = t.match(/^#?([A-Z]{0,6}-?\d{1,4}[a-z]?|[A-Z0-9]{1,6}-[A-Z0-9]{1,6})\s+(.+)$/i);
  if (!m) return null;
  const num = m[1].replace(/^#/, "");
  let rest = m[2].trim();
  const dash = rest.lastIndexOf(" - ");
  if (dash > 0) rest = rest.slice(0, dash).trim();
  const comma = rest.indexOf(",");
  if (comma > 0) rest = rest.slice(0, comma).trim();
  if (!rest || !/[A-Za-z]{2}/.test(rest) || rest.length > 60) return null;
  return { num, player: rest };
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
    const colRx = /<div[^>]*class="[^"]*csColumn[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let cm;
    while ((cm = colRx.exec(sub.body))) {
      const pRx = /<p[^>]*>([\s\S]*?)<\/p>/gi; let pm;
      while ((pm = pRx.exec(cm[1]))) for (const line of pm[1].split(/<br\s*\/?>/i)) { const c = parseCardLine(line); if (c) cards.push(c); }
    }
    if (!cards.length) continue;
    const playerNames = new Set(cards.map((c) => c.player).filter(isPersonName).map(foldName));
    const ladders = parseLadders(sub.body, playerNames, rejected);
    subsets.push({ title: sub.title, cards, ladders });
  }
  return { subsets, rejected };
}

function parseXlsx(xlsxPath, product) {
  const XLSX = require("xlsx");
  const wb = XLSX.readFile(xlsxPath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
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

function sectionSplit(setValue, sections) {
  // sections: the distinct leading words shared across many Set values (e.g. "Base", "Chrome Prospects")
  for (const sec of sections) if (setValue === sec) return { section: sec, finish: "" };
  for (const sec of sections) if (setValue.startsWith(sec + " ")) return { section: sec, finish: setValue.slice(sec.length + 1).trim() };
  return { section: setValue, finish: "" };
}

function categoryOf(section) {
  const s = slugify(section);
  if (!s || /^(base|base-set|base-cards)$/.test(s)) return "base";
  return "insert:" + s;
}

function emit(product, subsets, rejected, srcKind) {
  const rowsOut = [];
  let baseEmitted = false, refusedSubsets = 0;
  const pars = new Set(), nums = new Set(); // product-wide, for the report only -- the gate is per subset
  // CF-RIGHT-GUARD-RIGHT-SCOPE (2026-08-29, D3 dry run). Each subset's ladder
  // lands on that subset's own cards, so a product's distinct-rung count grows
  // with its insert sets (2025 Topps Series 1: 514 across ~20 sets) and says
  // nothing about a cross-join. The gate is per subset: a subset whose ladder
  // exceeds PAR_MAX rungs or whose card list exceeds NUM_MAX numbers is what a
  // roster-for-ladder mistake looks like, and only that subset is refused.
  for (const sub of subsets) {
    const category = sub.category ?? categoryOf(sub.title.replace(/^\d{4}\s+/, "").replace(/\s+(Set|Checklist)$/i, "").replace(/^[^-]*-\s*/, ""));
    const isAuto = /\b(auto|autograph|signature)/i.test(sub.title) ? "true" : "false";
    const rungs = sub.ladders.flatMap((l) => l.rungs);
    const subPars = new Set(rungs.map((r) => r.name)), subNums = new Set(sub.cards.map((c) => c.num));
    if (subPars.size > PAR_MAX || subNums.size > NUM_MAX) {
      console.log(`!! REFUSED subset ${product.sourceSlug} [${sub.title}]: distinct rungs=${subPars.size} cardNumbers=${subNums.size} (gate ${PAR_MAX}/${NUM_MAX})`);
      refusedSubsets++; continue;
    }
    for (const r of rungs) pars.add(r.name);
    for (const c of sub.cards) {
      nums.add(c.num);
      rowsOut.push([category, c.num, category === "base" ? "Base" : "", isAuto, "", c.player, ""]);
      for (const r of rungs) rowsOut.push([category, c.num, r.name, isAuto, r.printRun ?? "", c.player, r.note ?? ""]);
    }
    if (category === "base") baseEmitted = true;
  }
  if (!rowsOut.length) {
    console.log(`!! REFUSED ${product.sourceSlug}: every subset over the gate (${refusedSubsets} refused)`);
    return null;
  }
  const meta = productMeta(product);
  const stem = `${meta.year}-${meta.setKey}-${meta.sport}`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${stem}.csv`), ["category,cardNumber,parallel,isAuto,printRun,player,parallelNote", ...rowsOut.map((r) => r.map(csvEsc).join(","))].join("\n") + "\n");
  fs.writeFileSync(path.join(OUT_DIR, `${stem}.manifest.json`), JSON.stringify({ scrapedAt: new Date().toISOString(), sourceUrl: product.url, sport: meta.sport, year: meta.year, setName: product.productName ?? meta.setName, productKey: stem, setKey: meta.setKey, rowCount: rowsOut.length, parallelColumnAuthoritative: true, source: srcKind, rejected: rejected.slice(0, 50) }, null, 1));
  return { stem, rows: rowsOut.length, pars: pars.size, nums: nums.size, baseEmitted, rejected: rejected.length };
}

/** sport / year / setKey from the URL slug -- never normalizeSetKey (D6). */
function productMeta(product) {
  const slug = String(product.sourceSlug || "").replace(/-card-checklist$/, "").replace(/-checklist$/, "");
  const ym = slug.match(/^(19|20)\d{2}(?:-\d{2})?/);
  const year = product.year || (ym ? Number(ym[0].slice(0, 4)) : null);
  let rest = slug.replace(/^(19|20)\d{2}(?:-\d{2})?-/, "");
  const sportMatch = rest.match(/-(baseball|football|basketball|hockey|soccer|wrestling|golf|racing|mma|pokemon)$/);
  const sport = product.sport || (sportMatch ? sportMatch[1] : "baseball");
  if (sportMatch) rest = rest.slice(0, -sportMatch[0].length);
  return { year, sport, setKey: rest, setName: rest.replace(/-/g, " ") };
}

function main() {
  const list = JSON.parse(fs.readFileSync(LIST, "utf8"));
  let products = list.products;
  if (YEARS) { const [a, b] = YEARS.split("-").map(Number); products = products.filter((p) => p.year >= a && p.year <= (b || a)); }
  if (LIMIT) products = products.slice(0, LIMIT);
  console.log(`[clc-convert] ${f(products.length)} products  pages: ${PAGES_DIR}  out: ${OUT_DIR}\n`);
  let written = 0, refused = 0, noPage = 0, viaXlsx = 0, viaHtml = 0, rows = 0, rejectedTotal = 0;
  for (const p of products) {
    const year = String(p.year || "unknown");
    const hPath = path.join(PAGES_DIR, "html", year, `${p.sourceSlug}.html`), xPath = path.join(PAGES_DIR, "xlsx", year, `${p.sourceSlug}.xlsx`);
    let result = null;
    if (ONLY !== "html" && fs.existsSync(xPath)) {
      try {
        const x = parseXlsx(xPath, p);
        if (x) {
          const setValues = [...x.bySet.keys()];
          const firstWords = new Map();
          for (const sv of setValues) { const w = sv.split(" ").slice(0, 2).join(" "); firstWords.set(w, (firstWords.get(w) || 0) + 1); }
          const sections = [...new Set(setValues.map((sv) => { const w1 = sv.split(" ")[0]; return /^base$/i.test(w1) ? "Base" : sv.split(" ").slice(0, 2).join(" "); }))];
          const bySection = new Map();
          for (const [sv, cards] of x.bySet) {
            const { section, finish } = sectionSplit(sv, sections);
            const sec = bySection.get(section) ?? { title: section, cards: new Map(), ladders: [{ label: "xlsx", rungs: [] }], category: categoryOf(section) };
            for (const c of cards) sec.cards.set(c.num, { num: c.num, player: c.player });
            if (finish) { const { name, note, printRun } = clean(finish); const rejected = []; if (acceptRung(name, new Set([...sec.cards.values()].map((c) => c.player).filter(isPersonName).map(foldName)), rejected, "xlsx")) { if (!sec.ladders[0].rungs.some((r) => r.name === name)) sec.ladders[0].rungs.push({ name, note, printRun: printRun ?? cards[0]?.printRun ?? null }); } }
            bySection.set(section, sec);
          }
          const subsets = [...bySection.values()].map((s) => ({ title: s.title, category: s.category, cards: [...s.cards.values()], ladders: s.ladders }));
          result = emit(p, subsets, [], "xlsx");
          if (result) viaXlsx++;
        }
      } catch (e) { console.log(`   xlsx parse failed ${p.sourceSlug}: ${String(e.message).slice(0, 60)}`); }
    }
    if (!result && ONLY !== "xlsx" && fs.existsSync(hPath)) {
      const html = fs.readFileSync(hPath, "utf8");
      const { subsets, rejected } = parseHtml(html, p);
      if (subsets.length) { result = emit(p, subsets, rejected, "html"); if (result) { viaHtml++; rejectedTotal += rejected.length; } }
    }
    if (!fs.existsSync(hPath) && !fs.existsSync(xPath)) { noPage++; continue; }
    if (!result) { refused++; continue; }
    written++; rows += result.rows;
  }
  console.log(`\n[clc-convert] written=${f(written)} (xlsx ${f(viaXlsx)}, html ${f(viaHtml)})  rows=${f(rows)}  refused-or-empty=${f(refused)}  no page cached=${f(noPage)}  rung candidates rejected=${f(rejectedTotal)}`);
}

main();
