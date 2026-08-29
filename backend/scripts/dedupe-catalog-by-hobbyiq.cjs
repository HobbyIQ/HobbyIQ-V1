#!/usr/bin/env node
// CF-DEDUPE-CATALOG-BY-HOBBYIQ (Drew, 2026-08-01).
//
// card_catalog currently stores one row per (vendor, vendorCardId) —
// so a physical card covered by both CardHedge and Cardsight has TWO
// rows. Search dedupes at result-time via hobbyiqCardId, but the
// storage carries the duplication (~2× row count, 2× scan cost,
// inconsistent field coverage across vendors).
//
// This script merges duplicates by hobbyiqCardId — computed from
// (sport, year, setKey, cardNumber, parallel, isAuto, printRun) via
// the SAME function production uses (imported from dist/). The merge
// is catalogRowOps.moveCatalogRow (D5 PR 4), once per vendor row:
//   - the best-populated row moves to the slug first -- it creates the
//     row at (slug, slug), or lands on one the checklists already put
//     there, decided by authority (checklist > vendor > derived);
//   - every other vendor row folds onto it: vendorIds unioned, so every
//     vendor's id is preserved under its source (the old vendorMappings)
//   - best imageUrl wins (CH's Bubble CDN URLs preferred over proxy)
//   - searchText / searchTokens / displayName are rebuilt from the
//     identity, not unioned from the vendor rows' stale text
//   - the vendor row is deleted only after the canonical row is written
//
// The canonical row is the contract shape -- id === cardId === the hiq
// slug -- not the `canonical::{slug}` id this used to mint (which no
// point read could find; delete-corrupted-canonical.cjs cleans those).
//
// Idempotent — a re-run finds the survivor at its slug, groups it with
// any vendor row a cut-off run left behind, and folds that row onto it.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   BACKFILL_MAX_MINUTES       per-slice cap (default 25)
//   BACKFILL_CONCURRENCY       parallel workers (default 8)

const { CosmosClient } = require("@azure/cosmos");

let computeHobbyIqCardId, moveCatalogRow;
try {
  ({ computeHobbyIqCardId } = require("../dist/services/portfolioiq/hobbyIqCardId.service.js"));
  ({ moveCatalogRow } = require("../dist/services/catalog/catalogRowOps.service.js"));
} catch (e) {
  console.error("Cannot import from dist — build the backend first (npm run build)");
  console.error(e.message);
  process.exit(2);
}

const APPLY = process.env.BACKFILL_APPLY === "true";
// CF-DEDUPE-BIGGER-BUDGET (Drew, 2026-08-02). Bumped 25→60 min per
// slice. Prior 25 got eaten entirely by the scan phase (1.65M rows
// takes ~24 min), leaving 0 minutes for merge work. Job timeout is
// 150 min so 60 is safe.
const MAX_MINUTES = Math.max(1, Number(process.env.BACKFILL_MAX_MINUTES || 60));
// CF-DEDUPE-THROTTLE-FIX (Drew, 2026-08-01). Prior default of 8-16
// concurrent workers × (1 upsert + N deletes per group) hammered
// Cosmos into 429 storms that overwhelmed the retry loop and
// crashed the process with an uncaught 429 error. Reduce default
// concurrency + add per-group sleep + more retry attempts with
// longer backoff.
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 4));
const GROUP_SLEEP_MS = Math.max(0, Number(process.env.GROUP_SLEEP_MS || 100));

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

const START = Date.now();
let processExiting = false;
function timeExpired() { return (Date.now() - START) / 60000 > MAX_MINUTES; }

// Longer backoff + more attempts. Base 500ms, up to 8 attempts:
// 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000 ms.
// Total worst-case retry window per op: ~127s.
async function withRetry(fn, attempts = 8, baseMs = 500) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      const is429 = e?.code === 429 || e?.statusCode === 429 ||
                    /Too Many Requests|request rate is too large/i.test(String(e?.message ?? ""));
      if (!is429 || i === attempts - 1) throw e;
      const wait = baseMs * Math.pow(2, i) + Math.random() * 250;
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// Fatal error handler — log + set flag so main loop can exit
// gracefully with RELAUNCH_NEEDED=true instead of crashing to
// process exit 1 (which killed self-relaunch previously).
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.message ?? err);
  processExiting = true;
});

