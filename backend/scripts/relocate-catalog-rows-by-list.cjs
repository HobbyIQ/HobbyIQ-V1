#!/usr/bin/env node
/**
 * CF-THE-LIST-IS-THE-SCOPE, for card_catalog (2026-09-06).
 *
 * The catalog twin of relocate-pool-rows-by-list. It acts on the card_catalog
 * rows named EXPLICITLY in a committed list file, and on nothing else. A row
 * not in the file is never touched, so this lane cannot widen by accident the
 * way a `WHERE source = ...` sweep can -- which is exactly the accident this
 * lane was written to avoid.
 *
 * WHY IT EXISTS. The sportscardchecklist Bowman's Best incident asked for a
 * retire of 60 catalog rows scoped by (source, sport, year, setKey). Measured
 * read-only 2026-09-06, that predicate selects 292 rows in baseball/1997/
 * bowmans-best and 320 in basketball/1997/topps-stadium-club -- because the
 * SAME dated ingest wrote both the wrong rows and hundreds of correct ones
 * into the same product. Retiring on it would have taken out 232 Bowman's
 * Best and 240 Stadium Club rows, Michael Jordan among them. No predicate
 * available to a lane separates them; a reviewed list of ids does.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT "RETIRE" HAS TO MEAN HERE, AND WHY IT IS A DELETE
 * ────────────────────────────────────────────────────────────────────────────
 *
 * This is the load-bearing decision in this file, so it is written out.
 *
 * The pool lane's retire is a MARKER: it sets `flaggedWrong`, and that works
 * there because `flaggedWrong` is a field every FMV read already excludes
 * (exactPoolReader, tieredMomentum, treeGradeCurve, unifiedPricing,
 * hobbyIqFmv, and a dozen more). card_catalog has NO equivalent field, and
 * that is deliberate. catalogVisibility.ts:23-25 states the rule:
 *
 *     Every state is MATCHABLE. Sold comps roll up to verified, provisional
 *     and even excluded rows alike -- matching is about coverage, and an
 *     imperfect identity still beats an orphaned sale. Only VISIBILITY is
 *     tiered. Match paths (catalogVerify, resolveSetKey, checklistNarrow,
 *     catalogMatcher) read everything and must not use this module.
 *
 * Verified by reading every match path: catalogMatcher's point read and its
 * four candidate queries (Steps 2, 2b, 2c, 3), catalogIdentityResolver's stem
 * query, catalogVerify's two queries and resolveSetKey's one all filter on
 * IDENTITY fields only -- sport, year, setKey, cardNumber, isAuto, parallel,
 * playerName/playerSlug, id prefix. Not one of `retired`, `retiredAt`,
 * `supersededBy`, `deletedAt`, `isActive`, `status`, `tombstone`,
 * `excludedFromMatch` appears in any of them; `verificationStatus` is read
 * only by SEARCH; `flaggedWrong` and `identityUnverified` are sold_comps
 * fields. The single provenance field a matcher reads is `source`, and it
 * only ever demotes a VOTE (resolveSetKey) or breaks a TIE among numbered
 * twins (catalogIdentityResolver) -- it never removes a candidate from the
 * queries that return `best.id` and rebind sales.
 *
 * So: a soft label on a catalog row is a NO-OP for matching. A row stops
 * resolving when, and only when, it stops existing. This lane therefore
 * retires by DELETE, through catalogRowOps.retireCatalogRow -- the same
 * primitive every other `retire-*` catalog lane uses.
 *
 * THE COST LINE, STATED RATHER THAN DISCOVERED LATER. retireCatalogRow
 * deletes the row's graded children and then the row, and it re-points
 * NOTHING: its own docblock says "Nothing is stamped on the sales that
 * pointed here -- they are unplaced now, and the rematch owns unplaced
 * sales." That is the designed contract, not an oversight. Every entry in a
 * retire list is therefore also a decision to hand that row's sales to the
 * rematch, and the banner counts them so the size of that hand-off is visible
 * BEFORE the apply, not inferred from a pool query afterwards.
 *
 * THE ALTERNATIVE WAS REJECTED ON BLAST RADIUS. Adding an exclusion predicate
 * to the match paths would touch six live queries on the hottest read path in
 * the product, would need catalogQuerySchema.test.ts extended for a new field,
 * and would silently change the resolution of every row anyone had ever
 * flagged for any reason. A 140-row cleanup does not get to reshape the
 * matcher. If a soft-retire tier is ever wanted, it is its own change with its
 * own census -- not a side effect of this one.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TWO SHAPES
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   retire   the row should not exist. Deleted via retireCatalogRow (graded
 *            children first, then the row). Its sales become unplaced and are
 *            counted in the banner.
 *
 *   reslug   the row is a real card at the wrong address. Moved via
 *            moveCatalogRow to `to`: copy, re-point that row's sales, retire
 *            the old slug's graded children, delete the old row -- in that
 *            order, so no sale is ever dangling. If `to` is occupied by a
 *            DIFFERENT card the entry is REFUSED and counted, never merged:
 *            an occupied address is a collision to report, not to route
 *            around.
 *
 *   park     the row is at the right address but we do not know it is the
 *            right CARD. Nothing moves and nothing is deleted: the row is
 *            stamped `identityUnverified: true` plus an
 *            `identityUnverifiedReason`, through patchCatalogRowFields.
 *            Its sales stay exactly where they are.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY PARK EXISTS, AND WHAT IT HONESTLY DOES (Drew, 2026-09-08)
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The immaculate-01 list refused 13 reslugs as `occupied`. Point reads split
 * them: ONE was the same card (folded to a retire, #1999) and TWELVE named two
 * DIFFERENT players -- a hobbymonitor row moving onto an address a
 * checklist-backed row already held, with the two sources disagreeing about
 * which player owns which number.
 *
 * Neither existing shape answers that. A RETIRE deletes a row we have no
 * evidence is wrong -- only unconfirmed -- and hands its sales to the rematch,
 * which would re-derive them onto the same contested numbering. A RESLUG is
 * the collision itself. Drew's ruling is the third answer:
 *
 *     "the checklist decides the number -- the 12 cross-player hobbymonitor
 *      rows are PARKED identityUnverified (they stop resolving/pricing until a
 *      source confirms them; sales stay with them unpriced)."
 *
 * WHAT THE STAMP IS, STATED PLAINLY RATHER THAN OVERSOLD. `identityUnverified`
 * is the vocabulary `identityBacking.ts` already owns for "an identity we
 * decline to price", and `initialsCollisionPark` / `makerlessCatchAll` use it
 * for exactly this shape: we will not guess between two players, because FMV
 * is the projected next sale from a pool and a wrong pool is a wrong price,
 * silently, forever.
 *
 * BUT THE HONEST LIMIT, WRITTEN DOWN BECAUSE THIS FILE'S OWN HEADER ALREADY
 * ARGUES IT. Read the retire rationale above: catalog match paths filter on
 * IDENTITY fields only, and no `retired`/`flaggedWrong`/`identityUnverified`
 * predicate appears in any of them. So this stamp does NOT by itself stop a
 * catalog row being returned by the matcher today -- on card_catalog it is a
 * LABEL and an acquisition work item, which is precisely what
 * `IDENTITY_UNVERIFIED`'s own docblock calls it ("a LABEL and an acquisition
 * work item, never a judgement that the card is fake"). The consumer that
 * enforces it on the SALES side is soldCompsStore's `identityParked`.
 *
 * That limit is a reason to write the stamp, not to skip it: the ruling is
 * recorded on the row, the acquisition queue can find it, and the enforcement
 * predicate -- if one is ever wanted on the catalog read path -- is its own
 * change with its own census and blast radius, exactly as this file argues
 * for the retire. A 12-row ruling does not get to reshape the matcher.
 *
 * WHY NOT A DELETE, ONE MORE TIME. The 12 rows may well be RIGHT; what is
 * unproven is the numbering. Deleting a possibly-correct row orphans real
 * sales with no way back, which is the same reasoning
 * `RETIRED_SUPERSEDED_BY_CHECKLIST` records for the self-derived lane. Park
 * keeps the row, keeps the sales with it, and prices nothing until a source
 * confirms the number.
 *
 * ORDER WITHIN A LIST IS THE AUTHOR'S. Entries are applied top to bottom, so a
 * list that must vacate an alias address before reslugging onto it says so by
 * putting the retire first. The lane does not reorder.
 *
 * REPORT FIRST, AND THE REPORT RUNS THE APPLY'S DERIVATION. Without
 * BACKFILL_APPLY=true this prints the whole plan -- every id, its current
 * address, its intended fate, and the evidence recorded in the file -- and
 * writes nothing.
 *
 * "Writes nothing" is NOT the same as "computes nothing", and conflating them
 * is what produced the 2026-09-07 incident: the report counted every reslug a
 * success before moveCatalogRow was ever called, reconciled 148/148, and the
 * apply of the same list on the same rows then FAILED 91 of them on a
 * derivation the report had never run. A report that cannot predict its apply
 * is worse than no report -- it is a green light for a write that will not
 * happen. So the reslug path now makes ONE moveCatalogRow call for both modes,
 * with `dryRun: !APPLY`: read everything, derive everything, write only when
 * armed. Anything moveCatalogRow would refuse, the report refuses too.
 *
 * The same day proved the point twice. The Crown Zenith Galarian Gallery list
 * (292 EN->EN reslugs) reported 292/292 and applied 0, failing every row on
 * "newSlug is not a hiq slug" -- a VALIDATION refusal, nothing to do with the
 * market guard or with occupancy. A report that skips the derivation cannot
 * predict ANY of the three, which is why the fix is one shared call rather
 * than three mirrored checks that would drift apart again.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT HAPPENS TO A ROW'S SALES, STATED PER SHAPE -- AND `keepSales`
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The two shapes do OPPOSITE things to the sold_comps rows that point at the
 * slug being acted on, and neither of them is "nothing". Written out because a
 * list author picks a shape and inherits a sales decision with it:
 *
 *   retire   sales are LEFT WHERE THEY ARE, pointing at a slug that no longer
 *            resolves. retireCatalogRow's own docblock: "Nothing is stamped on
 *            the sales that pointed here -- they are unplaced now, and the
 *            rematch owns unplaced sales." The banner counts them as
 *            `sales made UNPLACED`. It is not a re-point and not a delete: the
 *            hobbyiqCardId keeps its old value and the address behind it is
 *            gone, so the rematch is the only thing that can place them again.
 *
 *   reslug   sales FOLLOW THE ROW, by default. moveCatalogRow patches every
 *            sale at the old slug -- `/hobbyiqCardId` to the new slug, plus
 *            `/reslugedFrom`, `/reslugedReason`, `/reslugedAt`. It does this
 *            whenever the caller hands it `salesContainer`, which this lane
 *            always did.
 *
 * THAT DEFAULT IS RIGHT FOR A MOVE AND WRONG FOR A DISENTANGLEMENT, and the
 * difference is whose sales they are. A reslug that corrects ONE card's address
 * -- a renumber, a parallel spelling, a key rename -- moves the card, and the
 * card's own sales belong at its new address. But a reslug that SEPARATES TWO
 * CARDS that were sharing one address moves only one of them, and the sales
 * resting there were never the moving card's: they belong to the card that
 * stays. Carrying them along would take a real sale off the identity that
 * actually sold and attach it to one that did not.
 *
 * #1925 is that second shape, measured: 141,304 hobbymonitor rows are the
 * year-N product carrying `year` = N+1, so they sit inside the year-N+1
 * product's numbering -- and the 7,905 sales resting on their slugs have
 * titles that are 7,901-to-0 year N+1. Those are the OTHER card's sales. Move
 * the rows to year N with the default on and 7,905 genuine 2025 sales get
 * carried back to 2024, which is the mispricing this repair exists to end,
 * inflicted a second time by the repair itself.
 *
 * So the list may say so, per file or per entry:
 *
 *     "keepSales": true          at the top level, or on one entry
 *     "repointSales": false      the same statement, spelled the other way
 *
 * An entry's own value wins over the file's; absent at both levels the default
 * is unchanged (sales follow the row), so every existing list behaves exactly
 * as it did. Under the flag a reslug hands moveCatalogRow NO `salesContainer`,
 * which is the documented way to tell it the caller owns the sales -- the row
 * moves, the sales' `hobbyiqCardId` and `cardId` are not touched, and they stay
 * at the year-N+1 address for the rematch to re-derive against the genuine
 * year-N+1 identity. The banner counts them as `sales LEFT BEHIND` so the size
 * of that hand-off is as visible as the retire's is.
 *
 * IT IS NOT A SUPPRESSION OF THE WRITE, IT IS A STATEMENT OF OWNERSHIP. The
 * flag never makes a sale disappear and never marks one wrong. It says the
 * sales at this address are not this row's to carry, which is exactly what the
 * evidence says when a list separates two cards.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE BUDGET, AND THE RUN THAT ADDED IT
 * ────────────────────────────────────────────────────────────────────────────
 *
 * CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS, arriving late to this lane.
 *
 * Run 34079952456 -- APPLY over 2026-09-07-soccer-2022-panini-prizm-bare-key
 * .json, 13,295 entries (11,630 retires + 1,665 reslugs) -- was KILLED:
 *
 *   ##[error] The action 'Run backfill (APPLY)' has timed out after 150 minutes
 *
 * with no budget marker, no reconcile, no finishLane line. #1913's KILLED
 * branch fired and withheld the re-dispatch, which is the correct behaviour
 * for an unexplained kill -- but the kill was not unexplained. It was
 * arithmetic.
 *
 * THE DEFECT WAS NOT A MISPLACED CHECK. IT WAS THE ABSENCE OF ONE. This lane
 * never required scripts/lib/runner-budget.cjs at all: no `budget()`, no
 * `outOfClock()`, no `stoppedAtBudget()` marker, no `finishLane()`. It looped
 * over every entry in the file and printed its banner only after the last one.
 * runnerBudgetMargin's census could not have caught this, because its loader
 * skips any script matching neither RUN_MINUTES nor BUDGET_MS -- a lane with
 * NO budget was not a failing lane, it was an invisible one. That hole is
 * closed in the pin as part of this change: a whitelisted lane that WRITES
 * must declare a budget, and the census now says so by name.
 *
 * WHY THE REPORT FINISHED AND THE APPLY COULD NOT. Both modes are measured,
 * from the two runs' own logs:
 *
 *   REPORT 34077554971  11,630 retires in   886s = 0.076 s/row  (13.1 rows/s)
 *   APPLY  34079952456   4,935 retires in 9,010s = 1.826 s/row  ( 0.55 rows/s)
 *
 * The report is not doing less READING -- it runs the same `salesAt` count and
 * the same moveCatalogRow derivation under dryRun. What it does not run is the
 * WRITE half: retireCatalogRow (a graded-children sweep plus the delete) and
 * the read-back that confirms it. That is 1.75 s/row this list never budgeted
 * for. At 1.826 s/row, 13,295 entries need ~6.7 HOURS: 2.7x the 150-minute
 * ceiling. No arrangement of a budget check makes this list finish in one
 * step -- it was structurally impossible, and a lane without a budget had no
 * way to say so.
 *
 * AND #1940's confirmRetired IS NOT THE CAUSE, which is worth stating because
 * it is the obvious suspect. Its three reads plus backoff plus cross-partition
 * query only escalate past the FIRST point read when that read still sees the
 * row. Run 34079952456 printed `read-back needed a retry` exactly 0 times
 * across 4,935 retires: every confirm settled on the first point-read, i.e. at
 * one read's cost. The backoff path was never entered. The cost is the delete
 * and its cascade, which predate #1940.
 *
 * SO THE FIX IS TWO THINGS, AND BOTH ARE NEEDED. A budget alone would turn a
 * red kill into a green stop that relaunches ~4 times to finish one file --
 * correct, but slow, and each relaunch re-reads the whole list from the top.
 * A split alone would let the current lane finish, and leave the next
 * oversized list to be killed exactly as this one was. So: this lane now
 * budgets, marks, exits and relaunches (below), AND the two oversized
 * committed lists are split into <=2,000-entry chunks in the same change.
 *
 * WHAT A UNIT COSTS, AND THEREFORE WHAT IS RESERVED. A unit here is ONE
 * ENTRY, and the measurement above sizes it: 1.826 s/row for a retire.
 * A reslug is dearer -- an extra destination read, a moveCatalogRow write and
 * a two-read verify -- so the reserve is set to 30s, roughly 16x the measured
 * worst entry. That is deliberately generous, because the reserve's job is to
 * be larger than the slowest single entry a throttled container can produce,
 * and it costs only 30 seconds of a 15-minute margin to be sure of it.
 *
 * IDEMPOTENT, SO THE RELAUNCH IS FREE. A relaunch re-reads the list from
 * entry 0 and re-derives every one. A retire whose row is already gone is
 * counted `already gone` and skipped -- never re-deleted, never counted as
 * written. A reslug whose source has moved is `NOT FOUND` and skipped. So the
 * continuation costs one cheap point read per finished entry (~0.076 s/row,
 * measured above) and writes only what is left. No resume cursor is needed
 * and no repair list is ever required after a kill.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY/APPLY; SCOPE=<list file>
 *      (path relative to backend/; REQUIRED -- this lane has no default list);
 *      RUN_MINUTES (default 110), RESERVE_MS, VERIFY_MS.
 */
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const backend = path.resolve(__dirname, "..");
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
// The ONE name reduction the survivor rule and the corroboration arms use.
// Loaded defensively (see lib/player-identity.cjs): a tree-less run falls back
// to the legacy expression rather than failing to load.
const { playerIdentityKey, identityKeyIsBuilt } = require(path.join(__dirname, "lib", "player-identity.cjs"));
// The dist/ and Cosmos requires live inside main(), as the pool lane does it:
// loading this module must not need a built tree, so the runner contract test
// can require it and drive the scope refusal without a compile step.

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";

