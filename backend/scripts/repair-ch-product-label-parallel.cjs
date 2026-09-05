#!/usr/bin/env node
/**
 * repair-ch-product-label-parallel.cjs -- a CardHedge PRODUCT's label is not
 * the SALE's parallel.
 *
 * CF-THE-ENGINE-CONSUMES-CH-SALES-NOT-CH-PRODUCT-FIELDS, at the keying step.
 *
 * ── THE DAMAGE, MEASURED ────────────────────────────────────────────────────
 *
 * CardHedge labels product 1778540428361x447194681698603460 "Black & White Red
 * Ink". historicalBackfill fetched every SALE of that product and stamped the
 * PRODUCT's label onto each one, and the slug was then composed from the
 * stamped label. Live, measured 2026-09-04:
 *
 *   56 CardHedge sales on
 *      hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto
 *   titles: "2026 Bowman Victor Figueroa Chrome Auto ... #CPA-VF ... - Raw"
 *   not one says red ink / shimmer / B&W; two say BASE outright
 *   median $10, range $5-$19
 *
 * exactPoolReader ORs cardId and hobbyiqCardId, so those $10 base autos price
 * the same card as Drew's genuine $270 Red Ink purchase. The base pool they
 * belong to -- ...:cpa-vf:base:auto, checklist-backed, 119 rows -- sits at an
 * $11 median. One card, two readings, one pool.
 *
 * ── WHY THE REMATCH CANNOT DO THIS ──────────────────────────────────────────
 *
 * The rematch derives all 56 to the base slug and lands CONFLICT /
 * writable:false. Base-eviction guard 2 (stored-parallel-names-a-finish) is
 * DOING ITS JOB -- the stored parallel field says "Black & White Red Ink",
 * which is a finish, and defending a populated stored parallel is exactly what
 * that guard is for. GUARD 2 IS NOT LOOSENED HERE and must not be. This lane
 * adds a strictly NARROWER predicate that guard 2 has no way to see: the
 * stored parallel is not anyone's reading of this sale, it is the vendor
 * PRODUCT's label, copied onto every sale of that product by a writer that
 * never read the title.
 *
 * ── THE ROOT IS ALREADY CLOSED; THIS IS THE STORED HALF ─────────────────────
 *
 * historicalBackfill.service.ts learned `parallelForVendorSale` in 797376b
 * (2026-09-04 19:29 EDT) and chRowToSoldComp.ts learned the same rule on the
 * CH-daily path before it. Every one of the 56 rows was written at or before
 * 2026-09-04T16:58Z -- six and a half hours BEFORE that commit existed -- and
 * prod deployed it at 2026-09-05T00:04Z. Run today's `parallelTheTitleAllows`
 * over the 56 titles and it returns Base with `vendorTagOverruled: "Black &
 * White Red Ink"` for every one. A fixed writer cannot repair a row already
 * written; that is the whole of this lane's job, and it is why the lane is a
 * one-off repair rather than a guard.
 *
 * ── SCOPE IS REQUIRED, AND IS A LIST OF PRODUCT IDS ─────────────────────────
 *
 * A whole-scope write must be asked for by name (CF-A-WHOLE-SOURCE-RETIRE-
 * NEEDS-ITS-NAME). This lane REFUSES to run with no scope, in report mode as
 * well as apply -- a report over an unnamed scope is how an apply over an
 * unnamed scope gets authorised. The scope is carried on the runner's existing
 * `scope` input as a comma-separated list of CardHedge product ids; the
 * inherited default "refractor" is REFUSED (exit 2) rather than treated as
 * "everything", for the same reason rematch-sold-comps refuses it.
 *
 *   scope=1778540428361x447194681698603460
 *
 * ── THE FIVE ASSERTIONS ─────────────────────────────────────────────────────
 *
 * Per row, ALL of these must hold, and they live in lib/ch-product-label.cjs
 * so the tests pin the code that runs:
 *
 *   1. source is `cardhedge`
 *   2. the row's CH product id is in the dispatched scope. The product id is
 *      the first segment of the composite key the backfill mints -- there is
 *      no field for it (`vendorCardId` is null on every one of these rows).
 *      `ch-daily::` rows carry no product id and are out of scope by
 *      construction.
 *   3. the stored parallel FIELD slugs to what the stored SLUG's parallel
 *      segment says: the row is wearing one coherent label, not merely
 *      mis-slugged.
 *   4. the title carries NO witness for that parallel -- neither spelling of
 *      the claim echoes in it, AND it names no other finish either. A title
 *      saying "Red Ink" is SKIPPED. So is one saying "B&W Shimmer", which by
 *      Drew's 2026-08-30 ruling is the same card by its other name.
 *   5. the derived destination is CHECKLIST-BACKED and differs from the
 *      stored slug. A row is never moved onto a slug the checklist does not
 *      list.
 *
 * ── THE WRITE ───────────────────────────────────────────────────────────────
 *
 * REPORT ONLY unless BACKFILL_APPLY=true (the runner exports BACKFILL_APPLY,
 * not APPLY). The write shape mirrors repair-tiffany-pool-enumeration exactly:
 * relocateSoldComp (upsert the keeper, read it back, THEN delete the old row --
 * CF-A-SALE-IS-NEVER-LOST), verify-by-read on BOTH cardId and hobbyiqCardId,
 * the rekeyedFrom/At/Reason ledger on every moved row, canary anchors captured
 * before and re-read after, and `intended = written + skipped + failed`
 * through reportWrites.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   SCOPE                     REQUIRED -- comma-separated CH product ids
 *   BACKFILL_APPLY=true       actually write. Default: REPORT ONLY.
 *   YEARS / SPORTS            optional extra narrowing
 *   LIMIT / SLOT / SLOTS / SHARD / CONCURRENCY / RUN_MINUTES
 */