function pickImage(rows) {
  // Prefer CH-native CDN URL (highest quality). Then proxy URL. Then any URL.
  const chNative = rows.find(r => r.imageUrl && /cdn\.bubble\.io|cdnh\.bubble\.io/i.test(r.imageUrl));
  if (chNative) return chNative.imageUrl;
  const proxy = rows.find(r => r.imageUrl && /\/api\/compiq\/card-image\//i.test(r.imageUrl));
  if (proxy) return proxy.imageUrl;
  const any = rows.find(r => r.imageUrl);
  return any?.imageUrl ?? null;
}

// CF-DEDUPE-SKIP-AMBIGUOUS-SETKEYS (Drew, 2026-08-02). Slugs that fall
// into these "unknown" buckets collapse unrelated cards from different
// products into one canonical row (verified 2026-08-02: 337K corrupted
// rows in card_catalog from a prior dedupe run — "base-set" bucketed
// every #44 across every product's #44 into one row with all
// identifying fields dropped and a cross-player searchTokens mashup).
// Reject before creating a canonical id.
const AMBIGUOUS_SETKEYS = new Set(["base-set", "base", "set", "unknown", "other", ""]);

function hobbyiqSlugFromRow(row) {
  const sport = row.sport ?? row.__sport ?? null;
  const year = Number(row.year ?? row.cardYear ?? 0);
  const setKey = row.setName ?? row.set ?? row.releaseName ?? null;
  const cardNumber = row.cardNumber ?? row.number ?? null;
  if (!sport || !year || !setKey || !cardNumber) return null;
  try {
    const slug = computeHobbyIqCardId({
      sport: String(sport),
      year,
      setKey: String(setKey),
      cardNumber: String(cardNumber),
      parallel: "Base",   // catalog rows don't carry a parallel — that's a per-sale attribute
      isAuto: /auto/i.test(String(setKey)) || /auto/i.test(String(row.title ?? "")),
      printRun: null,
    });
    if (!slug) return null;
    // Slug shape: hiq:{sport}:{year}:{setKey}:{cardNumber}:{parallel}:{autoFlag}
    // Pull setKey segment and reject if it's in the ambiguous bucket.
    const segments = slug.split(":");
    const setKeySegment = segments[3] ?? "";
    if (AMBIGUOUS_SETKEYS.has(setKeySegment.toLowerCase())) return null;
    return slug;
  } catch { return null; }
}

/** The identity a vendor row carries, in the catalog's field names, with the
 *  setKey the slug resolved to (a key needs both halves) and the vendor's own
 *  id kept under its source. */
function identityFromVendorRow(row, slug) {
  return {
    setKey: slug.split(":")[3],
    sport: row.sport ?? row.__sport ?? null,
    year: Number(row.year ?? row.cardYear ?? 0),
    cardNumber: row.cardNumber ?? row.number ?? null,
    setName: row.setName ?? row.set ?? row.releaseName ?? null,
    playerName: row.playerName ?? row.player ?? null,
    parallel: "Base",
    vendorIds: { ...(row.vendorIds ?? {}), [String(row.source ?? "vendor")]: String(row.cardId) },
  };
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  console.log(`[dedupe-catalog-by-hobbyiq]  apply=${APPLY}  concurrency=${CONCURRENCY}  maxMinutes=${MAX_MINUTES}`);

  // CF-COSMOS-RESERVED-SET-REVERT (Drew, 2026-08-02). Reverted to
  // SELECT * because `set` is a Cosmos SQL reserved word and any
  // attempt to alias it in a SELECT list corrupted downstream field
  // access (hobbyiqSlugFromRow reads row.set). SELECT * is not the
  // bottleneck anyway — the real wins come from the MAX_MINUTES bump
  // (25→60). Scan runs at ~68K rows/min regardless of column count.
  const query = "SELECT * FROM c WHERE c.source IN ('cardhedge', 'cardsight') " +
                "AND NOT STARTSWITH(c.id, 'canonical::') " +
                "AND (IS_DEFINED(c.cardNumber) OR IS_DEFINED(c.number))";

  const iter = cc.items.query({ query }, { maxItemCount: 1000 });

  // Group by hobbyiqCardId
  const bySlug = new Map();
  let scanned = 0;
  let noSlug = 0;

  while (iter.hasMoreResults()) {
    if (timeExpired()) { console.log("⏰ scan-phase time cap"); break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      scanned++;
      const slug = hobbyiqSlugFromRow(row);
      if (!slug) { noSlug++; continue; }
      if (!bySlug.has(slug)) bySlug.set(slug, []);
      bySlug.get(slug).push(row);
      if (scanned % 100000 === 0) console.log(`  scanned=${scanned}  slugs=${bySlug.size}  noSlug=${noSlug}`);
    }
  }
  console.log(`\n  Scan done. scanned=${scanned}  distinct-slugs=${bySlug.size}  noSlug=${noSlug}`);

  // Count singletons vs duplicates
  let singletons = 0, dupGroups = 0, dupRows = 0;
  for (const rows of bySlug.values()) {
    if (rows.length === 1) singletons++;
    else { dupGroups++; dupRows += rows.length; }
  }
  console.log(`  singletons: ${singletons}`);
  console.log(`  duplicate groups: ${dupGroups}  (total rows in groups: ${dupRows})`);
  console.log(`  potential row reduction: ${dupRows - dupGroups}`);

  if (!APPLY) {
    console.log(`\n  (dry run — set BACKFILL_APPLY=true to write canonical + delete vendor rows)`);
    console.log(`RELAUNCH_NEEDED=${timeExpired() ? "true" : "false"}`);
    return;
  }

  // Merge phase — every vendor row moves onto the slug; the first write
  // creates (or lands on) the canonical row, the rest fold onto it.
  let mergedGroups = 0, canonicalUpserts = 0, vendorDeletes = 0, errors = 0;
  const inFlight = [];

  async function processGroup(slug, rows) {
    // Best-populated row first: it is the survivor unless a higher authority
    // already sits at the slug. Sales never point at a vendor id, so there is
    // nothing to re-point (no salesContainer).
    const ordered = rows.slice().sort((a, b) => Object.keys(b).length - Object.keys(a).length);
    const imageUrl = pickImage(rows);
    let landed = false;
    for (const r of ordered) {
      try {
        const res = await moveCatalogRow(cc, r, slug, { ...identityFromVendorRow(r, slug), ...(imageUrl ? { imageUrl } : {}) }, {
          reason: "vendor row folded onto its hobbyiq slug (CF-DEDUPE-CATALOG-BY-HOBBYIQ)",
          retry: withRetry,
        });
        if (res.action === "noop") continue;   // already the row at its own slug
        if (!landed) { canonicalUpserts++; landed = true; }
        vendorDeletes++;
      } catch (e) { errors++; }
    }
    if (landed) mergedGroups++;
  }

  for (const [slug, rows] of bySlug) {
    if (rows.length < 2) continue;   // singletons don't need merge
    if (timeExpired() || processExiting) { console.log("⏰ merge-phase stopping (time cap or fatal error)"); break; }
    inFlight.push(processGroup(slug, rows));
    if (inFlight.length >= CONCURRENCY) {
      await Promise.race(inFlight);
      for (let i = inFlight.length - 1; i >= 0; i--) {
        const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
        if (s !== "PENDING") inFlight.splice(i, 1);
      }
      // Small breather between concurrency-drains to give Cosmos
      // room to breathe if we're brushing up against 429 limits.
      if (GROUP_SLEEP_MS > 0) await new Promise(r => setTimeout(r, GROUP_SLEEP_MS));
    }
    if (mergedGroups > 0 && mergedGroups % 1000 === 0) {
      console.log(`  mergedGroups=${mergedGroups}  canonicalUpserts=${canonicalUpserts}  vendorDeletes=${vendorDeletes}  errors=${errors}`);
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  merged groups:      ${mergedGroups}`);
  console.log(`  canonical upserts:  ${canonicalUpserts}`);
  console.log(`  vendor rows deleted: ${vendorDeletes}`);
  console.log(`  errors:             ${errors}`);
  // Relaunch when: (a) we hit time cap, (b) something crashed and we
  // want the next slice to keep making progress, OR (c) there are
  // more dup groups than we processed this slice (per-slice quota).
  const stillMore = mergedGroups < dupGroups;
  console.log(`RELAUNCH_NEEDED=${(timeExpired() || processExiting || stillMore) ? "true" : "false"}`);
}

main().catch(e => {
  console.error("[main-catch]", e?.message ?? e);
  // Print RELAUNCH_NEEDED=true so the workflow re-dispatches instead
  // of dropping the loop on a crash (prior bug: exit(1) killed the
  // self-relaunch grep).
  console.log("RELAUNCH_NEEDED=true");
  process.exit(0);
});