// CF-A-WHOLE-SCOPE-WRITE-REFUSES-WITHOUT-ITS-SCOPE (D-06, R3).
//
// `scope` is shared with every other lane on this runner and carries THEIR
// vocabulary ("refractor", "all", a product key). A scope that does not name a
// list is a REFUSAL.
//
// AND UNLIKE THE POOL LANE, THERE IS NO DEFAULT. The pool lane may fall back to
// its one documented population when SCOPE is absent. This lane must not: it
// DELETES catalog rows, the runner's own default for `scope` is the string
// "refractor", and a lane that deletes must never be one empty input away from
// running a list nobody named. Absent scope is fatal.
const RAW_SCOPE = String(process.env.SCOPE || "").trim();
const SCOPE_ERROR = (() => {
  if (!RAW_SCOPE) {
    return "FATAL: SCOPE is empty. This lane DELETES catalog rows and has no default list — "
      + "name the committed .json list to run (e.g. SCOPE=data/catalog-relocations/<file>.json).";
  }
  if (!RAW_SCOPE.endsWith(".json")) {
    return `FATAL: SCOPE="${RAW_SCOPE}" does not name a list file. This lane's scope is a `
      + "committed .json list of row ids — never a predicate, a product key, or another "
      + "lane's vocabulary.";
  }
  return null;
})();
const SCOPE = RAW_SCOPE;
const f = (n) => Number(n).toLocaleString();

