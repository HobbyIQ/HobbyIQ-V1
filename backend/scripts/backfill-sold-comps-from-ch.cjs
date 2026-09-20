#!/usr/bin/env node
/**
 * CF-SOLD-COMPS-CH-BACKFILL (Drew, 2026-07-19). Bulk-populate
 * sold_comps from ch_daily_sales so cross-user aggregation, /recent-
 * sales feeds, and signals see the full CH corpus — not just what
 * canonical FMV happens to have warmed on demand.
 *
 * Fixes the ch_daily_sales → sold_comps ingestion gap: previously
 * only cards someone asked FMV for got written. Now every CH sale
 * lands in the pool with its NATIVE parallel, cardNumber, and grader
 * (NOT the caller's requested parallel — that was the bug in
 * warmPoolFromCh that tagged CH cross-parallel returns with the
 * request's parallel).
 *
 * Runbook:
 *   # Dry run last 24 hours
 *   COSMOS_CONNECTION_STRING=... node scripts/backfill-sold-comps-from-ch.cjs \
 *     --from=2026-07-18 --to=2026-07-19 --dry-run
 *
 *   # Apply last 90 days
 *   COSMOS_CONNECTION_STRING=... node scripts/backfill-sold-comps-from-ch.cjs \
 *     --from=2026-04-20 --to=2026-07-19 --apply
 *
 * Flags:
 *   --from=YYYY-MM-DD   inclusive start (required)
 *   --to=YYYY-MM-DD     inclusive end (required)
 *   --apply             actually write (default: dry-run)
 *   --concurrency=N     concurrent writers (default 8, max 32)
 *   --limit=N           safety limit on rows processed (default: unlimited)
 *
 * Idempotent: uses source::sourceExternalId dedup so re-runs are safe.
 *
 * CF-CH-DAILY-DOUBLE-WRITE (2026-09-20). This script writes straight to
 * the sold_comps container — #1941's guardSoldCompDoc call below catches
 * a malformed identity field, but does NOT catch an id-shape mismatch
 * against recordSoldComp's own makeId(), because this script never calls
 * recordSoldComp. Fixed here: the id this script wrote had drifted from
 * the canonical `cardhedge::ch-daily::<price_history_id>` shape onto a
 * synthetic (card_id, sale_date, price) key, producing a second doc for
 * the same sale in 35% of sampled September rows. Id construction now
 * goes through scripts/lib/chSoldCompId.cjs, the same shape
 * chRowToSoldComp.ts (TS, via recordSoldComp) and
 * bulk-import-ch-daily-to-sold-comps.cjs (via recordSoldComp) produce.
 *
 * CF-INSERT-ONLY-NOT-OVERWRITE (2026-09-20, review follow-up on the fix
 * above). Writing the CANONICAL id means this script's id can now be the
 * SAME id a canonical writer already created and a repair lane has since
 * edited in place (hobbyiqCardId re-points, rekeyedAt/rekeyedFrom,
 * splitResolved*, park stamps, flaggedWrong/excludedFromFmv/
 * verifiedByUser, grade fields). An `upsert` would silently overwrite
 * every one of those fields back to this script's stale view, every
 * morning. Switched to `items.create`, which REFUSES (409) instead of
 * overwriting when the id already exists — this lane creates rows and
 * never touches one it did not create. See findResidentTwin()'s own
 * comment for what is still NOT covered by this or the twin check.
 */

