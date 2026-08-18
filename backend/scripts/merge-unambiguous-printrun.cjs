#!/usr/bin/env node
/**
 * CF-PRINTRUN-MERGE-UNAMBIGUOUS (Drew, 2026-08-18).
 *
 * Merges an UNNUMBERED comp pool into its numbered twin — but ONLY when there
 * is exactly one numbered twin to merge into.
 *
 * THE DEFECT. A card does not change identity because a seller omitted "/150",
 * yet the slug's optional print-run segment makes those two forms different
 * pools. 2024 Bowman Draft Blue Refractor Caminiti CPA-CC showed $5.52 partly
 * because its four real sales were split:
 *
 *   :blue-refractor:auto:num-150   $76, $160, $215
 *   :blue-refractor:auto           $205.40
 *
 * Only /150 exists for that parallel, so the unnumbered sale is the same card
 * and the split is pure loss.
 *
 * WHY NOT JUST DROP THE PRINT RUN EVERYWHERE. Because for most modern
 * parallels the SERIAL IS THE PARALLEL. Panini Prizm #22 Orange exists as /99,
 * /49 and /124 with medians $1,150, $26.55 and $2.53 — collapsing those into
 * one "Orange" pool would be a far worse error than the split it fixed. So:
 *
 *   exactly ONE numbered variant + an unnumbered pool -> MERGE (seller omitted it)
 *   TWO OR MORE numbered variants                     -> LEAVE ALONE (ambiguous;
 *                                                        we cannot tell which
 *                                                        card the unnumbered
 *                                                        sale was)
 *
 * Leaving the ambiguous ones is not a gap, it is the correct answer: assigning
 * them would be guessing, and slugGuard's doctrine is that an absent or
 * separate identity beats a confidently wrong one.
 *
 * TWO PASSES, ON PURPOSE. Pass 1 reads only hobbyiqCardId to learn which
 * print-run variants exist per card — that question cannot be answered
 * row-by-row. Pass 2 patches only the unnumbered rows of cards that pass the
 * one-variant test, so the write set is a small fraction of the read set.
 *
 * hobbyiqCardIdBefore records the original, so the pass is reversible.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/merge-unambiguous-printrun.cjs \
 *     [--year=2024] [--apply] [--pool=12] [--top=25]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const POOL = Math.max(1, Number(arg("pool", "12")));
const TOP = Number(arg("top", "25"));
const YEAR = arg("year", "");

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[merge-unambiguous-printrun] mode=${APPLY ? "APPLY" : "DRY-RUN"}${YEAR ? ` year=${YEAR}` : " (all years)"}\n`);

  // ---- PASS 1: which print-run variants exist per card? -------------------
  const where = ["IS_DEFINED(c.hobbyiqCardId)", "NOT IS_NULL(c.hobbyiqCardId)"];
  if (YEAR) where.push(`c.cardYear = ${Number(YEAR)}`);
  const iter = sold.items.query(
    `SELECT c.hobbyiqCardId FROM c WHERE ${where.join(" AND ")}`,
    { maxItemCount: 2000 },
  );

  const variants = new Map(); // identity (7 segments) -> Set of print-run segments
  let scanned = 0;
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources || []) {
      scanned++;
      const p = String(r.hobbyiqCardId).split(":");
      if (p.length < 7) continue;
      const core = p.slice(0, 7).join(":");
      const run = p[7] ?? "";
      let s = variants.get(core);
      if (!s) variants.set(core, (s = new Set()));
      s.add(run);
    }
    if (scanned % 250000 < 2000) process.stderr.write(`\r  pass1 scanned=${scanned} cards=${variants.size}   `);
  }
  process.stderr.write("\n");

  // ---- decide ------------------------------------------------------------
  const merges = [];   // { fromSlug (unnumbered), toSlug (numbered) }
  let ambiguous = 0;
  for (const [core, set] of variants) {
    if (!set.has("")) continue;                       // no unnumbered pool
    const numbered = [...set].filter((v) => /^num-\d+$/.test(v));
    if (numbered.length === 0) continue;              // nothing to merge into
    if (numbered.length > 1) { ambiguous++; continue; } // serial IS the parallel
    merges.push({ from: core, to: `${core}:${numbered[0]}` });
  }

  console.log(`cards seen=${variants.size}`);
  console.log(`  MERGE (exactly one numbered variant) : ${merges.length}`);
  console.log(`  LEFT ALONE (two or more variants)    : ${ambiguous}\n`);
  for (const m of merges.slice(0, TOP)) console.log(`   ${m.from}\n      -> ${m.to}`);
  if (merges.length > TOP) console.log(`   ... and ${merges.length - TOP} more`);

  // ---- PASS 2: move the unnumbered rows ----------------------------------
  let moved = 0, failed = 0;
  let cursor = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (cursor < merges.length) {
      const m = merges[cursor++];
      try {
        const { resources } = await sold.items.query({
          query: "SELECT c.id, c.cardId FROM c WHERE c.hobbyiqCardId = @s",
          parameters: [{ name: "@s", value: m.from }],
        }).fetchAll();
        for (const row of resources) {
          if (!APPLY) { moved++; continue; }
          try {
            await sold.item(row.id, row.cardId).patch([
              { op: "add", path: "/hobbyiqCardIdBefore", value: m.from },
              { op: "set", path: "/hobbyiqCardId", value: m.to },
            ]);
            moved++;
          } catch (e) {
            failed++;
            if (failed <= 5) console.log(`   patch failed ${row.id}: ${String(e.message).slice(0, 80)}`);
          }
        }
      } catch (e) {
        failed++;
        if (failed <= 5) console.log(`   query failed ${m.from}: ${String(e.message).slice(0, 80)}`);
      }
    }
  }));

  console.log(`\npass1Scanned=${scanned} merges=${merges.length} rowsMoved=${moved} ambiguousLeftAlone=${ambiguous} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
