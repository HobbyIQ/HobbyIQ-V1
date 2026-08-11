// CF-INHERENT-RUN-AUDIT (Drew, 2026-08-10). After the chrome-family
// mass reslug, many `<base>:auto:num-N` slugs now sit next to their
// `<base>:auto` twins. For CPA Refractor Autos, /499 is the INHERENT
// print run (base "Refractor" IS the /499 auto; colored refractors
// have their own labels: Blue /150, Green /99, etc.). So the num-499
// suffix is spurious — should collapse into the base.
//
// This audit finds every (base, base:num-N) pair where both exist
// across the sold_comps container, so we can decide which pairs to
// merge. Some are legitimate (a Bowman Chrome base auto has /499 and
// /50 variants — those are distinct). Only certain parallels have an
// inherent print run: for chrome autos, "Refractor" == /499.

const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const sold = new CosmosClient(conn).database("hobbyiq").container("sold_comps");

  console.log("[step 1] enumerate all :num-N slugs");
  const { resources } = await sold.items.query({
    query: `SELECT DISTINCT c.hobbyiqCardId FROM c WHERE IS_STRING(c.hobbyiqCardId) AND CONTAINS(c.hobbyiqCardId, ':num-')`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`  found ${resources.length} distinct :num-N slug(s)`);

  console.log("\n[step 2] pair each with its base and count both");
  const pairs = [];
  let checked = 0;
  for (const r of resources) {
    checked++;
    if (checked % 200 === 0) console.log(`  ...${checked}/${resources.length}`);
    const slug = r.hobbyiqCardId;
    const m = slug.match(/^(.+):num-(\d+)$/);
    if (!m) continue;
    const base = m[1];
    const printRun = Number(m[2]);
    const bc = await sold.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s`,
      parameters: [{ name: "@s", value: base }],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    const baseCount = bc.resources[0] || 0;
    if (baseCount === 0) continue;
    const nc = await sold.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s`,
      parameters: [{ name: "@s", value: slug }],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    pairs.push({ base, printRun, numSlug: slug, baseCount, numCount: nc.resources[0] || 0 });
  }

  // Focus: chrome autos where base parallel = "refractor" (inherent /499)
  // Also: chrome autos where base parallel is a colored refractor with
  // known inherent print runs (blue-refractor:auto:num-150, etc.). Keep
  // the audit report broad; let the fix script apply narrow rules only.
  console.log(`\n[found ${pairs.length} pair(s) — base + :num-N both populated]`);

  // Classify pairs by whether the print run is the "inherent" one
  // for that parallel. Chrome-family parallel/inherent-run map:
  const INHERENT = {
    "refractor:auto": 499,
    "blue-refractor:auto": 150,
    "green-refractor:auto": 99,
    "purple-refractor:auto": 250,
    "gold-refractor:auto": 50,
    "orange-refractor:auto": 25,
    "red-refractor:auto": 5,
    "green-shimmer-refractor:auto": 99,
    "blue-shimmer-refractor:auto": 150,
    "aqua-refractor:auto": 75,
  };

  const consolidatable = [];
  const preserve = [];
  for (const p of pairs) {
    const m = p.base.match(/^hiq:[^:]+:\d+:[^:]+:[^:]+:(.+)$/);
    if (!m) { preserve.push(p); continue; }
    const parallelAuto = m[1];
    const inh = INHERENT[parallelAuto];
    if (inh && inh === p.printRun) consolidatable.push(p);
    else preserve.push(p);
  }
  console.log(`\n  consolidatable (inherent run): ${consolidatable.length}`);
  console.log(`  preserve (distinct run):        ${preserve.length}`);

  const fs = require("fs");
  fs.writeFileSync("scripts/inherent-run-findings.json", JSON.stringify({ pairs, consolidatable, preserve, generatedAt: new Date().toISOString() }, null, 2));
  console.log("\n  wrote backend/scripts/inherent-run-findings.json");

  console.log("\n=== TOP CONSOLIDATABLE PAIRS ===");
  consolidatable.sort((a,b)=>b.numCount-a.numCount).slice(0, 30).forEach(p => {
    console.log(`  base ${String(p.baseCount).padStart(5)}  |  num${p.printRun} ${String(p.numCount).padStart(4)}  |  ${p.numSlug}`);
  });
  const totalToMerge = consolidatable.reduce((a,b)=>a+b.numCount,0);
  console.log(`\n  total :num-N rows to merge: ${totalToMerge}`);
}
main().catch(e => { console.error(e); process.exit(1); });