/**
 * An entry names ONE shape, and the shape is stated by `action` rather than
 * inferred from which fields happen to be present -- inference is how a typo'd
 * key becomes a silent no-op.
 *
 * Returns { ok, action, reason } where a falsy `ok` carries the refusal text.
 */
function classifyEntry(e) {
  const id = String(e?.id ?? "").trim();
  const action = String(e?.action ?? "").trim();
  const to = String(e?.to ?? "").trim();
  const reason = String(e?.reason ?? "").trim();
  if (!id) return { ok: false, why: "entry has no id" };
  if (!id.startsWith("hiq:")) return { ok: false, why: `id is not a hiq slug: ${id.slice(0, 60)}` };
  if (action !== "retire" && action !== "reslug" && action !== "park") {
    return { ok: false, why: `action must be "retire", "reslug" or "park", got ${JSON.stringify(e?.action ?? null)}` };
  }
  // The reason is what a reviewer reads in the diff and what the write stamps.
  // An unexplained delete is not reviewable.
  if (!reason) return { ok: false, why: `entry has no reason: ${id.slice(0, 60)}` };
  if (action === "reslug") {
    if (!to) return { ok: false, why: `reslug entry has no "to": ${id.slice(0, 60)}` };
    if (!to.startsWith("hiq:")) return { ok: false, why: `"to" is not a hiq slug: ${to.slice(0, 60)}` };
    if (to === id) return { ok: false, why: `reslug "to" equals the id: ${id.slice(0, 60)}` };
  } else if (to) {
    // A PARK AND A RETIRE BOTH STAY PUT, so neither may name a destination.
    // A `to` on a park is a list author reaching for the reslug they were
    // told not to write, and it is refused rather than ignored: silently
    // dropping a stated destination is how a rejected move becomes a
    // no-op nobody notices.
    return { ok: false, why: `${action} entry must not name a "to": ${id.slice(0, 60)}` };
  }
  return { ok: true, id, action, to, reason };
}

/**
 * Is the row at the destination the SAME card, or a different one?
 *
 * A reslug onto an address held by the same card (a re-run, or a graded child
 * regenerated meanwhile) is a fold moveCatalogRow can adjudicate. A reslug onto
 * a DIFFERENT player's card is the collision that produced this whole incident,
 * and it is refused rather than merged: two cards must never share a pricing
 * address, and picking a winner here would be picking one by accident.
 *
 * WHY THIS LANE IS NOT WIRED TO `playerEvidence` (CF-A-FOLD-NEVER-CHANGES-THE-
 * PLAYER, the evidence half). The other three fold lanes now gather corroboration
 * so a different-player collision can RESOLVE instead of always refusing. This
 * one deliberately does not, because this guard is STRICTER than the evidence
 * rule and must stay that way: it refuses every different-player destination,
 * including one the market would corroborate. Handing it evidence would let a
 * corroborated pair through and turn a refusal into a write -- WEAKENING a guard
 * on a lane that acts from a human-curated list and DELETES the source row.
 * There is no ambiguity here for evidence to settle: a curated list that names a
 * destination already occupied by another player is a mistake in the list, and
 * the answer is to report it to the human who wrote it.
 */
/** The setKey segment of a hiq slug, or "" when it is not one. */
function idSetKey(slug) {
  const parts = String(slug ?? "").split(":");
  return parts.length >= 5 && parts[0] === "hiq" ? parts[3] : "";
}

/**
 * The `changedFields` a reslug must pass to moveCatalogRow.
 *
 * moveCatalogRow separates two populations by ONE question: did the caller ASK
 * to change the product? A FOLD (renumber, parallel fix) asks for nothing and
 * its destination stem must equal the row's own; a RENAME names the product it
 * is moving to and is allowed to land there. A curated list states the whole
 * destination slug, so it answers that question by construction: when the
 * destination's stem differs from the id's, this entry IS a rename and must
 * say so. Returning `{}` for a same-stem move keeps every fold on the strict
 * path, unchanged.
 *
 * Nothing is invented here -- the key is read off the destination the list
 * author wrote, never re-derived from setName, and the market guard still has
 * to agree before it is used.
 */
