// CF-STAGING-PROMOTER (Drew, 2026-08-03). Walks comps_staging rows with
// status='pending' and re-runs them through persistVendorSalesToPool with
// today's improved cleaner (LLM enrichment, player-fallback, TCA catalog
// fallback). Rows that resolve get their status flipped to 'promoted';
// rows that still can't resolve stay 'pending' for a future re-run.
//
// Zero API cost — reads staged raw and processes locally. The one
// per-row TCA /catalog call may fire when checklistNarrow misses AND
// TCA_CATALOG_FALLBACK_ENABLED=true; that's cached in-memory.
//
// Env:
//   COSMOS_CONNECTION_STRING  required
//   COSMOS_DATABASE           default "hobbyiq"
//   APPLY=true                write to sold_comps + flip status (else dry-run)
//   MAX_MINUTES=60            wall-clock cap
//   VENDOR                    filter by raw.vendor, e.g. "tca-ebay" (default no filter)
//   BATCH_SIZE=500            rows per Cosmos query page
//   CONCURRENCY=32            parallel persist calls
//   PERSIST_LLM_ENRICH_ENABLED  must be "true" for LLM enrichment
//   TCA_API_KEY               required if TCA_CATALOG_FALLBACK_ENABLED=true
//   AZURE_OPENAI_*            required if PERSIST_LLM_ENRICH_ENABLED=true

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const fs = require("fs");

function loadPersistHelper() {
  const distRoot = path.resolve(__dirname, "..", "dist");
  const helperPath = path.join(distRoot, "services", "portfolioiq", "persistVendorSalesToPool.service.js");
  if (!fs.existsSync(helperPath)) {
    throw new Error(`persistVendorSalesToPool helper not found at ${helperPath} — run \`npm run build\` first`);
  }
  return require(helperPath).persistVendorSalesToPool;
}

const APPLY = process.env.APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 60));
const VENDOR = process.env.VENDOR || null;
const BATCH_SIZE = Math.max(50, Number(process.env.BATCH_SIZE || 500));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 32));

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(cs);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const stg = db.container("comps_staging");
  const persist = loadPersistHelper();

  console.log(`[promoter] apply=${APPLY} vendor=${VENDOR || "*"} maxMin=${MAX_MINUTES} batch=${BATCH_SIZE} concurrency=${CONCURRENCY}`);
  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  // Filter for status=pending + optional vendor
  const parameters = [];
  let filter = "c.status = 'pending'";
  if (VENDOR) { filter += " AND c.raw.vendor = @vendor"; parameters.push({ name: "@vendor", value: VENDOR }); }
  const q = {
    query: `SELECT c.id, c.raw, c._ts FROM c WHERE ${filter}`,
    parameters,
  };
  const iter = stg.items.query(q, { maxItemCount: BATCH_SIZE });

  let scanned = 0, tried = 0, inserted = 0, deduped = 0, skipped = 0, catalogUnmatched = 0, errored = 0, statusFlipped = 0;
  const inflight = new Set();

  while (iter.hasMoreResults()) {
    if (Date.now() - startMs > budgetMs) {
      console.warn(`[promoter] wall-clock cap reached at scanned=${scanned}`);
      break;
    }
    const { resources } = await iter.fetchNext();
    for (const row of resources) {
      scanned++;
      const raw = row.raw || {};
      const vp = raw.vendorPayload || {};
      // Build the vendor-sale row shape persistVendorSalesToPool expects
      const vsRow = {
        title: vp.title || null,
        price: typeof vp.price === "number" ? vp.price : Number(vp.price ?? 0),
        soldAt: vp.soldAt || null,
        url: vp.url || null,
        externalId: vp.externalId || vp.id || raw.vendorRawId || null,
        imageUrl: vp.imageUrl || null,
      };
      if (!vsRow.soldAt || !(vsRow.price > 0)) { skipped++; continue; }

      // Preserve identity hints TCA sent us in the original payload
      const hint = {};
      if (vp.playerName) hint.playerName = String(vp.playerName);
      if (typeof vp.cardYear === "number") hint.cardYear = vp.cardYear;
      if (vp.sport) hint.sport = String(vp.sport).toLowerCase();
      if (vp.cardNumber) hint.cardNumber = String(vp.cardNumber);
      if (vp.setName) hint.setName = String(vp.setName);

      tried++;
      if (!APPLY) continue;

      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      const p = persist(raw.vendor || "tca-ebay", [vsRow], hint)
        .then(async (res) => {
          inserted += res.inserted;
          deduped += res.deduped;
          skipped += res.skipped;
          const unmatched = res.catalogUnmatched ?? 0;
          catalogUnmatched += unmatched;
          // CF-CATALOG-MATCH-ONLY (Drew, 2026-08-08). Flip status also
          // on catalog-unmatched so the row stops getting re-tried —
          // it's now in the admin review pool, decision belongs there.
          if (res.inserted > 0 || res.deduped > 0 || unmatched > 0) {
            const newStatus = res.inserted > 0
              ? "promoted"
              : (unmatched > 0 ? "catalog-unmatched" : "already-in-pool");
            try {
              await stg.item(row.id, row.id).patch([
                { op: "replace", path: "/status", value: newStatus },
                { op: "add", path: "/statusUpdatedAt", value: new Date().toISOString() },
              ]);
              statusFlipped++;
            } catch (patchErr) {
              // Non-fatal — row stays pending, next run will re-try
              if (errored < 10) console.warn(`  patch failed id=${row.id}: ${patchErr?.code ?? patchErr?.message ?? patchErr}`);
            }
          }
        })
        .catch((err) => {
          errored++;
          if (errored < 10) console.warn(`  persist failed id=${row.id}: ${err?.code ?? err?.message ?? err}`);
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);

      if (tried % 1000 === 0) {
        const el = ((Date.now() - startMs) / 1000).toFixed(0);
        const rate = (tried / Math.max(1, (Date.now() - startMs) / 1000)).toFixed(1);
        console.log(`  scanned=${scanned} tried=${tried} inserted=${inserted} deduped=${deduped} skipped=${skipped} catalogUnmatched=${catalogUnmatched} flipped=${statusFlipped} errored=${errored} rate=${rate}/s elapsed=${el}s`);
      }
    }
  }
  await Promise.all([...inflight]);

  console.log(`\n[promoter] done — scanned=${scanned} tried=${tried} inserted=${inserted} deduped=${deduped} skipped=${skipped} catalogUnmatched=${catalogUnmatched} flipped=${statusFlipped} errored=${errored} elapsed=${((Date.now()-startMs)/1000).toFixed(0)}s`);
  if (!APPLY) console.log(`(dry-run — no writes)`);
}

main().catch(err => { console.error(err); process.exit(1); });