"use strict";

const path = require("path");
const crypto = require("crypto");

const backend = path.resolve(__dirname, "..");
const L = require(path.join(__dirname, "lib", "ch-product-label.cjs"));
const K = require(path.join(__dirname, "lib", "rematch-classify.cjs"));
const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const str = (v) => String(v ?? "").trim();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const YEARS = csv(process.env.YEARS || process.env.YEAR).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const SPORTS = csv(process.env.SPORTS || process.env.SPORT).map((s) => s.toLowerCase());
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 16));
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);
const STARTED = Date.now();

const REASON = "ch-product-label-is-not-the-sale-parallel";
const REASON_LONG = "the CardHedge PRODUCT's label was stamped on a SALE whose title never said it (CF-THE-ENGINE-CONSUMES-CH-SALES-NOT-CH-PRODUCT-FIELDS)";

// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (2026-09-04). The runner exports
// slot=0 slots=16 as workflow-wide DEFAULTS, so the environment alone cannot
// distinguish "I chose slot 0 of 16" from "I chose nothing". Sharding is
// OPT-IN: a non-zero slot, or SHARD=true for slot 0 of a real fan-out.
// Anything else sweeps EVERY row in scope. An under-sweep that reconciles
// honestly is the worst failure mode available.
const rawSlot = str(process.env.SLOT);
const rawSlots = str(process.env.SLOTS);
const SLOT = Number(rawSlot || 0);
const SLOTS_REQUESTED = Math.max(1, Number(rawSlots || 1));
const SHARD_OPT_IN = /^(1|true|yes)$/i.test(str(process.env.SHARD));
const SHARDED = SLOTS_REQUESTED > 1 && Number.isFinite(SLOT) && (SLOT > 0 || SHARD_OPT_IN);
const SLOTS = SHARDED ? SLOTS_REQUESTED : 1;
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;
const mineByShard = (key) => !SHARDED || shardOf(str(key)) === SLOT;

// THE SCOPE. `refractor` is the runner's inherited default and is REFUSED, not
// obeyed: an apply names what it writes.
const RAW_SCOPE = csv(process.env.SCOPE);
const SCOPE_PRODUCTS = new Set(RAW_SCOPE.filter((s) => /^\d+x\d+$/.test(s)));
const SCOPE_REJECTED = RAW_SCOPE.filter((s) => !/^\d+x\d+$/.test(s));

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};

