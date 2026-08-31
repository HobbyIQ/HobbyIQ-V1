#!/usr/bin/env node
/**
 * CF-CHECKLIST-GAP-REPORT (Drew, 2026-08-16: "lets get every catalog we need
 * and ingest the FULL checklist for all of those and that way we can run it
 * daily to stay on top of it").
 *
 * Ranks every product our SALES touch by how badly its CHECKLIST is missing.
 *
 * WHY THIS AND NOT THE SEED QUEUE. catalog_seed_queue is fed by match
 * failures, and match failures are dominated by bugs rather than by absent
 * checklists — diagnosing 478 of them found only 22% genuinely missing, while
 * the top of the queue asked for 2025 Topps against 2,944,147 checklist-backed
 * rows we already had. A queue built from failures inherits the failures.
 *
 * This asks the question directly instead: for each (sport, year, setKey) that
 * real sales reference, how many CHECKLIST-BACKED catalog rows exist? A product
 * with 207,638 comps and 1,468 checklist rows is a real gap no matter what the
 * matcher thinks. That is how Donruss Optic surfaced.
 *
 * CHECKLIST-BACKED IS THE ONLY COUNT THAT MATTERS. Vendor rows inflate a key
 * that no publisher ever described — bowman-draft-chrome looked like a 23,899
 * row product until you filtered to checklist sources and it went to ZERO.
 *
 * Output is the work list, ordered by how many sales are stranded.
 *
 * CF-GAP-DIGEST-TRIAGE (Drew, 2026-08-31). The report now PERSISTS each
 * night's result as a dated artifact under backend/data/gap-reports/ and
 * diffs against the prior night, so the morning mail can say what CLOSED
 * rather than re-listing standing gaps. Same convention as the multiplier
 * artifacts: a dated file plus a `-latest.json` pointer.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/checklist-gap-report.cjs [--min-comps=500] [--top=60] [--json=path]
 *                                                 [--persist] [--history-dir=path] [--date=YYYY-MM-DD]
 *
 * --persist writes the dated artifact + latest pointer and prints the
 * night-over-night diff. It writes ONLY to the history directory; it never
 * touches the catalog.
 */

const path = require("path");
const fs = require("node:fs");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { canAdjudicate } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
const { diffGapReports, diffHeadline } = require(path.join(backend, "dist/services/catalog/gapHistory.service.js"));

function has(name) { return process.argv.includes(`--${name}`); }

/** The prior night's artifact: the newest dated file that is not today's. */
function loadPrior(dir, todayFile) {
  if (!fs.existsSync(dir)) return { gaps: null, date: null };
  const files = fs.readdirSync(dir)
    .filter((f) => /^gap-report-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== todayFile)
    .sort();
  const last = files[files.length - 1];
  if (!last) return { gaps: null, date: null };
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, last), "utf8"));
    return { gaps: doc.gaps ?? doc, date: doc.date ?? last.slice(11, 21) };
  } catch { return { gaps: null, date: null }; }
}

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

