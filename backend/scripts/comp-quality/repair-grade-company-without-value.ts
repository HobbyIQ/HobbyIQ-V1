/**
 * Repair stored holdings that carry a grading company with no grade value.
 *
 * WHY. A company with no grade is not a graded card, it is a half-filled form —
 * and it priced like a slab while displaying like one. Measured 2026-08-22:
 * 3 of 79 holdings stored gradingCompany "PSA" with gradeValue absent, and
 * Nick Kurtz #RA-KG carried fairMarketValue $239.64 against $6.85 paid while
 * his own predictedPrice sat at $3.75. A 64x spread on a card that was believed
 * to be pricing as raw. Confirmed with Drew 2026-08-22: these are ungraded and
 * the company is simply wrong.
 *
 * CF-GRADE-COMPANY-WITHOUT-VALUE stops NEW ones at the write boundary. Stored
 * rows never self-heal, so this is the other half.
 *
 * THE RULE IS NOT RESTATED HERE. This imports the very function the write
 * boundary runs (clearGradeCompanyWithoutValue). A repair that re-implements
 * its own copy of the rule is a second rule, and the two drift — including the
 * cert carve-out, which is the part most likely to be forgotten: a holding with
 * a certNumber IS slabbed and its grade is recoverable via resolveCert, so it
 * must be left alone rather than cleared.
 *
 * Clearing the grade changes what the card is worth, so the stored price is no
 * longer ours to keep: predictedPrice / fairMarketValue are nulled to force a
 * reprice on the next surface hit, exactly as applyRematchToHolding does.
 *
 * Writes use replace() with an ifMatch etag, so a concurrent portfolio write
 * makes this stand down rather than clobber.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="$(az webapp config appsettings list \
 *     --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
 *     --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" \
 *     AUTH_SESSION_SECRET=... \
 *     npx tsx scripts/comp-quality/repair-grade-company-without-value.ts
 *
 *   APPLY=true    write the repair (default: report only)
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

const APPLY = process.env.APPLY === "true";

async function main(): Promise<void> {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }

  const { CosmosClient } = await import("@azure/cosmos");

  // Resolved from cwd and PRINTED — the session cwd can revert to a stale
  // checkout, and repairing with the wrong tree's rule is worse than not
  // repairing at all.
  const storePath = path.resolve(process.cwd(), "src/services/portfolioiq/portfolioStore.service.ts");
  console.log(`[import] ${storePath}`);
  console.log(`[mode]   ${APPLY ? "APPLY — WILL WRITE" : "report only"}\n`);
  const { clearGradeCompanyWithoutValue } = await import(pathToFileURL(storePath).href);

  const c = new CosmosClient(conn).database("hobbyiq").container("portfolio");
  const { resources } = await c.items
    .query({ query: "SELECT c.id, c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)" })
    .fetchAll();
  if (!resources.length) {
    console.error("FATAL: zero portfolio docs returned. The sweep proved nothing.");
    process.exit(2);
  }

  type Hit = { docId: string; userId: string; hid: string; company: string; fmv: unknown; cost: unknown };
  const hits: Hit[] = [];
  let totalHoldings = 0;

  for (const doc of resources as any[]) {
    for (const [hid, h] of Object.entries<any>(doc.holdings || {})) {
      if (!h) continue;
      totalHoldings++;
      // Ask the REAL guard whether this row is affected, by running it on a
      // copy and seeing whether it changed anything.
      const before = JSON.stringify(h);
      const probe = { ...h };
      clearGradeCompanyWithoutValue(probe, { userId: doc.userId, holdingId: hid });
      if (JSON.stringify(probe) === before) continue;
      hits.push({
        docId: doc.id,
        userId: doc.userId,
        hid,
        company: String(h.gradingCompany ?? h.gradeCompany ?? "?"),
        fmv: h.fairMarketValue ?? null,
        cost: h.purchasePrice ?? h.totalCostBasis ?? null,
      });
      console.log(`  ${String(h.playerName ?? "?").slice(0, 20).padEnd(20)} #${String(h.cardNumber ?? "?").padEnd(9)}` +
        `  ${String(h.gradingCompany ?? h.gradeCompany ?? "?").padEnd(5)} (no grade)` +
        `  fmv=${h.fairMarketValue ?? "—"} cost=${h.purchasePrice ?? "—"}`);
    }
  }

  if (!totalHoldings) {
    console.error("FATAL: portfolio docs exist but contain zero holdings. The sweep proved nothing.");
    process.exit(2);
  }

  console.log(`\nholdings scanned: ${totalHoldings}   to repair: ${hits.length}`);

  if (!hits.length) {
    console.log("Nothing to repair.");
    return;
  }
  if (!APPLY) {
    console.log(`\nReport only — nothing written. Re-run with APPLY=true to clear the ${hits.length} above.`);
    return;
  }

  // ---- APPLY -------------------------------------------------------------
  const byDoc = new Map<string, { userId: string; hids: string[] }>();
  for (const h of hits) {
    const e = byDoc.get(h.docId) ?? { userId: h.userId, hids: [] };
    e.hids.push(h.hid);
    byDoc.set(h.docId, e);
  }

  let wrote = 0, conflicts = 0, failed = 0, skipped = 0;

  for (const [docId, entry] of byDoc) {
    let doc: any, etag: string | undefined;
    try {
      const read = await c.item(docId, entry.userId).read();
      doc = read.resource;
      etag = (read.resource as any)?._etag;
    } catch (e: any) {
      failed += entry.hids.length;
      console.log(`  READ FAIL  ${docId}  ${e?.message}`);
      continue;
    }
    if (!doc?.holdings) {
      failed += entry.hids.length;
      console.log(`  READ FAIL  ${docId}  doc has no holdings`);
      continue;
    }

    const now = new Date().toISOString();
    let mutated = 0;
    for (const hid of entry.hids) {
      const h = doc.holdings[hid];
      if (!h) { skipped++; continue; }

      const before = JSON.stringify(h);
      clearGradeCompanyWithoutValue(h, { userId: entry.userId, holdingId: hid });
      if (JSON.stringify(h) === before) {
        // Re-asserted against the fresh doc: something fixed it since the scan.
        skipped++;
        console.log(`  SKIP       ${hid}  no longer affected`);
        continue;
      }

      // The grade WAS the price. Force a reprice rather than keep a number
      // computed for a card that turned out not to be graded.
      h.predictedPrice = null;
      h.predictedPriceUpdatedAt = null;
      h.fairMarketValue = null;
      h.lastUpdated = now;

      mutated++;
      console.log(JSON.stringify({
        event: "grade_company_without_value_repaired",
        source: "repair-grade-company-without-value",
        userId: entry.userId,
        holdingId: hid,
      }));
    }

    if (!mutated) continue;

    try {
      await c.item(docId, entry.userId).replace(doc, { accessCondition: { type: "IfMatch", condition: etag! } });
      wrote += mutated;
      console.log(`  WROTE      ${docId}  ${mutated} holding(s)`);
    } catch (e: any) {
      if (e?.code === 412) {
        conflicts += mutated;
        console.log(`  CONFLICT   ${docId}  doc changed under us — nothing written, re-run`);
      } else {
        failed += mutated;
        console.log(`  WRITE FAIL ${docId}  ${e?.message}`);
      }
    }
  }

  console.log(`\nAPPLY DONE  written=${wrote}  skipped=${skipped}  conflicts=${conflicts}  failed=${failed}`);
  if (conflicts || failed) process.exit(4);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
