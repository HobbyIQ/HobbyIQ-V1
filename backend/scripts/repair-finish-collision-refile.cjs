#!/usr/bin/env node
/**
 * repair-finish-collision-refile.cjs -- the TITLE's finish wins when the
 * checklist backs it.
 *
 * CF-FINISH-FAMILY-COLLISION (Drew's ruling, 2026-09-05), the WRITE half of
 * #1790.
 *
 * ── WHAT #1790 DID, AND WHY IT LEFT THE ROWS WHERE THEY WERE ────────────────
 *
 * #1790 widened `finishFamilyCollision` in lib/rematch-classify.cjs so the
 * census could SEE this shape at all: the predicate read the row's `hiq:`
 * address off `cardId` alone, and on a CardHedge row `cardId` is the vendor's
 * bubble id -- 59% of a 5,000-row 2015+ sample. Flagged rows went 394 -> 922
 * and the fleet verdict on every one of them stayed the same, because the
 * subclass is REPORT-ONLY inside the rematch and permanently so:
 *
 *   - `finishFamilyCollision` sets a TAG and a COUNT, never `writable`.
 *   - SPECIALIZATION-STATED moves `setKey` only, and its L4 leg REFUSES any
 *     row whose `parallel` axis moves. It cannot express a parallel change
 *     within one product.
 *
 * So the population is named and nothing moves it. This lane moves it, over a
 * NAMED SCOPE, with the CHECKLIST -- not a heuristic -- deciding.
 *
 * ── THE RULING THIS LANE EXECUTES ───────────────────────────────────────────
 *
 * A sold_comps row whose TITLE names a finish/parallel the stored slug lacks
 * ("Gold Shimmer /50" stored as `gold-refractor`) is a sale of the card the
 * TITLE names -- TITLE WINS -- when the title-stated identity is CHECKLIST-
 * BACKED and the stored row is not user-verified / ruled.
 *
 * The five assertions live in lib/finish-collision-refile.cjs so the tests pin
 * the code that runs. ALL of them must hold; each failure is a SKIP with its
 * reason named in the report, and there is no silent skip:
 *
 *   A1  the CLASSIFIER flagged it -- `K.finishFamilyCollision` returns
 *       qualifies:true. The same function the census runs, not a second title
 *       reader here.
 *   A2  ONLY the `parallel` and `num-` segments move. sport / year / setKey /
 *       subset / cardNumber / auto flag byte-identical, or SKIP.
 *   A3  the destination is CHECKLIST-BACKED -- the corpus lists the parallel
 *       name AND the catalog carries the destination slug from a strict
 *       checklist source, read cardYear-aware (#1769).
 *   A4  the stored row is AUTO tier -- not user-verified, not
 *       ebay-user-purchase, not ruled. PROTECTED is report-only forever.
 *   A5  the title's finish word does not name TWO card families at this number
 *       (an insert set beside a parallel). Ambiguous is a SKIP; unanswerable is
 *       ambiguous, because absent beats wrong.
 *
 * ── THE SCOPE AXIS: A PRODUCT LIST ──────────────────────────────────────────
 *
 * CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME. Of the two axes the ruling offered
 * -- a (sport, year, setKey) product list, or a finish family -- this lane
 * takes the PRODUCT LIST, and the reason is that only the product axis lets a
 * whole-scope write NAME ITS RULING.
 *
 * A finish family is a word ("shimmer"), and a word spans every product that
 * ever printed it: a `scope=shimmer` dispatch would be a write over a
 * population nobody enumerated, with the checklist-backed gate as its only
 * bound. The product axis is enumerable before the run -- `2026:bowman-chrome`
 * names 56 listed parallels and a countable pool -- so the BEFORE/AFTER pool
 * counts are index-served, the canary anchors are knowable, and the dispatcher
 * can read what they are authorising. The family is still reported per bucket
 * inside the run; it is just not what the write is scoped by.
 *
 *   scope=baseball:2026:bowman-chrome
 *   scope=baseball:2025:topps-chrome,baseball:2024:topps-chrome
 *
 * There is no 'all', in EITHER mode -- a report over an unnamed scope is how an
 * apply over an unnamed scope gets authorised. The runner's inherited default
 * `refractor` is REFUSED (exit 2), as is `all` and an empty scope.
 *
 * ── THE WRITE ───────────────────────────────────────────────────────────────
 *
 * REPORT ONLY unless BACKFILL_APPLY=true (the runner exports BACKFILL_APPLY,
 * not APPLY). relocateSoldComp: upsert the keeper, read it back, THEN delete
 * the old row -- CF-A-SALE-IS-NEVER-LOST. Both identity fields land at the
 * destination because the exact-pool reader ORs them, and a verification that
 * reads one of them is not a verification. The rekeyedFrom / rekeyedAt /
 * rekeyedReason ledger carries the QUOTED TITLE as evidence, so the move is
 * legible from the row alone months later. Canary anchors are counted before
 * and re-read after, and a REPORT-mode run that moved a pool exits 3 -- a dry
 * run is proven write-free by MEASUREMENT, not by intent.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   SCOPE                     REQUIRED -- comma-separated sport:year:setKey
 *   BACKFILL_APPLY=true       actually write. Default: REPORT ONLY.
 *   LIMIT / SLOT / SLOTS / SHARD / CONCURRENCY / RUN_MINUTES
 * Requires dist/ (hobbyIqCardId, writeReconciliation).
 */
