// CF-TCA-FIREHOSE (Drew, 2026-08-02). Continuous ingest from
// thecardapi.com's /sales endpoint into sold_comps. Replaces the
// on-demand CH pull model — every eBay sports sale lands in our pool
// within ~15 min, tagged source: "tca-ebay".
//
// See backend/docs/design/tca-firehose-ingest-architecture.md for the
// full design. This script implements Phases 1-2 of that memo.
//
// Two modes:
//   INGEST_MODE=incremental (default)
//     - Reads cursor from crawl_state container
//     - Walks TCA /sales cursor-forward until page returns empty or
//       MAX_MINUTES elapsed
//     - Persists cursor back to crawl_state on success
//     - Idempotent: same TCA id → same sold_comps row (upsert by id)
//
//   INGEST_MODE=backfill
//     - Ignores crawl_state cursor
//     - Fetches from oldest TCA cursor forward (or reverses date order)
//     - Used once per catchup run for the 2.95M sports-eBay pool
//
// Env:
//   TCA_API_KEY                  required
//   COSMOS_CONNECTION_STRING     required
//   COSMOS_DATABASE              default "hobbyiq"
//   INGEST_MODE                  "incremental" | "backfill"     (default "incremental")
//   MAX_MINUTES                  wall-clock cap                  (default 12)
//   APPLY                        "true" to write, else dry-run  (default false)
//   PLATFORM                     TCA platform filter             (default "eBay")
//   CATEGORY                     TCA category filter             (default "sports")
//   PAGE_LIMIT                   rows per TCA request            (default 1000, max 1000)
//   SORT                         "date_desc" | "date_asc"        (default "date_desc")
//                                Enterprise-tier unlimited-lookback: use "date_asc" for
//                                historical backfill from oldest sales forward.

const { CosmosClient } = require("@azure/cosmos");
const https = require("https");

const APPLY = process.env.APPLY === "true";
const MODE = (process.env.INGEST_MODE || "incremental").toLowerCase();
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 12));
const PLATFORM = process.env.PLATFORM || "eBay";
const CATEGORY = process.env.CATEGORY || "sports";
const PAGE_LIMIT = Math.min(1000, Math.max(1, Number(process.env.PAGE_LIMIT || 1000)));
const SORT = (process.env.SORT || "date_desc").toLowerCase();
const CRAWLER_ID = process.env.CRAWLER_ID || `tca-${PLATFORM.toLowerCase()}-${CATEGORY}-${SORT}`;

const TCA_HOST = "www.thecardapi.com";
const TCA_PATH = "/api/v1/market/sales";

// ─── HTTP helper ─────────────────────────────────────────────────────

function tcaFetch(qs) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TCA_HOST,
      port: 443,
      path: `${TCA_PATH}?${qs}`,
      method: "GET",
      headers: {
        "x-market-api-key": process.env.TCA_API_KEY,
        "Accept": "application/json",
      },
      timeout: 60_000,
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode === 429) {
          const retryAfter = Number(res.headers["retry-after"] || 60);
          return reject({ code: 429, retryAfter, body: d.slice(0, 300) });
        }
        if (res.statusCode >= 400) {
          return reject({ code: res.statusCode, body: d.slice(0, 500) });
        }
        try { resolve(JSON.parse(d)); }
        catch (e) { reject({ code: -1, message: "JSON parse failed", body: d.slice(0, 500) }); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject({ code: -2, message: "timeout" }); });
    req.on("error", (err) => reject({ code: -3, message: err.message }));
    req.end();
  });
}