const path = require("path");
const { CosmosClient } = require("@azure/cosmos");
// CF-CH-INGEST-SLUG-AT-SOURCE (Drew, 2026-07-25). Import computeHobbyIqCardId
// so rows written from CH land with the canonical slug on first insert
// (instead of relying on the nightly cleanup pass to backfill).
const { computeHobbyIqCardId } = require(path.join(__dirname, "..", "dist/services/portfolioiq/hobbyIqCardId.service.js"));
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW (D18, 2026-08-29). Counters, disjoint:
//   intended = CH rows fetched and handed to the day loop (processed)
//   written  = items.create acknowledged (a genuinely NEW row)
//   skipped  = rows without a card_id / price / sale_date
//              (skipped-other), a twin already resident
//              (skipped-twin-resident), or the id already existed and
//              items.create 409'd (skipped-already-present)
//   failed   = create calls that threw for any other reason
// A day whose QUERY fails is logged and never counted as processed.
const { reportWrites } = require(path.join(__dirname, "..", "dist/services/ops/writeReconciliation.js"));
const { guardSoldCompDoc } = require(path.join(__dirname, "..", "dist/services/portfolioiq/splitIdentityWriteGuard.js"));
// CF-CH-DAILY-DOUBLE-WRITE (2026-09-20). Shared id shape with the other
// .cjs writer and (transitively, via recordSoldComp) chRowToSoldComp.ts —
// see that module's header for why a THIRD copy of this logic is a landmine.
const {
  canonicalSourceExternalId,
  canonicalDocId,
  syntheticSourceExternalId,
  isLongSyntheticShape,
} = require(path.join(__dirname, "lib", "chSoldCompId.cjs"));

// Prospect autograph cardNumber prefixes — per Drew's memory
// `isauto-boundary-is-cardnumber-not-text`, the cardNumber prefix IS
// the auto boundary. Text-based detection (r.variant or r.card_set
// containing "auto") misses cases where CH's card_set is generic
// "Bowman Baseball" for CPA-* autos.
const AUTO_CARD_NUMBER_PREFIX = /^(CPA|BCPA|BCA|BCRA|BSA|BSHA|CDA|BDPA|BFA|CPAP|CRA|TAA|USA|RA|GA)-/i;

function normalizeCardNumber(s) {
  return String(s ?? "").trim().replace(/^#+/, "").toUpperCase();
}

function parseArgs(argv) {
  // CF-BACKFILL-CH-GROUP (Drew, 2026-07-20). Added --ch-group so BB/FB
  // promotions can filter by CH's authoritative sport field
  // (c["group"] = 'Football' | 'Basketball') instead of the
  // card_set_contains substring filter — modern FB/BB sets like
  // "Panini Prizm" don't contain the sport word in card_set, so
  // card_set_contains missed them entirely on the first pass.
  const args = { concurrency: 4, apply: false, limit: Infinity, cardSetContains: null, sport: null, chGroup: null };
  for (const a of argv) {
    if (a.startsWith("--from=")) args.from = a.slice(7);
    else if (a.startsWith("--to=")) args.to = a.slice(5);
    else if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a.startsWith("--concurrency=")) args.concurrency = Math.min(32, Math.max(1, parseInt(a.slice(14), 10)));
    else if (a.startsWith("--limit=")) args.limit = parseInt(a.slice(8), 10);
    else if (a.startsWith("--card-set-contains=")) args.cardSetContains = a.slice(20).toLowerCase();
    else if (a.startsWith("--sport=")) args.sport = a.slice(8).toLowerCase();
    else if (a.startsWith("--ch-group=")) args.chGroup = a.slice(11);
  }
  return args;
}

/** Same sport-inference logic as soldCompsStore.inferSportFromContext,
 *  duplicated here so the backfill script has no TS import dependency. */
function inferSport(setName, title) {
  const text = `${setName ?? ""} ${title ?? ""}`.toLowerCase();
  if (!text.trim()) return null;
  if (text.includes("baseball")) return "baseball";
  if (text.includes("football") || text.includes("nfl")) return "football";
  if (text.includes("basketball") || text.includes("nba")) return "basketball";
  if (text.includes("hockey") || text.includes("nhl")) return "hockey";
  if (text.includes("soccer") || text.includes("mls") || text.includes("premier league")) return "soccer";
  // CF-POKEMON-INFER-SPORT (Drew, 2026-07-26). Duplicated from
  // soldCompsStore.inferSportFromContext — keep in sync.
  if (text.includes("pokemon") || text.includes("pokémon")) return "pokemon";
  if (/\bbowman\b/.test(text)) return "baseball";
  if (/\btopps\s+chrome\b/.test(text) && !text.includes("f1") && !text.includes("ufc")) return "baseball";
  return null;
}

