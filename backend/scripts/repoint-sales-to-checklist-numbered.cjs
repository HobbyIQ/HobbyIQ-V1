#!/usr/bin/env node
/**
 * repoint-sales-to-checklist-numbered.cjs -- move STORED sales that the
 * INGEST-TIME upgrade (#2298, resolveChecklistNumberedIngestId) can never
 * reach, and that the CATALOG-side fold (fold-checklist-numbered-twins.cjs,
 * R1) cannot reach either when no catalog twin row exists at the short id.
 *
 * THE MEASURED PROBLEM. On a sales-volume ranking the single largest reason
 * sports sales are not checklist-backed is the NUMBERED TWIN: the checklist
 * states a print run, so the checklist-backed catalog row's id ends
 * `:num-N` (`hiq:baseball:2026:topps:20:gold:no-auto:num-2026`), but a
 * sale's title rarely states the print run, so the sale's own
 * `hobbyiqCardId`/`cardId` is the SHORT id (`...:gold:no-auto`) -- which has
 * either a vendor-created catalog twin row, or NO catalog row at all.
 * Sampled: 2026 Topps baseball 93% of sales not backed, 2025 Topps 93%, 2025
 * Topps football 100%, also 2025 Prizm baseball, Topps Chrome
 * basketball/football -- ~53% of all not-backed volume in the top 60
 * product-years.
 *
 * WHY NEITHER EXISTING MECHANISM CLOSES THIS.
 *
 *   resolveChecklistNumberedIngest.ts (#2298, merged and deployed
 *   2026-09-19) upgrades a FRESH sale's derived slug at write time, inside
 *   recordSoldComp / persistVendorSalesToPool. It has no effect whatsoever
 *   on a sale already sitting in sold_comps before that PR landed -- it is
 *   an ingest-path hook, never invoked for a stored row.
 *
 *   fold-checklist-numbered-twins.cjs (R1) drives from card_catalog: its
 *   pass 1 is `SELECT c.id, ... FROM c WHERE STARTSWITH(c.id, "hiq:") ...`
 *   over card_catalog ONLY (fold-checklist-numbered-twins.cjs:183), groups
 *   the results by identityKeyOf, and for each group folds every NON-target
 *   CATALOG ROW it finds onto the checklist's numbered row -- re-pointing
 *   that catalog row's own sales as a side effect of the fold
 *   (relocatePartitionKeyedSales at :557, scoped to
 *   `WHERE c.cardId = @t` with `partitionKey: twinId`, where `twinId` is a
 *   CATALOG TWIN's id). A short id with NO catalog row at all is never read
 *   in pass 1 (it produces no `c.id` row to group), is never a `twin` in
 *   pass 2's per-group loop, and so its sales -- however many there are --
 *   are never visited by this lane under any circumstance. THE CLAIM IN THE
 *   BRIEF HOLDS: confirmed by reading fold-checklist-numbered-twins.cjs:178-201
 *   (pass 1 query and grouping) and :301-318 (pass 2 only iterates `rows`
 *   drawn from those same catalog-sourced groups) -- there is no code path
 *   in that file that ever reads sold_comps by a short id absent from
 *   card_catalog.
 *
 * THIS LANE closes exactly that gap by driving from the CATALOG side (the
 * checklist rows that DO exist, and DO carry the numbered identity) rather
 * than scanning sold_comps cross-partition, and then reaching into
 * sold_comps at the short id it computes -- present or absent as a catalog
 * row, sold_comps never knows the difference at that address.
 *
 * DRIVE ORDER, PER (sport, year, setKey):
 *   1. page card_catalog for checklist-backed rows whose id carries a
 *      `:num-N` segment (equality filters + maxItemCount 1000 + continuation,
 *      NEVER a COUNT/GROUP BY);
 *   2. group by identityKeyOf (foldTwinRuleChecklistNumbered.js, the SAME
 *      authority gate the twins fold and the ingest upgrade both reuse);
 *   3. pickChecklistNumberedTarget per group -- exactly ONE checklist print
 *      run required; two rival runs are AMBIGUOUS, counted and skipped, same
 *      as the twins fold;
 *   4. for the one target, derive its SHORT id by stripping ONLY the
 *      trailing `:num-N` segment (parseHobbyIqCardId / computeHobbyIqCardId
 *      round-trip, not a hand-rolled parser -- see shortIdOf below);
 *   5. find sales at the short id BOTH ways sold_comps addresses a card:
 *        - cardId === shortId, partition-scoped (the row's own partition key
 *          IS the short id -- these need a full relocate);
 *        - hobbyiqCardId === shortId, the bounded indexed-equality query the
 *          fold's own player-evidence gathering (player-evidence.cjs) and
 *          #2298's own ingest upgrade both use for a non-partition address
 *          (these need only a patch: the row is already living at some OTHER
 *          partition, usually a vendor id, and only hobbyiqCardId moves);
 *   6. for each sale, the ONE title/print-run rule #2298 itself applies
 *      ("absent beats wrong" -- persistVendorSalesToPool.service.ts:1656,
 *      `if (!parsed.printRun)`): re-parse the sale's own stored `title`
 *      through parseListingIdentity (parseTitleIdentity.service.ts) and
 *      refuse + list whenever it states a print run at all (whether or not
 *      it agrees with N -- a title that states its OWN print run was never
 *      the "un-numbered twin" case this lane exists to fix, and a stored row
 *      whose slug is short despite a title-stated run is itself a defect
 *      this lane must not paper over by relocating it). No second title
 *      parser is written; this is the same function and the same field
 *      #2298 already gates on.
 *   7. relocate (cardId === shortId) or patch (hobbyiqCardId only, cardId
 *      unchanged) onto the numbered id, both fields set to the numbered id
 *      after a relocate, only hobbyiqCardId after a patch.
 *
 * WHAT THIS LANE DOES NOT DO.
 *
 *   - It never touches card_catalog. If a catalog row already exists at the
 *     short id, that row is the TWINS LANE's job (fold-checklist-numbered-
 *     twins.cjs already reaches it via its own pass 1, because the row
 *     itself is a `c.id` this lane's catalog scan never sees since it only
 *     pages NUMBERED rows). This lane only counts and reports how many short
 *     ids still have a twin row, as an input for that lane's own targeting.
 *   - Pre-existing SPLIT IDENTITY (cardId and hobbyiqCardId already point at
 *     two DIFFERENT cards) is never "fixed" here -- it is counted and listed.
 *     relocateSoldComp's own guardSoldCompDoc still runs on every write this
 *     lane makes and can independently park a malformed destination; that is
 *     unrelated to this lane's own split-identity accounting and is counted
 *     separately (guardParked).
 *   - Holdings on the short id are not orphaned by leaving them unmoved:
 *     the price path already unions short + numbered ids at read time
 *     (poolReadIdsFor, catalogIdentityResolver.ts:300) as the documented
 *     bridge until every pool is re-keyed, so a holding not yet re-pointed
 *     here still prices correctly. This lane still re-points every holding
 *     it can (bounded, in-memory map walk) and reports the walk count.
 *
 * CF-A-SALE-IS-NEVER-LOST throughout: every relocation goes through
 * scripts/lib/relocate-sold-comp.cjs (upsert -> verify read-back -> delete),
 * and the banner's own reconciliation is sales-at-short-ids-before ==
 * relocated + patched + refused + left (never written = never counted lost).
 *
 * REPORT-FIRST. BACKFILL_APPLY=true (not APPLY) gates every write, matching
 * the runner's own env name and every sibling lane. REPORT runs the SAME
 * reads and the SAME per-sale decision as APPLY and prints the real "would
 * relocate / would patch" counts -- rekey-catalog-id-to-setkey's own header
 * names the sibling bug this guards against (a REPORT run that structurally
 * cannot reach a non-zero count because a write-only code path decides
 * something a report-only path never runs); this lane's `planSale` /
 * `decideSaleAction` are pure and run identically in both modes, and the
 * pinned test below asserts REPORT's counts equal APPLY's on one fixture.
 *
 * SCOPE IS REQUIRED, BY NAME, reusing the runner's `scope` input for
 * sport:year cells (rekey-catalog-id-to-setkey's own convention) and
 * `titles` for a REQUIRED comma-separated setKey list -- empty or a
 * wildcard ('all', '*') is refused (exit 2). NO NEW WORKFLOW INPUT.
 *
 * BUDGET / RELAUNCH / SHARDING follow the sibling convention exactly:
 * lib/runner-budget.cjs and lib/runner-shard-scope.cjs. A relocated sale no
 * longer matches the short-id selection, so a re-run after a budget stop is
 * idempotent by construction -- see processTarget's own header comment for
 * why that stays true under concurrency too (a relaunch re-derives targets
 * from card_catalog; an already-moved sale is simply absent from the next
 * run's shortId query, whichever worker would have claimed it).
 *
 * CONCURRENCY (review, 2026-09-19): the per-target body (a partition-scoped
 * cardId query + the ONE cross-partition hobbyiqCardId query + decide + write
 * + holdings repoint) runs through a bounded worker pool, not the one-at-a-
 * time serial loop this lane shipped with -- see processTarget's own header
 * comment for the honest disjointness proof (destination ids are always
 * disjoint by construction; a sale/holding CAN be found by two live targets,
 * but ONLY when it is a pre-existing split identity, which classifySaleFor
 * Relocation now refuses from EITHER side rather than writing from either)
 * and for how the budget stop, the reconciliation counters (deduped by
 * document address, not raw query hits) and the REPORT==APPLY parity all
 * stay exact under it. A blocking review on the first version of this
 * change found the split-identity gap (a sale with cardId naming one live
 * target's short id and hobbyiqCardId naming ANOTHER live target's short id
 * used to be relocated by one and patched by the other -- a torn write on a
 * document that was never an un-numbered twin); that decision defect was
 * pre-existing and SERIAL too (the two writes just never raced before), and
 * is fixed at the decision layer, not just the race. Read env, same as
 * before: CONCURRENCY or BACKFILL_CONCURRENCY (the runner's own
 * `inputs.concurrency` -- no workflow change needed).
 *
 * LIMIT (non-blocking review note, 2026-09-19): under concurrency, up to
 * CONCURRENCY targets can be past the `LIMIT` check before any of their
 * writes land and bump `salesRelocated + salesPatched`, so a dispatch with
 * LIMIT set can overshoot by up to CONCURRENCY targets' worth of sales
 * (worst case) before the NEXT target claim sees the limit reached. This
 * lane's `LIMIT` was already a soft/approximate cap serially (checked once
 * per TARGET, never per sale, so one target's whole sale list could already
 * push past it) -- concurrency widens that same slack, it does not introduce
 * a new kind of imprecision. Not a correctness defect (nothing under- or
 * double-counts), just a sizing note for an operator who set LIMIT expecting
 * an exact ceiling.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true / APPLY=true to write;
 *      SCOPE required (sport:year cells, comma list); SET_KEYS required
 *      (comma list, no 'all'/'*'); SLOT/SLOTS (sha1(id) shards, opt-in via
 *      SHARD=true for slot 0); CONCURRENCY=8 (or BACKFILL_CONCURRENCY, the
 *      runner's own input name); RUN_MINUTES=110; LIMIT=0 (soft cap, see
 *      LIMIT note above).
 * Requires dist/ (foldTwinRuleChecklistNumbered, catalogAuthority,
 * parseTitleIdentity, writeReconciliation).
 */
"use strict";
const path = require("path");
const crypto = require("node:crypto");
const backend = path.resolve(__dirname, "..");

const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const STARTED = Date.now();
const CLOCK = budget({ minutes: 110, reserveMs: 90 * 1000, verifyMs: 5 * 60 * 1000, startedAt: STARTED });
// CONCURRENCY (review, 2026-09-19): capped at 32 -- the runner's own default
// fan-out width for this container's autoscale (40k RU, same ceiling
// explodeCatalogGrades.cjs's grade-explode.yml dispatch already uses) -- so a
// stray operator-typed value (e.g. a fat-fingered 320) cannot fan this lane
// out past what the container was ever measured to sustain. Sibling lanes'
// own CLASSIFY_CONCURRENCY caps the same way (`Math.min(32, ...)`).
const CONCURRENCY = Math.min(32, Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8)));
const LIMIT = Number(process.env.LIMIT || 0);

const SHARD_SCOPE = runnerShardScope({ label: "repoint-sales-to-checklist-numbered" });
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SHARD_SCOPE.SLOTS;

// ── THE SCOPE. sport:year cells, and an inherited default is REFUSED ────────
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const CELL_RE = /^[a-z][a-z0-9-]*:\d{4}$/;
const SCOPE_CELLS = RAW_SCOPE.map(lower).filter((p) => CELL_RE.test(p));
const SCOPE_REJECTED = RAW_SCOPE.filter((p) => !CELL_RE.test(lower(p)));

// ── THE TARGET SETKEYS. Riding the runner's `titles` input, same convention
// as rekey-catalog-id-to-setkey / repair-rc-marker-playername. Empty or a
// wildcard is refused -- a whole-source write needs its own name.
const WILDCARDS = new Set(["", "all", "*"]);
const RAW_SET_KEYS = csv(process.env.SET_KEYS || process.env.BCP_TITLES).map(lower);
const SET_KEYS = RAW_SET_KEYS.filter((k) => !WILDCARDS.has(k));