function crossProductFields(id, to) {
  const from = idSetKey(id);
  const dest = idSetKey(to);
  return dest && from && dest !== from ? { setKey: dest } : {};
}

/**
 * Does this entry keep its sales where they are, rather than carrying them to
 * the new slug?
 *
 * Two spellings, because a list author reaches for whichever reads right in
 * the file, and they mean the same thing: `keepSales: true` and
 * `repointSales: false`. An ENTRY's own statement wins over the FILE's, so a
 * list can set the shape once at the top and dissent on the rows that differ.
 *
 * ABSENT IS NOT FALSE, AND THAT IS THE WHOLE CONTRACT. Silence at both levels
 * returns `false` -- sales follow the row, exactly as every list committed
 * before this flag existed behaves. A new option that quietly changed the
 * meaning of the eight lists already on disk would be a far worse defect than
 * the one it fixes, so the default is pinned by a test rather than left to
 * read right.
 *
 * The two spellings are read INDEPENDENTLY and either one is enough. They are
 * not checked for agreement: a file that says `keepSales: true` and an entry
 * that says `repointSales: true` is the entry dissenting, and the entry wins
 * on both keys alike.
 */
function keepsSales(entry, doc) {
  const read = (o) => {
    if (!o || typeof o !== "object") return null;
    if (typeof o.keepSales === "boolean") return o.keepSales;
    if (typeof o.repointSales === "boolean") return !o.repointSales;
    return null;
  };
  const own = read(entry);
  if (own !== null) return own;
  const file = read(doc);
  return file === null ? false : file;
}

/**
 * Does a row already at the destination name a DIFFERENT card than the row
 * being moved?
 *
 * ── THE COMPARE IS playerIdentityKey, NOT A RAW LOWERCASE (#1953) ───────────
 *
 * This used to reduce both names with
 *
 *     String(r?.playerName ?? "").trim().toLowerCase()
 *
 * and ask `a !== b`. That is the pre-fix expression `playerIdentityKey.ts`
 * exists to replace, and on the #1930 shapes it calls one card two cards:
 *
 *   "Team Magma's Camerupt" vs "Team Magma’s Camerupt"   curly apostrophe
 *   "Mr. Mime"              vs "Mr Mime"                 punctuation
 *   "Flabébé"               vs "Flabebe"                 accent
 *   "Suicune ☆"             vs "Suicune Star"            identity symbol
 *   "Nidoran♀"              vs "Nidoran F"               gender symbol
 *   "Miracle Sphere α"      vs "Miracle Sphere Alpha"    Greek suffix
 *
 * Each of those refused as `occupied`, and #1953 settled 138 of them BY HAND --
 * reading tcgdex per pair to confirm what orthography alone could have said.
 * The reduction now comes from `lib/player-identity.cjs`, which loads the ONE
 * key the survivor rule and the corroboration arms already use. A lane that
 * disagrees with the survivor rule about who two rows name is worse than a lane
 * that refuses, so there is exactly one answer to the question.
 *
 * ── WHAT DID NOT CHANGE: A DIFFERENT KEY STILL REFUSES ─────────────────────
 *
 * "Todd Hundley" and "Derek Jeter" reduce to two keys and this still refuses.
 * An occupied address is a COLLISION to report, never to route around, and
 * folding it would put two cards' sales in one pricing pool. This change makes
 * the compare see through SPELLING, and nothing else.
 *
 * An unnamed side still refuses. Blank is unknown, never "the same", which is
 * the safe direction for a delete-bearing lane.
 *
 * ── A SUPERSET IS NOT A FOLD, AND THIS LANE MAY NOT DECIDE IT ──────────────
 *
 * "Jolteon" vs "Jolteon δ" is the shape that tempts a containment rule, and a
 * containment rule is exactly the "right guard, wrong scope" error.
 * `playerIdentityKey.ts`'s own header draws this line: A SUFFIX IS NOT AN
 * ACCENT. Whether the bare row is a truncated transcription of the δ card or a
 * genuinely different card at the same number is a question about the product's
 * CHECKLIST, and this lane has no checklist -- #1953 answered its supersets by
 * reading tcgdex, which is the right way and not one available here.
 *
 * So a containment pair is still REFUSED, but it is refused by its own name --
 * `name-superset` -- rather than being lumped in with a genuine collision. The
 * two need different actions from an operator: a collision is a numbering bug
 * to fix, a superset is a checklist lookup that resolves to a fold or a split.
 * Reporting them as one number is what made 138 hand-adjudications look like
 * 138 collisions.
 *
 * @returns {false | {reason: string, hint: string}} false when the destination
 *          is free or holds THIS card; otherwise the refusal, named.
 */
function occupancyRefusal(incumbent, row) {
  if (!incumbent) return false;
  const display = (r) => String(r?.playerName ?? "").trim();
  const a = playerIdentityKey(display(incumbent));
  const b = playerIdentityKey(display(row));
  // An unnamed side cannot be adjudicated either way. Blank is unknown, never
  // "the same", so an unnamed incumbent is treated as a different card and
  // refused -- the safe direction for a delete-bearing lane. A name that
  // reduces to nothing (punctuation only) is unknown by the same argument.
  if (!a || !b) {
    return {
      reason: "occupied: unnamed",
      hint: "one side has no usable playerName — blank is unknown, never 'the same'",
    };
  }
  // The same card under two spellings. THE fold this change exists to allow.
  if (a === b) return false;
  // Containment: one key is the other plus a suffix. NOT folded here — only a
  // checklist can say whether the suffix is a different card. See the header.
  if (a.startsWith(b) || b.startsWith(a)) {
    return {
      reason: "occupied: name-superset",
      hint: "one name is the other plus a suffix — a checklist twin decides whether this is a fold or two cards; this lane does not guess",
    };
  }
  return {
    reason: "occupied: different card",
    hint: "two different names at one address — a collision to report, never to route around",
  };
}

/** The boolean face of `occupancyRefusal`, kept because "is this occupied?" is
 *  the question most callers ask and a truthy object answers it directly. */
function occupiedByDifferentCard(incumbent, row) {
  return occupancyRefusal(incumbent, row) !== false;
}