function parseGrader(grader) {
  // ch_daily_sales stores grader as e.g. "Raw" | "PSA 10" | "BGS 9.5"
  const g = String(grader ?? "").trim();
  if (!g || g.toLowerCase() === "raw") return { gradeCompany: null, gradeValue: null };
  const m = g.match(/^([A-Z]+)\s+([0-9.]+)$/i);
  if (!m) return { gradeCompany: null, gradeValue: null };
  const value = Number(m[2]);
  return { gradeCompany: m[1].toUpperCase(), gradeValue: Number.isFinite(value) ? value : null };
}

/**
 * CF-CH-DAILY-DOUBLE-WRITE (2026-09-20). Single-partition existence check
 * for a resident twin of this exact sale (same cardId partition, same
 * soldAt + price, source cardhedge) — used two ways:
 *
 *   1. price_history_id missing on the row: any resident twin at all
 *      means don't fall back to the synthetic id (never write a twin).
 *   2. price_history_id present: only a LONG-shape (synthetic) resident
 *      twin matters — that's the shape a prior run of THIS script could
 *      have left before this fix. Skip re-adding a short-id row for a
 *      sale the long-shape row already covers; the sweep (owner-run,
 *      out of scope here) reconciles which one survives.
 *
 * Cheap and measured: SELECT c.id only, single partition, capped at a
 * few results, and the caller sums requestCharge into the day's
 * twinCheckRU for the banner.
 *
 * TWO KNOWN RESIDUAL GAPS, neither fixed here (review follow-up,
 * 2026-09-20):
 *
 *   (a) This check only runs from THIS script. bulk-import-ch-daily-to-
 *       sold-comps.cjs and chRowToSoldComp.ts (via recordSoldComp) do no
 *       equivalent twin check, so a twin can still be created from
 *       THEIR side until the owner-run sweep retires the existing
 *       synthetic-id rows.
 *   (b) This is a SAME-PARTITION check. If a sale was ever RELOCATED to
 *       a different cardId partition (a repair lane's move), this check
 *       is blind to it — the sale is invisible under its OLD address,
 *       so any CH writer (this one included, once items.create sees no
 *       id collision there) can re-create it at the old, now-wrong
 *       partition. Needs its own fix: either a lookup by
 *       sourceExternalId across partitions, or a relocation tombstone at
 *       the old address. Not attempted here.
 */
async function findResidentTwin(sc, cardId, soldAt, price, opts = {}) {
  if (!cardId) return { found: false, requestCharge: 0 };
  try {
    const iter = sc.items.query(
      {
        query: `SELECT TOP 5 c.id FROM c WHERE c.soldAt = @soldAt AND c.price = @price AND c.source = "cardhedge"`,
        parameters: [
          { name: "@soldAt", value: soldAt },
          { name: "@price", value: price },
        ],
      },
      { partitionKey: cardId },
    );
    const { resources, requestCharge } = await iter.fetchAll();
    const rc = Number(requestCharge) || 0;
    if (!opts.longShapeOnly) {
      return { found: resources.length > 0, requestCharge: rc };
    }
    const hasLongShape = resources.some((row) => isLongSyntheticShape(row.id, soldAt));
    return { found: hasLongShape, requestCharge: rc };
  } catch (err) {
    // A failed twin check must never crash the row — fail closed toward
    // "assume no twin" would risk writing one, so instead treat it like
    // any other row-level failure: count it, keep going.
    console.error(`  twin-check error for cardId=${cardId} soldAt=${soldAt}: ${err.message}`);
    return { found: false, requestCharge: 0, checkFailed: true };
  }
}