async function fetchPageWithRetry(qs, attempt = 1) {
  try { return await tcaFetch(qs); }
  catch (err) {
    if (err.code === 429 && attempt <= 3) {
      const waitMs = (err.retryAfter || 60) * 1000;
      console.warn(`[tca] 429 throttled — waiting ${waitMs / 1000}s then retry ${attempt}/3`);
      await new Promise(r => setTimeout(r, waitMs));
      return fetchPageWithRetry(qs, attempt + 1);
    }
    if ((err.code === -2 || err.code === -3 || (err.code >= 500 && err.code < 600)) && attempt <= 3) {
      const waitMs = Math.min(30_000, 1000 * Math.pow(3, attempt - 1));
      console.warn(`[tca] transient err code=${err.code} — waiting ${waitMs / 1000}s then retry ${attempt}/3`);
      await new Promise(r => setTimeout(r, waitMs));
      return fetchPageWithRetry(qs, attempt + 1);
    }
    throw err;
  }
}

// ─── Row reshaper ────────────────────────────────────────────────────

// Map a TCA sale to a sold_comps row. Rows without structured
// player+year+setName default to __pendingMatch: true so the async
// matcher picks them up.
function tcaToSoldComp(t) {
  const hasIdentity = !!(t.player && t.year && (t.card_set || t.card_number));
  const gradeCompany = t.grader || null;
  const gradeValueRaw = t.grade || null;
  // TCA grades come like "PSA 10" or just "9". Parse numeric value.
  let gradeValueNum = null;
  if (gradeValueRaw) {
    const m = String(gradeValueRaw).match(/(\d+(?:\.\d+)?)/);
    if (m) gradeValueNum = Number(m[1]);
  }
  // TCA sport enum is inconsistent ("Baseball" / "BASEBALL" / "baseball" all appear).
  const sport = t.sport ? String(t.sport).toLowerCase() : null;
  const cardYear = (typeof t.year === "number") ? t.year : (t.year && Number.isFinite(Number(t.year)) ? Number(t.year) : null);

  return {
    // sold_comps schema uses cardId as partition key. When TCA identity
    // isn't matched yet, we can't compute the CH-cardId — use a synthetic
    // partition based on the TCA id so writes distribute evenly.
    cardId: t.id,   // reshuffled downstream when matcher populates real cardId + slug
    source: "tca-ebay",
    sourceExternalId: t.id,
    price: Number(t.price),
    soldAt: t.sold_at || (t.sale_date ? new Date(t.sale_date + "T12:00:00Z").toISOString() : null),
    playerName: t.player || null,
    setName: t.card_set || null,
    cardNumber: t.card_number || null,
    cardYear,
    sport,
    parallel: null,   // TCA doesn't split parallel from card_set — matcher will parse from title later
    isAuto: t.has_autograph_grade === true ? true : null,
    printRun: (typeof t.print_run === "number") ? t.print_run : null,
    gradeCompany,
    gradeValue: gradeValueNum,
    imageUrl: t.image_url || null,
    tcaListingUrl: t.listing_url || null,
    tcaPlatform: t.platform || null,
    title: t.title || null,
    hobbyiqCardId: null,  // matcher fills in
    confidence: 0.5,       // raw eBay listing, not vendor-authoritative
    __pendingMatch: !hasIdentity,
    __tcaIngestedAt: new Date().toISOString(),
    contributorUserId: null,
    verifiedByUser: false,
  };
}

// ─── Crawl state ─────────────────────────────────────────────────────

