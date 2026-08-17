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

  const STATUSES = String(process.env.STATUSES || "pending")
    .split(",").map((s) => s.trim()).filter(Boolean);
  console.log(`[promoter] apply=${APPLY} statuses=${STATUSES.join(",")} vendor=${VENDOR || "*"} maxMin=${MAX_MINUTES} batch=${BATCH_SIZE} concurrency=${CONCURRENCY}`);
  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  // CF-AWAITING-CATALOG-IS-NOT-A-DEAD-END (Drew, 2026-08-16: "what is going on
  // with the sales index? are things not cleaning?").
  //
  // This filter was hardcoded to status='pending', so a row diverted to
  // 'awaiting-catalog' was NEVER looked at again. That makes the divert a
  // one-way door: the row is parked because the catalog lacked its card, and
  // then no amount of catalog work can ever bring it back — the promoter does
  // not ask.
  //
  // Measured 2026-08-16, sampling the awaiting-catalog backlog and testing each
  // row against the catalog AS IT STANDS: 112 of 150 (75%) WOULD resolve right
  // now. Against 909,175 parked rows that is roughly 680,000 sales sitting one
  // re-drive away from the pool, while the index looked stalled.
  //
  // STATUSES is a comma list so the routine pass stays 'pending' (cheap, keeps
  // up with inbound) and a re-drive pass can be scheduled separately after
  // checklists land. Re-driving is safe by construction: a row that still finds
  // no catalog row is simply re-parked in the same status.
  const parameters = [];
  const statusParams = STATUSES.map((s, i) => {
    parameters.push({ name: `@st${i}`, value: s });
    return `@st${i}`;
  });
  let filter = `c.status IN (${statusParams.join(", ")})`;
  if (VENDOR) { filter += " AND c.raw.vendor = @vendor"; parameters.push({ name: "@vendor", value: VENDOR }); }
  // CF-STAGING-FLIP-PARTITION-KEY (Drew, 2026-08-14). hobbyiqCardId is
  // the PARTITION KEY of comps_staging and must be projected here — the
  // status flip below is a point-write and cannot address the document
  // without it. It was previously absent, which is why the flip fell
  // back to row.id and silently 404'd on every row.
  const q = {
    query: `SELECT c.id, c.hobbyiqCardId, c.raw, c._ts FROM c WHERE ${filter}`,
    parameters,
  };
  const iter = stg.items.query(q, { maxItemCount: BATCH_SIZE });

  let scanned = 0, tried = 0, inserted = 0, deduped = 0, skipped = 0, catalogUnmatched = 0, errored = 0, statusFlipped = 0, patchFailed = 0, divertedToVerify = 0;
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
          const diverted = res.divertedToVerify ?? 0;
          divertedToVerify += diverted;
          // CF-CATALOG-MATCH-ONLY (Drew, 2026-08-08). Flip status also
          // on catalog-unmatched so the row stops getting re-tried —
          // it's now in the admin review pool, decision belongs there.
          //
          // CF-PROMOTER-VERIFY-LOOP (Drew, 2026-08-15). Same rule, same
          // reason, for rows diverted to verify_queue — and this one was
          // missing, which is why the backlog never fell.
          //
          // persistVendorSalesToPool reports a diverted row as `skipped`,
          // and `skipped` was not in this condition. So the row stayed
          // pending, got re-scanned on the next hourly run, and was
          // RE-ENQUEUED to verify_queue every single time. Measured
          // before this fix: 1,839,312 rows stuck pending for 5-14 days,
          // verify_queue at 1,333,299 entries (828,699 price-outlier +
          // 457,801 parser-low-confidence), and a continuous Cosmos 429
          // storm from the repeated writes. Run 31902272869 scanned
          // 276,500 rows and skipped 274,860 — 99.4% of a 45-minute
          // budget spent re-doing work it had already done.
          //
          // A diverted row is not lost: it is in verify_queue and a human
          // owns the decision, exactly like catalog-unmatched. Flipping it
          // is what lets the promoter's budget reach rows it has not seen.
          if (res.inserted > 0 || res.deduped > 0 || unmatched > 0 || diverted > 0) {
            const newStatus = res.inserted > 0
              ? "promoted"
              : (unmatched > 0 ? "catalog-unmatched"
              : (diverted > 0 ? "awaiting-verify" : "already-in-pool"));
            // CF-STAGING-FLIP-PARTITION-KEY (Drew, 2026-08-14). The
            // partition key is hobbyiqCardId, NOT id. Passing row.id
            // addressed a partition that does not exist, so every patch
            // 404'd and no row was ever flipped out of 'pending'.
            //
            // Measured on run 31861919160 before this fix:
            //   inserted=4725  flipped=0  "patch failed ... 404" x15,170
            //
            // The rows were written to sold_comps correctly and then
            // left pending, so every subsequent run re-scanned the same
            // rows from the top — which is what the 48.6% dedupe rate in
            // that run actually was. The backlog could never fall, and
            // nothing alarmed because the job exits 0 either way.
            try {
              await stg.item(row.id, row.hobbyiqCardId).patch([
                { op: "replace", path: "/status", value: newStatus },
                { op: "add", path: "/statusUpdatedAt", value: new Date().toISOString() },
              ]);
              statusFlipped++;
            } catch (patchErr) {
              // A failed flip is NOT cosmetic: the row is already in
              // sold_comps, so leaving it pending guarantees it is
              // re-processed forever. Count it so a broken flip shows up
              // in the summary line instead of hiding behind inserted>0.
              patchFailed++;
              if (patchFailed <= 10) console.warn(`  patch failed id=${row.id}: ${patchErr?.code ?? patchErr?.message ?? patchErr}`);
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
        console.log(`  scanned=${scanned} tried=${tried} inserted=${inserted} deduped=${deduped} skipped=${skipped} diverted=${divertedToVerify} catalogUnmatched=${catalogUnmatched} flipped=${statusFlipped} patchFailed=${patchFailed} errored=${errored} rate=${rate}/s elapsed=${el}s`);
      }
    }
  }
  await Promise.all([...inflight]);

  console.log(`\n[promoter] done — scanned=${scanned} tried=${tried} inserted=${inserted} deduped=${deduped} skipped=${skipped} diverted=${divertedToVerify} catalogUnmatched=${catalogUnmatched} flipped=${statusFlipped} patchFailed=${patchFailed} errored=${errored} elapsed=${((Date.now()-startMs)/1000).toFixed(0)}s`);
  if (!APPLY) console.log(`(dry-run — no writes)`);
}

main().catch(err => { console.error(err); process.exit(1); });
