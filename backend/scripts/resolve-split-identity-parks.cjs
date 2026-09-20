#!/usr/bin/env node
/**
 * resolve-split-identity-parks.cjs -- resolves the ~87,542 sold_comps sales
 * PARKED on 2026-09-07 because `cardId` (the Cosmos PARTITION key, vendor-
 * derived) and `hobbyiqCardId` (the field pricing pools key on) name
 * DIFFERENT SPORTS. Modelled on revert-set-sport-repair.cjs's own
 * MODE=checklist-evidence pass -- same evidence rule (THE CHECKLIST DECIDES,
 * WITH THE PLAYER), same shared helpers (relocate-sold-comp.cjs,
 * splitIdentityWriteGuard, two-sport-athletes.cjs, sport-title-evidence.cjs),
 * same page-walk / budget / shard / reconcile / self-relaunch machinery.
 *
 * THE DEFECT (PR #2341, live). `splitIdentityWriteGuard.decideSplitIdentity`
 * parks a sale (reason `split-identity`) whenever `cardId` and
 * `hobbyiqCardId` name different sports and nothing attests either side.
 * PR #2341 changed exact-pool reading so a parked row still prices via
 * `hobbyiqCardId` -- correct roughly two-thirds of the time, per the
 * 2026-09-07 census (`backend/data/pool-relocations/2026-09-07-split-
 * identity-sport-segment-*.json`: hobbyiqCardId correct 2,330, cardId
 * correct 1,203 on the unambiguous-setKey sub-class alone). The rest sit in
 * the WRONG pool, and every one of the ~87,542 remains flagged
 * `identityUnverified`, invisible to every audit that reads the flag as
 * "not yet resolved."
 *
 * THIS LANE is the resolution step the census+guard pair never had: for
 * each parked sale it builds the two candidate ids (H = hobbyiqCardId,
 * C = cardId), asks card_catalog which one (if either) a CHECKLIST-
 * AUTHORITY row backs FOR THE SAME PLAYER, and either fixes the document
 * (one logical correction: cardId/hobbyiqCardId/sport all agree, and the
 * partition follows the verified identity) or leaves it parked under a
 * named bucket for a human.
 *
 * SELECTION (paged, continuation token, never a COUNT/GROUP BY):
 *
 *   SELECT * FROM c
 *   WHERE c.identityUnverified = true
 *     AND STARTSWITH(c.cardId, "hiq:") AND STARTSWITH(c.hobbyiqCardId, "hiq:")
 *     AND c.cardId != c.hobbyiqCardId
 *     AND (c.identityUnverifiedReason = "split-identity"
 *          OR STARTSWITH(c.identityUnverifiedReason, "PARK. cardId vertical"))
 *
 * -- equality/STARTSWITH filters only, scoped further client-side by SCOPE.
 * Duplicate-partition-copy parks and insert-named parks (`insert-named-
 * no-key`, `two-inserts-named`, `insert-named-unconfirmed`, `malformed-key`)
 * are OUT OF SCOPE by construction: this predicate only ever matches the
 * `split-identity` reason family, never those others.
 *
 * CANDIDATES, BASE IDENTITY. H and C are compared and swapped on their
 * SPORT SEGMENT ONLY (segment 1 of the hiq slug), byte-preserving every
 * other segment -- the SAME `reSportSlug` shape revert-set-sport-repair.cjs
 * uses, applied here via the shared `baseIdentityOf`/`withSportSegment`
 * helpers below. A trailing grade-suffix segment (`:psa-9`, present only on
 * card_catalog graded-child ids, never on a sold_comps hobbyiqCardId/cardId
 * -- see hobbyIqCardId.service.ts's parseHobbyIqCardId, max 9 segments, no
 * grade) is stripped before any candidate lookup so a defensive point-read
 * never misses a checklist row over a segment count mismatch it can never
 * actually have; sold_comps ids carry no such segment today, so this is
 * inert in practice and only guards a future caller.
 *
 * VERDICT PER PARKED SALE (judgeSplitIdentityVerdict, pure, no I/O):
 *
 *   H matches (checklist-authority row, SAME player) and C does not
 *     -> RESOLVE-TO-H: the pricing id was right. cardId := H,
 *        hobbyiqCardId := H, sport := H's sport -- ONE logical correction,
 *        via patch (cardId untouched by the park, i.e. cardId !== the OLD
 *        cardId's own hiq slug is never true here since cardId IS an hiq
 *        slug by selection) or RELOCATE (cardId moves partition, since H
 *        differs from the row's current cardId partition).
 *   C matches and H does not
 *     -> RESOLVE-TO-C: hobbyiqCardId := C; cardId already C; sport := C's
 *        sport. PATCH only -- cardId (the partition) never moves.
 *   both match, or neither matches
 *     -> LEAVE, named `both-sides-name-the-player` / `neither-side-names-
 *        the-player`.
 *   two-sport athlete (scripts/lib/two-sport-athletes.cjs) whose ONLY
 *     evidence for a resolve is the OTHER side having no row at all
 *     -> LEAVE `two-sport-athlete`, unless the other side's row EXISTS and
 *        names a DIFFERENT player (positive counter-evidence) -- same bound
 *        revert-set-sport-repair.cjs's MODE=checklist-evidence applies.
 *
 * TITLE VETO (never a decider on its own). Once a side wins on checklist
 * evidence, the title must not CONTRADICT it: sportEvidence(title) naming a
 * third sport (neither H's nor C's), inferSetKeyFromTitle/
 * resolveSetKeyForSlug + extractCardNumberFromTitle/sameCardNumber
 * disagreeing with the winner's own year-resolved setKey/cardNumber, or a
 * REAL title-side player guess (guessTitlePlayer, the same lazy require +
 * confidence floor as repoint-sales-to-checklist-numbered.cjs's own
 * guessPlayerFromTitleLocal) sharing NO name token (cleanPlayerName +
 * playerIdentityKey, RC/RR/DP/TC/UER/SP/SSP-insensitive) with any player
 * listed on the winner's own catalog row, when the guess itself has >= 2
 * tokens -- see titleVetoes' own doc for the three production false
 * positives ("James" vs "James Wood RC" etc.) this bar exists to clear. Any
 * of these vetoes the resolve to LEAVE `title-contradicts-winner`. A title
 * that is merely silent (no evidence either way) never vetoes.
 *
 * PINNED-OR-FLAGGED ROWS (REVIEW #5, LOW, 2026-09-19) are never resolved,
 * regardless of catalog evidence: `verifiedByUser === true`, `flaggedWrong
 * === true`, `excludedFromFmv === true`, or `source` in
 * USER_SEED_SOURCES's literal (soldCompsStore.service.ts's own module-
 * private const, not exported -- copied here by inspection, kept in sync
 * the same way every other script that cannot import a private const
 * does). A human claim, or the one path a sale is allowed to mint a card,
 * outranks a catalog point-read. Leaves the row parked, named
 * `pinned-or-flagged`.
 *
 * OTHER READERS OF sold_comps (REVIEW #6, 2026-09-19). `SoldCompDoc`
 * (soldCompsStore.service.ts) carries exactly THREE identity fields --
 * `sport`, `cardId`, `hobbyiqCardId` -- and no `league`/`category`/
 * `vertical`/`sportKey` or any other sport-derived denormalized field.
 * `exactPoolReader.ts` (the pricing pool's own read path) filters sold_comps
 * on `cardId`, `hobbyiqCardId`, `flaggedWrong`, `excludedFromFmv` only --
 * the last two are moderation flags this lane already leaves alone (review
 * #5, above), not sport-derived. Every OTHER stored field on the doc
 * (`playerName`, `setName`, `parallel`, `cardNumber`, `isAuto`, grade
 * fields, `printRun`, `composite`, `contentHash`, `vendorCardId`,
 * `derivedIdentityAtIngest`) is independent of `sport` -- populated from
 * vendor/title parsing at ingest, never RECOMPUTED from the sport field a
 * resolve changes. This lane's resolve therefore never needs to rewrite
 * anything beyond the three identity fields it already does.
 *
 * PARK FIELDS CLEARED ON RESOLVE (read from splitIdentityWriteGuard.ts's
 * `GuardedSoldCompDoc` and relocate-pool-rows-by-list.cjs's own PARK/REPOINT
 * stamps, lines ~278-292): `identityUnverified`, `identityUnverifiedAt`,
 * `identityUnverifiedBy`, `identityUnverifiedReason`,
 * `identityUnverifiedDetail`. All five are unset (`op: "remove"` on APPLY's
 * patch shape; simply omitted from the relocate shape's `keep` document) so
 * nothing is left half-parked. A ledger is stamped in their place:
 * `splitResolvedAt`, `splitResolvedTo` ("hobbyiqCardId"|"cardId"),
 * `splitResolvedFrom: { cardId, hobbyiqCardId }` (the PRE-resolve values, so
 * the correction is reversible), `splitResolvedBy`.
 *
 * WRITE-DOOR GUARD, BOTH DIRECTIONS. The resolved document is run through
 * `guardSoldCompDoc` before any write: cardId === hobbyiqCardId === the
 * winner by construction, so `decideSplitIdentity` sees `cardProduct ===
 * hiqProduct` and returns `{ verdict: "ok" }` for every genuine resolve --
 * this lane's own correctness proof that it never writes a document its own
 * write-time guard would re-park. A malformed winner (defensive; the
 * catalog point-read that produced the match already proved the id
 * addressable) is refused and listed rather than written half-guarded.
 *
 * DESTINATION COLLISION (RESOLVE-TO-H / relocate only -- RESOLVE-TO-C never
 * moves partition). Same sale at the destination by content hash ->
 * COLLAPSE (delete the moving copy, the resident stays); a DIFFERENT sale
 * -> REFUSE, both listed, neither moved. `id` stays unique within the new
 * partition because `relocateSoldComp`'s own upsert-verify-delete addresses
 * the destination by the SAME `(id, cardId)` compound key sold_comps
 * partitions on -- the row's own `id` (e.g. `tca-ebay::168568127039`) is
 * unchanged by a resolve; only its `cardId` (partition) changes, and a
 * SAME-ID collision is only possible when some OTHER sale's `id` already
 * equals this one's `id` AT the destination partition, which the collision
 * check (a point read at `(doc.id, destCardId)`) catches before the upsert
 * ever runs.
 *
 * PHYSICAL-SALE TWINS (REVIEW #1, HIGH, 2026-09-19; REVISED delta review,
 * HIGH, 2026-09-20 -- OWNER RULE: deletes need the owner; absent beats
 * wrong; never destroy a sale on a guess). A same-id check cannot see a
 * CardHedge dual-id twin of the SAME physical sale, because a twin carries a
 * DIFFERENT `id` by construction (project_cardhedge_dual_id_duplicates_and_
 * graded_in_raw_pool). Before EITHER write shape, this lane additionally
 * runs `physicalTwinAtPartition` -- one single-partition query at the
 * destination filtered on price + soldAt(day), then `isSameSale` (the SAME
 * contentHashOf compare) in memory across the small candidate set.
 *
 * `contentHashOf` (cardId, parallel, isAuto, grade, price-cents, soldAt-day
 * ONLY -- no listing identity, no title) is NOT, on its own, proof that two
 * rows are the SAME LISTING filed twice: two DISTINCT real sales of the same
 * card, at the same price, on the same day (many $1.99 raw copies with
 * templated CardHedge titles is the measured shape) hash identically and are
 * NOT duplicates. This lane therefore never deletes on a contentHash match
 * alone -- collapse additionally requires `sameListingIdentity`, a non-empty
 * EXTERNAL LISTING id shared by both docs (`sourceExternalId`, or the same
 * `${source}::${externalId}` shape parsed out of `id` when that field is
 * absent -- see `listingIdOf`'s own doc): an eBay item id embedded in two
 * differently-sourced ids proves it; CardHedge's own `ch-daily::
 * {price_history_id}` never equalling an eBay item id correctly proves
 * nothing, so a cross-vendor pair with no shared listing id NEVER collapses,
 * even when price+day+contentHash all agree.
 *
 *   RELOCATE, a contentHash-matching twin found, listing id PROVEN shared
 *     -> COLLAPSE (delete the moving copy, the twin survives, same as the
 *        same-id case).
 *   RELOCATE, contentHash matches but NO shared listing id provable
 *     -> the MOVING row is left PARKED, untouched, named
 *        `possible-twin-at-destination` -- never relocated, never deleted.
 *   PATCH, a contentHash-matching row ALREADY resident at this row's OWN
 *     (unmoving) partition, listing id PROVEN shared
 *     -> left PARKED (not patched), named `duplicate-of-resolved-resident`
 *        (patching identity fields does not collapse a duplicate that was
 *        already double-counted before this lane ran, and this lane still
 *        never deletes from the PATCH shape either way).
 *   PATCH, same, but NO shared listing id provable
 *     -> left PARKED, named `possible-twin-at-destination`.
 *
 * Both PARKED-by-guess buckets are counted in the run banner (REFUSED:) with
 * a sample naming both docs' id + source + title, and fold into the
 * RECONCILE line's `refused` total like every other named refusal.
 *
 * Serialised WITHIN a run by a PHYSICAL-SALE KEY (destination|price|
 * soldAt-day -- `title` dropped from this key, see `physicalSaleKeyOf`'s own
 * doc), not by `id` -- two twins share no `id` to group on, so without this
 * lock both could pass the destination scan concurrently and both write.
 *
 * TWO WRITE SHAPES:
 *   PATCH      RESOLVE-TO-C always; RESOLVE-TO-H when the row's cardId
 *              already equals H (can only happen if a prior partial run or
 *              an unrelated fix already relocated the partition without
 *              clearing the park fields -- treated as already-at-target).
 *   RELOCATE   RESOLVE-TO-H, the ordinary case: cardId moves from C to H
 *              via relocate-sold-comp.cjs's relocateSoldComp (upsert at H,
 *              verify read-back, delete the old C-partition row).
 *
 * CONDITIONAL WRITES (REVIEW #3, MEDIUM, 2026-09-19). Both shapes re-read
 * the source document immediately before writing and pass its FRESH
 * `_etag` as an `IfMatch` access condition on the mutating call (the
 * patch itself, or the relocate's source-side delete via
 * relocate-sold-comp.cjs's existing `ifMatchEtag` drop option) -- closing
 * the window between this handleRow call's own planning read and its
 * write, during which a concurrent lane or a prior partial run could have
 * changed the document. A 412 REFUSES the write outright (never retried --
 * `retry()` only retries 429/timeout-shaped errors), counted
 * `stale-since-plan`, disjoint from every other outcome.
 *
 * BUDGET / SHARD / RELAUNCH / RECONCILE: identical machinery to
 * revert-set-sport-repair.cjs (lib/runner-budget.cjs, lib/runner-shard-
 * scope.cjs) -- candidates grouped by sale `id` for the page-walk's own
 * batch dispatch (multiple ids run concurrently, bounded by CONCURRENCY,
 * same shared-cursor-pool shape the repoint lane uses) and ADDITIONALLY
 * serialised by physical-sale key (see above) at the write site, so a
 * dual-id twin sharing no `id` with its sibling still cannot race it.
 * Catalog reads are promise-cached per id, per run, and a persistent
 * (non-404) catalog read failure is caught at the narrowest point that
 * knows it is a read failure, isolating exactly ONE row -- never the
 * batch, the page walk, or the run's own RECONCILE/relaunch marker.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true / APPLY=true to write;
 *      SCOPE required (`all-splits` or comma `sport:year` cells, matched
 *      against EITHER id's sport/year); TITLES optional freeform filter
 *      (substring, case-insensitive, against the sale's own title) mirroring
 *      the runner's inherited `titles` dispatch field -- OR, when it starts
 *      with the literal `exclude-winner:`, a comma list of winner candidate
 *      ids to LEAVE untouched (named `excluded-by-operator`) instead of a
 *      substring filter; MODE unused (kept for workflow-input symmetry,
 *      refused if set to anything but empty); SLOT/SLOTS (sha1(id) shards,
 *      opt-in via SHARD=true for slot 0); CONCURRENCY=8; RUN_MINUTES=110;
 *      LIMIT=0.
 *
 * PLAN_OUT (AUDITABILITY, 2026-09-20). The banner's own samples cap at 20-60
 * lines per bucket -- necessarily, for a lane this large (1,506+ LEAVE rows
 * measured on the pilot alone) -- so a REPORT that only ever lived in that
 * capped banner could not be audited row-by-row before the matching APPLY
 * ran, even though the banner CLAIMED "full list in the uploaded artifact."
 * It was not: the uploaded artifact was `/tmp/backfill.log` alone, the same
 * capped text. When PLAN_OUT names a path (the runner sets it to a FIXED
 * directory, guarded on script name, so an operator never has to know this
 * exists), this run writes ONE NDJSON record per IN-SCOPE row -- every
 * scanned row this run did not drop for being out of shard/cell/titles-
 * filter/limit, i.e. every row `intended` counts -- to
 * `${PLAN_OUT}/plan-slot-${SLOT}.ndjson`, one JSON object per line:
 *   action    "resolve-to-c-patch" | "resolve-to-h-patch" |
 *             "resolve-to-h-relocate" | "collapse" | "leave" | "refused" |
 *             "failed"
 *   reason    the named bucket (verdict.reason / the LEAVE/REFUSED name)
 *   id, source, title, price, soldAt, cardId, hobbyiqCardId   the row's own
 *             identity + sale fields, read verbatim off `doc`
 *   winner    the candidate id this row resolved/would resolve to, or null
 *   winnerCatalogPlayer, winnerCatalogSource   the winning candidate's own
 *             catalog row playerName/source (its checklist authority), or
 *             null when there is no winner (LEAVE/REFUSED/FAILED)
 *   titlePlayerGuess   the SAME guessTitlePlayer() this lane's own title
 *             veto already computed, so the file carries the evidence a
 *             human needs without re-deriving it
 *   twinId, twinSource   the OTHER document's id/source when this row was
 *             REFUSED over a possible/proven physical-sale twin, else null
 * This is written into the SAME fixed path the runner already uploads as
 * part of this lane's artifact (see backfill-runner.yml's own "Upload the
 * resolve-split-identity-parks log" step) -- no new upload-artifact step, no
 * new workflow_dispatch input.
 *
 * Requires dist/ (splitIdentityWriteGuard, catalogAuthority.service.js,
 * playerIdentityKey.js) and scripts/lib (relocate-sold-comp, runner-budget,
 * runner-shard-scope, two-sport-athletes, sport-title-evidence).
 */
