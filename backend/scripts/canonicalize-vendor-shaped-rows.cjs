#!/usr/bin/env node
/**
 * CF-ALL-OF-THE-CATALOG-IN-ONE-PLACE (Drew, 2026-08-26).
 *
 * 5,369,164 catalog rows -- 17% of the container -- cannot be reached by a
 * point read, because their address is not their identity:
 *
 *     id     = cardhedge::1775832219776x807179689237410600::2be9b853
 *     cardId = 1775832219776x807179689237410600
 *
 * Two distinct populations, measured:
 *
 *     id !== cardId (wrong partition)      2,835,432
 *     cardId missing entirely (undefined)  2,533,732
 *
 * NOTHING HAS EVER TARGETED THESE. Phase 02's retire required
 * IS_DEFINED(c.gradeTier), so it only ever saw graded rows -- of the 2,835,432
 * mis-partitioned rows exactly 1,018 were graded, and the other 2,834,414 were
 * never touched. rehome-catalog-rows-to-own-partition requires
 * STARTSWITH(c.id,'hiq:'), and these ids are vendor-shaped, so it cannot reach
 * them either. Two sweeps ran to completion over this population and both were
 * structurally blind to it.
 *
 * WHAT THIS DOES. A row is canonical when it lives at its own slug. For each
 * broken row:
 *
 *   1. Determine its canonical slug -- hobbyiqCardId if it carries one
 *      (2,502,339 do), otherwise derive it from its own fields.
 *   2. If a canonical row ALREADY exists at that slug, this row is a redundant
 *      copy: retire it. Sampled at 79%.
 *   3. Otherwise this row is the only record of that card: write it to its own
 *      slug through upsertCatalogEntry, then retire the vendor-shaped original.
 *      Sampled at 21%.
 *   4. If no slug can be determined, leave it and COUNT it. A row we cannot
 *      name is not a row we may delete.
 *
 * COPY BEFORE DELETE, ALWAYS. The canonical write is awaited and verified
 * before the original is removed. A crash between them leaves a duplicate,
 * which the next pass retires; the reverse order would lose the only copy.
 * Half-moved rows are what stranded the last re-home.
 *
 * SHARDED ON SOURCE, because it is measured and every target row has one
 * (rows with no source are their own bucket). setKey ranges put 89% of the
 * retire on one worker and could not reach 66,711 rows at all -- shard axes
 * get a GROUP BY before a fleet is dispatched, not after.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   APPLY / BACKFILL_APPLY    actually write (default: report only)
 *   SLOT / SLOTS              shard across workers by source (biggest-first)
 *   CONCURRENCY=48
 *   RUN_MINUTES=140           stop before the 150-min step ceiling
 *   LIMIT=0                   stop after N rows resolved (0 = no limit)
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const { upsertCatalogEntry } = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 48));
const LIMIT = Number(process.env.LIMIT || 0);
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, generalised 2026-09-04).
// The runner exports `slots` for EVERY script with a workflow-wide DEFAULT of
// "16", so `process.env.SLOTS ?? 1` NEVER saw undefined and this lane sharded
// itself sixteen ways on a dispatch that asked for no sharding -- sweeping slot
// 0 and leaving fifteen sixteenths untouched, green and honestly reconciled.
// Sharding is now OPT-IN: a non-zero slot, or an explicit SHARD=true for slot 0
// of a real fan-out. Everything else -- including the inherited slot=0 slots=16
// -- sweeps EVERY row. SLOTS binds to 1 when unsharded, so `% SLOTS` and
// `SLOTS === 1` guards below keep working unchanged.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({ label: "canonicalize-vendor-shaped-rows" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const STARTED = Date.now();

/**
 * Not at its own address.
 *
 * CF-AN-UNINDEXABLE-PREDICATE-IS-A-FULL-SCAN (Drew, 2026-08-26). This was
 * `c.id != c.cardId OR NOT IS_DEFINED(c.cardId)`, which is correct and
 * unusably slow: comparing two FIELDS cannot be served from an index, so every
 * page was a full scan of 31.6M documents pulling SELECT *. Four workers
 * managed ~700 rows/min where the retire did 28,000, and 5.2M rows would have
 * taken five days.
 *
 * Measured, the two populations are almost exactly the same rows:
 *
 *     id != cardId          2,700,294
 *     id is not a hiq slug  2,703,875   <- STARTSWITH, index-friendly
 *
 * because a row whose address is not its identity is precisely a row carrying
 * a vendor-shaped id. So select on STARTSWITH, which a range index serves, and
 * keep the field comparison as a per-row CHECK rather than a scan predicate —
 * that way an id that happens to start with "hiq:" but still disagrees with
 * its cardId is skipped rather than wrongly rewritten.
 *
 * MODE picks which half to work: "vendor" (default) or "nopk".
 */
const MODE = String(process.env.MODE || "vendor").toLowerCase();
const BROKEN = MODE === "nopk"
  ? "(NOT IS_DEFINED(c.cardId) OR c.cardId = null)"
  : "(NOT STARTSWITH(c.id,'hiq:'))";

