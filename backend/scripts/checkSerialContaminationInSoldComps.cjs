#!/usr/bin/env node
// CF-SERIAL-CONTAMINATION-CHECK (Drew, 2026-08-14).
//
// verifySerialAsCardNumber confirmed ~6,500 staged slugs took their card number
// from a serial ("22/30" -> cardNumber 2230). Those are stuck in
// awaiting-catalog, which is harmless — they never reached the sales index.
//
// The question that actually matters is whether any got THROUGH. A sold_comp
// filed under hiq:baseball:2025:topps:2550 is a phantom card holding real
// money, and FMV for it is computed from a pool that should not exist. That is
// a pricing defect, not a backlog defect.
//
// CATALOG_MATCH_ONLY_ENABLED should have blocked them — but it has not always
// been on, so this checks rather than assumes.
//
// Cheap and exact: sold_comps partitions on /cardId and these slugs ARE cardIds,
// so each check is a single-partition COUNT, not a scan.
//
//   node scripts/checkSerialContaminationInSoldComps.cjs --sample 400

const { CosmosClient } = require("@azure/cosmos");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SAMPLE = Number(val("--sample", "400"));
const CONCURRENCY = Number(val("--concurrency", "24"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const db = new CosmosClient(cn).database(process.env.COSMOS_DATABASE || "hobbyiq");
const staging = db.container("comps_staging");
const sold = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER || "sold_comps");

function parse(slug) {
  const p = String(slug).split(":");
  if (p.length < 7) return null;
  return { cardNumber: p[4], printRun: p[7] && p[7].startsWith("num-") ? p[7].slice(4) : null };
}
function looksLikeSerial(cardNumber, printRun) {
  if (!printRun || !/^\d+$/.test(cardNumber)) return false;
  if (!cardNumber.endsWith(printRun) || cardNumber.length <= printRun.length) return false;
  const head = cardNumber.slice(0, cardNumber.length - printRun.length);
  return /^\d+$/.test(head) && Number(head) <= Number(printRun);
}
async function mapLimit(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; await fn(items[i]); }
  }));
}

(async () => {
  const { resources } = await staging.items.query({
    query: `SELECT c.hobbyiqCardId AS slug, COUNT(1) AS n FROM c
            WHERE c.status = 'awaiting-catalog' AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
            GROUP BY c.hobbyiqCardId`,
  }).fetchAll();

  const flagged = resources.filter((r) => {
    const c = parse(r.slug); return c && looksLikeSerial(c.cardNumber, c.printRun);
  }).sort((a, b) => b.n - a.n);

  const step = Math.max(1, Math.floor(flagged.length / SAMPLE));
  const picked = flagged.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  console.log(`flagged slugs: ${flagged.length.toLocaleString()}   probing sold_comps for ${picked.length}\n`);

  let withComps = 0, totalComps = 0;
  const hits = [];
  await mapLimit(picked, CONCURRENCY, async (r) => {
    try {
      const { resources: c } = await sold.items.query({
        query: "SELECT VALUE COUNT(1) FROM c",
      }, { partitionKey: r.slug }).fetchAll();
      const n = c[0] ?? 0;
      if (n > 0) {
        withComps++; totalComps += n;
        if (hits.length < 15) hits.push(`${String(n).padStart(5)} comps  ${r.slug}`);
      }
    } catch { /* treat as no comps */ }
  });

  console.log(`slugs WITH sold_comps : ${withComps} / ${picked.length}`);
  console.log(`comps under them      : ${totalComps.toLocaleString()}`);
  if (withComps === 0) {
    console.log("\nCLEAN — the catalog-match gate held; no phantom cards reached the sales index.");
  } else {
    const rate = withComps / picked.length;
    console.log(`\nCONTAMINATED — ~${(100 * rate).toFixed(1)}% of flagged slugs carry comps`);
    console.log(`extrapolated over ${flagged.length.toLocaleString()} flagged slugs: ~${Math.round(flagged.length * rate).toLocaleString()} phantom cards in sold_comps`);
    console.log("\nexamples:");
    for (const h of hits) console.log(`  ${h}`);
  }
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