async function forEachPage(container, spec, onPage, pageSize = 400) {
  let token;
  do {
    const page = await retry(() => container.items
      .query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

/** Every row on either key. The pool reader ORs both, so a verification that
 *  reads one key is not a verification. */
async function poolRowsFor(pool, slug) {
  const out = [];
  await forEachPage(pool, {
    query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.price, c.parallel FROM c WHERE (c.cardId = @d OR c.hobbyiqCardId = @d)",
    parameters: [{ name: "@d", value: slug }],
  }, async (page) => { out.push(...page); return out.length < 5000; }, 1000);
  return out;
}

/**
 * THE DESTINATION: the same identity with the parallel dropped to base.
 *
 * A SEGMENT REWRITE of the stored slug, never a re-derivation from the title.
 * The stored slug's other axes -- sport, year, setKey, cardNumber, auto flag,
 * grade -- are not what this lane disputes, and a re-derivation would drag any
 * other parser disagreement along with the repair. Surgery, never a recompute
 * (the discipline D28 states). A row whose OTHER axes are also wrong is the
 * rematch's business, not this lane's.
 */
function baseDestinationOf(slug) {
  const parts = str(slug).split(":");
  if (parts[0] !== "hiq" || parts.length < 7) return null;
  const out = parts.slice();
  out[5] = "base";
  // The print run belonged to the parallel that carried it; a base auto is
  // not numbered.
  const tail = out.slice(7).filter((seg) => !/^num-\d+$/.test(seg));
  return out.slice(0, 7).concat(tail).join(":");
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  REPAIR: the CardHedge PRODUCT label became the SALE parallel");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  // THE SCOPE REFUSAL, BEFORE ANYTHING IS READ. A whole-scope write must be
  // asked for by name, and a report over an unnamed scope is how an apply over
  // an unnamed scope gets authorised -- so both modes refuse.
  if (SCOPE_REJECTED.length) {
    console.error("");
    console.error(`FATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are not CardHedge product ids: ${SCOPE_REJECTED.join(", ")}`);
    console.error("       A CH product id looks like 1778540428361x447194681698603460.");
    console.error("       'refractor' is the runner's INHERITED default and is refused, never treated as 'all'.");
    process.exit(2);
  }
  if (SCOPE_PRODUCTS.size === 0) {
    console.error("");
    console.error("FATAL: SCOPE is REQUIRED and names the CardHedge product ids to repair.");
    console.error("       There is no 'all' for this lane, in either mode.");
    console.error("       Dispatch with -f scope=1778540428361x447194681698603460 (comma-separate for several).");
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(2); }

  console.log(`  scope (CH products)  ${[...SCOPE_PRODUCTS].join(", ")}`);
  console.log(`  sports               ${SPORTS.length ? SPORTS.join(",") : "(every sport)"}`);
  console.log(`  years                ${YEARS.length ? YEARS.join(",") : "(every year)"}`);
  console.log(`  shard                ${SHARDED ? `slot ${SLOT}/${SLOTS} (opt-in)` : "ALL ROWS (no shard opted in)"}`);
  console.log(`  budget               ${Math.round(RUN_MS / 60000)} min`);
  console.log(`  limit                ${LIMIT ? f(LIMIT) + " rekeys" : "(none)"}`);
  console.log("");

  const { CosmosClient } = require("@azure/cosmos");
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const client = new CosmosClient(conn);
  const db = client.database("hobbyiq");
  const pool = db.container("sold_comps");
  const catalog = db.container("card_catalog");

  const backedCache = new Map();
  async function checklistBacked(slug) {
    const s = str(slug);
    if (!s) return false;
    if (backedCache.has(s)) return backedCache.get(s);
    let row = null;
    try { row = (await retry(() => catalog.item(s, s).read())).resource ?? null; }
    catch (e) { if (e?.code !== 404 && e?.statusCode !== 404) throw e; }
    const named = [row?.source, row?.sourceSystem, ...(Array.isArray(row?.sources) ? row.sources : [])];
    const backed = !!row && (named.some((x) => K.isStrictChecklistSource(x)) || row.checklistBacked === true);
    backedCache.set(s, backed);
    return backed;
  }

  // ── THE CANARY ANCHORS, BEFORE ────────────────────────────────────────────
  // Every distinct (stored slug, destination) pair this scope touches, counted
  // on BOTH keys before the run. A shard's own banner cannot certify the shard
  // (CF-GREEN-WORKFLOW-IS-NOT-DATA-FLOW), so the pools are measured
  // independently of what the loop believes it did.
  const anchors = new Map();
  async function anchor(slug) {
    if (!slug || anchors.has(slug)) return;
    const rows = await poolRowsFor(pool, slug);
    anchors.set(slug, { before: rows.length, after: null });
  }

  const s = {
    scanned: 0, otherSlot: 0, rekeyed: 0, created: 0, deleted: 0, collapsed: 0,
    failed: 0, duplicatesLeft: 0, outOfScope: 0,
  };
  const skips = new Map();
  const bumpSkip = (k) => skips.set(k, (skips.get(k) ?? 0) + 1);
  const moved = [];
  let stopReason = null;

  // The read is narrowed to the writer in question: only historicalBackfill
  // mints a key whose first segment is the CH product id. Without this the
  // scan walks every CardHedge row in the year (594k for one 2026 scope) to
  // classify a few hundred.
  const where = [
    "c.source = 'cardhedge'",
    "NOT STARTSWITH(c.sourceExternalId, 'ch-daily::')",
    "NOT STARTSWITH(c.sourceExternalId, 'ch-fill')",
  ];
  const parameters = [];
  if (YEARS.length) { where.push(`c.cardYear IN (${YEARS.map((_, i) => `@y${i}`).join(",")})`); YEARS.forEach((y, i) => parameters.push({ name: `@y${i}`, value: y })); }
  if (SPORTS.length) { where.push(`c.sport IN (${SPORTS.map((_, i) => `@s${i}`).join(",")})`); SPORTS.forEach((x, i) => parameters.push({ name: `@s${i}`, value: x })); }

  async function handle(row) {
    const storedSlug = str(row.hobbyiqCardId || row.cardId);
    const dest = baseDestinationOf(storedSlug);
    const backed = dest ? await checklistBacked(dest) : false;

    const v = L.chProductLabelVerdict(row, {
      productIds: SCOPE_PRODUCTS, derivedSlug: dest, derivedBacked: backed,
    });
    if (!v.rekeyable) {
      bumpSkip(v.failed ?? "unknown");
      if ((skips.get(v.failed ?? "unknown") ?? 0) <= 3) {
        console.log(`    SKIP ${v.failed}  ${str(row.id).slice(0, 60)}`);
        console.log(`         title: ${str(row.title).slice(0, 86)}`);
        if (v.witness) console.log(`         witness: ${v.witness}`);
      }
      return;
    }

    await anchor(storedSlug);
    await anchor(dest);

    const keep = stripSystem(row);
    const oldPk = str(row.cardId);
    // The old partition key is the CH PRODUCT ID on these rows, not a slug --
    // keep it on the row so the provenance of the move is legible later.
    if (oldPk && !oldPk.startsWith("hiq:")) keep.vendorCardIdWas = oldPk;
    keep.cardId = dest;
    keep.hobbyiqCardId = dest;
    keep.parallel = "";
    keep.parallelSlug = "";
    keep.parallelBefore = str(row.parallel);
    keep.rekeyedFrom = storedSlug;
    keep.rekeyedAt = new Date().toISOString();
    keep.rekeyedReason = REASON;
    // The evidence travels WITH the row: the verdict alone is not the record.
    keep.rekeyedEvidence = {
      chProductId: v.productId,
      productLabel: str(row.parallel),
      titleQuoted: str(row.title).slice(0, 160),
      titleWitness: null,
      rule: REASON_LONG,
    };
    keep.contentHash = contentHashOf(keep);

    if (moved.length < 12) {
      moved.push(`    REKEY  ${storedSlug.slice(0, 68)}\n           -> ${dest.slice(0, 68)}\n           $${row.price}  ${str(row.title).slice(0, 78)}`);
    }

    const res = await relocateSoldComp(pool, {
      keep,
      drop: [{ id: row.id, cardId: row.cardId }],
      retry,
      // BOTH keys are verified, because the pool reader ORs both. A
      // verification that reads one of them is not a verification.
      verifyFields: ["cardId", "hobbyiqCardId", "parallel", "contentHash", "rekeyedFrom"],
      dryRun: !APPLY,
    });
    if (!res.ok && res.stage !== "done") {
      s.failed++;
      console.log(`  FAILED at ${res.stage}: ${row.id} -> ${dest}: ${String(res.error).slice(0, 110)}`);
      return;
    }
    if (res.duplicatesLeft.length) {
      s.failed++; s.duplicatesLeft += res.duplicatesLeft.length;
      for (const d of res.duplicatesLeft) console.log(`  DUPLICATE LEFT ${d.id}@${d.cardId}: ${String(d.error).slice(0, 80)}`);
      return;
    }
    if (!APPLY) { s.created += 1; s.deleted += 1; }
    else {
      s.created += res.existedBefore ? 0 : 1;
      s.deleted += res.deleted.length;
      if (res.existedBefore) s.collapsed++;
    }
    s.rekeyed++;
  }

  await forEachPage(pool, { query: `SELECT * FROM c WHERE ${where.join(" AND ")}`, parameters }, async (rows) => {
    // The product-id scope is applied BEFORE the shard, so a shard slices the
    // rows this lane would actually touch rather than the whole CH corpus.
    const inScope = rows.filter((r) => {
      const pid = L.chProductIdOf(r);
      if (!pid || !SCOPE_PRODUCTS.has(pid)) { s.outOfScope++; return false; }
      if (!mineByShard(r.id)) { s.otherSlot++; return false; }
      return true;
    });
    for (let i = 0; i < inScope.length; i += CONCURRENCY) {
      const batch = inScope.slice(i, i + CONCURRENCY);
      s.scanned += batch.length;
      await Promise.all(batch.map((r) => handle(r).catch((e) => {
        s.failed++;
        if (s.failed <= 5) console.log(`  FAILED ${str(r.id).slice(0, 64)}: ${String(e?.message ?? e).slice(0, 110)}`);
      })));
      if (LIMIT && s.rekeyed >= LIMIT) { stopReason = "limit"; break; }
      if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; break; }
    }
    return !stopReason;
  });

  if (moved.length) {
    console.log("");
    console.log(`  ${APPLY ? "MOVED" : "WOULD MOVE"} (first ${moved.length}):`);
    for (const m of moved) console.log(m);
  }

  console.log("");
  console.log("-".repeat(78));
  console.log(`  ${APPLY ? "APPLIED" : "REPORT ONLY -- nothing was written"}`);
  console.log(`  rows in scope (this slot)  ${f(s.scanned)}   (+${f(s.otherSlot)} other slots, ${f(s.outOfScope)} other products)`);
  console.log(`  REKEYED onto the base pool ${f(s.rekeyed)}   <- cardId AND hobbyiqCardId, verified by read`);
  console.log(`  new rows created           ${f(s.created)}`);
  console.log(`  old rows deleted           ${f(s.deleted)}`);
  console.log(`  collapsed onto an existing ${f(s.collapsed)}`);
  console.log(`  duplicates LEFT in pool    ${f(s.duplicatesLeft)}`);
  console.log(`  failed                     ${f(s.failed)}`);
  const skipped = [...skips.values()].reduce((a, b) => a + b, 0);
  console.log(`  SKIPPED (reported, never written) ${f(skipped)}`);
  for (const [k, n] of [...skips].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(f(n)).padStart(6)}  ${k}`);
  }

  // ── THE CANARY ANCHORS, AFTER ─────────────────────────────────────────────
  console.log("");
  console.log("  CANARY ANCHORS (counted on BOTH cardId and hobbyiqCardId)");
  let canaryBad = 0;
  for (const [slug, a] of anchors) {
    a.after = (await poolRowsFor(pool, slug)).length;
    const delta = a.after - a.before;
    console.log(`    ${String(a.before).padStart(6)} -> ${String(a.after).padStart(6)}  (${delta >= 0 ? "+" : ""}${delta})  ${slug}`);
    // In REPORT mode nothing may move at all. That is the assertion the
    // market-index incident rule exists for: a dry run is proven write-free by
    // measurement, not by intent.
    if (!APPLY && delta !== 0) {
      console.log(`      ::error:: a REPORT-ONLY run changed this pool by ${delta} -- this is the defect the lane exists to avoid`);
      canaryBad++;
    }
  }
  if (!APPLY && canaryBad) {
    console.error("");
    console.error(`FATAL: ${canaryBad} pool(s) moved during a REPORT-ONLY run.`);
    process.exit(3);
  }

  console.log("");
  console.log(`  reconciled: intended ${f(s.scanned)} = written ${f(s.rekeyed)} + skipped ${f(skipped)}${s.failed ? ` + failed ${f(s.failed)}` : ""}`);
  if (APPLY) reportWrites({ job: "repair-ch-product-label-parallel", intended: s.scanned, written: s.rekeyed, skipped, failed: s.failed });

  console.log("");
  if (stopReason === "budget") {
    console.log("  stopped at the 140-minute budget — the relaunch continues from here");
  } else if (stopReason === "limit") {
    console.log(`  stopped at LIMIT=${f(LIMIT)} rekeys (a bounded probe, NOT a budget stop — no relaunch)`);
  } else {
    console.log("  scan complete — every row in scope was classified.");
  }
  console.log("");
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL", e?.stack ?? e); 
    await finishLane(1);
  });
