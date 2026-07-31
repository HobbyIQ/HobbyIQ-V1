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

  // CF-BACKFILL-WIDEN-SOURCES (Drew, 2026-07-31). Originally scoped to
  // cardsight-source rows only (which pre-dated the CF-CARDNUMBER-FROM-
  // TITLE ingest fix). Widening to also cover cardhedge + ebay-user-
  // purchase because BOTH of those paths also wrote pre-title-parsing
  // rows to sold_comps before the parseListingIdentity call landed in
  // persistVendorSalesToPool on 2026-07-23. Historical rows from those
  // sources have the same wrong-parallel / wrong-cardNumber bug.
  //
  // Scope filter via BACKFILL_CARD_NUMBERS env var: comma-separated
  // list of cardNumbers (e.g. "CPA-EHA,CPA-JHA,BCP-102") — restricts
  // scan to matching rows only. Used for targeted, fast cleanup of
  // Drew's specific holdings before firing the full corpus grind.
  const cardNumbersFilter = String(process.env.BACKFILL_CARD_NUMBERS || "").trim();
  const cardNumberList = cardNumbersFilter
    ? cardNumbersFilter.split(",").map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0)
    : null;
  const sourceClause = "c.source IN ('cardsight', 'cardhedge', 'ebay-user-purchase')";
  const cardNumberClause = cardNumberList && cardNumberList.length > 0
    ? ` AND UPPER(c.cardNumber) IN (${cardNumberList.map((n) => `'${n.replace(/'/g, "''")}'`).join(", ")})`
    : "";
  const topClause = LIMIT > 0 ? `TOP ${LIMIT} ` : "";
  const query = `SELECT ${topClause}c.id, c.cardId, c.title, c.parallel, c.cardNumber, c.isAuto, c.playerName, c.cardYear, c.setName, c.sport, c.hobbyiqCardId, c.contentHash, c.price, c.soldAt, c.source, c.url FROM c WHERE ${sourceClause}${cardNumberClause} AND IS_DEFINED(c.title) AND c.title != null`;
  console.log(`  sources:     cardsight, cardhedge, ebay-user-purchase`);
  console.log(`  cardNumbers: ${cardNumberList ? cardNumberList.join(",") : "(all)"}`);

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
      // CF-BACKFILL-CARDSIGHT-TITLE-IDENTITY (Drew, 2026-07-31):
      // three-way mismatch check — cardNumber, parallel, isAuto. Every
      // one of them is a real data-quality signal worth correcting:
      //
      //   - cardNumber mismatch → sale in wrong FMV pool (Drew's Blue
      //     Refractor $550 case: stored CPA-EHA but title BCP-102)
      //   - parallel mismatch → sale in wrong sibling pool (Blue
      //     Refractor vs Blue X-Fractor are different variants)
      //   - isAuto mismatch → sale in wrong isAuto slot (base auto
      //     comparisons broken; grade multipliers apply the wrong tier)
      //   - null → Base parallel — legit correction that stops the
      //     "unknown parallel" bucket from polluting cross-parallel
      //     queries. Same physical card being labeled two ways is a bug.
      //
      // Normalize casing + hyphen/space for parallel comparison so
      // "blue-refractor" and "Blue Refractor" (same identity, different
      // spelling) don't flag; only genuine spelling differences do.
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
        // CF-BACKFILL-429-RETRY (Drew, 2026-07-31). First apply run
        // hit 4,374 Cosmos 429s at concurrency 32. Wrap read+write in
        // exponential-backoff retry so throttled rows still land on
        // this pass rather than needing another whole re-run.
        const withRetry = async (op) => {
          let attempt = 0;
          while (true) {
            try {
              return await op();
            } catch (e) {
              const is429 = String((e && e.message) || "").includes("request rate is too large");
              if (!is429 || attempt >= 4) throw e;
              const backoffMs = 200 * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
              await new Promise((r) => setTimeout(r, backoffMs));
              attempt++;
            }
          }
        };
        const { resource: full } = await withRetry(() => sc.item(row.id, row.cardId).read());
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
        await withRetry(() => sc.item(row.id, row.cardId).replace(full));
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
