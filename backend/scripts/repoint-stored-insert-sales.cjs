#!/usr/bin/env node
/**
 * repoint-stored-insert-sales.cjs -- move STORED sold_comps rows that a
 * REGISTERED insert set's own checklist confirms, off the BASE product's
 * pools they were mis-filed under, forever, until this lane runs.
 *
 * THE MEASURED PROBLEM (PR #2331 context). R66/R67/R70 taught the two
 * WRITERS (soldCompsStore.service.ts, persistVendorSalesToPool.service.ts)
 * to recognise a title naming a REGISTERED insert set of its own product, and
 * to re-key a FRESH sale onto the insert's own setKey -- but only when
 * CONFIRMED by the insert's checklist rows (insertSetTitleReader.ts +
 * insertSetChecklistConfirm.ts). That is an INGEST-PATH hook: it runs once,
 * at write time, for a sale being written today. CF-INGEST-KEEPS-STORED-
 * IDENTITY (soldCompsStore.service.ts, 2026-09-14) is the general form of why
 * this can never reach a STORED row -- ingest never re-derives the identity
 * of a document that already exists at an address, on any re-upsert, by
 * design (232 Bush/Mantle rows moving silently on a re-scrape is exactly the
 * incident that rule exists to prevent). So every insert sale that landed in
 * a BASE card's pool BEFORE #2331 shipped -- named a Panini Photogenic
 * Rookie Pix DT-5 sale, filed for decades under the base card at #5, priced
 * the wrong player forever -- stays there. Drew's own framing: this is the
 * single biggest source of wrong-player / wrong-card prices in the stored
 * pool, because a title-vocabulary defect that ran for the LIFETIME of a
 * product (until #2331 merged) affects every sale scraped in that window,
 * not a handful.
 *
 * THIS LANE closes exactly that gap, driving from the CHECKLIST rather than
 * scanning sold_comps pool-wide:
 *
 *   1. `titles` (SET_KEYS, reused -- see BCP_TITLES below) names one or more
 *      REGISTERED INSERT setKeys (`panini-photogenic-rookie-pix`, ...), never
 *      a base product -- `productParentOf` resolves each insert's own base
 *      product from productSetKeys.ts, and a key with no registered parent is
 *      refused by name (an insert with no parent is not this lane's shape).
 *   2. UNITS ARE (cell, BASE PRODUCT), NOT (cell, insert key) -- REVIEW FIX
 *      (2026-09-19, finding 3). Several requested insert keys sharing one
 *      base product (panini-photogenic-rookie-pix AND
 *      panini-photogenic-troops-tribute both nest under panini-photogenic)
 *      are grouped into ONE unit, so the base product's cell is scanned
 *      exactly ONCE no matter how many of its inserts are in scope, cutting
 *      RU cost N-fold and removing cross-target overlap by construction
 *      (the old per-insert-key unit shape STARTSWITH-scanned the SAME base
 *      cell once per insert key requested against it).
 *   3. For each unit, page card_catalog ONCE PER REQUESTED INSERT sharing
 *      this base product for that insert's own CHECKLIST-AUTHORITY rows
 *      (catalogAuthorityOf(source) === "checklist") -- these are the
 *      CONFIRMATION SETS, read once per (cell, insert), never re-read per
 *      sale, keyed by insertSetKey so each candidate sale is routed to the
 *      RIGHT insert's confirmation set below.
 *   4. Candidate sales are every stored row at the BASE PRODUCT'S OWN CELL:
 *      `STARTSWITH(c.hobbyiqCardId, "hiq:sport:year:baseSetKey:")` -- THE
 *      SAME query shape rekey-product-setkey.cjs's own MODE=pool lane already
 *      runs against sold_comps, header-justified there with a measured row
 *      count ("the pool is the substance of these rulings and it is swept
 *      directly, by slug prefix"). Scanned ONCE per unit (see #2), not once
 *      per insert. A per-number query is NOT used for candidate discovery
 *      (only for confirmation, in step 6) because a mis-pooled sale's STORED
 *      cardNumber may be the BASE product's own number for that roster slot,
 *      not the insert's -- the whole point of the CARD-NUMBER RULE below --
 *      so filtering candidates by an insert's numbers before the checklist
 *      comparison runs would make that LEAVE reason structurally
 *      unreachable. Every candidate's own (sport, year, setKey) CELL is
 *      double-checked in JS against BOTH cardId and hobbyiqCardId (see
 *      FULL-CELL DEFENCE IN DEPTH below), since a vendor-partitioned row's
 *      cardId names no product at all and only hobbyiqCardId carries the
 *      base slug.
 *   5. Each candidate sale's TITLE is read through the REAL compiled
 *      `insertSetNamedInTitle` (dist/services/portfolioiq/
 *      insertSetTitleReader.js) against the sale's OWN base identity
 *      (sport/year/baseSetKey) -- exactly the question the ingest-time
 *      writers ask, asked here after the fact, ONCE per sale (not once per
 *      requested insert): the matched registeredKey is what ROUTES the sale
 *      to the right insert's confirmation set loaded in step 3. A title that
 *      names no insert, or names two, or names an insert NOT in this run's
 *      requested set, is left untouched -- see LEAVE REASONS below.
 *   6. A title match is confirmed against the checklist rows ALREADY LOADED
 *      in step 3 -- no per-sale Cosmos read -- via `planInsertRekey`'s pure
 *      predicate below, which mirrors insertSetChecklistConfirm.ts's own
 *      "both known -> one row must confirm both" rule (FIX 1) without
 *      importing that module (its predicate is private; only its I/O-facing
 *      exports are public, and this lane's whole point is to do that
 *      confirmation WITHOUT a second Cosmos round-trip per sale).
 *   7. DESTINATION RUNG (REVIEW FIX, finding 5, "price only checklist-matched
 *      identities"). A MOVE also requires the exact DESTINATION address (the
 *      insert's number/parallel/auto rung, minus any grade suffix) to be one
 *      the insert's OWN checklist actually prints -- confirming the NUMBER
 *      is not enough, because the move keeps every other segment of the
 *      sale's stored identity byte-identical (parallel, auto flag), and a
 *      confirmed number under a parallel or auto flag the checklist never
 *      printed for that number is a rung nobody has attested. Checked
 *      against the SAME already-loaded checklist rows (parallelSlug, isAuto)
 *      -- no per-sale I/O. See DESTINATION RUNG RULE below.
 *
 * CARD-NUMBER RULE. An insert checklist usually numbers with its own prefix
 * (DT-5) while a mis-pooled sale may carry the BASE card's number instead (a
 * title-parser reading the base checklist's own #5 before #2331 existed to
 * redirect it). Confirmation requires the sale's STORED cardNumber to equal
 * the INSERT ROW's number, normalised exactly as insertSetChecklistConfirm.ts
 * normalises it (case/hyphen/leading-zero fold, via the shared, read-only
 * `cardNumberVariants` plus this file's own local leading-zero fold -- see
 * that module's header on why the fold is local and not added to the shared
 * helper, reused verbatim here for the same reason: hobbyIqCardId.service.ts
 * is a declared derivation-stamp input and this lane may only ever WIDEN a
 * comparison over its existing, unchanged output, never edit it). A sale
 * whose stored number is the BASE product's own number for that slot --
 * never appearing on the insert's checklist under any variant -- is LEFT,
 * named `number-is-base-number`, and listed: guessing that the title's own
 * number differs from the stored field is a job for a title-vocabulary pass,
 * not this identity mover.
 *
 * DESTINATION RUNG RULE (REVIEW FIX, finding 5). "Price only checklist-
 * matched identities": confirming the card NUMBER alone is not sufficient
 * when the MOVE preserves the sale's own parallel/auto segments verbatim (one
 * axis only -- the setKey segment moves, nothing else). A stored sale
 * confirmed at DT-5 but marked `isAuto: true` (or a `parallel` the checklist
 * never lists at DT-5) would land at an address like
 * `hiq:...:panini-photogenic-rookie-pix:cpa-dm:gold:auto:num-5` that no
 * checklist row backs -- the number matched, but the exact destination rung
 * never printed. So a MOVE additionally requires a checklist-authority row
 * at the SAME insert whose (cardNumber, normalised parallel, isAuto) all
 * match the sale's own (case-insensitive parallel comparison, since checklist
 * parallel spellings are human-form/mixed-case per
 * feedback_catalog_parallel_field_is_human_form_mixed_case). No such row ->
 * LEAVE `destination-rung-not-on-checklist`, listed with counts by rung
 * (insertSetKey + normalised parallel + auto flag) so the ladder gap is
 * visible to whoever acquires the missing checklist rows. Checked against the
 * SAME already-loaded checklist rows -- no per-sale I/O.
 *
 * VERDICTS, ONE AXIS ONLY (relocation lists change one axis only):
 *   MOVE       title names ONLY this insert, confirms (number+player, or
 *              number alone when the checklist row carries no player) on
 *              exactly one checklist row, AND the destination rung
 *              (number+parallel+auto) is itself checklist-attested (see
 *              DESTINATION RUNG RULE). hobbyiqCardId's setKey segment moves
 *              to the insert key (withProductSetKey, the same helper
 *              carryProductRekeyOntoCardId already trusts); cardId's setKey
 *              segment moves TOO, but ONLY in the two writable shapes named
 *              under SPLIT-IDENTITY below -- everything else LEAVEs.
 *   LEAVE      named reasons below; nothing written.
 *   REFUSE     destination collision (a DIFFERENT sale already resident) --
 *              neither moved.
 *   COLLAPSE   the SAME sale (by content hash) already resident at the
 *              destination -- the short-address copy is deleted, the
 *              resident is untouched.
 *
 * SPLIT-IDENTITY (REVIEW FIX, CRITICAL finding 1). The ONLY two writable
 * shapes, both requiring cardId and hobbyiqCardId to AGREE before the move
 * (never independently -- the old `patch` branch moved hobbyiqCardId alone
 * onto the insert while leaving a DISAGREEING cardId exactly where it was,
 * manufacturing a WORSE split than the one it started from and never parking
 * it):
 *
 *   (A) RELOCATE  cardId === hobbyiqCardId, both the base product's own hiq:
 *                 slug -- both fields move together, one axis (the setKey
 *                 segment), via relocate-sold-comp.cjs's upsert-verify-delete.
 *   (B) PATCH     cardId is a RAW VENDOR id (does not start with "hiq:") and
 *                 hobbyiqCardId is the base product's slug -- only
 *                 hobbyiqCardId is patched; cardId (a legacy vendor
 *                 partition key) is untouched, exactly the shape
 *                 repoint-sales-to-checklist-numbered.cjs's own patch branch
 *                 already draws.
 *
 * Any OTHER shape -- most pointedly cardId and hobbyiqCardId are BOTH
 * `hiq:` slugs but name DIFFERENT products (cardId says panini-prizm,
 * hobbyiqCardId says panini-photogenic) -- is a PRE-EXISTING SPLIT this lane
 * did not create and must not deepen. LEAVE `pre-existing-split-identity`,
 * listing BOTH ids and which field this candidate query matched on; nothing
 * is written. This is the same disagreement guardSoldCompDoc's own
 * decideSplitIdentity already names and parks at the INGEST door -- this
 * lane does not re-park it (parking is `identityUnverified`'s own job,
 * already handled as a never-move marker below), it simply refuses to widen
 * it by moving only one side.
 *
 * guardSoldCompDoc RUN ON THE WOULD-BE DOCUMENT, BOTH SHAPES (REVIEW FIX,
 * part of finding 1). Before either a relocate or a patch actually writes,
 * the WOULD-BE new document (cardId/hobbyiqCardId both already set to the
 * insert's address, per whichever shape applies) is run through
 * guardSoldCompDoc -- the SAME write-door predicate recordSoldComp itself
 * applies -- and a `park` verdict is honoured (the doc is stamped
 * identityUnverified and written parked, never silently forced through as a
 * clean insert-keyed row). The old patch branch skipped this entirely.
 *
 * FULL-CELL DEFENCE IN DEPTH (REVIEW FIX, part of finding 1). Beyond the
 * setKey-segment comparison, `planInsertRekey` also compares the sale's OWN
 * (sport, year, setKey) cell -- read off whichever field is the base slug --
 * against the UNIT's own (sport, year, baseSetKey) before ever proposing a
 * move. A STARTSWITH false positive or a cross-cell contamination is refused
 * the same way (LEAVE `neither-field-names-base-product`), never trusted on
 * the setKey segment alone.
 *
 * NEVER-MOVE MARKERS (checked first, before any title/checklist work):
 *   verifiedByUser === true      a real user attested THIS sale to THIS card.
 *   source in USER_SEED_SOURCES  ebay-user-purchase / ebay-user-sale /
 *                                 manual-user-entry / user-verified --
 *                                 soldCompsStore.service.ts's own set: these
 *                                 transactions are ALREADY reconciled through
 *                                 the catalog by the user's own action per
 *                                 CF-A-USER-SALE-IS-ALWAYS-RECONCILED.
 *   identityUnverified === true   already parked by the split-identity guard
 *                                 or by R70 itself; unparking is a different
 *                                 lane's job.
 *   flaggedWrong === true        (REVIEW FIX, finding 4) the row's own
 *                                 moderation flag -- a user has already told
 *                                 the engine this comp is wrong; re-addressing
 *                                 it under a NEW identity on a title-
 *                                 vocabulary guess compounds that, it does not
 *                                 resolve it.
 *   excludedFromFmv === true     (REVIEW FIX, finding 4) already excluded
 *                                 from pricing for a reason this lane has no
 *                                 visibility into; moving it does not restore
 *                                 trust, it just moves a doubted row.
 *   All four bucket to LEAVE `pinned-or-verified` (the first three) or
 *   `flagged-or-excluded` (the last two) -- kept as two named reasons rather
 *   than one, so an operator can tell "a person vouched for this" from "a
 *   person or the engine doubted this" at a glance.
 *
 * LEAVE REASONS:
 *   two-inserts-named             the title names two distinct insert
 *                                 families -- R70's own "never choose" rule,
 *                                 reused: guessing between two named games
 *                                 risks the wrong one.
 *   pinned-or-verified            see NEVER-MOVE MARKERS above.
 *   flagged-or-excluded           see NEVER-MOVE MARKERS above.
 *   already-parked                see NEVER-MOVE MARKERS above.
 *   number-is-base-number         see CARD-NUMBER RULE above.
 *   destination-rung-not-on-checklist  see DESTINATION RUNG RULE above.
 *   no-checklist-match            the title names this insert and the number
 *                                 is not the base number, but no checklist
 *                                 row confirms BOTH the number and the (when
 *                                 known) player together -- refuted, not
 *                                 unknown (the checklist rows were already
 *                                 loaded in step 3; there is no "the read
 *                                 failed" case here the way
 *                                 insertSetChecklistConfirm.ts's live,
 *                                 per-sale query has to allow for).
 *   title-does-not-name-insert    the title names no known insert of its own
 *                                 product at all.
 *   title-names-a-different-insert  the title names a registered insert, but
 *                                 not one requested (`titles`) this run.
 *   pre-existing-split-identity   see SPLIT-IDENTITY above.
 *   neither-field-names-base-product  neither field names this unit's base
 *                                 product/cell at all -- not this unit's row.
 *   insert-checklist-empty        the insert setKey has ZERO checklist-
 *                                 authority rows in this cell -- nothing to
 *                                 confirm against; counted separately from
 *                                 no-checklist-match so an operator can tell
 *                                 "wrong number" from "the checklist was
 *                                 never ingested for this cell".
 *
 * CF-A-SALE-IS-NEVER-LOST throughout: every relocation goes through
 * scripts/lib/relocate-sold-comp.cjs (upsert -> verify read-back -> delete);
 * the banner's own reconciliation is candidates found == moved + refused +
 * collapsed + failed + left (named).
 *
 * DUAL-ADDRESS RACE (REVIEW FIX, CRITICAL finding 2; corrected in a SECOND
 * review, 2026-09-19). CardHedge dual-id twins -- the SAME sale `id`,
 * resident at TWO different sold_comps partitions
 * (project_cardhedge_dual_id_duplicates_and_graded_in_raw_pool) -- can both
 * appear as separate candidate rows in one unit's STARTSWITH scan, and both
 * independently plan a write. Two DIFFERENT races, fixed two different ways:
 *
 *   RELOCATE-VS-RELOCATE (the actual race: two copies proposing to land at
 *   the SAME destination address). BY CONSTRUCTION: candidates are grouped
 *   by sale `id` before planning, and every copy of one `id` is handled
 *   SERIALLY, in one pass, within one unit (units themselves may still run
 *   concurrently -- a DIFFERENT sale id is unaffected by another unit's
 *   timing). The first RELOCATE-shape copy processed performs the relocate;
 *   every LATER RELOCATE-shape copy of the same id then re-checks the
 *   destination (now resident) and either COLLAPSES (same content hash) or
 *   REFUSES (destination-collision) -- never a second independent upsert
 *   racing the first. `alreadyHandled` -- the flag this short-circuit reads
 *   -- is set ONLY by a relocate, and gates ONLY the relocate branch.
 *
 *   PATCH IS NEVER PART OF THIS RACE (SECOND REVIEW FIX). A patch-shape
 *   copy's document lives at its OWN vendor cardId partition -- a DIFFERENT
 *   Cosmos document from any relocate-shape twin's destination (keyed on the
 *   insert's hiq: slug) -- so a patch can NEVER collide with a relocate
 *   destination and has nothing to "already be handled" by. The FIRST
 *   version of this fix gated the patch branch on `alreadyHandled` too,
 *   which silently skipped writing a patch-shape twin whenever ANY earlier
 *   same-id copy (relocate OR patch) had already run: the write never
 *   happened, was mis-counted as `collapsedOntoResident`, left a real
 *   Cosmos document on its stale base hobbyiqCardId, and (since the flag
 *   stayed true for the rest of that id's copies) was never retried on a
 *   re-run either. Every patch-shape copy of a same-id group now gets its
 *   OWN independent plan-write cycle, unconditionally -- own pre-write etag
 *   re-read, own IfMatch, own counter. Two patch-shape twins of one id both
 *   patch, each at its own address.
 *
 *   LAST-LINE DEFENCE (part b, applies to both shapes). Immediately before
 *   every write (upsert, patch, or delete of the SOURCE row), the source
 *   document is RE-READ and its `_etag` compared against the etag captured
 *   at planning time. A mismatch means some OTHER process (a concurrent
 *   unit, a live ingest re-upsert) wrote this exact row between the plan and
 *   the write -- refused as `changed-since-planned`, nothing written, the
 *   row is left for a future run to re-evaluate fresh. The write itself is
 *   issued with `accessCondition: { type: "IfMatch", condition: etag }`
 *   (the SAME precedent backfill-holding-ebay-ids.cjs already uses for
 *   portfolio replaces), so even a race that slips past the JS re-read is
 *   caught by Cosmos itself at the storage layer and answered with a 412
 *   Precondition Failed, handled identically to a local mismatch.
 *
 * CONCURRENCY FROM THE START (per the brief: the model lane's serial
 * per-target loop over its one cross-partition query is a known defect, PR in
 * flight). This lane's per-(cell, baseSetKey) UNIT loop runs with bounded
 * concurrency (`CONCURRENCY`, default 6) via a small in-file pool -- each
 * unit's own work executes inside that same budget, never unbounded. Every
 * unit's write path (relocate / patch / holdings) is independent of every
 * OTHER unit's (a different base product, or a different cell), so
 * interleaving them changes nothing about correctness, only wall clock --
 * verified by the "concurrency>1 produces identical counters to
 * CONCURRENCY=1" pin below. WITHIN one unit, same-id candidates are handled
 * serially (see DUAL-ADDRESS RACE above) regardless of the unit-level
 * concurrency setting.
 *
 * REPORT-FIRST. BACKFILL_APPLY=true (not APPLY) gates every write, matching
 * the runner's own env name and every sibling lane. `planInsertRekey` is
 * pure and runs identically in both modes; REPORT prints the same "would
 * move" counts a real APPLY would produce (pinned by the REPORT==APPLY
 * parity test below).
 *
 * SCOPE IS REQUIRED (sport:year cells, the runner's own `scope` input,
 * rekey-catalog-id-to-setkey's convention). TITLES/SET_KEYS IS REQUIRED and
 * names one or more REGISTERED INSERT setKeys -- empty or a wildcard ('all',
 * '*') is refused (exit 2): this lane rewrites the id segment itself, so
 * "every insert" is a whole-source write that needs its own name.
 *
 * NO NEW WORKFLOW INPUT. `titles` (BCP_TITLES) carries the insert setKey
 * list, exactly the convention repoint-sales-to-checklist-numbered.cjs and
 * rekey-catalog-id-to-setkey.cjs already use it for.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true / APPLY=true to write;
 *      SCOPE required (sport:year cells, comma list); SET_KEYS required
 *      (comma list of REGISTERED INSERT setKeys, no 'all'/'*');
 *      SLOT/SLOTS (sha1(id) shards, opt-in via SHARD=true for slot 0);
 *      CONCURRENCY=6; RUN_MINUTES=110; LIMIT=0.
 * Requires dist/ (insertSetTitleReader, productSetKeys, catalogAuthority,
 * splitIdentityWriteGuard, hobbyIqCardId, playerIdentityKey).
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
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 6));
const LIMIT = Number(process.env.LIMIT || 0);

const SHARD_SCOPE = runnerShardScope({ label: "repoint-stored-insert-sales" });
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SHARD_SCOPE.SLOTS;

// ── THE SCOPE. sport:year cells; an inherited default is REFUSED ────────────
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const CELL_RE = /^[a-z][a-z0-9-]*:\d{4}$/;
const SCOPE_CELLS = RAW_SCOPE.map(lower).filter((p) => CELL_RE.test(p));
const SCOPE_REJECTED = RAW_SCOPE.filter((p) => !CELL_RE.test(lower(p)));

// ── THE TARGET INSERT SETKEYS. Riding the runner's `titles` input (SET_KEYS/
// BCP_TITLES), the same convention repoint-sales-to-checklist-numbered.cjs
// and rekey-catalog-id-to-setkey.cjs already use it for. Empty or a wildcard
// is refused -- a whole-source write needs its own name.
const WILDCARDS = new Set(["", "all", "*"]);
const RAW_SET_KEYS = csv(process.env.SET_KEYS || process.env.BCP_TITLES).map(lower);
const SET_KEYS = RAW_SET_KEYS.filter((k) => !WILDCARDS.has(k));

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

async function forEachPage(container, spec, onPage, pageSize = 1000) {
  let token;
  do {
    const page = await retry(() => container.items
      .query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

/** A tiny bounded-concurrency pool -- CONCURRENCY workers pull from `items`
 *  and run `worker` on each; the model lane's own header names its serial
 *  per-target loop as the known defect this lane must not repeat. Each
 *  unit's own writes are independent of every other's (a different base
 *  product, or a different cell), so interleaving changes only wall clock,
 *  never which decision a given sale receives -- pinned by the
 *  identical-counters-under-concurrency test. Same-id candidates WITHIN one
 *  unit are still handled serially by that unit's own logic (see the
 *  DUAL-ADDRESS RACE fix), independent of this pool's concurrency. */
