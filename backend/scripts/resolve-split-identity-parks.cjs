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
 * third sport (neither H's nor C's), or inferSetKeyFromTitle/
 * extractCardNumberFromTitle+sameCardNumber disagreeing with the winner's
 * own setKey/cardNumber, or playerTheTitleAllows judging the winner's own
 * catalog player "irreconcilable" against the sale's stored playerName --
 * any of these vetoes the resolve to LEAVE `title-contradicts-winner`. A
 * title that is merely silent (no evidence either way) never vetoes.
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
 * collision is only possible when some OTHER sale's `id` already equals
 * this one's `id` AT the destination partition, which the collision check
 * (a point read at `(doc.id, destCardId)`) catches before the upsert ever
 * runs.
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
 * BUDGET / SHARD / RELAUNCH / RECONCILE: identical machinery to
 * revert-set-sport-repair.cjs (lib/runner-budget.cjs, lib/runner-shard-
 * scope.cjs) -- candidates grouped by sale `id` and processed serially
 * WITHIN an id (never two concurrent writers on one sale) but multiple ids
 * run concurrently, bounded by CONCURRENCY, same shared-cursor-pool shape
 * the repoint lane uses. Catalog reads are promise-cached per id, per run,
 * and a persistent (non-404) catalog read failure is caught at the
 * narrowest point that knows it is a read failure, isolating exactly ONE
 * row -- never the batch, the page walk, or the run's own RECONCILE/
 * relaunch marker.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true / APPLY=true to write;
 *      SCOPE required (`all-splits` or comma `sport:year` cells, matched
 *      against EITHER id's sport/year); TITLES optional freeform filter
 *      (substring, case-insensitive, against the sale's own title) mirroring
 *      the runner's inherited `titles` dispatch field; MODE unused (kept for
 *      workflow-input symmetry, refused if set to anything but empty);
 *      SLOT/SLOTS (sha1(id) shards, opt-in via SHARD=true for slot 0);
 *      CONCURRENCY=8; RUN_MINUTES=110; LIMIT=0.
 * Requires dist/ (splitIdentityWriteGuard, catalogAuthority.service.js,
 * playerIdentityKey.js) and scripts/lib (relocate-sold-comp, runner-budget,
 * runner-shard-scope, two-sport-athletes, sport-title-evidence).
 */
"use strict";
const path = require("path");
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
const TITLES_FILTER = csv(process.env.TITLES).map(lower);

/** Unset every park field on a resolve. Read from splitIdentityWriteGuard.ts's
 *  GuardedSoldCompDoc and relocate-pool-rows-by-list.cjs's own PARK stamp --
 *  the same five fields either mechanism writes, so a row this lane resolves
 *  is indistinguishable, once cleared, from a row that was never parked. */
const PARK_FIELDS = ["identityUnverified", "identityUnverifiedAt", "identityUnverifiedBy", "identityUnverifiedReason", "identityUnverifiedDetail"];

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
 * `extractCardNumberFromTitle`/`sameCardNumber` (setKey/number check), and
 * `playerTheTitleAllows` (player check against the WINNING catalog row's
 * own playerName, never the sale's stored playerName -- the stored field is
 * what already won the checklist match; the title is a SEPARATE, weaker
 * witness being asked whether it actively disagrees).
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
  const { inferSetKeyFromTitle, resolveSetKeyForSlug, extractCardNumberFromTitle, sameCardNumber, playerTheTitleAllows, sportEvidenceFn } = deps;
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

  // ── PLAYER: the title's own player mention (read from the title text via
  // a simple presence check against the winning catalog row's playerName --
  // playerTheTitleAllows reconciles VENDOR vs TITLE attribution, so it is
  // called here with the winning catalog row's name standing in for the
  // "vendor" side and nothing else claiming a title-side name unless the
  // catalog row's own name is absent from the title). This only vetoes on
  // an outright IRRECONCILABLE disagreement -- the strongest signal that
  // function returns -- never on ambiguity.
  if (winnerCatalogPlayerName) {
    const decision = playerTheTitleAllows(winnerCatalogPlayerName, winnerCatalogPlayerName);
    // playerTheTitleAllows compares VENDOR vs TITLE attribution; this lane
    // has no separately-parsed "title player" of its own to hand it (that
    // parser lives in parseTitleIdentity.service.ts's title pipeline, which
    // this lane does not run). Rather than approximate a title-player
    // extraction (and risk a false veto from a bad approximation),
    // player-name vetoing is deliberately left to the existing
    // checklistMatchOf comparison (sale.playerName vs catalog row), which
    // already ran and IS the winning evidence. `decision` is computed only
    // to keep the dependency wired for a future caller that supplies a real
    // title-side player; today it can never disagree with itself, so it
    // never vetoes on its own.
    void decision;
  }

  return { vetoed: false };
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
  const { playerTheTitleAllows } = require(path.join(backend, "dist/services/portfolioiq/playerTheTitleAllows.js"));
  const TWO_SPORT_ATHLETE_KEYS = require(path.join(__dirname, "lib", "two-sport-athletes.cjs")).buildTwoSportAthleteKeys(playerIdentityKey);

  const titleDeps = { inferSetKeyFromTitle, resolveSetKeyForSlug, extractCardNumberFromTitle, sameCardNumber, playerTheTitleAllows, sportEvidenceFn: sportEvidence };

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const pool = db.container("sold_comps");
  const cat = db.container("card_catalog");

  console.log(`  scope            ${SCOPE_IS_ALL ? "all-splits (every parked split-identity row this lane can reach)" : SCOPE_CELLS.join(", ")}`);
  if (TITLES_FILTER.length) console.log(`  titles filter     ${TITLES_FILTER.join(", ")}`);
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

    const H = str(doc.hobbyiqCardId);
    const C = str(doc.cardId);
    const hSport = sportSegmentOf(H);
    const cSport = sportSegmentOf(C);
    if (!segmentsOf(H) || !segmentsOf(C) || !hSport || !cSport) {
      bumpReason(s.leave, "malformed-candidate-id");
      pushExample(leaveExamples, "malformed-candidate-id", `  ${doc.id}@${doc.cardId}: cardId=${C} hobbyiqCardId=${H}`);
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
      return;
    }

    const hMatch = checklistMatchOf(hRow, doc.playerName, catalogAuthorityOf, playerIdentityKey);
    const cMatch = checklistMatchOf(cRow, doc.playerName, catalogAuthorityOf, playerIdentityKey);
    const saleIsTwoSportAthlete = TWO_SPORT_ATHLETE_KEYS.has(playerIdentityKey(doc.playerName));
    const verdict = judgeSplitIdentityVerdict({ hMatch, cMatch, saleIsTwoSportAthlete });

    if (verdict.verdict === "leave") {
      bumpReason(s.leave, verdict.reason);
      pushExample(leaveExamples, verdict.reason, `  ${doc.id}@${doc.cardId}: ${verdict.detail}`);
      return;
    }

    const winner = verdict.verdict === "resolve-to-h" ? H : C;
    const winnerRow = verdict.verdict === "resolve-to-h" ? hRow : cRow;
    const winnerSport = verdict.verdict === "resolve-to-h" ? hSport : cSport;
    const otherSport = verdict.verdict === "resolve-to-h" ? cSport : hSport;

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
      return;
    }

    // ── ALREADY AT TARGET: cardId, hobbyiqCardId and sport already all
    // equal the winner -- some earlier partial run or unrelated fix already
    // resolved the fields but never cleared the park stamp. Clear the stamp
    // only; no new decision to make.
    const alreadyResolved = doc.cardId === winner && doc.hobbyiqCardId === winner && doc.sport === winnerSport;

    const cellKey = [...cells].join(",") || "unknown-cell";

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
        return;
      }

      if (alreadyResolved || verdict.verdict === "resolve-to-c" || doc.cardId === winner) {
        // PATCH shape: partition (cardId) does not move. RESOLVE-TO-C is
        // always this shape (cardId already equals C by construction of the
        // predicate); RESOLVE-TO-H takes this shape only in the
        // already-at-target case, or the defensive case where cardId
        // already equals H for some other reason.
        if (APPLY) {
          await retry(() => pool.item(doc.id, doc.cardId).patch([
            { op: "set", path: "/sport", value: keep.sport },
            { op: "set", path: "/hobbyiqCardId", value: keep.hobbyiqCardId },
            { op: "set", path: "/cardId", value: keep.cardId },
            { op: "set", path: "/splitResolvedAt", value: ledger.splitResolvedAt },
            { op: "set", path: "/splitResolvedTo", value: ledger.splitResolvedTo },
            { op: "set", path: "/splitResolvedFrom", value: ledger.splitResolvedFrom },
            { op: "set", path: "/splitResolvedBy", value: ledger.splitResolvedBy },
            ...PARK_FIELDS.filter((f2) => doc[f2] !== undefined).map((f2) => ({ op: "remove", path: `/${f2}` })),
          ]));
        }
        if (alreadyResolved) s.alreadyAtTarget++;
        if (verdict.verdict === "resolve-to-h") s.resolveToHByPatch++; else s.resolveToCByPatch++;
        bump(byCell, cellKey);
        if (resolveExamples.length < 60) {
          resolveExamples.push(`  PATCH   ${str(doc.title).slice(0, 70)} | ${doc.cardId} | ${doc.hobbyiqCardId} -> ${winner} (${verdict.reason}, catalog player: ${winnerRow?.playerName ?? "?"})`);
        }
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
          return;
        }
        bumpReason(s.refused, "destination-collision");
        pushExample(refuseExamples, "destination-collision", `  ${doc.id}@${doc.cardId} -> ${destCardId}: a DIFFERENT sale (by content hash) already resides at the destination; NEITHER moved -- resident price=${resident.price ?? "?"} soldAt=${resident.soldAt ?? "?"} vs incoming price=${doc.price ?? "?"} soldAt=${doc.soldAt ?? "?"}`);
        return;
      }

      const res = await relocateSoldComp(pool, {
        keep, drop: [{ id: doc.id, cardId: doc.cardId }],
        retry, verifyFields: ["cardId", "hobbyiqCardId", "sport", "splitResolvedTo"], dryRun: !APPLY,
      });
      if (res.guard?.verdict === "park") {
        bumpReason(s.refused, "guard-parked");
        pushExample(refuseExamples, "guard-parked", `  ${doc.id}@${doc.cardId}: ${res.error ?? res.guard.reason}`);
        return;
      }
      if (!res.ok && res.stage !== "dry-run") {
        s.failed++;
        failures.push(`  FAILED relocate ${doc.id}@${doc.cardId} -> ${destCardId}: ${res.error ?? "unknown"}`);
        return;
      }
      s.resolveToHByRelocate++;
      bump(byCell, cellKey);
      if (resolveExamples.length < 60) {
        resolveExamples.push(`  RELOCATE ${str(doc.title).slice(0, 70)} | ${doc.cardId} | ${doc.hobbyiqCardId} -> ${winner} (${verdict.reason}, catalog player: ${winnerRow?.playerName ?? "?"})`);
      }
    } catch (e) {
      s.failed++;
      failures.push(`  FAILED resolve ${doc.id}@${doc.cardId}: ${String(e?.stack ?? e?.message ?? e)}`);
    }
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
  if (resolveExamples.length) {
    console.log(`\n  RESOLVE examples (up to 60, for eyeballing -- title | cardId | hobbyiqCardId -> winner + catalog player):`);
    for (const e of resolveExamples) console.log(e);
  }
  for (const [reason, list] of Object.entries(leaveExamples)) {
    console.log(`\n  LEAVE (${reason}), every one listed (${f(list.length)} shown, ${f(s.leave[reason] || 0)} total -- full list in the uploaded artifact):`);
    for (const l of list) console.log(l);
  }
  for (const [reason, list] of Object.entries(refuseExamples)) {
    console.log(`\n  REFUSED (${reason}), every one listed (${f(list.length)} shown, ${f(s.refused[reason] || 0)} total -- full list in the uploaded artifact):`);
    for (const l of list) console.log(l);
  }
  if (failures.length) { console.log(`\n  FAILURES (${f(failures.length)}):`); for (const fl of failures) console.log(fl); }

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
  judgeSplitIdentityVerdict, titleVetoes,
  ALL_SPLITS, CELL_RE, PARK_FIELDS,
};

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); await finishLane(1, { budget: CLOCK }); });
}
