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
//   RUN_MINUTES                the work loop's budget (default 110)
//   RESERVE_MS / VERIFY_MS     unit reserve / verify cap (see THE CLOCK)
//   BACKFILL_CONCURRENCY       parallel workers (default 8)

const path = require("node:path");
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

const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy: a
// private capped() is what #1859 cost (an unref'd cap that never fired, four
// runs killed at the ceiling having already reconciled clean).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = process.env.BACKFILL_APPLY === "true";

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane DELETES card_catalog rows
// (it folds vendor rows onto their hobbyiq slug) and had a LOCAL time cap
// rather than a budget: BACKFILL_MAX_MINUTES, checked at the top of both loops
// with no unit reserve, and signalling continuation through RELAUNCH_NEEDED
// rather than the marker every other budgeted lane prints.
//
// THAT CAP WAS NOT A BUDGET. It reserved NOTHING for the group still in flight,
// so a group admitted a millisecond before expiry ran its whole delete train
// past it. And its RELAUNCH_NEEDED protocol goes SILENT when the step is
// killed: `RN` parses empty and the runner's RELAUNCH_NEEDED step falls to a
// `::warning::` that does NOT fail the job, so a killed run went GREEN with an
// unknown number of catalog rows deleted -- #1906's defect in a second
// protocol. Its own history says the exposure was real: the cap was raised
// 25 -> 60 precisely because "prior 25 got eaten entirely by the scan phase
// (1.65M rows takes ~24 min)".
//
// THE UNIT IS ONE DUPLICATE GROUP, not a page, because the merge loop cannot
// stop inside one: processGroup walks the group's rows serially, and each
// moveCatalogRow is an upsert plus a delete through an EIGHT-ATTEMPT retry
// ladder whose backoff sums to ~127 seconds per operation on a throttled
// container. A group is small in rows and potentially very long in wall clock,
// so the reserve is FIVE MINUTES -- sized to that retry ladder rather than to
// the row count -- and it is checked BEFORE the group is dispatched.
//
// -- WHY THE WRITE PHASE REFUSES AFTER A SCAN-PHASE STOP ---------------------
//
// #1947's retire-flattened-attestations lesson, and this lane is the sharper
// case. The scan does not merely collect rows: it GROUPS THE WHOLE CONTAINER by
// hobbyiq slug, and the merge phase then reads each group's SHAPE to decide
// what to do -- `rows.length < 2` means singleton, skip; otherwise the
// best-populated row is chosen as the survivor and every other row in the group
// is DELETED.
//
// Both of those readings are wrong on a partial scan, and wrong in the
// direction that destroys data:
//
//   - A group that has been seen ONCE looks like a singleton, but its siblings
//     may simply be in the pages the budget never reached. Skipping it is
//     harmless.
//   - A group seen TWICE out of five looks complete, and the merge picks the
//     best-populated of the TWO rows it happens to have. The true survivor --
//     the richest row in the group -- may sit in the unscanned remainder, and
//     this run will DELETE the better row and keep the poorer one. That is not
//     an unfinished job; it is a wrong one, and no relaunch undoes it.
//
// So a scan-phase budget stop REFUSES the merge phase outright (exit 5) rather
// than acting on a population whose shape it cannot trust. The next dispatch
// re-scans from the top and, when it completes the scan inside its budget,
// merges against groups that are actually whole.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 5 + 1 + 1 = 117m under the 150m ceiling: 33 minutes of margin.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 5 * 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });
// CF-DEDUPE-THROTTLE-FIX (Drew, 2026-08-01). Prior default of 8-16
// concurrent workers × (1 upsert + N deletes per group) hammered
// Cosmos into 429 storms that overwhelmed the retry loop and
// crashed the process with an uncaught 429 error. Reduce default
// concurrency + add per-group sleep + more retry attempts with
// longer backoff.
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 4));
const GROUP_SLEEP_MS = Math.max(0, Number(process.env.GROUP_SLEEP_MS || 100));

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

