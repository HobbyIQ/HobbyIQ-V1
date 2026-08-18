#!/usr/bin/env node
/**
 * CF-PARALLEL-PRINTRUN-CONSISTENCY (Drew, 2026-08-18: "make sure the print run
 * matches the color parallel too").
 *
 * Within one product and year, a colour parallel has ONE print run. 2024
 * Bowman Draft Chrome Blue Refractor is /150 for every card in the set; Orange
 * is /25, Green /99, Yellow /75, Gold Wave /50. So if a handful of rows on a
 * colour disagree with the rest of that colour, those rows are a parse error,
 * not a rarer card.
 *
 * WHY THIS IS A DIFFERENT QUESTION FROM THE MERGE.
 * merge-unambiguous-printrun asks "is this unnumbered sale the same card as
 * that numbered one?" and is careful never to cross colours. This asks the
 * reverse: "given the colour, is the print run we recorded even possible?" A
 * row can pass the merge and still be wrong here — e.g. blue-refractor:num-99
 * sits in its own consistent-looking pool while being a mis-parsed /150.
 *
 * THE TEST IS RELATIVE, NOT A HARDCODED LADDER. Print runs vary by year and
 * product, and a hardcoded table would rot and would violate the empirical-only
 * doctrine. Instead each (sport, year, setKey, parallel) votes: if one print
 * run holds the large majority of the cards in that group, the stragglers are
 * suspect. A group with a genuine 50/50 split is NOT reported, because that is
 * how a real two-serial parallel looks and guessing there would be worse than
 * silence.
 *
 * COUNTS CARDS, NOT SALES. One popular card with 400 sales must not outvote
 * forty cards with one sale each — the question is what the SET does, so each
 * distinct cardNumber contributes one vote per print run it appears under.
 *
 * READ-ONLY. It reports; it never rewrites a print run. Repair would mean
 * deciding a card's identity from a majority vote, which is exactly the kind
 * of confident guess slugGuard exists to prevent.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-parallel-printrun-consistency.cjs \
 *     [--year=2024] [--minCards=8] [--dominance=0.85] [--top=30]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const YEAR = arg("year", "");
const MIN_CARDS = Number(arg("minCards", "8"));
const DOMINANCE = Number(arg("dominance", "0.85"));
const TOP = Number(arg("top", "30"));

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  const where = ["IS_DEFINED(c.hobbyiqCardId)", "NOT IS_NULL(c.hobbyiqCardId)"];
  if (YEAR) where.push(`c.cardYear = ${Number(YEAR)}`);
  const iter = sold.items.query(
    `SELECT c.hobbyiqCardId FROM c WHERE ${where.join(" AND ")}`,
    { maxItemCount: 2000 },
  );

  // group "sport|year|setKey|parallel" -> printRun -> Set(cardNumber)
  const groups = new Map();
  let scanned = 0;

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources || []) {
      scanned++;
      const p = String(r.hobbyiqCardId).split(":");
      if (p.length < 8) continue;                  // only numbered rows vote
      const run = p[7];
      if (!/^num-\d+$/.test(run)) continue;
      const key = `${p[1]}|${p[2]}|${p[3]}|${p[5]}`;
      let byRun = groups.get(key);
      if (!byRun) groups.set(key, (byRun = new Map()));
      let cards = byRun.get(run);
      if (!cards) byRun.set(run, (cards = new Set()));
      cards.add(p[4]);                             // count CARDS, not sales
    }
    if (scanned % 250000 < 2000) process.stderr.write(`\r  scanned=${scanned} groups=${groups.size}   `);
  }
  process.stderr.write("\n");

  const findings = [];
  for (const [key, byRun] of groups) {
    if (byRun.size < 2) continue;                  // one print run = consistent
    const runs = [...byRun.entries()].map(([run, cards]) => ({ run, n: cards.size }))
      .sort((a, b) => b.n - a.n);
    const total = runs.reduce((s, r) => s + r.n, 0);
    if (total < MIN_CARDS) continue;
    const share = runs[0].n / total;
    if (share < DOMINANCE) continue;               // genuine multi-serial parallel
    findings.push({ key, dominant: runs[0], odd: runs.slice(1), total, share });
  }
  findings.sort((a, b) => (b.dominant.n - a.dominant.n));

  console.log(`\nscanned=${scanned} groups=${groups.size}`);
  console.log(`suspect groups (one print run holds >=${(DOMINANCE * 100).toFixed(0)}% of cards, others look mis-parsed): ${findings.length}\n`);
  for (const f of findings.slice(0, TOP)) {
    const [sport, year, setKey, parallel] = f.key.split("|");
    console.log(`  ${year} ${setKey} ${parallel}  (${sport})`);
    console.log(`     dominant ${f.dominant.run} on ${f.dominant.n}/${f.total} cards (${(f.share * 100).toFixed(0)}%)`);
    console.log(`     SUSPECT: ${f.odd.map((o) => `${o.run} on ${o.n}`).join(", ")}`);
  }
  console.log("\nREAD-ONLY — nothing was written. A print run is not rewritten from a majority vote.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
