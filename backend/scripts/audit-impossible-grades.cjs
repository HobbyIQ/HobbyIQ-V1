#!/usr/bin/env node
/**
 * CF-ONE-GRADE-LADDER (Drew, 2026-08-25).
 *
 * Reports card_catalog rows asserting a grade their own company does not issue,
 * judged by gradeLadder.service -- the one declaration of which grades each
 * grader actually gives out.
 *
 * REPORT ONLY, ON PURPOSE. This deletes nothing and takes no APPLY flag. The
 * population it names is ~1.5M rows, and the last thing this catalog needs is
 * another script that can remove a million rows because a predicate looked
 * right. The predicate is conservative in one direction by design: a company
 * whose ladder the service does not assert can never produce an "impossible"
 * verdict, so an unrecognised grader is reported as UNKNOWN and left alone.
 *
 * It also reports the BGS 10 surplus, which is a DIFFERENT defect wearing
 * similar clothes: Beckett issues both Pristine 10 and Black Label 10, the same
 * number on two very differently priced cards. Those rows are duplicates whose
 * label was lost, not phantom grades, and the fix is to restore the label --
 * never to delete on the count.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const {
  canonicalGradeCompany, isImpossibleGrade, gradesFor,
} = require(path.join(backend, "dist/services/catalog/gradeLadder.service.js"));

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const cat = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq").container("card_catalog");

  const rows = (await cat.items.query({
    query: `SELECT c.gradeCompany AS co, c.gradeValue AS v, COUNT(1) AS n FROM c
            WHERE IS_DEFINED(c.gradeCompany) AND c.gradeCompany != null
            GROUP BY c.gradeCompany, c.gradeValue`,
  }, { enableCrossPartitionQuery: true }).fetchAll()).resources;

  const f = (n) => Number(n).toLocaleString();
  let impossible = 0, valid = 0, unknownCo = 0, noValue = 0;
  const bad = [], unknown = new Map();

  for (const r of rows) {
    const canon = canonicalGradeCompany(r.co);
    if (canon === null) { unknownCo += r.n; unknown.set(r.co, (unknown.get(r.co) || 0) + r.n); continue; }
    if (r.v === null || r.v === undefined) { noValue += r.n; continue; }
    if (isImpossibleGrade(r.co, r.v)) { impossible += r.n; bad.push({ co: canon, raw: r.co, v: r.v, n: r.n }); }
    else valid += r.n;
  }

  console.log("card_catalog rows carrying a grade company\n");
  console.log("  valid for that company      " + f(valid).padStart(12));
  console.log("  IMPOSSIBLE for that company " + f(impossible).padStart(12) + "   <- the company does not issue this grade");
  console.log("  company not recognised      " + f(unknownCo).padStart(12) + "   (left alone by design)");
  console.log("  no grade value on the row   " + f(noValue).padStart(12) + "   (incomplete, not impossible)");

  if (bad.length) {
    console.log("\nimpossible grades, worst first:");
    for (const b of bad.sort((a, c) => c.n - a.n)) {
      const ladder = gradesFor(b.co);
      const near = ladder.filter((g) => Math.abs(g - b.v) <= 0.5).join("/") || "none";
      console.log(`  ${f(b.n).padStart(11)}  ${b.co} ${b.v}   ${b.co} issues ${near} around it, not ${b.v}`);
    }
  }

  if (unknown.size) {
    console.log("\nunrecognised grade companies (candidates for the alias map, or parser junk):");
    for (const [k, n] of [...unknown].sort((a, c) => c[1] - a[1])) {
      console.log(`  ${f(n).padStart(11)}  ${JSON.stringify(k)}`);
    }
  }

  // The BGS 10 surplus. Reported, never acted on -- see the header.
  const bgs = rows.filter((r) => canonicalGradeCompany(r.co) === "BGS" && r.v !== null && r.v !== undefined);
  const bgs10 = bgs.find((r) => Number(r.v) === 10);
  const others = bgs.filter((r) => Number(r.v) !== 10 && r.n > 100000).map((r) => r.n);
  if (bgs10 && others.length) {
    const median = others.sort((a, b) => a - b)[Math.floor(others.length / 2)];
    console.log("\nBGS 10 surplus check:");
    console.log("  BGS 10                " + f(bgs10.n).padStart(12));
    console.log("  median other BGS rung " + f(median).padStart(12));
    console.log("  ratio                 " + (bgs10.n / median).toFixed(2).padStart(12) +
      "   (~2.0 means one extra row per card)");
    console.log("  Beckett issues BOTH Pristine 10 and Black Label 10 -- same number, different");
    console.log("  cards, different money. A surplus here is a LOST LABEL, not a phantom grade.");
    console.log("  Restore the label; do not delete on the count.");
  }
})().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
