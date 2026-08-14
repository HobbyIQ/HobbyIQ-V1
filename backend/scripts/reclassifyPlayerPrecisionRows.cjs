#!/usr/bin/env node
// CF-PLAYER-PRECISION-IS-NOT-AWAITING-CATALOG (Drew, 2026-08-14: "yes and 2").
//
// Companion migration to the promotion-job change. That change only affects
// where NEW skips land; this moves the rows already sitting in the wrong bucket.
//
// Two live features cancel each other out:
//
//   PLAYER_FALLBACK_CARDNUMBER_ENABLED mints `pf-<playerSlug>` as the card
//     number when the title has none, expressly so the row can land WITHOUT
//     cardNumber precision
//   CATALOG_MATCH_ONLY_ENABLED then refuses to write anything that does not
//     match a catalog card
//
// Every pf- row is therefore manufactured and immediately rejected. Measured on
// prod: 6,100 distinct slugs carrying 70,732 sales — 22.9% of awaiting-catalog.
//
// They are not unmatched; they are a different PRECISION CLASS. Filing them as
// "awaiting-catalog" claims they are waiting for a checklist, so they inflate
// the catalog-gap work-list, file seeds for checklists that cannot help, and
// are re-tried by every requeue forever. No checklist will ever contain a card
// numbered "pf-league-debut-almost-complete".
//
// NOT a delete and NOT a re-slug: status only. hobbyiqCardId is the partition
// key and is left untouched, so this is a patch, and it is reversible by
// flipping the status back.
//
//   node scripts/reclassifyPlayerPrecisionRows.cjs
//   node scripts/reclassifyPlayerPrecisionRows.cjs --apply

const { CosmosClient } = require("@azure/cosmos");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CONCURRENCY = Number(val("--concurrency", "32"));
const FROM_STATUS = val("--from", "awaiting-catalog");

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const staging = new CosmosClient(cn)
  .database(process.env.COSMOS_DATABASE || "hobbyiq").container("comps_staging");

/** hiq:{vertical}:{year}:{setKey}:{cardNumber}:... — pf- in the cardNumber slot. */
const PF_RE = /^hiq:[^:]*:[^:]*:[^:]*:pf-/;

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; await fn(items[i]); }
  }));
}

(async () => {
  console.log(`reclassify ${FROM_STATUS} -> player-precision — ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  const { resources } = await staging.items.query({
    query: `SELECT c.hobbyiqCardId AS slug, COUNT(1) AS n FROM c
            WHERE c.status = @s AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
            GROUP BY c.hobbyiqCardId`,
    parameters: [{ name: "@s", value: FROM_STATUS }],
  }).fetchAll();

  const pf = resources.filter((r) => PF_RE.test(String(r.slug)));
  const rows = pf.reduce((s, r) => s + Number(r.n ?? 0), 0);
  const allRows = resources.reduce((s, r) => s + Number(r.n ?? 0), 0);
  console.log(`slugs in ${FROM_STATUS}      : ${resources.length.toLocaleString()}  (${allRows.toLocaleString()} sales)`);
  console.log(`  player-precision (pf-)    : ${pf.length.toLocaleString()}  (${rows.toLocaleString()} sales, ${(100 * rows / Math.max(allRows, 1)).toFixed(1)}%)`);
  console.log(`  genuinely awaiting catalog: ${(resources.length - pf.length).toLocaleString()}  (${(allRows - rows).toLocaleString()} sales)\n`);

  console.log("sample:");
  for (const r of pf.slice(0, 8)) console.log(`  ${String(r.n).padStart(5)}  ${r.slug}`);

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to reclassify ${rows.toLocaleString()} rows.`);
    return;
  }
  if (!pf.length) { console.log("\nnothing to reclassify."); return; }

  console.log(`\nreclassifying ${rows.toLocaleString()} rows across ${pf.length.toLocaleString()} slugs...`);
  let moved = 0, errors = 0;
  const now = new Date().toISOString();
  await mapLimit(pf, CONCURRENCY, async (r) => {
    // Single-partition: every row here shares hobbyiqCardId = slug.
    const { resources: ids } = await staging.items.query({
      query: "SELECT c.id FROM c WHERE c.status = @s",
      parameters: [{ name: "@s", value: FROM_STATUS }],
    }, { partitionKey: r.slug }).fetchAll();
    for (const it of ids) {
      try {
        await staging.item(it.id, r.slug).patch([
          { op: "set", path: "/status", value: "player-precision" },
          { op: "set", path: "/playerPrecisionSince", value: now },
          { op: "set", path: "/reclassifiedFrom", value: FROM_STATUS },
        ]);
        moved++;
      } catch (e) {
        errors++;
        if (errors <= 3) console.error("  write error:", String(e && e.message).slice(0, 140));
      }
    }
  });

  console.log(`\nRECLASSIFIED : ${moved.toLocaleString()}`);
  console.log(`errors       : ${errors}`);
  console.log(`\nReversible: the rows carry reclassifiedFrom="${FROM_STATUS}".`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
