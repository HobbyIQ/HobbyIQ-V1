#!/usr/bin/env node
/**
 * resolve-disagreeing-sale-twins.cjs -- of the 23,688 `twins-disagree` pairs
 * collapse-ch-synthetic-twins.cjs's REPORT found (slot 0 of 8, first pass) and
 * deliberately leaves, decide which of the two identities is RIGHT, using
 * ONLY evidence -- never a guess.
 *
 * THE POPULATION. A twin pair is the SAME CardHedge sale stored TWICE under
 * the two id shapes #2357's own follow-up sweep already proves are one sale
 * (same CH card id, same sale instant, same price cents) -- see
 * collapse-ch-synthetic-twins.cjs's own header for the full proof predicate,
 * REUSED here verbatim (imported, never re-implemented): `decideSyntheticTwin`
 * plus its `isProtected` / `isParkedSide` gates. Of every proven pair, this
 * lane's own population is the SUBSET where `decideSyntheticTwin` returns
 * `twins-disagree` -- the two copies carry DIFFERENT identities (22,861 on
 * `hobbyiqCardId`, 827 on grade). The sweep lane counts these and leaves them;
 * this lane is what looks at each one and decides.
 *
 * ONE SALE, TWO POOLS. Until a disagreement resolves, the sale is counted in
 * BOTH the long copy's cardId partition and the short copy's -- at least one
 * of the two pools is wrong, and the pool-level dedupe (dedupeSoldComps, at
 * FMV READ TIME) cannot see it: that dedupe collapses same-grade twins WITHIN
 * one partition, never across two different partitions holding two different
 * cardIds for what is provably the same underlying sale.
 *
 * THE DECISION, hobbyiqCardId axis (rules 1-2 below; grade axis is rule 3).
 *
 *   RULE 1 -- CHECKLIST + ROSTER. A side's `hobbyiqCardId` wins outright when:
 *     (a) it resolves to a STRICT checklist row -- `catalogAuthorityOf(row.source)
 *         === "checklist"` (the repo-standard strict-source test; there is no
 *         function literally named `isStrictChecklistSource` in the TS layer,
 *         so this reuses the SAME predicate repoint-sales-to-sibling-product.cjs
 *         and repoint-sales-parallel-suffix.cjs already trust for "is this
 *         source an adjudicating checklist");
 *     (b) that row's playerName matches the sale's own via `playerIdentityKey`
 *         (multi-player rows split on the D33 "/" and "&" separators, ANY
 *         listed name clearing it is enough -- catalogRowPlayerKeys, the same
 *         reader repoint-sales-to-sibling-product.cjs uses);
 *     (c) the sale's title does not CONTRADICT that row -- `titleContradictsTarget`,
 *         re-derived here as a thin orchestration of the SAME already-shipped
 *         primitives the two repoint lanes call in the same order
 *         (extractCardNumberFromTitle+sameCardNumber, statedFinishFromChecklist+
 *         parallelTheTitleAllows, playerTheTitleAllows) -- no new title parser;
 *     (d) the title does not name a year or product that CONTRADICTS the
 *         candidate's own cell -- `titleContradictsCandidateCell`
 *         (extractYearFromTitle, inferSetKeyFromTitle+productAncestry);
 *     (e) the title does not NAME AN IDENTITY MORE SPECIFIC than the
 *         candidate itself -- `titleNamesMoreSpecificThanCandidate` (below):
 *         a named parallel/insert/variation the candidate's own checklist row
 *         does not carry means "absent beats wrong" cuts the OTHER way here,
 *         and this candidate fails rather than winning by the other side's
 *         elimination (coordinator review of #2381, HIGH -- a checklist row
 *         merely MISSING for the true, more-specific identity must never let
 *         a generic BASE identity win by default: "2025 Topps Chrome Update
 *         Cal Raleigh Image Variation SSP #USC45", "Adley Rutschman 2023
 *         Topps #250 Image Variation RC" and "2025 Panini Donruss - DOWNTOWN
 *         Tyler Shough #19" all measured resolving to plain base before this
 *         gate existed);
 *   AND the OTHER side fails (a)-(e). BOTH sides' OWN titles are checked
 *   (coordinator review of #2381, MEDIUM -- a candidate must clear every
 *   gate against EACH side's independently-populated `title` field, not just
 *   the short row's), and both directions are tried (long-wins-over-short
 *   and short-wins-over-long); whichever side alone clears every gate is the
 *   winner.
 *
 *   RULE 2 -- BOTH SIDES CHECKLIST-BACKED: the MORE SPECIFIC wins, ONLY when
 *   it strictly REFINES the other -- `moreSpecificRefines` below, composed
 *   from the SAME two derivation-stamp-input readers `titleContradictsTarget`
 *   already calls (`statedFinishFromChecklist`, `parallelTheTitleAllows`),
 *   never a new comparator and never an edit to either stamp input:
 *     - same card number (`sameCardNumber`) and same isAuto flag on both
 *       identities (`parseHobbyIqCardId` -- hobbyIqCardId.service.ts, a
 *       READ-ONLY call, not an edit, of a declared stamp input);
 *     - the LOSING side's own parallel segment is `base` or blank
 *       (`normParallelForRung`, the same case-insensitive human-form compare
 *       resolve-split-identity-parks.cjs and the sibling lanes already use);
 *     - on EITHER side's own title, `statedFinishFromChecklist(title,
 *       {setKey, year})` returns a finish whose words are a SUBSET of the
 *       winner's own parallel words (never the reverse: the title may say
 *       less than the checklist's full name, it may never say a DIFFERENT
 *       one -- see the inline `titleNamesWinner` check inside
 *       `moreSpecificRefines`), AND
 *     - NEITHER title names something MORE SPECIFIC than the winner itself
 *       (an insert, a print run, a finer variation tier the winner's own row
 *       does not carry -- `titleNamesMoreSpecificThanCandidate`, the SAME
 *       named-card gate rule 1 applies).
 *   Otherwise (both checklist-backed, neither refines the other, or a title
 *   names the winner's words but ALSO names something more specific) the
 *   pair is LEFT `both-sides-valid` -- never guessed past by richness or
 *   length.
 *
 *   RULE 3 -- GRADE axis. The side whose grade fields agree with a grader
 *   TOKEN in EITHER title wins -- `parseGradeFromTitle` (gradeParser.ts, repo
 *   doctrine "grade from grader token only": a numeral counts only when it
 *   follows PSA/BGS/SGC/CGC/CSG/HGA/... literally in the title, never an
 *   adjective or a card number). A side wins when its `gradeKeyOf` (the SAME
 *   raw-is-a-grade-too key collapse-ch-synthetic-twins.cjs already uses)
 *   equals the title's parsed (company, value); the other side must NOT
 *   equal it. When the two titles state DIFFERENT grader tokens (coordinator
 *   review of #2381, MEDIUM), or neither side's grade matches the token found
 *   (or neither title carries one at all), the pair is LEFT
 *   `neither-side-backed`.
 *
 * (2) NEITHER PASSES rule 1 -> LEFT `neither-side-backed`, named and counted
 * (a hobbyiqCardId axis pair that clears neither checklist+roster gate falls
 * through to a rule-2 attempt only when BOTH sides at least resolve to SOME
 * strict checklist row; when a side resolves to none at all it cannot ever
 * win rule 1 or rule 2, and if the OTHER side also cannot, the pair is
 * `neither-side-backed`).
 *
 * ACTION on a decided pair. The SHORT canonical-id row is ALWAYS the kept
 * document address (same KEEP RULE as the sweep lane: every OTHER writer
 * produces the short shape, and a future backfill re-derives it). When the
 * winner is the SHORT side's own identity, this is the sweep lane's ordinary
 * collapse (`decideSyntheticTwin`'s ordinary `collapse` path is reused
 * outright once the disagreement is resolved in the short row's favour).
 * When the winner is the LONG side's identity, the short row's ENTIRE
 * identity field family (cardId, hobbyiqCardId, sport, cardYear, cardNumber,
 * parallel, isAuto, playerName -- or the three grade fields, for a grade-axis
 * win) is overwritten TOGETHER with the winner's OWN values (coordinator
 * review of #2381, HIGH: production previously overwrote hobbyiqCardId alone,
 * leaving every OTHER identity field at the losing identity and never
 * recomputing `contentHash` -- never folded, a fold only fills what is
 * MISSING and this is a correction of a value that is PRESENT but wrong)
 * before the short row is kept and the long row is dropped. `contentHash` is
 * recomputed against the NEW identity (`contentHashOf`, mirroring
 * repoint-sales-to-sibling-product.cjs's own `keep.contentHash =
 * contentHashOf(keep)` after any identity change) and the result is run
 * through `guardSoldCompDoc` before it is ever handed to the write path, in
 * REPORT as in APPLY, so a malformed winning identity parks rather than
 * writing silently. A cardId change is a RELOCATION (the pool partitions on
 * /cardId), so this goes through `relocateSoldComp`
 * (scripts/lib/relocate-sold-comp.cjs) exactly as the sweep lane's own
 * collapse does -- upsert the corrected short-shaped document, verify the
 * read-back, THEN delete the long row with a plan-time `ifMatchEtag`
 * (split-row guard #2339's own conditional-delete mechanism). A ledger field
 * `twinResolved: {at, by, winner, loser, rule}` -- ONE object, one Cosmos
 * field -- is stamped on the kept document (Cosmos's patch op cap is 10;
 * this lane never patches at all, it goes through the SAME full-doc upsert
 * path relocateSoldComp already uses, so the cap does not apply, but
 * the ledger is still kept to ONE field by convention with every other D19
 * repair stamp).
 *
 * NEVER TOUCHED: `isProtected` (verifiedByUser/flaggedWrong/excludedFromFmv/
 * pinned) or `isParkedSide` (identityUnverified) on EITHER side -- imported
 * from collapse-ch-synthetic-twins.cjs, not re-implemented, checked BEFORE
 * any evidence is weighed, exactly as that lane checks them before its own
 * proof predicate runs.
 *
 * NO DERIVATION-STAMP INPUT IS EDITED. hobbyIqCardId.service.ts (one of the
 * six -- scripts/lib/derivation-version.cjs's DERIVATION_INPUTS) is a
 * read-only import here: `parseHobbyIqCardId`, `sameCardNumber`. Every reader
 * this file composes is ALREADY SHIPPED and CALLED, never re-derived at the
 * parsing layer -- only the ORCHESTRATION (which reader runs when, in what
 * order) is written here, the same discipline repoint-sales-to-sibling-
 * product.cjs's own `titleContradictsTarget` documents for why IT is not a
 * second parser.
 *
 * SHARD/BUDGET/RELAUNCH/PLAN_OUT: identical machinery to
 * collapse-ch-synthetic-twins.cjs -- partition walk by CH card id (the SAME
 * population query, restricted to pairs that decide `twins-disagree`),
 * runner-shard-scope.cjs, runner-budget.cjs's finishLane, bounded pages
 * (maxItemCount 500, never -1), the `stopped at the ${RUN_MINUTES}-minute
 * budget` marker the runner's relaunch step greps, and a full PLAN_OUT NDJSON
 * (one record per pair: both ids, both identities, winner, rule, title,
 * evidence rows' sources) -- copied because a REPORT that only lives in a
 * capped banner cannot be audited row by row before the matching APPLY runs.
 * Catalog lookups (the checklist rows behind each side's hobbyiqCardId) are
 * cached per hiq: id prefix with a row-budgeted LRU (CATALOG_CACHE_MAX
 * entries) -- never a cross-partition aggregate, never re-fetched per pair
 * once a (sport, year, setKey) cell has been loaded once in this run.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true / APPLY=true to write
 *      (default report only); SLOT/SLOTS (sha1(cardId) shards, opt-in via a
 *      non-zero SLOT or SHARD=true for slot 0 of a real fan-out --
 *      runner-shard-scope.cjs); RUN_MINUTES=120; RESERVE_MS=90000;
 *      VERIFY_MS=600000; LIMIT (CH partitions scanned; 0 = all); PLAN_OUT
 *      (NDJSON directory, set by the runner, not an operator input);
 *      CATALOG_CACHE_MAX=20000 (per-cell checklist row cache ceiling).
 * Requires dist/ (catalogAuthorityOf, playerIdentityKey, parseGradeFromTitle,
 *      parseHobbyIqCardId/sameCardNumber/slugify, statedFinishFromChecklist,
 *      parallelTheTitleAllows, playerTheTitleAllows, extractCardNumberFromTitle/
 *      extractPrintRunFromTitle, cleanPlayerName, readVariationFromTitle,
 *      insertSetNamedInTitle, isRegisteredProduct, productAncestry,
 *      inferSetKeyFromTitle, extractYearFromTitle, guardSoldCompDoc,
 *      reportWrites, splitIdentityWriteGuard via relocate-sold-comp.cjs's own
 *      lazy dist load) plus scripts/collapse-ch-synthetic-twins.cjs and
 *      scripts/lib/rematch-classify.cjs (isStrictChecklistSource --
 *      consulted alongside catalogAuthorityOf, see isChecklistBacked below
 *      for why both are asked).
 */