"use strict";

const path = require("path");

const backend = path.resolve(__dirname, "..");
const F = require(path.join(__dirname, "lib", "finish-collision-refile.cjs"));
const K = require(path.join(__dirname, "lib", "rematch-classify.cjs"));
const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));
const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));

const V = K.VOCAB;

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 16));
const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const LIMIT = Number(process.env.LIMIT || 0);
const STARTED = Date.now();

// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1765). Sharding is OPT-IN; the
// runner exports slot=0 slots=16 as workflow-wide DEFAULTS and the environment
// alone cannot tell "I chose slot 0" from "I chose nothing". An under-sweep
// that reconciles honestly is the worst failure mode available.
const SHARD_SCOPE = runnerShardScope({ label: "repair-finish-collision-refile" });

// THE SCOPE. `sport:year:setKey`, and the inherited `refractor` is REFUSED.
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const PRODUCT_RE = /^[a-z0-9-]+:\d{4}:[a-z0-9-]+$/;
const SCOPE_PRODUCTS = RAW_SCOPE.map(lower).filter((p) => PRODUCT_RE.test(p));
const SCOPE_REJECTED = RAW_SCOPE.filter((p) => !PRODUCT_RE.test(lower(p)));

/** sha1 shard of a row's own id, used only when sharding is opted into. The
 *  row id and never the partition key: a vendor bubble id can be shared by
 *  thousands of rows, and sharding on it piles them into one slot. */
function shardIndex(id) {
  const crypto = require("crypto");
  return parseInt(crypto.createHash("sha1").update(String(id ?? "")).digest("hex").slice(0, 8), 16)
    % Math.max(1, SHARD_SCOPE.SLOTS);
}

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

/** Every row on either key. The pool reader ORs both fields, so a count that
 *  reads one of them is not a count of the pool. */
async function poolRowsFor(pool, slug) {
  const out = [];
  await forEachPage(pool, {
    query: "SELECT c.id, c.cardId, c.hobbyiqCardId FROM c WHERE (c.cardId = @d OR c.hobbyiqCardId = @d)",
    parameters: [{ name: "@d", value: slug }],
  }, async (page) => { out.push(...page); return out.length < 5000; }, 1000);
  return out;
}

/** The row's identity as the classifier reads it -- the same shape
 *  rematch-sold-comps' `storedIdentity` builds, so the two cannot disagree
 *  about what the row says. `normalizeSetKey` is the live one. */
