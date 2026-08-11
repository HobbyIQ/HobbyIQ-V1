// CF-TCA-BACKFILL-WINDOW (Drew, 2026-08-10). Targeted backfill for a
// specific soldAt window where the old TCA key was throttled and the
// firehose ingested only 77-681 rows/day instead of the normal 10-25K.
//
// Approach: paginate TCA /market/sales with sort=date_asc starting from
// oldest, but ONLY persist rows where soldAt falls inside the target
// window. Stops paginating when soldAt >= WINDOW_END.
//
// Env:
//   TCA_API_KEY, COSMOS_CONNECTION_STRING       required
//   PERSIST_VENDOR_LOOKUPS_ENABLED=true         required for APPLY
//   APPLY=true                                  write (default dry-run)
//   WINDOW_START=YYYY-MM-DD (default 2026-07-25)
//   WINDOW_END=YYYY-MM-DD   (default 2026-08-02, exclusive)
//   MAX_MINUTES=60          wall-clock cap
//   PAGE_LIMIT=1000
//   SELF_THROTTLE_MS=200
//   CONCURRENCY=32

const { CosmosClient } = require("@azure/cosmos");
const https = require("https");
const path = require("path");
const fs = require("fs");

const APPLY = process.env.APPLY === "true";
const WINDOW_START = process.env.WINDOW_START || "2026-07-25";
const WINDOW_END = process.env.WINDOW_END || "2026-08-02";
const WINDOW_START_ISO = `${WINDOW_START}T00:00:00.000Z`;
const WINDOW_END_ISO = `${WINDOW_END}T00:00:00.000Z`;
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 60));
const PAGE_LIMIT = Math.min(1000, Math.max(1, Number(process.env.PAGE_LIMIT || 1000)));
const SELF_THROTTLE_MS = Math.max(0, Number(process.env.SELF_THROTTLE_MS || 200));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 32));

if (!process.env.TCA_API_KEY) { console.error("TCA_API_KEY required"); process.exit(1); }
if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
if (APPLY && process.env.PERSIST_VENDOR_LOOKUPS_ENABLED !== "true") {
  console.error("PERSIST_VENDOR_LOOKUPS_ENABLED must be 'true' for APPLY=true");
  process.exit(1);
}

function loadPersistHelper() {
  const distRoot = path.resolve(__dirname, "..", "dist");
  const helperPath = path.join(distRoot, "services", "portfolioiq", "persistVendorSalesToPool.service.js");
  if (!fs.existsSync(helperPath)) throw new Error(`missing ${helperPath} — run \`npm run build\` first`);
  return require(helperPath);
}
const persistHelper = APPLY ? loadPersistHelper() : null;

