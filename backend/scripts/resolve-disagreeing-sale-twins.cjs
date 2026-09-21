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
const f = (n) => Number(n ?? 0).toLocaleString();
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };

// ── pure ───────────────────────────────────────────────────────────────────

const normParallelForRung = (p) => String(p ?? "").trim().toLowerCase().replace(/\s+/g, " ") || "base";
const normNumber = (n) => String(n ?? "").trim().toLowerCase();

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
  return { sport: parsed.sport, year: parsed.year, setKey: parsed.setKey, cardNumber: parsed.cardNumber, parallel: parsed.parallel, isAuto: parsed.isAuto };
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

  const titlePrintRun = deps.extractPrintRunFromTitle(title);
  if (titlePrintRun && !candidateParsed.printRun) {
    return { moreSpecific: true, evidence: `title states a print run (/${titlePrintRun}) the candidate identity does not carry` };
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
  buildResolution, normParallelForRung, normNumber,
  __setSweepDepsForTest: (d) => { SWEEP_DEPS = d; },
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
  const cards = [];
  {
    const it = pool.items.query({ query: `SELECT DISTINCT VALUE c.cardId FROM c WHERE c.source = 'cardhedge' AND RegexMatch(c.id, "^cardhedge::ch-daily::.*::.*::[0-9]+$")` }, { maxItemCount: 500 });
    while (it.hasMoreResults()) { const { resources } = await retry(() => it.fetchNext()); for (const id of resources ?? []) if (id) cards.push(String(id)); }
  }
  console.log(`  ${f(cards.length)} CH cards carry a long-id-shaped row (same population as the sweep lane)`);

  const stats = {
    partitions: 0, otherShard: 0, rowsRead: 0,
    disagreePairsSeen: 0, protected: 0, parkedSide: 0,
    resolvedChecklistRoster: 0, resolvedMoreSpecific: 0, resolvedGraderToken: 0,
    bothSidesValid: 0, neitherSideBacked: 0,
    winnerLong: 0, winnerShort: 0,
    applied: 0, failed: 0, duplicatesLeft: 0, staleSincePlan: 0, alreadyGone: 0, notReached: 0,
  };
  const examples = [];
  let stopReason = null, i = 0;

  const deps = {
    playerIdentityKey, titleContradictsTarget, statedFinishFromChecklist,
    sameCardNumber, parseGradeFromTitle,
    readVariationFromTitle, insertSetNamedInTitle, isRegisteredProduct,
    extractPrintRunFromTitle, extractYearFromTitle, inferSetKeyFromTitle,
    productAncestry, slugify, guardSoldCompDoc,
    checklistRowsByNumber: () => new Map(), // placeholder; real cache-backed fn bound per-partition below
  };

  for (const cardId of cards) {
    if (LIMIT && stats.partitions >= LIMIT) { stats.notReached += cards.length - i; break; }
    if (budgetLeft() < RESERVE_MS) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget`; stats.notReached += cards.length - i; break; }
    i++;
    if (SLOTS > 1 && shardOf(cardId) !== SLOT) { stats.otherShard++; continue; }
    stats.partitions++;

    const rows = [];
    const it = pool.items.query({ query: "SELECT * FROM c WHERE c.cardId = @id AND c.source = 'cardhedge'", parameters: [{ name: "@id", value: cardId }] }, { partitionKey: cardId, maxItemCount: 500 });
    while (it.hasMoreResults()) { const { resources } = await retry(() => it.fetchNext()); for (const r of resources ?? []) rows.push(r); }
    stats.rowsRead += rows.length;

    const longRows = rows.filter((r) => parseLongSyntheticId(r.id));
    const shortRows = rows.filter((r) => isCanonicalChDailyId(r.id));
    if (!longRows.length || !shortRows.length) continue; // nothing to disagree about in this partition

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

    // Bind this partition's checklist cache lookup: parses the slug's
    // (sport, year, setKey) and loads it (cached across the whole run, not
    // per pair).
    deps.checklistRowsByNumber = (parsed) => {
      if (!parsed) return new Map();
      // Synchronous surface over an async cache load is not possible here,
      // so the cache is PRE-WARMED per candidate pair below instead; this
      // placeholder exists only for the module-level export's default.
      return cache.get(`${parsed.sport}|${parsed.year}|${parsed.setKey}`) ?? new Map();
    };

    for (const long of longRows) {
      // PLAN_OUT gets protected/parked-side rows too (coordinator review of
      // #2381, LOW) -- same auditability doctrine as the sweep lane's own
      // emitPlanRow calls for these classes; a REPORT that silently drops
      // them cannot be audited row by row before the matching APPLY runs.
      if (isProtected(long)) { stats.protected++; emitPlanRow("protected", null, long, null, { reason: "long-row-pinned-or-flagged" }); continue; }
      if (isParkedSide(long)) { stats.parkedSide++; emitPlanRow("parked-side", null, long, null, { reason: "long-row-parked" }); continue; }
      const parsedId = parseLongSyntheticId(long.id);
      const candidateShorts = shortRows.filter((s) => cents(s.price) === Math.round(Number(parsedId.priceCents) || NaN));
      for (const short of candidateShorts) {
        if (isProtected(short)) { stats.protected++; emitPlanRow("protected", null, long, short, { reason: "short-row-pinned-or-flagged" }); continue; }
        if (isParkedSide(short)) { stats.parkedSide++; emitPlanRow("parked-side", null, long, short, { reason: "short-row-parked" }); continue; }
        const d = decideSyntheticTwin(long, short, { dayCounts, longDayCounts });
        if (d.verdict !== "twins-disagree") continue;
        stats.disagreePairsSeen++;

        // PRE-WARM the checklist cache for both sides' cells before calling
        // the pure resolver -- one Cosmos round trip per (sport,year,setKey)
        // per run, never per pair, via the MRU cache above.
        for (const hiq of [long.hobbyiqCardId, short.hobbyiqCardId]) {
          const parsed = parseHobbyIqCardId(String(hiq ?? ""));
          if (parsed) await loadChecklistRowsByNumber(cat, parsed.sport, parsed.year, parsed.setKey);
        }
        deps.checklistRowsByNumber = (parsed) => {
          if (!parsed) return new Map();
          return cache.get(`${parsed.sport}|${parsed.year}|${parsed.setKey}`) ?? new Map();
        };

        const resolution = resolveDisagreement(deps, d.axis, long, short);
        if (resolution.verdict === "both-sides-valid") {
          stats.bothSidesValid++;
          if (examples.length < 30) examples.push(`  BOTH-SIDES-VALID  ${cardId}  long=${long.id} short=${short.id}: ${resolution.detail}`);
          emitPlanRow("left", null, long, short, { verdict: "both-sides-valid", detail: resolution.detail, axis: d.axis });
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

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  CH partitions scanned         ${f(stats.partitions)}   (${f(stats.otherShard)} belonging to other slots; ${f(stats.rowsRead)} rows read)`);
  console.log(`  twins-disagree pairs seen     ${f(stats.disagreePairsSeen)}`);
  console.log(`  protected                     ${f(stats.protected)}   <- verifiedByUser/flaggedWrong/excludedFromFmv/pinned; never touched`);
  console.log(`  parked-side                   ${f(stats.parkedSide)}   <- identityUnverified on either side; never touched`);
  console.log(`  RESOLVED: checklist-and-roster ${f(stats.resolvedChecklistRoster)}`);
  console.log(`  RESOLVED: more-specific-refines ${f(stats.resolvedMoreSpecific)}`);
  console.log(`  RESOLVED: grader-token-in-title ${f(stats.resolvedGraderToken)}`);
  console.log(`    winner=long                  ${f(stats.winnerLong)}`);
  console.log(`    winner=short                 ${f(stats.winnerShort)}`);
  console.log(`  LEFT: both-sides-valid         ${f(stats.bothSidesValid)}   <- both checklist-backed, neither refines the other`);
  console.log(`  LEFT: neither-side-backed      ${f(stats.neitherSideBacked)}   <- no strict checklist row (or grader token) backs either side`);
  console.log(`  ${APPLY ? "APPLIED" : "WOULD APPLY"}                       ${f(stats.applied)}`);
  console.log(`  failed                         ${f(stats.failed)}`);
  console.log(`    duplicates left              ${f(stats.duplicatesLeft)}   <- kept row written, the long row's delete failed: the sale is in the pool twice, never lost`);
  console.log(`    stale since plan (412)       ${f(stats.staleSincePlan)}   <- the long row changed since this run's own planning read; nothing deleted`);
  console.log(`  not reached                    ${f(stats.notReached)}`);
  const reconciled = stats.resolvedChecklistRoster + stats.resolvedMoreSpecific + stats.resolvedGraderToken + stats.bothSidesValid + stats.neitherSideBacked + stats.protected + stats.parkedSide;
  console.log(`  reconcile: disagree pairs seen ${f(stats.disagreePairsSeen)} == resolved+left+protected+parked ${f(reconciled)}  ${stats.disagreePairsSeen === reconciled ? "OK" : "MISMATCH"}`);
  if (examples.length) { console.log("  examples:"); for (const e of examples) console.log(e); }
  if (APPLY) reportWrites({ job: "resolve-disagreeing-sale-twins", intended: stats.resolvedChecklistRoster + stats.resolvedMoreSpecific + stats.resolvedGraderToken, written: stats.applied, skipped: stats.bothSidesValid + stats.neitherSideBacked + stats.protected + stats.parkedSide, failed: stats.failed });
  if (stopReason) console.log(`\n${stopReason}`);
  if (planFd) { try { fs.closeSync(planFd); } catch { /* best effort */ } }
}

if (require.main === module) // CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809).
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message);
    await finishLane(3);
  });
