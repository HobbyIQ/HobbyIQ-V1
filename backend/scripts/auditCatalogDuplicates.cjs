// CF-CATALOG-DEDUP-AUDIT (Drew, 2026-08-08). Read-only audit: group
// card_catalog docs by hobbyiqCardId, find slugs with more than one
// doc. Report:
//   - total docs with hobbyiqCardId
//   - distinct slugs represented
//   - slugs with duplicates (N > 1)
//   - histogram of dup counts (2, 3, 4, 5+)
//   - top 15 worst offenders with sample docs
//
// No writes. Safe to run at 20K RU/s.
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const cat = client.database("hobbyiq").container("card_catalog");

  console.log("[dedup-audit] scanning card_catalog for hobbyiqCardId duplicates...");
  const startMs = Date.now();

  // Stream paginated results collecting slug -> [ids...] in memory.
  // 4.1M docs total, ~1.4M with hobbyiqCardId — should fit fine.
  //
  // Full-scan projection (no WHERE) — filtered WHERE clauses with
  // IS_DEFINED across all partitions are RU-expensive; a naked scan
  // is cheaper per row. We filter in JS after the network round.
  const bySlug = new Map(); // slug -> Array<{ id, source, verificationStatus }>
  let scanned = 0;
  let skipped = 0;
  const iter = cat.items.query({
    query: `SELECT c.id, c.hobbyiqCardId, c.source, c.verificationStatus, c.confidence FROM c`,
  }, { maxItemCount: 200 });

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      scanned++;
      const slug = r.hobbyiqCardId;
      if (!slug) { skipped++; continue; }
      if (!bySlug.has(slug)) bySlug.set(slug, []);
      bySlug.get(slug).push({
        id: r.id,
        source: r.source,
        verificationStatus: r.verificationStatus,
        confidence: r.confidence,
      });
    }
    if (scanned % 50_000 === 0) {
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
      console.log(`  scanned=${scanned.toLocaleString()} withSlug=${(scanned - skipped).toLocaleString()} uniqueSlugs=${bySlug.size.toLocaleString()} elapsed=${elapsed}s`);
    }
  }

  const distinctSlugs = bySlug.size;
  const totalDocs = scanned - skipped;
  const dupSlugs = [];
  const dupHist = { "2": 0, "3": 0, "4": 0, "5+": 0 };
  for (const [slug, docs] of bySlug) {
    if (docs.length > 1) {
      dupSlugs.push({ slug, count: docs.length, docs });
      if (docs.length === 2) dupHist["2"]++;
      else if (docs.length === 3) dupHist["3"]++;
      else if (docs.length === 4) dupHist["4"]++;
      else dupHist["5+"]++;
    }
  }
  dupSlugs.sort((a, b) => b.count - a.count);

  const elapsed = Math.round((Date.now() - startMs) / 1000);
  console.log(`\n=== DEDUP AUDIT SUMMARY ===`);
  console.log(`elapsed         : ${elapsed}s`);
  console.log(`total scanned   : ${scanned.toLocaleString()}`);
  console.log(`  with slug     : ${totalDocs.toLocaleString()}`);
  console.log(`  no slug (skip): ${skipped.toLocaleString()}`);
  console.log(`distinct slugs  : ${distinctSlugs.toLocaleString()}`);
  console.log(`duplicate slugs : ${dupSlugs.length.toLocaleString()}`);
  console.log(`extra docs      : ${(totalDocs - distinctSlugs).toLocaleString()}  (would delete on dedup)`);
  console.log(`\nDup distribution:`);
  console.log(`  2 docs / slug : ${dupHist["2"]}`);
  console.log(`  3 docs / slug : ${dupHist["3"]}`);
  console.log(`  4 docs / slug : ${dupHist["4"]}`);
  console.log(`  5+ docs / slug: ${dupHist["5+"]}`);

  if (dupSlugs.length > 0) {
    console.log(`\nTop 15 worst offenders:`);
    for (const d of dupSlugs.slice(0, 15)) {
      console.log(`  n=${d.count}  ${d.slug}`);
      for (const doc of d.docs.slice(0, 3)) {
        console.log(`      id=${doc.id.slice(0, 50).padEnd(50)}  source=${doc.source || '<null>'}  status=${doc.verificationStatus || '<null>'}  conf=${doc.confidence ?? '<null>'}`);
      }
      if (d.docs.length > 3) console.log(`      ... +${d.docs.length - 3} more`);
    }
  }
}

main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
