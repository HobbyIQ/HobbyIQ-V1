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
//   refused  = twinAddressRefused + twinFolded (2026-09-07, see below)
//   failed   = persist calls that rejected (row-level)
//
// NOT a counter in that identity, and deliberately so (#2006 follow-up):
//   skippedSportUnresolved = the share of `skipped` whose vertical nothing
//   named. Reported on its own line, never added -- the same row is already
//   inside `skipped`, so summing it would drive `unaccounted` negative.
//
// CF-A-REFUSAL-IS-AN-OUTCOME-NOT-A-LOSS (2026-09-07). Every scheduled run
// since CF-ONE-SALE-ONE-ADDRESS landed reported a shortfall, because this
// caller read four of the service's outcome counters and the service returns
// six. `twinAddressRefused` and `twinFolded` are TERMINAL -- the row leaves
// the pipeline at the twin check and reaches none of the other four -- so
// every refused row simply fell out of the ledger.
//
// Measured on run 34071480616 (2026-09-07T00:58Z), the run that motivated
// this fix:
//
//   fetched 19,109  written 9,177  skipped 9,719  ->  UNACCOUNTED 213 (1.11%)
//   twin_address_refused events in that run's log:                  213
//
// Exactly the shortfall, to the row. Not a sampling artifact, not a dropped
// write: a missing term. The staging promoter hit the identical bug and fixed
// it the identical way in #1953 (`UNACCOUNTED 6,557 (100.00%)`); this script
// is the one caller that never got that fix.
//
// A fold is not an insert (the sale was already at this address, so the upsert
// replaced a document and no NEW sale entered the pool) and not a refusal of
// the write (the write was correct and allowed). It still has to be named, or
// a silent fold -- one with no live twin elsewhere, which logs nothing at all
// -- vanishes from the ledger exactly as the refusals did.
// A TCA FETCH that fails is fetchErrors — no rows, so nothing intended. The
// crawl_state upsert is one doc; if it throws the run exits 1, not green.
const { reportWrites } = require(path.join(__dirname, "..", "dist/services/ops/writeReconciliation.js"));
// CF-A-TCGPLAYER-ROW-STATES-ITS-OWN-IDENTITY (2026-09-08). Reads a TCA
// TCGplayer row into the Pokemon address fields. Compiled alongside
// persistVendorSalesToPool, so it shares that helper's `npm run build`
// requirement and is required from dist/ for the same reason.
const { tcgPlayerRowIdentity, isTcgPlayerRow } =
  require(path.join(__dirname, "..", "dist/services/portfolioiq/tcgPlayerRowIdentity.js"));

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
// CF-A-PRE-FLIGHT-QUOTA-GATE (2026-09-12). One row of the 200K/day cap costs
// nothing to check and everything to run out of mid-page: a cursor-paged
// continuation bills ~1 unit/row (see the CF-TCA-WATERMARK-CLAMP comment
// below), so a run that starts with too little headroom stops on a 429 partway
// through a page rather than cleanly at the top of one. EXPECTED_ROWS is the
// run's own estimate of what it is about to spend — operators already pass
// PAGE_LIMIT/MAX_MINUTES per invocation, so this is one more explicit input
// rather than a guess: default is a single page's worth (PAGE_LIMIT), which
// is the minimum any run can usefully do. Set higher for a run expected to
// page multiple times (e.g. a DAILY_FEED pull of a full ~50-90K-row day).
const EXPECTED_ROWS = Math.max(1, Number(process.env.EXPECTED_ROWS || PAGE_LIMIT));
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