"use strict";
const path = require("path");
const fs = require("node:fs");
const crypto = require("crypto");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");

const {
  relocateSoldComp, stripSystem, isMissing, cents, foldMissing, contentHashOf,
} = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));
// THE SWEEP LANE'S OWN PROOF PREDICATE + GATES -- imported, never
// re-implemented, per the task's own instruction.
const SWEEP = require(path.join(__dirname, "collapse-ch-synthetic-twins.cjs"));
const { decideSyntheticTwin, isProtected, isParkedSide, gradeKeyOf, parseLongSyntheticId, isCanonicalChDailyId } = SWEEP;
// isStrictChecklistSource: a plain .cjs, no dist/ needed.
const { isStrictChecklistSource } = require(path.join(__dirname, "lib", "rematch-classify.cjs"));

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true"; // the runner exports BACKFILL_APPLY, not APPLY
const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "resolve-disagreeing-sale-twins" });
const { SLOT, SLOTS } = SHARD_SCOPE;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
/** Wall clock a single unit (one CH partition) may still be granted after
 *  the budget expires. CHECKED BEFORE EACH UNIT, never at the loop top. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);
const PLAN_OUT = String(process.env.PLAN_OUT || "").trim();
/** Row-budgeted LRU ceiling for the per-cell checklist cache -- never an
 *  unbounded map over a long run. */
const CATALOG_CACHE_MAX = Number(process.env.CATALOG_CACHE_MAX || 20000);
// OWNER RULING (2026-09-21) OPT-IN. Rides the EXISTING `TITLES` runner env
// (no new workflow_dispatch input) -- a `;`-separated token list, same
// convention resolve-split-identity-parks.cjs's own parseTitlesInput uses
// for exclude-winner:/exclude-id:. Absent the literal token
// "rule:named-and-specific" (case-insensitive, whitespace-trimmed),
// resolveBothSidesValidByRule is NEVER attempted and every both-sides-valid
// pair keeps today's byte-for-byte default behaviour (left, untouched).
const NAMED_AND_SPECIFIC_TOKEN = "rule:named-and-specific";
const NAMED_AND_SPECIFIC_OPT_IN = String(process.env.TITLES ?? "")
  .split(";").map((s) => s.trim().toLowerCase()).includes(NAMED_AND_SPECIFIC_TOKEN);
const f = (n) => Number(n ?? 0).toLocaleString();
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
// THROTTLE COUNT (coordinator report on run 35578577288, speed finding --
// mirrors fold-catalog-duplicate-rungs.cjs's own throttleStats byte-for-byte).
// sold_comps is SHARED with production pricing reads, so every retried call
// (429/503/timeout, through this ONE shared retry() wrapper) is
// production-relevant contention this lane caused; module-scope so `retry`
// (also module-scope, called before any partition-local closure exists) can
// increment it, and exported below for white-box testing of the throttle-drop
// mechanism without paying real retry() backoff delays.
const throttleStats = { count: 0, droppedTo2: false };
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; throttleStats.count++; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };

// ── pure ───────────────────────────────────────────────────────────────────

const normParallelForRung = (p) => String(p ?? "").trim().toLowerCase().replace(/\s+/g, " ") || "base";
const normNumber = (n) => String(n ?? "").trim().toLowerCase();

// soldCompsStore.service.ts's own module-private USER_SEED_SOURCES literal,
// byte-for-byte copied -- same discipline resolve-split-identity-parks.cjs,
// repoint-sales-to-sibling-product.cjs and fold-catalog-duplicate-rungs.cjs
// already keep in sync by inspection (not exported, so no import is
// possible). This lane's own population is source='cardhedge' only (never a
// user-seed source today), but the OWNER RULING names user-seed rows
// explicitly among "never flag" cases, so this is checked defensively.
const USER_SEED_SOURCES = new Set(["ebay-user-purchase", "ebay-user-sale", "manual-user-entry", "user-verified"]);

// ── RESUME CURSOR (coordinator report on run 35589416039: a REPORT relaunch
// restarts from zero and loops forever). Copies fold-catalog-duplicate-
// rungs.cjs's own convention byte-for-byte: hop*1,000,000 + offset, riding the
// EXISTING `scan_limit` dispatch input (no new one). Module-scope and pure so
// a test can pin the encode/decode round-trip without any Cosmos or clock.
const RESUME_HOP_UNIT = 1_000_000;
/** Hops after which this chain ABORTS rather than relaunching again -- APPLY
 *  has no offset to rely on for termination (it rescans every hop), so a
 *  population that somehow never converges must not relaunch forever on the
 *  hop counter alone. */
const MAX_RESUME_HOPS = 30;
// REVIEW FIX (coordinator, PR #2391 review): the OWNER RULING opt-in
// (NAMED_AND_SPECIFIC_OPT_IN) is now folded INTO the resume cursor's own
// signature, well above the hop range -- 100 * RESUME_HOP_UNIT
// (100,000,000), deliberately more than 3x MAX_RESUME_HOPS's own
// hop*RESUME_HOP_UNIT ceiling (30 * 1,000,000 = 30,000,000) so encoding the
// EXACT boundary hop value (MAX_RESUME_HOPS itself, which the hop-cap test
// below exercises on purpose) can never collide with the rule bit's own
// unit. A cursor minted by a rule-OFF run carries ruleBit=0; a rule-ON run
// carries ruleBit=1. decodeResume returns the decoded ruleBit; the CALLER
// (main(), the only place that knows the CURRENT run's own
// NAMED_AND_SPECIFIC_OPT_IN) compares it against that live value -- a
// mismatch means this cursor was minted under a DIFFERENT rule state than
// the run about to consume it, and resuming it anyway would silently mix
// rule-on and rule-off outcomes across hops of what is supposed to be ONE
// chain's own consistent scan. The caller treats a mismatch exactly like an
// absent/zero cursor: hop 0, offset 0 -- a fresh restart, never a silent
// carry-forward of the wrong rule state.
const RESUME_RULE_UNIT = 100 * RESUME_HOP_UNIT;
function decodeResume(raw) {
  const v = Math.max(0, Math.floor(Number(raw || 0)) || 0);
  const ruleBit = Math.floor(v / RESUME_RULE_UNIT) % 2;
  const withinRule = v % RESUME_RULE_UNIT;
  return { hop: Math.floor(withinRule / RESUME_HOP_UNIT), offset: withinRule % RESUME_HOP_UNIT, ruleBit };
}
const encodeResume = ({ hop, offset, ruleBit }) => (ruleBit ? RESUME_RULE_UNIT : 0) + hop * RESUME_HOP_UNIT + offset;

/**
 * THE STRICT-CHECKLIST TEST. Both readers are consulted, not one, because
 * they are populated from two independent tables (STRICT_CHECKLIST_SOURCES
 * in rematch-classify.cjs vs the regex+DERIVED/VENDOR ladder in
 * catalogAuthority.service.ts) that have drifted apart before -- a row whose
 * `source` either one recognises as strict is treated as strict here, so this
 * lane never manufactures a false `neither-side-backed` off a table gap that
 * is itself a different lane's bug to close.
 */
function isChecklistBacked(source) {
  return isStrictChecklistSource(source) || SWEEP_DEPS.catalogAuthorityOf(source) === "checklist";
}

/** Multi-player catalog rows are ONE string listing every name -- split on
 *  the D33 separators, same as repoint-sales-to-sibling-product.cjs's own
 *  catalogRowPlayerKeys. */
function catalogRowPlayerKeys(playerIdentityKeyFn, playerName) {
  const raw = String(playerName ?? "");
  const keys = new Set();
  for (const part of raw.split(/\s*[/&]\s*/)) {
    const k = playerIdentityKeyFn(part);
    if (k) keys.add(k);
  }
  return keys;
}

/** THE ROSTER DECIDES: does the sale's player match ANY name the checklist
 *  row lists? */
function playerMatchesRow(playerIdentityKeyFn, salePlayer, rowPlayer) {
  const saleKey = playerIdentityKeyFn(salePlayer ?? "");
  if (!saleKey) return false;
  return catalogRowPlayerKeys(playerIdentityKeyFn, rowPlayer).has(saleKey);
}

/**
 * Split a `hiq:` slug's segments without editing hobbyIqCardId.service.ts --
 * this is `parseHobbyIqCardId` itself, re-exported through SWEEP_DEPS so the
 * pure functions in this file stay dependency-injected and testable without
 * a dist/ build (mirrors collapse-ch-synthetic-twins.cjs's own pattern of
 * keeping every pure decision free of a live `require`).
 */
function catalogPrefixFor(hiqId) {
  const parsed = SWEEP_DEPS.parseHobbyIqCardId(String(hiqId ?? ""));
  if (!parsed) return null;
  // REVIEW FIX (coordinator, PR #2391 review): the slug's OPTIONAL `sub-`
  // segment (hobbyIqCardId.service.ts's own CF-A-SUBSET-IS-PART-OF-THE-
  // IDENTITY-WHEN-IT-HAS-TO-BE) was DROPPED here, even though
  // parseHobbyIqCardId returns it -- two ids whose ONLY difference is the
  // subset (e.g. "sub-cards-that-never-were" vs "sub-johnson-reprints" at
  // the SAME card number) were indistinguishable from a base-vs-named-
  // parallel pair downstream, which R1 would then wrongly flag as a
  // base/named SAME-card disagreement. Carried through explicitly (null
  // when absent, never "" or "base" -- a blank subset means "no clash flag
  // at all", a DIFFERENT state from a named subset, and must never
  // silently equal it).
  return { sport: parsed.sport, year: parsed.year, setKey: parsed.setKey, cardNumber: parsed.cardNumber, parallel: parsed.parallel, isAuto: parsed.isAuto, printRun: parsed.printRun ?? null, subsetName: parsed.subsetName ?? null };
}

/**
 * THE NAMED-CARD GATE (coordinator review of #2381, HIGH). A candidate side
 * may only win when the sale's title does not NAME an identity MORE SPECIFIC
 * than that side's own -- "absent beats wrong" cuts both ways: a checklist
 * row that is merely MISSING for the true (more specific) identity must never
 * let a generic BASE identity win by default, because the title itself is
 * already the evidence that the sale is not base.
 *
 * MEASURED (owner's real-data trial, 320 pairs): three resolutions collapsed
 * a named variation/insert onto plain base --
 *   "2025 Topps Chrome Update Cal Raleigh Image Variation SSP #USC45" -> base
 *   "Adley Rutschman 2023 Topps #250 Image Variation RC" -> base
 *   "2025 Panini Donruss - DOWNTOWN Tyler Shough #19" -> base
 * -- in every case the WINNING side's checklist row was simply absent for the
 * named variation/insert, and rule 1/2 let the OTHER (base) side win by
 * elimination rather than refusing on the title's own evidence.
 *
 * Four independent readers, each already shipped and called elsewhere in
 * this repo, ORed together (a title tripping ANY one of them is enough):
 *   - `readVariationFromTitle` (variationVocabulary.ts) -- STRONG reads only
 *     (Image Variation, Image Variation SSP, "SP-CHROME" label forms, named
 *     kinds). A WEAK marker alone (bare "SP"/"IV" out of context) is
 *     deliberately NOT gated on here -- that file's own doctrine is "reported
 *     for the seam to corroborate against the checklist, never guessed", and
 *     this gate has no checklist row to corroborate a weak marker against.
 *   - `insertSetNamedInTitle` (insertSetTitleReader.ts), scoped to the
 *     CANDIDATE's own (sport, year, setKey) -- an insert set the title names,
 *     REGISTERED or not (an unregistered match is still evidence the sale is
 *     not base, even though this lane cannot address it; see that function's
 *     own "R70 park signal" doctrine). ALSO tried under the candidate's bare
 *     brand root (`panini-` stripped) when that root is independently
 *     `isRegisteredProduct` -- Panini's own corpus sometimes files an insert
 *     under the bare manufacturer word for a family that is ALSO registered
 *     under its own `panini-` spelling (measured: Donruss "Downtown" is
 *     indexed under bare `donruss`, not `panini-donruss`) -- a narrow,
 *     table-free widening of WHICH KEY to query, never a guess about which
 *     product the card belongs to.
 *   - `statedFinishFromChecklist` naming a parallel that is NOT a subset of
 *     the candidate's own parallel words (the same subset test
 *     `moreSpecificRefines` already applies, inverted: if it fails there, the
 *     title names something the CANDIDATE itself does not carry).
 *   - `extractPrintRunFromTitle` finding a print-run fraction ("/25") while
 *     the candidate identity carries none -- a numbered parallel the
 *     candidate's own slug does not reflect.
 *
 * Returns `{ moreSpecific: false }` when the title names nothing the
 * candidate does not already carry, or `{ moreSpecific: true, evidence }`
 * naming which reader tripped.
 */