const f = (n) => Number(n).toLocaleString();

// CF-A-ROW-CAN-EXIST-AT-AN-ID-THE-SDK-CANNOT-ADDRESS (Drew, 2026-08-27:
// "fix it").
//
// Cosmos forbids / \ # ? in a Resource ID, and the SDK builds a URL path from
// the id -- so item(id, pk) throws client-side before any request is made.
// Rows nonetheless EXIST carrying them:
//
//     card::hiq:baseball:2018:bowman:108/165
//
// 16,112 catalog rows and 51,095 sales carry a "/" in cardNumber, and they are
// not all mistakes: "AAC/BG" and "PTD-AR/NG" are real dual-player card
// numbers, and "N/A" is a placeholder. computeHobbyIqCardId already sanitises
// these correctly (108/165 -> 108165), so the slug generator is not the
// source; these rows predate it or came in through another path.
//
// The bug being fixed here is narrower: this script THREW on them, which
// failed the whole run and cost three dispatches before anyone read the log.
// A row we cannot address is a real class of thing -- count it and move on, so
// the pass finishes and the population stays visible.
const ILLEGAL_ID = /[/\\#?]/;

/** The slug this row should live at, or null when it cannot be named. */
function canonicalSlugFor(row) {
  if (typeof row.hobbyiqCardId === "string" && row.hobbyiqCardId.startsWith("hiq:")) {
    return row.hobbyiqCardId;
  }
  if (typeof row.id === "string" && row.id.startsWith("hiq:")) return row.id;
  // Derive from the row's own fields. Anything missing means we cannot name it,
  // and an unnameable row is never deleted.
  const setKey = row.setKey ?? row.setName;
  if (!row.sport || !row.year || !setKey || row.cardNumber === undefined || row.cardNumber === null) return null;
  try {
    const slug = computeHobbyIqCardId({
      sport: row.sport,
      year: Number(row.year),
      setKey,
      cardNumber: String(row.cardNumber),
      parallel: row.parallel ?? "Base",
      isAuto: Boolean(row.isAuto),
      printRun: row.printRun ?? null,
    });
    return typeof slug === "string" && slug.startsWith("hiq:") ? slug : null;
  } catch { return null; }
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const cat = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq").container("card_catalog");

  const retry = async (fn, tries = 12) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        if (!/request rate is too large|429/i.test(String(e?.message)) || a >= tries) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  // ── shard on source, measured at startup ─────────────────────────────────
  let scoped = BROKEN;
  let params = [];
  if (SLOTS > 1) {
    if (SLOT > 0) await new Promise((r) => setTimeout(r, SLOT * 15000));
    const { resources: rows } = await retry(() => cat.items
      .query(`SELECT c.source AS s, COUNT(1) AS n FROM c WHERE ${BROKEN} GROUP BY c.source`).fetchAll());
    const all = rows.filter((r) => typeof r.s === "string").sort((a, b) => b.n - a.n || a.s.localeCompare(b.s));
    const mine = all.filter((_, i) => i % SLOTS === SLOT);
    // Rows with no source at all belong to exactly one slot, or they would be
    // done N times or not at all.
    const takesNullSource = SLOT === 0;
    if (!mine.length && !takesNullSource) {
      console.log(`slot ${SLOT}/${SLOTS} owns no source — nothing to do`);
      console.log(`  ${SHARD_SCOPE.banner()}`);
      return;
    }
    params = mine.map((r, i) => ({ name: `@s${i}`, value: r.s }));
    const inList = params.length ? `c.source IN (${params.map((p) => p.name).join(",")})` : "false";
    scoped = takesNullSource
      ? `${BROKEN} AND (${inList} OR NOT IS_DEFINED(c.source) OR c.source = null)`
      : `${BROKEN} AND ${inList}`;
    console.log(`slot ${SLOT}/${SLOTS}  ${mine.length} of ${all.length} sources, ${f(mine.reduce((s, r) => s + r.n, 0))} rows${takesNullSource ? " (+ rows with no source)" : ""}`);
  }

  let scanned = 0, retiredRedundant = 0, rehomed = 0, unnameable = 0, failed = 0, alreadyOk = 0;
  let unaddressable = 0;
  const unaddressableSample = [];
  let stopReason = null;
  // A copy that landed but whose delete threw is a leftover DUPLICATE, not a
  // lost card, and not a failed write. It was being counted as both rehomed
  // AND failed, which is what tripped the reconciliation "OVER by 1".
  let deleteFailed = 0, notReached = 0;
  const unnameableSample = [];

  let token;
  do {
    const page = await retry(() => cat.items
      .query({ query: `SELECT * FROM c WHERE ${scoped}`, parameters: params },
        { maxItemCount: 400, continuationToken: token }).fetchNext());
    token = page.continuationToken;

    for (let i = 0; i < page.resources.length; i += CONCURRENCY) {
      await Promise.all(page.resources.slice(i, i + CONCURRENCY).map(async (row) => {
        scanned++;
        // Unaddressable by the SDK: reading or deleting it throws before a
        // request is sent, so there is nothing this pass can do with it.
        if (ILLEGAL_ID.test(String(row.id ?? "")) || ILLEGAL_ID.test(String(row.cardId ?? ""))) {
          unaddressable++;
          if (unaddressableSample.length < 8) unaddressableSample.push(String(row.id).slice(0, 70));
          return;
        }
        // The scan predicate is indexable but coarse. Confirm the row really
        // is mis-addressed before touching it: a row already at its own slug
        // is left exactly as it is.
        if (row.cardId !== undefined && row.cardId !== null && row.id === row.cardId) { alreadyOk++; return; }
        const slug = canonicalSlugFor(row);
        if (!slug) {
          unnameable++;
          if (unnameableSample.length < 8) unnameableSample.push(`${String(row.id).slice(0, 62)}  src=${row.source}`);
          return;
        }
        try {
          const twin = await retry(() => cat.item(slug, slug).read().catch((e) => {
            if (e.code === 404) return { resource: undefined };
            throw e;
          }));

          if (!twin.resource) {
            // Only copy of this card. Write it to its own slug FIRST.
            if (!APPLY) { rehomed++; return; }
            const {
              _rid, _self, _etag, _attachments, _ts,
              id: _oldId, cardId: _oldCardId,
              ...rest
            } = row;
            // upsertCatalogEntry returns the written row, so a separate verify
            // read was a third round-trip per card that proved nothing the
            // return value did not already prove.
            // `known: null` -- the twin read above already established that
            // nothing sits at this slug. Without it upsertCatalogEntry looks
            // again and then runs a cross-partition scan on the miss, once per
            // card, which is what held re-homing to 1,700 rows/min.
            const written = await retry(() => upsertCatalogEntry({
              ...rest, id: slug, cardId: slug, hobbyiqCardId: slug,
              vendorIds: {
                ...(row.vendorIds ?? {}),
                ...(row.source && row.cardId ? { [row.source]: String(row.cardId) } : {}),
              },
              canonicalizedFrom: row.id,
            }, { known: null }));
            if (!written) { failed++; return; }
            rehomed++;
          } else if (!APPLY) { retiredRedundant++; return; }
          else retiredRedundant++;

          // The original is now redundant either way.
          if (APPLY) {
            const pk = row.cardId === undefined || row.cardId === null ? undefined : row.cardId;
            await retry(() => cat.item(row.id, pk).delete()).catch((e) => {
              if (e.code === 404) return;   // already gone; the copy stands
              deleteFailed++;
              if (deleteFailed <= 5) console.error(`  delete left a duplicate ${String(row.id).slice(0, 60)}: ${String(e.message || e).slice(0, 60)}`);
            });
          }
        } catch (e) {
          failed++;
          if (failed <= 5) console.error(`  failed ${String(row.id).slice(0, 60)}: ${String(e.message || e).slice(0, 70)}`);
        }
      }));
      const processed = Math.min(i + CONCURRENCY, page.resources.length);
      if (LIMIT && (rehomed + retiredRedundant) >= LIMIT) { stopReason = "limit"; notReached += page.resources.length - processed; break; }
      if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; notReached += page.resources.length - processed; break; }
    }
    if (stopReason) break;
  } while (token);

  if (stopReason === "budget") {
    console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget with work left — the relaunch continues from here`);
  } else if (stopReason === "limit") {
    console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run, not the whole shard`);
  }

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written or deleted"}`);
  console.log(`  scanned                        ${f(scanned)}`);
  console.log(`  re-homed to their own slug     ${f(rehomed)}`);
  console.log(`  retired as redundant copies    ${f(retiredRedundant)}`);
  console.log(`  already at their own slug      ${f(alreadyOk)}`);
  console.log(`  UNNAMEABLE (left alone)        ${f(unnameable)}`);
  console.log(`  UNADDRESSABLE id (skipped)     ${f(unaddressable)}   <- / \\ # ? in the id; the SDK cannot reference it`);
  console.log(`  delete left a duplicate        ${f(deleteFailed)}   <- copy landed, original remains; a re-sweep clears it`);
  console.log(`  failed                         ${f(failed)}`);
  if (unaddressableSample.length) {
    console.log(`\n  unaddressable sample — these need a migration, not a sweep:`);
    for (const u of unaddressableSample) console.log(`    ${u}`);
  }
  if (unnameableSample.length) {
    console.log(`\n  unnameable sample — these are not deletable, they need a parser:`);
    for (const u of unnameableSample) console.log(`    ${u}`);
  }
  if (APPLY) {
    reportWrites({
      job: "canonicalize-vendor-shaped-rows",
      intended: scanned,
      written: rehomed + retiredRedundant,
      // Every bucket a scanned row can land in, or the total under-accounts
      // and the guard fires on a clean run.
      skipped: unnameable + alreadyOk + unaddressable + notReached,
      failed,
    });
  }
}

module.exports = { canonicalSlugFor, BROKEN };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
}
