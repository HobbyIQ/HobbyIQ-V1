#!/usr/bin/env node
// CF-QUICK-CHECK-GRADE-PASSTHROUGH (Drew, 2026-07-30). Verify that
// bulk-import is preserving grade info from ch_daily_sales into
// sold_comps by cross-checking a small sample of matched row-pairs.

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database("hobbyiq").container("sold_comps");
  const ch = c.database("hobbyiq").container("ch_daily_sales");

  // 1. Aggregate counts of bulk-import rows written in last 6h by grade status
  console.log(`[quick-check-grade-passthrough]\n`);
  const cutoff = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const total = await sc.items.query({
    query: `SELECT VALUE COUNT(1) FROM c WHERE c.source = "cardhedge" AND STARTSWITH(c.sourceExternalId, "ch-daily::") AND c.observedAt >= @cutoff`,
    parameters: [{ name: "@cutoff", value: cutoff }],
  }).fetchAll();
  const withGrade = await sc.items.query({
    query: `SELECT VALUE COUNT(1) FROM c WHERE c.source = "cardhedge" AND STARTSWITH(c.sourceExternalId, "ch-daily::") AND c.observedAt >= @cutoff AND IS_STRING(c.gradeCompany)`,
    parameters: [{ name: "@cutoff", value: cutoff }],
  }).fetchAll();

  console.log(`Bulk-import rows in last 6h:  ${total.resources[0].toLocaleString()}`);
  console.log(`  with populated gradeCompany:  ${withGrade.resources[0].toLocaleString()} (${((withGrade.resources[0] / total.resources[0]) * 100).toFixed(2)}%)`);

  // 2. Sample 10 rows WITH grade and 10 WITHOUT, print their sourceExternalId
  //    so we can cross-reference the ch_daily_sales row to verify.
  console.log(`\n════ Sample 5 rows WITH grade ════`);
  const withSample = await sc.items.query({
    query: `SELECT TOP 5 c.hobbyiqCardId, c.gradeCompany, c.gradeValue, c.sourceExternalId, c.title FROM c WHERE c.source = "cardhedge" AND STARTSWITH(c.sourceExternalId, "ch-daily::") AND c.observedAt >= @cutoff AND IS_STRING(c.gradeCompany)`,
    parameters: [{ name: "@cutoff", value: cutoff }],
  }).fetchAll();
  for (const r of withSample.resources) {
    console.log(`  sold_comps.${r.gradeCompany} ${r.gradeValue}`);
    console.log(`    ext: ${r.sourceExternalId}`);
    console.log(`    title: ${(r.title || "").slice(0, 80)}`);
    // Cross-check ch_daily
    const phid = String(r.sourceExternalId || "").replace("ch-daily::", "");
    try {
      const chRow = await ch.items.query({
        query: `SELECT c.grade, c.grader, c.description FROM c WHERE c.price_history_id = @id`,
        parameters: [{ name: "@id", value: phid }],
      }).fetchAll();
      if (chRow.resources.length > 0) {
        const src = chRow.resources[0];
        console.log(`    ch:   ${src.grader} ${src.grade}   [${(src.description || "").slice(0, 60)}]`);
      } else {
        console.log(`    ch:   (not found for price_history_id=${phid})`);
      }
    } catch { /* ignore */ }
    console.log("");
  }

  console.log(`\n════ Sample 5 rows WITHOUT grade ════`);
  const noSample = await sc.items.query({
    query: `SELECT TOP 5 c.hobbyiqCardId, c.gradeCompany, c.gradeValue, c.sourceExternalId, c.title FROM c WHERE c.source = "cardhedge" AND STARTSWITH(c.sourceExternalId, "ch-daily::") AND c.observedAt >= @cutoff AND NOT IS_STRING(c.gradeCompany)`,
    parameters: [{ name: "@cutoff", value: cutoff }],
  }).fetchAll();
  for (const r of noSample.resources) {
    console.log(`  sold_comps.gradeCompany=${r.gradeCompany ?? "null"}`);
    console.log(`    ext: ${r.sourceExternalId}`);
    console.log(`    title: ${(r.title || "").slice(0, 80)}`);
    const phid = String(r.sourceExternalId || "").replace("ch-daily::", "");
    try {
      const chRow = await ch.items.query({
        query: `SELECT c.grade, c.grader, c.description FROM c WHERE c.price_history_id = @id`,
        parameters: [{ name: "@id", value: phid }],
      }).fetchAll();
      if (chRow.resources.length > 0) {
        const src = chRow.resources[0];
        console.log(`    ch:   ${src.grader} ${src.grade}   [${(src.description || "").slice(0, 60)}]`);
      } else {
        console.log(`    ch:   (not found)`);
      }
    } catch { /* ignore */ }
    console.log("");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