function titleNamesMoreSpecificThanCandidate(deps, sale, candidateParsed, candidateRow) {
  const title = String(sale.title ?? "");
  if (!title.trim() || !candidateParsed) return { moreSpecific: false };

  const variation = deps.readVariationFromTitle(title.toLowerCase());
  if (variation.finish) {
    const candidateParallelWords = normParallelForRung(candidateRow?.parallel ?? candidateParsed.parallel).split(/\s+/).filter(Boolean);
    const variationWords = normParallelForRung(variation.finish).split(/\s+/).filter(Boolean);
    const candidateAlreadyNamesIt = variationWords.every((w) => candidateParallelWords.includes(w));
    if (!candidateAlreadyNamesIt) {
      return { moreSpecific: true, evidence: `title states a variation ("${variation.finish}") the candidate identity (parallel="${candidateRow?.parallel ?? candidateParsed.parallel ?? "base"}") does not carry` };
    }
  }

  const insertCandidates = new Set([candidateParsed.setKey]);
  const bareBrand = String(candidateParsed.setKey ?? "").replace(/^panini-/, "");
  if (bareBrand && bareBrand !== candidateParsed.setKey && deps.isRegisteredProduct(bareBrand)) insertCandidates.add(bareBrand);
  for (const setKey of insertCandidates) {
    const inserts = deps.insertSetNamedInTitle({ title, sport: candidateParsed.sport, year: candidateParsed.year, setKey, playerName: sale.playerName });
    if (inserts.length) {
      return { moreSpecific: true, evidence: `title names insert set "${inserts.map((m) => m.root).join(", ")}" under ${setKey}, which the candidate identity (setKey=${candidateParsed.setKey}) does not carry` };
    }
  }

  const titleFinish = deps.statedFinishFromChecklist(title, { setKey: candidateParsed.setKey, year: candidateParsed.year });
  if (titleFinish) {
    const candidateParallelWords = normParallelForRung(candidateRow?.parallel ?? candidateParsed.parallel).split(/\s+/).filter(Boolean);
    const titleWords = normParallelForRung(titleFinish).split(/\s+/).filter(Boolean);
    const candidateAlreadyNamesIt = titleWords.length > 0 && titleWords.every((w) => candidateParallelWords.includes(w));
    if (!candidateAlreadyNamesIt) {
      return { moreSpecific: true, evidence: `title states a parallel ("${titleFinish}") the candidate identity (parallel="${candidateRow?.parallel ?? candidateParsed.parallel ?? "base"}") does not carry` };
    }
  }

  // PRINT RUN (coordinator delta review of #2381: catalogPrefixFor used to
  // DROP `printRun` even though parseHobbyIqCardId returns it, so this check
  // fired on EVERY title stating "/N" -- even when the candidate's OWN slug
  // already carries the identical `:num-N` segment. Real pairs wrongly left
  // by that bug: Angel Cepeda black-refractor:auto:num-10 vs title "/10",
  // PPDAR-ARO /15, CPA-WT /150, PPAR-AB /75, AC-MM Green /99, BCP-243 /50 --
  // every one a CORRECT resolution the missing field turned into a false
  // "more specific" gate. The comparison is now EXACT:
  //   title states no /N at all           -> no print-run opinion (silence)
  //   title /N, candidate carries num-N    -> the SAME rung; not more specific
  //   title /N, candidate carries num-M
  //     (M != N)                           -> the candidate's OWN print run
  //                                          CONTRADICTS the title; that side
  //                                          fails just as surely as if it
  //                                          named a different parallel
  //   title /N, candidate carries no num-  -> the title states a numbered
  //                                          rung the candidate's slug does
  //                                          not reflect at all; more specific
  const titlePrintRun = deps.extractPrintRunFromTitle(title);
  if (titlePrintRun) {
    if (candidateParsed.printRun && Number(candidateParsed.printRun) === Number(titlePrintRun)) {
      // Exact match -- the candidate already IS this print run; silence.
    } else if (candidateParsed.printRun) {
      return { moreSpecific: true, evidence: `title states print run /${titlePrintRun}, candidate identity carries a DIFFERENT print run (/${candidateParsed.printRun}) -- contradicts, not merely under-specified` };
    } else {
      return { moreSpecific: true, evidence: `title states a print run (/${titlePrintRun}) the candidate identity does not carry` };
    }
  }

  return { moreSpecific: false };
}

/**
 * THE YEAR/PRODUCT CROSS-CHECK (coordinator review of #2381, HIGH). The
 * title's own stated year (`extractYearFromTitle`) and inferred product
 * (`inferSetKeyFromTitle` + `productAncestry`) must not CONTRADICT the
 * candidate's own cell -- a candidate whose year or product the title itself
 * disagrees with fails, regardless of how well its checklist row otherwise
 * matches. Silence (the title states neither) is never a contradiction.
 */
function titleContradictsCandidateCell(deps, sale, candidateParsed) {
  const title = String(sale.title ?? "");
  if (!title.trim() || !candidateParsed) return { contradicts: false };

  const titleYear = deps.extractYearFromTitle(title);
  if (titleYear && Number(titleYear) !== Number(candidateParsed.year)) {
    return { contradicts: true, detail: `title states year ${titleYear}, candidate cell is ${candidateParsed.year}` };
  }

  const inferred = deps.inferSetKeyFromTitle(title, candidateParsed.cardNumber ?? undefined);
  const titleSetKey = inferred && inferred !== "Unknown" ? deps.slugify(inferred) : "";
  if (titleSetKey && titleSetKey !== candidateParsed.setKey) {
    const ancestry = deps.productAncestry(candidateParsed.setKey);
    const titleAncestry = deps.productAncestry(titleSetKey);
    // Silence, not a contradiction, whenever either key sits on the other's
    // own ancestry chain (an ancestor names less than the candidate; a
    // registered child of the candidate is a specialization of it, not a
    // rival) -- the SAME directional reading repoint-sales-to-sibling-
    // product.cjs's own titleNamesFromProduct already applies.
    const agrees = ancestry.includes(titleSetKey) || titleAncestry.includes(candidateParsed.setKey);
    if (!agrees && deps.isRegisteredProduct(titleSetKey)) {
      return { contradicts: true, detail: `title infers product "${inferred}" (${titleSetKey}), which is neither the candidate's own product (${candidateParsed.setKey}) nor on its ancestry chain` };
    }
  }

  return { contradicts: false };
}

/**
 * RULE 1's per-side evaluation: does `hiqId` resolve to a STRICT checklist
 * row (any parallel, same card number) whose roster names `salePlayer`, and
 * does the title not contradict that row -- OR name something MORE SPECIFIC
 * than it? Returns the winning row or null. `checklistRowsForNumber` is a
 * Map<normNumber, row[]> the caller preloaded once per (sport, year, setKey)
 * cell. `sale` here is whichever SIDE's own document the caller is evaluating
 * titles from (both are tried by the caller -- see
 * evaluateHobbyiqCardIdSideBothTitles).
 */
function evaluateHobbyiqCardIdSide(deps, hiqId, sale, checklistRowsByNumber) {
  const parsed = catalogPrefixFor(hiqId);
  if (!parsed || !parsed.cardNumber) return { row: null, reason: "unparseable-slug" };
  const num = normNumber(parsed.cardNumber);
  const candidates = (checklistRowsByNumber.get(num) ?? []).filter((r) => isChecklistBacked(r.source));
  if (!candidates.length) return { row: null, reason: "no-strict-checklist-row" };
  const rosterRows = candidates.filter((r) => playerMatchesRow(deps.playerIdentityKey, sale.playerName, r.playerName));
  if (!rosterRows.length) return { row: null, reason: "roster-does-not-name-player" };
  const nonContradicted = rosterRows.filter((r) => !deps.titleContradictsTarget(sale, r).contradicts);
  if (!nonContradicted.length) return { row: null, reason: "title-contradicts-every-candidate-row" };
  const cellOk = nonContradicted.filter((r) => !titleContradictsCandidateCell(deps, sale, parsed).contradicts);
  if (!cellOk.length) return { row: null, reason: "title-contradicts-candidate-cell" };
  const notMoreSpecific = cellOk.filter((r) => !titleNamesMoreSpecificThanCandidate(deps, sale, parsed, r).moreSpecific);
  if (!notMoreSpecific.length) {
    const evidence = titleNamesMoreSpecificThanCandidate(deps, sale, parsed, cellOk[0]).evidence;
    return { row: null, reason: "title-names-a-more-specific-card", evidence };
  }
  return { row: notMoreSpecific[0], reason: "ok" };
}

/**
 * Evaluate a candidate hobbyiqCardId against BOTH sides' own titles
 * (coordinator review of #2381, MEDIUM) -- production previously hardcoded
 * `sale = short`, so a genuine contradiction visible only on the LONG row's
 * own independently-populated `title` field was invisible whenever the SHORT
 * row's title happened to look silent or agreeable. A candidate now wins only
 * when it clears `evaluateHobbyiqCardIdSide` against EACH side's own title
 * (player name likewise: each side's own `playerName`, not a splice) --  a
 * contradiction OR a more-specific-card read surfaced by EITHER title/player
 * pairing is enough to fail the candidate.
 */
function evaluateHobbyiqCardIdSideBothTitles(deps, hiqId, long, short, checklistRowsByNumber) {
  const viaLong = evaluateHobbyiqCardIdSide(deps, hiqId, long, checklistRowsByNumber);
  if (!viaLong.row) return viaLong;
  const viaShort = evaluateHobbyiqCardIdSide(deps, hiqId, short, checklistRowsByNumber);
  if (!viaShort.row) return viaShort;
  return viaShort;
}

/**
 * RULE 2: does `winnerParsed` STRICTLY REFINE `loserParsed`? Same card
 * number, same isAuto, the loser's own parallel is base/blank, and the
 * sale's title NAMES the winner's parallel words (never the reverse -- a
 * title may say less than the checklist's full name, never a DIFFERENT one).
 * `winnerRow`/`loserRow` are the checklist rows evaluateHobbyiqCardIdSide
 * already proved for each side (both must be checklist-backed for rule 2 to
 * even be attempted -- the caller enforces that before calling this).
 *
 * BOTH titles are checked (coordinator review of #2381, MEDIUM/HIGH):
 * refinement requires the title (on EITHER side's own document) to name the
 * winner's words, and must NOT (on either title) name something even MORE
 * specific than the winner -- the same named-card gate rule 1 applies, so a
 * refinement can never mint an under-specified named-card resolution either.
 */
function moreSpecificRefines(deps, long, short, winnerParsed, winnerRow, loserParsed) {
  if (!winnerParsed || !loserParsed) return { refines: false, reason: "unparseable-slug" };
  if (!deps.sameCardNumber(winnerParsed.cardNumber, loserParsed.cardNumber)) return { refines: false, reason: "different-card-number" };
  if (winnerParsed.isAuto !== loserParsed.isAuto) return { refines: false, reason: "different-auto-flag" };
  const loserParallel = normParallelForRung(loserParsed.parallel);
  if (loserParallel !== "base" && loserParallel !== "") return { refines: false, reason: "loser-parallel-is-not-base-or-blank" };
  const winnerParallelWords = normParallelForRung(winnerRow?.parallel ?? winnerParsed.parallel).split(/\s+/).filter(Boolean);
  if (!winnerParallelWords.length) return { refines: false, reason: "winner-names-no-parallel-either" };

  let anyTitleNamesWinner = false;
  for (const sale of [short, long]) {
    const titleFinish = deps.statedFinishFromChecklist(String(sale.title ?? ""), { setKey: winnerParsed.setKey, year: winnerParsed.year });
    if (titleFinish) {
      const titleWords = new Set(normParallelForRung(titleFinish).split(/\s+/).filter(Boolean));
      // The title's stated words must be a SUBSET of the winner's own
      // parallel words -- the title may under-state ("Refractor" on a "Blue
      // Refractor" winner), it may never name a THIRD, different parallel.
      const titleNamesWinner = [...titleWords].every((w) => winnerParallelWords.includes(w)) && titleWords.size > 0;
      if (!titleNamesWinner) return { refines: false, reason: "title-names-a-different-parallel-than-the-winner" };
      anyTitleNamesWinner = true;
    }
    // Named-card gate, rule 2's own half: neither title may name something
    // MORE specific than the winner either (an insert, a print run, a finer
    // variation tier the winner's own row does not carry) -- checked on
    // BOTH titles regardless of whether this one stated a parallel.
    const moreSpecific = titleNamesMoreSpecificThanCandidate(deps, sale, winnerParsed, winnerRow);
    if (moreSpecific.moreSpecific) return { refines: false, reason: `title-names-a-more-specific-card: ${moreSpecific.evidence}` };
  }
  if (!anyTitleNamesWinner) return { refines: false, reason: "title-names-no-parallel" };
  return { refines: true, reason: "same-number-same-auto-loser-is-base-title-names-winner-parallel" };
}