async function runPool(items, concurrency, worker) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) || 0 }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(workers);
}

/** Page size for the base-cell STARTSWITH candidate scan. */
const CANDIDATE_PAGE_SIZE = 500;

/**
 * LOCAL leading-zero fold, over `cardNumberVariants`'s own (unchanged)
 * output -- the SAME fold insertSetChecklistConfirm.ts applies, for the SAME
 * reason (hobbyIqCardId.service.ts, its home, is a declared derivation-stamp
 * input; this lane may only ever widen a comparison over its existing output,
 * never edit the shared helper). "BD005" gains "BD5"/"BD-5"; a bare "005"
 * gains "5". Never strips a run to nothing ("000" keeps "0").
 */
function withLeadingZeroFold(variants) {
  const out = new Set(variants);
  for (const v of variants) {
    const m = /^([A-Za-z]*)-?(0+\d+)$/.exec(v);
    if (!m) continue;
    const [, prefix, digits] = m;
    const stripped = digits.replace(/^0+(?=\d)/, "");
    if (!stripped || stripped === digits) continue;
    out.add(`${prefix}${stripped}`);
    out.add(`${prefix}${stripped}`.toLowerCase());
    if (prefix) {
      out.add(`${prefix}-${stripped}`);
      out.add(`${prefix}-${stripped}`.toLowerCase());
    }
  }
  return [...out];
}

