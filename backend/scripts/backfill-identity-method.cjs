// CF-IDENTITY-METHOD-BACKFILL (Drew, 2026-08-03). identityMethod
// started being written on 2026-08-03 mid-day. The ~158K TCA rows
// landed before that lack the tag. Downstream code that filters
// identityMethod = 'cardnumber-precise' silently misses them.
//
// Backfill: any row where identityMethod is missing gets it inferred
// from cardNumber:
//   - starts with "pf-"  → "player-fallback"
//   - anything else      → "cardnumber-precise"
//
// Zero API cost, purely local. Idempotent (skips rows already tagged).
//
// Env:
//   COSMOS_CONNECTION_STRING  required
//   APPLY=true                write (else dry-run count only)
//   VENDOR=tca-ebay           filter (default all TCA vendors)
//   MAX_MINUTES=45            wall-clock cap

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.APPLY === "true";
const VENDOR = process.env.VENDOR || "tca-ebay";
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 45));
const BATCH = Number(process.env.BATCH || 500);

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(cs);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sc = db.container("sold_comps");

  console.log(`[identity-backfill] apply=${APPLY} vendor=${VENDOR} maxMin=${MAX_MINUTES}`);
  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  const q = {
    query: `SELECT c.id, c.cardId, c.cardNumber FROM c
            WHERE c.source = @src AND (NOT IS_DEFINED(c.identityMethod) OR c.identityMethod = null)`,
    parameters: [{ name: "@src", value: VENDOR }],
  };
  const iter = sc.items.query(q, { maxItemCount: BATCH });

  let scanned = 0, tagged = 0, precise = 0, fallback = 0, failed = 0;
  const CONCURRENCY = 32;
  const inflight = new Set();

  while (iter.hasMoreResults()) {
    if (Date.now() - startMs > budgetMs) { console.warn("[identity-backfill] wall-clock cap"); break; }
    const { resources } = await iter.fetchNext();
    for (const row of resources) {
      scanned++;
      const method = String(row.cardNumber ?? "").startsWith("pf-") ? "player-fallback" : "cardnumber-precise";
      if (method === "cardnumber-precise") precise++; else fallback++;
      if (!APPLY) continue;

      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      const p = sc.item(row.id, row.cardId).patch([
        { op: "add", path: "/identityMethod", value: method },
        { op: "add", path: "/identityMethodBackfilledAt", value: new Date().toISOString() },
      ])
        .then(() => { tagged++; })
        .catch((err) => {
          failed++;
          if (failed < 10) console.warn(`  patch failed id=${row.id}: ${err?.code ?? err?.message ?? err}`);
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);

      if (scanned % 5000 === 0) {
        const el = ((Date.now()-startMs)/1000).toFixed(0);
        const rate = (scanned / Math.max(1,(Date.now()-startMs)/1000)).toFixed(1);
        console.log(`  scanned=${scanned} tagged=${tagged} precise=${precise} fallback=${fallback} failed=${failed} rate=${rate}/s el=${el}s`);
      }
    }
  }
  await Promise.all([...inflight]);

  console.log(`\n[identity-backfill] done — scanned=${scanned} tagged=${tagged} precise=${precise} fallback=${fallback} failed=${failed} elapsed=${((Date.now()-startMs)/1000).toFixed(0)}s`);
  if (!APPLY) console.log(`(dry-run — no writes)`);
}

main().catch(err => { console.error(err); process.exit(1); });
