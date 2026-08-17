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
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/checklist-gap-report.cjs [--min-comps=500] [--top=60] [--json=path]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

// Sources that trace to a PUBLISHED checklist. Everything else is a vendor
// mirror or a stub derived from the very sales we are trying to match.
const CHECKLIST_SOURCES = [
  "checklist", "checklistcenter", "beckett", "baseballcardpedia", "bccp",
  "cardboardchecklist", "cardboardconnection", "hobbymonitor", "tcgdex",
  "ingest-auto-seed",
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
      comps.set(k, (comps.get(k) || 0) + 1);
      scanned++;
    }
    process.stderr.write(`\rslugs=${scanned} products=${comps.size}`);
  }
  process.stderr.write("\n");

  const ranked = [...comps.entries()].filter(([, n]) => n >= MIN).sort((a, b) => b[1] - a[1]);
  console.log(`\ncomps with a usable product : ${scanned.toLocaleString()}`);
  console.log(`distinct products            : ${comps.size.toLocaleString()}`);
  console.log(`with >= ${MIN} comps             : ${ranked.length.toLocaleString()}\n`);

  // 2. For each, how much CHECKLIST is behind it?
  const srcClause = CHECKLIST_SOURCES.map((_, i) => `STARTSWITH(c.source, @s${i})`).join(" OR ");
  const srcParams = CHECKLIST_SOURCES.map((s, i) => ({ name: `@s${i}`, value: s }));
  const gaps = [];
  let checked = 0;
  for (const [k, n] of ranked.slice(0, TOP * 4)) {
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
    gaps.push({ sport, year: Number(year), setKey, comps: n, checklistRows: chk });
    checked++;
    process.stderr.write(`\rchecked ${checked}/${Math.min(ranked.length, TOP * 4)}`);
  }
  process.stderr.write("\n");

  // Stranded = sales pointing at a product with little or nothing to match.
  const needed = gaps.filter((g) => g.checklistRows < Math.max(50, g.comps / 20))
    .sort((a, b) => b.comps - a.comps);

  console.log("PRODUCTS OUR SALES NEED A CHECKLIST FOR\n");
  console.log("    comps  checklistRows  sport       year  setKey");
  for (const g of needed.slice(0, TOP)) {
    console.log(`${String(g.comps).padStart(9)}${String(g.checklistRows).padStart(15)}  ${g.sport.padEnd(11)} ${g.year}  ${g.setKey}`);
  }
  const stranded = needed.reduce((a, g) => a + g.comps, 0);
  console.log(`\n${needed.length} products, ${stranded.toLocaleString()} sales stranded`);

  if (JSON_OUT) {
    require("node:fs").writeFileSync(JSON_OUT, JSON.stringify(needed, null, 1));
    console.log(`wrote ${JSON_OUT}`);
  }
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
