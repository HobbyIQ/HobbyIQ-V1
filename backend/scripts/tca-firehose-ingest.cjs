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
const path = require("path");
const fs = require("fs");
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW (D18, 2026-08-29). Counters, disjoint:
//   intended = TCA rows fetched under APPLY (each is pre-checked or persisted)
//   written  = inserted by persistVendorSalesToPool
//   skipped  = unusable before persist + deduped + skipped + catalogUnmatched
//              (the service lands every row in exactly one of its four counts;
//              catalogUnmatched was not being tallied at all until D18)
//   failed   = persist calls that rejected (row-level)
// A TCA FETCH that fails is fetchErrors — no rows, so nothing intended. The
// crawl_state upsert is one doc; if it throws the run exits 1, not green.
const { reportWrites } = require(path.join(__dirname, "..", "dist/services/ops/writeReconciliation.js"));

// CF-TCA-USE-CLEAN-PIPELINE (Drew, 2026-08-02). Route through
// persistVendorSalesToPool so TCA rows get the SAME treatment as CH
// rows: parseListingIdentity, computeHobbyIqCardId, contentHash dedup,
// staging shim, image mirror, verify-queue sampling. Requires
// `npm run build` in backend/ before running so dist/ exists.
function loadPersistHelper() {
  const distRoot = path.resolve(__dirname, "..", "dist");
  const helperPath = path.join(distRoot, "services", "portfolioiq", "persistVendorSalesToPool.service.js");
  if (!fs.existsSync(helperPath)) {
    throw new Error(`persistVendorSalesToPool helper not found at ${helperPath} — run \`npm run build\` first`);
  }
  return require(helperPath);
}

const APPLY = process.env.APPLY === "true";
const MODE = (process.env.INGEST_MODE || "incremental").toLowerCase();
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 12));
// PLATFORM / CATEGORY default to "" (no filter) — pull everything TCA has.
// Set explicitly (e.g. PLATFORM=eBay CATEGORY=sports) to narrow scope.
const PLATFORM = process.env.PLATFORM || "";
const CATEGORY = process.env.CATEGORY || "";
const PAGE_LIMIT = Math.min(1000, Math.max(1, Number(process.env.PAGE_LIMIT || 1000)));
const SORT = (process.env.SORT || "date_desc").toLowerCase();
// A daily-feed run is a different query shape (date-scoped, one day) from the
// open-ended incremental crawl, so it needs its OWN cursor state. Sharing one
// has each run resume from the other's position: the first scheduled daily-feed
// run resumed the incremental crawler's cursor — already parked at the end of
// the consumed feed — and returned pages=0 fetched=0 with NO error, which reads
// exactly like "nothing new to fetch".
//
// The suffix is applied even when CRAWLER_ID is passed in, because the workflow
// always sets it explicitly; making this a `||` fallback (the first attempt)
// meant the separation silently never applied in CI.
const BASE_CRAWLER_ID = process.env.CRAWLER_ID
  || `tca-${PLATFORM.toLowerCase() || "all"}-${CATEGORY || "all"}-${SORT}`;
// CF-TCA-WATERMARK-CLAMP (2026-09-02). The daily suffix must name the day we
// actually pull, not the day we asked for — a clamped run resumes the cursor
// for the clamped date. Resolved after the clamp via setCrawlerDate().
let CRAWLER_DATE = process.env.FEED_DATE
  || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const crawlerId = () => (process.env.DAILY_FEED === "true"
  ? `${BASE_CRAWLER_ID}-daily-${CRAWLER_DATE}`
  : BASE_CRAWLER_ID);
function setCrawlerDate(d) { CRAWLER_DATE = d; }

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

// ─── Row reshaper (TCA → VendorSaleRow for persistVendorSalesToPool) ─
//
// persistVendorSalesToPool does the heavy lifting (identity parse from
// title, hobbyiqCardId compute, contentHash dedup, staging shim, image
// mirror). We only need to hand it a VendorSaleRow with the four
// fields it requires plus an optional per-row identity hint.
//
// TCA sport enum is inconsistent ("Baseball" / "BASEBALL" / "baseball"
// all appear) — normalize to lowercase.
function tcaToVendorSaleRow(t) {
  return {
    title: t.title || null,
    price: Number(t.price),
    soldAt: t.sold_at || (t.sale_date ? new Date(t.sale_date + "T12:00:00Z").toISOString() : null),
    url: t.listing_url || null,
    externalId: t.id || null,
    imageUrl: t.image_url || null,
  };
}

// When TCA already gives us structured player/year/sport on a row, use
// them as identity hints — persistVendorSalesToPool skips the title
// guess for those and gets straight to slug compute.
function tcaToIdentityHint(t) {
  const hint = {};
  if (t.player) hint.playerName = String(t.player);
  const y = (typeof t.year === "number") ? t.year : (t.year && Number.isFinite(Number(t.year)) ? Number(t.year) : null);
  if (y) hint.cardYear = y;
  if (t.sport) hint.sport = String(t.sport).toLowerCase();
  return hint;
}

