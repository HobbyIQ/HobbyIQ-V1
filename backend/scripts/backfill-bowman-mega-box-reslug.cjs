#!/usr/bin/env node
// CF-BACKFILL-BOWMAN-MEGA-BOX-RESLUG (Drew, 2026-08-01).
//
// Retroactively re-slugs sold_comps rows where setName mentions
// "Mega Box" but the slug's set segment is generic `bowman`.
// After 2026-08-01 normalizeSetKey fix, new ingest lands at
// bowman-mega-box — this brings existing rows in line.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY / BACKFILL_MODE   apply | dry (default dry)
//   BACKFILL_CONCURRENCY       default 12

const { CosmosClient } = require("@azure/cosmos");

const MODE = (process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")).toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 12));

async function withRetry(fn, attempts = 5, baseMs = 250) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      const is429 = e?.code === 429 || e?.statusCode === 429;
      if (!is429 || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)));
    }
  }
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[backfill-bowman-mega-box-reslug]  mode=${MODE}  concurrency=${CONCURRENCY}`);

  const iter = sc.items.query({
    query: `SELECT * FROM c WHERE IS_DEFINED(c.setName) AND CONTAINS(UPPER(c.setName), 'MEGA BOX')`
  }, { maxItemCount: 500 });

  let examined = 0, wouldChange = 0, errors = 0;
  const transitions = {};
  const inFlight = [];
  const at = new Date().toISOString();

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      const slug = row.hobbyiqCardId;
      if (typeof slug !== "string" || !slug.startsWith("hiq:")) continue;
      const parts = slug.split(":");
      if (parts.length < 6) continue;
      if (parts[3] === "bowman-chrome") continue; // already at correct destination
      // Only reslug rows currently at generic bowman OR (legacy) bowman-mega-box
      if (parts[3] !== "bowman" && parts[3] !== "bowman-mega-box") continue;
      const oldSet = parts[3];
      parts[3] = "bowman-chrome";
      const newSlug = parts.join(":");
      const key = `${oldSet} → bowman-chrome`;
      transitions[key] = (transitions[key] || 0) + 1;
      wouldChange++;
      if (MODE === "apply") {
        row.hobbyiqCardId = newSlug;
        row.__megaBoxReslugAt = at;
        inFlight.push(
          withRetry(() => sc.items.upsert(row)).catch(() => { errors++; })
        );
        if (inFlight.length >= CONCURRENCY) {
          await Promise.race(inFlight);
          for (let i = inFlight.length - 1; i >= 0; i--) {
            const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
            if (s !== "PENDING") inFlight.splice(i, 1);
          }
        }
      }
    }
    if (examined % 50000 === 0) console.log(`  examined=${examined}  wouldChange=${wouldChange}`);
  }
  await Promise.allSettled(inFlight);
  console.log(`\n=== Done ===  examined=${examined}  wouldChange=${wouldChange}  errors=${errors}`);
  Object.entries(transitions).forEach(([k, n]) => console.log(`  ${String(n).padStart(6)}  ${k}`));
}

main().catch(e => { console.error(e); process.exit(1); });