async function getState(container) {
  try {
    const { resource } = await container.item(CRAWLER_ID, CRAWLER_ID).read();
    return resource;
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}
async function putState(container, state) {
  await container.items.upsert({ ...state, id: CRAWLER_ID });
}

// ─── Main loop ───────────────────────────────────────────────────────

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  if (!process.env.TCA_API_KEY) { console.error("TCA_API_KEY required"); process.exit(1); }

  const c = new CosmosClient(cs);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sold = db.container("sold_comps");
  const state = db.container("crawl_state");

  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  console.log(`[tca-firehose] mode=${MODE} apply=${APPLY} platform=${PLATFORM} category=${CATEGORY} maxMinutes=${MAX_MINUTES}`);

  // Load state
  let cursor = null;
  let existing = null;
  if (MODE === "incremental") {
    existing = await getState(state);
    if (existing) {
      cursor = existing.cursor;
      console.log(`[tca-firehose] resume from cursor: ${(cursor||'').slice(0,60)}…`);
    } else {
      console.log(`[tca-firehose] no prior cursor — starting from newest and walking back`);
    }
  } else {
    console.log(`[tca-firehose] BACKFILL mode — ignoring stored cursor`);
  }

  const baseQs = new URLSearchParams({
    limit: String(PAGE_LIMIT),
    platform: PLATFORM,
    category: CATEGORY,
    sort: SORT,
  });

  let page = 0;
  let totalFetched = 0;
  let totalWritten = 0;
  let totalDedupSkipped = 0;
  let totalErrors = 0;
  let lastCursor = cursor;

  while (true) {
    if (Date.now() - startMs > budgetMs) {
      console.log(`[tca-firehose] wall-clock cap ${MAX_MINUTES}m reached — stopping cleanly, cursor preserved`);
      break;
    }
    const qs = new URLSearchParams(baseQs);
    if (lastCursor) qs.set("cursor", lastCursor);
    let resp;
    try { resp = await fetchPageWithRetry(qs.toString()); }
    catch (err) {
      console.error(`[tca-firehose] fatal fetch error:`, err);
      totalErrors++;
      break;
    }
    const rows = (resp && resp.data) || [];
    if (rows.length === 0) {
      console.log(`[tca-firehose] page ${page + 1}: 0 rows — reached end of feed`);
      break;
    }
    page++;
    totalFetched += rows.length;

    if (APPLY) {
      // Upsert rows. Concurrency 8 keeps Cosmos happy.
      const CONCURRENCY = 8;
      const inflight = new Set();
      for (const t of rows) {
        while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
        const doc = tcaToSoldComp(t);
        if (!doc.soldAt || !(doc.price > 0)) { totalDedupSkipped++; continue; }
        const p = sold.items.upsert(doc)
          .then(() => { totalWritten++; })
          .catch((err) => {
            totalErrors++;
            if (totalErrors < 10) console.warn(`  upsert failed id=${t.id}: ${err?.code ?? err?.message ?? err}`);
          })
          .finally(() => inflight.delete(p));
        inflight.add(p);
      }
      await Promise.all([...inflight]);
    } else {
      // Dry-run: count only
      totalWritten += rows.length;
    }

    lastCursor = resp?.pagination?.next_cursor || null;
    if ((page % 5) === 0 || !lastCursor) {
      const elapsedS = ((Date.now() - startMs) / 1000).toFixed(0);
      const ratePerS = (totalWritten / Math.max(1, (Date.now() - startMs) / 1000)).toFixed(1);
      console.log(`[tca-firehose] page ${page}: fetched=${totalFetched} written=${totalWritten} skipped=${totalDedupSkipped} errors=${totalErrors} elapsed=${elapsedS}s rate=${ratePerS}/s`);
    }
    if (!lastCursor) {
      console.log(`[tca-firehose] no next_cursor — end of feed`);
      break;
    }
  }

  // Persist state (only in real-write mode; dry-run leaves state untouched)
  if (APPLY && MODE === "incremental") {
    const newState = {
      cursor: lastCursor,
      lastRunAt: new Date().toISOString(),
      totalRowsWritten: (existing?.totalRowsWritten || 0) + totalWritten,
      lastPagesFetched: page,
      lastError: totalErrors > 0 ? `${totalErrors} row-level errors` : null,
    };
    await putState(state, newState);
    console.log(`[tca-firehose] state persisted — cursor advanced, cumulativeTotal=${newState.totalRowsWritten}`);
  }

  const elapsedS = ((Date.now() - startMs) / 1000).toFixed(0);
  console.log(`\n[tca-firehose] done — pages=${page} fetched=${totalFetched} written=${totalWritten} skipped=${totalDedupSkipped} errors=${totalErrors} elapsed=${elapsedS}s`);
  if (!APPLY) console.log(`(dry-run — no sold_comps writes, no state persisted)`);
}

main().catch(err => { console.error(err); process.exit(1); });