let processExiting = false;

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
  // NAMED, not chained, so finishLane() can dispose it (#1809): an undisposed
  // SDK holds keep-alive sockets, and a live handle is what held four
  // reconciled-clean runs to the ceiling.
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  console.log(`[dedupe-catalog-by-hobbyiq]  apply=${APPLY}  concurrency=${CONCURRENCY}`);
  console.log(`  ${CLOCK.describe()}`);

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

  // Set when the budget stopped the SCAN. It is what makes the merge phase
  // refuse: a partial grouping cannot be merged safely (see THE CLOCK above).
  let scanStoppedAtBudget = false;
  while (iter.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched rather than after it is grouped.
    if (CLOCK.outOfClock()) { scanStoppedAtBudget = true; break; }
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
    if (scanStoppedAtBudget) {
      console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
        + `the scan is UNFINISHED, so these group counts describe only what was seen`);
    }
    return { client, budget: CLOCK };
  }

  // -- THE WRITE PHASE REFUSES ON A PARTIAL SCAN ---------------------------
  //
  // See THE CLOCK above for why this is a REFUSAL rather than a partial merge:
  // a group's SHAPE decides which row survives and which are deleted, and a
  // half-scanned group can name the wrong survivor. Nothing has been written at
  // this point, so refusing costs a re-scan and never a wrong delete.
  if (scanStoppedAtBudget) {
    console.error(`\nREFUSING TO MERGE: the scan stopped at the ${CLOCK.RUN_MINUTES}-minute budget,`
      + ` so the grouping is PARTIAL.`);
    console.error("  A group seen in part looks complete: the merge would pick the best-populated of"
      + " the rows it happens to hold and DELETE the rest, while the true survivor may sit in the"
      + " pages this run never read. That is a wrong merge, not an unfinished one, and no relaunch"
      + " undoes a deleted row.");
    console.error("  Nothing was written. Re-dispatch: the next run re-scans from the top and merges"
      + " only if it completes the scan inside its budget.");
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `scan phase only; the merge was REFUSED and the relaunch continues from here`);
    process.exitCode = 5;
    return { client, budget: CLOCK };
  }

  // Merge phase — every vendor row moves onto the slug; the first write
  // creates (or lands on) the canonical row, the rest fold onto it.
  let mergedGroups = 0, canonicalUpserts = 0, vendorDeletes = 0, errors = 0;
  const inFlight = [];
  let mergeStoppedAtBudget = false;

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
    // THE PRE-CHECK: before the group is dispatched rather than after its
    // delete train has been issued. The reserve is sized to the ~127s retry
    // ladder a single moveCatalogRow can spend on a throttled container.
    if (CLOCK.outOfClock()) { mergeStoppedAtBudget = true; break; }
    if (processExiting) { console.log("merge-phase stopping (fatal error)"); break; }
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
  // RECONCILE OVER THE GROUPS THIS RUN DISPATCHED. The population is KNOWN here
  // -- `dupGroups` was counted from a COMPLETE scan, which the refusal above
  // guarantees -- so `not reached` is a real number rather than an invention
  // (#1947: the two reconciliation shapes are not interchangeable).
  const notReached = dupGroups - mergedGroups - errors;
  console.log(`  reconciled: intended ${dupGroups} groups = merged ${mergedGroups}`
    + ` + failed ${errors} + not reached ${notReached}`);
  if (mergedGroups + errors + notReached !== dupGroups) {
    console.error("  !! RECONCILE MISMATCH -- a duplicate group was neither merged, failed nor left unreached");
    process.exitCode = 4;
  }
  reportWrites({
    job: "dedupe-catalog-by-hobbyiq",
    intended: dupGroups, written: mergedGroups, skipped: notReached, failed: errors,
  });

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables: a marker built by concatenation is one a refactor can silently
  // reword, and a reworded marker ends the fan-out after one slice with the run
  // green -- the quiet version of the bug it exists to make loud.
  if (mergeStoppedAtBudget || processExiting || mergedGroups < dupGroups) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `${notReached} of ${dupGroups} duplicate groups NOT REACHED; the relaunch continues from here`);
    console.log("  the merge is IDEMPOTENT: a group already folded has one row left at its slug, so"
      + " it re-reads as a singleton and is skipped, and moveCatalogRow returns `noop` for a row"
      + " already at its own slug. The continuation re-scans cheaply and merges only what is left.");
  }

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too -- a failure
// path that exits and a success path that hopes is the asymmetry that cost four
// reconciled-clean runs their exit codes.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