/**
 * CF-INSERT-ONLY-NOT-OVERWRITE (2026-09-20). One CH row, one outcome.
 * Extracted out of the day loop so the create-vs-409-vs-twin-skip
 * decision is directly testable against a fake sold_comps container,
 * without spinning up a real CosmosClient.
 *
 * `sc` is the sold_comps container. `args` needs only `.sport` and
 * `.apply` from parseArgs' shape. `day` is used only for log prefixes.
 *
 * Returns one of:
 *   { outcome: "written" }
 *   { outcome: "skipped-other", requestChargeRU: 0 }
 *   { outcome: "skipped-twin-resident", requestChargeRU }
 *   { outcome: "skipped-already-present", requestChargeRU }
 *   { outcome: "failed", requestChargeRU, error }
 */
async function processRow(sc, r, args, day) {
  if (!r.card_id || !(Number(r.price) > 0) || !r.sale_date) {
    return { outcome: "skipped-other", requestChargeRU: 0 };
  }
  let requestChargeRU = 0;
  // CF-BACKFILL-GRADE-FIELD-FIX (Drew, 2026-07-20). ch_daily_sales
  // stores grader as company-only ("BGS", "PSA") and the numeric
  // tier lives on c.grade ("BGS 9.5", "PSA 10", "BGS AUTH", "Raw").
  // Earlier code parsed r.grader → always returned null gradeValue
  // → every graded sale stored as raw. Read r.grade instead.
  const { gradeCompany, gradeValue } = parseGrader(r.grade ?? r.grader);

  // CF-CH-DAILY-DOUBLE-WRITE (2026-09-20). Prefer CH's true vendor
  // sale id (price_history_id) — that is what makes this script's
  // writes idempotent AGAINST recordSoldComp's writers (bulk-import
  // .cjs, chRowToSoldComp.ts) instead of landing as a second doc for
  // the same sale.
  let sourceExternalId = canonicalSourceExternalId(r.price_history_id);
  if (!sourceExternalId) {
    // No vendor id on this row (older ch_daily_sales rows, or a
    // narrowed SELECT elsewhere). Fall back to the legacy synthetic
    // shape, but ONLY after confirming no resident row already
    // covers this exact sale — never write a twin.
    const existing = await findResidentTwin(sc, r.card_id, r.sale_date, Number(r.price));
    requestChargeRU += existing.requestCharge;
    if (existing.found) return { outcome: "skipped-twin-resident", requestChargeRU };
    sourceExternalId = syntheticSourceExternalId(r.card_id, r.sale_date, r.price);
  } else {
    // Even with a canonical id, a LONG-shape (synthetic) twin of
    // this same sale may already be resident from a prior run of
    // this script before this fix. Don't add a second row for it —
    // the sweep (owner-run, out of scope here) reconciles those.
    const existing = await findResidentTwin(sc, r.card_id, r.sale_date, Number(r.price), { longShapeOnly: true });
    requestChargeRU += existing.requestCharge;
    if (existing.found) return { outcome: "skipped-twin-resident", requestChargeRU };
  }
  // CF-CH-CARD-SET-ALREADY-HAS-THE-YEAR (Drew, 2026-08-24: "lets fix the
  // double year while we can").
  //
  // CardHedge's card_set is already year-prefixed — "1954 Topps
  // Baseball", "2021 Topps Now Baseball" — every row sampled, no
  // exceptions. Prefixing r.year again produced
  //
  //     "1954 1954 Topps Baseball #133 Base"
  //
  // on 3,175,209 sold_comps rows, 20% of the pool, across 124 years.
  // Every matcher and parser that reads a title has been reading that.
  //
  // Prefix only when the set text does not already say it, so a source
  // that changes its mind later still yields a complete title.
  const chSet = String(r.card_set ?? "").trim();
  const chYear = String(r.year);
  const nextChar = chSet.charAt(chYear.length);
  const yearPrefixed = chSet.startsWith(chYear) && (nextChar < "0" || nextChar > "9");
  const title = `${yearPrefixed ? "" : `${r.year} `}${chSet} #${r.number} ${r.variant}`.trim().replace(/\s+/g, " ");
  const sport = args.sport ?? inferSport(r.card_set, title);

  // CF-CH-INGEST-SLUG-AT-SOURCE (Drew, 2026-07-25). Normalize cardNumber
  // + set isAuto from cardNumber prefix (auto-boundary rule) + compute
  // canonical hobbyiqCardId slug inline so no nightly cleanup pass is
  // required to make CH rows searchable/FMV-usable.
  const cardNumber = r.number ? normalizeCardNumber(r.number) : null;
  const isAutoFromCn = cardNumber && AUTO_CARD_NUMBER_PREFIX.test(cardNumber);
  const isAuto = !!(isAutoFromCn || /auto/i.test(r.variant ?? "") || /auto/i.test(r.card_set ?? ""));
  const cardYear = typeof r.year === "number" ? r.year : (Number.isFinite(Number(r.year)) ? Number(r.year) : null);
  let hobbyiqCardId = null;
  if (r.player && cardYear && cardNumber && r.card_set && sport) {
    try {
      hobbyiqCardId = computeHobbyIqCardId({
        sport,
        year: cardYear,
        setKey: r.card_set,
        cardNumber,
        parallel: r.variant || "Base",
        isAuto,
        printRun: null,
      });
    } catch { hobbyiqCardId = null; }
  }

  const doc = {
    id: canonicalDocId(sourceExternalId),
    cardId: r.card_id,
    hobbyiqCardId,
    playerName: r.player ?? "Unknown",
    cardYear,
    setName: r.card_set ?? null,
    parallel: r.variant ?? null,       // NATIVE parallel — the fix vs warmPoolFromCh pollution
    cardNumber,                         // normalized
    isAuto,
    sport,                              // sport tag for cross-sport filtering
    gradeCompany,
    gradeValue,
    price: Number(r.price),
    soldAt: r.sale_date,
    observedAt: new Date().toISOString(),
    source: "cardhedge",
    sourceExternalId,
    contributorUserId: null,
    title,
    imageUrl: r.image_url ?? null,
    sellerHandle: null,
    verifiedByUser: false,
    confidence: 0.8,
  };
  // CF-ONE-WRITE-PATH-FOR-SOLD-COMPS (2026-09-07). This lane mints whole
  // sale documents and writes them straight to the pool, so neither
  // #1929's split-identity guard nor #1939's malformed-key guard -- both
  // of which live in `recordSoldComp` -- has ever seen a row it wrote.
  // `cardId` here can be the VENDOR's id beside our own slug, which is the
  // designed 12.96M-row vendor partition and NOT a split; the guard fails
  // open on exactly that shape. What it does catch is an identity field
  // that is not a readable address -- the #1939 class, 8,102 rows.
  {
    const verdict = guardSoldCompDoc(doc, { guardedBy: "backfill-sold-comps-from-ch" });
    if (verdict.verdict === "park") {
      console.warn(JSON.stringify({
        event: "sold_comp_split_identity_parked",
        source: "backfill-sold-comps-from-ch",
        reason: verdict.reason,
        cardId: doc.cardId,
        hobbyiqCardId: doc.hobbyiqCardId,
        detail: verdict.detail,
      }));
    }
  }
  if (!args.apply) return { outcome: "written", requestChargeRU };
  try {
    // CF-INSERT-ONLY-NOT-OVERWRITE (2026-09-20, coordinator review of
    // #2357). Writing the CANONICAL id (this PR) means the id this
    // script writes can now be the SAME id a canonical writer already
    // created, and repair lanes edit that row in place (hobbyiqCardId
    // re-points, rekeyedAt/rekeyedFrom, splitResolved*, park stamps,
    // flaggedWrong/excludedFromFmv/verifiedByUser, grade fields). An
    // upsert here would silently clobber every one of those fields
    // back to this script's (stale, unrepaired) view every morning.
    // items.create refuses instead of overwriting when the id already
    // exists (409) — this lane NEVER updates a row it did not create.
    await sc.items.create(doc);
    return { outcome: "written", requestChargeRU };
  } catch (err) {
    if (err && err.code === 409) return { outcome: "skipped-already-present", requestChargeRU };
    return { outcome: "failed", requestChargeRU, error: err };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Default the window to "all-time from CH earliest to today" when not supplied
  if (!args.from) args.from = "2018-01-01";
  if (!args.to) args.to = new Date().toISOString().slice(0, 10);
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const ch = db.container(process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales");
  const sc = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");

  console.log(`Backfill window: ${args.from} → ${args.to}  apply=${args.apply}  concurrency=${args.concurrency}  limit=${args.limit}  cardSetContains=${args.cardSetContains ?? "(none)"}  chGroup=${args.chGroup ?? "(none)"}`);
  // CF-CH-DAILY-DOUBLE-WRITE (2026-09-20). This script writes straight to
  // the container (sc.items.create, insert-only as of this PR) rather
  // than through recordSoldComp(), so recordSoldComp's split-identity and
  // malformed-key guards never see these rows -- only guardSoldCompDoc's
  // own check runs (see #1941's comment in processRow()). Pre-existing,
  // out of scope here; PR body has the follow-up.
  console.log(`NOTE: this script bypasses recordSoldComp()'s own guards (direct sc.items.create; only guardSoldCompDoc runs). See PR follow-up.`);

  // Walk ch_daily_sales day-by-day so we get bounded result sets per
  // query. Cross-partition GROUP BY on 2M rows would stack-overflow
  // the SDK; per-day slices are ~15-20K rows each — manageable.
  const start = new Date(args.from + "T00:00:00Z");
  const end = new Date(args.to + "T23:59:59Z");
  const t0 = Date.now();
  let totalProcessed = 0;
  let totalWritten = 0;
  let totalSkipped = 0;
  let totalSkippedTwinResident = 0;
  let totalSkippedAlreadyPresent = 0;
  let totalSkippedOther = 0;
  let totalErrors = 0;
  let totalTwinCheckRU = 0;

  for (let day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const dayStart = day.toISOString().slice(0, 10) + "T00:00:00Z";
    const dayEnd = day.toISOString().slice(0, 10) + "T23:59:59Z";
    const rows = [];
    try {
      const parameters = [
        { name: "@from", value: dayStart },
        { name: "@to", value: dayEnd },
      ];
      let whereExtra = "";
      if (args.cardSetContains) {
        whereExtra += " AND CONTAINS(LOWER(c.card_set), @setToken)";
        parameters.push({ name: "@setToken", value: args.cardSetContains });
      }
      if (args.chGroup) {
        whereExtra += " AND c[\"group\"] = @chGroup";
        parameters.push({ name: "@chGroup", value: args.chGroup });
      }
      const iter = ch.items.query({
        query: `SELECT c.price_history_id, c.card_id, c.player, c.year, c.card_set, c.variant, c.number,
                       c.price, c.grader, c.grade, c.sale_date, c.image_url
                FROM c
                WHERE c.sale_date >= @from AND c.sale_date <= @to AND c.price > 0${whereExtra}`,
        parameters,
      });
      while (iter.hasMoreResults()) {
        const { resources } = await iter.fetchNext();
        rows.push(...resources);
        if (totalProcessed + rows.length >= args.limit) break;
      }
    } catch (err) {
      console.error(`  ${day.toISOString().slice(0, 10)}: query error ${err.message}`);
      continue;
    }

    if (rows.length === 0) {
      console.log(`  ${day.toISOString().slice(0, 10)}: 0 rows`);
      continue;
    }

    // Bounded-concurrency writes. Each write is idempotent via the
    // deterministic id, so re-runs are safe.
    let dayWritten = 0;
    let daySkipped = 0;
    let daySkippedTwinResident = 0;
    let daySkippedAlreadyPresent = 0;
    let daySkippedOther = 0;
    let dayErrors = 0;
    let dayTwinCheckRU = 0;

    const chunks = [];
    for (let i = 0; i < rows.length; i += args.concurrency) chunks.push(rows.slice(i, i + args.concurrency));

    for (const chunk of chunks) {
      await Promise.all(chunk.map(async (r) => {
        const result = await processRow(sc, r, args, day);
        dayTwinCheckRU += result.requestChargeRU ?? 0;
        switch (result.outcome) {
          case "written":
            dayWritten++;
            break;
          case "skipped-twin-resident":
            daySkipped++;
            daySkippedTwinResident++;
            break;
          case "skipped-already-present":
            daySkipped++;
            daySkippedAlreadyPresent++;
            break;
          case "skipped-other":
            daySkipped++;
            daySkippedOther++;
            break;
          case "failed":
            dayErrors++;
            if (dayErrors <= 3) console.error(`  ${day.toISOString().slice(0, 10)}: create error ${result.error && result.error.message}`);
            break;
          default:
            // Unreachable for a known outcome; treat as a hard failure
            // rather than silently dropping the row from every counter.
            dayErrors++;
        }
      }));
    }

    totalProcessed += rows.length;
    totalWritten += dayWritten;
    totalSkipped += daySkipped;
    totalSkippedTwinResident += daySkippedTwinResident;
    totalSkippedAlreadyPresent += daySkippedAlreadyPresent;
    totalSkippedOther += daySkippedOther;
    totalErrors += dayErrors;
    totalTwinCheckRU += dayTwinCheckRU;

    const elapsedSec = (Date.now() - t0) / 1000;
    const rate = totalProcessed / elapsedSec;
    console.log(`  ${day.toISOString().slice(0, 10)}: rows=${rows.length}  wrote=${dayWritten}  skip=${daySkipped} (twin-resident=${daySkippedTwinResident} already-present=${daySkippedAlreadyPresent} other=${daySkippedOther})  err=${dayErrors}  twinCheckRU=${dayTwinCheckRU.toFixed(1)}  (running total ${totalWritten.toLocaleString()} @ ${rate.toFixed(0)}/s)`);

    if (totalProcessed >= args.limit) {
      console.log(`Limit ${args.limit} reached, stopping.`);
      break;
    }
  }

  const elapsedMin = (Date.now() - t0) / 60_000;
  // Reconcile: read (processed) = written + skipped-twin-resident +
  // skipped-already-present + skipped-other + failed.
  const reconciled = totalWritten + totalSkippedTwinResident + totalSkippedAlreadyPresent + totalSkippedOther + totalErrors;
  console.log(`\nDONE. processed=${totalProcessed.toLocaleString()}  wrote=${totalWritten.toLocaleString()}  skipped=${totalSkipped.toLocaleString()} (twin-resident=${totalSkippedTwinResident.toLocaleString()} already-present=${totalSkippedAlreadyPresent.toLocaleString()} other=${totalSkippedOther.toLocaleString()})  errors=${totalErrors.toLocaleString()}  time=${elapsedMin.toFixed(1)}min`);
  console.log(`twin-check RU spent: ${totalTwinCheckRU.toFixed(1)}`);
  console.log(`reconcile: processed ${totalProcessed.toLocaleString()} ${reconciled === totalProcessed ? "==" : "!="} written+skipped-twin-resident+skipped-already-present+skipped-other+failed ${reconciled.toLocaleString()}`);
  console.log(`apply=${args.apply}${args.apply ? "" : " (dry-run — no writes)"}`);
  if (args.apply) reportWrites({ job: "backfill-sold-comps-from-ch", intended: totalProcessed, written: totalWritten, skipped: totalSkippedTwinResident + totalSkippedAlreadyPresent + totalSkippedOther, failed: totalErrors });
}

module.exports = {
  parseGrader,
  inferSport,
  normalizeCardNumber,
  findResidentTwin,
  processRow,
};

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
