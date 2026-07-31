#!/usr/bin/env node
// CF-BACKFILL-CARDSIGHT-TITLE-IDENTITY (Drew, 2026-07-31).
//
// Retroactively applies the CF-CARDNUMBER-FROM-TITLE ingest fix to
// historical sold_comps rows written before the fix landed (PR #987).
//
// Scans every row from source=="cardsight" with a title, re-parses the
// title via parseListingIdentity, and REWRITES the row's identity
// fields (cardNumber, parallel, isAuto, hobbyiqCardId, contentHash)
// when the parsed identity differs from the stored one.
//
// Motivating case: Drew's Hartman Blue Refractor CPA-EHA pool had 19
// sub-$25 rows that were actually base BCP-102 sales (Reptilian,
// Purple Geometric, Sky Blue Border, Lazer). Their tiny prices dragged
// the raw anchor from a real $1,500+ market down to $550. This
// script relocates those rows to their true pools (Reptilian BCP-102,
// etc.), immediately cleaning up the Blue Refractor CPA-EHA pool.
//
// Idempotent: re-running skips rows whose stored identity already
// matches the parsed identity. Skips rows where title parsing can't
// derive a cardNumber (falls through — can't verify → don't touch).
//
// Modes:
//   BACKFILL_APPLY=false (default) — dry-run: reports what would change
//   BACKFILL_APPLY=true            — apply the writes
//
// Concurrency: BACKFILL_CONCURRENCY (default 8).

const path = require("path");

const APPLY = String(process.env.BACKFILL_APPLY || "").toLowerCase() === "true";
const CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.BACKFILL_CONCURRENCY || 8)));
const LIMIT = Number(process.env.BACKFILL_LIMIT || 0);   // 0 = no cap

if (!process.env.COSMOS_CONNECTION_STRING) {
  console.error("COSMOS_CONNECTION_STRING not set");
  process.exit(1);
}