const normNumber = (n) => String(n ?? "").trim().toLowerCase();
/** Human-form, mixed-case checklist parallel spellings -- compared
 *  case-insensitively, same discipline the catalog's own LOWER(c.parallel)
 *  convention already uses. */
const normParallelForRung = (p) => String(p ?? "").trim().toLowerCase().replace(/\s+/g, " ") || "base";

/** Multi-player catalog rows are one string with every name listed
 *  ("Eddie Murray / Cal Ripken Jr.") -- the SAME D33 shape
 *  insertSetChecklistConfirm.ts's catalogRowPlayerKeys reads. Split on the
 *  documented separators; a single-name row is a one-element list. */
function catalogRowPlayerKeys(playerIdentityKeyFn, playerName) {
  const raw = String(playerName ?? "");
  const keys = new Set();
  for (const part of raw.split(/\s*[/&]\s*/)) {
    const k = playerIdentityKeyFn(part);
    if (k) keys.add(k);
  }
  return keys;
}

function playerMatchesRow(playerIdentityKeyFn, salePlayer, rowPlayer) {
  const saleKey = playerIdentityKeyFn(salePlayer ?? "");
  if (!saleKey) return false;
  return catalogRowPlayerKeys(playerIdentityKeyFn, rowPlayer).has(saleKey);
}