/**
 * OWNER RULING (2026-09-21). Of the pairs `resolveHobbyiqCardIdDisagreement`
 * itself leaves `both-sides-valid` (both ids are strict-checklist-backed,
 * neither passes RULE 2's refinement test), two NARROW shapes are still
 * decidable on structure alone, no title evidence needed -- gated behind an
 * explicit opt-in (see TITLES parsing below), never run by default.
 *
 *   R1 -- BASE vs NAMED PARALLEL. The two ids differ ONLY in the parallel
 *   segment, one side's parallel is `base` (blank counts as base, same
 *   normParallelForRung the rest of this file already uses) and the other
 *   names something else; card number, setKey, year and isAuto are IDENTICAL
 *   on both sides. A `:num-N` print-run suffix on the NAMED side only is
 *   allowed (a numbered named parallel is still "the named side"); a print
 *   run on the BASE side, or DIFFERING print runs on both named sides, falls
 *   through to R2's own comparison (which requires the parallel to be
 *   IDENTICAL) and fails that too -- correctly left.
 *
 *   R2 -- AUTO/NUM-N AXIS ONLY. The two ids are identical on parallel,
 *   card number, setKey and year, and differ ONLY on isAuto and/or the
 *   `:num-N` print-run suffix. The MORE SPECIFIC side (auto=true, or a
 *   numbered print run present) wins WHEN IT IS MORE SPECIFIC ON BOTH AXES
 *   IT DIFFERS ON -- i.e. the other side is never itself more specific on a
 *   DIFFERENT axis (one auto-but-unnumbered vs the other numbered-but-no-
 *   auto is a genuine cross-axis disagreement, left).
 *
 * Returns `{ verdict:"flagged", rule:"base-vs-named-parallel"|"auto-or-num-specificity",
 * keeper:"long"|"short", detail }` or `{ verdict:"left" }` -- this function
 * NEVER decides EXCLUSION eligibility on protected/parked state (the caller
 * already refused those pairs before RULE 1/2 ever ran; this is purely the
 * structural axis test).
 */
function resolveBothSidesValidByRule(longParsed, shortParsed) {
  if (!longParsed || !shortParsed) return { verdict: "left" };
  if (!deps_sameCardNumberOk(longParsed, shortParsed)) return { verdict: "left" };
  if (String(longParsed.setKey) !== String(shortParsed.setKey)) return { verdict: "left" };
  if (Number(longParsed.year) !== Number(shortParsed.year)) return { verdict: "left" };
  // REVIEW FIX (coordinator, PR #2391 review): the subset segment is part of
  // the identity whenever it is present at all (hobbyIqCardId.service.ts's
  // own CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE) -- two ids
  // sharing card number/setKey/year but naming DIFFERENT subsets (or one
  // named, one not) are DIFFERENT CARDS, never a base-vs-named-parallel or
  // auto/num-N pair on the SAME card. Required equal for BOTH R1 and R2 --
  // null (no clash flag) only equals null, never a named subset string.
  if (String(longParsed.subsetName ?? "") !== String(shortParsed.subsetName ?? "")) return { verdict: "left" };

  const longParallel = normParallelForRung(longParsed.parallel);
  const shortParallel = normParallelForRung(shortParsed.parallel);
  const longIsBase = longParallel === "base";
  const shortIsBase = shortParallel === "base";

  // ── R1: base vs named parallel -- same auto flag REQUIRED (an auto/no-auto
  // difference alongside a parallel difference is TWO axes moving at once,
  // never this rule's population -- left for a human).
  if (longParsed.isAuto === shortParsed.isAuto && longIsBase !== shortIsBase) {
    const namedSide = longIsBase ? "short" : "long";
    const baseSide = longIsBase ? "long" : "short";
    const namedParsed = namedSide === "long" ? longParsed : shortParsed;
    const baseParsed = baseSide === "long" ? longParsed : shortParsed;
    // A print-run suffix is allowed on the NAMED side only -- the base side
    // must carry none (a numbered BASE identity is itself a more specific
    // claim this rule does not adjudicate).
    if (baseParsed.printRun) return { verdict: "left" };
    return {
      verdict: "flagged", rule: "base-vs-named-parallel", keeper: namedSide,
      detail: `ids differ only in the parallel segment (named="${namedParsed.parallel}" vs base) -- named copy keeps pricing, base copy excluded`,
    };
  }

  // ── R2: auto/num-N axis only -- parallel and everything else IDENTICAL.
  if (longParallel === shortParallel) {
    const longAuto = Boolean(longParsed.isAuto), shortAuto = Boolean(shortParsed.isAuto);
    const longNum = longParsed.printRun ? Number(longParsed.printRun) : null;
    const shortNum = shortParsed.printRun ? Number(shortParsed.printRun) : null;
    const autoDiffers = longAuto !== shortAuto;
    const numDiffers = (longNum !== null) !== (shortNum !== null);
    if (!autoDiffers && !numDiffers) return { verdict: "left" }; // no disagreement on either axis -- not this rule's population
    // Cross-axis disagreement: one side more specific on auto, the OTHER
    // more specific on num -- neither is strictly more specific; left.
    const longMoreSpecificAuto = longAuto && !shortAuto;
    const shortMoreSpecificAuto = shortAuto && !longAuto;
    const longMoreSpecificNum = longNum !== null && shortNum === null;
    const shortMoreSpecificNum = shortNum !== null && longNum === null;
    const longWins = (longMoreSpecificAuto || (!autoDiffers)) && (longMoreSpecificNum || (!numDiffers)) && (longMoreSpecificAuto || longMoreSpecificNum);
    const shortWins = (shortMoreSpecificAuto || (!autoDiffers)) && (shortMoreSpecificNum || (!numDiffers)) && (shortMoreSpecificAuto || shortMoreSpecificNum);
    if (longWins && !shortWins) {
      return { verdict: "flagged", rule: "auto-or-num-specificity", keeper: "long", detail: `ids differ only on auto/print-run (long more specific: auto=${longAuto} num=${longNum ?? "none"} vs short auto=${shortAuto} num=${shortNum ?? "none"}) -- more specific copy keeps pricing` };
    }
    if (shortWins && !longWins) {
      return { verdict: "flagged", rule: "auto-or-num-specificity", keeper: "short", detail: `ids differ only on auto/print-run (short more specific: auto=${shortAuto} num=${shortNum ?? "none"} vs long auto=${longAuto} num=${longNum ?? "none"}) -- more specific copy keeps pricing` };
    }
    return { verdict: "left" }; // cross-axis (each more specific on a DIFFERENT axis) or neither strictly dominates
  }

  return { verdict: "left" };
}
/** sameCardNumber is a real dist/-authored predicate elsewhere in this file;
 *  this rule only needs a structural, dependency-free equality (both parsed
 *  objects already came off the SAME parseHobbyIqCardId reader), so it
 *  compares the parsed cardNumber strings case-insensitively rather than
 *  pull a live dep into a function that must stay pure/dependency-free for
 *  the caller's own resolveHobbyiqCardIdDisagreement to call it without a
 *  deps object. */
function deps_sameCardNumberOk(longParsed, shortParsed) {
  return String(longParsed.cardNumber ?? "").trim().toLowerCase() === String(shortParsed.cardNumber ?? "").trim().toLowerCase();
}

/**
 * REVIEW FIX (coordinator, PR #2391 review): isProtected/isParkedSide alone
 * are NOT the full set of fields the FMV readers themselves exclude a row
 * on -- exactPoolReader.ts's own WHERE clause (the exact-cell pool) and
 * soldCompsGradeReader.ts's own (the cross-grade pool) both ALSO refuse
 * `c.priceAnomaly = true`, which neither isProtected nor isParkedSide reads
 * (byte-for-byte from those two files' own predicate lists):
 *   exactPoolReader.ts:      priceAnomaly, flaggedWrong, excludedFromFmv,
 *                            identityUnverified (matched-by-hiq carve-out)
 *   soldCompsGradeReader.ts: flaggedWrong, excludedFromFmv, identityUnverified
 *     (soldCompsGradeReader.ts does not itself filter priceAnomaly, but a
 *     keeper flagged priceAnomaly is STILL excluded from the exact-cell
 *     pool above, which is reason enough on its own never to leave a flagged
 *     loser's sale priced ONLY through a keeper the exact pool itself
 *     already refuses to read -- the union of both readers' exclusion
 *     fields is what "the keeper actually prices" means here, not either
 *     reader alone).
 * A keeper failing ANY of these must never receive a flagged loser -- the
 * sale would price nowhere. Checked wherever isProtected/isParkedSide are
 * checked on the keeper (both the plan-time gate note and the pre-write
 * gate use this SAME function, so a keeper that becomes priceAnomaly
 * between plan and write is caught at the point closest to the actual
 * Cosmos write, not just once at plan time).
 */
function keeperExcludedFromPricing(doc) {
  return isProtected(doc) || isParkedSide(doc) || doc?.priceAnomaly === true;
}

/**
 * OWNER RULING write shape: the LOSING (plainer/base) copy is flagged
 * `excludedFromFmv: true`, never deleted or relocated -- a PATCH on the
 * loser's OWN existing (id, cardId) address, never a relocateSoldComp call
 * (there is no address change here at all). ONE object-valued ledger field
 * (`twinDisagreeExcluded: {at, to, from, by}`), same compact shape
 * resolve-split-identity-parks.cjs's own `splitResolved` uses, so a reader
 * already familiar with that stamp recognises this one on sight.
 *
 * Returns the JSON-Patch ops array for the loser doc -- 3 ops
 * (excludedFromFmv, excludedFromFmvReason, twinDisagreeExcluded), always
 * well under Cosmos's 10-op patch ceiling.
 */
function buildFlagExclusion(loser, keeper, rule, now) {
  return [
    { op: "set", path: "/excludedFromFmv", value: true },
    { op: "set", path: "/excludedFromFmvReason", value: `twin-disagree-${rule}` },
    {
      op: "set", path: "/twinDisagreeExcluded",
      value: { at: now, to: keeper.id, from: loser.id, by: "resolve-disagreeing-sale-twins" },
    },
  ];
}

/**
 * ONE disagreeing pair -> a resolution verdict. Pure, no I/O. Both sides'
 * OWN titles are consulted throughout (coordinator review of #2381, MEDIUM)
 * -- there is no single `sale` argument any more.
 *
 * @returns {{verdict:"resolved", winner:"long"|"short", rule:string, detail:string}
 *          | {verdict:"both-sides-valid"|"neither-side-backed", detail:string}}
 */
function resolveHobbyiqCardIdDisagreement(deps, long, short) {
  const longParsed = catalogPrefixFor(long.hobbyiqCardId);
  const shortParsed = catalogPrefixFor(short.hobbyiqCardId);
  const longRowsByNumber = deps.checklistRowsByNumber(longParsed);
  const shortRowsByNumber = deps.checklistRowsByNumber(shortParsed);
  const longEval = evaluateHobbyiqCardIdSideBothTitles(deps, long.hobbyiqCardId, long, short, longRowsByNumber);
  const shortEval = evaluateHobbyiqCardIdSideBothTitles(deps, short.hobbyiqCardId, long, short, shortRowsByNumber);

  const longOk = longEval.row !== null;
  const shortOk = shortEval.row !== null;

  // RULE 1: exactly one side clears checklist+roster+title(s)+named-card gate.
  if (longOk && !shortOk) return { verdict: "resolved", winner: "long", rule: "checklist-and-roster", detail: `long hobbyiqCardId=${long.hobbyiqCardId} resolves to a strict checklist row naming this player; short (${short.hobbyiqCardId}) fails: ${shortEval.reason}${shortEval.evidence ? ` (${shortEval.evidence})` : ""}`, winnerRow: longEval.row };
  if (shortOk && !longOk) return { verdict: "resolved", winner: "short", rule: "checklist-and-roster", detail: `short hobbyiqCardId=${short.hobbyiqCardId} resolves to a strict checklist row naming this player; long (${long.hobbyiqCardId}) fails: ${longEval.reason}${longEval.evidence ? ` (${longEval.evidence})` : ""}`, winnerRow: shortEval.row };

  // RULE 2: both sides checklist-backed -- try refinement in both directions.
  if (longOk && shortOk) {
    const longRefinesShort = moreSpecificRefines(deps, long, short, longParsed, longEval.row, shortParsed);
    if (longRefinesShort.refines) return { verdict: "resolved", winner: "long", rule: "more-specific-refines", detail: `long ${long.hobbyiqCardId} refines short ${short.hobbyiqCardId}: ${longRefinesShort.reason}`, winnerRow: longEval.row };
    const shortRefinesLong = moreSpecificRefines(deps, long, short, shortParsed, shortEval.row, longParsed);
    if (shortRefinesLong.refines) return { verdict: "resolved", winner: "short", rule: "more-specific-refines", detail: `short ${short.hobbyiqCardId} refines long ${long.hobbyiqCardId}: ${shortRefinesLong.reason}`, winnerRow: shortEval.row };
    return { verdict: "both-sides-valid", detail: `both hobbyiqCardId values (long=${long.hobbyiqCardId}, short=${short.hobbyiqCardId}) resolve to a strict checklist row naming this player, and neither strictly refines the other` };
  }

  // (2) NEITHER PASSES.
  return { verdict: "neither-side-backed", detail: `neither hobbyiqCardId value resolves to a strict checklist row naming this player -- long: ${longEval.reason}; short: ${shortEval.reason}` };
}