async function main() {
  const { CosmosClient } = require("@azure/cosmos");
  const { createHash } = require("crypto");

  // Load compiled title parser + slug computer.
  const backend = path.resolve(__dirname, "..");
  const { parseListingIdentity } = require(
    path.join(backend, "dist", "services", "portfolioiq", "parseTitleIdentity.service.js"),
  );
  const { computeHobbyIqCardId } = require(
    path.join(backend, "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"),
  );

  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[backfill-cardsight-title-identity]`);
  console.log(`  mode:        ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit:       ${LIMIT || "no cap"}`);
  console.log("");

  // Query cardsight rows with a title. Bounded fetch — Cosmos SDK
  // pages internally; we consume 500 at a time to keep memory bounded.
  const query = LIMIT > 0
    ? `SELECT TOP ${LIMIT} c.id, c.cardId, c.title, c.parallel, c.cardNumber, c.isAuto, c.playerName, c.cardYear, c.setName, c.sport, c.hobbyiqCardId, c.contentHash, c.price, c.soldAt, c.source, c.url FROM c WHERE c.source = 'cardsight' AND IS_DEFINED(c.title) AND c.title != null`
    : `SELECT c.id, c.cardId, c.title, c.parallel, c.cardNumber, c.isAuto, c.playerName, c.cardYear, c.setName, c.sport, c.hobbyiqCardId, c.contentHash, c.price, c.soldAt, c.source, c.url FROM c WHERE c.source = 'cardsight' AND IS_DEFINED(c.title) AND c.title != null`;

  const stats = {
    scanned: 0,
    unchanged: 0,           // parser matched stored (no-op, most rows)
    unparseable: 0,         // title has no recognizable cardNumber
    identityMismatched: 0,  // parser differs from stored → will rewrite
    rewriteQueued: 0,
    rewriteOk: 0,
    rewriteErr: 0,
    samples: [],
  };

  const iterator = sc.items.query(query, { maxItemCount: 500 });
  const workQueue = [];

  while (iterator.hasMoreResults()) {
    const page = await iterator.fetchNext();
    for (const row of page.resources) {
      stats.scanned++;
      const parsed = parseListingIdentity(String(row.title || ""));
      if (!parsed.cardNumber) {
        stats.unparseable++;
        continue;
      }
      const newCardNumber = String(parsed.cardNumber).toUpperCase();
      const oldCardNumber = String(row.cardNumber || "").toUpperCase();
      const newParallel = parsed.parallel ?? "Base";
      const oldParallel = String(row.parallel || "");
      const newIsAuto = Boolean(parsed.isAuto);
      const oldIsAuto = Boolean(row.isAuto);
      // CF-BACKFILL-CARDSIGHT-TITLE-IDENTITY (Drew, 2026-07-31, dry-run
      // sanity check): the first dry-run flagged 194K rows as mismatched
      // because slug-form stored values (e.g. "blue-refractor") differ
      // from Title-Case parsed values ("Blue Refractor") purely by
      // hyphens vs spaces. Those aren't real identity mismatches —
      // they're just spelling variants of the same card. Normalize both
      // sides to a canonical form (uppercase for cardNumber, collapse
      // whitespace/hyphens/underscores for parallel) before comparing.
      // Only REAL identity differences (different color/finish word,
      // different card number, wrong auto flag) survive the filter.
      const normalizeParallel = (s) =>
        String(s || "").toLowerCase().replace(/[-_\s]+/g, "-").replace(/^-|-$/g, "");
      const changed =
        newCardNumber !== oldCardNumber ||
        normalizeParallel(newParallel) !== normalizeParallel(oldParallel) ||
        newIsAuto !== oldIsAuto;
      if (!changed) {
        stats.unchanged++;
        continue;
      }
      stats.identityMismatched++;
      if (stats.samples.length < 12) {
        stats.samples.push({
          id: row.id,
          title: String(row.title || "").slice(0, 90),
          from: { cardNumber: row.cardNumber, parallel: row.parallel, isAuto: row.isAuto },
          to: { cardNumber: newCardNumber, parallel: newParallel, isAuto: newIsAuto },
        });
      }
      if (!APPLY) continue;
      workQueue.push({ row, parsed, newCardNumber, newParallel, newIsAuto });
    }
  }

  console.log(`\n=== Scan summary ===`);
  console.log(`  scanned:              ${stats.scanned}`);
  console.log(`  unchanged (skipped):  ${stats.unchanged}`);
  console.log(`  unparseable title:    ${stats.unparseable}`);
  console.log(`  identity mismatched:  ${stats.identityMismatched}`);

  if (stats.samples.length > 0) {
    console.log(`\n=== Sample mismatches (first ${stats.samples.length}) ===`);
    for (const s of stats.samples) {
      console.log(`  [${s.id.slice(0, 40)}...]`);
      console.log(`    title:  "${s.title}"`);
      console.log(`    from:   ${s.from.cardNumber} / ${s.from.parallel} / auto=${s.from.isAuto}`);
      console.log(`    to:     ${s.to.cardNumber} / ${s.to.parallel} / auto=${s.to.isAuto}`);
    }
  }

  if (!APPLY) {
    console.log(`\n[dry-run] no writes. Re-run with BACKFILL_APPLY=true to apply.`);
    return;
  }

  console.log(`\n=== Applying ${workQueue.length} rewrites (concurrency ${CONCURRENCY}) ===`);

  // Worker pool
  let idx = 0;
  const worker = async () => {
    while (idx < workQueue.length) {
      const my = idx++;
      const { row, parsed, newCardNumber, newParallel, newIsAuto } = workQueue[my];
      stats.rewriteQueued++;
      try {
        // Recompute slug + contentHash with the new identity.
        // hobbyIqCardId inputs: sport, year, setKey, cardNumber,
        // parallel, isAuto, printRun. We keep sport/year/setKey from
        // the stored row (title parsing doesn't derive them here —
        // the ingest path already inferred setKey from the FULL title
        // context, and year is server-supplied).
        const setKey = deriveSetKeyFromSlug(row.hobbyiqCardId) || null;
        const newSlug = computeHobbyIqCardId({
          sport: row.sport ?? "baseball",
          year: row.cardYear,
          setKey,
          cardNumber: newCardNumber,
          parallel: newParallel,
          isAuto: newIsAuto,
          printRun: parsed.printRun ?? null,
        });
        const newContentHash = createHash("sha256").update(
          `${newSlug}|${Number(row.price).toFixed(2)}|${String(row.soldAt).slice(0, 10)}|${row.source}|${row.url ?? ""}`,
        ).digest("hex").slice(0, 32);

        // Read the CURRENT full doc (fields not in the SELECT above),
        // then write it back with the updated identity fields.
        const { resource: full } = await sc.item(row.id, row.cardId).read();
        if (!full) {
          stats.rewriteErr++;
          continue;
        }
        full.cardNumber = newCardNumber;
        full.parallel = newParallel;
        full.isAuto = newIsAuto;
        full.hobbyiqCardId = newSlug;
        full.contentHash = newContentHash;
        // Marker for retrospective audit — which rows this backfill touched.
        full.__migratedByBackfill = "CF-BACKFILL-CARDSIGHT-TITLE-IDENTITY-20260731";
        await sc.item(row.id, row.cardId).replace(full);
        stats.rewriteOk++;
        if (stats.rewriteOk % 50 === 0) {
          console.log(`  ...${stats.rewriteOk} rewrites applied`);
        }
      } catch (err) {
        stats.rewriteErr++;
        console.warn(`  ERR row ${row.id}: ${(err && err.message) || err}`);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`\n=== Apply summary ===`);
  console.log(`  queued:  ${stats.rewriteQueued}`);
  console.log(`  ok:      ${stats.rewriteOk}`);
  console.log(`  errors:  ${stats.rewriteErr}`);
}

// Given a slug like "hiq:baseball:2026:bowman-chrome:cpa-eha:blue-refractor:auto",
// return the setKey segment ("bowman-chrome"). Returns null when slug
// is malformed. Used to preserve setKey through the rewrite.
function deriveSetKeyFromSlug(slug) {
  if (typeof slug !== "string") return null;
  const parts = slug.split(":");
  // hiq : sport : year : setKey : cardNumber : parallel : autoFlag [: num-N]
  if (parts.length < 7 || parts[0] !== "hiq") return null;
  return parts[3] || null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
