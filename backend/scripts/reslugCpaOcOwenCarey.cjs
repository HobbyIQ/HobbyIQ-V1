// CF-OWEN-CAREY-RESLUG (Drew, 2026-08-10). Consolidate the 4 fragmented
// sold_comps slugs for the 2026 Bowman Chrome Prospect Autographs
// Refractor Auto CPA-OC Owen Carey card onto the canonical slug:
//   hiq:baseball:2026:bowman-chrome:cpa-oc:refractor:auto
//
// Fragmentation observed 2026-08-10:
//   bowman-chrome:cpa-oc:refractor:auto              7   (target)
//   bowman:cpa-oc:refractor:auto                    92   (missing -chrome)
//   bowman-chrome:cpa-oc:refractor:auto:num-499      2   (:num-499 is inherent, drop)
//   bowman:cpa-oc:refractor:auto:num-499             3   (both bugs)
//
// For CPA autos, "Refractor" IS the /499 base — colored refractors have
// their own labels. So :num-499 must NOT be its own slug.
//
// This script patches hobbyiqCardId in place. It leaves the cardId
// partition-key alone (it's already inconsistent with hobbyiqCardId on
// most of these rows — the ingest wrote them from different paths).
// Queries by hobbyiqCardId will find all 104 rows at the target slug.
//
// Env: APPLY=true to write; default dry-run.

const { CosmosClient } = require("@azure/cosmos");

const TARGET = "hiq:baseball:2026:bowman-chrome:cpa-oc:refractor:auto";
const SOURCE_SLUGS = [
  "hiq:baseball:2026:bowman:cpa-oc:refractor:auto",
  "hiq:baseball:2026:bowman-chrome:cpa-oc:refractor:auto:num-499",
  "hiq:baseball:2026:bowman:cpa-oc:refractor:auto:num-499",
];
const APPLY = process.env.APPLY === "true";

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const sold = new CosmosClient(conn).database("hobbyiq").container("sold_comps");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  target=${TARGET}`);

  let touched = 0, failed = 0;
  for (const srcSlug of SOURCE_SLUGS) {
    const { resources } = await sold.items.query({
      query: `SELECT c.id, c.cardId, c.hobbyiqCardId FROM c WHERE c.hobbyiqCardId = @s`,
      parameters: [{ name: "@s", value: srcSlug }],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    console.log(`\n  ${srcSlug}: ${resources.length} row(s)`);
    for (const r of resources) {
      if (!APPLY) { touched++; continue; }
      try {
        await sold.item(r.id, r.cardId).patch([
          { op: "set", path: "/hobbyiqCardId", value: TARGET },
          { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
          { op: "set", path: "/reslugedFrom", value: srcSlug },
          { op: "set", path: "/reslugedReason", value: "CF-OWEN-CAREY-RESLUG: bowman→bowman-chrome + drop :num-499 (inherent)" },
        ]);
        touched++;
      } catch (err) {
        console.warn(`    fail id=${r.id} pk=${r.cardId}: ${err.message || err}`);
        failed++;
      }
    }
  }

  console.log(`\n[done] touched=${touched} failed=${failed}  ${APPLY ? "(applied)" : "(dry-run)"}`);

  if (APPLY) {
    // Verify
    const { resources: after } = await sold.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s`,
      parameters: [{ name: "@s", value: TARGET }],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    console.log(`  target slug now has ${after[0]} row(s)`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