/**
 * RULE 3: grade axis. The side whose grade agrees with a grader TOKEN in
 * EITHER title wins (grade from grader token only -- gradeParser.ts's
 * parseGradeFromTitle). Coordinator review of #2381, MEDIUM: a grade token
 * may appear on either row's own title, and if the two titles STATE
 * DIFFERENT grades, that is itself a disagreement this lane must not paper
 * over by picking one arbitrarily -- left, never guessed. Pure.
 */
function resolveGradeDisagreement(deps, long, short) {
  const longTitleGrade = deps.parseGradeFromTitle(String(long.title ?? ""));
  const shortTitleGrade = deps.parseGradeFromTitle(String(short.title ?? ""));
  const keyOf = (g) => (g ? `${String(g.gradeCompany).toUpperCase()}|${g.gradeValue}` : null);
  const longTitleKey = keyOf(longTitleGrade);
  const shortTitleKey = keyOf(shortTitleGrade);
  if (longTitleKey && shortTitleKey && longTitleKey !== shortTitleKey) {
    return { verdict: "neither-side-backed", detail: `the two titles state DIFFERENT grader tokens (long title reads ${longTitleKey}, short title reads ${shortTitleKey}) -- never guessed past` };
  }
  const titleKey = longTitleKey ?? shortTitleKey;
  if (!titleKey) return { verdict: "neither-side-backed", detail: "neither title carries a grader token at all -- grade from grader token only, never inferred" };
  const longKey = gradeKeyOf(long);
  const shortKey = gradeKeyOf(short);
  const longMatches = longKey === titleKey;
  const shortMatches = shortKey === titleKey;
  if (longMatches && !shortMatches) return { verdict: "resolved", winner: "long", rule: "grader-token-in-title", detail: `title's grader token reads ${titleKey}; long grade=${longKey} agrees, short grade=${shortKey} does not` };
  if (shortMatches && !longMatches) return { verdict: "resolved", winner: "short", rule: "grader-token-in-title", detail: `title's grader token reads ${titleKey}; short grade=${shortKey} agrees, long grade=${longKey} does not` };
  if (longMatches && shortMatches) return { verdict: "both-sides-valid", detail: `both sides already agree with the title's grader token (${titleKey}) -- decideSyntheticTwin should not have called this a disagreement; left for review` };
  return { verdict: "neither-side-backed", detail: `title's grader token reads ${titleKey}; neither side's stored grade (long=${longKey}, short=${shortKey}) agrees with it` };
}

/**
 * THE ONE ENTRY POINT: given a `twins-disagree` verdict from
 * decideSyntheticTwin, resolve it. `axis` names which field disagreed. Both
 * documents are always passed; there is no single `sale` any more.
 */
function resolveDisagreement(deps, axis, long, short) {
  if (axis === "hobbyiqCardId") return resolveHobbyiqCardIdDisagreement(deps, long, short);
  if (axis === "grade") return resolveGradeDisagreement(deps, long, short);
  return { verdict: "neither-side-backed", detail: `unknown disagreement axis "${axis}"` };
}

/**
 * ACTION: build the kept document once a pair is resolved. The SHORT row's
 * ADDRESS is ALWAYS kept (this pool's own KEEP RULE); when the winner is the
 * LONG side, the short row's ENTIRE identity field family is OVERWRITTEN
 * (never folded -- a fold only fills what is missing, and a resolved
 * disagreement means the short row's own value was WRONG, not absent) with
 * the winning identity, `contentHash` is recomputed against the NEW identity
 * (mirroring repoint-sales-to-sibling-product.cjs's own
 * `keep.contentHash = contentHashOf(keep)` after any identity change), and
 * the result is run through `guardSoldCompDoc` so a malformed winning
 * identity parks rather than writes silently. The ledger stamp is ONE object
 * field.
 *
 * `winnerRow` is the checklist row RULE 1/2 proved for the winning side (its
 * OWN `playerName`/`parallel` spelling -- the canonical checklist form, not
 * whatever the losing row happened to store) when the axis is hobbyiqCardId;
 * absent for a grade-axis resolution, where only the three grade fields move.
 */
function buildResolution(deps, long, short, resolution, axis, now, winnerRow) {
  const keep = stripSystem(short);
  const loserId = resolution.winner === "long" ? short.id : long.id;
  const winnerId = resolution.winner === "long" ? long.id : short.id;
  if (resolution.winner === "long") {
    if (axis === "hobbyiqCardId") {
      const winnerParsed = catalogPrefixFor(long.hobbyiqCardId);
      keep.cardId = long.cardId;
      keep.hobbyiqCardId = long.hobbyiqCardId;
      if (winnerParsed) {
        keep.sport = winnerParsed.sport;
        keep.cardYear = winnerParsed.year;
        keep.cardNumber = winnerParsed.cardNumber;
        keep.parallel = winnerRow?.parallel ?? winnerParsed.parallel;
        keep.isAuto = winnerParsed.isAuto;
      }
      keep.playerName = winnerRow?.playerName ?? long.playerName ?? keep.playerName;
      keep.contentHash = contentHashOf(keep);
    } else if (axis === "grade") {
      keep.gradeCompany = long.gradeCompany;
      keep.gradeValue = long.gradeValue;
      keep.gradeQualifier = long.gradeQualifier ?? null;
      keep.contentHash = contentHashOf(keep);
    }
  }
  keep.twinResolved = { at: now, by: "resolve-disagreeing-sale-twins", winner: winnerId, loser: loserId, rule: resolution.rule };
  if (deps?.guardSoldCompDoc) deps.guardSoldCompDoc(keep, { guardedBy: "resolve-disagreeing-sale-twins" });
  return keep;
}

module.exports = {
  isChecklistBacked, catalogRowPlayerKeys, playerMatchesRow, catalogPrefixFor,
  evaluateHobbyiqCardIdSide, evaluateHobbyiqCardIdSideBothTitles, moreSpecificRefines,
  titleNamesMoreSpecificThanCandidate, titleContradictsCandidateCell,
  resolveHobbyiqCardIdDisagreement, resolveGradeDisagreement, resolveDisagreement,
  resolveBothSidesValidByRule, buildFlagExclusion, keeperExcludedFromPricing,
  buildResolution, normParallelForRung, normNumber, USER_SEED_SOURCES,
  decodeResume, encodeResume, RESUME_HOP_UNIT, RESUME_RULE_UNIT, MAX_RESUME_HOPS,
  NAMED_AND_SPECIFIC_TOKEN, NAMED_AND_SPECIFIC_OPT_IN,
  __setSweepDepsForTest: (d) => { SWEEP_DEPS = d; },
  // Exported for white-box testing of the throttle-drop mechanism only --
  // `throttleStats` lets a test simulate 429 pressure without paying real
  // retry() backoff delays (500ms-15s per attempt) for 20+ real throttles.
  throttleStats,
};