// ─── Crawl state ─────────────────────────────────────────────────────

async function getState(container) {
  try {
    const id = crawlerId();
    const { resource } = await container.item(id, id).read();
    return resource;
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}
async function putState(container, state) {
  await container.items.upsert({ ...state, id: crawlerId() });
}

// ─── Main loop ───────────────────────────────────────────────────────

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  if (!process.env.TCA_API_KEY) { console.error("TCA_API_KEY required"); process.exit(1); }

  const c = new CosmosClient(cs);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const state = db.container("crawl_state");

  // Ensure PERSIST_VENDOR_LOOKUPS_ENABLED is on — persistVendorSalesToPool
  // is a no-op otherwise and we'd silently write nothing to sold_comps.
  if (APPLY && process.env.PERSIST_VENDOR_LOOKUPS_ENABLED !== "true") {
    console.error("PERSIST_VENDOR_LOOKUPS_ENABLED must be 'true' for APPLY=true — persistVendorSalesToPool no-ops otherwise");
    process.exit(1);
  }

  // Lazy-load compiled helper (requires backend/dist to exist)
  const persistHelper = APPLY ? loadPersistHelper() : null;
  const { persistVendorSalesToPool } = persistHelper || {};

  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  console.log(`[tca-firehose] mode=${MODE} apply=${APPLY} platform=${PLATFORM} category=${CATEGORY} maxMinutes=${MAX_MINUTES}`);

  // State is loaded AFTER the daily-feed clamp below, because the crawler id
  // is keyed to the day we actually pull (CF-TCA-WATERMARK-CLAMP).
  let cursor = null;
  let existing = null;

  // Only include platform / category in the query when explicitly set.
  // Default = no filter = pull EVERYTHING TCA has (per Drew, 2026-08-02).
  const baseQs = new URLSearchParams({
    limit: String(PAGE_LIMIT),
    sort: SORT,
  });
  if (PLATFORM) baseQs.set("platform", PLATFORM);
  if (CATEGORY) baseQs.set("category", CATEGORY);

  // CF-TCA-DAILY-FEED (Drew, 2026-08-13: "we have access to the full daily
  // sold comps too with tca").
  //
  // Our plan carries the Full Daily Feed add-on: pulls scoped to
  // sale_date = yesterday are UNLIMITED, while every other range draws on the
  // 200K/day cap. This script never used it — it pulled cursor-paginated with
  // no date filter, which is the capped path — so once the cap was spent the
  // nightly cron fetched nothing at all. Verified against prod on 2026-08-13
  // with the cap already at remaining=0:
  //
  //   200  date_from=2026-08-12&date_to=2026-08-12   (yesterday — served)
  //   429  date_from=2026-08-13&date_to=2026-08-13   (today — capped)
  //   200  /sales/export/csv?date_from=2026-08-12&date_to=2026-08-12
  //        x-ratelimit-limit: "unlimited"  x-ratelimit-remaining: "unlimited"
  //
  // DAILY_FEED=true scopes the run to that unlimited window, so the nightly
  // ingest stops competing with on-demand app traffic for the shared cap. The
  // date params are date_from / date_to per TCA's docs — sale_date, sold_date
  // and date are NOT recognised and silently fall back to the capped path.
  const DAILY_FEED = process.env.DAILY_FEED === "true";
  const FEED_DATE_REQUESTED = process.env.FEED_DATE
    || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  // Reassigned below when the platform watermark is behind the requested day.
  let FEED_DATE = FEED_DATE_REQUESTED;
  if (DAILY_FEED) {
    console.log(`[tca-firehose] DAILY FEED mode — requested ${FEED_DATE_REQUESTED}`);

    // CF-TCA-PLATFORM-LAG (Drew, 2026-08-13). TCA's platforms publish on
    // different schedules, so a run asking eBay for yesterday can get a
    // legitimate 0 rows: the data simply is not published yet.
    //
    // CF-TCA-WATERMARK-CLAMP (2026-09-02). The original guard `return`ed when
    // the watermark was behind the requested day, on the belief that the free
    // window was STRICTLY yesterday and pulling an older day would burn the
    // 200K cap. That belief is wrong, and the skip is why the eBay lane went
    // to zero for four days.
    //
    // eBay's watermark froze at 2026-08-28. FEED_DATE kept advancing with the
    // clock (08-29 -> 09-01), so the gap widened every run and all 12 runs
    // from 2026-08-30T00:57Z onward logged:
    //
    //   eBay has only published through 2026-08-28; <FEED_DATE> is not
    //   available yet — skipping (not an error).
    //   done — pages=0 fetched=0 written=0 skipped=0 errors=0 (platform behind)
    //
    // while 2026-08-28 sat there with 89,633 unpulled rows. So clamp to the
    // watermark and PULL it instead of skipping. contentHash dedup makes
    // re-pulling an already-ingested day a no-op, which is what makes the
    // clamp safe to run on every pass.
    //
    // QUOTA, measured against prod 2026-09-02 — the "unlimited" window is
    // narrower than the 2026-08-13 note assumed. The un-cursored first page of
    // a date-scoped query is free, but cursor-paged continuations bill ~1 unit
    // per row regardless of the date:
    //
    //   first page,  limit=1000, no cursor      delta remaining = 0
    //   3 pages,     limit=1000, with cursor    delta remaining = 3001
    //
    // A full day of eBay (~90K rows) therefore costs ~90K of the 200K/day cap.
    // That is affordable for the daily lane but means a multi-day backfill must
    // be spread across days — see the MAX_MINUTES budget and the 429 auto-halt.
    if (PLATFORM) {
      try {
        const platforms = await new Promise((resolve, reject) => {
          const r = https.request({
            hostname: TCA_HOST, port: 443, path: "/api/v1/market/platforms",
            method: "GET",
            headers: { "x-market-api-key": process.env.TCA_API_KEY, Accept: "application/json" },
            timeout: 30_000,
          }, (res) => {
            let d = ""; res.on("data", (c) => (d += c));
            res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
          });
          r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
          r.on("error", reject);
          r.end();
        });
        const row = (Array.isArray(platforms) ? platforms : []).find(
          (p) => String(p.platform || "").toLowerCase() === PLATFORM.toLowerCase());
        const watermark = row && row.last_sale_date;
        if (watermark && watermark < FEED_DATE) {
          // An explicit FEED_DATE is an operator asking for one specific day.
          // Honour it rather than silently pulling a different one.
          if (process.env.FEED_DATE) {
            console.log(`[tca-firehose] ${PLATFORM} has only published through ${watermark}; explicit FEED_DATE=${FEED_DATE} is not available yet — skipping (not an error).`);
            console.log(`[tca-firehose] done — pages=0 fetched=0 written=0 skipped=0 errors=0 elapsed=0s (platform behind)`);
            return;
          }
          const lagDays = Math.round(
            (Date.parse(`${FEED_DATE}T00:00:00Z`) - Date.parse(`${watermark}T00:00:00Z`)) / 86_400_000);
          console.log(`[tca-firehose] ${PLATFORM} published through ${watermark}, ${lagDays}d behind requested ${FEED_DATE} — clamping to ${watermark} and pulling it.`);
          if (lagDays > 1) {
            console.log(`::warning::${PLATFORM} feed is ${lagDays} days behind (watermark ${watermark}). Pulling the watermark day; days between it and ${FEED_DATE} are unpublished upstream.`);
          }
          FEED_DATE = watermark;
        } else if (watermark) {
          console.log(`[tca-firehose] ${PLATFORM} published through ${watermark} — ${FEED_DATE} available`);
        }
      } catch (e) {
        // Never block the pull on the watermark check.
        console.warn(`[tca-firehose] platform watermark check failed (${e.message}) — proceeding`);
      }
    }

    // Set the window AFTER the clamp, so the request carries the day we
    // actually intend to pull.
    baseQs.set("date_from", FEED_DATE);
    baseQs.set("date_to", FEED_DATE);
    setCrawlerDate(FEED_DATE);
    console.log(`[tca-firehose] DAILY FEED window — date_from=date_to=${FEED_DATE} (unlimited window)`);
  }

  // Load state — now that the crawler id names the day we will pull.
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

  let page = 0;
  let totalFetched = 0;
  let totalWritten = 0;
  let totalDedupSkipped = 0;
  let totalCatalogUnmatched = 0;
  let totalErrors = 0;
  let fetchErrors = 0;
  let lastCursor = cursor;

  // CF-TCA-PIPELINED-FETCH (Drew, 2026-08-02). Overlaps fetch of page
  // N+1 with processing of page N. Roughly doubles wall-clock throughput.
  const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 48));
  const SELF_THROTTLE_MS = Math.max(0, Number(process.env.SELF_THROTTLE_MS || 200));

  // Prefetch: kick off first fetch before entering loop.
  let nextFetch;
  function scheduleNextFetch(cur) {
    const qs = new URLSearchParams(baseQs);
    if (cur) qs.set("cursor", cur);
    return fetchPageWithRetry(qs.toString());
  }
  nextFetch = scheduleNextFetch(lastCursor);

  while (true) {
    if (Date.now() - startMs > budgetMs) {
      console.log(`[tca-firehose] wall-clock cap ${MAX_MINUTES}m reached — stopping cleanly, cursor preserved`);
      break;
    }
    let resp;
    try { resp = await nextFetch; }
    catch (err) {
      console.error(`[tca-firehose] fatal fetch error:`, err);
      fetchErrors++;
      break;
    }
    const rows = (resp && resp.data) || [];
    if (rows.length === 0) {
      console.log(`[tca-firehose] page ${page + 1}: 0 rows — reached end of feed`);
      break;
    }
    page++;
    totalFetched += rows.length;
    const nextCursor = resp?.pagination?.next_cursor || null;

    // Pipeline: schedule NEXT fetch immediately (with self-throttle to
    // stay well under TCA per-second rate limits) so we're not blocking
    // Cosmos writes on TCA network round-trips.
    if (nextCursor) {
      if (SELF_THROTTLE_MS > 0) {
        nextFetch = new Promise(res => setTimeout(res, SELF_THROTTLE_MS))
          .then(() => scheduleNextFetch(nextCursor));
      } else {
        nextFetch = scheduleNextFetch(nextCursor);
      }
    } else {
      nextFetch = Promise.resolve({ data: [] });
    }

    if (APPLY) {
      // Higher concurrency now that Cosmos sold_comps is at 10K RU/s
      // autoscale + comps_staging at 4K. persistVendorSalesToPool
      // handles per-row parse + dedup + dual-write internally.
      const inflight = new Set();
      for (const t of rows) {
        while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
        const vsRow = tcaToVendorSaleRow(t);
        if (!vsRow.soldAt || !(vsRow.price > 0)) { totalDedupSkipped++; continue; }
        const hint = tcaToIdentityHint(t);
        const p = persistVendorSalesToPool("tca-ebay", [vsRow], hint)
          .then((res) => {
            totalWritten += res.inserted;
            totalDedupSkipped += res.deduped + res.skipped;
            totalCatalogUnmatched += res.catalogUnmatched ?? 0;
          })
          .catch((err) => {
            totalErrors++;
            if (totalErrors < 10) console.warn(`  persist failed id=${t.id}: ${err?.code ?? err?.message ?? err}`);
          })
          .finally(() => inflight.delete(p));
        inflight.add(p);
      }
      await Promise.all([...inflight]);
    } else {
      totalWritten += rows.length;
    }

    lastCursor = nextCursor;
    if ((page % 5) === 0 || !lastCursor) {
      const elapsedS = ((Date.now() - startMs) / 1000).toFixed(0);
      const ratePerS = (totalWritten / Math.max(1, (Date.now() - startMs) / 1000)).toFixed(1);
      const fetchRatePerS = (totalFetched / Math.max(1, (Date.now() - startMs) / 1000)).toFixed(0);
      console.log(`[tca-firehose] page ${page}: fetched=${totalFetched} (${fetchRatePerS}/s) written=${totalWritten} (${ratePerS}/s) skipped=${totalDedupSkipped} errors=${totalErrors} elapsed=${elapsedS}s`);
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
      lastError: (totalErrors + fetchErrors) > 0 ? `${totalErrors} row-level errors, ${fetchErrors} fetch errors` : null,
    };
    await putState(state, newState);
    console.log(`[tca-firehose] state persisted — cursor advanced, cumulativeTotal=${newState.totalRowsWritten}`);
  }

  const elapsedS = ((Date.now() - startMs) / 1000).toFixed(0);
  console.log(`\n[tca-firehose] done — pages=${page} fetched=${totalFetched} written=${totalWritten} skipped=${totalDedupSkipped} catalogUnmatched=${totalCatalogUnmatched} errors=${totalErrors} fetchErrors=${fetchErrors} elapsed=${elapsedS}s`);
  if (APPLY) reportWrites({ job: "tca-firehose-ingest", intended: totalFetched, written: totalWritten, skipped: totalDedupSkipped + totalCatalogUnmatched, failed: totalErrors });

  // A daily-feed run that started with NO stored cursor asked the unlimited
  // window for a whole day of sales. Zero rows back is an anomaly — a real day
  // has tens of thousands — not "nothing new". Exiting non-zero keeps it out of
  // the silent-success class that hid this pipeline stalling in the first
  // place. A resumed cursor legitimately returns 0 once the day is drained, so
  // that case is excluded.
  if (DAILY_FEED && !existing && totalFetched === 0) {
    console.error(`[tca-firehose] ERROR: daily feed for ${FEED_DATE} returned 0 rows on a fresh cursor.`);
    console.error(`[tca-firehose] Expected tens of thousands. Check date_from/date_to are honoured and the Full Daily Feed add-on is active.`);
    process.exitCode = 1;
  }
  if (!APPLY) console.log(`(dry-run — no sold_comps writes, no state persisted)`);
}

main().catch(err => { console.error(err); process.exit(1); });