function storedIdentity(row, normalizeSetKey) {
  return {
    sport: row.sport ?? null,
    cardYear: row.cardYear ?? null,
    setKey: row.setName ? normalizeSetKey(String(row.setName)) : "",
    cardNumber: row.cardNumber ?? null,
    parallel: row.parallel ?? null,
    isAuto: row.isAuto === true,
    printRun: row.printRun ?? null,
    gradeCompany: row.gradeCompany ?? null,
    gradeValue: row.gradeValue ?? null,
  };
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  REPAIR: finish-collision refile — the title's finish wins when the checklist backs it");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  // THE SCOPE REFUSAL, BEFORE ANYTHING IS READ, IN BOTH MODES.
  if (SCOPE_REJECTED.length) {
    console.error("");
    console.error(`FATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are not products: ${SCOPE_REJECTED.join(", ")}`);
    console.error("       A product looks like baseball:2026:bowman-chrome (sport:year:setKey).");
    console.error("       'refractor' is the runner's INHERITED default and is refused, never treated as 'all'.");
    process.exit(2);
  }
  if (!SCOPE_PRODUCTS.length || RAW_SCOPE.some((s) => INHERITED_SCOPES.has(lower(s)))) {
    console.error("");
    console.error("FATAL: SCOPE is REQUIRED and names the products to refile, as sport:year:setKey.");
    console.error("       There is no 'all' for this lane, in either mode -- a report over an unnamed");
    console.error("       scope is how an apply over an unnamed scope gets authorised.");
    console.error("       Dispatch with -f scope=baseball:2026:bowman-chrome (comma-separate for several).");
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(2); }

  const { CosmosClient } = require("@azure/cosmos");
  const hic = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { normalizeSetKey, computeHobbyIqCardId } = hic;

  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
  const pool = db.container("sold_comps");
  const cat = db.container("card_catalog");

  console.log(`  ruling               ${F.REASON_LONG}`);
  console.log(`  scope axis           PRODUCT LIST (sport:year:setKey) -- a family word spans every product that ever printed it`);
  console.log(`  scope (${SCOPE_PRODUCTS.length} product${SCOPE_PRODUCTS.length === 1 ? "" : "s"})    ${SCOPE_PRODUCTS.join(", ")}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  concurrency          ${CONCURRENCY}   budget ${Math.round(RUN_MS / 60000)}m${LIMIT ? `   LIMIT=${f(LIMIT)}` : ""}`);
  console.log("");

  // ── the catalog reads, cached ─────────────────────────────────────────────
  //
  // CF-THE-SLUG'S-YEAR-IS-THE-IDENTITY-YEAR + CF-CARDYEAR-ABSENT-HIDES-
  // CHECKLISTS (#1769). `cardYear` is a MIRROR of `year`, not the identity, and
  // the ingest lane behind every sportscardchecklist row wrote `year` alone --
  // so a gate reading `cardYear` only was blind to the strictest checklists we
  // own. Both names are read; an OR of two equality predicates is still
  // index-served on both terms.
  const yearMatch = (a) => `(${a}.cardYear = @y OR ${a}.year = @y)`;

  const backedCache = new Map();
  /** A3b. The DESTINATION slug must carry a catalog row from a STRICT
   *  checklist source. `checklistBacked: true` with no named source is not
   *  strict backing: that flag says someone believed it, not who measured it. */
  async function destinationBacked(slug) {
    const s = str(slug);
    if (!s) return false;
    if (backedCache.has(s)) return backedCache.get(s);
    let row = null;
    try { row = (await retry(() => cat.item(s, s).read())).resource ?? null; }
    catch (e) { if (e?.code !== 404 && e?.statusCode !== 404) throw e; }
    const named = [row?.source, row?.sourceSystem, ...(Array.isArray(row?.sources) ? row.sources : [])];
    const backed = !!row && named.some((x) => K.isStrictChecklistSource(x));
    backedCache.set(s, backed);
    return backed;
  }

  /** A5. The product's SUBSETTED checklist rows, grouped by cardNumber, plus
   *  whether the product has any strictly-sourced rows at all.
   *
   *  ONE PAIR OF QUERIES PER (year, setKey), cached. A per-row catalog query
   *  over a pool this size is not a census, it is an outage
   *  (CF-FLEET-SCRIPTS-MEASURE-THROUGHPUT-BEFORE-DISPATCH), and so is reading
   *  every row of the product to group it: measured on 2025 topps-chrome
   *  2026-09-05, the unfiltered read is 415,625 rows / 14,666 RU / 23s while
   *  the `subsetName > ''` range predicate that answers the same question is
   *  10,123 rows / 628 RU / 3s. A range predicate on subsetName is index-served
   *  where IS_DEFINED is a scan, and blank is unknown and can neither create
   *  nor join a clash, so excluding it here is the RULE and not an
   *  optimisation.
   *
   *  `hasStrict` false means A5 cannot be asked at all, and the plan treats
   *  that as a refusal -- absent beats wrong. */
  const subsetCache = new Map();
  async function subsetFacts(year, setKey) {
    const key = `${year}|${setKey}`;
    if (subsetCache.has(key)) return subsetCache.get(key);
    let out = { byNumber: new Map(), hasStrict: false };
    try {
      const { resources } = await retry(() => cat.items.query({
        query: `SELECT c.cardNumber, c.subsetName, c.source FROM c WHERE c.setKey = @sk AND ${yearMatch("c")} AND c.subsetName > ''`,
        parameters: [{ name: "@sk", value: setKey }, { name: "@y", value: Number(year) }],
      }, { maxItemCount: -1 }).fetchAll());
      for (const r of resources ?? []) {
        // ONLY A STRICT CHECKLIST SOURCE MAY ANSWER. A vendor row's subsetName
        // comes from the same kind of title parse this lane exists to repair;
        // citing one would be citing the defect as its own cure.
        if (!K.isStrictChecklistSource(r?.source)) continue;
        const num = String(r?.cardNumber ?? "").toUpperCase();
        const sub = str(r?.subsetName);
        if (!num || !sub) continue;
        if (!out.byNumber.has(num)) out.byNumber.set(num, new Set());
        out.byNumber.get(num).add(lower(sub));
      }
      // "Has this product a checklist at all?" is a separate, cheap question:
      // the subsetted read above is empty for a product whose checklist lists
      // no subsets AND for a product we never scraped, and only the second is
      // a refusal. TOP 1 rather than a COUNT -- existence is the whole
      // question.
      const { resources: probe } = await retry(() => cat.items.query({
        query: `SELECT TOP 400 c.source FROM c WHERE c.setKey = @sk AND ${yearMatch("c")}`,
        parameters: [{ name: "@sk", value: setKey }, { name: "@y", value: Number(year) }],
      }, { maxItemCount: 400 }).fetchAll());
      out.hasStrict = (probe ?? []).some((r) => K.isStrictChecklistSource(r?.source));
    } catch { out = { byNumber: new Map(), hasStrict: false }; }
    subsetCache.set(key, out);
    return out;
  }

  // ── the canary anchors ───────────────────────────────────────────────────
  const anchors = new Map();
  async function anchor(slug) {
    if (!slug || anchors.has(slug)) return;
    anchors.set(slug, { before: (await poolRowsFor(pool, slug)).length, after: null });
  }

  const s = {
    scanned: 0, otherSlot: 0, moved: 0, created: 0, deleted: 0, collapsed: 0,
    failed: 0, duplicatesLeft: 0,
  };
  const skips = new Map();
  const bumpSkip = (k) => skips.set(k, (skips.get(k) ?? 0) + 1);
  // Per-BUCKET numbers, where a bucket is (title finish word / stored parallel)
  // -- the shape the census reports and the shape Drew ruled on.
  const buckets = new Map();
  const bucketOf = (key) => {
    if (!buckets.has(key)) buckets.set(key, { inScope: 0, wouldWrite: 0, skipped: new Map(), examples: [] });
    return buckets.get(key);
  };
  const examples = [];
  let stopReason = null;

  async function handle(row, product) {
    // THE SCOPE'S (year, setKey) IS THE ROW'S OWN, not an assumption about it.
    // The scan reaches a row by its SLUG PREFIX, so a row handled under
    // `baseball:2025:topps-chrome` is one whose `hiq:` address carries exactly
    // that sport, year and setKey -- which is the address the pool prices it
    // under and the one A2 compares the destination against. Selecting the
    // finish vocabulary and the checklist with it is therefore reading the
    // product the row is FILED under, never a guess at the product it might
    // belong to. A row whose STORED setName disagrees is not re-homed here:
    // that is a setKey dispute and this lane refuses those at A2.
    //
    // The sport is deliberately NOT taken from here: the destination is built
    // from `addr.sport`, the slug's own segment, so the identity axes of the
    // destination come from ONE place -- the address -- and A2 can prove the
    // move mechanically instead of trusting two sources to agree.
    const [, year, setKey] = product.split(":");
    const stored = storedIdentity(row, normalizeSetKey);
    const storedSlug = row.cardId;

    // A1 FIRST, because it is the ruling's own evidence and it also supplies
    // the ADDRESS (`addressSlug`) every later assertion compares against.
    const collision = K.finishFamilyCollision({ row, storedSlug, stored, derived: null });
    // Every row the scan reached is counted in a bucket, so the report's
    // "in scope" is what the lane classified rather than what it moved.
    const titleFams = V.titleFinishFamilyTokens(str(row.title), setKey);
    const bucketKey = `${titleFams.join("+") || "(no family word)"} / ${str(row.parallel) || "(blank)"}`;
    const b = bucketOf(bucketKey);
    b.inScope++;

    const skip = (reason) => {
      bumpSkip(reason);
      b.skipped.set(reason, (b.skipped.get(reason) ?? 0) + 1);
      if ((skips.get(reason) ?? 0) <= 3) {
        console.log(`    SKIP ${reason}`);
        console.log(`         ${str(row.title).slice(0, 92)}`);
      }
    };

    if (!collision.qualifies) { skip("not-a-finish-family-collision"); return; }

    // The DESTINATION, built from the CHECKLIST'S OWN NAME for the card the
    // title describes -- never composed here (CF-NO-SYNTHETIC-PARALLELS-ONLY-
    // ACTUALS). See checklistNameForCollision for why this is not the corpus's
    // own `checklistParallelForFamily`: that one drops the colour.
    const checklistParallel = F.checklistNameForCollision({
      names: V.checklistParallelNamesFor(Number(year), setKey),
      family: collision.evidence.family,
      titleFamilyTokens: titleFams,
      parallelTokensOf: V.parallelFinishFamilyTokens,
      titleWords: V.titleWords(str(row.title)),
    });

    // The destination slug through the LIVE writers, so a slug this lane
    // accepts is one an ingest would mint today. The identity axes are the
    // STORED row's own -- this lane disputes the finish and nothing else -- and
    // A2 then proves that mechanically rather than trusting it.
    const addr = F.slugParts(collision.evidence.addressSlug);
    let destSlug = null;
    if (checklistParallel && addr) {
      try {
        destSlug = computeHobbyIqCardId({
          sport: addr.sport,
          year: Number(addr.year),
          setKey: addr.setKey,
          cardNumber: addr.cardNumber,
          parallel: checklistParallel,
          isAuto: addr.autoFlag === "auto",
          printRun: addr.printRun ? Number(addr.printRun) : null,
          playerName: row.playerName ?? null,
          gradeCompany: row.gradeCompany ?? null,
          gradeValue: row.gradeValue ?? null,
        });
      } catch { destSlug = null; }
    }

    const destBacked = destSlug ? await destinationBacked(destSlug) : false;
    const facts = await subsetFacts(Number(year), setKey);
    const subsettedNamesAtNumber = facts.byNumber.get(String(addr?.cardNumber ?? "").toUpperCase()) ?? new Set();

    const plan = F.planFinishCollisionRefile({
      row, stored, derived: null, storedSlug,
      destSlug, checklistParallel, destBacked,
      subsettedNamesAtNumber, productHasStrictRows: facts.hasStrict,
    });
    if (!plan.move) { skip(plan.reason); return; }

    b.wouldWrite++;
    if (b.examples.length < 3) {
      b.examples.push({ title: str(row.title).slice(0, 120), from: collision.evidence.addressSlug, to: plan.dest });
    }

    await anchor(collision.evidence.addressSlug);
    await anchor(plan.dest);

    const keep = stripSystem(row);
    const oldPk = str(row.cardId);
    // A vendor partition key is not a slug; keeping it makes the move legible.
    if (oldPk && !oldPk.startsWith("hiq:")) keep.vendorCardIdWas = oldPk;
    // BOTH identity fields land at the destination -- the reader ORs them, so
    // a move that rewrites one has not moved the sale.
    keep.cardId = plan.dest;
    keep.hobbyiqCardId = plan.dest;
    keep.parallel = checklistParallel;
    keep.parallelSlug = hic.normalizeParallel(checklistParallel);
    keep.parallelBefore = str(row.parallel);
    keep.rekeyedFrom = collision.evidence.addressSlug;
    keep.rekeyedAt = new Date().toISOString();
    keep.rekeyedReason = F.REASON;
    // THE EVIDENCE TRAVELS WITH THE ROW. A verdict alone is not the record:
    // the QUOTED TITLE is what makes this move re-judgeable months later
    // without re-deriving anything.
    keep.rekeyedEvidence = {
      titleQuoted: plan.evidence.titleQuoted,
      family: plan.evidence.family,
      titleFamilyWords: plan.evidence.titleFamilyWords,
      storedSlugParallel: plan.evidence.storedSlugParallel,
      storedParallelField: plan.evidence.storedParallelField,
      addressField: plan.evidence.addressField,
      checklistParallel,
      differingSegments: plan.evidence.differingSegments,
      rule: F.REASON_LONG,
    };
    // THE HASH FOLLOWS THE ADDRESS: cardId is contentHash's first component, so
    // a moved row keeping the old hash is invisible to the store's
    // partition-scoped pre-write dedup and every re-emit duplicates it.
    // Computed AFTER both identity fields and the parallel are final.
    keep.contentHash = contentHashOf(keep);

    if (examples.length < 12) {
      examples.push(`    REFILE ${collision.evidence.addressSlug.slice(0, 70)}\n        -> ${plan.dest.slice(0, 70)}\n           "${str(row.title).slice(0, 76)}"`);
    }

    const res = await relocateSoldComp(pool, {
      keep,
      drop: [{ id: row.id, cardId: row.cardId }],
      retry,
      // BOTH keys verified, because the pool reader ORs both.
      verifyFields: ["cardId", "hobbyiqCardId", "parallel", "contentHash", "rekeyedFrom"],
      dryRun: !APPLY,
    });
    if (!res.ok && res.stage !== "done") {
      s.failed++;
      console.log(`  FAILED at ${res.stage}: ${row.id} -> ${plan.dest}: ${String(res.error).slice(0, 110)}`);
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
    s.moved++;
  }

  // ── the sweep, one product at a time ─────────────────────────────────────
  //
  // THE ID CARRIES THE PRODUCT, so the scan is by SLUG PREFIX and not by a
  // predicate over the year. `STARTSWITH(c.hobbyiqCardId, 'hiq:baseball:2025:
  // topps-chrome:')` is index-served; `c.sport = @sp AND c.cardYear = @y` reads
  // the whole year -- measured 2026-09-05, that read did not finish a
  // ten-minute probe on one product while the prefix scan classifies the same
  // product in seconds.
  //
  // BOTH KEYS ARE SCANNED, because the exact-pool reader ORs them: a row whose
  // `hobbyiqCardId` carries the product while its `cardId` is a vendor bubble
  // id is reached by the first scan, and a row keyed the other way round only
  // by the second. Ids already seen are not handled twice.
  const seen = new Set();
  for (const product of SCOPE_PRODUCTS) {
    if (stopReason) break;
    const [sport, year, setKey] = product.split(":");
    const prefix = `hiq:${sport}:${year}:${setKey}:`;
    for (const field of ["hobbyiqCardId", "cardId"]) {
      if (stopReason) break;
      console.log(`-- scanning ${field} ${prefix}`);
      await forEachPage(pool, {
        // SELECT * and not a projection: the row read here is the document
        // UPSERT-ed at the new address, so a projection would silently drop
        // every field it left out. A re-key must carry the whole row.
        query: `SELECT * FROM c WHERE STARTSWITH(c.${field}, @p)`,
        parameters: [{ name: "@p", value: prefix }],
      }, async (rows) => {
        // The budget is checked on EVERY page, not only inside a batch: a page
        // whose rows all filter out never reaches the batch loop, and a scan
        // that is mostly filtered would run past its budget without asking.
        if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; return false; }
        const mine = rows.filter((r) => {
          const k = `${r.id} ${r.cardId}`;
          if (seen.has(k)) return false;
          seen.add(k);
          // Shard on the row's OWN id: the partition key is a vendor id for
          // much of this population and thousands of rows can share one, so
          // sharding on it would pile them into a single slot.
          if (!SHARD_SCOPE.mine(shardIndex(r.id))) { s.otherSlot++; return false; }
          return true;
        });
        for (let i = 0; i < mine.length; i += CONCURRENCY) {
          const batch = mine.slice(i, i + CONCURRENCY);
          s.scanned += batch.length;
          await Promise.all(batch.map((r) => handle(r, product).catch((e) => {
            s.failed++;
            if (s.failed <= 5) console.log(`  FAILED ${str(r.id).slice(0, 64)}: ${String(e?.message ?? e).slice(0, 110)}`);
          })));
          if (LIMIT && s.moved >= LIMIT) { stopReason = "limit"; break; }
          if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; break; }
        }
        return !stopReason;
      });
    }
  }

  if (examples.length) {
    console.log("");
    console.log(`  ${APPLY ? "REFILED" : "WOULD REFILE"} (first ${examples.length}):`);
    for (const m of examples) console.log(m);
  }

  console.log("");
  console.log("-".repeat(78));
  console.log(`  ${APPLY ? "APPLIED" : "REPORT ONLY -- nothing was written"}`);
  console.log(`  rows in scope (this slot)   ${f(s.scanned)}   (+${f(s.otherSlot)} other slots)`);
  console.log(`  REFILED onto the title's card ${f(s.moved)}   <- cardId AND hobbyiqCardId, verified by read`);
  console.log(`  new rows created            ${f(s.created)}`);
  console.log(`  old rows deleted            ${f(s.deleted)}`);
  console.log(`  collapsed onto an existing  ${f(s.collapsed)}`);
  console.log(`  duplicates LEFT in the pool ${f(s.duplicatesLeft)}`);
  console.log(`  failed                      ${f(s.failed)}`);
  const skipped = [...skips.values()].reduce((a, b) => a + b, 0);
  console.log(`  SKIPPED (reported, never written) ${f(skipped)}`);
  for (const [k, n] of [...skips].sort((a, b) => b[1] - a[1])) console.log(`    ${String(f(n)).padStart(6)}  ${k}`);

  // ── the per-bucket report ────────────────────────────────────────────────
  console.log("");
  console.log("  BY BUCKET (title finish word / stored parallel):");
  for (const [key, v] of [...buckets].sort((a, b) => b[1].inScope - a[1].inScope).slice(0, 30)) {
    console.log(`    ${String(f(v.inScope)).padStart(7)} in scope   ${String(f(v.wouldWrite)).padStart(6)} ${APPLY ? "written" : "would write"}   ${key}`);
    for (const [r, n] of [...v.skipped].sort((a, b) => b[1] - a[1])) {
      console.log(`              ${String(f(n)).padStart(7)}  skipped: ${r}`);
    }
    for (const ex of v.examples) console.log(`              e.g. "${ex.title}"\n                   ${ex.from}\n                -> ${ex.to}`);
  }

  // ── the canary anchors, AFTER ────────────────────────────────────────────
  console.log("");
  console.log("  CANARY ANCHORS (counted on BOTH cardId and hobbyiqCardId)");
  let canaryBad = 0;
  for (const [slug, a] of anchors) {
    a.after = (await poolRowsFor(pool, slug)).length;
    const delta = a.after - a.before;
    console.log(`    ${String(a.before).padStart(6)} -> ${String(a.after).padStart(6)}  (${delta >= 0 ? "+" : ""}${delta})  ${slug}`);
    // A dry run is proven write-free by MEASUREMENT, not by intent.
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
  console.log(`  reconciled: intended ${f(s.scanned)} = written ${f(s.moved)} + skipped ${f(skipped)}${s.failed ? ` + failed ${f(s.failed)}` : ""}`);
  if (APPLY) reportWrites({ job: "repair-finish-collision-refile", intended: s.scanned, written: s.moved, skipped, failed: s.failed });

  console.log("");
  if (stopReason === "budget") {
    console.log(`  stopped at the ${Math.round(RUN_MS / 60000)}-minute budget — the relaunch continues from here`);
  } else if (stopReason === "limit") {
    console.log(`  stopped at LIMIT=${f(LIMIT)} refiles (a bounded probe, NOT a budget stop — no relaunch)`);
  } else {
    console.log("  scan complete — every row in scope was classified.");
  }
  console.log("");
}

module.exports = { storedIdentity, INHERITED_SCOPES, PRODUCT_RE };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL", e?.stack ?? e); process.exit(1); });
}