/**
 * THE pure confirmation predicate -- insertSetChecklistConfirm.ts's own FIX-1
 * rule ("both known -> one row must confirm both, together"), evaluated here
 * against checklist rows ALREADY LOADED for the whole target (no per-sale
 * Cosmos read; this is the one difference from that module's shape, which
 * exists solely because that module answers per-sale, at ingest, and this
 * lane answers per-target, once, against a set it already paged).
 *
 * @param {{cardNumberVariants:(s:string)=>string[], playerIdentityKey:(s:string)=>string}} deps
 * @param {Array<{cardNumber?:string|null, playerName?:string|null}>} checklistRows
 * @param {string|null} saleCardNumber
 * @param {string|null} salePlayerName
 * @returns {"confirmed"|"refuted"} -- never "unknown": the rows are already
 *          in hand, so there is no read to fail.
 */
function confirmedAgainstLoadedChecklist(deps, checklistRows, saleCardNumber, salePlayerName) {
  const num = normNumber(saleCardNumber);
  const playerKey = deps.playerIdentityKey(salePlayerName ?? "");
  if (!num && !playerKey) return "refuted";
  const variants = num
    ? new Set(withLeadingZeroFold(deps.cardNumberVariants(saleCardNumber)).map((v) => v.toLowerCase()))
    : null;
  let matched;
  if (num && playerKey) {
    matched = checklistRows.some((r) => variants.has(normNumber(r.cardNumber)) && playerMatchesRow(deps.playerIdentityKey, salePlayerName, r.playerName));
  } else if (num) {
    matched = checklistRows.some((r) => variants.has(normNumber(r.cardNumber)));
  } else {
    matched = checklistRows.some((r) => playerMatchesRow(deps.playerIdentityKey, salePlayerName, r.playerName));
  }
  return matched ? "confirmed" : "refuted";
}

/** Every normalised card-number variant appearing on the insert's own
 *  checklist rows -- used ONLY for the "number-is-base-number" LEAVE
 *  distinction (a stored number that never appears on the insert's
 *  checklist under any variant is presumptively the BASE product's own
 *  number for that slot, not a mis-transcribed insert number). */
function checklistNumberVariantSet(deps, checklistRows) {
  const set = new Set();
  for (const r of checklistRows) {
    if (!r.cardNumber) continue;
    for (const v of withLeadingZeroFold(deps.cardNumberVariants(r.cardNumber))) set.add(v.toLowerCase());
  }
  return set;
}

/**
 * DESTINATION RUNG RULE (REVIEW FIX, finding 5). Does a checklist-authority
 * row exist for this insert at THIS EXACT (cardNumber, parallel, isAuto)
 * combination? Bounded, over the SAME already-loaded checklist rows -- no
 * per-sale I/O. `parallel`/`isAuto` on a checklist row are compared to the
 * SALE's own stored `parallel`/`isAuto`, since the move keeps those segments
 * byte-identical (one axis only) -- so if the checklist never attests this
 * exact rung, the destination the move would mint is unattested regardless
 * of the number matching.
 */
function destinationRungOnChecklist(deps, checklistRows, saleCardNumber, saleParallel, saleIsAuto) {
  const variants = new Set(withLeadingZeroFold(deps.cardNumberVariants(saleCardNumber)).map((v) => v.toLowerCase()));
  const num = normNumber(saleCardNumber);
  const wantParallel = normParallelForRung(saleParallel);
  const wantAuto = saleIsAuto === true;
  return checklistRows.some((r) => {
    const rNum = normNumber(r.cardNumber);
    if (rNum !== num && !variants.has(rNum)) return false;
    const rParallel = normParallelForRung(r.parallelSlug ?? r.parallel);
    if (rParallel !== wantParallel) return false;
    const rAuto = r.isAuto === true;
    return rAuto === wantAuto;
  });
}

const USER_SEED_SOURCES = new Set(["ebay-user-purchase", "ebay-user-sale", "manual-user-entry", "user-verified"]);

/**
 * Pure per-sale decision -- no I/O -- so REPORT and APPLY run the EXACT same
 * logic (the sibling bug this guards against: a structural zero because a
 * write-only code path decided something a report-only path never ran).
 *
 * @param {object} deps  { insertSetNamedInTitle, cardNumberVariants, playerIdentityKey, withProductSetKey }
 * @param {object} sale  the sold_comps row as read
 * @param {object} ctx
 * @param {string} ctx.sport
 * @param {number} ctx.year
 * @param {string} ctx.baseSetKey       the base product's setKey (from productParentOf)
 * @param {Map<string,{checklistRows:Array, checklistNumberVariants:Set<string>}>} ctx.insertsByKey
 *        every REQUESTED insert sharing this unit's base product, keyed by
 *        insertSetKey, each carrying its own already-loaded checklist rows.
 */