"use strict";
const path = require("path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const backend = path.resolve(__dirname, "..");

const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { sportEvidence } = require(path.join(__dirname, "lib", "sport-title-evidence.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const STARTED = Date.now();
const CLOCK = budget({ minutes: 110, reserveMs: 30 * 1000, verifyMs: 5 * 60 * 1000, startedAt: STARTED });
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8));
const LIMIT = Number(process.env.LIMIT || 0);

// ── PLAN_OUT (module header). A fixed directory the runner sets, guarded on
// script name -- not a new workflow_dispatch input. Empty means "no plan
// file" (a local operator run, or a test harness that never wires it) --
// the run still prints its capped banner exactly as before; only the full
// machine-readable audit trail is skipped.
const PLAN_OUT = str(process.env.PLAN_OUT);

const SHARD_SCOPE = runnerShardScope({ label: "resolve-split-identity-parks" });
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SHARD_SCOPE.SLOTS;

// ── MODE: this lane has exactly one algorithm, but the runner's `mode`
// dropdown field is shared across every script, so an operator's dispatch
// may carry a stray value from a DIFFERENT lane's own mode vocabulary
// (copy/paste from a prior dispatch). Refused rather than silently ignored,
// same discipline revert-set-sport-repair.cjs applies to its own MODE.
//
// Read here at module scope (so a pure-function test importing this file
// never pays a Cosmos-shaped cost), but VALIDATED inside main() only --
// several test runners (vitest among them) set their own process.env.MODE
// ("test") for unrelated reasons, and a module-load-time process.exit(2)
// would make importing this file for its pure helpers fail in exactly that
// environment. The model lane's own MODE/SCOPE refusals are both gated
// inside main() for the same reason.
const RAW_MODE = lower(process.env.MODE);

// ── THE SCOPE. 'all-splits' (typed explicitly) or comma `sport:year` cells,
// matched against EITHER candidate id's sport/year (a parked sale by
// definition has two DIFFERENT sports, so a scope naming either side's
// sport reaches it). The runner's inherited defaults are ALL refused --
// there is no bare 'all' synonym; a whole-source sweep needs its own name.
const ALL_SPLITS = "all-splits";
const CELL_RE = /^[a-z][a-z-]*:\d{4}$/;
const RAW_SCOPE = csv(process.env.SCOPE);
const SCOPE_IS_ALL = RAW_SCOPE.length === 1 && lower(RAW_SCOPE[0]) === ALL_SPLITS;
const SCOPE_CELLS = SCOPE_IS_ALL ? [] : RAW_SCOPE.map(lower).filter((p) => CELL_RE.test(p));
const SCOPE_REJECTED = SCOPE_IS_ALL ? [] : RAW_SCOPE.filter((p) => !CELL_RE.test(lower(p)));

// ── TITLES: an optional freeform substring filter against the sale's own
// title, case-insensitive -- the runner's existing `titles` dispatch field,
// unused by revert-set-sport-repair.cjs but wired here because a pilot
// dispatch narrowing to one product family (e.g. "topps now") is a natural
// operator move on a lane this large. Empty means no filter.
//
// EXCLUDE-BY-WINNER (optional, riding the SAME `titles` input rather than a
// new one -- workflow_dispatch is at its 25-input cap). A single token,
// `exclude-winner:<id>[,<id>...]`, names one or more WINNER candidate ids
// (the full hiq: slug either H or C would resolve/relocate a row onto) an
// operator wants this run to leave alone -- e.g. a product an acquisition
// freeze covers, or a cell a human is mid-review on. A row whose verdict
// would otherwise resolve to an excluded winner is LEAVEd instead, named
// `excluded-by-operator`, counted and reconciled exactly like every other
// named LEAVE bucket -- never silently dropped from the run's own math.
//
// Recognised ONLY when the token starts with the literal prefix
// `exclude-winner:` (case-insensitive) -- anything else is read as the
// ordinary title-substring filter, unchanged. The two are mutually
// exclusive on one dispatch (this lane has no third value for "both"), and
// that is fine: a pilot narrowing by product family and a pilot excluding a
// winner are two different operator intents, never issued in the same
// dispatch today. Winner ids are hiq: slugs, which themselves contain
// colons, so this is parsed OUT OF the raw (pre-lowercased, pre-csv-split)
// env value rather than reusing the generic `csv().map(lower)` pipeline,
// which would mangle the prefix's own colon.
//
// `parseTitlesInput` is pure (no process.env read) so it can be unit tested
// directly; the module-scope constants below are its one, real call.
const EXCLUDE_WINNER_PREFIX = /^exclude-winner:/i;
function parseTitlesInput(raw) {
  const rawStr = str(raw);
  if (EXCLUDE_WINNER_PREFIX.test(rawStr)) {
    const excludedWinners = new Set(csv(rawStr.replace(EXCLUDE_WINNER_PREFIX, "")));
    return { excludedWinners, titlesFilter: [] };
  }
  return { excludedWinners: new Set(), titlesFilter: csv(rawStr).map(lower) };
}
const { excludedWinners: EXCLUDED_WINNERS, titlesFilter: TITLES_FILTER } = parseTitlesInput(process.env.TITLES);

/** Unset every park field on a resolve. Read from splitIdentityWriteGuard.ts's
 *  GuardedSoldCompDoc and relocate-pool-rows-by-list.cjs's own PARK stamp --
 *  the same five fields either mechanism writes, so a row this lane resolves
 *  is indistinguishable, once cleared, from a row that was never parked. */
const PARK_FIELDS = ["identityUnverified", "identityUnverifiedAt", "identityUnverifiedBy", "identityUnverifiedReason", "identityUnverifiedDetail"];

/**
 * REVIEW #5 (LOW, 2026-09-19). A human (or the ONE place a sale mints a
 * card: USER_SEED_SOURCES) already made a stronger claim about this row
 * than a catalog point-read can second-guess, so this lane leaves it
 * parked untouched rather than resolving out from under that claim:
 *
 *   verifiedByUser === true    a real user attested to this cardId.
 *   flaggedWrong === true      soft-deleted by wrong-attestation recovery
 *                              (flagCompAsWrong) -- moderation, not identity.
 *   excludedFromFmv === true   deliberately excluded from every FMV read.
 *   source in USER_SEED_SOURCES  soldCompsStore.service.ts's own literal
 *     ("ebay-user-purchase","ebay-user-sale","manual-user-entry",
 *     "user-verified") -- NOT exported (module-private `const`), so this is
 *     a byte-for-byte copy kept in sync by inspection, same as it always
 *     was for every OTHER script that cannot import a private const.
 *
 * Named `pinned-or-flagged` and listed, same discipline as every other
 * LEAVE bucket -- a human can still act on these by name; this lane simply
 * never overrides them on catalog evidence alone. */
const USER_SEED_SOURCES = new Set(["ebay-user-purchase", "ebay-user-sale", "manual-user-entry", "user-verified"]);
function isPinnedOrFlagged(doc) {
  return doc.verifiedByUser === true
    || doc.flaggedWrong === true
    || doc.excludedFromFmv === true
    || USER_SEED_SOURCES.has(String(doc.source ?? ""));
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

async function forEachPage(container, spec, onPage, pageSize = 1000) {
  let token;
  do {
    const page = await retry(() => container.items
      .query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

/** The candidate predicate: every parked split-identity sale this lane has
 *  not yet resolved. Equality / STARTSWITH filters only, never a
 *  cross-partition COUNT/GROUP BY -- sold_comps partitions on /cardId, so
 *  this is necessarily a cross-partition scan, bounded by maxItemCount and
 *  a continuation token, same as every other census-shaped lane.
 *
 *  Deliberately narrower than "every identityUnverified row": duplicate-
 *  partition-copy parks and insert-named parks (`insert-named-no-key`,
 *  `two-inserts-named`, `insert-named-unconfirmed`, `malformed-key`) carry a
 *  DIFFERENT identityUnverifiedReason and never match this predicate, so
 *  they are never selected -- out of scope by construction, not by a
 *  post-hoc filter that could drift from the query. */
const CANDIDATE_SPEC = {
  query: `SELECT * FROM c
          WHERE c.identityUnverified = true
            AND IS_STRING(c.cardId) AND STARTSWITH(c.cardId, "hiq:")
            AND IS_STRING(c.hobbyiqCardId) AND STARTSWITH(c.hobbyiqCardId, "hiq:")
            AND c.cardId != c.hobbyiqCardId
            AND (c.identityUnverifiedReason = "split-identity"
                 OR STARTSWITH(c.identityUnverifiedReason, "PARK. cardId vertical"))`,
  parameters: [],
};

/**
 * The base identity of an hiq slug -- every segment up to and including the
 * auto flag (segments 0..6, i.e. `hiq:sport:year:setKey:cardNumber:parallel:
 * auto-flag`), with any trailing print-run (`:num-N`) or grade-suffix
 * segment (`:psa-9`, never present on a sold_comps id today -- see module
 * header) stripped for the PURPOSE OF COMPARISON only. Mirrors the
 * `reSportSlug`/rekeyed-since discipline revert-set-sport-repair.cjs uses:
 * this function is read-only and never used to WRITE a truncated id: every
 * candidate this lane builds keeps the FULL original segments (including a
 * later lane's own `:num-N` tail), via `withSportSegment` below, exactly as
 * revert-set-sport-repair.cjs's own `reSportSlug` byte-preserves everything
 * but the swapped segment.
 */
function segmentsOf(slug) {
  const s = String(slug ?? "");
  if (!s.startsWith("hiq:")) return null;
  const parts = s.split(":");
  return parts.length >= 7 ? parts : null;
}

/** The sport segment (index 1) of a well-formed hiq slug, or null. */
function sportSegmentOf(slug) {
  const parts = segmentsOf(slug);
  return parts ? parts[1] : null;
}

/** The year segment (index 2) of a well-formed hiq slug, or null. */
function yearSegmentOf(slug) {
  const parts = segmentsOf(slug);
  if (!parts) return null;
  const y = parts[2];
  return /^\d{4}$/.test(y) ? y : null;
}

/** The setKey segment (index 3), or null. */
function setKeySegmentOf(slug) {
  const parts = segmentsOf(slug);
  return parts ? parts[3] : null;
}

/**
 * EXACT MIRROR of revert-set-sport-repair.cjs's own `reSportSlug`: swap ONLY
 * the sport segment, byte-preserving every other segment (a later lane's
 * `:num-N` tail included). Named differently here because this lane swaps
 * to an ARBITRARY sport (the other candidate's), not specifically "the
 * sport before a repair" -- same operation.
 */
function withSportSegment(slug, sport) {
  const parts = segmentsOf(slug);
  if (!parts) return null;
  const out = [...String(slug).split(":")];
  out[1] = sport;
  return out.join(":");
}

/**
 * The `sport:year` cell(s) a row belongs to, for SCOPE matching -- read from
 * BOTH candidate ids, since a split-identity row's two sides disagree on
 * sport BY DEFINITION and an operator may reasonably scope by either one
 * (the task's own example: `basketball:2023` reaches the Wembanyama cells
 * via hobbyiqCardId, even though cardId's own cell is `baseball:2023`).
 */
function cellsOf(cardId, hobbyiqCardId) {
  const cells = new Set();
  for (const slug of [cardId, hobbyiqCardId]) {
    const sport = sportSegmentOf(slug);
    const year = yearSegmentOf(slug);
    if (sport && year) cells.add(`${sport}:${year}`);
  }
  return cells;
}

/**
 * Classify ONE candidate address's catalog row against the SALE it is
 * judged for -- pure, no I/O. IDENTICAL shape to revert-set-sport-repair.cjs's
 * own `checklistMatchOf`: a checklist-authority row at an address is not
 * evidence about THIS sale unless it names the SAME player (multi-player
 * rows read as a list, "/" or "&" joined -- the D33 shape -- any listed name
 * matching is enough).
 *
 * @param {object|null} catalogRow
 * @param {string} salePlayerName
 * @param {(source: unknown) => string} catalogAuthorityOf
 * @param {(name: unknown) => string} playerIdentityKey
 * @returns {"match"|"different-card"|"no-row"}
 */
function checklistMatchOf(catalogRow, salePlayerName, catalogAuthorityOf, playerIdentityKey) {
  if (!catalogRow) return "no-row";
  if (catalogAuthorityOf(catalogRow.source) !== "checklist") return "no-row";
  const saleKey = playerIdentityKey(salePlayerName);
  if (!saleKey) return "different-card"; // cannot confirm -- absent beats wrong
  const rowKeys = multiPlayerKeysOf(catalogRow.playerName, playerIdentityKey);
  if (!rowKeys.size) return "different-card";
  return rowKeys.has(saleKey) ? "match" : "different-card";
}

/**
 * REVIEW #1 (delta review, HIGH; MEDIUM follow-up, 2026-09-20). A physical
 * sale's own LOCK signature -- destination cardId, price (cents, to avoid a
 * float-equality footgun), soldAt floored to the DAY (matching relocate-
 * sold-comp.cjs's own `contentHashOf`/`day()` helper). Two rows sharing this
 * key are candidates for "the same underlying physical sale, filed twice
 * under different ids" and this key is what serialises this run's own
 * writes against each other (see `withPhysicalSaleLock` in main()).
 *
 * `dest` (the destination cardId partition `physicalTwinAtPartition` itself
 * scans -- `winner` at the call site, i.e. `keep.cardId` for both the PATCH
 * and RELOCATE write shapes) is REQUIRED, not optional: a price+day-only key
 * (the MEDIUM follow-up's own finding) serialises EVERY $1.99 sale of ANY
 * card nationwide sold the same day through ONE queue -- measured 13x
 * slower, maxConcurrentInsideLock collapsing to 1 across completely
 * unrelated cards that could never physically collide at the same
 * destination partition. Two movers to DIFFERENT destinations can never be
 * the same physical sale (a sale has exactly one destination), so they must
 * run concurrently; only two movers racing the SAME destination at the same
 * price+day need the lock at all.
 *
 * `title` is DELIBERATELY NOT part of this key (the delta review's earlier
 * finding): a CardHedge bulk-import title and a tca-ebay title for the
 * exact same physical sale are independently templated by each vendor's own
 * scraper and do not byte-match, so keying the lock on title let two
 * differently-formatted titles for the SAME sale serialize under TWO
 * different keys -- defeating the lock precisely when it mattered most.
 *
 * The lock's own job is only to stop two CONCURRENT calls from racing the
 * destination scan for the same (destination, price, day) triple; it is
 * never the identity test itself (that is `sameListingIdentity`, below, plus
 * `isSameSale`/`contentHashOf`), so a coarser key here costs nothing but a
 * few sales with genuinely different content sharing a lock queue -- and
 * with `dest` restored, that "few" is bounded to one destination partition,
 * not the whole nationwide price+day cross-section.
 */
function physicalSaleKeyOf(d, dest) {
  const price = Number.isFinite(Number(d?.price)) ? Math.round(Number(d.price) * 100) : "?";
  const soldDay = String(d?.soldAt ?? "").slice(0, 10);
  return `${str(dest)}|${price}|${soldDay}`;
}

/**
 * REVIEW #1 (delta review, HIGH). The listing identity a physical-sale twin
 * must PROVE before this lane collapses (deletes) one of two rows sharing a
 * price+day signature. `contentHashOf` alone (cardId, parallel, isAuto,
 * grade, price-cents, soldAt-day) cannot tell "the same listing filed twice"
 * from "two distinct real sales that happen to match on those coarse fields"
 * -- e.g. many $1.99 raw copies of a common card sold the same day, each
 * with its own CardHedge-templated title that also collapses to the same
 * normalised string. Deleting on that guess is exactly the defect this
 * fixes: absent beats wrong, and a delete needs an owner (a real, provable
 * shared listing), never a guess.
 *
 * THE PROOF: a non-empty EXTERNAL LISTING id shared by both docs.
 *   1. `sourceExternalId` (soldCompsStore.service.ts's own field -- the
 *      vendor's own external id: an eBay item id for tca-ebay/ebay-user rows,
 *      `ch-daily::{price_history_id}` for CardHedge daily rows, `holding::
 *      {id}` for an eBay-import-created holding sale, etc, per makeId's own
 *      `${source}::${externalId}` id-shape and chRowToSoldComp.ts's own
 *      `ch-daily::` prefix doc). Preferred because it is the field the
 *      ingest path itself populates with the vendor's own listing/sale id,
 *      never re-derived here.
 *   2. Falls back to parsing the SAME shape out of `doc.id` itself when
 *      `sourceExternalId` is absent on an older row: `makeId` mints
 *      `${source}::${externalId}` whenever a source provides one, so the
 *      substring after the FIRST `::` is that same externalId, byte for
 *      byte -- e.g. `tca-ebay::168568127039` yields listing id
 *      `168568127039`, the eBay item id embedded in the id.
 *
 * Two docs share listing identity ONLY when both resolve to a non-empty
 * string and those strings are EQUAL (exact, case-sensitive -- vendor ids
 * are opaque tokens, never text to fuzz-match). This is deliberately
 * cross-vendor-capable: two tca-ebay rows (or an eBay-sourced row filed
 * under any other source label) that embed the SAME eBay item id collapse,
 * exactly the shipped test's "same listing id under two id shapes" case.
 * But CardHedge's `ch-daily::{price_history_id}` is a CardHedge-internal
 * counter that never equals an eBay item id or another vendor's own id --
 * so a `cardhedge` row and a `tca-ebay` row for what LOOKS like the same
 * physical sale (same price, same day, similarly-templated title) have NO
 * shared listing proof today, and correctly do NOT collapse: that gap is
 * real (there is no cross-vendor listing linkage field in this schema
 * today), not a bug in this function.
 *
 * CORRUPTED-LITERAL GUARD (delta review, LOW, follow-up 2026-09-20). A
 * `sourceExternalId` (or an `id` tail) that is literally the string
 * "undefined", "null", or "NaN" -- trimmed, case-insensitive -- is a known
 * corruption shape (a JS `undefined`/`null`/`NaN` value stringified into a
 * template literal upstream, e.g. `${source}::${externalId}` when
 * `externalId` was itself one of those, or a CSV/JSON field that lost its
 * type) and is treated as EMPTY, never as a real listing id. Without this
 * guard, two DIFFERENT corrupted rows -- e.g. two unrelated ingests that
 * both wrote `sourceExternalId: undefined` and both stringify to
 * `"undefined"` -- would satisfy `sameListingIdentity`'s bare non-empty-
 * and-equal test and let this lane delete a real sale on a data bug rather
 * than a proven shared listing. Absent beats wrong applies here too.
 */
const CORRUPTED_LISTING_ID_LITERALS = new Set(["undefined", "null", "nan"]);
function listingIdOf(doc) {
  const ext = str(doc?.sourceExternalId);
  if (ext && !CORRUPTED_LISTING_ID_LITERALS.has(ext.toLowerCase())) return ext;
  const id = str(doc?.id);
  const i = id.indexOf("::");
  if (i < 0) return "";
  const tail = id.slice(i + 2).trim();
  return tail && !CORRUPTED_LISTING_ID_LITERALS.has(tail.toLowerCase()) ? tail : "";
}

function sameListingIdentity(a, b) {
  const ka = listingIdOf(a);
  const kb = listingIdOf(b);
  return ka !== "" && kb !== "" && ka === kb;
}

/**
 * Multi-player catalog rows are one string with every name listed
 * ("Eddie Murray / Cal Ripken Jr.", the D33 shape documented in
 * cardCatalog.service.ts and read identically by
 * insertSetChecklistConfirm.ts's own `catalogRowPlayerKeys`) -- never an
 * array. Split on "/" and "&", the same two joiners; a single-name row is a
 * one-element list, so this subsumes the single-name case exactly.
 */
function multiPlayerKeysOf(playerName, playerIdentityKey) {
  const raw = String(playerName ?? "");
  const keys = new Set();
  for (const part of raw.split(/\s*[/&]\s*/)) {
    const k = playerIdentityKey(part);
    if (k) keys.add(k);
  }
  return keys;
}

/**
 * THE RESOLUTION VERDICT (module header). Pure: takes the ALREADY-COMPUTED
 * checklistMatchOf classification for each side, exactly as
 * revert-set-sport-repair.cjs's own judgeChecklistEvidenceVerdict does, so
 * REPORT and APPLY share this without any I/O of their own.
 *
 * TWO-SPORT ATHLETE BOUND, applied SYMMETRICALLY (both directions can be
 * gated, unlike the model lane which only ever restores in one direction):
 * a resolve toward EITHER side additionally requires the LOSING side to be
 * "different-card" (a row exists and names someone else) rather than merely
 * "no-row" (absence), whenever the sale's player is on the two-sport
 * gazetteer -- a catalog coverage gap on the loser's side must not be read
 * as that side's checklist siding with the winner for a player who
 * genuinely could have a card under either sport.
 *
 * @param {"match"|"different-card"|"no-row"} hMatch  checklistMatchOf for the H (hobbyiqCardId) candidate
 * @param {"match"|"different-card"|"no-row"} cMatch  checklistMatchOf for the C (cardId) candidate
 * @param {boolean} [saleIsTwoSportAthlete]
 * @returns {{ verdict: "resolve-to-h"|"resolve-to-c"|"leave", reason: string, detail: string }}
 */
function judgeSplitIdentityVerdict({ hMatch, cMatch, saleIsTwoSportAthlete }) {
  const hIsMatch = hMatch === "match";
  const cIsMatch = cMatch === "match";

  if (hIsMatch && !cIsMatch) {
    if (saleIsTwoSportAthlete && cMatch !== "different-card") {
      return { verdict: "leave", reason: "two-sport-athlete", detail: `this player is a known two-sport athlete and the cardId-sport candidate is only "${cMatch}" (absence of counter-evidence, not a disagreeing checklist row) -- a catalog gap must not be read as the checklist siding against a genuinely two-sport player` };
    }
    return { verdict: "resolve-to-h", reason: "checklist-backs-hobbyiqcardid", detail: "only the hobbyiqCardId-sport candidate id has a checklist-authority card_catalog row naming the SAME player as this sale" };
  }
  if (cIsMatch && !hIsMatch) {
    if (saleIsTwoSportAthlete && hMatch !== "different-card") {
      return { verdict: "leave", reason: "two-sport-athlete", detail: `this player is a known two-sport athlete and the hobbyiqCardId-sport candidate is only "${hMatch}" (absence of counter-evidence, not a disagreeing checklist row) -- a catalog gap must not be read as the checklist siding against a genuinely two-sport player` };
    }
    return { verdict: "resolve-to-c", reason: "checklist-backs-cardid", detail: "only the cardId-sport candidate id has a checklist-authority card_catalog row naming the SAME player as this sale" };
  }
  if (hIsMatch && cIsMatch) {
    return { verdict: "leave", reason: "both-sides-name-the-player", detail: "BOTH candidate ids have a checklist-authority card_catalog row naming the same player as this sale -- cannot disambiguate from the catalog alone (a genuine two-sport athlete, or a rare same-cell coincidence)" };
  }
  if (hMatch === "different-card" || cMatch === "different-card") {
    return { verdict: "leave", reason: "neither-side-names-the-player", detail: `a candidate address is checklist-authority but names a DIFFERENT player than this sale (hobbyiqCardId-side=${hMatch}, cardId-side=${cMatch}) -- cell collision, not evidence about this sale` };
  }
  return { verdict: "leave", reason: "neither-side-names-the-player", detail: "NEITHER candidate id has a checklist-authority card_catalog row naming this sale's player" };
}

/**
 * THE TITLE VETO (module header). Never a decider on its own -- only fires
 * to REJECT a checklist-backed winner the title actively contradicts.
 * Reuses the SHIPPED title machinery verbatim (never re-implemented):
 * `sportEvidence` (third-sport check), `inferSetKeyFromTitle` +
 * `resolveSetKeyForSlug` + `extractCardNumberFromTitle`/`sameCardNumber`
 * (year-aware setKey/number check), and a REAL title-side player guess
 * (`guessTitlePlayer`, below -- the same lazy require + confidence floor as
 * repoint-sales-to-checklist-numbered.cjs's own `guessPlayerFromTitleLocal`)
 * compared by shared name TOKEN against the WINNING catalog row's own
 * playerName (never the sale's stored playerName -- the stored field is
 * what already won the checklist match; the title is a SEPARATE, weaker
 * witness being asked whether it actively disagrees). See that function's
 * own doc below for why this is a token-sharing test, not
 * `playerTheTitleAllows`'s "irreconcilable" outcome verbatim.
 *
 * @param {object} input
 * @param {string} input.title
 * @param {string} input.winnerSport
 * @param {string} input.winnerSetKey
 * @param {string} input.winnerCardNumber   the sale's OWN cardNumber field (never re-derived here)
 * @param {string} input.winnerCatalogPlayerName  the winning catalog row's playerName
 * @param {string} input.otherSport         the LOSING side's sport, for the third-sport check
 * @param {object} deps  the six shipped functions, injected so this stays pure/testable
 * @returns {{ vetoed: boolean, detail?: string }}
 */
function titleVetoes({ title, winnerSport, winnerYear, winnerSetKey, winnerCardNumber, winnerCatalogPlayerName, otherSport }, deps) {
  const { inferSetKeyFromTitle, resolveSetKeyForSlug, extractCardNumberFromTitle, sameCardNumber, sportEvidenceFn } = deps;
  const t = String(title ?? "");
  if (!t.trim()) return { vetoed: false };

  // ── THIRD SPORT: the title's own evidence set names a sport that is
  // NEITHER side of this dispute. A title siding with the winner, the
  // loser, or saying nothing at all never vetoes.
  const { sports } = sportEvidenceFn(t);
  const thirdSports = [...sports].filter((s) => s !== winnerSport && s !== otherSport);
  if (thirdSports.length && !sports.has(winnerSport)) {
    return { vetoed: true, detail: `title evidence names ${thirdSports.join(", ")} -- neither the winning side (${winnerSport}) nor the losing side (${otherSport})` };
  }

  // ── SETKEY: only checked when the title resolves to a setKey the shipped
  // parser actually recognises (never "unknown"/empty) AND it disagrees with
  // the winner's own setKey segment -- a title that simply doesn't name a
  // product clearly is silent, not contradicting. `inferSetKeyFromTitle`
  // returns a human-display form ("Topps Now", "Donruss"); `resolveSetKeyForSlug`
  // (winnerSport, that answer, winnerYear) is the SAME year-aware reduction
  // computeHobbyIqCardId itself runs a title's product parse through before
  // minting a slug segment -- critically NOT the bare `normalizeSetKey`,
  // which has no year and so always resolves "Donruss" to the modern
  // "panini-donruss" even on an 1988 title (CF-PANINI-IS-ANACHRONISTIC-
  // BEFORE-2009, hobbyIqCardId.service.ts) and would falsely veto every
  // vintage Donruss/Score/etc. resolve.
  const titleSetKey = lower(resolveSetKeyForSlug(winnerSport, inferSetKeyFromTitle(t, winnerCardNumber) || "", winnerYear));
  if (titleSetKey && titleSetKey !== "unknown" && winnerSetKey && titleSetKey !== lower(winnerSetKey)) {
    return { vetoed: true, detail: `title's own product parse ("${titleSetKey}") disagrees with the winning candidate's setKey ("${winnerSetKey}")` };
  }

  // ── CARD NUMBER: only checked when BOTH the title states one and the
  // sale itself carries one to compare it against.
  const titleNumber = extractCardNumberFromTitle(t);
  if (titleNumber && winnerCardNumber && !sameCardNumber(titleNumber, winnerCardNumber)) {
    return { vetoed: true, detail: `title states card number "${titleNumber}", which disagrees with the winning candidate's own number "${winnerCardNumber}"` };
  }

  // ── PLAYER (REVIEW #2, HIGH, 2026-09-19). A REAL title-side player guess,
  // via `guessTitlePlayer` -- the SAME lazy require of dist/services/compiq/
  // cardQueryParser.js, the same confidence>0 floor, as
  // repoint-sales-to-checklist-numbered.cjs's own `guessPlayerFromTitleLocal`
  // (not re-implemented; this is the identical pattern against the identical
  // compiled parser). The FIRST version of this veto called
  // `playerTheTitleAllows(winnerCatalogPlayerName, winnerCatalogPlayerName)`
  // -- a string compared with ITSELF, which can never disagree and never
  // vetoed anything. Wiring the model lane's own veto (`outcome ===
  // "irreconcilable"`) VERBATIM against a real title guess reproduced three
  // false positives measured in production against this exact title corpus:
  //
  //   title guess "James"             vs winner "James Wood RC"
  //   title guess "Mason Montgomery"  vs winner "Mason Montgomery RC"
  //   title guess "Roki Sasaki Ff Nyc" vs winner "Roki Sasaki RC"
  //
  // Every one is the SAME player -- `playerNameKey` (playerTheTitleAllows.ts)
  // strips jr/sr/ii/iii/iv/v but NOT "RC" ("James Wood RC" -> surname token
  // "rc", not "wood"), so `isAbbreviationOf`'s own surname-anchored compare
  // sees mismatched surnames and calls it IRRECONCILABLE on the RC marker
  // alone -- exactly the false-contradiction shape this lane's own review
  // exists to catch before it reaches "irreconcilable" at all.
  //
  // THE FIX is a narrower, additive gate ON TOP of playerTheTitleAllows,
  // never a change to that shared function (which the model lane and this
  // one must keep agreeing with): normalise BOTH sides through
  // cleanPlayerName (strips RC/RR/DP/TC/UER/SP/SSP -- the SAME reduction
  // playerIdentityKey.ts's own header documents doing first, for this exact
  // reason) + playerIdentityKey, and veto ONLY when ALL of:
  //
  //   1. the title guess has >= 2 name tokens (a bare single word --
  //      "James" -- is too weak a signal to contradict a checklist-backed
  //      catalog row; measured false positive #1 above is exactly this);
  //   2. guessTitlePlayer's own confidence floor already passed (baked into
  //      guessTitlePlayer itself, mirroring guessPlayerFromTitleLocal);
  //   3. the guess shares NO token with ANY name listed on the winner's own
  //      catalog row (multi-player rows: "Eddie Murray / Cal Ripken Jr." --
  //      any listed name's tokens count, via the SAME "/" & "&" split
  //      multiPlayerKeysOf already uses elsewhere in this file).
  //
  // "Shares no token" rather than a stricter equality/abbreviation test is
  // deliberately permissive: "Mason Montgomery" (title, after cleaning)
  // shares both tokens with "Mason Montgomery" (winner, after cleaning) and
  // is a clean agreement, never reaching this rule at all; "Roki Sasaki"
  // (title, after cleaning strips "Ff Nyc"? -- no, cardQueryParser's own
  // parse already returns "Roki Sasaki" for that title, see the test) shares
  // both tokens with "Roki Sasaki" too. A genuine contradiction --
  // "LeBron James" against a Wembanyama catalog row -- shares ZERO tokens
  // and correctly vetoes.
  if (winnerCatalogPlayerName) {
    const titleGuess = guessTitlePlayer(t, deps);
    if (titleGuess) {
      const guessTokens = playerIdentityTokens(titleGuess, deps);
      if (guessTokens.length >= 2) {
        const winnerTokenSets = String(winnerCatalogPlayerName ?? "")
          .split(/\s*[/&]\s*/)
          .map((name) => new Set(playerIdentityTokens(name, deps)))
          .filter((set) => set.size > 0);
        const sharesAnyToken = winnerTokenSets.some((winnerSet) => guessTokens.some((tok) => winnerSet.has(tok)));
        if (winnerTokenSets.length && !sharesAnyToken) {
          return { vetoed: true, detail: `title's own player guess ("${titleGuess}") shares no name token with the winning candidate's catalog player ("${winnerCatalogPlayerName}")` };
        }
      }
    }
  }

  return { vetoed: false };
}

/**
 * The title's own player guess -- the SAME lazy require + confidence>0 floor
 * as repoint-sales-to-checklist-numbered.cjs's own `guessPlayerFromTitleLocal`
 * (not re-implemented, the identical pattern against the identical compiled
 * parser: dist/services/compiq/cardQueryParser.js's `parseCardQuery`).
 */
function guessTitlePlayer(title, deps) {
  try {
    const parsed = deps.parseCardQuery(String(title || ""));
    if (!parsed || !(Number(parsed.confidence) > 0)) return null;
    const player = parsed.playerName;
    return typeof player === "string" && player.trim().length > 0 ? player.trim() : null;
  } catch { return null; }
}

/** A name reduced to its identity-bearing tokens: cleanPlayerName strips the
 *  RC/RR/DP/TC/UER/SP/SSP family FIRST (the exact fix for the three measured
 *  false positives -- "James Wood RC" and "James Wood" must tokenize the
 *  same), then playerIdentityKey folds accents/symbols/punctuation, and the
 *  result is split on whitespace into tokens. Returns [] for an empty/
 *  unresolvable name. */
function playerIdentityTokens(name, deps) {
  const cleaned = deps.cleanPlayerName(String(name ?? ""));
  const key = deps.playerIdentityKey(cleaned);
  // playerIdentityKey already removed every non-alphanumeric character, so
  // there is no whitespace left to split on -- re-derive token boundaries
  // from the CLEANED (pre-key) string instead, lowercased, split on
  // whitespace, each token then run through the same identity fold so
  // "O'Neill" and "ONeill" still compare equal token-for-token.
  return cleaned
    .toLowerCase()
    .split(/\s+/)
    .map((tok) => deps.playerIdentityKey(tok))
    .filter(Boolean);
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  RESOLVE-SPLIT-IDENTITY-PARKS: resolve 2026-09-07 split-identity parks");
  console.log("  (cardId vertical vs hobbyiqCardId vertical) by checklist+player evidence");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  if (SCOPE_REJECTED.length) {
    console.error("");
    console.error(`FATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are neither`);
    console.error(`       'all-splits' nor a sport:year cell: ${SCOPE_REJECTED.join(", ")}`);
    console.error("       A cell looks like basketball:2023 (sport:year).");
    process.exit(2);
  }
  if (!SCOPE_IS_ALL && (!SCOPE_CELLS.length || RAW_SCOPE.some((x) => ["", "refractor", "all"].includes(lower(x))))) {
    console.error("");
    console.error("FATAL: SCOPE is REQUIRED. Pass -f scope=all-splits to sweep every parked");
    console.error("       row this lane can reach, or a comma list of sport:year cells, e.g.");
    console.error("       -f scope=basketball:2023,baseball:2023. The runner's inherited");
    console.error("       default ('', 'refractor', 'all') is refused -- there is no bare");
    console.error("       'all' synonym; a whole-source resolve needs its own name.");
    process.exit(2);
  }
  // Empty means "the operator left it blank" (this lane's own default); any
  // OTHER value is a stray carried over from a different script's MODE
  // vocabulary, refused rather than silently ignored -- but ONLY here,
  // inside main(), never at module load: several test runners (vitest among
  // them) set their own process.env.MODE for unrelated reasons, and an
  // import-time exit would break every pure-function unit test that requires
  // this file. main() itself only ever runs when this file is executed
  // directly (require.main === module, at the bottom of this file), never
  // when a test merely imports it for its pure helpers -- so this check
  // never sees a test runner's own MODE value in practice.
  if (RAW_MODE !== "") {
    console.error("");
    console.error(`FATAL: MODE "${process.env.MODE}" is not recognised -- resolve-split-identity-parks`);
    console.error("       has no modes; leave MODE empty.");
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { guardSoldCompDoc } = require(path.join(backend, "dist/services/portfolioiq/splitIdentityWriteGuard.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const { playerIdentityKey } = require(path.join(backend, "dist/services/catalog/playerIdentityKey.js"));
  const { inferSetKeyFromTitle } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
  const { extractCardNumberFromTitle } = require(path.join(backend, "dist/services/portfolioiq/soldCompsStore.service.js"));
  const { sameCardNumber, resolveSetKeyForSlug } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  // REVIEW #2: parseCardQuery + cleanPlayerName back the REAL title-player
  // veto (guessTitlePlayer/playerIdentityTokens above) -- the same lazy
  // require of dist/services/compiq/cardQueryParser.js
  // repoint-sales-to-checklist-numbered.cjs's own guessPlayerFromTitleLocal
  // uses, and the same cleanPlayerName (cardCatalog.service.js) whose RC/RR/
  // DP/TC/UER/SP/SSP strip playerIdentityKey.ts's own header already runs
  // FIRST for exactly this reason.
  const { parseCardQuery } = require(path.join(backend, "dist/services/compiq/cardQueryParser.js"));
  const { cleanPlayerName } = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));
  const TWO_SPORT_ATHLETE_KEYS = require(path.join(__dirname, "lib", "two-sport-athletes.cjs")).buildTwoSportAthleteKeys(playerIdentityKey);

  const titleDeps = { inferSetKeyFromTitle, resolveSetKeyForSlug, extractCardNumberFromTitle, sameCardNumber, sportEvidenceFn: sportEvidence, parseCardQuery, cleanPlayerName, playerIdentityKey };

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const pool = db.container("sold_comps");
  const cat = db.container("card_catalog");

  console.log(`  scope            ${SCOPE_IS_ALL ? "all-splits (every parked split-identity row this lane can reach)" : SCOPE_CELLS.join(", ")}`);
  if (TITLES_FILTER.length) console.log(`  titles filter     ${TITLES_FILTER.join(", ")}`);
  if (EXCLUDED_WINNERS.size) console.log(`  exclude-winner    ${[...EXCLUDED_WINNERS].join(", ")}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");
  console.log("  selects sold_comps rows parked by the split-identity write guard");
  console.log("  (identityUnverified=true, cardId/hobbyiqCardId both hiq: slugs that");
  console.log("  differ, reason 'split-identity' or 'PARK. cardId vertical...'), builds the");
  console.log("  two candidate card_catalog ids (H=hobbyiqCardId, C=cardId), and resolves");
  console.log("  the ones where checklist+player evidence backs exactly ONE side.");
  console.log("");

  const s = {
    scanned: 0, otherShard: 0, otherCell: 0, otherTitleFilter: 0,
    resolveToHByPatch: 0, resolveToHByRelocate: 0, resolveToCByPatch: 0,
    alreadyAtTarget: 0, collapsedOntoResident: 0,
    leave: {}, refused: {}, failed: 0,
  };
  const byCell = new Map();
  const leaveExamples = {};
  const refuseExamples = {};
  const failures = [];
  const resolveExamples = [];
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const bumpReason = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };
  const pushExample = (map, k, line, cap = 20) => {
    if (!map[k]) map[k] = [];
    if (map[k].length < cap) map[k].push(line);
  };
  let stoppedAtBudget = false;

  // ── PLAN_OUT: one NDJSON record per in-scope row, written into the SAME
  // fixed path the runner already uploads (see module header). A synchronous
  // append -- this lane's own CONCURRENCY is bounded (default 8), so a
  // per-row fs.appendFileSync is never a bottleneck next to a Cosmos round
  // trip, and synchronous means no write can be lost to an unflushed buffer
  // if the process is killed at its own budget boundary.
  let planFd = null;
  if (PLAN_OUT) {
    try {
      fs.mkdirSync(PLAN_OUT, { recursive: true });
      const planPath = path.join(PLAN_OUT, `plan-slot-${SHARD_SCOPE.SLOT}.ndjson`);
      // Truncate at the START of a run (not append across relaunches) --
      // each relaunch's own selection is disjoint from the last (a row this
      // run resolves drops out of the next run's own query), so a
      // continuation's plan file describes ONLY the rows THIS invocation
      // reached, same scope discipline the banner's own 'scanned' line
      // documents in its LIVE-COUNT NOTE below.
      planFd = fs.openSync(planPath, "w");
      console.log(`  plan file         ${planPath}`);
    } catch (e) {
      console.log(`\n::warning::could not open PLAN_OUT (${PLAN_OUT}): ${e?.message}`);
      planFd = null;
    }
  }
  let planRowsWritten = 0;
  /**
   * Write ONE plan record. `doc` is the row this run is deciding; `action`
   * is one of resolve-to-c-patch/resolve-to-h-patch/resolve-to-h-relocate/
   * collapse/leave/refused/failed; `reason` is the named bucket (verdict
   * reason, or the LEAVE/REFUSED bucket name); `extra` carries the winner +
   * catalog-player + twin fields documented in the module header, whichever
   * apply to this outcome (undefined fields serialise as omitted, never a
   * stray `null` key on rows that never had a winner).
   */
  function emitPlanRow(doc, action, reason, extra = {}) {
    planRowsWritten++;
    if (!planFd) return;
    const record = {
      action, reason,
      id: doc?.id ?? null, source: doc?.source ?? null, title: doc?.title ?? null,
      price: doc?.price ?? null, soldAt: doc?.soldAt ?? null,
      cardId: doc?.cardId ?? null, hobbyiqCardId: doc?.hobbyiqCardId ?? null,
      winner: extra.winner ?? null,
      winnerCatalogPlayer: extra.winnerCatalogPlayer ?? null,
      winnerCatalogSource: extra.winnerCatalogSource ?? null,
      titlePlayerGuess: extra.titlePlayerGuess ?? null,
      twinId: extra.twinId ?? null, twinSource: extra.twinSource ?? null,
    };
    try { fs.appendFileSync(planFd, JSON.stringify(record) + "\n"); }
    catch (e) { console.log(`\n::warning::PLAN_OUT write failed for ${doc?.id}: ${e?.message}`); }
  }

  // ── ROLLUP (banner-readable, no file needed to see the SHAPE of a run).
  // fromWinner: keyed on "<hobbyiqCardId>" + ROLLUP_DELIM + "<winner>" --
  // top 40 pairs by count. neitherSideNames: keyed on "<cardId-side
  // product>" + ROLLUP_DELIM + "<hobbyiqCardId-side product>" for the
  // `neither-side-names-the-player` bucket only -- top 25 combos.
  // ROLLUP_DELIM (the literal codepoint U+0000, never found in a slug or
  // a product name) is the join separator so a product name containing
  // "->" or a comma can never be misparsed back into two fields when the
  // key is split back apart for the banner.
  const ROLLUP_DELIM = "\u0000";
  const fromWinnerRollup = new Map();
  const neitherSideRollup = new Map();
  const bumpRollup = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  /** Point read + memoise a card_catalog row by id (partition key IS the id
   *  for an hiq: slug). Caches the IN-FLIGHT PROMISE, not the resolved
   *  value -- several sales sharing an identity cell can call this before
   *  the first read resolves, and a value-only cache would race, exactly as
   *  revert-set-sport-repair.cjs's own catalogRowAt documents. */
  const catalogRowCache = new Map();
  async function catalogRowAt(id) {
    if (!id) return null;
    if (catalogRowCache.has(id)) return catalogRowCache.get(id);
    const p = (async () => {
      try { return (await retry(() => cat.item(id, id).read())).resource ?? null; }
      catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
    })();
    catalogRowCache.set(id, p);
    return p;
  }

  /** Point read at the destination a resolve-to-H relocate would move to. */
  async function residentAt(saleId, cardId) {
    try { return (await retry(() => pool.item(saleId, cardId).read())).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
  }
  function isSameSale(resident, incomingAtNewAddress) {
    if (!resident) return false;
    return contentHashOf(resident) === contentHashOf(incomingAtNewAddress);
  }

  // ── REVIEW #1 (HIGH, 2026-09-19): PHYSICAL-SALE TWINS ---------------------
  //
  // CardHedge dual-id twins of ONE physical sale carry DIFFERENT `id`s
  // (e.g. a `cardhedge::…` row and a `tca-ebay::…` row, or ch-daily vs
  // ch-fill) -- CF-A-SLUG-SEGMENT-IS-NOT-A-VENDOR-LABEL's own sibling
  // finding, `project_cardhedge_dual_id_duplicates_and_graded_in_raw_pool`.
  // Grouping this run's own candidate rows by `doc.id` (the page-walk
  // below) therefore does NOT serialise two twins of the same physical
  // sale, because they are DIFFERENT `id`s and land in DIFFERENT groups --
  // and `residentAt(doc.id, H)` above only ever checks for the SAME `id`
  // already at H, so it can never see a twin filed under its own,
  // different, id. Both twins independently see "nothing resident yet" and
  // both write to H: the double-count that already exists today (each
  // twin already prices via H under PR #2341's read path) survives the
  // resolve unless this lane collapses it -- and a resolve, which touches
  // every parked row anyway, is the natural place to do that rather than
  // cementing the duplicate a second time under a newly-coherent identity.
  //
  // PHYSICAL-SALE SIGNATURE. price + soldAt (floored to the DAY, matching
  // contentHashOf's own `day()` helper) is the narrowest equality/prefix
  // filter Cosmos can serve as a SINGLE-PARTITION, index-served query (never
  // a cross-partition scan) -- `c.cardId = @dest AND c.price = @p AND
  // STARTSWITH(c.soldAt, @day)`. That narrows to a small candidate set;
  // `isSameSale` (the SAME contentHashOf-based predicate every other
  // collapse/collision check in this file already uses) decides identity
  // FROM those candidates in memory, so this is additive precision, never a
  // second, looser definition of "same sale."
  //
  // SERIALISED WITHIN A RUN by a PHYSICAL-SALE KEY (destination cardId|
  // price|soldAt-day, `physicalSaleKeyOf` above at module scope -- pure, no
  // I/O, exported for its own unit test), not by `id` -- two twins of the
  // same physical sale have DIFFERENT ids and would otherwise both pass the
  // destination check concurrently (read-then-write race: both read "no
  // twin yet", both write). `physicalSaleMutex` below is a promise-chain-
  // per-key lock: every `handleRow` call for the SAME physical-sale key
  // awaits the prior one's mutex link before running its own destination
  // scan + write, so the scan always sees any twin the SAME run already
  // resolved.
  const physicalSaleMutex = new Map();
  /** Run `fn` serialised against every OTHER call sharing the same
   *  physical-sale key, in this run only -- a promise-chain lock, not a
   *  distributed one. Always resolves/rejects with `fn`'s own outcome. */
  function withPhysicalSaleLock(key, fn) {
    const prior = physicalSaleMutex.get(key) ?? Promise.resolve();
    const chained = prior.then(fn, fn);
    // Store a NEVER-REJECTING continuation as the new tail -- a failed
    // holder must not poison the lock for the next physical-sale twin.
    physicalSaleMutex.set(key, chained.then(() => {}, () => {}));
    return chained;
  }

  /**
   * Single-partition scan at `destCardId` for a resident row matching this
   * sale's PHYSICAL signature (price + soldAt day), any `id` OTHER than
   * `saleForHash.id` itself -- the twin check `residentAt` cannot make
   * because a twin's `id` differs from `doc.id` by construction. The
   * self-exclusion matters at the PATCH call site: when `destCardId`
   * equals the sale's OWN current partition (the row has not moved), the
   * sale's own resident document would otherwise match its own query and
   * "find" itself as its own twin. Returns the first OTHER row
   * `contentHashOf` confirms is the same sale, or null. Index-served
   * (`c.cardId = @dest` is the partition key equality; `c.price`/
   * `STARTSWITH(c.soldAt,...)` are property filters WITHIN that one
   * partition, never cross-partition).
   */
  async function physicalTwinAtPartition(destCardId, saleForHash) {
    const price = Number(saleForHash?.price);
    const soldDay = String(saleForHash?.soldAt ?? "").slice(0, 10);
    if (!Number.isFinite(price) || !soldDay) return null;
    const res = await retry(() => pool.items.query({
      query: "SELECT * FROM c WHERE c.cardId = @dest AND c.price = @p AND STARTSWITH(c.soldAt, @day)",
      parameters: [
        { name: "@dest", value: destCardId },
        { name: "@p", value: price },
        { name: "@day", value: soldDay },
      ],
    }, { partitionKey: destCardId }).fetchAll());
    // EXCLUDE THE SALE'S OWN id -- when destCardId equals this sale's
    // CURRENT partition (the PATCH-shape call site, where the row has not
    // moved yet), the sale's own resident document matches its own query
    // trivially and would otherwise "find" itself as its own twin.
    const candidates = (res?.resources ?? []).filter((c) => c.id !== saleForHash?.id);
    const targetHash = contentHashOf({ ...saleForHash, cardId: destCardId });
    return candidates.find((c) => contentHashOf(c) === targetHash) ?? null;
  }

  async function handleRow(doc) {
    s.scanned++;
    const cells = cellsOf(doc.cardId, doc.hobbyiqCardId);
    if (!SCOPE_IS_ALL) {
      const inScope = [...cells].some((c) => SCOPE_CELLS.includes(c));
      if (!inScope) { s.otherCell++; return; }
    }
    if (SHARD_SCOPE.SHARDED && shardOf(String(doc.id)) !== SHARD_SCOPE.SLOT) { s.otherShard++; return; }
    if (TITLES_FILTER.length) {
      const t = lower(doc.title);
      if (!TITLES_FILTER.some((needle) => t.includes(needle))) { s.otherTitleFilter++; return; }
    }
    if (LIMIT && (s.resolveToHByPatch + s.resolveToHByRelocate + s.resolveToCByPatch) >= LIMIT) return;

    // ── REVIEW #5: a human claim (or the user-seed mint path) outranks a
    // catalog point-read -- leave these parked, named, never resolved.
    if (isPinnedOrFlagged(doc)) {
      bumpReason(s.leave, "pinned-or-flagged");
      pushExample(leaveExamples, "pinned-or-flagged", `  ${doc.id}@${doc.cardId}: verifiedByUser=${doc.verifiedByUser === true} flaggedWrong=${doc.flaggedWrong === true} excludedFromFmv=${doc.excludedFromFmv === true} source=${doc.source ?? "?"}`);
      emitPlanRow(doc, "leave", "pinned-or-flagged");
      return;
    }

    const H = str(doc.hobbyiqCardId);
    const C = str(doc.cardId);
    const hSport = sportSegmentOf(H);
    const cSport = sportSegmentOf(C);
    if (!segmentsOf(H) || !segmentsOf(C) || !hSport || !cSport) {
      bumpReason(s.leave, "malformed-candidate-id");
      pushExample(leaveExamples, "malformed-candidate-id", `  ${doc.id}@${doc.cardId}: cardId=${C} hobbyiqCardId=${H}`);
      emitPlanRow(doc, "leave", "malformed-candidate-id");
      return;
    }

    // The catalog reads run in BOTH REPORT and APPLY: the only difference
    // between the two is whether the write lands.
    let hRow, cRow;
    try {
      [hRow, cRow] = await Promise.all([catalogRowAt(H), catalogRowAt(C)]);
    } catch (e) {
      s.failed++;
      failures.push(`  FAILED catalog read ${doc.id}@${doc.cardId} (H=${H} C=${C}): ${String(e?.stack ?? e?.message ?? e)}`);
      emitPlanRow(doc, "failed", "catalog-read-failed");
      return;
    }

    const hMatch = checklistMatchOf(hRow, doc.playerName, catalogAuthorityOf, playerIdentityKey);
    const cMatch = checklistMatchOf(cRow, doc.playerName, catalogAuthorityOf, playerIdentityKey);
    const saleIsTwoSportAthlete = TWO_SPORT_ATHLETE_KEYS.has(playerIdentityKey(doc.playerName));
    const verdict = judgeSplitIdentityVerdict({ hMatch, cMatch, saleIsTwoSportAthlete });

    if (verdict.verdict === "leave") {
      bumpReason(s.leave, verdict.reason);
      pushExample(leaveExamples, verdict.reason, `  ${doc.id}@${doc.cardId}: ${verdict.detail}`);
      if (verdict.reason === "neither-side-names-the-player") {
        const cProduct = setKeySegmentOf(C) || "(unknown)";
        const hProduct = setKeySegmentOf(H) || "(unknown)";
        bumpRollup(neitherSideRollup, `${cProduct}${ROLLUP_DELIM}${hProduct}`);
      }
      emitPlanRow(doc, "leave", verdict.reason);
      return;
    }

    const winner = verdict.verdict === "resolve-to-h" ? H : C;
    const winnerRow = verdict.verdict === "resolve-to-h" ? hRow : cRow;
    const winnerSport = verdict.verdict === "resolve-to-h" ? hSport : cSport;
    const otherSport = verdict.verdict === "resolve-to-h" ? cSport : hSport;
    const planExtra = { winner, winnerCatalogPlayer: winnerRow?.playerName ?? null, winnerCatalogSource: winnerRow?.source ?? null };

    // ── EXCLUDE-BY-OPERATOR (optional, via titles=exclude-winner:<id>[,...]).
    // A row that would otherwise resolve to an operator-named winner is left
    // untouched instead -- named, counted, reconciled like every other LEAVE
    // bucket. Checked AFTER the verdict (so an excluded winner is reported
    // against the SAME winner id the verdict actually computed) but BEFORE
    // the title veto and any write, so an excluded row never reaches Cosmos.
    if (EXCLUDED_WINNERS.has(winner)) {
      bumpReason(s.leave, "excluded-by-operator");
      pushExample(leaveExamples, "excluded-by-operator", `  ${doc.id}@${doc.cardId}: winner ${winner} is named in this run's exclude-winner list -- left parked untouched`);
      bumpRollup(fromWinnerRollup, `${doc.hobbyiqCardId}${ROLLUP_DELIM}${winner}`);
      emitPlanRow(doc, "leave", "excluded-by-operator", planExtra);
      return;
    }

    // ── TITLE VETO: never a decider, only a refusal of a checklist-backed
    // winner the title actively contradicts.
    const veto = titleVetoes({
      title: doc.title,
      winnerSport,
      winnerYear: Number(yearSegmentOf(winner)),
      winnerSetKey: setKeySegmentOf(winner),
      winnerCardNumber: doc.cardNumber,
      winnerCatalogPlayerName: winnerRow?.playerName,
      otherSport,
    }, titleDeps);
    if (veto.vetoed) {
      bumpReason(s.leave, "title-contradicts-winner");
      pushExample(leaveExamples, "title-contradicts-winner", `  ${doc.id}@${doc.cardId}: ${veto.detail}`);
      emitPlanRow(doc, "leave", "title-contradicts-winner", { ...planExtra, titlePlayerGuess: guessTitlePlayer(doc.title, titleDeps) });
      return;
    }

    // Every genuine resolve (never excluded, never vetoed) rolls up here --
    // the SAME winner every write shape below converges on.
    bumpRollup(fromWinnerRollup, `${doc.hobbyiqCardId}${ROLLUP_DELIM}${winner}`);

    // ── ALREADY AT TARGET: cardId, hobbyiqCardId and sport already all
    // equal the winner -- some earlier partial run or unrelated fix already
    // resolved the fields but never cleared the park stamp. Clear the stamp
    // only; no new decision to make.
    const alreadyResolved = doc.cardId === winner && doc.hobbyiqCardId === winner && doc.sport === winnerSport;

    const cellKey = [...cells].join(",") || "unknown-cell";

    // ── REVIEW #1: serialise the write against every OTHER sale in THIS run
    // sharing this sale's physical signature (destination|price|soldAt-day)
    // -- a CardHedge dual-id twin has a DIFFERENT `doc.id`, so the page-walk's
    // own group-by-id below cannot serialise two twins against each other;
    // this is the one place that does. `winner` is the destination cardId
    // both write shapes converge on (`keep.cardId`) -- the SAME partition
    // `physicalTwinAtPartition` scans below, so two movers to DIFFERENT
    // destinations (which can never be the same physical sale) run
    // concurrently, and only a genuine race at ONE destination serialises.
    await withPhysicalSaleLock(physicalSaleKeyOf(doc, winner), async () => {
    try {
      const ledger = {
        splitResolvedAt: new Date().toISOString(),
        splitResolvedTo: verdict.verdict === "resolve-to-h" ? "hobbyiqCardId" : "cardId",
        splitResolvedFrom: { cardId: doc.cardId, hobbyiqCardId: doc.hobbyiqCardId },
        splitResolvedBy: "resolve-split-identity-parks",
      };
      const keep = { ...stripSystem(doc) };
      for (const f2 of PARK_FIELDS) delete keep[f2];
      Object.assign(keep, ledger, { sport: winnerSport, hobbyiqCardId: winner });
      keep.cardId = winner;

      // ── THE WRITE-DOOR GUARD, before anything is written. By construction
      // cardId === hobbyiqCardId === winner, so decideSplitIdentity sees one
      // product on both sides and returns "ok" for every genuine resolve --
      // this IS the correctness proof that a resolve never re-parks itself.
      const guardVerdict = guardSoldCompDoc(keep, { guardedBy: "resolve-split-identity-parks" });
      if (guardVerdict.verdict === "park") {
        bumpReason(s.refused, "guard-parked");
        pushExample(refuseExamples, "guard-parked", `  ${doc.id}@${doc.cardId} -> ${winner}: ${guardVerdict.detail}`);
        emitPlanRow(doc, "refused", "guard-parked", planExtra);
        return;
      }

      if (alreadyResolved || verdict.verdict === "resolve-to-c" || doc.cardId === winner) {
        // ── REVIEW #1 (delta review, HIGH): a row sharing this sale's
        // physical signature (price+soldAt-day) may already be resident at
        // this SAME partition under a different id. `contentHashOf` matching
        // is NOT, on its own, proof it is the SAME LISTING filed twice --
        // many distinct $1.99 raw copies of a common card, sold the same
        // day at the same price with templated CardHedge titles, hash
        // identically and are NOT duplicates. This lane NEVER deletes a sale
        // on that guess (owner rule: deletes need the owner; absent beats
        // wrong). It only ever leaves the row PARKED here -- a patch never
        // deletes anything regardless, so there is nothing to collapse; the
        // only question is whether to write the identity fix at all -- and
        // it does not, because patching this row's identity onto a
        // pre-existing physical-sale match (proven-twin or not) would still
        // leave two rows resolved to the same address, which a human should
        // look at named, not have this lane guess through.
        const patchTwin = await physicalTwinAtPartition(doc.cardId, doc);
        if (patchTwin) {
          const provenTwin = sameListingIdentity(doc, patchTwin);
          const reason = provenTwin ? "duplicate-of-resolved-resident" : "possible-twin-at-destination";
          const detail = provenTwin
            ? `a physical-sale twin already resides at this SAME partition under a different id (${patchTwin.id}), and both share listing id "${listingIdOf(doc)}" -- left parked, not patched, to avoid cementing the pre-existing duplicate`
            : `a row matching this sale's price+soldAt-day already resides at this SAME partition under a different id (${patchTwin.id} source=${patchTwin.source ?? "?"}), but NEITHER doc proves a shared external listing id (this=${listingIdOf(doc) || "(none)"} source=${doc.source ?? "?"}, other=${listingIdOf(patchTwin) || "(none)"}) -- could be a genuine twin OR two distinct sales (e.g. two different $1.99 raw copies sold the same day); left parked for a human, never resolved on a guess`;
          bumpReason(s.refused, reason);
          pushExample(refuseExamples, reason, `  ${doc.id}@${doc.cardId} (source=${doc.source ?? "?"}, title="${str(doc.title).slice(0, 60)}") vs ${patchTwin.id}@${patchTwin.cardId} (source=${patchTwin.source ?? "?"}, title="${str(patchTwin.title).slice(0, 60)}"): ${detail}`);
          emitPlanRow(doc, "refused", reason, { ...planExtra, twinId: patchTwin.id ?? null, twinSource: patchTwin.source ?? null });
          return;
        }

        // PATCH shape: partition (cardId) does not move. RESOLVE-TO-C is
        // always this shape (cardId already equals C by construction of the
        // predicate); RESOLVE-TO-H takes this shape only in the
        // already-at-target case, or the defensive case where cardId
        // already equals H for some other reason.
        if (APPLY) {
          // ── REVIEW #3 (MEDIUM, 2026-09-19): CONDITIONAL WRITES. `doc._etag`
          // is the PLANNING read's own etag -- the page-walk's own query
          // result this handleRow call was handed, captured before any of
          // this row's own I/O ran. Two layers, both keyed on that SAME
          // planning etag:
          //
          //   1. RE-READ IMMEDIATELY BEFORE WRITE: a fast, explicit check --
          //      if the document's CURRENT etag already differs from the
          //      planning etag, refuse now rather than let Cosmos discover
          //      it (cheaper, and gives a clearer refusal reason).
          //   2. THE WRITE ITSELF still carries an IfMatch access condition
          //      on the PLANNING etag (never the fresh re-read's own etag --
          //      using the fresh value would only catch a race in the
          //      instant between the re-read and the patch call, not the
          //      much wider window between this row's OWN planning read and
          //      the write, which is the actual race this review closes).
          //      Cosmos itself is the enforcement layer of last resort: even
          //      if step 1 raced and missed a concurrent change, the server
          //      still refuses a write against a stale etag.
          //
          // Either layer 412ing REFUSES the write outright (never retried --
          // retry() only retries 429/timeout-shaped errors) and is counted
          // `stale-since-plan`, disjoint from every other outcome.
          const planEtag = doc._etag;
          try {
            const fresh = await retry(() => pool.item(doc.id, doc.cardId).read());
            if (planEtag && fresh?.resource?._etag && fresh.resource._etag !== planEtag) {
              bumpReason(s.refused, "stale-since-plan");
              pushExample(refuseExamples, "stale-since-plan", `  ${doc.id}@${doc.cardId}: patch refused -- a re-read immediately before write found the document already changed since this run's own planning read; nothing written`);
              emitPlanRow(doc, "refused", "stale-since-plan", planExtra);
              return;
            }
          } catch (e) {
            if (!(e?.code === 404 || e?.statusCode === 404)) throw e;
          }
          try {
            await retry(() => pool.item(doc.id, doc.cardId).patch([
              { op: "set", path: "/sport", value: keep.sport },
              { op: "set", path: "/hobbyiqCardId", value: keep.hobbyiqCardId },
              { op: "set", path: "/cardId", value: keep.cardId },
              { op: "set", path: "/splitResolvedAt", value: ledger.splitResolvedAt },
              { op: "set", path: "/splitResolvedTo", value: ledger.splitResolvedTo },
              { op: "set", path: "/splitResolvedFrom", value: ledger.splitResolvedFrom },
              { op: "set", path: "/splitResolvedBy", value: ledger.splitResolvedBy },
              ...PARK_FIELDS.filter((f2) => doc[f2] !== undefined).map((f2) => ({ op: "remove", path: `/${f2}` })),
            ], planEtag ? { accessCondition: { type: "IfMatch", condition: planEtag } } : undefined));
          } catch (e) {
            if (e?.code === 412 || e?.statusCode === 412) {
              bumpReason(s.refused, "stale-since-plan");
              pushExample(refuseExamples, "stale-since-plan", `  ${doc.id}@${doc.cardId}: patch refused (412) -- the document changed since this run's own planning read; nothing written`);
              emitPlanRow(doc, "refused", "stale-since-plan", planExtra);
              return;
            }
            throw e;
          }
        }
        if (alreadyResolved) s.alreadyAtTarget++;
        if (verdict.verdict === "resolve-to-h") s.resolveToHByPatch++; else s.resolveToCByPatch++;
        bump(byCell, cellKey);
        if (resolveExamples.length < 60) {
          resolveExamples.push(`  PATCH   ${str(doc.title).slice(0, 70)} | ${doc.cardId} | ${doc.hobbyiqCardId} -> ${winner} (${verdict.reason}, catalog player: ${winnerRow?.playerName ?? "?"})`);
        }
        emitPlanRow(doc, verdict.verdict === "resolve-to-h" ? "resolve-to-h-patch" : "resolve-to-c-patch", verdict.reason, planExtra);
        return;
      }

      // plan is RESOLVE-TO-H, and cardId !== H: the partition must move.
      const destCardId = winner;
      const resident = await residentAt(doc.id, destCardId);
      if (resident) {
        if (isSameSale(resident, { ...keep, cardId: destCardId })) {
          if (APPLY) await retry(() => pool.item(doc.id, doc.cardId).delete());
          s.collapsedOntoResident++;
          bump(byCell, cellKey);
          if (resolveExamples.length < 60) resolveExamples.push(`  COLLAPSE ${str(doc.title).slice(0, 70)} -- same sale already resident at ${destCardId}; wrong-partition copy deleted`);
          emitPlanRow(doc, "collapse", "same-id-resident", { ...planExtra, twinId: resident.id ?? null, twinSource: resident.source ?? null });
          return;
        }
        bumpReason(s.refused, "destination-collision");
        pushExample(refuseExamples, "destination-collision", `  ${doc.id}@${doc.cardId} -> ${destCardId}: a DIFFERENT sale (by content hash) already resides at the destination; NEITHER moved -- resident price=${resident.price ?? "?"} soldAt=${resident.soldAt ?? "?"} vs incoming price=${doc.price ?? "?"} soldAt=${doc.soldAt ?? "?"}`);
        emitPlanRow(doc, "refused", "destination-collision", { ...planExtra, twinId: resident.id ?? null, twinSource: resident.source ?? null });
        return;
      }

      // ── REVIEW #1 (delta review, HIGH): a row matching this sale's
      // physical signature (price+soldAt-day) may already be resident at the
      // RELOCATE destination under a different id -- the `residentAt` check
      // above only ever matches `doc.id` itself, which a dual-id twin never
      // shares. `contentHashOf` agreeing is NOT proof it is the SAME LISTING
      // filed twice -- two DISTINCT real sales (same card, same price, same
      // day: many $1.99 raw copies with templated CardHedge titles) hash
      // identically and are NOT duplicates. This lane NEVER deletes the
      // moving copy on that guess alone (owner rule: deletes need the owner;
      // absent beats wrong):
      //
      //   - contentHash matches AND a non-empty external listing id is
      //     SHARED (sameListingIdentity -- sourceExternalId, or the same
      //     shape parsed from `id`, per makeId's own `${source}::
      //     ${externalId}`) -> PROVEN twin -> collapse: delete the moving
      //     copy, the resident survives, exactly as the same-id case does.
      //   - contentHash matches but NO shared listing id is provable
      //     (including every cross-vendor pair today: CardHedge's own
      //     `ch-daily::{price_history_id}` never equals an eBay item id) ->
      //     leave the MOVING row PARKED, untouched, named
      //     `possible-twin-at-destination` -- never relocated, never
      //     deleted, counted for a human to resolve by hand.
      //   - contentHash disagrees entirely -> a coincidence, not a twin --
      //     fall through to the ordinary relocate below, exactly as if no
      //     candidate had matched the narrower scan at all.
      const physicalTwin = await physicalTwinAtPartition(destCardId, doc);
      if (physicalTwin) {
        if (isSameSale(physicalTwin, { ...keep, cardId: destCardId })) {
          if (sameListingIdentity(doc, physicalTwin)) {
            if (APPLY) await retry(() => pool.item(doc.id, doc.cardId).delete());
            s.collapsedOntoResident++;
            bump(byCell, cellKey);
            if (resolveExamples.length < 60) resolveExamples.push(`  COLLAPSE ${str(doc.title).slice(0, 70)} -- a physical-sale twin (${physicalTwin.id}) already resides at ${destCardId}, both share listing id "${listingIdOf(doc)}"; this copy (${doc.id}) deleted, one survivor remains`);
            emitPlanRow(doc, "collapse", "physical-sale-twin-proven", { ...planExtra, twinId: physicalTwin.id ?? null, twinSource: physicalTwin.source ?? null });
            return;
          }
          bumpReason(s.refused, "possible-twin-at-destination");
          pushExample(refuseExamples, "possible-twin-at-destination", `  ${doc.id}@${doc.cardId} (source=${doc.source ?? "?"}, title="${str(doc.title).slice(0, 60)}") -> ${destCardId} vs resident ${physicalTwin.id} (source=${physicalTwin.source ?? "?"}, title="${str(physicalTwin.title).slice(0, 60)}"): same price+soldAt-day+contentHash, but NEITHER doc proves a shared external listing id (this=${listingIdOf(doc) || "(none)"}, other=${listingIdOf(physicalTwin) || "(none)"}) -- could be a genuine twin OR two distinct sales (e.g. two different $1.99 raw copies sold the same day); left PARKED, never moved or deleted on a guess`);
          emitPlanRow(doc, "refused", "possible-twin-at-destination", { ...planExtra, twinId: physicalTwin.id ?? null, twinSource: physicalTwin.source ?? null });
          return;
        }
        // A physical-sale-signature (price+soldAt-day) match that FAILS the
        // full contentHashOf compare is a coincidence, not a twin -- fall
        // through to the ordinary relocate below, exactly as if no
        // candidate had matched the narrower scan at all.
      }

      // ── REVIEW #3: same two-layer discipline as the patch shape, applied
      // to the RELOCATE's source-side DELETE. Layer 1 (APPLY only -- a
      // REPORT run performs no write and gains nothing from re-reading): a
      // fast re-read-before-write pre-check against the PLANNING etag
      // (`doc._etag`, from the page-walk's own query result). Layer 2: the
      // planning etag is ALSO passed as `ifMatchEtag` on the drop item --
      // relocate-sold-comp.cjs already supports this (see that file's own
      // CONDITIONAL DELETE doc) -- so Cosmos itself refuses the delete if
      // the document changed since the plan, even if layer 1 raced and
      // missed it. A 412 from EITHER layer is reported in `staleSincePlan`,
      // disjoint from `duplicatesLeft`, and never retried.
      const planEtagForDrop = doc._etag;
      if (APPLY) {
        try {
          const fresh = await retry(() => pool.item(doc.id, doc.cardId).read());
          if (planEtagForDrop && fresh?.resource?._etag && fresh.resource._etag !== planEtagForDrop) {
            bumpReason(s.refused, "stale-since-plan");
            pushExample(refuseExamples, "stale-since-plan", `  ${doc.id}@${doc.cardId}: relocate refused -- a re-read immediately before write found the document already changed since this run's own planning read; nothing written`);
            emitPlanRow(doc, "refused", "stale-since-plan", planExtra);
            return;
          }
        } catch (e) {
          if (!(e?.code === 404 || e?.statusCode === 404)) throw e;
        }
      }
      const res = await relocateSoldComp(pool, {
        keep, drop: [{ id: doc.id, cardId: doc.cardId, ifMatchEtag: planEtagForDrop }],
        retry, verifyFields: ["cardId", "hobbyiqCardId", "sport", "splitResolvedTo"], dryRun: !APPLY,
      });
      if (res.guard?.verdict === "park") {
        bumpReason(s.refused, "guard-parked");
        pushExample(refuseExamples, "guard-parked", `  ${doc.id}@${doc.cardId}: ${res.error ?? res.guard.reason}`);
        emitPlanRow(doc, "refused", "guard-parked", planExtra);
        return;
      }
      if (res.staleSincePlan?.length) {
        bumpReason(s.refused, "stale-since-plan");
        pushExample(refuseExamples, "stale-since-plan", `  ${doc.id}@${doc.cardId}: relocate's source delete refused (412) -- the document changed since this run's own planning read; the new copy at ${destCardId} was written, the OLD copy at ${doc.cardId} was NOT deleted (a duplicate this lane does not retry past)`);
        emitPlanRow(doc, "refused", "stale-since-plan", planExtra);
        return;
      }
      if (!res.ok && res.stage !== "dry-run") {
        s.failed++;
        failures.push(`  FAILED relocate ${doc.id}@${doc.cardId} -> ${destCardId}: ${res.error ?? "unknown"}`);
        emitPlanRow(doc, "failed", "relocate-failed", planExtra);
        return;
      }
      s.resolveToHByRelocate++;
      bump(byCell, cellKey);
      if (resolveExamples.length < 60) {
        resolveExamples.push(`  RELOCATE ${str(doc.title).slice(0, 70)} | ${doc.cardId} | ${doc.hobbyiqCardId} -> ${winner} (${verdict.reason}, catalog player: ${winnerRow?.playerName ?? "?"})`);
      }
      emitPlanRow(doc, "resolve-to-h-relocate", verdict.reason, planExtra);
    } catch (e) {
      s.failed++;
      failures.push(`  FAILED resolve ${doc.id}@${doc.cardId}: ${String(e?.stack ?? e?.message ?? e)}`);
      emitPlanRow(doc, "failed", "unexpected-error", planExtra);
    }
    });
  }

  // ── bounded-concurrency page walk. A `.catch` on EACH row's own promise,
  // not on the Promise.all as a whole -- one row throwing can never take
  // the rest of the batch, the page walk, or the run's own RECONCILE/
  // relaunch-marker down with it. Candidates are grouped by sale `id` and
  // processed serially WITHIN one id (never two concurrent writers on the
  // same sale); distinct ids within a page still run up to CONCURRENCY at
  // once, the same shared-cursor-pool shape the repoint lane uses.
  await forEachPage(pool, CANDIDATE_SPEC, async (page) => {
    const byId = new Map();
    for (const doc of page) {
      if (!byId.has(doc.id)) byId.set(doc.id, []);
      byId.get(doc.id).push(doc);
    }
    const groups = [...byId.values()];
    let i = 0;
    while (i < groups.length) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; return false; }
      const batch = groups.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((group) => (async () => {
        for (const doc of group) await handleRow(doc);
      })().catch((e) => {
        s.failed++;
        failures.push(`  FAILED (unexpected, backstop) group ${group[0]?.id}: ${String(e?.stack ?? e?.message ?? e)}`);
      })));
      i += CONCURRENCY;
    }
    return true;
  });

  console.log("");
  console.log(`scanned (parked split-identity, not yet resolved)   ${f(s.scanned)}`);
  if (SHARD_SCOPE.SHARDED) console.log(`  other shard                    ${f(s.otherShard)}`);
  if (!SCOPE_IS_ALL) console.log(`  other cell (outside scope)     ${f(s.otherCell)}`);
  if (TITLES_FILTER.length) console.log(`  other title filter              ${f(s.otherTitleFilter)}`);
  console.log("");
  console.log(`  ${APPLY ? "RESOLVE-TO-H (patch)" : "WOULD RESOLVE-TO-H (patch)"}      ${f(s.resolveToHByPatch)}${s.alreadyAtTarget ? `   (${f(s.alreadyAtTarget)} already at target -- stamp-clear only)` : ""}`);
  console.log(`  ${APPLY ? "RESOLVE-TO-H (relocate)" : "WOULD RESOLVE-TO-H (relocate)"}   ${f(s.resolveToHByRelocate)}`);
  console.log(`  ${APPLY ? "RESOLVE-TO-C (patch)" : "WOULD RESOLVE-TO-C (patch)"}      ${f(s.resolveToCByPatch)}`);
  console.log(`  COLLAPSED onto a resident (same sale, by hash)  ${f(s.collapsedOntoResident)}`);
  for (const [reason, n] of Object.entries(s.leave)) console.log(`  LEAVE: ${reason.padEnd(28)} ${f(n)}`);
  for (const [reason, n] of Object.entries(s.refused)) console.log(`  REFUSED: ${reason.padEnd(26)} ${f(n)}`);
  console.log(`  failed                          ${f(s.failed)}`);

  if (byCell.size) {
    console.log(`\n  by sport:year cell (top 25):`);
    for (const [k, n] of [...byCell.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      console.log(`    ${String(n).padStart(9)}  ${k}`);
    }
  }

  // ── ROLLUPS -- the SHAPE of a run readable without opening the plan file.
  if (fromWinnerRollup.size) {
    console.log(`\n  top 40 (hobbyiqCardId -> winner) pairs by row count:`);
    const rows = [...fromWinnerRollup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    for (const [key, n] of rows) {
      const [fromId, toId] = key.split(ROLLUP_DELIM);
      console.log(`    ${String(n).padStart(7)}  ${fromId} -> ${toId}`);
    }
  }
  if (neitherSideRollup.size) {
    console.log(`\n  top 25 (cardId-side product, hobbyiqCardId-side product) combos for neither-side-names-the-player:`);
    const rows = [...neitherSideRollup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    for (const [key, n] of rows) {
      const [cProduct, hProduct] = key.split(ROLLUP_DELIM);
      console.log(`    ${String(n).padStart(7)}  (${cProduct}, ${hProduct})`);
    }
  }

  if (resolveExamples.length) {
    console.log(`\n  RESOLVE examples (up to 60, for eyeballing -- title | cardId | hobbyiqCardId -> winner + catalog player):`);
    for (const e of resolveExamples) console.log(e);
  }
  for (const [reason, list] of Object.entries(leaveExamples)) {
    console.log(`\n  LEAVE (${reason}), every one listed (${f(list.length)} shown, ${f(s.leave[reason] || 0)} total -- full list in the uploaded plan file, action=leave reason=${reason}):`);
    for (const l of list) console.log(l);
  }
  for (const [reason, list] of Object.entries(refuseExamples)) {
    console.log(`\n  REFUSED (${reason}), every one listed (${f(list.length)} shown, ${f(s.refused[reason] || 0)} total -- full list in the uploaded plan file, action=refused reason=${reason}):`);
    for (const l of list) console.log(l);
  }
  if (failures.length) { console.log(`\n  FAILURES (${f(failures.length)}):`); for (const fl of failures) console.log(fl); }

  if (planFd) {
    console.log(`\n  plan file rows written  ${f(planRowsWritten)}  (one NDJSON record per in-scope row -- resolve/collapse/leave/refused/failed, every one auditable, not just the samples above)`);
    try { fs.closeSync(planFd); } catch { /* best effort */ }
  } else if (PLAN_OUT) {
    console.log(`\n  ::warning::PLAN_OUT was set but no plan file was opened -- see the warning above.`);
  }

  console.log("");
  console.log(`  LIVE-COUNT NOTE: 'scanned' above is what THIS run's paged walk read (bounded`);
  console.log(`  by SCOPE/SHARD/TITLES/LIMIT/budget), never a cross-partition COUNT -- it is`);
  console.log(`  not a census of every parked split-identity row still live in sold_comps.`);

  // ── CF-A-SALE-IS-NEVER-LOST-STYLE RECONCILIATION ---------------------------
  const totalLeave = Object.values(s.leave).reduce((a, b) => a + b, 0);
  const totalRefused = Object.values(s.refused).reduce((a, b) => a + b, 0);
  const written = s.resolveToHByPatch + s.resolveToHByRelocate + s.resolveToCByPatch + s.collapsedOntoResident;
  const skipped = totalLeave;
  const intended = s.scanned - s.otherShard - s.otherCell - s.otherTitleFilter;
  const accountedFor = written + skipped + totalRefused + s.failed;
  console.log("");
  console.log(`RECONCILE`);
  console.log(`  intended (in scope, this shard)   ${f(intended)}`);
  console.log(`  = written (resolved+collapsed) ${f(written)} + skipped (leave) ${f(skipped)} + refused ${f(totalRefused)} + failed ${f(s.failed)}`);
  if (accountedFor !== intended) {
    console.error(`!! RECONCILE: accounted ${f(accountedFor)} != intended ${f(intended)}. A row is unaccounted for. Exit 4.`);
    process.exitCode = 4;
  } else {
    console.log(`  RECONCILE BALANCES -- every in-scope row is resolved, collapsed, left (named), refused (named), or failed (named).`);
  }

  if (APPLY) {
    reportWrites({ job: "resolve-split-identity-parks", intended, written, skipped, refused: totalRefused, failed: s.failed });
  }

  console.log("");
  console.log(`  ${APPLY ? "RESOLVED" : "WOULD RESOLVE"} ${f(written)}   LEAVE ${f(totalLeave)}   REFUSED ${f(totalRefused)}`);
  if (stoppedAtBudget || CLOCK.outOfClock()) {
    console.log(`  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the slot has more to do`);
  }
  if (!APPLY) console.log(`\nREPORT ONLY -- nothing was written. Re-run with BACKFILL_APPLY=true to apply.`);

  if (s.failed) {
    console.error(`::error::${f(s.failed)} row(s) failed -- see FAILURES above.`);
    process.exitCode = 4;
  }
}

module.exports = {
  CANDIDATE_SPEC, segmentsOf, sportSegmentOf, yearSegmentOf, setKeySegmentOf,
  withSportSegment, cellsOf, checklistMatchOf, multiPlayerKeysOf,
  judgeSplitIdentityVerdict, titleVetoes, guessTitlePlayer, playerIdentityTokens,
  physicalSaleKeyOf, listingIdOf, sameListingIdentity, isPinnedOrFlagged, USER_SEED_SOURCES,
  ALL_SPLITS, CELL_RE, PARK_FIELDS, EXCLUDE_WINNER_PREFIX, EXCLUDED_WINNERS, TITLES_FILTER,
  parseTitlesInput,
};

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); await finishLane(1, { budget: CLOCK }); });
}