/**
 * CF-A-READ-BACK-THAT-LAGS-IS-NOT-A-FAILED-DELETE (2026-09-07).
 *
 * The retire verifies by READ, and that stays: a delete is never believed on
 * its own word. But the FIRST read is not the last word either. On 2026-09-07
 * the two hobbymonitor donruss-optic applies -- runs 34077802430 (RETIRED 999,
 * failed 1) and 34086888973 (written 998, failed 2) -- reported three rows
 * "still readable after the retire":
 *
 *   hiq:basketball:2025:donruss-optic:27:checkerboard:no-auto
 *   hiq:basketball:2025:donruss-optic:8:choice-dragon:no-auto
 *   hiq:basketball:2025:donruss-optic:36:purple-velocity:no-auto:num-12
 *
 * All three were point-read afterwards at (id, id) AND queried cross-partition
 * by id: gone, zero rows, nowhere in the container -- and all three 2024
 * checklist twins present, so the retires were right AND complete. The deletes
 * had succeeded; the immediate read-back had been served by a replica that had
 * not yet applied them. Nothing was left behind and nothing needs re-running.
 *
 * The delete path itself was cleared in the same pass. retireCatalogRow ->
 * deleteTolerant awaits `container.item(id, pk).delete()`, and the SDK rejects
 * on any non-2xx, so a 412 or a throttled 429 surfaces as a throw (the lane's
 * own `retry` re-tries the 429s) and can never be mistaken for a 204. It
 * returns true only for a delete that actually returned, false only on a 404.
 *
 * The same lag is already documented one container over: relocate-sold-comp's
 * readBackKeptRow retries the point read and then falls back to a QUERY, whose
 * header records rekey-product-setkey run 33973364948 hitting it on 12 of
 * 35,173 rows. This is that helper's mirror image -- it waits for ABSENCE
 * rather than presence -- and it is deliberately NOT folded into the shared
 * one: the pool helper verifies a written document field-by-field, this one
 * verifies that nothing is there at all.
 *
 * The retries do not make the verify weaker. A row that is genuinely still
 * resident is read on every attempt and STILL fails, because the loop ends
 * early only on absence; the cost of the extra confidence is ~2s on the
 * ~0.1-0.2% of retires that lag. The cross-partition query is the last word:
 * a point read at (id, id) misses a row living under a foreign partition key,
 * and calling such a row "gone" is exactly the false success a DELETING lane
 * must never report.
 *
 * Returns { gone, via, attempts }. `via` names how absence was established, so
 * the banner can separate a clean delete from one that needed the wait.
 *
 * CF-A-THE-MOVE-VERIFIES-ITS-SOURCE-THE-SAME-WAY (2026-09-07, this change).
 *
 * #1940 gave that read-back to the RETIRE branch only. The MOVE branch kept a
 * single bare `rowAt(id)` -- one point read, at (id, id), no retry, no query
 * -- and so reproduced the identical false failure at the identical rate: five
 * entries across 99 relocate APPLY runs on 2026-09-07, ~1 per 1,000, every one
 * reported `FAILED: landed=true sourceVacated=false (action move)`:
 *
 *   hiq:soccer:2022:panini-prizm:130:pink:no-auto                  (run 34112338270)
 *   hiq:basketball:2023:nba-hoops:14:pink-ice-prizm:no-auto:num-35 (run 34131833131)
 *   hiq:football:2025:topps-finest:46:purple-checkerboard-refractor:no-auto:num-150 (34135975562)
 *   hiq:football:2025:panini-select:231:black-green-prizm-shock:no-auto (34141342368)
 *   hiq:football:2025:topps-finest:fg-rs:black-geometric-refractor:auto:num-25 (34144311996)
 *
 * All five were point-read afterwards at (id, id) AND queried cross-partition
 * by id: gone, zero hits. All five destinations were present, each stamped
 * `movedFrom` the failed source and carrying the right player (Ao Tanaka,
 * Lauri Markkanen, Roger Craig, Aaron Rodgers, Roger Staubach). The deletes
 * had landed; the immediate read-back was served by a replica that had not yet
 * applied them. Nothing was left behind and nothing needed re-running -- the
 * bug was the REPORT, exactly as it was for the retire half.
 *
 * Two things follow, and both are in the code below. First, the move's source
 * verify uses confirmRetired at `row.cardId ?? id` -- the key moveCatalogRow's
 * own `oldPk = String(oldRow.cardId ?? oldId)` deletes at -- so a row under a
 * foreign partition key is no longer declared gone by a read that could never
 * have seen it. Second, a source that IS still resident after all of that is
 * no longer counted as `failed`: it is `move landed; source retire failed`,
 * its own outcome, listed by name, because the state it describes is TWO ROWS
 * FOR ONE CARD and the fix is to retire the source, not to redo the move.
 *
 * Which is what a re-run now does. An entry whose destination already holds
 * the moved row -- proven by `movedFrom === id`, a stamp moveCatalogRow writes
 * on every move -- is COMPLETED by retiring the source, never refused as
 * occupied. Refusing was the trap: the destination is not a rival card, it is
 * this card already arrived, so every re-run would refuse identically and the
 * pair would stay split forever. A row at `to` WITHOUT that stamp is still a
 * genuine collision and still takes the occupied refusal, unchanged.
 */
const RETIRE_READ_BACK_ATTEMPTS = 3;
const RETIRE_READ_BACK_BACKOFF_MS = [400, 900];

async function confirmRetired(cat, id, pk, opts = {}) {
  const retry = opts.retry ?? ((fn) => fn());
  const wait = opts.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const readOnce = async () => {
    try { return (await retry(() => cat.item(id, pk).read())).resource ?? null; }
    catch (err) { if (err?.code === 404 || err?.statusCode === 404) return null; throw err; }
  };
  for (let attempt = 0; attempt < RETIRE_READ_BACK_ATTEMPTS; attempt++) {
    if (!(await readOnce())) {
      return { gone: true, via: attempt === 0 ? "point-read" : `point-read-retry-${attempt}`, attempts: attempt + 1 };
    }
    if (attempt < RETIRE_READ_BACK_ATTEMPTS - 1) await wait(RETIRE_READ_BACK_BACKOFF_MS[attempt] ?? 900);
  }
  // Still readable after every retried point read. A query reaches an
  // up-to-date replica set AND every partition, so it settles both remaining
  // questions at once: a lagging replica, and a row under a foreign pk the
  // point read could never have seen.
  const { resources } = await retry(() => cat.items.query({
    query: "SELECT c.id FROM c WHERE c.id = @id",
    parameters: [{ name: "@id", value: id }],
  }).fetchAll());
  const hits = (resources ?? []).length;
  return hits === 0
    ? { gone: true, via: "query", attempts: RETIRE_READ_BACK_ATTEMPTS }
    : { gone: false, via: "query", attempts: RETIRE_READ_BACK_ATTEMPTS, hits };
}