// Sources that trace to a PUBLISHED checklist.
//
// CF-CATALOG-AUTHORITY (2026-08-20): `ingest-auto-seed` USED TO BE IN THIS LIST,
// directly contradicting the comment above it. Those rows are generated from the
// very sales this report is trying to find checklists for, so counting them made
// gaps look SMALLER than they are — a product with no real checklist could appear
// covered by rows we invented from its own comps. Removed.
//
// The array survives because it builds a server-side STARTSWITH filter, which is
// far cheaper than fetching every row and judging in JS. canAdjudicate() is then
// applied per row as the actual authority, so this list can only ever narrow the
// scan, never widen what counts as evidence.
const CHECKLIST_SOURCES = [
  "checklist", "checklistcenter", "beckett", "baseballcardpedia", "bccp",
  "cardboardchecklist", "cardboardconnection", "hobbymonitor", "tcgdex",
  "checklistinsider", "almanac", "tcdb",
];

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const MIN = Number(arg("min-comps", "500"));
  const TOP = Number(arg("top", "60"));
  const JSON_OUT = arg("json", "");

  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");

  // 1. What products do our SALES actually reference, and how heavily?
  const iter = sold.items.query({
    query: "SELECT c.hobbyiqCardId FROM c WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:')",
  }, { maxItemCount: 5000 });

  const comps = new Map();
  let scanned = 0;
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources || []) {
      const p = String(r.hobbyiqCardId).split(":");
      if (p.length < 5) continue;
      const [, sport, year, setKey] = p;
      // A slug that never got a product is a different problem — the setKey
      // vocabulary — and cannot be answered by fetching a checklist.
      if (!setKey || setKey === "unknown" || !year || year === "0") continue;
      const k = `${sport}|${year}|${setKey}`;
      let e = comps.get(k);
      if (!e) { e = { n: 0, numbers: new Set() }; comps.set(k, e); }
      e.n++;
      // The card numbers our sales actually reference. This is the only
      // honest estimate we have of how big the set IS — see the coverage
      // note below.
      if (p[4]) e.numbers.add(p[4]);
      scanned++;
    }
    process.stderr.write(`\rslugs=${scanned} products=${comps.size}`);
  }
  process.stderr.write("\n");

  const ranked = [...comps.entries()].filter(([, e]) => e.n >= MIN).sort((a, b) => b[1].n - a[1].n);
  console.log(`\ncomps with a usable product : ${scanned.toLocaleString()}`);
  console.log(`distinct products            : ${comps.size.toLocaleString()}`);
  console.log(`with >= ${MIN} comps             : ${ranked.length.toLocaleString()}\n`);

  // 2. For each, how much CHECKLIST is behind it?
  const srcClause = CHECKLIST_SOURCES.map((_, i) => `STARTSWITH(c.source, @s${i})`).join(" OR ");
  const srcParams = CHECKLIST_SOURCES.map((s, i) => ({ name: `@s${i}`, value: s }));
  const gaps = [];
  let checked = 0;
  for (const [k, e] of ranked.slice(0, TOP * 4)) {
    const [sport, year, setKey] = k.split("|");
    const p = [
      { name: "@sp", value: sport },
      { name: "@y", value: Number(year) },
      { name: "@k", value: setKey },
    ];
    const { resources } = await cat.items.query({
      query: `SELECT VALUE COUNT(1) FROM c
              WHERE c.sport=@sp AND c.year=@y AND c.setKey=@k
                AND STARTSWITH(c.id,'hiq:') AND (${srcClause})`,
      parameters: [...p, ...srcParams],
    }).fetchAll();
    const chk = resources[0] || 0;
    gaps.push({
      sport, year: Number(year), setKey,
      comps: e.n,
      distinctNumbers: e.numbers.size,
      checklistRows: chk,
      coverage: e.numbers.size ? chk / e.numbers.size : 0,
    });
    checked++;
    process.stderr.write(`\rchecked ${checked}/${Math.min(ranked.length, TOP * 4)}`);
  }
  process.stderr.write("\n");

  // CF-COVERAGE-NOT-VOLUME (Drew, 2026-08-16: "lets get the gap report and
  // clean it up today").
  //
  // The first cut ranked on checklistRows < comps/20 — it assumed a checklist
  // should scale with TRADING VOLUME. It does not, and that produced a report
  // led almost entirely by vintage Topps:
  //
  //     1955 topps  25,050 comps /   259 rows  -> flagged
  //
  // 1955 Topps is a 206-card set. 259 rows is COMPLETE. It was flagged purely
  // for being heavily traded, while genuine holes sat below it.
  //
  // Coverage is the honest test: how many DISTINCT CARD NUMBERS do our sales
  // reference, and does the checklist cover them? The comps are the only
  // estimate of set size we have that does not require knowing the set — and
  // a card cannot be sold without existing, so every number they reference is
  // real.
  //
  //     1968 topps  598 distinct numbers /  60 rows  -> 0.10  REAL hole
  //     1955 topps  ~206 numbers          / 259 rows  -> 1.26  covered
  //
  // A ratio below 1 means the checklist does not even cover the cards we have
  // watched trade. Ordered by how many DISTINCT CARDS are uncovered, because
  // that is the work, not the sale count.
  const needed = gaps
    .filter((g) => g.distinctNumbers >= 25 && g.coverage < 0.9)
    .map((g) => ({ ...g, uncovered: Math.max(0, g.distinctNumbers - g.checklistRows) }))
    .sort((a, b) => b.uncovered - a.uncovered);

  console.log("PRODUCTS OUR SALES NEED A CHECKLIST FOR\n");
  console.log("    comps  cardsSeen  checklist  coverage  uncovered  sport       year  setKey");
  for (const g of needed.slice(0, TOP)) {
    console.log(
      `${String(g.comps).padStart(9)}${String(g.distinctNumbers).padStart(11)}`
      + `${String(g.checklistRows).padStart(11)}${g.coverage.toFixed(2).padStart(10)}`
      + `${String(g.uncovered).padStart(11)}  ${g.sport.padEnd(11)} ${g.year}  ${g.setKey}`);
  }
  const stranded = needed.reduce((a, g) => a + g.comps, 0);
  const cards = needed.reduce((a, g) => a + g.uncovered, 0);
  console.log(`
${needed.length} products · ${cards.toLocaleString()} cards uncovered · ${stranded.toLocaleString()} sales behind them`);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(needed, null, 1));
    console.log(`wrote ${JSON_OUT}`);
  }

  // CF-GAP-DIGEST-TRIAGE. Persist tonight's list and diff against the prior
  // night. Writes land ONLY under the history directory.
  if (has("persist")) {
    const dir = arg("history-dir", path.join(backend, "data/gap-reports"));
    const date = arg("date", new Date().toISOString().slice(0, 10));
    const todayFile = `gap-report-${date}.json`;
    const { gaps: prior, date: priorDate } = loadPrior(dir, todayFile);

    fs.mkdirSync(dir, { recursive: true });
    const doc = { date, minComps: MIN, generatedAt: new Date().toISOString(), gaps: needed };
    fs.writeFileSync(path.join(dir, todayFile), JSON.stringify(doc, null, 1));
    fs.writeFileSync(path.join(dir, "gap-report-latest.json"), JSON.stringify(doc, null, 1));
    console.log(`\npersisted ${path.join(dir, todayFile)} (+ gap-report-latest.json)`);

    const d = diffGapReports(needed, prior, priorDate);
    console.log(`\nNIGHT-OVER-NIGHT: ${diffHeadline(d)}`);
    console.log(`  closed=${d.closed.length}  new=${d.added.length}  moved=${d.changed.length}  unchanged=${d.unchanged.length}`);
    console.log(`  uncoveredClosed=${d.uncoveredClosed}  checklistRowsGained=${d.checklistRowsGained}`);
    for (const g of d.closed.slice(0, 10)) {
      console.log(`  CLOSED  ${g.sport} ${g.year} ${g.setKey} (was ${g.uncovered} uncovered)`);
    }
    for (const g of d.added.slice(0, 10)) {
      console.log(`  NEW     ${g.sport} ${g.year} ${g.setKey} (${g.uncovered} uncovered)`);
    }
    for (const c of d.changed.slice(0, 10)) {
      const s = c.uncoveredDelta <= 0 ? "" : "+";
      console.log(`  MOVED   ${c.sport} ${c.year} ${c.setKey}  uncovered ${c.uncoveredBefore}->${c.uncoveredAfter} (${s}${c.uncoveredDelta})  checklist +${c.checklistRowsDelta}`);
    }
  }
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