// Lazily-bound TS-authored deps -- assigned in main() once dist/ is required,
// and independently assignable by tests via __setSweepDepsForTest so the pure
// functions above never need a live dist/ build to be unit tested.
let SWEEP_DEPS = {
  catalogAuthorityOf: () => "unknown",
  parseHobbyIqCardId: () => null,
};

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const { playerIdentityKey } = require(path.join(backend, "dist/services/catalog/playerIdentityKey.js"));
  const { parseHobbyIqCardId, sameCardNumber, slugify } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { statedFinishFromChecklist } = require(path.join(backend, "dist/services/portfolioiq/statedFinishFromChecklist.js"));
  const { parallelTheTitleAllows } = require(path.join(backend, "dist/services/portfolioiq/titleOutranksVendorTag.js"));
  const { playerTheTitleAllows, playerNameKey } = require(path.join(backend, "dist/services/portfolioiq/playerTheTitleAllows.js"));
  const { cleanPlayerName } = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));
  const { extractCardNumberFromTitle, extractPrintRunFromTitle } = require(path.join(backend, "dist/services/portfolioiq/soldCompsStore.service.js"));
  const { parseGradeFromTitle } = require(path.join(backend, "dist/services/portfolioiq/gradeParser.js"));
  const { readVariationFromTitle } = require(path.join(backend, "dist/services/catalog/variationVocabulary.js"));
  const { insertSetNamedInTitle } = require(path.join(backend, "dist/services/portfolioiq/insertSetTitleReader.js"));
  const { isRegisteredProduct } = require(path.join(backend, "dist/services/catalog/resolveProductByChecklist.js"));
  const { productAncestry } = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
  const { inferSetKeyFromTitle } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
  const { extractYearFromTitle } = require(path.join(backend, "dist/services/portfolioiq/slugRederivation.service.js"));
  const { guardSoldCompDoc } = require(path.join(backend, "dist/services/portfolioiq/splitIdentityWriteGuard.js"));

  SWEEP_DEPS = { catalogAuthorityOf, parseHobbyIqCardId };

  // ── titleContradictsTarget: re-derived orchestration, SAME primitives, SAME
  // order, as repoint-sales-to-sibling-product.cjs's own (not exported there
  // either -- "no new title parser is written here", copied verbatim in
  // spirit per that file's own header). Card-number rule, then parallel,
  // then player.
  function guessPlayerFromTitleLocal(title) {
    try {
      const { parseCardQuery } = require(path.join(backend, "dist/services/compiq/cardQueryParser.js"));
      const parsed = parseCardQuery(String(title || ""));
      if (!parsed || !(Number(parsed.confidence) > 0)) return null;
      const player = parsed.playerName;
      return typeof player === "string" && player.trim().length > 0 ? player.trim() : null;
    } catch { return null; }
  }
  function normalizeKeepHyphens(raw) { return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, ""); }
  function isHyphenSuffixOf(shorter, longer) { return Boolean(shorter) && longer.length > shorter.length && longer.startsWith(`${shorter}-`); }
  function cardNumberIsUnderSpecified(titleCardNumber, targetCardNumber) {
    const nt = normalizeKeepHyphens(titleCardNumber), ng = normalizeKeepHyphens(targetCardNumber);
    if (!nt || !ng) return false;
    return isHyphenSuffixOf(nt, ng) || isHyphenSuffixOf(ng, nt);
  }
  function titleContradictsTarget(sale, target) {
    const title = String(sale.title ?? "");
    if (!title.trim()) return { contradicts: false };
    const titleCardNumber = extractCardNumberFromTitle(title);
    if (titleCardNumber && target.cardNumber && !sameCardNumber(titleCardNumber, target.cardNumber) && !cardNumberIsUnderSpecified(titleCardNumber, target.cardNumber)) {
      return { contradicts: true, rule: "card-number", detail: `title states #${titleCardNumber}, destination row is #${target.cardNumber}` };
    }
    const titleFinish = statedFinishFromChecklist(title, { setKey: target.setKey ?? null, year: target.year ?? target.cardYear ?? null });
    if (titleFinish) {
      const finishDecision = parallelTheTitleAllows(titleFinish, String(target.parallelSlug ?? target.parallel ?? "Base"));
      if (finishDecision.vendorTagOverruled) {
        return { contradicts: true, rule: "parallel", detail: `title states finish "${titleFinish}", destination row is "${target.parallelSlug ?? target.parallel ?? "Base"}"` };
      }
    }
    const titlePlayer = guessPlayerFromTitleLocal(title);
    if (titlePlayer && target.playerName) {
      const titleKey = playerIdentityKey(titlePlayer);
      const targetNames = String(target.playerName).split(/\s*(?:\/|&|\band\b)\s*/i).map((n) => n.trim()).filter(Boolean);
      const namesToCheck = targetNames.length ? targetNames : [String(target.playerName)];
      const collapseInitials = (tokens) => { const out = []; let buf = ""; for (const t of tokens) { if (t.length === 1) buf += t; else { if (buf) { out.push(buf); buf = ""; } out.push(t); } } if (buf) out.push(buf); return out; };
      const tokensOf = (raw) => collapseInitials(playerNameKey(cleanPlayerName(String(raw ?? ""))).split(" ").filter(Boolean).map((t) => playerIdentityKey(t)));
      const isSubsetMatch = namesToCheck.some((name) => {
        const nameKey = playerIdentityKey(name);
        if (!nameKey || !titleKey) return false;
        if (nameKey === titleKey) return true;
        const nameTokens = tokensOf(name), titleTokens = tokensOf(titlePlayer);
        if (!nameTokens.length || !titleTokens.length) return false;
        const isSubsequence = (shorter, longer) => shorter.length > 0 && shorter.every((t) => longer.includes(t));
        return isSubsequence(nameTokens, titleTokens) || isSubsequence(titleTokens, nameTokens);
      });
      if (!isSubsetMatch) {
        const playerDecision = playerTheTitleAllows(target.playerName, titlePlayer);
        if (playerDecision.outcome === "irreconcilable") {
          return { contradicts: true, rule: "player", detail: `title names "${titlePlayer}", destination row is "${target.playerName}"` };
        }
      }
    }
    return { contradicts: false };
  }
  void inferSetKeyFromTitle; void isRegisteredProduct; void productAncestry; void slugify; // read-only imports of stamp-input exports; kept available for a future title-names-product widening, unused today

  // ── per-cell checklist cache, row-budgeted LRU ---------------------------
  const cache = new Map(); // "sport|year|setKey" -> Map<normNumber, row[]>
  function cacheEvictIfNeeded() {
    while (cache.size > CATALOG_CACHE_MAX) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
  }
  async function loadChecklistRowsByNumber(cat, sport, year, setKey) {
    const key = `${sport}|${year}|${setKey}`;
    if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; } // MRU bump
    const byNumber = new Map();
    const it = cat.items.query({
      query: `SELECT c.id, c.source, c.sport, c.year, c.cardYear, c.setKey, c.cardNumber, c.parallel, c.parallelSlug, c.isAuto, c.playerName
              FROM c WHERE STARTSWITH(c.id, @prefix) AND c.sport = @sport AND (c.year = @year OR c.cardYear = @year) AND NOT IS_DEFINED(c.gradeTier)`,
      parameters: [{ name: "@prefix", value: `hiq:${sport}:${year}:${setKey}:` }, { name: "@sport", value: sport }, { name: "@year", value: year }],
    }, { maxItemCount: 500 });
    while (it.hasMoreResults()) {
      const { resources } = await retry(() => it.fetchNext());
      for (const r of resources ?? []) {
        if (!r.cardNumber) continue;
        const num = normNumber(r.cardNumber);
        if (!byNumber.has(num)) byNumber.set(num, []);
        byNumber.get(num).push(r);
      }
    }
    cache.set(key, byNumber);
    cacheEvictIfNeeded();
    return byNumber;
  }

  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const pool = db.container("sold_comps");
  const cat = db.container("card_catalog");
  console.log(`resolve-disagreeing-sale-twins  ${APPLY ? "APPLY" : "REPORT ONLY"}  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m  limit ${LIMIT || "none"} partitions`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  let planFd = null;
  if (PLAN_OUT) {
    try {
      fs.mkdirSync(PLAN_OUT, { recursive: true });
      const planPath = path.join(PLAN_OUT, `plan-slot-${SLOT}.ndjson`);
      planFd = fs.openSync(planPath, "w");
      console.log(`  plan file         ${planPath}`);
    } catch (e) {
      console.log(`\n::warning::could not open PLAN_OUT (${PLAN_OUT}): ${e?.message}`);
      planFd = null;
    }
  }
  function emitPlanRow(action, rule, long, short, extra = {}) {
    if (!planFd) return;
    const record = {
      action, rule: rule ?? null,
      longId: long?.id ?? null, longHobbyiqCardId: long?.hobbyiqCardId ?? null, longGrade: long ? gradeKeyOf(long) : null,
      shortId: short?.id ?? null, shortHobbyiqCardId: short?.hobbyiqCardId ?? null, shortGrade: short ? gradeKeyOf(short) : null,
      cardId: long?.cardId ?? short?.cardId ?? null, title: long?.title ?? short?.title ?? null,
      ...extra,
    };
    try { fs.appendFileSync(planFd, JSON.stringify(record) + "\n"); }
    catch (e) { console.log(`\n::warning::PLAN_OUT write failed for ${long?.id}: ${e?.message}`); }
  }

  // THE POPULATION: same CH card ids the sweep lane's own population query
  // finds (any card carrying a long-shaped row) -- this lane's own decision
  // (decideSyntheticTwin) then narrows each partition to just the
  // twins-disagree pairs.
  const allCards = [];
  {
    const it = pool.items.query({ query: `SELECT DISTINCT VALUE c.cardId FROM c WHERE c.source = 'cardhedge' AND RegexMatch(c.id, "^cardhedge::ch-daily::.*::.*::[0-9]+$")` }, { maxItemCount: 500 });
    while (it.hasMoreResults()) { const { resources } = await retry(() => it.fetchNext()); for (const id of resources ?? []) if (id) allCards.push(String(id)); }
  }
  console.log(`  ${f(allCards.length)} CH cards carry a long-id-shaped row (same population as the sweep lane)`);

  const stats = {
    partitions: 0, otherShard: 0, rowsRead: 0,
    disagreePairsSeen: 0, protected: 0, parkedSide: 0,
    resolvedChecklistRoster: 0, resolvedMoreSpecific: 0, resolvedGraderToken: 0,
    bothSidesValid: 0, neitherSideBacked: 0,
    winnerLong: 0, winnerShort: 0,
    applied: 0, failed: 0, duplicatesLeft: 0, staleSincePlan: 0, alreadyGone: 0, notReached: 0,
    // OWNER RULING (2026-09-21), opt-in only (NAMED_AND_SPECIFIC_OPT_IN) --
    // both-sides-valid pairs this run additionally flags rather than leaves.
    flaggedBaseVsNamedParallel: 0, flaggedAutoOrNumSpecificity: 0,
    flagApplied: 0, flagFailed: 0, flagStaleSincePlan: 0,
  };
  const examples = [];
  let stopReason = null;

  const baseDeps = {
    playerIdentityKey, titleContradictsTarget, statedFinishFromChecklist,
    sameCardNumber, parseGradeFromTitle,
    readVariationFromTitle, insertSetNamedInTitle, isRegisteredProduct,
    extractPrintRunFromTitle, extractYearFromTitle, inferSetKeyFromTitle,
    productAncestry, slugify, guardSoldCompDoc,
  };

  // ── SHARDING (coordinator report on run 35578577288: dispatched
  // slot=0 slots=8, ran "slot 0/1" -- the whole population, and a real
  // fan-out of slots 0..7 would have run EIGHT COPIES over the same pairs).
  // The lane always called runnerShardScope correctly; what was missing was
  // the workflow's own SHARD env wire (see backfill-runner.yml's SHARD
  // expression) -- this script cannot fix that from inside itself, so it
  // now also prints the fold-catalog-duplicate-rungs.cjs convention's
  // explicit `shard  slot X/Y` line (in ADDITION to SHARD_SCOPE.banner()'s
  // own prose banner) so the runner's relaunch step can parse the REAL
  // slot/slots off the log rather than trust the raw dispatch inputs
  // verbatim (a slot=0 dispatch that never opted in still prints slot 0/1
  // here, honestly, and the relaunch notice below reads THIS line).
  console.log(`  shard         slot ${SLOT}/${SLOTS}  on sha1(cardId) -- a whole CH partition (and every pair inside it) lands on ONE slot, never straddling two`);
  const shardedCards = SLOTS > 1
    ? allCards.filter((cardId) => { const mine = shardOf(cardId) === SLOT; if (!mine) stats.otherShard++; return mine; })
    : allCards;

  // ── DETERMINISTIC ORDER + RESUME CURSOR (coordinator report: "a REPORT
  // relaunch restarts from zero and loops forever", cancelled run
  // 35589416039). Copies fold-catalog-duplicate-rungs.cjs's own convention
  // byte-for-byte: hop*1,000,000 + offset, riding the EXISTING `scan_limit`
  // dispatch input (no new one), a hop cap so a chain that never converges
  // cannot relaunch forever, APPLY ALWAYS RESCANS AT OFFSET 0 (a resolved
  // pair drops out of the fresh population on its own -- decideSyntheticTwin
  // no longer proves it twins-disagree once one copy is gone -- so slicing a
  // rebuilt, potentially-reordered scan by a stale numeric offset would skip
  // arbitrary never-resolved pairs, forever), and REPORT's offset is only
  // ever valid because the order it indexes into is SORTED, not "however the
  // population query happened to return it".
  let RESUME = decodeResume(process.env.SCAN_LIMIT);
  // REVIEW FIX (coordinator, PR #2391 review): a cursor minted while the
  // OWNER RULING opt-in was OFF (or ON) must never be resumed by a run
  // whose OWN opt-in state disagrees -- that would silently mix rule-on and
  // rule-off outcomes across hops of what is supposed to be ONE chain's own
  // consistent scan (a pair the first hop left both-sides-valid under
  // rule-off could be flagged on the very next hop under rule-on, with no
  // record that the rule state ever changed mid-chain). A mismatch is
  // treated exactly like an absent/zero cursor: a fresh restart at hop 0,
  // offset 0, under the CURRENT run's own (correct) rule state.
  const currentRuleBit = NAMED_AND_SPECIFIC_OPT_IN ? 1 : 0;
  if (RESUME.hop > 0 || RESUME.offset > 0) {
    if (RESUME.ruleBit !== currentRuleBit) {
      console.log(`  RESUME (RULE MISMATCH)  scan_limit's own cursor was minted under opt-in=${RESUME.ruleBit ? "ON" : "OFF"}, but this run's opt-in is ${currentRuleBit ? "ON" : "OFF"} -- the cursor is DISCARDED (fresh restart at hop 0, offset 0) rather than resumed under a rule state it was never minted for.`);
      RESUME = { hop: 0, offset: 0, ruleBit: currentRuleBit };
    }
  }
  if (RESUME.hop >= MAX_RESUME_HOPS) {
    throw new Error(`RESOLVE_DISAGREEING_SALE_TWINS_HOP_CAP: this chain has already relaunched ${RESUME.hop} time(s) (cap ${MAX_RESUME_HOPS}) without converging -- ABORTING rather than relaunching again. Re-dispatch deliberately (scan_limit=0) only after checking why the population is not shrinking.`);
  }
  const orderedCards = [...shardedCards].sort();
  const totalCardsThisSlot = orderedCards.length;
  const REPORT_RESUME_OFFSET = APPLY ? 0 : RESUME.offset;
  if (APPLY && RESUME.offset > 0) {
    console.log(`  RESUME (APPLY)   scan_limit carried a non-zero offset (${f(RESUME.offset)}) from an earlier hop -- IGNORED under APPLY: every relaunch rescans from the top, because a pair an earlier hop resolved no longer proves twins-disagree and simply will not appear in this fresh scan. Only the hop count (${f(RESUME.hop)}) carries forward, for the hop cap.`);
  }
  const cardsThisRun = REPORT_RESUME_OFFSET > 0 ? orderedCards.slice(REPORT_RESUME_OFFSET) : orderedCards;
  if (REPORT_RESUME_OFFSET > 0) {
    console.log(`  RESUMED (REPORT) skipping the first ${f(REPORT_RESUME_OFFSET)} of ${f(totalCardsThisSlot)} sorted CH partition(s) on this slot an earlier relaunch already decided (hop ${RESUME.hop}) -> ${f(cardsThisRun.length)} left. Valid because REPORT writes nothing, so the population and this sort are unchanged between hops.`);
  }

  // ── CONCURRENCY, ACROSS PARTITIONS ONLY (coordinator report: 80,770 pairs
  // in 120 minutes is ~11 pairs/s). Copies fold-catalog-duplicate-rungs.cjs's
  // own convention: a partition is the unit of concurrency (its own pairs
  // stay strictly serial within it -- two pairs sharing a `long` row must
  // never decide/write concurrently), default 6 (safe headroom on a shared
  // 10,000-RU/s sold_comps day), the `concurrency`/`CONCURRENCY`/
  // `BACKFILL_CONCURRENCY` dispatch input raises it, and every retried
  // Cosmos call (429/503/timeout, the ONE shared `retry()` wrapper) trips a
  // one-way step-down to 2 after 20 throttles in this run.
  const REQUESTED_CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 6));
  const THROTTLE_TRIP_AT = 20;
  const THROTTLE_CONCURRENCY = 2;
  function effectiveConcurrency() {
    if (throttleStats.count >= THROTTLE_TRIP_AT) {
      if (!throttleStats.droppedTo2) {
        throttleStats.droppedTo2 = true;
        console.log(`\n  THROTTLED: ${f(throttleStats.count)} retries (429/503/timeout) hit in this run -- dropping concurrency from ${f(REQUESTED_CONCURRENCY)} to ${f(THROTTLE_CONCURRENCY)} for the REST of this run. sold_comps is shared with production pricing; this lane backs off rather than compete for it.`);
      }
      return THROTTLE_CONCURRENCY;
    }
    return REQUESTED_CONCURRENCY;
  }
  console.log(`  concurrency   ${REQUESTED_CONCURRENCY} partition(s) at once (across partitions only -- one partition's own pairs stay strictly serial); auto-drops to ${THROTTLE_CONCURRENCY} after ${THROTTLE_TRIP_AT} throttles this run`);

  /** ONE partition's whole unit of work -- population read, day-count
   *  precompute, per-pair decide+write, all strictly serial WITHIN this
   *  call. Different partitions run concurrently (the caller's batches);
   *  this function's own body is otherwise byte-identical to the original
   *  single-loop version, just parameterized so several can run at once
   *  without racing on a shared mutable `deps.checklistRowsByNumber`. */
  async function processPartition(cardId) {
    stats.partitions++;

    const rows = [];
    const it = pool.items.query({ query: "SELECT * FROM c WHERE c.cardId = @id AND c.source = 'cardhedge'", parameters: [{ name: "@id", value: cardId }] }, { partitionKey: cardId, maxItemCount: 500 });
    while (it.hasMoreResults()) { const { resources } = await retry(() => it.fetchNext()); for (const r of resources ?? []) rows.push(r); }
    stats.rowsRead += rows.length;

    const longRows = rows.filter((r) => parseLongSyntheticId(r.id));
    const shortRows = rows.filter((r) => isCanonicalChDailyId(r.id));
    if (!longRows.length || !shortRows.length) return; // nothing to disagree about in this partition

    const dayCounts = new Map(), longDayCounts = new Map();
    // Same date-only uniqueness precompute the sweep lane runs, needed so
    // decideSyntheticTwin's own ambiguous-day branch is available to this
    // lane's calls too -- a pair this lane would otherwise mis-scope as
    // twins-disagree when it is really ambiguous-multi-sale-day.
    for (const s of shortRows) {
      const dParsed = SWEEP.parseInstant ? SWEEP.parseInstant(s.soldAt) : null;
      const d = dParsed && dParsed.day ? dParsed.day : String(s.soldAt ?? "").slice(0, 10);
      if (!d) continue;
      const key = `${d}|${cents(s.price)}`;
      dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1);
    }
    for (const l of longRows) {
      const parsed = parseLongSyntheticId(l.id);
      if (!parsed) continue;
      const day = String(parsed.soldAt ?? "").slice(0, 10);
      const c = Math.round(Number(parsed.priceCents));
      if (!Number.isFinite(c) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const key = `${day}|${c}`;
      longDayCounts.set(key, (longDayCounts.get(key) ?? 0) + 1);
    }

    // Partition-LOCAL deps: a fresh object per partition, never a shared
    // mutable closure -- concurrent partitions each bind their OWN
    // checklistRowsByNumber against the SAME shared LRU cache (safe: reads
    // and cache inserts are synchronous between awaits), so two partitions
    // running at once can never race on which cell the other's lookup
    // resolves to.
    const deps = { ...baseDeps, checklistRowsByNumber: (parsed) => (parsed ? cache.get(`${parsed.sport}|${parsed.year}|${parsed.setKey}`) ?? new Map() : new Map()) };

    for (const long of longRows) {
      const parsedId = parseLongSyntheticId(long.id);
      const candidateShorts = shortRows.filter((s) => cents(s.price) === Math.round(Number(parsedId.priceCents) || NaN));
      for (const short of candidateShorts) {
        // ── RECONCILE FIX (coordinator report on run 35578577288: "twins-
        // disagree pairs seen 80,770" vs "resolved+left+protected+parked
        // 106,741 MISMATCH"). The bug: isProtected/isParkedSide used to gate
        // BEFORE decideSyntheticTwin ever ran, once per LONG ROW and again
        // per CANDIDATE SHORT -- so a protected/parked row was counted into
        // `protected`/`parkedSide` for EVERY (long, short) pairing it
        // appeared in, including pairings decideSyntheticTwin would have
        // called `not-a-match`, `ambiguous-multi-sale-day`, or an ordinary
        // `collapse` (no disagreement at all). Those are NOT part of this
        // lane's own population (`disagreePairsSeen` only counts pairs
        // PROVEN `twins-disagree`), so the right-hand side of the reconcile
        // counted rows the left-hand side never counted -- exactly the
        // "counted without being counted as seen" the coordinator named.
        //
        // FIX: decideSyntheticTwin (pure, no I/O) is now the FIRST thing
        // checked, before ANY protected/parked gate. `disagreePairsSeen` and
        // the protected/parked counters now increment on the SAME
        // condition -- `d.verdict === "twins-disagree"` -- so every pair
        // that adds to one side of the reconcile also adds to the other.
        // Only a pair confirmed to be a genuine disagreement is EVER
        // classified as protected/parked/resolved/left; a not-a-match,
        // ambiguous, or ordinary-collapse pairing is silently skipped here
        // exactly as it always was, uncounted on EITHER side, because it is
        // not this lane's population at all (it belongs to -- and is
        // already counted by -- the sweep lane's own REPORT).
        const d = decideSyntheticTwin(long, short, { dayCounts, longDayCounts });
        if (d.verdict !== "twins-disagree") continue;
        stats.disagreePairsSeen++;

        // PLAN_OUT gets protected/parked-side pairs too (coordinator review
        // of #2381, LOW) -- same auditability doctrine as the sweep lane's
        // own emitPlanRow calls for these classes; a REPORT that silently
        // drops them cannot be audited row by row before the matching APPLY
        // runs. Checked NOW, after the pair is proven a genuine
        // disagreement, never before -- see the FIX note above.
        if (isProtected(long) || isProtected(short)) {
          stats.protected++;
          emitPlanRow("protected", null, long, short, { reason: isProtected(long) ? "long-row-pinned-or-flagged" : "short-row-pinned-or-flagged" });
          continue;
        }
        if (isParkedSide(long) || isParkedSide(short)) {
          stats.parkedSide++;
          emitPlanRow("parked-side", null, long, short, { reason: isParkedSide(long) ? "long-row-parked" : "short-row-parked" });
          continue;
        }

        // PRE-WARM the checklist cache for both sides' cells before calling
        // the pure resolver -- one Cosmos round trip per (sport,year,setKey)
        // per run, never per pair, via the MRU cache above (shared ACROSS
        // partitions on purpose -- a cell many partitions' pairs reference
        // is loaded once, not once per partition).
        for (const hiq of [long.hobbyiqCardId, short.hobbyiqCardId]) {
          const parsed = parseHobbyIqCardId(String(hiq ?? ""));
          if (parsed) await loadChecklistRowsByNumber(cat, parsed.sport, parsed.year, parsed.setKey);
        }

        const resolution = resolveDisagreement(deps, d.axis, long, short);
        if (resolution.verdict === "both-sides-valid") {
          // ── OWNER RULING (2026-09-21), opt-in only. R1/R2 only ever apply
          // to the hobbyiqCardId axis (grade-axis disagreements are
          // explicitly NOT ruled -- left, same as always) -- and only once
          // isProtected/isParkedSide has ALREADY refused this pair above, so
          // neither side here can be pinned/verifiedByUser/excludedFromFmv/
          // flaggedWrong/parked by construction. USER_SEED_SOURCES is still
          // checked directly (isProtected does not read `source`, and the
          // hard requirement names user-seed rows explicitly).
          let flagVerdict = { verdict: "left" };
          if (NAMED_AND_SPECIFIC_OPT_IN && d.axis === "hobbyiqCardId"
              && !USER_SEED_SOURCES.has(String(long.source ?? "")) && !USER_SEED_SOURCES.has(String(short.source ?? ""))) {
            const longParsed = catalogPrefixFor(long.hobbyiqCardId);
            const shortParsed = catalogPrefixFor(short.hobbyiqCardId);
            flagVerdict = resolveBothSidesValidByRule(longParsed, shortParsed);
          }
          if (flagVerdict.verdict !== "flagged") {
            stats.bothSidesValid++;
            if (examples.length < 30) examples.push(`  BOTH-SIDES-VALID  ${cardId}  long=${long.id} short=${short.id}: ${resolution.detail}`);
            emitPlanRow("left", null, long, short, { verdict: "both-sides-valid", detail: resolution.detail, axis: d.axis });
            continue;
          }

          const keeper = flagVerdict.keeper === "long" ? long : short;
          const loser = flagVerdict.keeper === "long" ? short : long;
          // NEVER flag when the keeper copy is itself flagged/excluded/
          // parked/priceAnomaly -- would leave the sale priced nowhere
          // (keeperExcludedFromPricing -- see its own header for the full
          // field list, matching BOTH FMV readers' own WHERE clauses, not
          // just isProtected/isParkedSide). isProtected/isParkedSide already
          // refused the WHOLE pair above whenever EITHER side trips them,
          // but priceAnomaly is NOT one of those two gates, so this is the
          // FIRST point priceAnomaly is ever checked on the keeper -- not
          // redundant. Checked again immediately before the write below
          // (plan-time and pre-write both use the SAME function) in case the
          // keeper's own priceAnomaly flips between plan and write.
          if (keeperExcludedFromPricing(keeper)) {
            stats.bothSidesValid++;
            if (examples.length < 30) examples.push(`  BOTH-SIDES-VALID  ${cardId}  long=${long.id} short=${short.id}: keeper side is itself protected/parked/priceAnomaly -- refused, left`);
            emitPlanRow("left", null, long, short, { verdict: "both-sides-valid", detail: `${resolution.detail} (rule ${flagVerdict.rule} would flag ${loser.id}, but its keeper ${keeper.id} is itself protected/parked/priceAnomaly -- refused)`, axis: d.axis });
            continue;
          }

          if (flagVerdict.rule === "base-vs-named-parallel") stats.flaggedBaseVsNamedParallel++;
          else stats.flaggedAutoOrNumSpecificity++;
          if (examples.length < 30) examples.push(`  FLAGGED (${flagVerdict.rule}, keeper=${flagVerdict.keeper})  ${cardId}  long=${long.id} short=${short.id}: ${flagVerdict.detail}`);

          const now = new Date().toISOString();
          const ops = buildFlagExclusion(loser, keeper, flagVerdict.rule, now);
          emitPlanRow(APPLY ? "flag-exclude" : "would-flag-exclude", flagVerdict.rule, long, short, { keeper: flagVerdict.keeper, loserId: loser.id, detail: flagVerdict.detail });

          if (APPLY) {
            try {
              // PRE-WRITE KEEPER RE-CHECK (coordinator review of #2391): the
              // plan-time check above ran before the checklist cache
              // pre-warm and every earlier pair in this partition's own
              // loop -- a keeper's own priceAnomaly/excludedFromFmv/
              // flaggedWrong/identityUnverified state can still change in
              // that window (including THIS run flagging the very same doc
              // as some OTHER pair's loser). Re-read the keeper's CURRENT
              // state, immediately before the loser's write, and refuse
              // rather than flag a loser whose keeper no longer prices.
              const freshKeeper = await retry(() => pool.item(keeper.id, keeper.cardId).read()).catch((e) => {
                if (e?.code === 404 || e?.statusCode === 404) return null;
                throw e;
              });
              if (freshKeeper?.resource && keeperExcludedFromPricing(freshKeeper.resource)) {
                stats.flagStaleSincePlan++;
                console.log(`  STALE SINCE PLAN (flag) ${loser.id}@${loser.cardId}: keeper ${keeper.id} became protected/parked/priceAnomaly since plan; nothing written`);
                continue;
              }
              const planEtag = loser._etag;
              const fresh = await retry(() => pool.item(loser.id, loser.cardId).read());
              if (planEtag && fresh?.resource?._etag && fresh.resource._etag !== planEtag) {
                stats.flagStaleSincePlan++;
                console.log(`  STALE SINCE PLAN (flag) ${loser.id}@${loser.cardId}: changed since this run's own planning read; nothing written`);
                continue;
              }
              // PATCH BY PARTITION: sold_comps ids are unique only within a
              // partition (/cardId) -- (id, cardId) addresses the loser doc
              // exactly, on its OWN existing partition, no relocation.
              await retry(() => pool.item(loser.id, loser.cardId).patch(ops, planEtag ? { accessCondition: { type: "IfMatch", condition: planEtag } } : undefined));
              stats.flagApplied++;
            } catch (e) {
              if (e?.code === 412 || e?.statusCode === 412) {
                stats.flagStaleSincePlan++;
                console.log(`  STALE SINCE PLAN (flag, 412) ${loser.id}@${loser.cardId}: nothing written`);
              } else {
                stats.flagFailed++;
                console.log(`  FLAG FAILED ${loser.id}@${loser.cardId}: ${String(e?.message ?? e).slice(0, 100)}`);
              }
            }
          } else {
            stats.flagApplied++; // REPORT counts what WOULD apply, same convention as `applied` above
          }
          continue;
        }
        if (resolution.verdict === "neither-side-backed") {
          stats.neitherSideBacked++;
          if (examples.length < 30) examples.push(`  NEITHER-SIDE-BACKED  ${cardId}  long=${long.id} short=${short.id}: ${resolution.detail}`);
          emitPlanRow("left", null, long, short, { verdict: "neither-side-backed", detail: resolution.detail, axis: d.axis });
          continue;
        }

        // resolution.verdict === "resolved"
        if (resolution.rule === "checklist-and-roster") stats.resolvedChecklistRoster++;
        else if (resolution.rule === "more-specific-refines") stats.resolvedMoreSpecific++;
        else if (resolution.rule === "grader-token-in-title") stats.resolvedGraderToken++;
        if (resolution.winner === "long") stats.winnerLong++; else stats.winnerShort++;
        if (examples.length < 30) examples.push(`  RESOLVED (${resolution.rule}, winner=${resolution.winner})  ${cardId}  long=${long.id} short=${short.id}: ${resolution.detail}`);

        const now = new Date().toISOString();
        // buildResolution sets the FULL identity field family (including
        // cardId, when the winner is long -- exercised directly whenever the
        // long row's cardId differs from the short row's, which today's
        // same-partition population never does, but a future population
        // that crosses partitions would) and recomputes contentHash + runs
        // guardSoldCompDoc, so nothing further touches identity here.
        const keep = buildResolution(deps, long, short, resolution, d.axis, now, resolution.winnerRow);
        // CARRY the sweep lane's own repair-ledger fold too -- a resolved
        // pair is still a collapse, and any long-only repair state
        // (rekeyedAt/splitResolved/etc.) the short row lacks should still
        // land on the kept row, exactly as the sweep lane's ordinary
        // collapse does.
        const folded = foldMissing(keep, [long], SWEEP.CARRY_FIELDS.filter((c) => c !== "hobbyiqCardId" && c !== "gradeCompany" && c !== "gradeValue" && c !== "gradeQualifier"));
        void folded;
        keep.collapsedFrom = { id: long.id, cardId: long.cardId, sourceExternalId: long.sourceExternalId ?? null, title: long.title ?? null, soldAt: long.soldAt ?? null };
        keep.collapsedAt = now;
        keep.collapsedReason = "CF-CH-DAILY-DOUBLE-WRITE: the same CH sale under a synthetic id and CardHedge's own vendor sale id, DISAGREEING identity resolved by evidence (resolve-disagreeing-sale-twins)";

        emitPlanRow(APPLY ? "resolve" : "would-resolve", resolution.rule, long, short, { winner: resolution.winner, axis: d.axis, detail: resolution.detail });

        const res = await relocateSoldComp(pool, { keep, drop: [{ id: long.id, cardId: long.cardId, ifMatchEtag: long._etag }], retry, verifyFields: ["twinResolved"], dryRun: !APPLY });
        if (!res.ok && res.stage !== "done") { stats.failed++; console.log(`  FAILED at ${res.stage} ${keep.id}: ${String(res.error).slice(0, 100)}`); continue; }
        if (res.duplicatesLeft?.length) { stats.failed++; stats.duplicatesLeft += res.duplicatesLeft.length; for (const x of res.duplicatesLeft) console.log(`  DUPLICATE LEFT ${x.id}@${x.cardId}: ${String(x.error).slice(0, 80)}`); continue; }
        if (res.staleSincePlan?.length) { stats.staleSincePlan += res.staleSincePlan.length; for (const x of res.staleSincePlan) console.log(`  STALE SINCE PLAN ${x.id}@${x.cardId}: ${String(x.error).slice(0, 80)}`); continue; }
        if (APPLY) stats.alreadyGone += res.alreadyGone.length;
        stats.applied++;
      }
    }
  }

  // ── HEARTBEAT: partitions done/total + ETA, once per minute, on stderr
  // (matches runner-budget.cjs's own narration convention and fold-catalog-
  // duplicate-rungs.cjs's own per-minute cadence). ──────────────────────────
  let partitionsDone = 0;
  let lastHeartbeatAt = Date.now();
  const HEARTBEAT_MS = 60 * 1000;
  function maybeHeartbeat() {
    const now = Date.now();
    if (now - lastHeartbeatAt < HEARTBEAT_MS) return;
    lastHeartbeatAt = now;
    const elapsedS = (now - started) / 1000;
    const rate = partitionsDone / Math.max(elapsedS, 1);
    const remaining = cardsThisRun.length - partitionsDone;
    const etaS = rate > 0 ? Math.round(remaining / rate) : null;
    const eta = etaS === null ? "unknown" : etaS < 60 ? `${etaS}s` : `${Math.round(etaS / 60)}m`;
    console.error(`  narrate: heartbeat pairs ${f(stats.disagreePairsSeen)} decided so far  partitions ${f(partitionsDone)}/${f(cardsThisRun.length)} this run (${f(totalCardsThisSlot)} total this slot)  rate ${rate.toFixed(1)} partitions/s  ETA ${eta}  throttles ${f(throttleStats.count)}${throttleStats.droppedTo2 ? ` (DROPPED to concurrency ${THROTTLE_CONCURRENCY})` : ""}`);
  }

  // `stoppedMidScan` is set ONLY by the CLOCK branch below -- a LIMIT stop is
  // an operator-requested slice (a dry-run sizing a probe), never a budget
  // exhaustion, and must never print the relaunch marker (coordinator
  // report: a FINISHED scan printing the marker anyway re-dispatches
  // forever, since a report drains nothing on the next hop).
  let stoppedMidScan = false;
  outer:
  for (let idx = 0; idx < cardsThisRun.length; ) {
    const batchSize = effectiveConcurrency();
    if (LIMIT && stats.partitions >= LIMIT) { stats.notReached += cardsThisRun.length - idx; break outer; }
    // Checked BEFORE each batch starts, never after -- the same "checked
    // before the unit, never at the loop top alone" rule runner-budget.cjs's
    // own header states, applied to a BATCH of partitions rather than one.
    if (budgetLeft() < RESERVE_MS) {
      stats.notReached += cardsThisRun.length - idx;
      stoppedMidScan = true;
      break outer;
    }
    const batch = cardsThisRun.slice(idx, idx + batchSize);
    await Promise.all(batch.map((cardId) => processPartition(cardId)));
    partitionsDone += batch.length;
    idx += batch.length;
    maybeHeartbeat();
  }

  // A REPORT (or APPLY) THAT FINISHED ITS SCAN NEVER PRINTS THE BUDGET
  // MARKER (coordinator report: run 35589416039, cancelled -- a REPORT
  // relaunch restarted from zero and looped forever because the marker
  // printed after the scan had already decided everything in scope).
  // `stoppedMidScan` is set ONLY inside the batch loop above, so a scan that
  // runs to completion (the `for` exhausts `cardsThisRun` without ever
  // hitting `break outer`) leaves it `false` and `stopReason` stays `null`.
  if (stoppedMidScan) {
    const nextOffset = APPLY ? 0 : REPORT_RESUME_OFFSET + partitionsDone;
    const nextResume = encodeResume({ hop: RESUME.hop + 1, offset: nextOffset, ruleBit: currentRuleBit });
    stopReason = APPLY
      ? `stopped at the ${RUN_MINUTES}-minute budget — the relaunch resumes at scan_limit=${nextResume} (hop ${RESUME.hop + 1}; APPLY always RESCANS from the top -- resolved pairs already dropped out of the next scan on their own, so offset stays 0)`
      : `stopped at the ${RUN_MINUTES}-minute budget — the relaunch resumes at scan_limit=${nextResume} (hop ${RESUME.hop + 1}, offset ${f(nextOffset)} of ${f(totalCardsThisSlot)} this slot)`;
  }
  console.log(`\n  partitions this run  decided ${f(partitionsDone)} of ${f(cardsThisRun.length)} in scope this run (resume offset ${f(REPORT_RESUME_OFFSET)}${APPLY ? " -- APPLY always rescans at 0" : ""}, ${f(totalCardsThisSlot)} total this slot, hop ${f(RESUME.hop)})`);

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  throttles (429/503/timeout)   ${f(throttleStats.count)}${throttleStats.droppedTo2 ? `   <- concurrency was DROPPED to ${THROTTLE_CONCURRENCY} for the rest of this run after ${THROTTLE_TRIP_AT} throttles` : ""}`);
  console.log(`  CH partitions scanned         ${f(stats.partitions)}   (${f(stats.otherShard)} belonging to other slots; ${f(stats.rowsRead)} rows read)`);
  console.log(`  twins-disagree pairs seen     ${f(stats.disagreePairsSeen)}`);
  console.log(`  protected                     ${f(stats.protected)}   <- verifiedByUser/flaggedWrong/excludedFromFmv/pinned; never touched`);
  console.log(`  parked-side                   ${f(stats.parkedSide)}   <- identityUnverified on either side; never touched`);
  console.log(`  RESOLVED: checklist-and-roster ${f(stats.resolvedChecklistRoster)}`);
  console.log(`  RESOLVED: more-specific-refines ${f(stats.resolvedMoreSpecific)}`);
  console.log(`  RESOLVED: grader-token-in-title ${f(stats.resolvedGraderToken)}`);
  console.log(`    winner=long                  ${f(stats.winnerLong)}`);
  console.log(`    winner=short                 ${f(stats.winnerShort)}`);
  console.log(`  LEFT: both-sides-valid         ${f(stats.bothSidesValid)}   <- both checklist-backed, neither refines the other${NAMED_AND_SPECIFIC_OPT_IN ? " (after the R1/R2 opt-in attempt below)" : ""}`);
  console.log(`  LEFT: neither-side-backed      ${f(stats.neitherSideBacked)}   <- no strict checklist row (or grader token) backs either side`);
  console.log(`  ${APPLY ? "APPLIED" : "WOULD APPLY"}                       ${f(stats.applied)}`);
  console.log(`  failed                         ${f(stats.failed)}`);
  console.log(`    duplicates left              ${f(stats.duplicatesLeft)}   <- kept row written, the long row's delete failed: the sale is in the pool twice, never lost`);
  console.log(`    stale since plan (412)       ${f(stats.staleSincePlan)}   <- the long row changed since this run's own planning read; nothing deleted`);
  console.log(`  not reached                    ${f(stats.notReached)}`);
  console.log(`\n  OWNER RULING (2026-09-21) opt-in "${NAMED_AND_SPECIFIC_TOKEN}"  ${NAMED_AND_SPECIFIC_OPT_IN ? "ON" : "off (default -- both-sides-valid pairs are only ever left)"}`);
  console.log(`  FLAGGED: base-vs-named-parallel  ${f(stats.flaggedBaseVsNamedParallel)}   <- R1: named copy keeps pricing, base copy excludedFromFmv`);
  console.log(`  FLAGGED: auto-or-num-specificity ${f(stats.flaggedAutoOrNumSpecificity)}   <- R2: more specific copy keeps pricing, plainer copy excludedFromFmv`);
  console.log(`    ${APPLY ? "APPLIED" : "WOULD APPLY"} (flag)              ${f(stats.flagApplied)}`);
  console.log(`    failed (flag)                 ${f(stats.flagFailed)}`);
  console.log(`    stale since plan (flag, 412)  ${f(stats.flagStaleSincePlan)}`);
  const flaggedTotal = stats.flaggedBaseVsNamedParallel + stats.flaggedAutoOrNumSpecificity;
  const reconciled = stats.resolvedChecklistRoster + stats.resolvedMoreSpecific + stats.resolvedGraderToken + stats.bothSidesValid + stats.neitherSideBacked + stats.protected + stats.parkedSide + flaggedTotal;
  const reconcileBalances = stats.disagreePairsSeen === reconciled;
  console.log(`  reconcile: disagree pairs seen ${f(stats.disagreePairsSeen)} == resolved+left+protected+parked+flagged ${f(reconciled)}  ${reconcileBalances ? "OK" : "MISMATCH"}`);
  if (examples.length) { console.log("  examples:"); for (const e of examples) console.log(e); }
  if (APPLY) reportWrites({ job: "resolve-disagreeing-sale-twins", intended: stats.resolvedChecklistRoster + stats.resolvedMoreSpecific + stats.resolvedGraderToken + flaggedTotal, written: stats.applied + stats.flagApplied, skipped: stats.bothSidesValid + stats.neitherSideBacked + stats.protected + stats.parkedSide, failed: stats.failed + stats.flagFailed });
  if (stopReason) console.log(`\n${stopReason}`);
  if (planFd) { try { fs.closeSync(planFd); } catch { /* best effort */ } }

  // CF-AN-UNBALANCED-RECONCILE-IS-A-BUG-NOT-A-BANNER-LINE (coordinator report
  // on run 35578577288). "disagree pairs seen" and "resolved+left+protected+
  // parked" are two independent tallies over the SAME per-pair classification
  // (see the RECONCILE FIX comment above the main loop) -- if they ever
  // disagree, either a pair is double-counted across two buckets or a bucket
  // is counting something the pair-seen tally never saw. Neither is a number
  // an operator can act on, and an APPLY run whose own banner cannot be
  // trusted must not be treated as having applied correctly just because it
  // exited 0. So this exits NON-ZERO in BOTH modes -- REPORT and APPLY alike
  // -- exactly as repoint-sales-to-sibling-product.cjs's own
  // CF-A-SALE-IS-NEVER-LOST reconciliation does for its own scanned/
  // moved+patched+refused+failed+left tally.
  if (!reconcileBalances) {
    console.error(`!! CF-AN-UNBALANCED-RECONCILE-IS-A-BUG-NOT-A-BANNER-LINE: disagree pairs seen ${f(stats.disagreePairsSeen)} != resolved+left+protected+parked+flagged ${f(reconciled)}. A pair is uncounted or double-counted. Exit 4.`);
    process.exitCode = 4;
  }
}

if (require.main === module) // CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809).
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message);
    await finishLane(3);
  });