async function main() {
  if (SCOPE_ERROR) { console.error(SCOPE_ERROR); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const {
    moveCatalogRow, retireCatalogRow, patchCatalogRowFields,
  } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  const { marketVerdict } = require(path.join(__dirname, "lib", "market-guard.cjs"));

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  // The list IS the scope. A missing or empty file is a refusal, never a
  // silent no-op that looks like success.
  const listPath = path.isAbsolute(SCOPE) ? SCOPE : path.join(backend, SCOPE);
  if (!fs.existsSync(listPath)) {
    console.error(`FATAL: scope list not found: ${listPath}`);
    console.error("This lane refuses to run without an explicit committed list.");
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(listPath, "utf8"));
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  if (entries.length === 0) {
    console.error(`FATAL: ${SCOPE} names no entries — nothing is in scope.`);
    process.exit(1);
  }

  console.log(`scope file              ${SCOPE}`);
  console.log(`entries in scope        ${f(entries.length)}`);
  console.log(`excluded by the audit   ${f((doc.excluded || []).length)}   <- deliberately NOT touched`);
  for (const r of doc.rulings || []) console.log(`  ruling: ${r}`);
  console.log("");

  // The client is NAMED rather than chained away, so finishLane() can dispose
  // it: an undisposed SDK keeps keep-alive sockets open, and a live handle is
  // exactly what held four APPLY shards to the ceiling in #1809.
  const client = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  });
  const db = client.database("hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");
  const retry = async (fn, tries = 12) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        if (!/request rate|429|ETIMEDOUT|ECONNRESET/i.test(String(e?.message)) || a >= tries) throw e;
        await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 30000);
      }
    }
  };
  const rowAt = async (slug) => {
    try { return (await retry(() => cat.item(slug, slug).read())).resource ?? null; }
    catch (err) { if (err?.code === 404 || err?.statusCode === 404) return null; throw err; }
  };
  // How many sales point at a slug. Printed for a retire so the size of the
  // hand-off to the rematch is visible BEFORE the apply.
  const salesAt = async (slug) => {
    try {
      const { resources } = await retry(() => pool.items.query({
        query: "SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s",
        parameters: [{ name: "@s", value: slug }],
      }, { maxItemCount: 1 }).fetchAll());
      return Number(resources[0] ?? 0) || 0;
    } catch { return null; }
  };

  let retired = 0, resluged = 0, alreadyRight = 0, notFound = 0, failed = 0;
  // Rows stamped identityUnverified. A park WRITES (it patches a field), so it
  // reconciles on the written side beside retire and reslug -- never as a skip.
  let parked = 0;
  // Parks whose row already carried the stamp. Idempotent, and a SKIP rather
  // than a write, so a re-run cannot inflate the parked count.
  let alreadyParked = 0;
  // Sales left sitting on a parked row. They are neither unplaced nor
  // re-pointed: the row is still there, still theirs, and now unpriced.
  let salesParked = 0;
  let refusedOccupied = 0, salesUnplaced = 0, salesRepointed = 0, gradedRetired = 0;
  // A SUBSET of refusedOccupied, never an addition to it: the reconciliation
  // identity below counts occupied refusals once, and a superset IS one.
  let refusedNameSuperset = 0;
  // Retires whose delete landed but whose FIRST read-back still saw the row.
  // Counted, not hidden: these are successes, and a number that climbs is the
  // container telling us something about its replication, not about this lane.
  let readBackRetried = 0;
  // Sales a keepSales reslug deliberately did NOT carry. Counted separately
  // from salesUnplaced because the two are different states: an unplaced sale
  // has no row at its address at all, while these still have one -- the
  // GENUINE year-N+1 row that was always the right one for them.
  let salesLeftBehind = 0;
  let refusedCrossMarket = 0;
  // Moves whose destination landed but whose SOURCE survived every retried
  // read and the cross-partition query. Its own outcome, neither success nor
  // plain failure: the card arrived, and a second row still holds its old
  // address. Named in `leftoverSources` so the report is a work list.
  let moveSourceLeftBehind = 0;
  const leftoverSources = [];
  // Half-applied moves this run FINISHED by retiring the source.
  let movesCompleted = 0;
  const intended = entries.length;

  // ── THE CLOCK ────────────────────────────────────────────────────────────
  //
  // Sized from the measurement in this file's header: a unit is ONE ENTRY at
  // ~1.8s, so a 30s reserve is ~16x the slowest entry measured -- the reserve
  // exists to exceed the worst single unit a throttled container can produce.
  // There is no post-loop aggregate to cap (every count is accumulated in the
  // loop), so VERIFY_MS is nominal and only sizes the pin's worst case.
  const b = budget({ minutes: 110, reserveMs: 30 * 1000, verifyMs: 60 * 1000 });
  console.log(`  ${b.describe()}`);
  console.log("");

  // How far the loop actually got. `stoppedAt` stays null when every entry was
  // considered; a number means the budget stopped the loop BEFORE that index,
  // and the banner and the marker both report it.
  let stoppedAt = null;
  let considered = 0;

  for (const e of entries) {
    // THE PRE-CHECK, ONCE, FOR EVERY BRANCH BELOW. It is here -- above the
    // classify, above the `rowAt`, above the retire/reslug fork -- precisely so
    // that no branch can be the one that forgets it. A budget checked inside
    // `if (action === "retire")` would leave the reslug half unbudgeted, which
    // is the same defect this lane already had, merely halved.
    //
    // And it is a PRE-check: `outOfClock()` is true when less than the reserve
    // remains, so the entry that would overrun is never STARTED. Checking
    // after the entry admits one more unit of unbounded size past expiry,
    // which is the loop-top defect #1799 named.
    if (b.outOfClock()) { stoppedAt = considered; break; }
    considered++;
    const c = classifyEntry(e);
    if (!c.ok) { failed++; console.error(`  MALFORMED — ${c.why}`); continue; }
    const { id, action, to, reason } = c;
    const evidence = String(e.evidence ?? "").trim();

    const row = await rowAt(id);
    if (!row) {
      // A RESLUG WHOSE SOURCE IS GONE MAY ALREADY BE DONE. Before calling it
      // "not found", ask the destination: a row there stamped `movedFrom` this
      // id is THIS ENTRY, already completed by an earlier run -- the ordinary
      // shape of a re-run over a list whose applies mostly succeeded. Counting
      // that as not-found is merely noisy; the state is correct either way.
      if (action === "reslug") {
        const done = await rowAt(to);
        if (done && String(done.movedFrom ?? "") === id) {
          alreadyRight++;
          console.log(`  ALREADY MOVED  ${id.slice(0, 62)}`);
          console.log(`      ->  ${to.slice(0, 70)}   <- an earlier run completed this entry`);
          continue;
        }
      }
      // Already gone is the target state for a retire, and it is a SKIP, not a
      // success: a re-run must not inflate the written count.
      // A PARK OF A ROW THAT IS GONE IS A REFUSAL, NOT A NO-OP. Park means
      // "this row stays, unpriced, until a source confirms it" -- there is no
      // such row, so the entry's premise is false and the list is out of date.
      // Counting it as a skip would let a list quietly park nothing at all.
      alreadyRight += action === "retire" ? 1 : 0;
      notFound += action === "retire" ? 0 : 1;
      console.log(`  NOT FOUND  ${id.slice(0, 70)}`);
      if (action === "park") {
        console.error("      a park needs a row to stamp — this entry's premise is gone; re-measure the list");
      }
      continue;
    }

    // ── PARK ──────────────────────────────────────────────────────────────
    //
    // Nothing moves, nothing is deleted. One patch, through the helper that
    // owns catalog field writes -- never a raw container.patch (#1614 left
    // rows unfindable exactly that way).
    if (action === "park") {
      const pointing = await salesAt(id);
      console.log(`  PARK  ${id.slice(0, 70)}`);
      console.log(`      ${String(row.playerName ?? "(no player)")} — ${String(row.setName ?? "")}`.slice(0, 100));
      console.log(`      reason: ${reason.slice(0, 90)}`);
      if (evidence) console.log(`      evidence: ${evidence.slice(0, 90)}`);
      console.log(`      sales staying on this row: ${pointing === null ? "unknown" : f(pointing)}   <- kept WITH the row, and unpriced`);
      if (row.identityUnverified === true) {
        alreadyParked++;
        console.log("      already identityUnverified — nothing to write");
        continue;
      }
      if (pointing) salesParked += pointing;
      // ONE call for both modes, with dryRun -- the same contract the reslug
      // path was fixed to honour: a report that cannot predict its apply is a
      // green light for a write that will not happen.
      try {
        const res = await patchCatalogRowFields(
          cat, id, row.cardId ?? id,
          { identityUnverified: true, identityUnverifiedReason: reason },
          { retry, dryRun: !APPLY },
        );
        if (res?.action === "noop") { alreadyParked++; continue; }
        parked++;
      } catch (err) {
        failed++;
        console.error(`      FAILED: ${String(err?.message ?? err).slice(0, 80)}`);
      }
      continue;
    }

    if (action === "retire") {
      const pointing = await salesAt(id);
      console.log(`  RETIRE  ${id.slice(0, 70)}`);
      console.log(`      ${String(row.playerName ?? "(no player)")} — ${String(row.setName ?? "")}`.slice(0, 100));
      console.log(`      reason: ${reason.slice(0, 90)}`);
      if (evidence) console.log(`      evidence: ${evidence.slice(0, 90)}`);
      console.log(`      sales pointing here: ${pointing === null ? "unknown" : f(pointing)}   <- become UNPLACED, the rematch owns them`);
      if (pointing) salesUnplaced += pointing;
      if (!APPLY) { retired++; continue; }
      try {
        const res = await retireCatalogRow(cat, id, row.cardId ?? id, reason, { retry });
        gradedRetired += res?.gradedChildrenRetired ?? 0;
        // VERIFY BY READ -- and read PAST a lagging replica before calling it a
        // failure. The delete is still not believed on its own word; a read
        // that has not caught up yet is simply not the delete's word either.
        // retireCatalogRow deletes at `cardId ? String(cardId) : id`, so the
        // verify reads at the SAME key rather than assuming (id, id).
        const back = await confirmRetired(cat, id, row.cardId ?? id, { retry });
        if (back.gone) {
          retired++;
          if (back.via !== "point-read") {
            readBackRetried++;
            console.log(`      read-back needed a retry (${back.via}) — the delete had landed`);
          }
        } else {
          failed++;
          console.error(`      FAILED: the row is still readable after the retire (${f(back.hits ?? 1)} still resident after ${back.attempts} reads + a query)`);
        }
      } catch (err) {
        failed++;
        console.error(`      FAILED: ${String(err?.message ?? err).slice(0, 80)}`);
      }
      continue;
    }

    // ── RESLUG ────────────────────────────────────────────────────────────
    const incumbent = await rowAt(to);

    // IDEMPOTENT COMPLETION, PINNED. The source is still here AND the
    // destination already holds the row this entry moved -- the exact residue
    // of a `move landed; source retire failed` above, and of any run killed
    // between moveCatalogRow's upsert and its delete. The right finish is to
    // RETIRE THE SOURCE, not to refuse as occupied: the destination is not a
    // rival card, it is this card, already arrived. Refusing here would strand
    // the pair as two rows for one card forever, since every re-run would make
    // the same refusal. The `movedFrom` stamp is what distinguishes this from
    // a genuine collision -- moveCatalogRow writes it on every move -- so a
    // row that merely happens to sit at `to` still goes down the occupied
    // path below and is still reported by name.
    if (incumbent && String(incumbent.movedFrom ?? "") === id) {
      console.log(`  COMPLETE MOVE  ${id.slice(0, 62)}`);
      console.log(`      ->  ${to.slice(0, 70)}   <- destination already holds this row; retiring the source`);
      if (!APPLY) { movesCompleted++; continue; }
      try {
        const res = await retireCatalogRow(cat, id, row.cardId ?? id, `complete a half-applied move to ${to}: ${reason}`, { retry });
        gradedRetired += res?.gradedChildrenRetired ?? 0;
        const back = await confirmRetired(cat, id, row.cardId ?? id, { retry });
        if (back.gone) {
          movesCompleted++;
          if (back.via !== "point-read") {
            readBackRetried++;
            console.log(`      read-back needed a retry (${back.via}) — the delete had landed`);
          }
        } else {
          failed++;
          console.error(`      FAILED: the source is still readable after the retire (${f(back.hits ?? 1)} still resident after ${back.attempts} reads + a query)`);
        }
      } catch (err) {
        failed++;
        console.error(`      FAILED: ${String(err?.message ?? err).slice(0, 80)}`);
      }
      continue;
    }

    // NAME THE REFUSAL. A superset ("Jolteon" vs "Jolteon δ") and a genuine
    // collision ("Todd Hundley" vs "Derek Jeter") both stop the move, but they
    // ask different things of an operator -- a checklist lookup versus a
    // numbering fix -- so they are reported apart rather than as one number.
    const occ = occupancyRefusal(incumbent, row);
    if (occ) {
      refusedOccupied++;
      if (occ.reason === "occupied: name-superset") refusedNameSuperset++;
      console.error(`  REFUSED (${occ.reason})  ${id.slice(0, 62)}`);
      console.error(`      -> ${to.slice(0, 70)}`);
      console.error(`      held by ${String(incumbent.playerName ?? "(unnamed)")}, moving ${String(row.playerName ?? "(unnamed)")}`);
      console.error(`      ${occ.hint}`);
      continue;
    }
    console.log(`  RESLUG  ${id.slice(0, 62)}`);
    console.log(`      ->  ${to.slice(0, 70)}`);
    console.log(`      ${String(row.playerName ?? "(no player)")} — reason: ${reason.slice(0, 70)}`);
    if (evidence) console.log(`      evidence: ${evidence.slice(0, 90)}`);

    // THE DESTINATION NAMES THE PRODUCT. When `to` stems from a different
    // setKey than the row's id, this entry is a RENAME, and moveCatalogRow
    // refuses a product change nobody asked for -- so ASK, with the key the
    // list itself spelled. Silence here is what failed all 91 Japanese 151
    // rows on 2026-09-06: `{}` means "same product, new address", the
    // destination said sv2a, the id said 151, and buildIncoming threw.
    // A same-product move (a fold: renumber, parallel fix) still passes
    // nothing, so the stem must equal the old one -- that guard is untouched.
    const changed = crossProductFields(id, to);

    // ...AND THE MARKET GUARD VALIDATES IT. Honouring the list is not trusting
    // it blindly: a destination whose market contradicts the ROW's market is
    // refused before any derivation. sv2a is JA and these rows' setName says
    // Japanese, so this passes -- and an EN destination for a JA row never
    // would. Both sides must speak and disagree; silence never invents a
    // refusal (market-guard.cjs).
    const verdict = marketVerdict(row, changed.setKey ?? idSetKey(to), row.sport);
    if (!verdict.allowed) {
      refusedCrossMarket++;
      console.error(`  REFUSED (cross-market)  ${id.slice(0, 62)}`);
      console.error(`      -> ${to.slice(0, 70)}`);
      console.error(`      the row's market is ${verdict.rowMarket}, the destination's is ${verdict.toMarket}`);
      console.error("      a JA row may never land on an EN key, or the reverse");
      continue;
    }

    // WHOSE SALES ARE THESE? A move carries the card's own sales; a
    // disentanglement leaves the other card's sales where they are. The list
    // states which this is, per entry or per file, and the count is printed
    // BEFORE the derivation so the hand-off is sized in the report exactly as
    // the retire's `sales pointing here` line is.
    const keepSales = keepsSales(e, doc);
    if (keepSales) {
      const staying = await salesAt(id);
      console.log(`      sales staying at this slug: ${staying === null ? "unknown" : f(staying)}`
        + "   <- NOT re-pointed; they are the other card's, the rematch re-derives them");
      if (staying) salesLeftBehind += staying;
    }

    // ONE DERIVATION FOR BOTH PATHS. The report does NOT count a success it
    // never computed: it runs the SAME moveCatalogRow with dryRun, which
    // reads everything, runs buildIncoming and the survivor choice, and
    // writes nothing. A report that cannot predict its apply is the defect
    // -- report-first is only safe when report and apply share the
    // derivation. Only the write and the verify-by-read differ below.
    try {
      const res = await moveCatalogRow(cat, row, to, changed, {
        reason,
        dryRun: !APPLY,
        // Omitting salesContainer is moveCatalogRow's documented way to say
        // "the caller KNOWS no sale should follow" -- it then re-points
        // nothing and says so in its own decision string. That is the whole
        // mechanism of keepSales: not a suppressed patch, an unasked-for one.
        // It rides the shared derivation above, so the report predicts this
        // too: a dryRun run reports salesRepointed 0 for a keepSales entry.
        ...(keepSales ? {} : { salesContainer: pool }),
        known: incumbent,
        retry,
      });
      if (res?.action === "refused") {
        failed++;
        console.error(`      FAILED: ${String(res?.decision ?? "refused").slice(0, 80)}`);
        continue;
      }
      if (!APPLY) { resluged++; continue; }
      salesRepointed += res?.salesRepointed ?? 0;
      gradedRetired += res?.gradedChildrenRetired ?? 0;
      // VERIFY BY READ -- AND THE SOURCE HALF READS PAST A LAGGING REPLICA
      // TOO. #1940 gave the retire a read-back that retries and then queries;
      // the move's source verify was left as ONE bare point read at (id, id),
      // and that asymmetry is the whole of this bug. moveCatalogRow deletes at
      // `oldRow.cardId ?? oldRow.id` -- so a row under a foreign partition key
      // was deleted at a key the verify never read, and a replica that had not
      // yet applied a delete made at the RIGHT key was believed on its first
      // word. Both are the same class of false failure, so both get the same
      // helper, at the same key the delete used.
      const landed = await rowAt(to);
      const back = await confirmRetired(cat, id, row.cardId ?? id, { retry });
      if (landed && back.gone) {
        resluged++;
        if (back.via !== "point-read") {
          readBackRetried++;
          console.log(`      read-back needed a retry (${back.via}) — the source delete had landed`);
        }
      } else if (landed && !back.gone) {
        // THE MOVE IS HALF DONE, AND THAT IS ITS OWN OUTCOME. The destination
        // holds the card and the source is genuinely still resident after
        // every retry and a cross-partition query: two rows for one card,
        // which the one-card-one-row doctrine forbids. It is NOT `failed`,
        // because the move itself landed and re-running the whole move would
        // find the destination occupied by its own copy; it is a source that
        // still needs retiring, and it is counted and named so a re-run --
        // which completes it below rather than refusing -- can finish it.
        moveSourceLeftBehind++;
        leftoverSources.push({ from: id, to, player: row.playerName ?? null });
        console.error(`      MOVE LANDED; SOURCE RETIRE FAILED  (${f(back.hits ?? 1)} still resident after ${back.attempts} reads + a query)`);
        console.error("      two rows now hold one card — re-run this entry to retire the source");
      } else {
        failed++;
        console.error(`      FAILED: landed=${Boolean(landed)} sourceVacated=${back.gone} (action ${res?.action})`);
      }
    } catch (err) {
      failed++;
      console.error(`      FAILED: ${String(err?.message ?? err).slice(0, 80)}`);
    }
  }

  // Entries the budget never reached. They are NOT failures and NOT skips:
  // nothing was read and nothing was decided about them, so they are their own
  // line in the reconcile and the relaunch is what settles them.
  const notReached = stoppedAt === null ? 0 : intended - stoppedAt;

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  entries in scope        ${f(intended)}`);
  console.log(`  entries considered      ${f(considered)}${stoppedAt === null ? "   <- the whole list" : ""}`);
  console.log(`  RETIRED (deleted)       ${f(retired)}   <- deleted; a soft label does NOT stop a catalog row resolving`);
  console.log(`  RESLUGGED (moved)       ${f(resluged)}`);
  console.log(`  PARKED (identityUnverified) ${f(parked)}   <- row and sales stay put, unpriced until a source confirms the identity`);
  console.log(`  already parked          ${f(alreadyParked)}   <- the stamp was already there; a re-run writes nothing`);
  console.log(`  moves COMPLETED         ${f(movesCompleted)}   <- destination already held the row; the source was retired`);
  console.log(`  move landed; source retire failed ${f(moveSourceLeftBehind)}   <- TWO rows hold one card; re-run finishes it`);
  console.log(`  refused — occupied      ${f(refusedOccupied)}   <- a different card holds the target address`);
  if (refusedNameSuperset) {
    console.log(`    of which name-superset ${f(refusedNameSuperset)}   <- one name is the other plus a suffix; a checklist twin decides`);
  }
  if (!identityKeyIsBuilt()) {
    console.log("  NOTE: dist/ was not loadable — names compared with the LEGACY reduction");
    console.log("        (accents and ☆ ♀ ♂ α β γ δ are deleted, not transliterated); build the tree for the full compare");
  }
  console.log(`  refused — cross-market  ${f(refusedCrossMarket)}   <- a JA row may never land on an EN key, or the reverse`);
  console.log(`  already gone            ${f(alreadyRight)}`);
  console.log(`  not found               ${f(notFound)}`);
  console.log(`  read-back needed a retry ${f(readBackRetried)}   <- replica lag, delete confirmed landed — NOT failed`);
  console.log(`  failed                  ${f(failed)}`);
  console.log(`  sales made UNPLACED     ${f(salesUnplaced)}   <- the rematch owns these`);
  console.log(`  sales re-pointed        ${f(salesRepointed)}`);
  console.log(`  sales LEFT BEHIND       ${f(salesLeftBehind)}   <- keepSales: the other card's sales, not carried`);
  console.log(`  sales on PARKED rows    ${f(salesParked)}   <- still on their row, neither unplaced nor re-pointed`);
  console.log(`  graded children retired ${f(gradedRetired)}`);
  // RECONCILE IN BOTH MODES. A report that cannot account for its own entries
  // is not a report worth reading, and the apply's arithmetic must have been
  // seen once before it runs.
  // A completed move WROTE (it deleted a source), so it counts as written.
  // A left-behind source also wrote -- the destination landed -- and is
  // counted here too; what it did not do is finish, which its own line says.
  // THE WORK LIST, BY NAME. A count of half-applied moves an operator cannot
  // act on is not a report. Every leftover source is printed as a (from, to)
  // pair, in the shape a relocation list entry takes, so a re-run of THIS
  // list finishes them by the idempotent-completion path above.
  if (moveSourceLeftBehind > 0) {
    console.log("");
    console.log(`  LEFTOVER SOURCES (${f(moveSourceLeftBehind)}) — the destination holds the card, the old row is still resident:`);
    for (const l of leftoverSources) {
      console.log(`    from ${l.from}`);
      console.log(`    to   ${l.to}${l.player ? `   (${l.player})` : ""}`);
    }
    console.log("  re-run this same list: each is completed by retiring the source, not refused as occupied");
  }

  // A PARK WROTE: it patched a field on a row. `alreadyParked` did not -- the
  // stamp was already there -- so it reconciles as a skip, the same way
  // `already gone` does for a retire.
  const written = retired + resluged + movesCompleted + moveSourceLeftBehind + parked;
  const skipped = alreadyRight + notFound + alreadyParked;
  const refused = refusedOccupied + refusedCrossMarket;
  // A PARTIAL RUN STILL RECONCILES. The identity has to hold over what the
  // loop CONSIDERED, not over the file, or a budget stop reads as 6,695 lost
  // entries. `not reached` carries the remainder explicitly so the two numbers
  // an operator cares about -- what happened, and what is left -- are both on
  // the page rather than one being inferred from the other's absence.
  console.log(`  reconciled: intended ${f(intended)} = written ${f(written)} + skipped ${f(skipped)} `
    + `+ refused ${f(refused)} + failed ${f(failed)} + not reached ${f(notReached)}`);
  if (written + skipped + refused + failed + notReached !== intended) {
    console.error("  !! RECONCILE MISMATCH — an entry was neither written, skipped, refused, failed nor deferred");
    process.exitCode = 4;
  }
  if (APPLY) {
    reportWrites({
      job: "relocate-catalog-rows-by-list", intended,
      written, skipped: skipped + notReached, failed: failed + refused,
    });
  }

  // ── THE MARKER THE RELAUNCH GREPS ────────────────────────────────────────
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). The runner greps stdout for
  // `stopped at the .*budget`, so the phrase is written here as a SOURCE
  // LITERAL rather than assembled from variables: a marker built by
  // concatenation is a marker a refactor can silently reword, and a reworded
  // marker ends the fan-out after one slice with the run green -- the quiet
  // version of the bug #1913 made loud.
  if (stoppedAt !== null) {
    console.log(`\n  stopped at the ${b.RUN_MINUTES}-minute budget — `
      + `stopped at ${f(stoppedAt)} of ${f(intended)}; the relaunch continues from here`);
    console.log("  the list is IDEMPOTENT: a finished retire re-reads as `already gone` and a "
      + "finished reslug as NOT FOUND, so the continuation re-derives cheaply and writes only what is left.");
  }

  // CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Whether the loop finished
  // or the budget stopped it, this lane EXITS -- it never ends by hoping the
  // event loop drains. `process.exitCode` may already carry a reconcile
  // mismatch, and that is the code finishLane is handed.
  await finishLane(process.exitCode ?? 0, { client, budget: b });
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}

module.exports = {
  SCOPE, APPLY, classifyEntry, occupiedByDifferentCard, occupancyRefusal, crossProductFields, idSetKey, keepsSales,
  confirmRetired, RETIRE_READ_BACK_ATTEMPTS,
};
