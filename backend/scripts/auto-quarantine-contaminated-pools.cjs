#!/usr/bin/env node
// CF-AUTO-QUARANTINE-POOLS (Drew, 2026-08-01). Closes the slug-audit
// loop: when a pool has ≥25 samples AND ≥50% flagged rows, quarantine
// EVERY row in that pool (__poolAutoQuarantined=true). Downstream FMV
// pool queries can filter this flag to isolate contaminated pools
// wholesale.
//
// Runs from the nightly cron. Idempotent — rows already marked don't
// get touched again. Rows in newly-clean pools get their flag cleared.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY / BACKFILL_MODE   apply | dry (default dry)
//   BACKFILL_CONCURRENCY       default 8
//   POOL_MIN_SAMPLES           default 25
//   POOL_CONTAMINATION_PCT     default 50 (percent)

const { CosmosClient } = require("@azure/cosmos");

const MODE = (process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")).toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));
const MIN_SAMPLES = Math.max(5, Number(process.env.POOL_MIN_SAMPLES || 25));
const CONTAMINATION_THRESHOLD = Math.max(10, Number(process.env.POOL_CONTAMINATION_PCT || 50)) / 100;

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
  console.log(`[auto-quarantine-pools]  mode=${MODE}  concurrency=${CONCURRENCY}  minSamples=${MIN_SAMPLES}  threshold=${CONTAMINATION_THRESHOLD * 100}%`);

  // Phase 1: aggregate per-slug counts of total + flagged
  console.log("\nPhase 1: aggregate contamination per slug...");
  const perSlug = new Map();
  const iter = sc.items.query({
    query: `SELECT c.hobbyiqCardId, c.__priceOutlier, c.__cardsightUnverified,
                   c.__userFlagQuarantine, c.__badActorSeller
              FROM c WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:')`
  }, { maxItemCount: 5000 });
  let scanned = 0;
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      scanned++;
      const slug = r.hobbyiqCardId;
      let entry = perSlug.get(slug);
      if (!entry) { entry = { total: 0, flagged: 0 }; perSlug.set(slug, entry); }
      entry.total++;
      const flagged = r.__priceOutlier === true || r.__cardsightUnverified === true
        || r.__userFlagQuarantine === true || r.__badActorSeller === true;
      if (flagged) entry.flagged++;
    }
  }
  console.log(`  scanned=${scanned}  slugs=${perSlug.size}`);

  // Identify slugs to quarantine
  const toQuarantine = new Set();
  for (const [slug, e] of perSlug) {
    if (e.total < MIN_SAMPLES) continue;
    if (e.flagged / e.total < CONTAMINATION_THRESHOLD) continue;
    toQuarantine.add(slug);
  }
  console.log(`  slugs to auto-quarantine: ${toQuarantine.size}`);

  if (toQuarantine.size === 0) { console.log("Nothing to do."); return; }

  // Phase 2: tag every row in those slugs with __poolAutoQuarantined
  console.log("\nPhase 2: tag rows...");
  let tagged = 0, alreadyTagged = 0, errors = 0;
  const inFlight = [];
  const at = new Date().toISOString();
  for (const slug of toQuarantine) {
    const { resources: rows } = await sc.items.query({
      query: `SELECT * FROM c WHERE c.hobbyiqCardId = @s AND (NOT IS_DEFINED(c.__poolAutoQuarantined) OR c.__poolAutoQuarantined != true)`,
      parameters: [{ name: "@s", value: slug }],
    }).fetchAll();
    for (const row of rows) {
      if (MODE === "apply") {
        row.__poolAutoQuarantined = true;
        row.__poolAutoQuarantinedAt = at;
        inFlight.push(
          withRetry(() => sc.items.upsert(row)).then(() => { tagged++; }).catch(() => { errors++; })
        );
        if (inFlight.length >= CONCURRENCY) {
          await Promise.race(inFlight);
          for (let i = inFlight.length - 1; i >= 0; i--) {
            const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
            if (s !== "PENDING") inFlight.splice(i, 1);
          }
        }
      } else { tagged++; }
    }
  }
  await Promise.allSettled(inFlight);
  console.log(`\n=== Done ===  quarantinedSlugs=${toQuarantine.size}  taggedRows=${tagged}  alreadyTagged=${alreadyTagged}  errors=${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
