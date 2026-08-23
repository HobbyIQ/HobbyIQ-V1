// Move sales off superseded catalog slugs and onto the card that survived.
//
// WHY THIS MUST RUN WITH THE CONSOLIDATION, NOT AFTER IT SOMEDAY.
// consolidate-draft-chrome-overlap marks a duplicate chrome row
// supersededBy its draft twin. That fixes the catalog and, on its own, makes
// pricing WORSE: 7,140 sales across 197 slugs stay filed under the row we just
// retired, so the surviving card looks like it has no comps. That is the
// "the comp disappeared" bug, at scale. Superseding without repointing is a
// half-finished operation.
//
// WHAT IT DOES. For every catalog row carrying supersededBy, rewrite the
// hobbyiqCardId of its sales to the surviving slug. Nothing else on the sale
// changes — not price, not date, not source. The sale is the same sale; only
// our name for the card changes.
//
// SAFETY.
//   - Report-only by default. APPLY=true writes.
//   - The target must be a CANONICAL slug. A supersededBy pointing at a vendor
//     id would move sales onto an identity nothing else resolves.
//   - Never repoints onto a target that is ITSELF superseded — that would
//     chain sales through a retired card into another one.
//   - sold_comps is partitioned by /cardId, so a row missing it cannot be
//     written and is counted separately rather than silently failing.
//   - Paced. The whole-pool version of this hammers Cosmos.
//
// Usage:
//   COSMOS_CONNECTION_STRING=... node scripts/comp-quality/repoint-comps-to-surviving-slug.cjs
//     YEAR=2024        catalog year to sweep (default 2024)
//     SETKEY=bowman-chrome   the superseded side (default bowman-chrome)
//     APPLY=true       perform the writes
//     PACE_MS=120      delay between writes
const { CosmosClient } = require("@azure/cosmos");

const YEAR = Number(process.env.YEAR || 2024);
const SETKEY = String(process.env.SETKEY || "bowman-chrome");
const APPLY = process.env.APPLY === "true";
const PACE_MS = Number(process.env.PACE_MS || 120);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isCanonical = (s) => String(s || "").startsWith("hiq:");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }
  const db = new CosmosClient(conn).database("hobbyiq");
  const cat = db.container("card_catalog");
  const sold = db.container("sold_comps");
  console.log(`mode: ${APPLY ? "APPLY — WILL REWRITE hobbyiqCardId" : "report only"}   year=${YEAR} setKey=${SETKEY}\n`);

  // 1. The retired -> surviving map.
  const { resources: rows } = await cat.items.query({
    query: `SELECT c.id, c.supersededBy FROM c
            WHERE c.year=@y AND c.setKey=@sk AND IS_DEFINED(c.supersededBy) AND c.supersededBy != null`,
    parameters: [{ name: "@y", value: YEAR }, { name: "@sk", value: SETKEY }],
  }).fetchAll();

  const map = new Map();
  let skippedTarget = 0;
  for (const r of rows) {
    if (!isCanonical(r.id) || !isCanonical(r.supersededBy)) { skippedTarget++; continue; }
    if (r.id === r.supersededBy) { skippedTarget++; continue; }
    map.set(r.id, r.supersededBy);
  }
  // A target that is itself retired would chain sales onward. Drop those pairs.
  const retired = new Set(rows.map((r) => r.id));
  let chained = 0;
  for (const [from, to] of [...map]) {
    if (retired.has(to)) { map.delete(from); chained++; }
  }
  console.log(`superseded rows: ${rows.length}   usable mappings: ${map.size}   unusable target: ${skippedTarget}   chained target: ${chained}`);
  if (map.size === 0) { console.log("nothing to do."); return; }

  // 2. Sales sitting on the retired slugs.
  const froms = [...map.keys()];
  const found = [];
  for (let i = 0; i < froms.length; i += 30) {
    const chunk = froms.slice(i, i + 30);
    const params = chunk.map((s, n) => ({ name: `@s${n}`, value: s }));
    const { resources } = await sold.items.query({
      query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.price FROM c
              WHERE c.hobbyiqCardId IN (${params.map((p) => p.name).join(", ")})`,
      parameters: params,
    }).fetchAll();
    found.push(...resources);
    await sleep(200);
  }
  console.log(`sales sitting on retired slugs: ${found.length}`);
  if (found.length === 0) { console.log("nothing stranded."); return; }

  if (!APPLY) {
    const bySlug = new Map();
    for (const r of found) bySlug.set(r.hobbyiqCardId, (bySlug.get(r.hobbyiqCardId) || 0) + 1);
    console.log("\ntop slugs by stranded sales:");
    for (const [s, n] of [...bySlug.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`  ${String(n).padStart(5)}  ${s.slice(4, 60)}`);
      console.log(`         -> ${String(map.get(s)).slice(4, 60)}`);
    }
    console.log(`\nReport only — nothing written. Re-run with APPLY=true.`);
    return;
  }

  // 3. Repoint.
  let moved = 0, unaddressable = 0, failed = 0;
  for (const r of found) {
    const pk = typeof r.cardId === "string" && r.cardId ? r.cardId : null;
    if (!pk) { unaddressable++; continue; }
    try {
      const { resource: doc } = await sold.item(r.id, pk).read();
      if (!doc) { unaddressable++; continue; }
      const to = map.get(doc.hobbyiqCardId);
      if (!to) { continue; }                      // changed under us; leave it
      doc.hobbyiqCardId = to;
      doc.repointedFrom = r.hobbyiqCardId;
      doc.repointedReason = `catalog row superseded (${SETKEY} overlap); sale follows the surviving card`;
      doc.repointedAt = new Date().toISOString();
      await sold.item(r.id, pk).replace(doc);
      moved++;
      if (moved % 250 === 0) process.stdout.write(`  ...${moved}/${found.length}\r`);
    } catch (e) {
      failed++;
      if (failed <= 3) console.log(`  write failed ${r.id}: ${e.message}`);
    }
    await sleep(PACE_MS);
  }
  console.log(`\nMOVED: ${moved}   unaddressable (no cardId): ${unaddressable}   failed: ${failed}`);
  if (failed) process.exit(4);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