// CF-A-PRE-FLIGHT-QUOTA-GATE. A minimal, header-reading sibling of tcaFetch —
// that function discards headers and resolves only the parsed body, which is
// all the pipelined loop needs. The gate needs `x-ratelimit-remaining`, so it
// gets its own tiny request rather than reworking tcaFetch's contract.
function tcaProbeRemaining() {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ limit: "1" }).toString();
    const req = https.request({
      hostname: TCA_HOST,
      port: 443,
      path: `${TCA_PATH}?${qs}`,
      method: "GET",
      headers: {
        "x-market-api-key": process.env.TCA_API_KEY,
        "Accept": "application/json",
      },
      timeout: 30_000,
    }, (res) => {
      // Drain the body — we only need the headers, but the socket must be
      // consumed or the request never completes.
      res.on("data", () => {});
      res.on("end", () => {
        const remainingHeader = res.headers["x-ratelimit-remaining"];
        const limitHeader = res.headers["x-ratelimit-limit"];
        const remaining = remainingHeader === "unlimited" ? Infinity : Number(remainingHeader);
        resolve({
          remaining: Number.isFinite(remaining) ? remaining : null,
          limit: limitHeader ?? null,
          statusCode: res.statusCode,
        });
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("quota probe timeout")); });
    req.on("error", (err) => reject(err));
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
  // CF-TCG-SPORTS-COLLIDING-SETS-NEED-A-MARKER (#2006 follow-up). TCA stamps
  // `platform` and `category` on every row, and a TCGplayer / category=tcg row
  // is never a sports card. Passing them lets the detector resolve Pokemon set
  // names that collide with sports products ("Expedition", "Diamond and
  // Pearl", "Platinum", the 2025 "ME01:" Mega Evolution era) without loosening
  // the collision guard for rows that carry no such marker. Measured on the
  // 2026-09-07 TCGplayer window: 3,898 of 12,000 rows (32.5%) were skipped for
  // an unresolved vertical, and every one of them carried platform=TCGplayer.
  if (t.platform) hint.platform = String(t.platform);
  if (t.category) hint.category = String(t.category);
  // CF-A-TCGPLAYER-ROW-STATES-ITS-OWN-IDENTITY (2026-09-08). A TCGplayer row
  // carries player=null, year=null and sport=null on EVERY row, so the three
  // hints above stay empty and the row arrives at persistVendorSalesToPool's
  // `if (!cardYear) skip` / `if (!playerName) skip` gates with nothing to
  // satisfy them. That is how run 34262947046 wrote 9 rows out of 26,000.
  //
  // The Pokemon address ruling says those gates are answerable, not
  // inapplicable: the character is the player, the SET's release year is the
  // year, and TCA hands us `card_set` / `card_number` structured. Read them.
  //
  // Deliberately AFTER the generic hints and unconditional on their absence:
  // a TCGplayer row has no competing sports reading to preserve.
  if (isTcgPlayerRow(t)) {
    const id = tcgPlayerRowIdentity(t);
    if (id.reason) {
      // Named refusal. The caller counts it; nothing is guessed.
      hint.tcgSkipReason = id.reason;
    } else {
      hint.playerName = id.playerName;
      hint.cardYear = id.cardYear;
      hint.cardNumber = id.cardNumber;
      hint.sport = id.sport;
      // The tcgdex CODE, per CF-THE-ENGLISH-SET-CODE-IS-THE-KEY. Passing it as
      // `setName` is what the earlier note here warned against doing with TCA's
      // RAW `card_set` -- and the warning was right about the raw field, which
      // would have rewritten every address. A canonical code is the opposite
      // case: it is the address these rows are ruled to have, and without it
      // `inferSetKeyFromTitle` reads "Obsidian Flames" as the SPORTS pool
      // "Panini Obsidian" (measured on real 2026-09-07 rows).
      hint.setName = id.setKey;
      if (id.parallel) hint.parallel = id.parallel;
    }
  }
  // NOT setName: `identity.setName` is consumed as the raw setKey that builds
  // the slug, so passing TCA card_set here would rewrite the ADDRESS of every
  // TCGplayer row -- a much larger change than this one, and not this PR to
  // make. The detector reads the set from the title, where TCA already puts it
  // ("Gastly - Expedition - Normal").
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

  // CF-A-PRE-FLIGHT-QUOTA-GATE (2026-09-12). Cheapest possible check — one
  // limit=1 request — before anything else runs. A run that starts with less
  // headroom than it expects to spend should abort cleanly at the top, not
  // discover the cap mid-page via a 429 with the cursor left in an unclear
  // spot. Failure to probe (network hiccup, unexpected header shape) does NOT
  // block the run — the existing per-page 429 retry/backoff already handles
  // the case this gate is trying to catch early, so a probe failure just
  // loses the early warning, not the run itself.
  try {
    const probe = await tcaProbeRemaining();
    if (probe.remaining !== null) {
      console.warn(`[tca-firehose] quota probe — remaining=${probe.remaining} limit=${probe.limit ?? "?"} expectedRows=${EXPECTED_ROWS}`);
      if (probe.remaining < EXPECTED_ROWS) {
        console.error(
          `[tca-firehose] budget: remaining quota (${probe.remaining}) is below this run's expected rows` +
          ` (${EXPECTED_ROWS}, from PAGE_LIMIT/EXPECTED_ROWS) — aborting cleanly before any fetch or write.` +
          ` Cursor untouched; resume once the 200K/day cap resets.`,
        );
        process.exit(1);
      }
    } else {
      console.warn(`[tca-firehose] quota probe — no numeric x-ratelimit-remaining header (status=${probe.statusCode}); proceeding without a pre-flight gate`);
    }
  } catch (err) {
    console.warn(`[tca-firehose] quota probe failed (${err?.message ?? err}) — proceeding without a pre-flight gate`);
  }

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
  // CF-A-THROTTLED-WRITE-IS-NOT-A-WRITE (#2015 follow-up, 2026-09-09). Rows
  // whose WRITE threw inside persistVendorSalesToPool. These used to be
  // returned in `result.skipped` and folded into `totalDedupSkipped`, so the
  // identity below balanced perfectly on sales that are not in the pool and
  // `errors=` read 0 through a Cosmos throttle storm. Moving them OUT of the
  // skip bucket and INTO the errors term keeps the sum unchanged -- the row is
  // counted once, in the bucket that describes what actually happened to it.
  let totalWriteErrors = 0;
  let totalCatalogUnmatched = 0;
  // Terminal twin-check outcomes. Counted separately from `skipped` because
  // "we understood this row and declined to write it" is a different fact from
  // "we could not read this row" -- a climbing refusal count is a guard doing
  // its job or a guard mis-scoped, a climbing skip count is a parser going
  // blind. Folding them together loses that signal.
  let totalTwinRefused = 0;
  let totalTwinFolded = 0;
  // #2006 follow-up: the vertical-unresolved share of `skipped`. Reported, not
  // summed -- see the reconcile block.
  let totalSkippedSportUnresolved = 0;
  // CF-A-SKIP-MUST-SAY-WHY (2026-09-08). `skipped` was ONE number covering
  // every way a row can fail to land, and run 34262947046 proved what that
  // costs: 25,991 of 26,000 TCGplayer rows skipped, the reconcile identity
  // balancing to zero unaccounted, and nothing anywhere naming a reason. A
  // 99.9% skip and a quiet feed printed the same line.
  //
  // These are DISJOINT sub-buckets of `totalDedupSkipped`, which stays the
  // reconcile term. They are printed beside it, never summed into it.
  const skipReasons = {
    // Pre-persist, in this script: the row is not a sale we can read.
    missingSoldAt: 0,
    nonPositivePrice: 0,
    // Pre-persist: a TCG row whose set the vocabulary cannot name, so there is
    // no year and no key. A refusal by design -- never guess a year.
    setUnmapped: 0,
    noCharacter: 0,
    noCardNumber: 0,
    // Returned by persistVendorSalesToPool, summed across batches.
    serviceDeduped: 0,
    serviceNoYear: 0,
    serviceNoPlayer: 0,
    serviceSportUnresolved: 0,
    // The service's `skipped` minus the named breakdowns it reports. A
    // climbing `serviceOther` is the signal that a NEW skip path exists that
    // nothing here names -- the defect to go fix, not a number to explain.
    serviceOther: 0,
  };
  // The set labels the vocabulary could not name, by row count. This is an
  // ACQUISITION LIST, not an error log: each entry is a real product whose
  // sales we are declining to file until someone maps it.
  const unmappedSets = new Map();
  const TCG_REASON_BUCKET = {
    "set-unmapped": "setUnmapped",
    "no-character": "noCharacter",
    "no-card-number": "noCardNumber",
  };
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
        // Each pre-persist refusal now names itself. Same two conditions as
        // before, counted apart: "no sale date" and "no price" are different
        // vendor failures and only the split tells them apart.
        if (!vsRow.soldAt) { totalDedupSkipped++; skipReasons.missingSoldAt++; continue; }
        if (!(vsRow.price > 0)) { totalDedupSkipped++; skipReasons.nonPositivePrice++; continue; }
        const hint = tcaToIdentityHint(t);
        // A TCG row whose identity the vocabulary could not read never reaches
        // persist -- there is no address to write it at. Counted by reason
        // here rather than dying inside the service's generic `skipped`.
        if (hint.tcgSkipReason) {
          totalDedupSkipped++;
          skipReasons[TCG_REASON_BUCKET[hint.tcgSkipReason] ?? "serviceOther"]++;
          if (hint.tcgSkipReason === "set-unmapped" && t.card_set) {
            unmappedSets.set(t.card_set, (unmappedSets.get(t.card_set) || 0) + 1);
          }
          continue;
        }
        delete hint.tcgSkipReason;
        const p = persistVendorSalesToPool("tca-ebay", [vsRow], hint)
          .then((res) => {
            totalWritten += res.inserted;
            totalDedupSkipped += res.deduped + res.skipped;
            // CF-A-THROTTLED-WRITE-IS-NOT-A-WRITE (#2015 follow-up). Writes that
            // THREW are their own term now. Folding them into the dedup/skip
            // bucket said "this row is handled" about a sale that never landed.
            totalWriteErrors += res.errors;
            totalCatalogUnmatched += res.catalogUnmatched ?? 0;
            totalTwinRefused += res.twinAddressRefused ?? 0;
            totalTwinFolded += res.twinFolded ?? 0;
            totalSkippedSportUnresolved += res.skippedSportUnresolved ?? 0;
            skipReasons.serviceDeduped += res.deduped;
            skipReasons.serviceNoYear += res.skippedNoYear ?? 0;
            skipReasons.serviceNoPlayer += res.skippedNoPlayer ?? 0;
            skipReasons.serviceSportUnresolved += res.skippedSportUnresolved ?? 0;
            // Whatever the service skipped that it did not name. All three
            // subtracted terms are BREAKDOWNS of `res.skipped` (each of those
            // paths increments `skipped` as well), so this is a remainder, not
            // a difference of siblings -- subtracting a sibling would drive it
            // negative and the clamp would hide that it had.
            skipReasons.serviceOther += Math.max(0, res.skipped
              - (res.skippedNoYear ?? 0) - (res.skippedNoPlayer ?? 0)
              - (res.skippedSportUnresolved ?? 0));
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
      // CF-A-DRY-RUN-THAT-COUNTS-EVERY-ROW-AS-A-WRITE-PROVES-NOTHING
      // (2026-09-08). This branch was `totalWritten += rows.length` -- it
      // reported a would-write of 100% no matter what the rows contained, so
      // the one cheap check that could have caught the TCGplayer collapse
      // before it ran in production was the check guaranteed to pass.
      //
      // The dry run now walks the SAME readers the apply path does (mapper,
      // then TCG identity) and reports what would actually land. It still
      // writes nothing and still calls no Cosmos.
      for (const t of rows) {
        const vsRow = tcaToVendorSaleRow(t);
        if (!vsRow.soldAt) { totalDedupSkipped++; skipReasons.missingSoldAt++; continue; }
        if (!(vsRow.price > 0)) { totalDedupSkipped++; skipReasons.nonPositivePrice++; continue; }
        const hint = tcaToIdentityHint(t);
        if (hint.tcgSkipReason) {
          totalDedupSkipped++;
          skipReasons[TCG_REASON_BUCKET[hint.tcgSkipReason] ?? "serviceOther"]++;
          if (hint.tcgSkipReason === "set-unmapped" && t.card_set) {
            unmappedSets.set(t.card_set, (unmappedSets.get(t.card_set) || 0) + 1);
          }
          continue;
        }
        // "Would write" is as far as a dry run can honestly go: dedup and the
        // twin check are decided against stored rows, which this path does not
        // read. Named as would-write, never as written.
        totalWritten++;
      }
    }

    lastCursor = nextCursor;
    if ((page % 5) === 0 || !lastCursor) {
      const elapsedS = ((Date.now() - startMs) / 1000).toFixed(0);
      const ratePerS = (totalWritten / Math.max(1, (Date.now() - startMs) / 1000)).toFixed(1);
      const fetchRatePerS = (totalFetched / Math.max(1, (Date.now() - startMs) / 1000)).toFixed(0);
      console.log(`[tca-firehose] page ${page}: fetched=${totalFetched} (${fetchRatePerS}/s) written=${totalWritten} (${ratePerS}/s) skipped=${totalDedupSkipped} errors=${totalErrors + totalWriteErrors} elapsed=${elapsedS}s`);
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
  console.log(`\n[tca-firehose] done — pages=${page} fetched=${totalFetched} written=${totalWritten} skipped=${totalDedupSkipped} catalogUnmatched=${totalCatalogUnmatched} twinFolded=${totalTwinFolded} twinRefused=${totalTwinRefused} errors=${totalErrors + totalWriteErrors} fetchErrors=${fetchErrors} elapsed=${elapsedS}s`);
  // CF-A-SKIP-MUST-SAY-WHY. `skipped` above is the reconcile term; this is what
  // it was made of. Printed unconditionally, including all-zero, because a
  // reason line that appears only when something is wrong is a line nobody
  // learns to read.
  console.log(`[tca-firehose] skipped by reason — ${
    Object.entries(skipReasons).map(([k, v]) => `${k}=${v}`).join(" ")
  }`);
  if (unmappedSets.size > 0) {
    const top = [...unmappedSets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    console.log(`[tca-firehose] top unmapped sets (${unmappedSets.size} distinct) — ${
      top.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(" ")
    }`);
  }

  // CF-EVERY-WRITE-RECONCILES, printed as an identity a reader can check by
  // eye — because the failure this fixes was not a wrong number, it was a
  // MISSING TERM, and only an equation written out in full shows a term to be
  // missing. Same shape as promote-staging-pending.cjs, deliberately.
  //
  // Every fetched row lands in exactly one bucket. If this line does not
  // balance, a NEW terminal outcome has appeared in persistVendorSalesToPool
  // that nothing here counts — which is the defect to go fix, not the
  // arithmetic to go adjust.
  if (APPLY) {
    // `skippedSportUnresolved` is a BREAKDOWN of `skipped`, not a sibling of
    // it. persistVendorSalesToPool increments BOTH `result.skipped` and
    // `result.skippedSportUnresolved` for the same row (a row with no
    // resolvable vertical has no slug first segment, so no address), and this
    // script already folds `res.skipped` into `totalDedupSkipped`. Adding it
    // again here would double-count and drive `unaccounted` NEGATIVE -- an
    // imbalance that looks like a missing outcome but is really an invented
    // one. So it is REPORTED beside the identity, never summed into it.
    const accountedFor =
      totalWritten + totalDedupSkipped + totalCatalogUnmatched +
      totalTwinFolded + totalTwinRefused + totalErrors + totalWriteErrors;
    const unaccounted = totalFetched - accountedFor;
    console.log(
      `[tca-firehose] reconcile — fetched=${totalFetched} = written=${totalWritten}` +
      ` + skipped=${totalDedupSkipped} + catalogUnmatched=${totalCatalogUnmatched}` +
      ` + twinFolded=${totalTwinFolded} + twinRefused=${totalTwinRefused}` +
      ` + errors=${totalErrors} + writeErrors=${totalWriteErrors}` +
      `  (unaccounted=${unaccounted})`,
    );
    // The composition of the `skipped` term above. Same subset-not-sibling
    // rule as skippedSportUnresolved: these break `skipped` down, they do not
    // extend the identity.
    console.log(`[tca-firehose] skipped by reason — ${
      Object.entries(skipReasons).map(([k, v]) => `${k}=${v}`).join(" ")
    }`);
    // The vertical-unresolved share of `skipped`, printed on its own line
    // because it is the number that says whether a feed is LANDING. On the
    // first live TCGplayer day it was 3,898 of 12,000 (32.5%) and nothing
    // anywhere reported it.
    console.log(
      `[tca-firehose] of which skippedSportUnresolved=${totalSkippedSportUnresolved}` +
      ` (${totalFetched ? (100 * totalSkippedSportUnresolved / totalFetched).toFixed(2) : "0.00"}% of fetched;` +
      ` a subset of skipped, already counted above)`,
    );
    if (unaccounted !== 0) {
      console.error(
        `[tca-firehose] UNACCOUNTED ${unaccounted} of ${totalFetched} — a persist outcome exists that this script does not count`,
      );
    }
    // `refused` carries the twin verdicts: a fold replaced a document already
    // at the right address (no new sale entered the pool) and a refusal
    // declined to mint a second copy of one sale. Both are CORRECT outcomes
    // and both must be declared, or reportWrites reads them as loss — which
    // is precisely what turned eight scheduled runs red.
    reportWrites({
      job: "tca-firehose-ingest",
      intended: totalFetched,
      written: totalWritten,
      skipped: totalDedupSkipped + totalCatalogUnmatched,
      refused: totalTwinFolded + totalTwinRefused,
      // A write that threw is FAILED -- retryable, worth a relaunch. It was
      // reaching this ledger as `skipped`, the one term that means "done with".
      failed: totalErrors + totalWriteErrors,
    });
  }

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