function planInsertRekey(deps, sale, ctx) {
  // ── NEVER-MOVE MARKERS, checked first, before any title/checklist work ──
  if (sale.verifiedByUser === true) {
    return { action: "leave", reason: "pinned-or-verified", detail: "verifiedByUser=true -- a real user attested this exact sale to this exact card" };
  }
  if (USER_SEED_SOURCES.has(String(sale.source ?? ""))) {
    return { action: "leave", reason: "pinned-or-verified", detail: `source=${sale.source} -- a user-owned transaction already reconciled through the catalog at write time (CF-A-USER-SALE-IS-ALWAYS-RECONCILED)` };
  }
  if (sale.identityUnverified === true) {
    return { action: "leave", reason: "already-parked", detail: "identityUnverified=true -- already parked; unparking is a different lane's job" };
  }
  if (sale.flaggedWrong === true) {
    return { action: "leave", reason: "flagged-or-excluded", detail: "flaggedWrong=true -- a user already told the engine this comp is wrong; re-addressing it compounds that, it does not resolve it" };
  }
  if (sale.excludedFromFmv === true) {
    return { action: "leave", reason: "flagged-or-excluded", detail: "excludedFromFmv=true -- already excluded from pricing; moving it does not restore trust" };
  }

  // ── FULL-CELL DEFENCE IN DEPTH (REVIEW FIX, finding 1). Compare the sale's
  // OWN (sport, year, setKey) cell -- read off whichever field is the base
  // slug -- against the UNIT's own cell, not merely the setKey segment. A
  // STARTSWITH false positive or cross-cell contamination is refused here,
  // never trusted on the setKey segment alone.
  const hiq = String(sale.hobbyiqCardId ?? "");
  const cardId = String(sale.cardId ?? "");
  const cellOf = (slug) => {
    const parts = slug.split(":");
    if (parts.length < 4 || parts[0] !== "hiq") return null;
    return `${parts[1]}|${parts[2]}|${parts[3]}`;
  };
  const wantCell = `${ctx.sport}|${ctx.year}|${ctx.baseSetKey}`;
  const hiqCell = hiq.startsWith("hiq:") ? cellOf(hiq) : null;
  const cardIdCell = cardId.startsWith("hiq:") ? cellOf(cardId) : null;
  const hiqBase = hiqCell === wantCell;
  const cardIdBase = cardIdCell === wantCell;
  if (!hiqBase && !cardIdBase) {
    return { action: "leave", reason: "neither-field-names-base-product", detail: `cardId=${cardId} hobbyiqCardId=${hiq} -- neither names ${wantCell}; not this unit's row` };
  }

  // ── SPLIT-IDENTITY (REVIEW FIX, CRITICAL finding 1). Both fields are
  // `hiq:` slugs but name DIFFERENT products/cells -- a PRE-EXISTING split
  // this lane did not create and must not deepen by moving only one side.
  if (cardId.startsWith("hiq:") && hiq.startsWith("hiq:") && cardIdCell !== null && hiqCell !== null && cardIdCell !== hiqCell) {
    return {
      action: "leave", reason: "pre-existing-split-identity",
      detail: `cardId=${cardId} hobbyiqCardId=${hiq} -- both are hiq: slugs naming DIFFERENT cells; not this lane's to arbitrate or deepen`,
    };
  }

  const insertMatches = deps.insertSetNamedInTitle({
    title: sale.title, sport: ctx.sport, year: ctx.year, setKey: ctx.baseSetKey, playerName: sale.playerName,
  });
  if (insertMatches.length === 0) {
    return { action: "leave", reason: "title-does-not-name-insert", detail: "title names no known insert of its own product" };
  }
  if (insertMatches.length > 1) {
    return {
      action: "leave", reason: "two-inserts-named",
      detail: `title names ${insertMatches.length} distinct insert sets (${insertMatches.map((m) => m.root).join(", ")}) -- never choosing between two named games`,
    };
  }
  const only = insertMatches[0];
  const insertSetKey = only.registeredKey;
  const insertCtx = insertSetKey ? ctx.insertsByKey.get(insertSetKey) : null;
  if (!insertCtx) {
    // Names a registered insert, but not one requested (`titles`) this run --
    // it will be a candidate under its own insert's target if/when that key
    // is also in scope.
    return { action: "leave", reason: "title-names-a-different-insert", detail: `title names "${only.root}" -> ${insertSetKey ?? "(unregistered)"}, not in this run's requested set` };
  }

  const num = normNumber(sale.cardNumber);
  if (num && !insertCtx.checklistNumberVariants.has(num) && !withLeadingZeroFold(deps.cardNumberVariants(sale.cardNumber)).some((v) => insertCtx.checklistNumberVariants.has(v.toLowerCase()))) {
    return { action: "leave", reason: "number-is-base-number", detail: `stored cardNumber "${sale.cardNumber}" never appears on ${insertSetKey}'s checklist -- likely the base product's own number for this slot; a title re-read is a different pass` };
  }

  const verdict = confirmedAgainstLoadedChecklist(deps, insertCtx.checklistRows, sale.cardNumber, sale.playerName);
  if (verdict !== "confirmed") {
    return { action: "leave", reason: "no-checklist-match", detail: `title names ${insertSetKey} but no checklist row confirms cardNumber="${sale.cardNumber ?? ""}" playerName="${sale.playerName ?? ""}" together` };
  }

  // ── DESTINATION RUNG (REVIEW FIX, finding 5). The number is confirmed;
  // the exact (number, parallel, auto) destination rung must ALSO be
  // checklist-attested -- "price only checklist-matched identities".
  if (!destinationRungOnChecklist(deps, insertCtx.checklistRows, sale.cardNumber, sale.parallel, sale.isAuto)) {
    const rungKey = `${insertSetKey}|${normParallelForRung(sale.parallel)}|${sale.isAuto === true ? "auto" : "no-auto"}`;
    return {
      action: "leave", reason: "destination-rung-not-on-checklist",
      detail: `${insertSetKey} #${sale.cardNumber ?? ""} confirms on number+player, but no checklist row attests the (parallel="${sale.parallel ?? "base"}", auto=${sale.isAuto === true}) rung this move would mint`,
      rungKey,
    };
  }

  // ── MOVE. One axis: the setKey segment. Only the two writable shapes named
  // in SPLIT-IDENTITY above are ever reached here (the split case already
  // returned above; the neither-field case already returned above), so by
  // this point exactly one of RELOCATE (both fields agree, both hiq:) or
  // PATCH (cardId is a raw vendor id) applies.
  const newHiq = deps.withProductSetKey(hiq, insertSetKey);
  if (cardId.startsWith("hiq:") && cardId === hiq) {
    const newCardId = deps.withProductSetKey(cardId, insertSetKey);
    return { action: "relocate", newCardId, newHiq: newCardId, insertSetKey };
  }
  // cardId is a raw vendor id (does not start with "hiq:") -- shape (B).
  return { action: "patch", newHiq, insertSetKey };
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  REPOINT: stored insert sales sitting in a BASE product's pool follow the");
  console.log("  insert's OWN checklist-confirmed identity (CF-INGEST-KEEPS-STORED-IDENTITY repair)");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  if (SCOPE_REJECTED.length) {
    console.error("");
    console.error(`FATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are not cells: ${SCOPE_REJECTED.join(", ")}`);
    console.error("       A cell looks like football:2024 (sport:year).");
    process.exit(2);
  }
  if (!SCOPE_CELLS.length || RAW_SCOPE.some((x) => INHERITED_SCOPES.has(lower(x)))) {
    console.error("");
    console.error("FATAL: SCOPE is REQUIRED and names the cells to scan, as sport:year.");
    console.error("       There is no 'all' for this lane. Dispatch with -f scope=football:2024,football:2025");
    console.error("       (comma-separate for several cells).");
    process.exit(2);
  }
  if (!SET_KEYS.length) {
    console.error("");
    console.error("FATAL: SET_KEYS (the runner's `titles` input) is REQUIRED and names the");
    console.error("       REGISTERED INSERT setKey(s) to repair -- an empty value or a wildcard");
    console.error("       ('all', '*') is refused: a whole-source write needs its own name.");
    console.error("       Dispatch with -f titles=panini-photogenic-rookie-pix (comma-separate for several).");
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const { productParentOf } = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
  const { insertSetNamedInTitle } = require(path.join(backend, "dist/services/portfolioiq/insertSetTitleReader.js"));
  const { cardNumberVariants } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { playerIdentityKey } = require(path.join(backend, "dist/services/catalog/playerIdentityKey.js"));
  const { withProductSetKey, guardSoldCompDoc } = require(path.join(backend, "dist/services/portfolioiq/splitIdentityWriteGuard.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));

  const deps = { insertSetNamedInTitle, cardNumberVariants, playerIdentityKey, withProductSetKey };
  const isChecklist = (source) => catalogAuthorityOf(source) === "checklist";

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");
  const portfolio = db.container("portfolio");

  // ── Resolve each target insert's base product, up front, and refuse by
  // name any insert with no registered parent -- an insert with no base
  // product is not this lane's shape (it is either a flagship's own insert
  // with no parent registered yet, or a mis-typed key).
  const insertToBase = new Map();
  const rejectedNoParent = [];
  for (const insertSetKey of SET_KEYS) {
    const parent = productParentOf(insertSetKey);
    if (!parent) { rejectedNoParent.push(insertSetKey); continue; }
    insertToBase.set(insertSetKey, parent);
  }
  if (rejectedNoParent.length) {
    console.error("");
    console.error(`FATAL: ${rejectedNoParent.length} setKey(s) have no registered PARENT in productSetKeys.ts: ${rejectedNoParent.join(", ")}`);
    console.error("       This lane repairs a registered INSERT's sales against its BASE product;");
    console.error("       a key with no parent names no base product to repair away from.");
    process.exit(2);
  }

  // ── REVIEW FIX (finding 3): GROUP requested inserts by BASE PRODUCT, so a
  // base cell shared by several requested inserts (panini-photogenic-
  // rookie-pix + panini-photogenic-troops-tribute, both under
  // panini-photogenic) is scanned exactly ONCE per (cell, baseSetKey) unit,
  // never once per insert key.
  const baseSetKeys = [...new Set(insertToBase.values())];
  const insertsByBase = new Map(); // baseSetKey -> [insertSetKey, ...]
  for (const [insertSetKey, baseSetKey] of insertToBase) {
    const list = insertsByBase.get(baseSetKey) ?? [];
    list.push(insertSetKey);
    insertsByBase.set(baseSetKey, list);
  }

  console.log(`  scope (${SCOPE_CELLS.length} cell${SCOPE_CELLS.length === 1 ? "" : "s"})    ${SCOPE_CELLS.join(", ")}`);
  console.log(`  target insert setKeys   ${[...insertToBase.entries()].map(([k, p]) => `${k} (base: ${p})`).join(", ")}`);
  console.log(`  base products (${baseSetKeys.length}, each scanned ONCE per cell)   ${baseSetKeys.join(", ")}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log(`  concurrency ${CONCURRENCY}`);
  console.log("");

  const s = {
    checklistRowsScanned: 0, insertChecklistEmpty: 0, unitsFailed: 0,
    candidateNumbers: 0, candidatesFound: 0, otherShard: 0,
    moved: 0, patched: 0, collapsedOntoResident: 0,
    leftPinnedOrVerified: 0, leftFlaggedOrExcluded: 0, leftAlreadyParked: 0, leftNumberIsBaseNumber: 0,
    leftNoChecklistMatch: 0, leftTitleDoesNotNameInsert: 0, leftTwoInsertsNamed: 0,
    leftTitleNamesDifferentInsert: 0, leftNeitherFieldNamesBase: 0, leftPreExistingSplitIdentity: 0,
    leftDestinationRungNotOnChecklist: 0,
    refusedDestinationCollision: 0, refusedChangedSincePlanned: 0, failed: 0,
    holdingsRepointed: 0, holdingsWalked: 0, holdingDocsWalked: 0,
    unitsProcessed: 0,
  };
  const bySetKey = new Map();
  const rungGaps = new Map(); // rungKey -> count
  const moveExamples = [];
  const leaveBuckets = {
    "pinned-or-verified": [], "flagged-or-excluded": [], "already-parked": [], "number-is-base-number": [],
    "destination-rung-not-on-checklist": [],
    "no-checklist-match": [], "title-does-not-name-insert": [], "two-inserts-named": [],
    "title-names-a-different-insert": [], "neither-field-names-base-product": [], "pre-existing-split-identity": [],
  };
  const failures = [];
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  let stoppedAtBudget = false;

  // ── Holdings index, built ONCE -- fold-checklist-numbered-twins' own
  // shape, portfolio.holdings is a MAP: Object.entries, never JOIN.
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
          for (const slug of new Set([String(h.hobbyiqCardId ?? ""), String(h.cardId ?? "")])) {
            if (!slug) continue;
            const list = index.get(slug) ?? [];
            list.push({ docId: doc.id, userId: doc.userId, holdingId: hid });
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

  async function repointHoldings(oldId, newId) {
    const hits = holdingsIndex.get(oldId);
    if (!hits || !hits.length) return;
    const byDoc = new Map();
    for (const h of hits) {
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
        ops.push({ op: "set", path: `/holdings/${hid}/identityResolvedBy`, value: "repoint-stored-insert-sales" });
        ops.push({ op: "set", path: `/holdings/${hid}/identityResolvedAt`, value: new Date().toISOString() });
        ops.push({ op: "set", path: `/holdings/${hid}/identityRenamedFrom`, value: oldId });
      }
      if (APPLY) await retry(() => portfolio.item(docId, userId).patch(ops));
      s.holdingsRepointed += ids.size;
    }
    holdingsIndex.delete(oldId);
  }

  async function residentAt(saleId, cardId) {
    try { return (await retry(() => pool.item(saleId, cardId).read())).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
  }
  function isSameSale(resident, incomingAtNewAddress) {
    if (!resident) return false;
    return contentHashOf(resident) === contentHashOf(incomingAtNewAddress);
  }

  /**
   * DUAL-ADDRESS RACE, last-line defence (REVIEW FIX, CRITICAL finding 2,
   * part b). Re-read the SOURCE document immediately before writing and
   * compare `_etag` against the etag captured when this sale was planned. A
   * mismatch means some OTHER process (a concurrent unit, a live ingest
   * re-upsert) wrote this exact row between the plan and the write -- refuse
   * rather than write over an unknown state. Returns the fresh doc's etag on
   * success (for the accessCondition passed to the actual write), or null on
   * mismatch/gone.
   */
  async function etagUnchangedOrRefuse(saleId, cardId, plannedEtag) {
    let fresh;
    try { fresh = (await retry(() => pool.item(saleId, cardId).read())).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return { ok: false, gone: true }; throw e; }
    if (!fresh) return { ok: false, gone: true };
    if (String(fresh._etag ?? "") !== String(plannedEtag ?? "")) return { ok: false, gone: false, fresh };
    return { ok: true, etag: fresh._etag };
  }

  /** One (cell, baseSetKey) unit: page EVERY requested insert's checklist
   *  rows sharing this base product, scan the base cell's candidates ONCE,
   *  route each candidate to its matched insert's confirmation set, plan and
   *  (in APPLY) write each one. Same-id candidates are handled serially
   *  within this function (never two independent writes for one sale id) --
   *  see DUAL-ADDRESS RACE. Independent of every OTHER unit -- safe to run
   *  inside the concurrency pool. */
  async function processUnit(cell, baseSetKey, insertSetKeysHere) {
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; return; }
    const [sport, yearStr] = cell.split(":");
    const year = Number(yearStr);

    if (SHARD_SCOPE.SHARDED && shardOf(`${cell}|${baseSetKey}`) !== SHARD_SCOPE.SLOT) { s.otherShard++; return; }

    // ── STEP 3: EVERY requested insert sharing this base product's own
    // CHECKLIST-AUTHORITY rows for this cell, one page per insert (never one
    // per sale) -- the CONFIRMATION SETS this unit's candidates route into.
    const insertsByKey = new Map();
    for (const insertSetKey of insertSetKeysHere) {
      const checklistRows = [];
      await forEachPage(cat, {
        query: `SELECT c.cardNumber, c.playerName, c.source, c.parallelSlug, c.parallel, c.isAuto FROM c
                WHERE c.sport = @sport AND (c.year = @year OR c.cardYear = @year)
                  AND c.setKey = @setKey AND NOT IS_DEFINED(c.gradeTier)`,
        parameters: [
          { name: "@sport", value: sport },
          { name: "@year", value: year },
          { name: "@setKey", value: insertSetKey },
        ],
      }, async (page) => {
        for (const r of page) { s.checklistRowsScanned++; if (isChecklist(r.source)) checklistRows.push(r); }
        return true;
      });

      if (checklistRows.length === 0) {
        s.insertChecklistEmpty++;
        continue;
      }
      insertsByKey.set(insertSetKey, {
        checklistRows,
        checklistNumberVariants: checklistNumberVariantSet(deps, checklistRows),
      });
      s.candidateNumbers += new Set(checklistRows.map((r) => r.cardNumber).filter(Boolean)).size;
    }
    s.unitsProcessed++;
    if (insertsByKey.size === 0) return; // every requested insert here has an empty checklist

    // ── STEP 4: candidate sales -- STARTSWITH(c.hobbyiqCardId, @prefix) over
    // the BASE PRODUCT'S OWN CELL, scanned EXACTLY ONCE for this whole unit
    // (REVIEW FIX, finding 3) regardless of how many requested inserts share
    // this base product.
    const prefix = `hiq:${sport}:${year}:${baseSetKey}:`;
    const candidatesByKey = new Map();
    await forEachPage(pool, {
      query: "SELECT * FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)",
      parameters: [{ name: "@p", value: prefix }],
    }, async (page) => {
      for (const row of page) candidatesByKey.set(`${row.id}::${row.cardId}`, row);
      return true;
    }, CANDIDATE_PAGE_SIZE);

    // ── DUAL-ADDRESS RACE, by construction (REVIEW FIX, finding 2, part a).
    // Group every candidate by its sale `id` FIRST, so twin copies of the
    // SAME sale (a CardHedge dual-id twin, or any other same-id resident at
    // two partitions) are handled in one serial pass, never as two
    // independently-planned writes racing each other.
    const bySaleId = new Map();
    for (const sale of candidatesByKey.values()) {
      const list = bySaleId.get(sale.id) ?? [];
      list.push(sale);
      bySaleId.set(sale.id, list);
    }

    const ctx = { sport, year, baseSetKey, insertsByKey };

    for (const [, copies] of bySaleId) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; return; }
      // "Has this sale id already moved (or been collapsed/refused) earlier
      // in this SAME pass?" -- once true, every remaining copy of the id is
      // re-checked against the (now possibly resident) destination rather
      // than independently planned again.
      let alreadyHandled = false;

      for (const sale of copies) {
        s.candidatesFound++;
        if (LIMIT && (s.moved + s.patched) >= LIMIT) continue;

        let plan;
        try {
          plan = planInsertRekey(deps, sale, ctx);
        } catch (e) {
          s.failed++;
          failures.push(`  FAILED plan ${sale.id}@${sale.cardId}: ${String(e?.stack ?? e?.message ?? e)}`);
          continue;
        }

        if (plan.action === "leave") {
          const bumpMap = {
            "pinned-or-verified": "leftPinnedOrVerified", "flagged-or-excluded": "leftFlaggedOrExcluded",
            "already-parked": "leftAlreadyParked",
            "number-is-base-number": "leftNumberIsBaseNumber", "no-checklist-match": "leftNoChecklistMatch",
            "title-does-not-name-insert": "leftTitleDoesNotNameInsert", "two-inserts-named": "leftTwoInsertsNamed",
            "title-names-a-different-insert": "leftTitleNamesDifferentInsert",
            "neither-field-names-base-product": "leftNeitherFieldNamesBase",
            "pre-existing-split-identity": "leftPreExistingSplitIdentity",
            "destination-rung-not-on-checklist": "leftDestinationRungNotOnChecklist",
          };
          const key = bumpMap[plan.reason];
          if (key) s[key]++;
          if (plan.rungKey) bump(rungGaps, plan.rungKey);
          const bucket = leaveBuckets[plan.reason];
          if (bucket && bucket.length < 50) bucket.push(`  ${sale.id}@${sale.cardId}: ${plan.detail}`);
          continue;
        }

        // ── `alreadyHandled` gates ONLY relocate-shape copies (SECOND
        // REVIEW FIX, 2026-09-19). If an EARLIER RELOCATE-shape copy of this
        // same sale id already moved/collapsed in this pass, a LATER
        // RELOCATE-shape copy must not plan an independent second write to
        // the SAME destination -- it re-checks the (now-resident) address
        // instead (see the `alreadyHandled` branch just below). A PATCH-shape
        // copy's own document lives at its OWN vendor cardId partition,
        // which a relocate destination can never collide with -- it always
        // gets its own independent write, regardless of `alreadyHandled`
        // (see that branch's own header comment for why).
        try {
          if (plan.action === "relocate") {
            const oldCardId = String(sale.cardId ?? "");

            if (alreadyHandled) {
              const resident = await residentAt(sale.id, plan.newCardId);
              const wouldBeKeep = { ...stripSystem(sale), cardId: plan.newCardId, hobbyiqCardId: plan.newHiq };
              if (resident && isSameSale(resident, wouldBeKeep)) {
                if (APPLY) await retry(() => pool.item(sale.id, oldCardId).delete());
                s.collapsedOntoResident++;
              } else if (resident) {
                s.refusedDestinationCollision++;
                failures.push(`  REFUSED destination-collision ${sale.id}@${oldCardId} -> ${plan.newCardId}: a DIFFERENT sale already resides there (same-id twin race)`);
              }
              continue;
            }

            const keep = { ...stripSystem(sale), cardId: plan.newCardId, hobbyiqCardId: plan.newHiq, insertRekeyedAt: new Date().toISOString(), insertRekeyedFrom: oldCardId, insertRekeyedBy: "repoint-stored-insert-sales" };
            keep.contentHash = contentHashOf(keep);

            // ── guardSoldCompDoc, BOTH shapes (REVIEW FIX, finding 1). The
            // WOULD-BE document -- already carrying the insert's address on
            // both fields -- is run through the SAME write-door predicate
            // recordSoldComp itself applies. A park verdict is honoured, not
            // bypassed: the doc is written with the guard's own stamp, still
            // moved (the sale is real and the address is the one this lane
            // decided), but marked unverified for every downstream reader.
            guardSoldCompDoc(keep, { guardedBy: "repoint-stored-insert-sales" });

            const resident = await residentAt(sale.id, plan.newCardId);
            if (resident) {
              if (isSameSale(resident, keep)) {
                if (APPLY) await retry(() => pool.item(sale.id, oldCardId).delete());
                s.collapsedOntoResident++;
                alreadyHandled = true;
                if (bySetKey.has(plan.insertSetKey)) bump(bySetKey, plan.insertSetKey);
                continue;
              }
              s.refusedDestinationCollision++;
              failures.push(`  REFUSED destination-collision ${sale.id}@${oldCardId} -> ${plan.newCardId}: a DIFFERENT sale already resides there`);
              continue;
            }

            // ── DUAL-ADDRESS RACE, last-line defence (part b). Re-read the
            // SOURCE row and compare _etag before writing anything.
            const guardCheck = await etagUnchangedOrRefuse(sale.id, oldCardId, sale._etag);
            if (!guardCheck.ok) {
              if (guardCheck.gone) {
                // The source row is already gone -- another process (this
                // same run's own earlier copy, or a concurrent one) already
                // moved or deleted it. Treat as collapsed if the destination
                // now holds the same sale, else leave silently (nothing to
                // move, nothing lost -- the row exists somewhere already).
                const nowResident = await residentAt(sale.id, plan.newCardId);
                if (nowResident && isSameSale(nowResident, keep)) { s.collapsedOntoResident++; continue; }
                continue;
              }
              s.refusedChangedSincePlanned++;
              failures.push(`  REFUSED changed-since-planned ${sale.id}@${oldCardId}: the source row was written by another process between planning and write`);
              continue;
            }

            const res = await relocateSoldComp(pool, {
              keep, drop: [{ id: sale.id, cardId: oldCardId }], retry,
              verifyFields: ["cardId", "hobbyiqCardId"], dryRun: !APPLY,
            });
            if (!res.ok && res.stage !== "dry-run") {
              s.failed++;
              failures.push(`  FAILED relocate ${sale.id}@${oldCardId} -> ${plan.newCardId}: ${res.error ?? "unknown"}`);
              continue;
            }
            s.moved++;
            alreadyHandled = true;
            bump(bySetKey, plan.insertSetKey);
            if (moveExamples.length < 50) moveExamples.push(`  MOVE ${JSON.stringify(sale.title ?? "")} | ${oldCardId} -> ${plan.newCardId}`);
            await repointHoldings(oldCardId, plan.newCardId);
          } else {
            // patch: hobbyiqCardId only, cardId (a vendor partition) unchanged.
            //
            // REVIEW FIX (2026-09-19, second review): `alreadyHandled` must
            // NEVER gate a patch-shape copy. A patch's own document lives at
            // its OWN vendor cardId partition -- a DIFFERENT Cosmos document
            // from any relocate-shape twin's destination (which is keyed on
            // the insert's hiq: slug) -- so a patch can NEVER collide with a
            // relocate destination and has nothing to "already be handled
            // by". The first version of this fix short-circuited a
            // patch-shape twin to `collapsedOntoResident` whenever ANY
            // earlier same-id copy (relocate OR patch) had already run,
            // which silently skipped writing THIS document entirely --
            // mis-accounting a live write as a collapse, leaving a real
            // Cosmos row on its stale base hobbyiqCardId, and (since
            // `alreadyHandled` stays true for the rest of this id's copies)
            // never retried on a re-run either. Every patch-shape copy of a
            // same-id group gets its OWN independent plan-write cycle below
            // -- own pre-write etag re-read, own IfMatch, own counter --
            // regardless of what any relocate-shape or other patch-shape
            // copy of the same id already did. Two patch-shape twins of one
            // id both patch, each at its own address.
            const wouldBeDoc = { ...stripSystem(sale), hobbyiqCardId: plan.newHiq };
            guardSoldCompDoc(wouldBeDoc, { guardedBy: "repoint-stored-insert-sales" });
            const finalHiq = wouldBeDoc.hobbyiqCardId;

            const guardCheck = await etagUnchangedOrRefuse(sale.id, sale.cardId, sale._etag);
            if (!guardCheck.ok) {
              if (!guardCheck.gone) {
                s.refusedChangedSincePlanned++;
                failures.push(`  REFUSED changed-since-planned ${sale.id}@${sale.cardId}: the source row was written by another process between planning and write`);
              }
              continue;
            }

            if (APPLY) {
              await retry(() => pool.item(sale.id, sale.cardId).patch([
                { op: "set", path: "/hobbyiqCardId", value: finalHiq },
                { op: "set", path: "/identityUnverified", value: wouldBeDoc.identityUnverified ?? false },
                { op: "set", path: "/insertRekeyedFrom", value: String(sale.hobbyiqCardId ?? "") },
                { op: "set", path: "/insertRekeyedAt", value: new Date().toISOString() },
                { op: "set", path: "/insertRekeyedBy", value: "repoint-stored-insert-sales" },
              ], { accessCondition: { type: "IfMatch", condition: guardCheck.etag } }));
            }
            s.patched++;
            // NOT alreadyHandled = true: a patch's address is independent of
            // any relocate destination (see the header comment above), so it
            // must never suppress a LATER relocate-shape copy's own
            // resident/collapse check for the same sale id.
            bump(bySetKey, plan.insertSetKey);
            if (moveExamples.length < 50) moveExamples.push(`  PATCH ${JSON.stringify(sale.title ?? "")} | ${sale.cardId}: hobbyiqCardId ${sale.hobbyiqCardId} -> ${finalHiq}`);
            await repointHoldings(String(sale.hobbyiqCardId ?? ""), finalHiq);
          }
        } catch (e) {
          s.failed++;
          failures.push(`  FAILED write ${sale.id}@${sale.cardId}: ${String(e?.stack ?? e?.message ?? e)}`);
        }
      }
    }
  }

  const units = [];
  for (const cell of SCOPE_CELLS) for (const [baseSetKey, insertSetKeysHere] of insertsByBase) units.push({ cell, baseSetKey, insertSetKeysHere });
  // A persistent read failure (a query that throws every retry, a broken
  // checklist page) fails ONLY the one (cell, baseSetKey) unit it happened
  // on -- never the whole run. Each unit is independent (its own checklist
  // rows, its own candidate sales, its own writes), so one bad unit's
  // exception is caught, counted, and named here rather than rejecting the
  // pool's Promise.all and losing every OTHER unit's already-planned work.
  await runPool(units, CONCURRENCY, async ({ cell, baseSetKey, insertSetKeysHere }) => {
    try {
      await processUnit(cell, baseSetKey, insertSetKeysHere);
    } catch (e) {
      s.unitsFailed++;
      failures.push(`  FAILED unit ${cell}|${baseSetKey}: ${String(e?.stack ?? e?.message ?? e)}`);
    }
  });

  console.log("");
  console.log(`checklist rows scanned (all requested inserts)   ${f(s.checklistRowsScanned)}${SHARD_SCOPE.SHARDED ? `  (${f(s.otherShard)} units in other shards)` : ""}`);
  console.log(`  units processed (cell x base product)    ${f(s.unitsProcessed)}`);
  console.log(`  requested inserts with an EMPTY checklist  ${f(s.insertChecklistEmpty)}   <- nothing to confirm against, not ingested for this cell`);
  console.log(`  units FAILED (persistent read failure)    ${f(s.unitsFailed)}   <- this unit's sales are untouched; every OTHER unit still ran`);
  console.log(`  distinct checklist numbers scanned        ${f(s.candidateNumbers)}`);
  console.log("");
  console.log(`candidates found (title names a requested insert or not, all read)  ${f(s.candidatesFound)}`);
  console.log(`  ${APPLY ? "MOVED" : "WOULD MOVE"}          ${f(s.moved)}`);
  console.log(`  ${APPLY ? "PATCHED" : "WOULD PATCH"}        ${f(s.patched)}`);
  console.log(`  COLLAPSED onto a resident (same sale, by hash)  ${f(s.collapsedOntoResident)}`);
  console.log(`  REFUSED: destination collision            ${f(s.refusedDestinationCollision)}`);
  console.log(`  REFUSED: changed-since-planned            ${f(s.refusedChangedSincePlanned)}   <- another process wrote this row between plan and write`);
  console.log(`  failed                                    ${f(s.failed)}`);
  console.log("");
  console.log(`  LEFT: title does not name this insert     ${f(s.leftTitleDoesNotNameInsert)}`);
  console.log(`  LEFT: title names a DIFFERENT insert       ${f(s.leftTitleNamesDifferentInsert)}`);
  console.log(`  LEFT: two-inserts-named                    ${f(s.leftTwoInsertsNamed)}`);
  console.log(`  LEFT: pinned-or-verified                   ${f(s.leftPinnedOrVerified)}`);
  console.log(`  LEFT: flagged-or-excluded                  ${f(s.leftFlaggedOrExcluded)}`);
  console.log(`  LEFT: already-parked                       ${f(s.leftAlreadyParked)}`);
  console.log(`  LEFT: number-is-base-number                ${f(s.leftNumberIsBaseNumber)}`);
  console.log(`  LEFT: destination-rung-not-on-checklist    ${f(s.leftDestinationRungNotOnChecklist)}`);
  console.log(`  LEFT: no-checklist-match                   ${f(s.leftNoChecklistMatch)}`);
  console.log(`  LEFT: neither field names the base product ${f(s.leftNeitherFieldNamesBase)}`);
  console.log(`  LEFT: pre-existing-split-identity           ${f(s.leftPreExistingSplitIdentity)}`);
  console.log("");
  console.log(`  holdings re-pointed        ${f(s.holdingsRepointed)}   (walked ${f(s.holdingsWalked)} holdings across ${f(s.holdingDocsWalked)} portfolio docs)`);

  if (bySetKey.size) { console.log(`\n  by insert setKey:`); for (const [k, n] of [...bySetKey.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(9)}  ${k}`); }
  if (rungGaps.size) {
    console.log(`\n  destination-rung-not-on-checklist, by rung (insertSetKey|parallel|auto):`);
    for (const [k, n] of [...rungGaps.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(9)}  ${k}`);
  }
  if (moveExamples.length) { console.log(`\n  MOVE/PATCH examples (title | from -> to), sample of ${moveExamples.length}:`); for (const e of moveExamples) console.log(e); }
  for (const [reason, list] of Object.entries(leaveBuckets)) {
    if (list.length) { console.log(`\n  LEFT (${reason}), sample of ${f(list.length)}:`); for (const l of list) console.log(l); }
  }
  if (failures.length) { console.log(`\n  FAILURES/REFUSALS (${f(failures.length)}):`); for (const fl of failures) console.log(fl); }

  // ── CF-A-SALE-IS-NEVER-LOST reconciliation ---------------------------------
  const totalLeft = s.leftTitleDoesNotNameInsert + s.leftTitleNamesDifferentInsert + s.leftTwoInsertsNamed
    + s.leftPinnedOrVerified + s.leftFlaggedOrExcluded + s.leftAlreadyParked + s.leftNumberIsBaseNumber
    + s.leftNoChecklistMatch + s.leftNeitherFieldNamesBase + s.leftPreExistingSplitIdentity
    + s.leftDestinationRungNotOnChecklist;
  const written = s.moved + s.patched + s.collapsedOntoResident;
  const refused = s.refusedDestinationCollision + s.refusedChangedSincePlanned;
  const accountedFor = written + refused + s.failed + totalLeft;
  console.log("");
  console.log(`CF-A-SALE-IS-NEVER-LOST`);
  console.log(`  candidates found            ${f(s.candidatesFound)}`);
  console.log(`  ${APPLY ? "=" : "would be ="} moved ${f(s.moved)} + patched ${f(s.patched)} + collapsed ${f(s.collapsedOntoResident)} + refused ${f(refused)} + failed ${f(s.failed)} + left ${f(totalLeft)}`);
  if (accountedFor !== s.candidatesFound) {
    console.error(`!! CF-A-SALE-IS-NEVER-LOST: accounted ${f(accountedFor)} != found ${f(s.candidatesFound)}. A sale is unaccounted for. Exit 4.`);
    process.exitCode = 4;
  } else {
    console.log(`  matched -- every candidate is moved, patched, collapsed, refused, failed, or left with a named reason.`);
  }

  if (APPLY) {
    reportWrites({
      job: "repoint-stored-insert-sales",
      intended: s.candidatesFound,
      written,
      skipped: totalLeft,
      refused,
      failed: s.failed,
    });
  }

  console.log("");
  console.log(`  ${APPLY ? "MOVED" : "WOULD MOVE"} ${f(s.moved)}   ${APPLY ? "PATCHED" : "WOULD PATCH"} ${f(s.patched)}`);
  if (stoppedAtBudget || CLOCK.outOfClock()) {
    console.log(`  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the slot has more to do`);
  }
  if (!APPLY) console.log(`\nREPORT ONLY -- nothing was written. Re-run with BACKFILL_APPLY=true to apply.`);

  if (s.failed) {
    console.error(`::error::${f(s.failed)} sale(s) failed -- see FAILURES above.`);
    process.exitCode = 4;
  }
}

module.exports = {
  planInsertRekey, confirmedAgainstLoadedChecklist, withLeadingZeroFold, checklistNumberVariantSet,
  destinationRungOnChecklist, CELL_RE, WILDCARDS, INHERITED_SCOPES, USER_SEED_SOURCES,
};

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); await finishLane(1, { budget: CLOCK }); });
}