// CONCURRENCY (review, 2026-09-19): under bounded parallelism several workers
// can be throttled at once, so the jittered backoff is widened here (full
// jitter rather than a bare exponential sleep) to avoid every worker waking
// on the same tick and re-hammering the container in lockstep.
//
// `THROTTLE_COUNT` is a single module-level counter rather than a callback
// threaded through every call site (forEachPage, relocateSoldComp's own
// `retry` option, the point reads in this file): every one of those already
// calls this SAME `retry`, so counting inside it once is the whole banner
// signal `main()` needs, with no plumbing change to any call site's
// signature. Reset per process -- this script is one-shot per invocation
// (spawned fresh by the runner, and by every test in the lane's suite), so
// there is no cross-run state to leak.
let THROTTLE_COUNT = 0;
const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(msg) || a >= tries) throw e;
      THROTTLE_COUNT++;
      // Full jitter (0..wait), not a bare sleep(wait): a fixed backoff lets
      // every concurrent worker that got throttled on the same tick retry on
      // the same tick too, which is the thundering-herd shape this widening
      // exists to avoid under CONCURRENCY > 1.
      await new Promise((r) => setTimeout(r, Math.random() * wait));
      wait = Math.min(wait * 2, 15000);
    }
  }
};

async function forEachPage(container, spec, onPage, pageSize = 1000) {
  let token;
  do {
    const page = await retry(() => container.items
      .query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

/** SHOULD-FIX 4 (review, 2026-09-19): p50/p95 over a list of elapsed-ms
 *  samples, for the banner's query-cost report. Sorts a copy; returns 0 for
 *  an empty list rather than NaN, so the banner prints a number, not a gap. */
function percentile(msValues, p) {
  if (!msValues.length) return 0;
  const sorted = [...msValues].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** The candidate predicate for one (sport, year, setKey) cell: checklist rows
 *  carrying a `:num-` segment somewhere in the id (the trailing print-run
 *  segment; STARTSWITH is index-served and cheap, the exact `:num-\d+$` shape
 *  is confirmed in JS below since Cosmos SQL has no anchored regex). Equality
 *  on sport/year/setKey, never a cross-partition COUNT/GROUP BY. */
function candidateSpec(sport, year, setKey) {
  return {
    query: `SELECT c.id, c.cardId, c.source, c.sport, c.year, c.cardYear, c.setKey, c.cardNumber,
                   c.parallelSlug, c.isAuto, c.printRun, c.playerName
            FROM c
            WHERE c.sport = @sport AND (c.year = @year OR c.cardYear = @year)
              AND c.setKey = @setKey
              AND CONTAINS(c.id, ":num-")
              AND NOT IS_DEFINED(c.gradeTier)`,
    parameters: [
      { name: "@sport", value: sport },
      { name: "@year", value: year },
      { name: "@setKey", value: setKey },
    ],
  };
}

/** True iff `id` ends in the print-run segment this lane strips. Cosmos SQL's
 *  CONTAINS(":num-") is a coarse pre-filter (index-served); this is the exact
 *  check applied to every row CONTAINS lets through, so a `:num-` substring
 *  inside a card number or a subset slug can never be mistaken for the
 *  trailing print-run segment. */
const TRAILING_NUM_RE = /:num-(\d+)$/;
function hasTrailingPrintRun(id) {
  return TRAILING_NUM_RE.test(String(id ?? ""));
}

/**
 * The SHORT id: `id` with ONLY the trailing `:num-N` segment removed, every
 * other segment (including a `:sub-...:` subset tag, present between the
 * setKey and the card number) byte-preserved. Surgery, not a recompute --
 * the same discipline rekey-catalog-id-to-setkey and fold-umbrella-to-series
 * both use for their own single-segment edits, and for the same reason: a
 * full re-derive could disagree with what the row already spells (a parallel
 * the resolver would name differently today), and this lane's whole
 * authority is the checklist row's OWN identity, not a fresh computation of
 * it.
 *
 * Graded children (`...:num-N:psa-9`) are excluded upstream by
 * `NOT IS_DEFINED(c.gradeTier)` in candidateSpec and are never handed here;
 * this function still refuses defensively if asked to strip a non-trailing
 * match. Returns null when `id` does not end in `:num-<digits>`.
 */
function shortIdOf(id) {
  const s = String(id ?? "");
  const m = s.match(TRAILING_NUM_RE);
  if (!m) return null;
  return s.slice(0, s.length - m[0].length);
}

/**
 * RULING (review, 2026-09-19, blocking #2339 as first filed): the split-
 * identity refusal below used to fire only when NEITHER `cardId` nor
 * `hobbyiqCardId` equalled the shortId being scanned -- which misses the
 * exact shape a concurrent dispatch turns into a torn write: a sale with
 * `cardId = shortA` (a LIVE target, this cell's own scan) and
 * `hobbyiqCardId = shortB` (a DIFFERENT live target). Target A's cardId-shape
 * query finds it and RELOCATES it, stamping `hobbyiqCardId = numberedA` --
 * destroying the very fact that this sale's hobbyiqCardId used to name a
 * DIFFERENT card. Target B's hobbyiqCardId-shape query (`hobbyiqCardId = @s
 * AND cardId != @s`) finds the SAME document and PATCHES `hobbyiqCardId =
 * numberedB`. Whichever write lands last wins; the other is a torn write, a
 * lost update, on a document that was NEVER an un-numbered twin to begin
 * with -- it was already split. This was already wrong SERIALLY (the two
 * writes just never raced), and worse: for split rows, tonight's audit
 * established the STORED hobbyiqCardId is typically the CORRECT identity and
 * the vendor-derived cardId the wrong one, so the old relocate path was
 * overwriting a correct field with a checklist target chosen from the WRONG
 * side of the split.
 *
 * So the shape a sale must be in to be touched AT ALL is now enumerated
 * explicitly, rather than inferred from "neither field is the shortId":
 *
 *   (1) cardId === hobbyiqCardId === shortId
 *       -- the ordinary un-numbered-twin case this lane exists to fix.
 *          RELOCATE: both fields become numberedId.
 *   (2) cardId is a raw VENDOR id (does not start with "hiq:") and
 *       hobbyiqCardId === shortId
 *       -- the vendor-keyed patch-shape case: the row lives at a vendor
 *          partition and only hobbyiqCardId names a hiq: slug.
 *          PATCH: hobbyiqCardId becomes numberedId, cardId untouched.
 *   (3) cardId === shortId and hobbyiqCardId is ABSENT/empty
 *       -- today's code already treats an absent hobbyiqCardId as if it
 *          equalled cardId (`sale.hobbyiqCardId ?? saleCardId`), so this is
 *          NOT a distinct code path -- it collapses into (1), and nothing
 *          about the absent field is destroyed: there was no information
 *          there to lose, and the relocate sets BOTH fields to numberedId
 *          exactly as (1) does.
 *   (4) cardId === shortId and hobbyiqCardId === numberedId ALREADY
 *       -- a relocate a prior run started and was interrupted before the
 *          delete of the short-id copy landed (or that itself raced). The
 *          cardId-shape query still finds it (cardId is still shortId); this
 *          is finished idempotently by relocating again -- `keep`'s
 *          hobbyiqCardId is already numberedId either way, so this is not a
 *          distinct branch from (1) either, just a fixture worth naming.
 *
 * EVERYTHING ELSE -- most importantly cardId and hobbyiqCardId both `hiq:`
 * slugs naming two DIFFERENT cards where at least one of them happens to be
 * a shortId THIS SCAN is currently examining -- REFUSES as split-identity,
 * from WHICHEVER side reaches it, in REPORT and APPLY, serial or concurrent.
 * "Different cards" here is judged against the EXACT relation this lane
 * itself creates (`numberedId === shortId + ":num-" + N`): a cardId/
 * hobbyiqCardId pair that already agrees on being exactly {shortId,
 * numberedId} for THIS target is shape (1)/(4), not a split; anything else
 * where both are `hiq:` and they disagree is a pre-existing split this lane
 * does not arbitrate.
 *
 * Returns the classification alone (no write decision) so both
 * `decideSaleAction` (per-sale) and the concurrency test fixtures can assert
 * on it directly. `null` shape/rank fields are for humans reading a refusal
 * detail, never branched on.
 */
function classifySaleForRelocation(sale, ctx) {
  const { shortId, numberedId } = ctx;
  const cardId = String(sale.cardId ?? "");
  const hobbyiqCardIdRaw = sale.hobbyiqCardId;
  const hobbyiqCardIdPresent = hobbyiqCardIdRaw !== null && hobbyiqCardIdRaw !== undefined && String(hobbyiqCardIdRaw) !== "";
  const hobbyiqCardId = hobbyiqCardIdPresent ? String(hobbyiqCardIdRaw) : cardId; // absent falls back to cardId, same as before -- shape (3)

  // (1) / (3) / (4): cardId IS the shortId this target is scanning, and
  // hobbyiqCardId is either the SAME shortId, absent (folded into the same
  // check via the fallback above), or ALREADY the numberedId this exact
  // target would write (a half-done prior relocate). Every one of these
  // agrees on the pair {shortId, numberedId} for THIS target -- never a
  // split, because there is only one other card in play (numberedId) and it
  // is the one this scan is already moving toward.
  if (cardId === shortId && (hobbyiqCardId === shortId || hobbyiqCardId === numberedId)) {
    return { ok: true, action: "relocate" };
  }

  // (2): a raw vendor id (never a hiq: slug) carrying hobbyiqCardId ===
  // shortId. The vendor id names no card of its own in this vocabulary --
  // there is nothing for it to "split" from -- so this is the ordinary
  // patch-shape case, not a split-identity question at all.
  if (!cardId.startsWith("hiq:") && hobbyiqCardId === shortId) {
    return { ok: true, action: "patch" };
  }

  // Everything else: SPLIT. Covers (a) cardId === shortId but hobbyiqCardId
  // names some OTHER hiq: slug entirely (a different live target, or any
  // other card) -- the shape the concurrency review found; (b) hobbyiqCardId
  // === shortId but cardId is a DIFFERENT hiq: slug (the mirror, reached from
  // the hobbyiqCardId-shape query); (c) the pre-existing "neither field is
  // this shortId" split the original guard already caught. All three are one
  // rule now: cardId and hobbyiqCardId disagree on being exactly this
  // target's {shortId, numberedId} pair, so this lane refuses and lists both
  // ids, never touching the doc from either side.
  return { ok: false, cardId, hobbyiqCardId };
}

/**
 * Pure per-sale decision -- no I/O -- so REPORT and APPLY run the EXACT same
 * logic and a test can assert REPORT's counts equal APPLY's on one fixture
 * (the sibling bug this guards against: a structural zero because a
 * write-only code path decided something a report-only path never ran).
 *
 * @param {object} sale        the sold_comps row as read (cardId, hobbyiqCardId, title, sport)
 * @param {"cardId"|"hobbyiqCardId"} shape  which address found this sale
 * @param {object} ctx
 * @param {string} ctx.shortId       the un-numbered id this sale sits at
 * @param {string} ctx.numberedId    the checklist target it would move to
 * @param {number|null} ctx.titlePrintRun  the print run parseListingIdentity
 *        read out of the sale's OWN stored title, or null. Passed in rather
 *        than computed here so this function stays pure and the title parser
 *        is called exactly once per sale, at the call site.
 * @param {boolean} [ctx.titleStatesProsePrintRun]  statesProsePrintRun's own
 *        answer for the sale's title (SHOULD-FIX 3, #2314 review) -- catches
 *        a print run stated in PROSE that extractPrintRun's slash-only
 *        reading misses. ORed with `titlePrintRun` as the SAME refusal, not
 *        a second rule.
 * @param {number|null} [ctx.targetPrintRun]  the checklist target's own /N,
 *        for the refusal message only.
 */
function decideSaleAction(sale, shape, ctx) {
  const { shortId, numberedId, titlePrintRun, targetPrintRun } = ctx;

  // RULING (review, 2026-09-19): the split-identity question is now answered
  // by ONE shared classifier (classifySaleForRelocation, above), reached
  // identically from either query shape, rather than a guard that only
  // caught the case where NEITHER field named the shortId. See that
  // function's own header for the four allowed shapes and why everything
  // else -- including cardId === shortId with hobbyiqCardId naming a
  // DIFFERENT hiq: slug (a different LIVE target under concurrency, or any
  // other pre-existing split) -- refuses from whichever side reaches it.
  const classified = classifySaleForRelocation(sale, { shortId, numberedId });
  if (!classified.ok) {
    return { action: "refuse", reason: "split-identity", detail: `cardId=${classified.cardId} hobbyiqCardId=${classified.hobbyiqCardId} -- these do not agree on being exactly {${shortId}, ${numberedId}}; pre-existing split, not this lane's to fix` };
  }

  // THE ONE TITLE/PRINT-RUN RULE (#2298's own gate, reused rather than
  // reimplemented): persistVendorSalesToPool.service.ts:1656 only calls the
  // ingest upgrade `if (!parsed.printRun)` -- absent beats wrong. A stored
  // sale whose TITLE states a print run at all (whether or not it agrees with
  // the checklist's N) is left exactly where it is: either it was ingested
  // before #2298 existed and belongs to a DIFFERENT repair, or it is itself
  // evidence of a rival print run this identity's target does not carry.
  //
  // SHOULD-FIX 3 (#2314 review): `titlePrintRun` alone is `extractPrintRun`'s
  // slash-only answer, which misses PROSE ("Numbered to 50", "SN50", "1 of
  // 1") -- `titleStatesProsePrintRun` is the shared conservative detector
  // (foldTwinRuleChecklistNumbered.ts, same one #2298's ingest upgrade now
  // calls) ORed in here as the SAME refusal, not a second rule: "the title
  // states a print run" is one question, answered by two readings of it.
  if (titlePrintRun || ctx.titleStatesProsePrintRun) {
    return {
      action: "refuse", reason: "title-states-print-run",
      detail: `title states${titlePrintRun ? ` /${titlePrintRun}` : " a print run in prose"}${targetPrintRun && titlePrintRun && titlePrintRun !== targetPrintRun ? ` (checklist target is /${targetPrintRun})` : ""} -- absent beats wrong, left at ${shape === "cardId" ? String(sale.cardId ?? "") : String(sale.hobbyiqCardId ?? sale.cardId ?? "")}`,
    };
  }

  // TITLE-CONTRADICTION VETO (review, 2026-09-19): computed once per sale at
  // the call site (titleContradictsTarget, in main()) and handed in the same
  // way titlePrintRun already is, so this function stays pure and I/O-free
  // and REPORT/APPLY still run the identical decision. Refuses in BOTH
  // shapes -- a title that contradicts the checklist target is evidence this
  // sale never belonged there, whether it was found by cardId or
  // hobbyiqCardId.
  if (ctx.titleContradiction && ctx.titleContradiction.contradicts) {
    return {
      action: "refuse", reason: "title-contradicts-target",
      detail: `${ctx.titleContradiction.detail} -- refused, not laundered onto a checklist-backed address (rule: ${ctx.titleContradiction.rule})`,
    };
  }

  // `classified.action` and `shape` always agree (shape "cardId" only ever
  // classifies "relocate"; shape "hobbyiqCardId" only ever classifies
  // "patch") -- classifySaleForRelocation's own shape (1)/(3)/(4) require
  // cardId === shortId (which is only how the cardId-shape query finds a
  // row), and shape (2) requires hobbyiqCardId === shortId with a non-hiq:
  // cardId (only how the hobbyiqCardId-shape query finds a row, since that
  // query explicitly excludes cardId === shortId). `shape` is kept as the
  // return value's own source of truth rather than `classified.action`
  // because it is what the two call sites already branch their OWN
  // shape-specific write code on (upsert+delete vs. a plain patch) -- this
  // is not a second decision, just naming which one classify already made.
  return shape === "cardId"
    ? { action: "relocate", newId: numberedId }
    : { action: "patch", newId: numberedId };
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  REPOINT: sales at the short (un-numbered) id follow the checklist's :num-N row");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  if (SCOPE_REJECTED.length) {
    console.error("");
    console.error(`FATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are not cells: ${SCOPE_REJECTED.join(", ")}`);
    console.error("       A cell looks like baseball:2026 (sport:year).");
    process.exit(2);
  }
  if (!SCOPE_CELLS.length || RAW_SCOPE.some((x) => INHERITED_SCOPES.has(lower(x)))) {
    console.error("");
    console.error("FATAL: SCOPE is REQUIRED and names the cells to scan, as sport:year.");
    console.error("       There is no 'all' for this lane. Dispatch with -f scope=baseball:2026,baseball:2025");
    console.error("       (comma-separate for several cells).");
    process.exit(2);
  }
  if (!SET_KEYS.length) {
    console.error("");
    console.error("FATAL: SET_KEYS (the runner's `titles` input) is REQUIRED and names the");
    console.error("       setKey(s) to scan for checklist-numbered rows -- an empty value or a");
    console.error("       wildcard ('all', '*') is refused: a whole-source write needs its own name.");
    console.error("       Dispatch with -f titles=topps (comma-separate for several).");
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const {
    identityKeyOf, pickChecklistNumberedTarget, printRunOf, shortIdChecklistVeto, statesProsePrintRun, DEFAULT_FORCE_AUTO_PREFIXES,
  } = require(path.join(backend, "dist/services/catalog/foldTwinRuleChecklistNumbered.js"));
  const { parseListingIdentity, inferSetKeyFromTitle } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { relocateSoldComp, stripSystem, contentHashOf, is412 } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));

  // TITLE-CONTRADICTION VETO (review, 2026-09-19): every helper reused
  // read-only, EXISTING title machinery -- none of these five files is a
  // declared derivation-stamp input (scripts/lib/derivation-version.cjs's
  // DERIVATION_INPUTS names parseTitleIdentity.service.ts and
  // hobbyIqCardId.service.ts among the six, but only their EXPORTED
  // functions are called here, nothing in them is edited).
  const { extractCardNumberFromTitle } = require(path.join(backend, "dist/services/portfolioiq/soldCompsStore.service.js"));
  const { sameCardNumber, slugify, foldCardNumber } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { isRegisteredProduct } = require(path.join(backend, "dist/services/catalog/resolveProductByChecklist.js"));
  const { productAncestry } = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
  const { statedFinishFromChecklist } = require(path.join(backend, "dist/services/portfolioiq/statedFinishFromChecklist.js"));
  const { parallelTheTitleAllows } = require(path.join(backend, "dist/services/portfolioiq/titleOutranksVendorTag.js"));
  const { playerTheTitleAllows, playerNameKey } = require(path.join(backend, "dist/services/portfolioiq/playerTheTitleAllows.js"));
  const { cleanPlayerName } = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));
  const { playerIdentityKey } = require(path.join(backend, "dist/services/catalog/playerIdentityKey.js"));
  // guessPlayerFromTitle (persistVendorSalesToPool.service.ts:2867) is not
  // exported; this mirrors its EXACT pattern (lazy require of the same
  // compiled parser, same .playerName?.trim() read, same fail-to-null),
  // rather than reimplementing a title-to-player reader.
  //
  // LOCAL CONFIDENCE FLOOR (found while testing this veto, 2026-09-19):
  // measured -- parseCardQuery("plain") returns { playerName: "Plain",
  // confidence: 0 }, i.e. its OWN fallback treats an unparseable single word
  // as if it named a player, with confidence 0 flagging exactly that it has
  // no real evidence. `guessPlayerFromTitle`'s shipped pattern does not
  // check `confidence` at all (grepped: no caller of parseCardQuery in this
  // repo gates on it either), which is an accepted risk on a REAL eBay title
  // that rarely reduces to one word -- but this veto's OWN refusal is
  // exactly the shape that turns a garbage title into a false contradiction
  // rather than "no evidence, don't refuse." So this LOCAL copy adds a
  // `confidence > 0` floor on top of the shared reader's own output --
  // reading a field parseCardQuery already returns, never editing
  // cardQueryParser.js itself -- the same "local adjustment over a shared
  // reader" precedent insertSetChecklistConfirm.ts already sets for
  // cardNumberVariants's own leading-zero fold.
  function guessPlayerFromTitleLocal(title) {
    try {
      const { parseCardQuery } = require(path.join(backend, "dist/services/compiq/cardQueryParser.js"));
      const parsed = parseCardQuery(String(title || ""));
      if (!parsed || !(Number(parsed.confidence) > 0)) return null;
      const player = parsed.playerName;
      return typeof player === "string" && player.trim().length > 0 ? player.trim() : null;
    } catch { return null; }
  }

  const isChecklist = (source) => catalogAuthorityOf(source) === "checklist";

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");
  const portfolio = db.container("portfolio");

  console.log(`  scope (${SCOPE_CELLS.length} cell${SCOPE_CELLS.length === 1 ? "" : "s"})    ${SCOPE_CELLS.join(", ")}`);
  console.log(`  target setKeys   ${SET_KEYS.join(", ")}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");
  console.log("  drives from card_catalog's checklist-numbered rows; the SHORT id is the");
  console.log("  target's own id with only the trailing :num-N segment removed. Sales at that");
  console.log("  short id -- whether or not a catalog twin also lives there -- are found by");
  console.log("  BOTH addresses sold_comps uses (cardId partition, hobbyiqCardId equality) and");
  console.log("  relocated or patched onto the checklist's numbered id.");
  console.log("");

  const s = {
    catalogRowsScanned: 0, otherShard: 0,
    identityGroups: 0, uniqueNumberedTargets: 0, ambiguousRivalRuns: 0, noChecklistNumbered: 0,
    shortIdsExamined: 0, shortIdsWithCatalogTwin: 0,
    // BLOCKER 1 (review, 2026-09-19): a checklist row AT the short id is a
    // DIFFERENT card (a partial print-run ladder), never a twin to move past.
    // The whole target -- every sale under it -- is refused when this fires.
    targetsVetoedShortIdChecklistBacked: 0,
    salesFoundByCardId: 0, salesFoundByHobbyiqCardId: 0,
    salesRelocated: 0, salesPatched: 0,
    // BLOCKER 2 (review, 2026-09-19): a resident document already sits at the
    // relocate destination (sale ids are `{source}::{externalId}`, which does
    // not embed cardId, so the same id can already exist at the numbered
    // partition -- written there by #2298's own ingest upgrade on a
    // re-scrape, or a prior partial run). Same sale (by content hash) ->
    // collapse; different sale -> refuse, move nothing.
    collapsedOntoResident: 0,
    refusedTitlePrintRun: 0, refusedSplitIdentity: 0, refusedGuardParked: 0, refusedDestinationCollision: 0,
    // LAST-LINE DEFENCE (review, 2026-09-19): the source doc changed (or
    // vanished from its planned address) between this target's planning
    // read and the point it was about to write -- a re-read-before-write
    // refusal, never a decision made on stale data.
    refusedEtagChanged: 0,
    // TITLE-CONTRADICTION VETO (review, 2026-09-19): a sale whose OWN title
    // names a different card number, product, parallel, or player than the
    // checklist target -- refused rather than laundered onto a
    // checklist-backed address on the strength of the address alone.
    refusedTitleContradiction: 0,
    salesFailed: 0, salesLeftAlone: 0,
    holdingsRepointed: 0, holdingsWalked: 0, holdingDocsWalked: 0,
    // RULING (review, 2026-09-19): a holding whose cardId/hobbyiqCardId
    // disagree on being exactly this target's {shortId, numberedId} pair --
    // the SAME split-identity question a sale gets, applied before a
    // holding write rather than after one that would have destroyed the
    // correct side of the split.
    holdingsRefusedSplitIdentity: 0,
    notReached: 0,
    // SHOULD-FIX 4 (review, 2026-09-19): the cross-partition hobbyiqCardId
    // query is the one whose cost scales with pool size rather than with the
    // catalog's own bounded scan, so a REPORT pilot must show its true price
    // before any wider scope is dispatched.
    hobbyiqCardIdQueries: 0,
    // CONCURRENCY (review, 2026-09-19): every retryable 429/503/timeout hit
    // across every worker, so a wider CONCURRENCY dispatch shows its own
    // throttle cost in the banner rather than only in the retry backoff.
    throttled: 0,
    // RULING (review, 2026-09-19): a split-identity sale can be FOUND by two
    // different targets -- cardId===shortA reaches it via one target's
    // shape-1 query, hobbyiqCardId===shortB reaches the SAME document via
    // another target's shape-2 query. Both finds are real (the queries did
    // return the row twice, once per target), but it is the SAME document,
    // so it is counted ONCE in `salesFoundByCardId`/`salesFoundByHobbyiqCardId`
    // via the raw query-hit counts (those are per-shape metrics and stay
    // exactly what they always were) and this counter is the CORRECTION
    // applied to the CF-A-SALE-IS-NEVER-LOST reconciliation's own
    // `salesBefore`, so "sales at short ids before" counts DOCUMENTS, not
    // query hits. See the reconciliation section below for the subtraction.
    salesFoundDuplicateAcrossTargets: 0,
  };
  const hobbyiqCardIdQueryMs = [];
  const bySetKey = new Map();
  const byYear = new Map();
  const refusals = { "title-states-print-run": [], "split-identity": [], "guard-parked": [], "destination-collision": [], "stale-since-plan": [], "title-contradicts-target": [] };
  const vetoedTargets = [];
  const collapsedExamples = [];
  const failures = [];
  const examples = [];
  const ambiguousExamples = [];
  const twinExamples = [];
  const splitHoldingExamples = [];
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  // RULING (review, 2026-09-19): every sale doc this run's queries have
  // touched, keyed by its OWN current `(id, cardId)` address -- the one
  // stable identity a document has regardless of which target's query (or
  // which of the two shapes) found it. A key already in this set when a
  // target's loop reaches it means SOME OTHER target already found this
  // EXACT document; that can only happen for a split-identity sale (proven
  // in classifySaleForRelocation's own header: every non-split shape ties a
  // document to exactly one target's {shortId, numberedId} pair), so the
  // decision is unaffected -- classifySaleForRelocation already refuses it
  // independently from either side -- but the REFUSAL COUNTERS and the
  // reconciliation's `salesBefore` must not double-count the same document.
  // A plain Map (not per-target), because "found by two different targets"
  // is a cross-target fact by definition and only means anything checked
  // against the WHOLE run's finds, not one target's own.
  const seenSaleAddresses = new Map(); // "id::cardId" -> count of targets that found it
  const saleAddressKey = (sale) => `${sale.id}::${sale.cardId}`;
  /** Marks `sale` as found by the CURRENT target's query, and reports
   *  whether this is the FIRST target to find it (`firstSighting: true`) or
   *  a document some other target already claimed (`firstSighting: false`,
   *  `duplicate: true`). Every call increments `salesFoundDuplicateAcrossTargets`
   *  by exactly the amount needed so `salesFoundByCardId + salesFoundByHobbyiqCardId
   *  - salesFoundDuplicateAcrossTargets` equals the number of DISTINCT
   *  documents found across the whole run, however many targets found each
   *  one. */
  function noteSaleFound(sale) {
    const key = saleAddressKey(sale);
    const n = (seenSaleAddresses.get(key) ?? 0) + 1;
    seenSaleAddresses.set(key, n);
    if (n > 1) s.salesFoundDuplicateAcrossTargets++;
    return { duplicate: n > 1 };
  }
  let stoppedAtBudget = false;

  // ── Holdings index, built ONCE (fold-checklist-numbered-twins' own shape).
  // portfolio.holdings is a MAP: Object.entries, never JOIN h IN c.holdings.
  //
  // RULING (review, 2026-09-19): each entry now carries the holding's OWN
  // cardId/hobbyiqCardId (not just its docId/userId/holdingId), so
  // repointHoldings can run the SAME split-identity classification a sale
  // gets before writing -- a holding whose two id fields name different
  // cards is not this lane's to fix either, and blindly overwriting BOTH
  // fields with `newId` (the pre-ruling code) is exactly the same destroy-
  // the-correct-side defect as the sale path had.
  async function buildHoldingsIndex() {
    const index = new Map();
    let docs = 0;
    await forEachPage(portfolio, { query: "SELECT c.id, c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)", parameters: [] }, async (rows) => {
      for (const doc of rows) {
        docs++;
        const holdings = doc.holdings && typeof doc.holdings === "object" ? doc.holdings : null;
        if (!holdings) continue;
        for (const [hid, h] of Object.entries(holdings)) {
          s.holdingsWalked++;
          if (!h || typeof h !== "object") continue;
          const hCardId = String(h.cardId ?? "");
          const hHobbyiqCardId = String(h.hobbyiqCardId ?? hCardId);
          for (const slug of new Set([hHobbyiqCardId, hCardId])) {
            if (!slug) continue;
            const list = index.get(slug) ?? [];
            list.push({ docId: doc.id, userId: doc.userId, holdingId: hid, cardId: hCardId, hobbyiqCardId: hHobbyiqCardId });
            index.set(slug, list);
          }
        }
      }
      return true;
    }, 100);
    s.holdingDocsWalked = docs;
    if (docs === 0) throw new Error("walked ZERO portfolio docs -- refusing to claim holdings are clean");
    console.log(`  holdings index: walked ${f(s.holdingsWalked)} holdings across ${f(docs)} portfolio docs; ${f(index.size)} distinct slugs held`);
    return index;
  }
  const holdingsIndex = await buildHoldingsIndex();

  // RULING (review, 2026-09-19): the SAME cross-target dedup a sale's split
  // refusal gets (see `noteSaleFound`/`seenSaleAddresses` above) -- a holding
  // whose cardId names live target A's shortId and hobbyiqCardId names live
  // target B's shortId is indexed under BOTH slugs in `holdingsIndex`, so
  // `repointHoldings` is called once by EACH target and would otherwise
  // count and list the SAME holding's split refusal twice. Keyed by
  // `(docId, holdingId)` -- the one stable identity a holding has regardless
  // of which target's call reached it.
  const seenHoldingSplitRefusal = new Set();

  async function repointHoldings(oldId, newId) {
    const hits = holdingsIndex.get(oldId);
    if (!hits || !hits.length) return;
    const byDoc = new Map();
    for (const h of hits) {
      // RULING (review, 2026-09-19): the SAME classifier a sale gets, applied
      // to the holding's own {cardId, hobbyiqCardId} pair against THIS
      // target's {shortId=oldId, numberedId=newId}. A holding whose two
      // fields disagree on being exactly that pair is a split -- counted and
      // left untouched, exactly as a split sale is, from whichever side
      // (cardId===oldId or hobbyiqCardId===oldId) reached it.
      const classified = classifySaleForRelocation({ cardId: h.cardId, hobbyiqCardId: h.hobbyiqCardId }, { shortId: oldId, numberedId: newId });
      if (!classified.ok) {
        const holdingKey = `${h.docId}::${h.holdingId}`;
        if (!seenHoldingSplitRefusal.has(holdingKey)) {
          seenHoldingSplitRefusal.add(holdingKey);
          s.holdingsRefusedSplitIdentity++;
          if (splitHoldingExamples.length < 20) {
            splitHoldingExamples.push(`  ${h.docId}/${h.holdingId}: cardId=${classified.cardId} hobbyiqCardId=${classified.hobbyiqCardId} -- pre-existing split, not repointed (target ${oldId} -> ${newId})`);
          }
        }
        continue;
      }
      const k = `${h.docId}|${h.userId}`;
      const e = byDoc.get(k) ?? { docId: h.docId, userId: h.userId, ids: new Set() };
      e.ids.add(h.holdingId);
      byDoc.set(k, e);
    }
    for (const { docId, userId, ids } of byDoc.values()) {
      const ops = [];
      for (const hid of ids) {
        ops.push({ op: "set", path: `/holdings/${hid}/hobbyiqCardId`, value: newId });
        ops.push({ op: "set", path: `/holdings/${hid}/cardId`, value: newId });
        ops.push({ op: "set", path: `/holdings/${hid}/identityResolvedBy`, value: "repoint-sales-to-checklist-numbered" });
        ops.push({ op: "set", path: `/holdings/${hid}/identityResolvedAt`, value: new Date().toISOString() });
        ops.push({ op: "set", path: `/holdings/${hid}/identityRenamedFrom`, value: oldId });
      }
      if (APPLY) await retry(() => portfolio.item(docId, userId).patch(ops));
      s.holdingsRepointed += ids.size;
    }
    holdingsIndex.delete(oldId);
  }

  /** Does a catalog row already live at the short id? Point read, memoised --
   *  this lane never touches it, only reports it (the twins lane's job).
   *
   *  CONCURRENCY (review, 2026-09-19): the cache stores the in-flight PROMISE,
   *  not the resolved value -- set into the Map SYNCHRONOUSLY, before the
   *  first `await`. Every concurrent target's shortId is already provably
   *  unique (see processTarget's own header comment: distinct identity groups
   *  produce distinct target ids, hence distinct shortIds), so today no two
   *  workers ever call this with the SAME shortId and there is no live TOCTOU
   *  to close. This is nonetheless made promise-safe rather than
   *  value-safe: a value-cached version has a window between "await the
   *  Cosmos read" and "store the result" during which a second caller for the
   *  SAME key would see a cache miss and issue its own read -- a real
   *  double-read (and, if this cache is ever reused for a write-through
   *  value, a double-write) if a future caller ever legitimately re-enters
   *  the same shortId mid-flight. Caching the promise closes that window by
   *  construction: the second caller awaits the FIRST caller's in-flight
   *  request instead of starting a new one. */
  const twinCache = new Map();
  async function catalogTwinAt(shortId) {
    if (twinCache.has(shortId)) return twinCache.get(shortId);
    const p = (async () => {
      try { return (await retry(() => cat.item(shortId, shortId).read())).resource ?? null; }
      catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
    })();
    twinCache.set(shortId, p);
    try { return await p; }
    catch (e) { twinCache.delete(shortId); throw e; } // a real failure must not poison the cache for a retry
  }

  /** The title/print-run signal for one sale, computed exactly once per sale
   *  at the call site -- see decideSaleAction's own doc for why this is
   *  handed in rather than computed inside the pure function. Fails open
   *  (null) on a parser throw: a title this lane cannot parse is not
   *  evidence of a print run, and failing closed here would strand sales
   *  behind a parser bug rather than moving them. */
  function titlePrintRunOf(sale, shortId) {
    try {
      const parsed = parseListingIdentity(String(sale.title ?? ""), undefined, {
        vertical: sale.sport ?? null, hobbyiqCardId: shortId,
      });
      return parsed?.printRun ?? null;
    } catch { return null; }
  }

  /**
   * CARD-NUMBER PREFIX EXEMPTION (review, 2026-09-19 false-positive pass).
   * `sameCardNumber` is an EQUALITY test (folds case AND hyphens, then
   * compares byte-for-byte) -- exactly right for "is this the same number",
   * wrong for "does the title's number CONTRADICT the target's", because a
   * title that states only the parent code of a hyphenated insert number
   * (#90ASC on a #90ASC-3 target, #90B2 on a #90B2-39 target) or the
   * checklist's bare number where the title carries an extra hyphenated
   * suffix (#19-SP on a #19 target) is not naming a different card -- it is
   * naming the SAME ladder at a coarser or finer grain than the checklist.
   * Measured: 312 of the run's refusals are this shape, ALL of them one code
   * being the other PLUS a trailing "-something" `sameCardNumber`'s own fold
   * already discards by removing every hyphen before comparing.
   *
   * Normalizes case/whitespace but DELIBERATELY KEEPS hyphens (unlike
   * `foldCardNumber`) so the hyphen position itself -- not a character-class
   * guess reconstructed after it is gone -- decides the boundary: "the
   * shorter code, plus a literal hyphen, is a PREFIX of the longer one".
   * This is why "90B2" vs "90B2-39" (both sides end in a DIGIT, so any
   * digit/letter-transition heuristic on the folded strings alone cannot
   * tell this apart from "6" vs "61") still exempts correctly -- the hyphen
   * that marks the boundary is read directly, not inferred.
   *
   * Deliberately NOT exempted: a prefix with no hyphen at the join point
   * ("6" vs "61" -- "61" is not "6-something") and a title/target pair that
   * are simply DIFFERENT numbers throughout ("61" vs "125") -- those still
   * contradict, per the review's own example.
   */
  function normalizeKeepHyphens(raw) {
    return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "");
  }
  function isHyphenSuffixOf(shorter, longer) {
    return Boolean(shorter) && longer.length > shorter.length && longer.startsWith(`${shorter}-`);
  }

  /**
   * True when the title's stated number and the target's number are the
   * SAME print-run ladder at different grains -- one hyphen-preserved,
   * case-normalized code is the other plus a trailing "-suffix" (either
   * direction), OR the target's own folded number appears verbatim
   * somewhere in the title's full text (the extractor grabbed the wrong
   * token, but the real target number is still stated). Never true for two
   * codes that are simply unrelated numbers.
   */
  function cardNumberIsUnderSpecified(titleCardNumber, targetCardNumber, fullTitle) {
    const nt = normalizeKeepHyphens(titleCardNumber);
    const ng = normalizeKeepHyphens(targetCardNumber);
    if (!nt || !ng) return false;
    if (isHyphenSuffixOf(nt, ng) || isHyphenSuffixOf(ng, nt)) return true;
    const foldedTitleText = foldCardNumber(fullTitle);
    const foldedTarget = foldCardNumber(targetCardNumber);
    return Boolean(foldedTarget) && foldedTitleText.includes(foldedTarget);
  }

  /**
   * TITLE-CONTRADICTION VETO (review, 2026-09-19, audit of tonight's 107
   * serial relocations: 4 of them carried a sale onto a checklist-backed
   * address the sale's OWN title contradicts -- "Aaron Judge 2026 Donruss
   * Elite Orange Foil #61" relocated onto a Topps purple-holo-foil row,
   * "2025-26 Topps Match Attax Ace Bailey #125 Rare Purple SP" onto an
   * image-variation row, etc. This lane must not launder a mis-identified
   * sale onto a checklist-backed address just because it happened to sit at
   * the short id first.
   *
   * NO NEW PARSER. Every check below reuses EXISTING, ALREADY-SHIPPED title
   * machinery, read-only:
   *   (a) card number   -- extractCardNumberFromTitle + sameCardNumber
   *                         (soldCompsStore.service.ts / hobbyIqCardId.service.ts,
   *                         the SAME case/hyphen-insensitive comparison the
   *                         confirm module (insertSetChecklistConfirm.ts) uses)
   *   (b) product/setKey -- inferSetKeyFromTitle (parseTitleIdentity.service.ts,
   *                         the ~40-brand-regex reader every reslug/repair
   *                         script already imports) + isRegisteredProduct /
   *                         productAncestry (resolveProductByChecklist.ts /
   *                         productSetKeys.ts, R29's own registry)
   *   (c) parallel/finish -- statedFinishFromChecklist (statedFinishFromChecklist.ts),
   *                         the checklist-corpus reader that reports ONLY a
   *                         finish name actually witnessed in the title
   *   (player) -- NO new reader written for this either. "R69"/"clean-share
   *                         judge" named in the original review does not
   *                         exist under that name anywhere in this repo
   *                         (verified: no match for R69 or clean-share/cleanShare
   *                         in backend/src or backend/scripts). The real
   *                         shipped equivalent is playerTheTitleAllows
   *                         (playerTheTitleAllows.ts), already the production
   *                         ingest-time player-contradiction gate -- reused
   *                         here the SAME way persistVendorSalesToPool.service.ts
   *                         calls it, paired with a LOCAL mirror of that same
   *                         file's un-exported guessPlayerFromTitle (lazy
   *                         require of dist/services/compiq/cardQueryParser.js,
   *                         identical read). This is reuse, not a new player
   *                         reader -- the review's own "if it lives only in a
   *                         scratchpad, skip player" caveat does not apply,
   *                         since playerTheTitleAllows is compiled, exported,
   *                         and already the production decision. A SUBSET
   *                         exemption sits in front of it as of the
   *                         2026-09-20 false-positive pass (see the call
   *                         site below) -- see that comment for why
   *                         `playerTheTitleAllows` alone over-refused.
   *
   * NONE of the six derivation-stamp inputs (scripts/lib/derivation-version.cjs
   * DERIVATION_INPUTS) are edited by this lane -- parseTitleIdentity.service.ts
   * and hobbyIqCardId.service.ts are two of the six, and only their EXPORTED
   * functions are CALLED here (inferSetKeyFromTitle, sameCardNumber, slugify),
   * exactly the "read from it, never patch it" precedent
   * insertSetChecklistConfirm.ts already sets for the same file.
   *
   * PRODUCT DIRECTION (a judgment call the review's own examples force,
   * documented so it is not silently different from the review's prose).
   * The review's literal text exempts "the target setKey or its registered
   * parent/child" SYMMETRICALLY, but its own example 3 --
   * "Topps Allen & Ginter X #225" relocated onto a plain `topps` row -- is a
   * title-inferred key (topps-allen-ginter) that IS a registered CHILD of the
   * target (topps) under a symmetric reading, and a symmetric exemption would
   * therefore never refuse it, contradicting the example. Measured: every
   * specialized product (topps-chrome, topps-heritage, topps-allen-ginter,
   * bowman-chrome, ...) registers with `parent: <flagship>`, so a symmetric
   * "target's parent or child" exemption would ALSO exempt a title that reads
   * as a MORE SPECIFIC product than a flagship target -- exactly backwards
   * from what a contradiction veto should catch. The examples, not the prose,
   * are the ground truth here: the exemption is DIRECTIONAL --
   *   - titleKey IS an ancestor of targetSetKey (title under-specifies a
   *     more-specific address, e.g. a lazy "Topps" title on a topps-chrome
   *     row) -- EXEMPT, the common and expected shape;
   *   - titleKey IS a DESCENDANT of targetSetKey (title claims a MORE
   *     specific product than the address, e.g. "Allen & Ginter" on a plain
   *     topps row) -- REFUSE, this is example 3's own shape;
   *   - unrelated entirely (Donruss Elite vs Topps, example 1) -- REFUSE.
   * `productAncestry` (one exported function, called twice with the
   * arguments swapped) is the whole primitive both directions need; nothing
   * new is invented past it.
   *
   * WHY EXAMPLE 2 (Match Attax) IS CAUGHT BY (b), THE PRODUCT RULE -- AND
   * WOULD ALSO BE CAUGHT BY (c) IF IT WERE NOT. Measured:
   * inferSetKeyFromTitle("...Topps Match Attax Ace Bailey #125 Rare Purple
   * SP") returns "topps-match-attax-uefa", whose registered parent IS
   * "topps" -- i.e. it IS a registered child of the target, which is exactly
   * the DESCENDANT-of-target shape the directional rule above refuses (a
   * title claiming a more specific product than the address). Rules run in
   * a fixed order (card-number, product, parallel, player) and the FIRST
   * one that fires wins, so this refuses on `rule: "product"` before the
   * parallel check ("Purple" != the target's Image Variation finish) ever
   * runs. Both signals independently agree this title contradicts the
   * target -- this is not a case where the rules disagree on the verdict,
   * only on which one gets to name it.
   *
   * WHY EXAMPLE 4 IS NOT CAUGHT AT ALL, ON PURPOSE. "2025 TOPPS #700
   * Kristian Campbell SHORT PRINTS SERIES 2" states card #700 (agrees),
   * infers plain "Topps" (agrees, same key as target), and
   * statedFinishFromChecklist returns null for "Short Print"/"Series 2"
   * against an image-variation target -- measured, in every phrasing tried.
   * readVariationFromTitle (variationVocabulary.ts) DOES read a "short-print"
   * MARKER off this exact title, but parallelTheTitleAllows's own documented
   * rule (D22, CF-A-VARIATION-IS-A-CARD) treats a bare SP/SSP marker as
   * CORROBORATING an image-variation tag, never contradicting it -- measured:
   * parallelTheTitleAllows(null, "Image Variation", { variationMarker:
   * "short-print" }) returns { vendorTagOverruled: null }, i.e. agreement.
   * So the existing, shipped machinery genuinely cannot distinguish this
   * one from a normal image-variation short print, and the review's own
   * caveat ("if it cannot, leave (c) to number/product") applies exactly:
   * number and product both agree, so (c) is the only rule that COULD catch
   * it, and it correctly does not. This is a known, accepted gap, pinned by
   * its own test below (asserting today's behaviour: NOT refused) rather
   * than silently left untested.
   *
   * Returns `{ contradicts: false }` or `{ contradicts: true, rule, detail }`
   * -- `rule` is one of "card-number" | "product" | "parallel" | "player",
   * for the refusal detail and the pinned tests. Never throws: every reader
   * called here already fails open to null/false on its own, and this
   * function adds no further parsing of its own past them.
   */
  function titleContradictsTarget(sale, target, parallelsByCardNumber) {
    const title = String(sale.title ?? "");
    if (!title.trim()) return { contradicts: false };

    // (a) CARD NUMBER -- extractCardNumberFromTitle + sameCardNumber, the
    // SAME case/hyphen-insensitive comparison the confirm module uses, widened
    // by the boundary-prefix exemption above: a title stating only the
    // parent code of a hyphenated insert number (#90ASC on a #90ASC-3
    // target), or the checklist's bare number where the title carries an
    // extra suffix (#19-SP on a #19 target), is the SAME ladder at a coarser
    // or finer grain -- not a different card -- and is not refused here.
    const titleCardNumber = extractCardNumberFromTitle(title);
    if (
      titleCardNumber && target.cardNumber
      && !sameCardNumber(titleCardNumber, target.cardNumber)
      && !cardNumberIsUnderSpecified(titleCardNumber, target.cardNumber, title)
    ) {
      return { contradicts: true, rule: "card-number", detail: `title states #${titleCardNumber}, target is #${target.cardNumber}` };
    }

    // (b) PRODUCT/SETKEY -- inferSetKeyFromTitle + the R29 registry's own
    // ancestry primitive, directional (see this function's own header for
    // why: an ancestor-of-target title is a common under-specified silence,
    // never a contradiction; a descendant-of-target title claims a MORE
    // specific product than the address and IS a contradiction).
    const inferred = inferSetKeyFromTitle(title, target.cardNumber ?? undefined);
    const titleSetKey = inferred && inferred !== "Unknown" ? slugify(inferred) : "";
    const targetSetKey = slugify(String(target.setKey ?? ""));
    if (titleSetKey && targetSetKey && isRegisteredProduct(titleSetKey) && titleSetKey !== targetSetKey) {
      const titleIsAncestorOfTarget = productAncestry(targetSetKey).includes(titleSetKey);
      if (!titleIsAncestorOfTarget) {
        return { contradicts: true, rule: "product", detail: `title names product "${inferred}" (${titleSetKey}), target is "${target.setKey}" (${targetSetKey}) -- neither the same product nor an under-specified ancestor of it` };
      }
    }

    // (c) PARALLEL/FINISH -- statedFinishFromChecklist, product-scoped by
    // the target's own setKey/year so the checklist corpus consulted is the
    // target's own, THEN parallelTheTitleAllows (titleOutranksVendorTag.ts)
    // to judge agreement vs contradiction -- the SAME refinement logic
    // repair-parallel-from-title.cjs already reuses, rather than a hand-
    // rolled word-overlap check. `vendorTagOverruled` (non-null) is exactly
    // "the title's finish contradicts the target's own tag" -- a refinement
    // either way ("Gold Refractor" vs "Gold", "Purple" vs "Purple Holo Foil")
    // returns null (agreement/respelling, never a contradiction). Silence
    // (statedFinishFromChecklist returns null) never reaches this call at
    // all -- the guard below skips it, matching the review's own caveat
    // ("if it cannot [distinguish], leave (c) to number/product").
    const titleFinish = statedFinishFromChecklist(title, { setKey: target.setKey ?? null, year: target.year ?? target.cardYear ?? null });
    if (titleFinish) {
      const finishDecision = parallelTheTitleAllows(titleFinish, String(target.parallelSlug ?? "Base"));
      if (finishDecision.vendorTagOverruled) {
        // BARE-COLOUR UNDER-SPECIFICATION EXEMPTION (review, 2026-09-19
        // false-positive pass, 76 of the run's refusals, ALL cardhedge rows:
        // "Gold" vs "gold-diamante-foil", "Orange" vs "orange-diamante-foil").
        // parallelTheTitleAllows's own vendorAddsADifferentFinishFamily guard
        // exists to stop "Green" adopting an UNRELATED finish family ("Green
        // Wave", "Green Shimmer") -- correct when a checklist genuinely has
        // several distinct green-family rungs. It over-applies to a terse
        // CardHedge product-record title that NEVER carries the compound
        // finish name at all -- measured against 20 of the refused titles
        // directly: bare colour, no "Diamante"/"Foil" token anywhere, a
        // known CardHedge title shape, not a truncation of a fuller title
        // the parser failed to read.
        //
        // The distinguishing fact this lane CAN see cheaply (no new I/O --
        // `parallelsByCardNumber` is built once per cell from the SAME
        // catalog rows already scanned into `groups`, see the call site):
        // does this card NUMBER carry more than one rung on this exact
        // ladder? A bare "Gold" is safely under-specified only when the
        // number's checklist has exactly ONE gold-family rung to mean --
        // if it ALSO carries a plain "gold" rung alongside "gold-diamante-
        // foil", "Gold" is genuinely ambiguous between them and this stays
        // refused (absent beats wrong), per the review's own caveat.
        const titleFinishTokens = slugify(titleFinish).split("-").filter(Boolean);
        const targetTokens = slugify(String(target.parallelSlug ?? "Base")).split("-").filter(Boolean);
        const isTokenSubsetOfCompound = titleFinishTokens.length > 0 && targetTokens.length > titleFinishTokens.length
          && titleFinishTokens.every((t) => targetTokens.includes(t));
        const cardNumberKey = String(target.cardNumber ?? "").trim().toLowerCase();
        const siblingRungs = parallelsByCardNumber instanceof Map ? parallelsByCardNumber.get(cardNumberKey) : null;
        const onlyOneRungOnThisLadder = !siblingRungs || siblingRungs.size <= 1;
        if (isTokenSubsetOfCompound && onlyOneRungOnThisLadder) {
          // Under-specified, not contradicting -- fall through without refusing.
        } else {
          return { contradicts: true, rule: "parallel", detail: `title states finish "${titleFinish}", target is "${target.parallelSlug ?? "Base"}"` };
        }
      }
    }

    // (player) -- playerTheTitleAllows, the same production ingest-time
    // gate, fed by the SAME title reader guessPlayerFromTitle uses.
    // "irreconcilable" is the ONLY outcome that refuses here: every other
    // outcome (agree, vendor-only, title-only, neither) is a normal case
    // this lane's own move must not second-guess.
    //
    // PLAYER FALSE-POSITIVE EXEMPTION (review, 2026-09-19 false-positive
    // pass, 61 of the run's refusals): playerTheTitleAllows compares the two
    // NAMES verbatim (playerNameKey strips only jr/sr/ii/iii/iv/v), but the
    // catalog's stored playerName still carries checklist markers --
    // "Mason Montgomery RC", "Andy Pages FS" -- that the title's own guess
    // never states, and the title-side extraction is itself a loose parse
    // that can grab an EXTRA trailing token the vendor's structured field
    // never had ("Roki Sasaki Ff Nyc", "Salvador Ff Nyc" against a catalog
    // "Roki Sasaki RC" / "Salvador Perez"). Neither side is wrong; the
    // stored marker and the parser's noise are both real, unrelated to
    // WHO is on the card. `playerIdentityKey` (playerIdentityKey.ts) is the
    // repo's ONE shared reduction that already strips those checklist
    // markers (RC/RR/DP/TC/UER/SP/SSP) before folding to a-z0-9 -- reused
    // here read-only, exactly as inferSetKeyFromTitle and sameCardNumber
    // already are, rather than adding a second marker-stripper.
    //
    // A key CONTAINING the other as a whole-token subset/prefix is silence,
    // not disagreement -- "james" ⊂ "jameswood" is checked on the SPACED
    // reduction (playerNameKey) so token boundaries stay whole-word ("James"
    // must not match inside "Jameson"). Multi-player target rows ("Eddie
    // Murray / Cal Ripken") are split on the same separators cleanPlayerName's
    // own header documents seeing in the wild (/, &, " and ") and ANY listed
    // name clearing the check is enough -- the title only ever depicts one
    // player at a time, so agreeing with one listed name is agreeing with
    // the row.
    //
    // Only fires (returns to the ordinary playerTheTitleAllows verdict) when
    // this exemption does NOT apply; contradict still requires the two keys
    // to share NO surname token, matching the review's own floor.
    const titlePlayer = guessPlayerFromTitleLocal(title);
    if (titlePlayer && target.playerName) {
      const targetNames = String(target.playerName).split(/\s*(?:\/|&|\band\b)\s*/i).map((n) => n.trim()).filter(Boolean);
      const namesToCheck = targetNames.length ? targetNames : [String(target.playerName)];
      const titleKey = playerIdentityKey(titlePlayer);
      const isSubsetMatch = namesToCheck.some((name) => {
        const nameKey = playerIdentityKey(name);
        if (!nameKey || !titleKey) return false;
        if (nameKey === titleKey) return true;
        // Whole-TOKEN containment, not raw substring (never let "james"
        // match inside "jameson"). Reduced through cleanPlayerName FIRST (the
        // SAME order playerIdentityKey itself uses, see that file's header)
        // so a checklist marker ("RC", "FS") is stripped from a TOKEN before
        // comparison rather than surviving as an unmatched leftover token --
        // playerNameKey alone only strips jr/sr/ii/iii/iv/v, never the
        // checklist markers this exemption exists for. `collapseInitials`
        // additionally joins RUNS of single-letter tokens ("j", "t") into one
        // ("jt"), so "J.T. Realmuto" and "Jt Realmuto" -- one person, two
        // punctuation conventions -- fold to the same token sequence.
        const collapseInitials = (tokens) => {
          const out = []; let buf = "";
          for (const t of tokens) {
            if (t.length === 1) buf += t;
            else { if (buf) { out.push(buf); buf = ""; } out.push(t); }
          }
          if (buf) out.push(buf);
          return out;
        };
        const tokensOf = (raw) => collapseInitials(
          playerNameKey(cleanPlayerName(String(raw ?? ""))).split(" ").filter(Boolean).map((t) => playerIdentityKey(t)),
        );
        const nameTokens = tokensOf(name);
        const titleTokens = tokensOf(titlePlayer);
        if (!nameTokens.length || !titleTokens.length) return false;
        const isSubsequence = (shorter, longer) => shorter.length > 0 && shorter.every((t) => longer.includes(t));
        return isSubsequence(nameTokens, titleTokens) || isSubsequence(titleTokens, nameTokens);
      });
      if (!isSubsetMatch) {
        const playerDecision = playerTheTitleAllows(target.playerName, titlePlayer);
        if (playerDecision.outcome === "irreconcilable") {
          return { contradicts: true, rule: "player", detail: `title names "${titlePlayer}", target is "${target.playerName}"` };
        }
      }
    }

    return { contradicts: false };
  }

  /**
   * BLOCKER 2 (review, 2026-09-19): does a document already sit at the
   * RELOCATE destination `(sale.id, numberedId)`? Sale ids are
   * `{source}::{externalId}` -- CF-ONE-WRITE-PATH-FOR-SOLD-COMPS's own doc,
   * soldCompsStore.service.ts:636 -- and do NOT embed cardId, so the same id
   * can already be resident at the numbered partition: written there by
   * #2298's ingest upgrade on a re-scrape of the same listing, or by a prior
   * partial run of this very lane. `relocateSoldComp`'s upsert is keyed on
   * (id, cardId) and REPLACES whatever is there -- it has no idea a resident
   * document is a DIFFERENT sale until this caller tells it so.
   *
   * Point read, not memoised: unlike the short-id twin check (one id, reused
   * across every sale under a target), the destination address is
   * PER-SALE (`sale.id` varies), so there is nothing to share across calls.
   */
  async function residentAt(saleId, cardId) {
    try { return (await retry(() => pool.item(saleId, cardId).read())).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
  }

  /**
   * Same sale, or a different one occupying the same address? "Same" is
   * decided the way the rest of the pool decides it: contentHashOf
   * (relocate-sold-comp.cjs, a mirror of soldCompsStore.computeContentHash --
   * the repo's ONE cross-source dedup key: cardId, parallel, isAuto,
   * gradeCompany, gradeValue, price-in-cents, sold-day). Comparing the
   * RESIDENT's own hash against the hash the incoming sale WOULD carry once
   * relocated (its own contentHash recomputed at the numbered cardId) is the
   * same predicate the pre-write dedup and the cross-source dedup lane both
   * already trust for "is this the same sale", not a new invented notion of
   * sameness.
   */
  function isSameSale(resident, incomingAtNewAddress) {
    if (!resident) return false;
    return contentHashOf(resident) === contentHashOf(incomingAtNewAddress);
  }

  /**
   * CONCURRENCY (review, 2026-09-19). Production run 35466486414 spent 86 of
   * its 110-minute budget on 12,321 SERIAL cross-partition hobbyiqCardId
   * queries (p50 417ms) and wrote only 2,185 of 16,409 targets -- the whole
   * per-target body below (catalog-twin point read, the cardId-shape query,
   * the cross-partition hobbyiqCardId-shape query, every sale's decide+write,
   * and the holdings repoint) ran ONE TARGET AT A TIME even though nothing
   * about it depends on another target's outcome. This function is that
   * per-target body, unchanged in DECISION -- same decideSaleAction, same
   * vetoes, same destination-collision handling, same guard, same
   * verify-by-read -- extracted so a bounded pool of workers (below) can run
   * several targets' bodies concurrently instead of the old serial `for`.
   *
   * WHY CONCURRENT TARGETS CANNOT COLLIDE (proven, not just hoped):
   *
   *   HAZARD 1 -- two targets writing the SAME destination id. `groups` is
   *   keyed by `identityKeyOf` (sport|year|setKey|cardNumber|cleaned-
   *   parallel|auto[|sub]), and `pickChecklistNumberedTarget` picks AT MOST
   *   ONE checklist row per group -- so two DIFFERENT groups can only ever
   *   produce two DIFFERENT `target.id` strings (they differ in at least one
   *   of those identity fields, which is exactly what makes the ids differ),
   *   and `shortIdOf` is a pure, deterministic strip of one target's own id.
   *   Two concurrent workers therefore operate on two DISJOINT (shortId,
   *   numberedId) address pairs by construction -- there is no shared
   *   destination to serialise around. Pinned by the "two targets in the
   *   same setKey never share a shortId" test below (distinct catalog rows,
   *   distinct cardNumbers, run at CONCURRENCY=16, asserts both relocate to
   *   their OWN numbered id and neither's sale count leaks into the other).
   *
   *   HAZARD 2 -- the same SALE reachable from two targets. THIS WAS
   *   PREVIOUSLY MIS-PROVEN HERE, and a blocking review caught it before
   *   merge: the claim that a document's cardId and hobbyiqCardId "cannot
   *   carry two different short-id-shaped values" is simply FALSE for a
   *   pre-existing split-identity sale -- one whose cardId names live target
   *   A's shortId and whose hobbyiqCardId names live target B's shortId,
   *   both real checklist-numbered cells in the SAME dispatch. That document
   *   IS found twice: once by target A's shape-1 query (`c.cardId = @shortA`)
   *   and once by target B's shape-2 query (`c.hobbyiqCardId = @shortB AND
   *   c.cardId != @shortB`) -- HAZARD 1's uniqueness of shortIds says nothing
   *   about this, because HAZARD 1 is about which id a TARGET computes, not
   *   about how many of a SALE's own two fields can independently match some
   *   live target's shortId. Under the old decision rule (a split-identity
   *   refusal that fired only when NEITHER field equalled the SCANNING
   *   target's own shortId), target A would RELOCATE it (stamping
   *   hobbyiqCardId = numberedA, destroying the fact that hobbyiqCardId used
   *   to name a different card) while target B would PATCH the SAME document
   *   (stamping hobbyiqCardId = numberedB) -- a torn write, decided from two
   *   different halves of the SAME split fact, on a document that was never
   *   an un-numbered twin to begin with. This was a pre-existing SERIAL
   *   defect too (the two writes simply never raced before this file added
   *   concurrency to notice it): a single-worker rerun that scanned target A
   *   and then target B would perform BOTH writes in sequence, same result.
   *
   *   THE FIX IS AT THE DECISION LAYER, NOT THE RACE.
   *   `classifySaleForRelocation` (above `decideSaleAction`) replaces "neither
   *   field is THIS target's shortId" with an exhaustive enumeration of the
   *   only four shapes this lane may touch (see that function's own header):
   *   cardId===hobbyiqCardId===shortId; a vendor cardId with
   *   hobbyiqCardId===shortId; an absent hobbyiqCardId (folds into the first
   *   shape); or a half-done prior relocate. EVERYTHING ELSE -- including
   *   cardId naming one live target's shortId while hobbyiqCardId names
   *   ANOTHER live target's shortId -- refuses as split-identity, from
   *   WHICHEVER SIDE reaches it, independently, with no shared state needed
   *   between the two targets to agree on the refusal. That is what makes
   *   concurrency safe here: not that the document is unreachable from two
   *   targets (it demonstrably is reachable), but that BOTH targets, given
   *   the SAME snapshot of that document, compute the SAME "refuse" verdict
   *   on their own -- there is no write for either of them to race on. The
   *   only remaining cross-target bookkeeping is COSMETIC: the refusal is
   *   counted and listed ONCE rather than twice (`noteSaleFound`, dedupe by
   *   `(id, cardId)`), so the reconciliation counts distinct documents, not
   *   raw query hits.
   *
   *   For a NON-split sale, the old field argument still holds and is worth
   *   keeping: shape 1 and shape 2 within one target's own two queries can
   *   never double-count the same document (shape 2 explicitly excludes
   *   `c.cardId = @s`), and a non-split document's cardId/hobbyiqCardId agree
   *   with each other, so it can only ever match ONE target's shortId in the
   *   first place. It is the split case specifically -- where the two fields
   *   disagree ON PURPOSE, naming two different cards -- that made the old
   *   "disjoint by field" claim false, and that is exactly the case the new
   *   classifier exists to name and refuse rather than paper over.
   *
   *   HAZARD 3 -- 429s under higher parallelism. Every I/O call in this
   *   function already goes through the shared `retry()` (now counted via
   *   `THROTTLE_COUNT`, surfaced in the banner as `throttled`) with full
   *   jitter on the backoff rather than a bare exponential sleep, so workers
   *   throttled on the same tick do not all wake and retry in lockstep.
   *
   *   HAZARD 4 -- per-cell caches shared across workers. `catalogTwinAt` is
   *   keyed purely by the SCANNING target's own shortId (never by a
   *   holding's or sale's field value), and HAZARD 1 genuinely guarantees
   *   every concurrent target's OWN shortId is unique -- so no two workers
   *   ever contend for the SAME `catalogTwinAt` cache key, and the cache is
   *   additionally made promise-safe below (the in-flight PROMISE is stored,
   *   not just the resolved value) for a hypothetical future caller that
   *   re-enters the same shortId mid-flight.
   *
   *   `holdingsIndex`, by contrast, IS reachable from two live targets for
   *   the SAME reason a sale is (HAZARD 2, corrected above): a holding whose
   *   cardId names target A's shortId and hobbyiqCardId names target B's
   *   shortId is indexed under BOTH slugs (`buildHoldingsIndex` indexes by
   *   both fields, same as before), and `repointHoldings` is called once by
   *   each target with its OWN `oldId`. The fix is the SAME fix as HAZARD 2,
   *   applied to holdings instead of sales: `repointHoldings` now runs
   *   `classifySaleForRelocation` on the holding's own {cardId,
   *   hobbyiqCardId} against the CALLING target's {shortId, numberedId}
   *   before queueing a write, and a holding that classifies as split is
   *   refused (counted in `holdingsRefusedSplitIdentity`, listed) rather than
   *   patched -- from whichever target reaches it, independently, no shared
   *   state needed between the two calls to agree.
   *
   * `LIMIT`, the example-list caps and `bySetKey`/`byYear` bumps are plain
   * counters/array pushes: JS never interleaves two synchronous statements on
   * one thread, so `s.x++` and `.push()` are safe under `Promise.all` exactly
   * as they were safe under the old `for` loop's own awaits. What changes is
   * PRINT ORDER, not correctness -- every sample list is sorted before it is
   * printed (see the sort calls at print time) so REPORT and APPLY runs, and
   * two runs at different CONCURRENCY values, produce byte-identical banners
   * modulo the counts and rows that actually differ.
   */
  async function processTarget(rows, ctx) {
    const { sport, year, setKey, parallelsByCardNumber } = ctx;
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; s.notReached++; return; }
    const picked = pickChecklistNumberedTarget(rows, isChecklist);
    if ("skip" in picked) {
      if (picked.skip === "ambiguous") {
        s.ambiguousRivalRuns++;
        if (ambiguousExamples.length < 20) {
          ambiguousExamples.push(`  AMBIGUOUS ${rows.map((r) => `${r.id} /${printRunOf(r)}`).join(" vs ")}`);
        }
      } else {
        s.noChecklistNumbered++;
      }
      return;
    }
    const target = picked.target;
    s.uniqueNumberedTargets++;

    const numberedId = target.id;
    const shortId = shortIdOf(numberedId);
    if (!shortId) { s.notReached++; return; } // defensive; candidateSpec + hasTrailingPrintRun already guarantee this
    s.shortIdsExamined++;

    // ── does a catalog twin already exist at the short id? Report only:
    // this lane never touches card_catalog. Input for the twins lane.
    const twin = await catalogTwinAt(shortId);
    if (twin) {
      s.shortIdsWithCatalogTwin++;
      if (twinExamples.length < 20) twinExamples.push(`  ${shortId}  [twin: ${twin.source}] -- the twins lane's job, not this one's`);
    }

    // BLOCKER 1 (review, 2026-09-19): a CHECKLIST row at the short id is
    // never a twin -- it is a DIFFERENT, checklist-attested card sharing
    // this identity cell (a partial print-run ladder, or an un-numbered
    // base card beside a numbered short-print). shortIdChecklistVeto is
    // the SAME decision fold-checklist-numbered-twins.cjs's own
    // `twinIsChecklist` gate applies and resolveChecklistNumberedIngestId
    // (#2298) now applies at ingest time -- one shared function, reused
    // here rather than a second copy. The WHOLE target is refused: no
    // sale under this identity is touched.
    const veto = shortIdChecklistVeto(twin, isChecklist);
    if (veto.veto) {
      s.targetsVetoedShortIdChecklistBacked++;
      if (vetoedTargets.length < 20) {
        vetoedTargets.push(`  ${shortId}  [${twin.source}] -- checklist-backed at the short id; the checklist's own ladder says this is a DIFFERENT card than ${numberedId}, not a twin. NOTHING touched.`);
      }
      return;
    }

    if (LIMIT && (s.salesRelocated + s.salesPatched) >= LIMIT) { s.notReached++; return; }

    // ── shape 1: sales whose PARTITION KEY (cardId) IS the short id.
    const cardIdRows = [];
    await forEachPage(pool, { query: "SELECT * FROM c WHERE c.cardId = @s", parameters: [{ name: "@s", value: shortId }] }, async (page) => {
      for (const row of page) cardIdRows.push(row);
      return true;
    }, 200);
    s.salesFoundByCardId += cardIdRows.length;

    for (const sale of cardIdRows) {
      const { duplicate } = noteSaleFound(sale);
      const titlePrintRun = titlePrintRunOf(sale, shortId);
      const titleStatesProsePrintRun = statesProsePrintRun(sale.title);
      const titleContradiction = titleContradictsTarget(sale, target, parallelsByCardNumber);
      const plan = decideSaleAction(sale, "cardId", { shortId, numberedId, titlePrintRun, titleStatesProsePrintRun, titleContradiction, targetPrintRun: printRunOf(target) });
      if (plan.action === "refuse") {
        // RULING (review, 2026-09-19): a document already found by ANOTHER
        // target (only possible for a split-identity sale -- see
        // classifySaleForRelocation's own proof) is counted and listed
        // exactly ONCE, by whichever target's loop reached it FIRST.
        // `noteSaleFound` above already recorded this as a duplicate FIND
        // for the reconciliation's own dedup; this is the matching dedup on
        // the REFUSAL side, so the two stay consistent with each other.
        if (!duplicate) {
          s.salesLeftAlone++;
          if (plan.reason === "title-states-print-run") s.refusedTitlePrintRun++;
          else if (plan.reason === "title-contradicts-target") s.refusedTitleContradiction++;
          else s.refusedSplitIdentity++;
          const list = refusals[plan.reason];
          if (list) list.push(`  ${sale.id}@${sale.cardId}: ${plan.detail}`);
        }
        continue;
      }
      try {
        const keep = { ...stripSystem(sale), cardId: numberedId, hobbyiqCardId: numberedId, reslugedFrom: shortId, reslugedReason: "sale at the short (un-numbered) id follows the checklist's :num-N row (repoint-sales-to-checklist-numbered)", reslugedAt: new Date().toISOString() };
        keep.contentHash = contentHashOf(keep);

        // BLOCKER 2 (review, 2026-09-19): relocateSoldComp's upsert is a
        // BLIND write at (sale.id, numberedId) -- it replaces whatever is
        // there. Sale ids do not embed cardId, so this exact id can
        // already be resident at the numbered partition. Check BEFORE
        // upserting, never after: an upsert that already happened cannot
        // be un-overwritten.
        const resident = await residentAt(sale.id, numberedId);
        if (resident) {
          if (isSameSale(resident, keep)) {
            // The SAME sale is already at the destination (by content
            // hash) -- this is a COLLAPSE, not a relocate: delete the
            // short-id copy and keep the resident, never upsert a
            // duplicate over it. relocateSoldComp itself already treats
            // "the address already held a document" as `existedBefore`
            // and its upsert would simply overwrite the resident with an
            // identical-by-hash document, but a DIRECT delete-after-
            // verify is more honest about what actually happened here:
            // nothing about the kept document changes.
            if (APPLY) await retry(() => pool.item(sale.id, shortId).delete());
            s.collapsedOntoResident++;
            if (collapsedExamples.length < 20) collapsedExamples.push(`  COLLAPSE ${sale.id}@${shortId} -- same sale already resident at ${numberedId}; short-id copy deleted`);
            continue;
          }
          // A DIFFERENT sale already occupies the destination. Moving
          // ours there would silently overwrite it (or, under the
          // ordinary path below, get overwritten BY it depending on
          // upsert timing) -- either way one sale is lost. Refuse, list
          // both, move nothing.
          s.refusedDestinationCollision++;
          refusals["destination-collision"].push(`  ${sale.id}@${shortId} -> ${numberedId}: a DIFFERENT sale (by content hash) already resides at the destination; NEITHER moved -- resident price=${resident.price ?? "?"} soldAt=${resident.soldAt ?? "?"} vs incoming price=${sale.price ?? "?"} soldAt=${sale.soldAt ?? "?"}`);
          continue;
        }

        // LAST-LINE DEFENCE (review, 2026-09-19): `sale` is the copy this
        // target's PLANNING read (the cardId-shape query, above) returned.
        // Everything since -- the title parse, the classify, the resident
        // check -- ran on that snapshot. Under concurrency (and, more
        // simply, under a slow serial run racing a live ingest), the SOURCE
        // document at (sale.id, shortId) can have changed since that read:
        // another writer (a re-scrape, a different repair lane) could have
        // altered its hobbyiqCardId, title or content between the plan and
        // this write. `relocateSoldComp`'s own upsert is a blind write of
        // `keep`, built entirely from the STALE `sale` snapshot -- so a
        // change nobody re-checked would be silently overwritten with a
        // decision made on data that no longer describes the document.
        //
        // Cheap and scoped to ONLY the sale actually being relocated (never
        // the whole cardIdRows page): one extra point read, compared by
        // `_etag` against the SAME snapshot's own `_etag` (Cosmos returns it
        // on every `SELECT *`, so `sale._etag` is already what the planning
        // read saw). A mismatch, or the document being GONE from its planned
        // address entirely, means it moved out from under this decision --
        // refuse rather than write over unknown changes; this lane is
        // idempotent by construction (see processTarget's own header), so a
        // later pass re-reads and re-decides from scratch rather than acting
        // on stale information now.
        let freshBeforeWrite = null;
        try { freshBeforeWrite = await residentAt(sale.id, shortId); }
        catch (e) { s.salesFailed++; failures.push(`  FAILED relocate ${sale.id}@${shortId} -> ${numberedId}: could not re-read before write: ${String(e?.message ?? e)}`); continue; }
        const etagChanged = !freshBeforeWrite || String(freshBeforeWrite._etag ?? "") !== String(sale._etag ?? "");
        if (etagChanged) {
          s.refusedEtagChanged++;
          s.salesLeftAlone++;
          const why = freshBeforeWrite
            ? `_etag changed since the planning read (${sale._etag ?? "?"} -> ${freshBeforeWrite._etag ?? "?"})`
            : `gone from ${shortId} since the planning read (already moved or deleted by something else)`;
          refusals["stale-since-plan"].push(`  ${sale.id}@${shortId} -> ${numberedId}: ${why} -- refused, not relocated on stale data`);
          continue;
        }

        // CONDITIONAL WRITES (review, 2026-09-19): the re-read above proved
        // the etag matched AT THAT MOMENT, but the re-read and the delete
        // below are still two separate round trips -- a document could
        // change in the gap between them without this. Passing
        // `freshBeforeWrite._etag` as `ifMatchEtag` closes that SECOND
        // window: relocateSoldComp issues the delete with an IfMatch
        // condition, so Cosmos itself (not another round trip on this
        // lane's side) refuses the delete with a 412 if the document
        // changed again between this line and the actual delete call.
        const res = await relocateSoldComp(pool, { keep, drop: [{ id: sale.id, cardId: shortId, ifMatchEtag: freshBeforeWrite._etag }], retry, verifyFields: ["cardId", "hobbyiqCardId"], dryRun: !APPLY });
        if (res.guard?.verdict === "park") {
          s.refusedGuardParked++;
          refusals["guard-parked"].push(`  ${sale.id}@${shortId}: ${res.error ?? res.guard.reason}`);
          continue;
        }
        // CONDITIONAL WRITES (review, 2026-09-19): a 412 on the delete lands
        // in `res.staleSincePlan`, never `res.duplicatesLeft` -- checked
        // BEFORE the generic `!res.ok` failure branch below, so a document
        // that changed a SECOND time (after the last-line re-read above,
        // between it and the actual delete) is named the same way as the
        // FIRST window's own refusal, not miscounted as a generic failure.
        // The keeper is already upserted at this point (relocateSoldComp's
        // own order: upsert, verify, THEN delete) -- a 412 here means the
        // source doc changed, not that the move failed; the sale is safely
        // at its new address either way, and the drop is simply not deleted
        // this run (a later idempotent pass finds it moved and does nothing).
        if (res.staleSincePlan?.length) {
          s.refusedEtagChanged++;
          s.salesLeftAlone++;
          refusals["stale-since-plan"].push(`  ${sale.id}@${shortId} -> ${numberedId}: delete refused (412) -- source changed between the last-line re-read and the delete itself; the keeper is already at ${numberedId}, the short-id copy is left for a later pass`);
          continue;
        }
        if (!res.ok && res.stage !== "dry-run") {
          s.salesFailed++;
          failures.push(`  FAILED relocate ${sale.id}@${shortId} -> ${numberedId}: ${res.error ?? "unknown"}`);
          continue;
        }
        s.salesRelocated++;
        bump(bySetKey, setKey); bump(byYear, String(year));
        if (examples.length < 24) examples.push(`  RELOCATE ${sale.id}@${shortId} -> ${numberedId}`);
      } catch (e) {
        s.salesFailed++;
        failures.push(`  FAILED relocate ${sale.id}@${shortId} -> ${numberedId}: ${String(e?.stack ?? e?.message ?? e)}`);
      }
    }

    // ── shape 2: sales whose hobbyiqCardId names the short id but whose
    // OWN cardId is something else (a vendor partition) -- patch only.
    // SHOULD-FIX 4 (review, 2026-09-19): this is the ONE cross-partition
    // query this lane issues per target (the cardId-shape query above is
    // partition-scoped; this one is not, since hobbyiqCardId is not the
    // container's partition key) -- timed so a REPORT pilot shows its
    // true cost before any wider scope is dispatched.
    const hobbyiqQueryStarted = Date.now();
    const hobbyiqRows = [];
    await forEachPage(pool, { query: "SELECT * FROM c WHERE c.hobbyiqCardId = @s AND c.cardId != @s", parameters: [{ name: "@s", value: shortId }] }, async (page) => {
      for (const row of page) hobbyiqRows.push(row);
      return true;
    }, 200);
    s.hobbyiqCardIdQueries++;
    hobbyiqCardIdQueryMs.push(Date.now() - hobbyiqQueryStarted);
    s.salesFoundByHobbyiqCardId += hobbyiqRows.length;

    for (const sale of hobbyiqRows) {
      const { duplicate } = noteSaleFound(sale);
      const titlePrintRun = titlePrintRunOf(sale, shortId);
      const titleStatesProsePrintRun = statesProsePrintRun(sale.title);
      const titleContradiction = titleContradictsTarget(sale, target, parallelsByCardNumber);
      const plan = decideSaleAction(sale, "hobbyiqCardId", { shortId, numberedId, titlePrintRun, titleStatesProsePrintRun, titleContradiction, targetPrintRun: printRunOf(target) });
      if (plan.action === "refuse") {
        // RULING (review, 2026-09-19): same dedup as the cardId-shape loop
        // above -- see its comment. A document reached from BOTH shapes
        // (once via some other target's cardId-shape query, once here via
        // this target's hobbyiqCardId-shape query) is counted once, by
        // whichever loop reached it first across the WHOLE run.
        if (!duplicate) {
          s.salesLeftAlone++;
          if (plan.reason === "title-states-print-run") s.refusedTitlePrintRun++;
          else if (plan.reason === "title-contradicts-target") s.refusedTitleContradiction++;
          else s.refusedSplitIdentity++;
          const list = refusals[plan.reason];
          if (list) list.push(`  ${sale.id}@${sale.cardId} (hobbyiqCardId=${shortId}): ${plan.detail}`);
        }
        continue;
      }
      try {
        // CONDITIONAL WRITES / LAST-LINE DEFENCE (review, 2026-09-19): the
        // patch shape gets the SAME last-line re-read the relocate shape
        // already has, run in BOTH modes (REPORT reads the same live
        // container APPLY would, exactly as the relocate shape's own
        // unconditional re-read already does -- REPORT-first doctrine, this
        // file's own header) -- only the actual patch call below is gated on
        // APPLY. The patch never goes through relocateSoldComp (it is not a
        // rekey, just a field update at the sale's own existing address), so
        // the IfMatch condition is built here rather than in that helper.
        let freshBeforeWrite = null;
        try { freshBeforeWrite = await residentAt(sale.id, sale.cardId); }
        catch (e) { s.salesFailed++; failures.push(`  FAILED patch ${sale.id}@${sale.cardId}: could not re-read before write: ${String(e?.message ?? e)}`); continue; }
        const etagChanged = !freshBeforeWrite || String(freshBeforeWrite._etag ?? "") !== String(sale._etag ?? "");
        if (etagChanged) {
          s.refusedEtagChanged++;
          s.salesLeftAlone++;
          const why = freshBeforeWrite
            ? `_etag changed since the planning read (${sale._etag ?? "?"} -> ${freshBeforeWrite._etag ?? "?"})`
            : `gone from ${sale.cardId} since the planning read (already moved or deleted by something else)`;
          refusals["stale-since-plan"].push(`  ${sale.id}@${sale.cardId} (hobbyiqCardId=${shortId}): ${why} -- refused, not patched on stale data`);
          continue;
        }
        if (APPLY) {
          try {
            await retry(() => pool.item(sale.id, sale.cardId).patch([
              { op: "set", path: "/hobbyiqCardId", value: numberedId },
              { op: "set", path: "/reslugedFrom", value: shortId },
              { op: "set", path: "/reslugedReason", value: "sale at the short (un-numbered) id follows the checklist's :num-N row (repoint-sales-to-checklist-numbered)" },
              { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
            ], { accessCondition: { type: "IfMatch", condition: freshBeforeWrite._etag } }));
          } catch (e) {
            if (is412(e)) {
              s.refusedEtagChanged++;
              s.salesLeftAlone++;
              refusals["stale-since-plan"].push(`  ${sale.id}@${sale.cardId} (hobbyiqCardId=${shortId}): patch refused (412) -- source changed between the last-line re-read and the patch itself`);
              continue;
            }
            throw e;
          }
        }
        s.salesPatched++;
        bump(bySetKey, setKey); bump(byYear, String(year));
        if (examples.length < 24) examples.push(`  PATCH ${sale.id}@${sale.cardId} hobbyiqCardId ${shortId} -> ${numberedId}`);
      } catch (e) {
        s.salesFailed++;
        failures.push(`  FAILED patch ${sale.id}@${sale.cardId}: ${String(e?.stack ?? e?.message ?? e)}`);
      }
    }

    await repointHoldings(shortId, numberedId);
  }

  /**
   * Run every target in `targets` through `processTarget` with at most
   * CONCURRENCY in flight at once -- the same shared-cursor worker-pool
   * idiom rematch-sold-comps.cjs already uses (`let idx = 0; const worker =
   * async () => { while (idx < list.length) { const my = idx++; ... } };
   * Promise.all(Array.from({length}, worker))`), reused rather than a new
   * shape invented for this lane. Each worker CLAIMS its index (`idx++`)
   * BEFORE doing anything else, so every target is claimed by EXACTLY ONE
   * worker with no gaps and no double-claims regardless of how many workers
   * are racing -- there is nothing here for two workers to contend over.
   */
  async function runTargetsPool(targets, ctx) {
    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        const my = idx++;
        await processTarget(targets[my], ctx);
      }
    };
    const lanes = Math.min(CONCURRENCY, Math.max(targets.length, 1));
    await Promise.all(Array.from({ length: lanes }, worker));
  }

  for (const cell of SCOPE_CELLS) {
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const [sport, yearStr] = cell.split(":");
    const year = Number(yearStr);

    for (const setKey of SET_KEYS) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
      const spec = candidateSpec(sport, year, setKey);

      const groups = new Map(); // identityKey -> rows[]
      await forEachPage(cat, spec, async (page) => {
        for (const r of page) {
          if (CLOCK.outOfClock()) { stoppedAtBudget = true; return false; }
          s.catalogRowsScanned++;
          if (!hasTrailingPrintRun(r.id)) continue; // CONTAINS pre-filter false-positive (e.g. inside a subset slug)
          if (SHARD_SCOPE.SHARDED && shardOf(String(r.id)) !== SHARD_SCOPE.SLOT) { s.otherShard++; continue; }
          const key = identityKeyOf(r, DEFAULT_FORCE_AUTO_PREFIXES);
          const list = groups.get(key) ?? [];
          list.push(r);
          groups.set(key, list);
        }
        return true;
      });

      s.identityGroups += groups.size;

      // PARALLEL RULE SIBLING-RUNG INDEX (review, 2026-09-19 false-positive
      // pass): `groups` already holds EVERY catalog row this cell scanned,
      // just keyed by the full identity (including parallel) rather than by
      // cardNumber alone -- so "does this card NUMBER have more than one
      // parallel rung on this checklist ladder" is answerable from data
      // already in memory, with NO new Cosmos I/O. Built once per (sport,
      // year, setKey) cell, reused by every target's titleContradictsTarget
      // call below: cardNumber -> Set of distinct parallelSlugs seen at that
      // number across every group. A bare-colour title against a target
      // whose number ALSO carries a compound rung on the SAME ladder
      // ("gold" AND "gold-diamante-foil" both present) stays ambiguous and
      // still refuses (absent beats wrong); a number with only ONE rung on
      // this ladder is what makes a bare colour "under-specified" rather
      // than "wrong", since there is nothing else it could mean.
      const parallelsByCardNumber = new Map();
      for (const rows of groups.values()) {
        for (const r of rows) {
          const num = String(r.cardNumber ?? "").trim().toLowerCase();
          if (!num) continue;
          const set = parallelsByCardNumber.get(num) ?? new Set();
          set.add(slugify(String(r.parallelSlug ?? "base")));
          parallelsByCardNumber.set(num, set);
        }
      }

      // ── THE BOUNDED-CONCURRENCY POOL (review, 2026-09-19) ─────────────────
      // Every group's target is independent of every other group's (see
      // processTarget's own header comment for the proof), so this setKey's
      // groups run through the shared-cursor worker pool instead of a serial
      // `for`. A budget stop is honoured INSIDE processTarget (checked before
      // any I/O for that target, exactly where the old serial loop checked
      // it), so in-flight targets still finish and only targets not yet
      // claimed are left unclaimed -- matching the old loop's own
      // claim-before-check discipline, just with up to CONCURRENCY claims
      // outstanding at once instead of one.
      await runTargetsPool([...groups.values()], { sport, year, setKey, parallelsByCardNumber });
    }
  }

  console.log("");
  console.log(`catalog rows scanned (checklist-numbered candidates) ${f(s.catalogRowsScanned)}${SHARD_SCOPE.SHARDED ? `  (${f(s.otherShard)} in other shards)` : ""}`);
  console.log(`  identity groups                ${f(s.identityGroups)}`);
  console.log(`  unique-/N targets               ${f(s.uniqueNumberedTargets)}   <- exactly one checklist print run`);
  console.log(`  rival/ambiguous /N groups        ${f(s.ambiguousRivalRuns)}   <- two checklist print runs; guessing is worse than the split`);
  console.log(`  no checklist /N in group         ${f(s.noChecklistNumbered)}`);
  console.log("");
  console.log(`short ids examined                ${f(s.shortIdsExamined)}`);
  console.log(`  short ids that ALSO have a catalog twin  ${f(s.shortIdsWithCatalogTwin)}   <- input for fold-checklist-numbered-twins.cjs (this lane never touches card_catalog)`);
  console.log(`  targets VETOED: short id is checklist-backed ${f(s.targetsVetoedShortIdChecklistBacked)}   <- the short id is a DIFFERENT, checklist-attested card; NOTHING under it touched`);
  console.log("");
  console.log(`sales found by cardId (partition-keyed)        ${f(s.salesFoundByCardId)}`);
  console.log(`sales found by hobbyiqCardId (patch-shape)     ${f(s.salesFoundByHobbyiqCardId)}`);
  console.log(`  ${APPLY ? "RELOCATED" : "WOULD RELOCATE"}     ${f(s.salesRelocated)}`);
  console.log(`  ${APPLY ? "PATCHED" : "WOULD PATCH"}       ${f(s.salesPatched)}`);
  console.log(`  COLLAPSED onto a resident (same sale, by hash)  ${f(s.collapsedOntoResident)}`);
  console.log(`  REFUSED: title states a print run   ${f(s.refusedTitlePrintRun)}   <- absent beats wrong (#2298's own rule)`);
  console.log(`  REFUSED: pre-existing split identity ${f(s.refusedSplitIdentity)}   <- cardId != hobbyiqCardId naming two different cards already; not this lane's to fix`);
  console.log(`  REFUSED: destination collision       ${f(s.refusedDestinationCollision)}   <- a DIFFERENT sale already resides at the numbered address; neither moved`);
  console.log(`  REFUSED: guard parked (malformed key) ${f(s.refusedGuardParked)}`);
  console.log(`  REFUSED: stale since the planning read ${f(s.refusedEtagChanged)}   <- source doc changed or vanished between plan and write; re-read before every relocate`);
  console.log(`  REFUSED: title contradicts the target ${f(s.refusedTitleContradiction)}   <- title names a different card number, product, parallel, or player; never laundered onto a checklist-backed address`);
  console.log(`  failed                              ${f(s.salesFailed)}`);
  console.log(`  not reached                         ${f(s.notReached)}`);
  console.log("");
  console.log(`  holdings re-pointed        ${f(s.holdingsRepointed)}   (walked ${f(s.holdingsWalked)} holdings across ${f(s.holdingDocsWalked)} portfolio docs)`);
  console.log(`  holdings REFUSED: split identity ${f(s.holdingsRefusedSplitIdentity)}   <- cardId != hobbyiqCardId naming two different cards already; not this lane's to fix`);
  console.log(`  NOTE: a holding still on the short id prices correctly regardless -- poolReadIdsFor`);
  console.log(`        (catalogIdentityResolver.ts) unions the short id and its numbered twin at read`);
  console.log(`        time, so a holding not yet re-pointed here does not go dark.`);

  // SHOULD-FIX 4 (review, 2026-09-19): query cost, so a REPORT pilot shows
  // the price of a wider dispatch before it is asked for. The cardId-shape
  // query above is partition-scoped (cheap, indexed on the container's own
  // partition key); the hobbyiqCardId-shape query is the one cross-partition
  // read this lane issues, once per target.
  console.log("");
  console.log(`  hobbyiqCardId cross-partition queries issued  ${f(s.hobbyiqCardIdQueries)}`);
  console.log(`    p50 ${percentile(hobbyiqCardIdQueryMs, 50)}ms   p95 ${percentile(hobbyiqCardIdQueryMs, 95)}ms`);

  // CONCURRENCY (review, 2026-09-19): read ONCE, after every worker has
  // finished (the outer targets loop has already been awaited by this line),
  // so this is the whole run's throttle count, not a snapshot mid-flight.
  s.throttled = THROTTLE_COUNT;
  console.log(`  throttled (429/503/timeout retries across all workers)  ${f(s.throttled)}   <- concurrency ${CONCURRENCY}`);

  // CONCURRENCY (review, 2026-09-19): every sample/refusal/failure list below
  // is filled by workers running in whatever order they happen to finish, so
  // PRINT ORDER is no longer the order targets/sales were claimed. Sorted
  // (plain string sort, stable and deterministic) immediately before
  // printing so two runs -- REPORT vs APPLY, or CONCURRENCY=1 vs 16 -- print
  // the SAME lines in the SAME order for the same fixture; only the counts
  // and the set of lines are meaningful, never the order they arrived in.
  const sorted = (arr) => [...arr].sort();
  if (bySetKey.size) { console.log(`\n  by setKey:`); for (const [k, n] of [...bySetKey.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) console.log(`    ${String(n).padStart(9)}  ${k}`); }
  if (byYear.size) { console.log(`\n  by year:`); for (const [k, n] of [...byYear.entries()].sort()) console.log(`    ${String(n).padStart(9)}  ${k}`); }
  if (examples.length) { console.log(`\n  examples:`); for (const e of sorted(examples)) console.log(e); }
  if (twinExamples.length) { console.log(`\n  short ids WITH a catalog twin (sample, ${f(s.shortIdsWithCatalogTwin)} total):`); for (const e of sorted(twinExamples)) console.log(e); }
  if (splitHoldingExamples.length) { console.log(`\n  holdings REFUSED as split identity (sample, ${f(s.holdingsRefusedSplitIdentity)} total):`); for (const e of sorted(splitHoldingExamples)) console.log(e); }
  if (vetoedTargets.length) { console.log(`\n  VETOED targets -- short id is checklist-backed (sample, ${f(s.targetsVetoedShortIdChecklistBacked)} total):`); for (const e of sorted(vetoedTargets)) console.log(e); }
  if (collapsedExamples.length) { console.log(`\n  COLLAPSED onto a resident (sample, ${f(s.collapsedOntoResident)} total):`); for (const e of sorted(collapsedExamples)) console.log(e); }
  if (ambiguousExamples.length) { console.log(`\n  RIVAL /N groups (sample, ${f(s.ambiguousRivalRuns)} total) -- never folded, a human rules on these:`); for (const e of sorted(ambiguousExamples)) console.log(e); }

  for (const [reason, list] of Object.entries(refusals)) {
    if (list.length) {
      console.log(`\n  REFUSED (${reason}), every one listed (${f(list.length)}):`);
      for (const l of sorted(list)) console.log(l);
    }
  }
  if (failures.length) {
    console.log(`\n  FAILURES (${f(failures.length)}):`);
    for (const fl of sorted(failures)) console.log(fl);
  }

  // ── CF-A-SALE-IS-NEVER-LOST reconciliation ---------------------------------
  // `collapsedOntoResident` is counted with `written`: the short-id copy is
  // RESOLVED (deleted once the resident is confirmed to be the same sale),
  // even though the resident document itself was not created by this run.
  // `refusedDestinationCollision` joins the other named refusals -- a
  // DIFFERENT sale already at the destination is exactly the shape a refusal
  // exists to report, never a write this lane may attempt.
  //
  // RULING (review, 2026-09-19): `salesFoundByCardId + salesFoundByHobbyiqCardId`
  // counts QUERY HITS, and a split-identity sale reachable from two live
  // targets is a query hit TWICE for the SAME document (once under each
  // target's own shortId). `salesFoundDuplicateAcrossTargets` (incremented
  // by `noteSaleFound`, at the point each sale is first seen by ANY target's
  // loop) is the exact correction: subtracting it turns the raw hit count
  // into a count of DISTINCT DOCUMENTS, which is what "sales at short ids
  // before" has always meant to claim. The refusal counters above are
  // deduped the same way (by `(id, cardId)`, via the SAME `noteSaleFound`
  // call), so both sides of this equation dedupe identically and the
  // balance holds whether a split sale was found by one target or two.
  const salesBefore = s.salesFoundByCardId + s.salesFoundByHobbyiqCardId - s.salesFoundDuplicateAcrossTargets;
  const written = s.salesRelocated + s.salesPatched + s.collapsedOntoResident;
  const refused = s.refusedTitlePrintRun + s.refusedSplitIdentity + s.refusedGuardParked + s.refusedDestinationCollision + s.refusedEtagChanged + s.refusedTitleContradiction;
  const left = salesBefore - written - refused - s.salesFailed;
  console.log("");
  console.log(`CF-A-SALE-IS-NEVER-LOST`);
  if (s.salesFoundDuplicateAcrossTargets) {
    console.log(`  (${f(s.salesFoundByCardId + s.salesFoundByHobbyiqCardId)} raw query hits, ${f(s.salesFoundDuplicateAcrossTargets)} were the SAME split-identity document found by a second target -- deduped to distinct documents below)`);
  }
  console.log(`  sales at short ids before   ${f(salesBefore)}`);
  console.log(`  ${APPLY ? "=" : "would be ="} relocated ${f(s.salesRelocated)} + patched ${f(s.salesPatched)} + collapsed ${f(s.collapsedOntoResident)} + refused ${f(refused)} + failed ${f(s.salesFailed)} + left ${f(left)}`);
  const accountedFor = written + refused + s.salesFailed + left;
  if (accountedFor !== salesBefore) {
    console.error(`!! CF-A-SALE-IS-NEVER-LOST: accounted ${f(accountedFor)} != before ${f(salesBefore)}. A sale is unaccounted for. Exit 4.`);
    process.exitCode = 4;
  } else {
    console.log(`  matched -- every sale at a short id is relocated, patched, refused (named), failed (named), or left with a reason accounted above.`);
  }

  console.log("");
  console.log(`  reconciled: intended ${f(s.uniqueNumberedTargets)} = written(targets acted on) ... see sales reconciliation above for the row-level count`);
  if (APPLY) {
    reportWrites({
      job: "repoint-sales-to-checklist-numbered",
      intended: salesBefore,
      written,
      skipped: left,
      refused,
      failed: s.salesFailed,
    });
  }

  console.log("");
  console.log(`  ${APPLY ? "RELOCATED" : "WOULD RELOCATE"} ${f(s.salesRelocated)}   ${APPLY ? "PATCHED" : "WOULD PATCH"} ${f(s.salesPatched)}`);
  if (stoppedAtBudget || CLOCK.outOfClock()) {
    console.log(`  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the slot has more to do`);
  }
  if (!APPLY) console.log(`\nREPORT ONLY -- nothing was written. Re-run with BACKFILL_APPLY=true to apply.`);

  if (s.salesFailed) {
    console.error(`::error::${f(s.salesFailed)} sale(s) failed -- see FAILURES above.`);
    process.exitCode = 4;
  }
}

module.exports = { candidateSpec, hasTrailingPrintRun, shortIdOf, classifySaleForRelocation, decideSaleAction, TRAILING_NUM_RE, INHERITED_SCOPES, CELL_RE, WILDCARDS };

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); await finishLane(1, { budget: CLOCK }); });
}