function tcaFetch(qs) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "www.thecardapi.com",
      port: 443,
      path: `/api/v1/market/sales?${qs}`,
      method: "GET",
      headers: { "x-market-api-key": process.env.TCA_API_KEY, Accept: "application/json" },
      timeout: 60000,
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode === 429) {
          const retryAfter = Number(res.headers["retry-after"] || 60);
          return reject({ code: 429, retryAfter, body: d.slice(0, 300) });
        }
        if (res.statusCode >= 400) return reject({ code: res.statusCode, body: d.slice(0, 500) });
        try { resolve(JSON.parse(d)); } catch (e) { reject({ code: -1, message: "parse", body: d.slice(0, 500) }); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject({ code: -2, message: "timeout" }); });
    req.on("error", (err) => reject({ code: -3, message: err.message }));
    req.end();
  });
}
async function fetchWithRetry(qs, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await tcaFetch(qs); }
    catch (err) {
      if (err.code === 429) {
        const wait = (err.retryAfter || 60) * 1000;
        console.warn(`  429; waiting ${wait/1000}s (try ${i+1}/${tries})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if ((err.code === -2 || err.code === -3 || (err.code >= 500 && err.code < 600)) && i < tries - 1) {
        const wait = Math.min(30000, 1000 * Math.pow(3, i));
        console.warn(`  transient ${err.code}; waiting ${wait/1000}s`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw new Error("retries exhausted");
}

function rowSoldAt(t) {
  return t.sold_at || (t.sale_date ? new Date(t.sale_date + "T12:00:00Z").toISOString() : null);
}
function tcaToVsRow(t) {
  return {
    title: t.title || null,
    price: Number(t.price),
    soldAt: rowSoldAt(t),
    url: t.listing_url || null,
    externalId: t.id || null,
    imageUrl: t.image_url || null,
  };
}
function tcaToHint(t) {
  const h = {};
  if (t.player) h.playerName = String(t.player);
  const y = typeof t.year === "number" ? t.year : (t.year && Number.isFinite(Number(t.year)) ? Number(t.year) : null);
  if (y) h.cardYear = y;
  if (t.sport) h.sport = String(t.sport).toLowerCase();
  return h;
}

async function main() {
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  window=[${WINDOW_START}, ${WINDOW_END})  maxMin=${MAX_MINUTES}`);
  const start = Date.now();
  const budgetMs = MAX_MINUTES * 60000;

  const persistFn = APPLY ? persistHelper.persistVendorSalesToPool : null;

  let cursor = null;
  let page = 0;
  let seen = 0, filteredIn = 0, filteredOut = 0, persisted = 0, dedup = 0, errors = 0;
  let stopped = false, reason = "";

  // Walking sort=date_desc from newest: skip past window (rows soldAt >=
  // WINDOW_END), enter window, persist, stop when past window-start
  // (rows soldAt < WINDOW_START). TCA has 8+ years of history so
  // date_asc would walk decades before reaching 07-25.
  while (!stopped) {
    if (Date.now() - start > budgetMs) { stopped = true; reason = "time-cap"; break; }
    page++;
    const qs = new URLSearchParams({ limit: String(PAGE_LIMIT), sort: "date_desc" });
    if (cursor) qs.set("cursor", cursor);
    let body;
    try { body = await fetchWithRetry(qs.toString()); }
    catch (err) { console.error(`  fetch fatal p=${page}:`, err); errors++; stopped = true; reason = `fetch-error: ${err.code}`; break; }

    const rows = (body?.data) || [];
    if (rows.length === 0) { stopped = true; reason = "empty-page"; break; }
    seen += rows.length;
    cursor = body?.pagination?.next_cursor || null;

    // Filter: keep rows in window.
    const inWindow = rows.filter((r) => {
      const t = rowSoldAt(r);
      if (!t) return false;
      if (t < WINDOW_START_ISO) return false;
      if (t >= WINDOW_END_ISO) return false;
      return true;
    });
    // With sort=date_desc, once ALL rows in a page are OLDER than
    // WINDOW_START, we're past the target window and can stop.
    const pastStart = rows.filter((r) => {
      const t = rowSoldAt(r);
      return t && t < WINDOW_START_ISO;
    });
    filteredIn += inWindow.length;
    filteredOut += rows.length - inWindow.length;

    if (APPLY && inWindow.length > 0) {
      const inflight = new Set();
      for (const t of inWindow) {
        while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
        const vs = tcaToVsRow(t);
        if (!vs.soldAt || !(vs.price > 0)) continue;
        const hint = tcaToHint(t);
        const p = persistFn("tca-ebay", [vs], hint)
          .then((res) => { persisted += res.inserted; dedup += res.deduped + res.skipped; })
          .catch((err) => { errors++; if (errors < 10) console.warn(`  persist fail id=${t.id}: ${err?.code ?? err?.message ?? err}`); })
          .finally(() => inflight.delete(p));
        inflight.add(p);
      }
      await Promise.all([...inflight]);
    }

    const firstSold = rows[0] ? rowSoldAt(rows[0]) : "?";
    const lastSold = rows[rows.length - 1] ? rowSoldAt(rows[rows.length - 1]) : "?";
    if (page % 10 === 0 || pastStart.length > 0) {
      console.log(`  p=${page} seen=${seen} in=${filteredIn} persisted=${persisted} dedup=${dedup} firstSold=${firstSold} lastSold=${lastSold}`);
    }

    // Stop when every row in this page is older than WINDOW_START —
    // we're past the target window.
    if (pastStart.length === rows.length && filteredIn > 0) {
      stopped = true; reason = "past-window-start (all rows older)";
      break;
    }
    if (!cursor) { stopped = true; reason = "no-cursor"; break; }
    if (SELF_THROTTLE_MS > 0) await new Promise(r => setTimeout(r, SELF_THROTTLE_MS));
  }

  const dur = ((Date.now() - start)/1000).toFixed(0);
  console.log(`\n[done ${dur}s] pages=${page} seen=${seen} in-window=${filteredIn} out-window=${filteredOut}`);
  console.log(`  persisted=${persisted} dedup=${dedup} errors=${errors} stopped=${reason}`);
}
main().catch(e => { console.error(e); process.exit(1); });
