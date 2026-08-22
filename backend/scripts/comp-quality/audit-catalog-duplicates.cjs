// How duplicated is card_catalog, and which source is doing it?
//
// WHY THIS EXISTS. The catalog re-tokenisation lost a rising share of rows to
// RU exhaustion every year it walked back: 18% on 2026, 37% on 2025, 39.4% on
// 2024 (1,750,449 throttle events). The instinct is to ask for more RU. The
// measurement says otherwise.
//
// CORRECTED 2026-08-22 (second pass). The first version of this script keyed
// on (setKey|parallel|isAuto) and reported 3.1x bloat, worst case 459 copies
// of bowman|Base|auto on 2026 CPA-MG. That reading was WRONG, and acting on it
// would have deleted the per-grade catalog.
//
// Those 459 rows are grade-exploded: catalogBatch "grade-explode-2026-08-10",
// ids like `…:cpa-mg:base:auto:raw`, each carrying its own gradeTier /
// gradeCompany / gradeValue / gradeQualifier and a parentSlug pointing at the
// ungraded canonical slug. They are one row per grade of the same card, which
// is the design. A key that omits grade collapses a full grade ladder onto one
// bucket and calls the ladder a duplicate.
//
// The lesson is the standing one: "duplicate" is a conclusion, not an
// observation. Before deleting on a key, check what actually varies across the
// rows that key groups together — if anything load-bearing varies, they are
// not duplicates.
//
// The key below therefore includes grade. Any bloat it still reports is real.
//
// SCOPED ON PURPOSE. A cross-partition GROUP BY over 25.5M rows will time out,
// and any function applied to an indexed field makes it worse. This samples
// specific card numbers instead — enough to size the problem, cheap enough to
// finish.
//
// Read-only.
//
// Usage:
//   COSMOS_CONNECTION_STRING=... node scripts/comp-quality/audit-catalog-duplicates.cjs
//   NUMBERS="2026:RA-KG,2025:CPA-MWI"   override the sample (year:cardNumber pairs)
const { CosmosClient } = require("@azure/cosmos");

const cs = process.env.COSMOS_CONNECTION_STRING;
if (!cs) {
  console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
  process.exit(1);
}

const DEFAULT_SAMPLE = [
  "2026:RA-KG", "2025:CPA-MWI", "2026:CPA-MG",
  "2026:BCP-106", "2024:RA-JC", "2021:BSPA-AG",
];
const SAMPLE = (process.env.NUMBERS || DEFAULT_SAMPLE.join(",")).split(",").map((s) => s.trim()).filter(Boolean);

const c = new CosmosClient(cs).database("hobbyiq").container("card_catalog");

(async () => {
  let totalRows = 0, totalDistinct = 0, probed = 0;
  const sourceTotals = new Map();
  const worstOverall = { key: null, count: 0, where: null };

  console.log("year  number       rows  distinct  worstDupe");
  console.log("-".repeat(72));

  for (const entry of SAMPLE) {
    const [yRaw, number] = entry.split(":");
    const year = Number(yRaw);
    if (!year || !number) {
      console.log(`  skipping unparseable sample entry "${entry}" (want year:cardNumber)`);
      continue;
    }
    try {
      const { resources: rows } = await c.items.query({
        query: "SELECT c.parallel, c.isAuto, c.source, c.setKey, c.gradeTier, c.gradeCompany, c.gradeValue, c.gradeQualifier FROM c WHERE c.cardNumber=@n AND c.year=@y",
        parameters: [{ name: "@n", value: number }, { name: "@y", value: year }],
      }).fetchAll();

      const byKey = new Map();
      for (const r of rows) {
        // GRADE IS PART OF THE IDENTITY. Keying on setKey|parallel|isAuto
        // alone collapses every grade-exploded row onto one key, so a card
        // with a full grade ladder reads as hundreds of "duplicates".
        // See the header — acting on that reading deletes the grade catalog.
        const g = [r.gradeTier, r.gradeCompany, r.gradeValue, r.gradeQualifier]
          .map((v) => (v === undefined || v === null ? "" : String(v)))
          .join(":");
        const k = `${r.setKey}|${r.parallel}|${r.isAuto ? 1 : 0}|${g}`;
        byKey.set(k, (byKey.get(k) ?? 0) + 1);
        const s = String(r.source ?? "(none)");
        sourceTotals.set(s, (sourceTotals.get(s) ?? 0) + 1);
      }
      let worst = 0, worstKey = "";
      for (const [k, n] of byKey) if (n > worst) { worst = n; worstKey = k; }
      if (worst > worstOverall.count) {
        worstOverall.count = worst; worstOverall.key = worstKey; worstOverall.where = `${year} ${number}`;
      }

      totalRows += rows.length;
      totalDistinct += byKey.size;
      probed++;
      console.log(`${year}  ${String(number).padEnd(11)} ${String(rows.length).padStart(5)}  ${String(byKey.size).padStart(8)}  ${String(worst).padStart(9)}`);
      if (worst > 3) console.log(`      worst key: ${worstKey}`);
    } catch (e) {
      console.log(`${year}  ${String(number).padEnd(11)} QUERY FAILED: ${e.message}`);
    }
  }

  if (!probed) {
    console.error("\nFATAL: no sample entry produced a result. The sweep proved nothing.");
    process.exit(2);
  }

  console.log("-".repeat(72));
  const ratio = totalDistinct > 0 ? totalRows / totalDistinct : 0;
  console.log(`rows=${totalRows}  distinct(setKey|parallel|isAuto|grade)=${totalDistinct}  bloat=${ratio.toFixed(1)}x`);
  if (worstOverall.key) {
    console.log(`worst single key: ${worstOverall.count} copies of "${worstOverall.key}" (${worstOverall.where})`);
  }

  console.log("\nrows by source (across the sample):");
  const sorted = [...sourceTotals.entries()].sort((a, b) => b[1] - a[1]);
  for (const [s, n] of sorted.slice(0, 15)) {
    console.log(`  ${String(n).padStart(6)}  ${s}`);
  }

  console.log("");
  if (ratio > 1.5) {
    console.log(`VERDICT: ${ratio.toFixed(1)}x duplicated on a GRADE-AWARE key, so this is real`);
    console.log(`bloat and not a grade ladder. It does not break matching — a card is findable`);
    console.log(`whether it appears once or ${worstOverall.count} times — but every scan pays for it.`);
    console.log(`Before deleting: dump the rows behind the worst key and confirm nothing`);
    console.log(`load-bearing varies across them. "Duplicate" is a conclusion, not an observation.`);
  } else {
    console.log("VERDICT: duplication is not material in this sample.");
    console.log("Note the key is grade-aware: rows differing only by grade are the grade");
    console.log("ladder by design, and an earlier version of this script counted them as bloat.");
  }
})().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
