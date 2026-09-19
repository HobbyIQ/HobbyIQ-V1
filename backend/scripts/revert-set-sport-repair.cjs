#!/usr/bin/env node
/**
 * revert-set-sport-repair.cjs -- R76 (Drew, 2026-09-19): restore the sales
 * repair-set-sport.cjs (2026-08-20) wrongly flipped, back to their
 * pre-repair sport and card id.
 *
 * THE DEFECT. On 2026-08-20 repair-set-sport.cjs changed the `sport` of
 * 183,248 sold_comps rows by asking which sport a (year, setKey)'s
 * CHECKLIST dominantly holds (setSportAuthority.cjs's buildAuthority), with
 * its only veto being five literal substring words ("baseball", "football",
 * "basketball", "hockey", "soccer" -- SPORT_WORDS). A title almost never
 * spells its own sport that way; it names a TEAM ("Chicago Bulls"), a
 * LEAGUE ("NBA"), or a position -- so the veto fired on ~11% of titles and
 * missed the other 89%. A read-only census (see r76/ census artifacts) then
 * judged 69,598 of the 183,248 flips WRONG on exactly that evidence: the
 * title named the PRE-repair sport's team or league and the substring veto
 * never saw it.
 *
 * THE REPAIR'S OWN SHAPE (verified, re-derived here rather than trusted):
 * for every row it flipped it did ONE patch -- added `sportBefore`,
 * `hobbyiqCardIdBefore`, `setSportRepairedAt`, and overwrote `sport` and
 * `hobbyiqCardId`. It NEVER changed `cardId` (the partition key) and never
 * touched any container but sold_comps. So a restore is symmetric with the
 * repair for the common case (this lane's own patch, same shape, opposite
 * direction) and needs a partition MOVE only when `cardId` happens to equal
 * the WRONG (post-repair) `hobbyiqCardId` -- the repair's own patch left
 * `cardId` alone, so a row whose original cardId was ALREADY the numeric/
 * vendor partition never needs to move; only a row whose cardId was set to
 * the (now wrong) hiq: slug at some point does.
 *
 * SELF-DERIVING, NOT LIST-DRIVEN. The 69,598-row census lists
 * (r76/r76-manifest.json + 7 list files) are READ-ONLY INPUTS the census
 * used to validate the classifier; they are not committed here (25MB of ids
 * has no place in this repo, and a list goes stale the moment any other
 * lane touches these rows). This lane instead SELECTS LIVE:
 *
 *   IS_DEFINED(c.setSportRepairedAt) AND NOT IS_DEFINED(c.setSportReversedAt)
 *
 * paged (maxItemCount 1000, continuation token), scoped by SCOPE, NEVER a
 * COUNT/GROUP BY. A row this run restores stamps `setSportReversedAt` and
 * so drops out of the selection on any later run -- idempotent by
 * construction, exactly like every sibling budgeted lane.
 *
 * THE GAZETTEER (scripts/lib/sport-title-evidence.cjs) is the SAME module
 * setSportAuthority.cjs's own veto now uses (R76 fixed the cause in the
 * same PR) -- one rule, two call sites, so this lane's verdicts and the
 * (now-idle) repair's veto can never drift apart the way the five-word
 * list and the census's classifier already drifted once. The census's own
 * 300-row validation sample (r76/validation-300.json, ported into
 * backend/tests/fixtures/r76/) reproduces 300/300 "restore" against this
 * module -- see revertSetSportRepairLane.test.ts and
 * sportTitleEvidence.test.ts.
 *
 * VERDICT PER ROW (judgeRestoreVerdict, sport-title-evidence.cjs):
 *   restore   title evidence backs sportBefore, not the current sport --
 *             the flip moved the card away from the sport its own title
 *             names. Fixed.
 *   keep      title evidence backs the current sport, not sportBefore --
 *             the flip was RIGHT. Nothing written; `setSportReversedAt` is
 *             NOT stamped (this row still carries `setSportRepairedAt` with
 *             no reversal, so a later, smarter pass could still reconsider
 *             it -- but THIS lane leaves it alone, counted `keep`).
 *   leave     title evidence names a third sport, both sports, or neither.
 *             A human rules on these; listed by reason, never guessed.
 *
 * GUARDS BEFORE ANY WRITE:
 *   moved-since       the doc's CURRENT sport/hobbyiqCardId no longer equal
 *                     what the repair itself wrote (something else moved it
 *                     since 08-20) -- restoring blind would stomp a LATER,
 *                     unrelated correction. Left, listed.
 *   guard-parked      guardSoldCompDoc (splitIdentityWriteGuard.js, the
 *                     SAME write-door guard every other sold_comps writer in
 *                     this repo goes through) would PARK the restored
 *                     document (e.g. a malformed hobbyiqCardIdBefore) --
 *                     never written; listed.
 *   destination-collision  (relocate shape only) a DIFFERENT sale already
 *                     resides at (id, hobbyiqCardIdBefore) -- refused, both
 *                     listed, neither moved. Same sale by content hash ->
 *                     COLLAPSE (delete the wrong-partition copy, keep the
 *                     resident), the same predicate
 *                     repoint-sales-to-checklist-numbered.cjs uses.
 *
 * TWO WRITE SHAPES, exactly the ruling's split:
 *   PATCH (the 67,180-row majority): `cardId` is UNCHANGED by the original
 *     repair (it never touched cardId), so restoring is an in-place patch:
 *     sport := sportBefore, hobbyiqCardId := hobbyiqCardIdBefore, stamp
 *     setSportReversedAt/setSportReversedReason. No partition move.
 *   RELOCATE (the 2,418-row minority): `cardId === hobbyiqCardId` (the
 *     CURRENT, wrong-sport slug) -- i.e. the row's own partition key is the
 *     wrong-sport hiq: slug, so restoring the slug means restoring the
 *     PARTITION too. Goes through relocate-sold-comp.cjs's relocateSoldComp
 *     (upsert kept doc at hobbyiqCardIdBefore -> verify read-back -> delete
 *     the old partition row), the ONE way a sold_comps row changes its key
 *     in this repo (CF-A-SALE-IS-NEVER-LOST). The destination-collision
 *     check runs BEFORE the upsert, same order
 *     repoint-sales-to-checklist-numbered.cjs uses.
 *
 * REPORT-FIRST. BACKFILL_APPLY=true (or APPLY=true) gates every write.
 * REPORT runs the EXACT SAME selection, verdicts, guards and destination-
 * collision reads as APPLY and prints the real counts -- `planRow` is a pure
 * function of the doc (no I/O) so REPORT and APPLY decide identically; the
 * only difference is whether the write actually lands, which the pinned
 * test (REPORT's counts equal APPLY's on one fixture) asserts.
 *
 * SCOPE IS REQUIRED, BY NAME. Either the single literal `all-repaired`
 * (typed explicitly -- an operator choosing to sweep every repaired row) or
 * a comma-separated list of `setKey|year` cells parsed from
 * `hobbyiqCardIdBefore` (e.g. `fleer|1988,score|1989`). The runner's
 * inherited defaults ('', 'refractor', 'all') are ALL refused (exit 2) --
 * none of them is a scope anyone chose for this lane, and 'all' in
 * particular is deliberately NOT accepted as a synonym for 'all-repaired':
 * a whole-source write needs its own name
 * (feedback_a_whole_source_retire_needs_its_name).
 *
 * BUDGET / RELAUNCH / SHARDING follow the sibling convention exactly:
 * lib/runner-budget.cjs (110-minute loop + reserve + verify cap) and
 * lib/runner-shard-scope.cjs (an inherited slot=0/slots=16 sweeps
 * EVERYTHING unless SHARD=true opts in). A restored row drops out of the
 * live selection immediately (setSportReversedAt), so a re-run after a
 * budget stop is idempotent by construction.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MODE=checklist-evidence (R76 second pass, 2026-09-19). EMPTY/DEFAULT MODE
 * IS BYTE-FOR-BYTE UNCHANGED (pinned by test) -- everything above this
 * paragraph describes that default, title-evidence-only pass.
 *
 * THE FIRST PASS'S OWN LEFTOVERS. Reading its own left buckets (this run's
 * REPORT, and the two GH Actions artifacts named in the PR): no-evidence
 * (title has no sport words at all, e.g. "1988 Fleer Michael Jordan #17" --
 * ~100k), rekeyed-since (a LATER lane re-keyed the row within the wrong
 * sport, ~23k), both-named / third-sport (title's word evidence is
 * genuinely ambiguous, ~1.4k+1.3k), guard-parked (912, unchanged, see D
 * below), keep (~1.1k, the default mode already leaves these alone).
 *
 * EVIDENCE = THE CHECKLIST DECIDES (doctrine). Title words are a PROXY for
 * what a card is; the checklist itself is the authority
 * (project_hobbyiq_is_the_pricing_standard). For every row this mode
 * considers it builds exactly two candidate catalog ids and asks
 * card_catalog which one (if either) a CHECKLIST-AUTHORITY row backs:
 *
 *   candidateCurrent  = the row's own CURRENT hobbyiqCardId, unchanged
 *   candidateBefore   = reSportSlug(candidateCurrent, sportBefore) -- the
 *                       SAME current id with ONLY its sport segment swapped
 *                       to sportBefore. Built from the CURRENT id, not from
 *                       hobbyiqCardIdBefore verbatim, so this reads
 *                       correctly even on a rekeyed-since row (B below):
 *                       whatever precision a later lane added to the
 *                       current id (a :num-N tail, a cleaned setKey) is
 *                       carried into the before-sport candidate too, rather
 *                       than discarded the way a literal swap back to
 *                       hobbyiqCardIdBefore would.
 *
 * Each candidate id is point-read from card_catalog (partition key is
 * /cardId -- and for an hiq: slug id === cardId, exactly the point-read
 * shape repoint-sales-to-checklist-numbered.cjs's own catalogTwinAt uses:
 * `cat.item(id, id).read()`).
 *
 * A CHECKLIST-AUTHORITY ROW AT AN ADDRESS IS NOT EVIDENCE ABOUT THIS SALE
 * UNLESS IT NAMES THE SAME CARD (measured, 2026-09-19, and the reason this
 * mode is NOT the naive "candidate id resolves to a checklist row" rule its
 * first draft was). `sold_comps` and `card_catalog` share an identity CELL
 * (sport:year:setKey:cardNumber:parallel:auto), not a one-card-per-cell
 * guarantee -- Fleer/Bowman/Topps/Upper Deck etc. issue INDEPENDENT
 * checklists per sport under the same publisher/year/product name, so the
 * same (year, setKey, cardNumber) cell is legitimately TWO DIFFERENT CARDS,
 * one per sport. Read-only sampling of 300 rows from the actual left
 * population found this cell collision on the majority of "keep" verdicts a
 * bare address-authority check would produce: e.g. `hiq:baseball:1994:
 * ultra:2:base:no-auto` IS a real checklist row (source: baseballcardpedia)
 * -- for Barry Bonds. The 1994 Fleer Ultra BASKETBALL #2 sale it was being
 * judged against (title: "1994-95 Fleer Ultra - Power in the Key #2
 * Patrick Ewing") has NOTHING to do with that row; the address merely
 * exists on the baseball side of the SAME publisher/year/product/number
 * cell. Trusting the bare address would have manufactured a false "keep"
 * (and, symmetrically, a false "restore" wherever the collision runs the
 * other way) on exactly the population this mode exists to adjudicate
 * carefully -- a card_catalog cell match is not identity
 * (feedback_ratio_similarity_is_not_identity's own doctrine, one level up
 * from a ratio: matching an ADDRESS is not matching a CARD).
 *
 * THE FIX: a candidate id only counts as checklist-authority evidence FOR
 * THIS SALE when its catalog row is BOTH (1) catalogAuthorityOf(row.source)
 * === "checklist" (catalogAuthority.service.js -- the SAME declaration
 * repoint-sales-to-checklist-numbered.cjs's `isChecklist` uses; not
 * re-implemented) AND (2) playerIdentityKey(row.playerName) ===
 * playerIdentityKey(sale.playerName) (playerIdentityKey.ts -- the ONE
 * reduction catalogRowOps.service.ts's survivor rule, sourceCorroboration.ts
 * and player-evidence.cjs already share for exactly this question; not a
 * fourth copy). `sale.playerName` is a STORED field on sold_comps rows
 * (populated at ingest, independent of the title-word gazetteer this mode
 * exists to go past) -- measured 100% populated on a 20,768-row sample of
 * the live left population, so this is not a coverage gap in practice. A
 * sale with NO playerName of its own can never corroborate identity this
 * way and its candidates are treated as unmatched (see
 * `checklistMatchOf` below) -- absent beats wrong, same doctrine as every
 * other "cannot confirm, so do not act" branch in this file.
 *
 * Reads are cached per id, per run (a Map, never re-read the same id twice
 * in one process); the player-identity compare is pure and adds no I/O.
 *
 * VERDICTS (judgeChecklistEvidenceVerdict below):
 *   restore   only candidateBefore has a checklist-authority row that ALSO
 *             names the same player as the sale -- the checklist itself
 *             says this card belongs to sportBefore, not current. Fixed via
 *             the SAME two write shapes as the title pass (patch when
 *             cardId is untouched, relocate when cardId === the current
 *             hobbyiqCardId) -- B below covers the rekeyed-since case,
 *             where the restore TARGET is candidateBefore itself (already
 *             carrying whatever later precision the row picked up), never
 *             hobbyiqCardIdBefore.
 *
 *             TWO-SPORT ATHLETE BOUND (orchestrator ruling, review MEDIUM,
 *             2026-09-19): candidateCurrent being "no-row" (nobody has
 *             ingested a checklist for the current sport at that address at
 *             all) is ABSENCE of counter-evidence, not a disagreeing
 *             checklist -- for an ordinary single-sport player that costs
 *             nothing (no rival checklist can exist for a sport they never
 *             played), but for a genuine two-sport athlete (Bo Jackson,
 *             Deion Sanders, ...) a catalog coverage gap must not be read as
 *             the checklist siding with sportBefore. For a player on the
 *             committed gazetteer (scripts/lib/two-sport-athletes.cjs,
 *             keyed by playerIdentityKey), restore additionally requires
 *             candidateCurrent to be "different-card" -- a row EXISTS there
 *             and names someone else, i.e. POSITIVE counter-evidence, not
 *             merely its absence. Short of that, the row is left, named
 *             `two-sport-athlete`. This is a no-op for every non-listed
 *             player and for a listed player whose currentMatch already IS
 *             "different-card". The REPORT artifact separately lists (up to
 *             50) every restore in a run whose currentMatch was "no-row",
 *             so a pilot dispatch can be eyeballed for a two-sport athlete
 *             the gazetteer missed before any wider APPLY.
 *   keep      only candidateCurrent has a matching checklist-authority row
 *             -- the flip was right. Nothing is written to sport/
 *             hobbyiqCardId; `setSportReviewedAt` + `setSportReviewedReason`
 *             ARE stamped (APPLY only) so a re-run of THIS mode skips it
 *             without re-reading the catalog twice -- see the idempotency
 *             note below for why this diverges from the default mode's bare
 *             "keep, stamp nothing".
 *   leave     both candidates have a matching checklist-authority row
 *             ("both-sports-have-checklist-row"), neither does
 *             ("no-checklist-row-either"), a candidate address resolves to
 *             a checklist row for a DIFFERENT PLAYER
 *             ("checklist-row-names-different-card" -- the cell-collision
 *             case above: real evidence that this address is the WRONG
 *             card, not absence of evidence, so it is named and listed
 *             separately rather than folded into "no-checklist-row-either"),
 *             or the sale's player is a known two-sport athlete and the only
 *             evidence for a restore is absence, not disagreement
 *             ("two-sport-athlete", see above) -- a human rules on these,
 *             named and listed exactly like the title pass's own leave
 *             reasons.
 *
 * CATALOG-READ FAILURE ISOLATION (review HIGH, 2026-09-19). A persistent
 * (non-404) catalog read failure -- a 429/503 that exhausts `retry`, a
 * network blip -- for ONE row's candidate id is caught at the narrowest
 * point that knows it is a read failure, not a verdict: `s.failed++`, the
 * row named in FAILURES, and the row is given NO verdict at all (never
 * cached as "no-row", never silently treated as absence of a checklist).
 * The bounded-concurrency batch dispatch (the page-walk's own
 * `Promise.all(batch.map(...))`) additionally catches per-row as a
 * backstop, matching the sibling lanes' own convention (e.g.
 * repair-ch-product-label-parallel.cjs), so ANY row-level throw -- not only
 * a catalog read -- can never make the whole batch, page walk, or run fail:
 * one bad id must never cost the RECONCILE line, the relaunch-on-marker
 * banner, or every other row's decision in the same run.
 *
 * IDEMPOTENCY / RE-RUN SAFETY. The default mode's selection
 * (`candidateSpec`) is `setSportRepairedAt AND NOT setSportReversedAt` --
 * unchanged by this mode, and still what BOTH modes select on, so a
 * checklist-evidence run reaches every row the title pass could not fix.
 * A checklist-evidence KEEP does not stamp `setSportReversedAt` (nothing
 * moved, exactly like the title pass's own keep), so without a marker of
 * its own it would be RE-JUDGED by every future checklist-evidence run
 * forever, re-reading the same two catalog rows for no new information --
 * wasted RUs at scale, not a correctness bug (the verdict cannot change
 * without the catalog itself changing). `setSportReviewedAt` /
 * `setSportReviewedReason: "R76-checklist-evidence"` close that: a future
 * checklist-evidence run's own candidate predicate additionally excludes
 * `IS_DEFINED(c.setSportReviewedAt)` (see candidateSpecFor below), so a
 * reviewed-and-kept row drops out exactly the way a restored row already
 * does via `setSportReversedAt`. REPORT and APPLY still decide identically
 * (the stamp only changes what a LATER run selects, never this run's own
 * verdict), preserving REPORT==APPLY parity.
 *
 * B. REKEYED-SINCE ROWS, restored in this mode. The default mode's own
 * rekeyed-since check (planRow, above) fires when the current hobbyiqCardId
 * does not equal reSportSlug(hobbyiqCardIdBefore, currentSport) -- i.e. some
 * LATER lane re-keyed the row within the wrong sport (a :num-N tail, a
 * cleaned setKey, an RC-marker repair) since the 08-20 flip, and the
 * default mode LEAVES it rather than discard that later precision by
 * restoring hobbyiqCardIdBefore verbatim. This mode can still restore such
 * a row, because its restore target is never hobbyiqCardIdBefore --
 * candidateBefore is built from the CURRENT (already re-keyed) id, so the
 * later precision rides along automatically. The Jordan case: a row whose
 * current hobbyiqCardId is `hiq:baseball:1988:fleer:17:base:no-auto:num-23`
 * (a later repoint-sales-to-checklist-numbered pass appended `:num-23`
 * within the wrong sport) restores to
 * `hiq:basketball:1988:fleer:17:base:no-auto:num-23` -- ONE axis (sport)
 * changes, the `:num-23` tail this lane never derived stays exactly as a
 * later, smarter pass wrote it. Restored via patch or relocate exactly as
 * any other checklist-evidence restore (cardId === current hobbyiqCardId
 * decides the shape, same as always).
 *
 * C. NO-EVIDENCE / BOTH-NAMED / THIRD-SPORT rows: all fall through to the
 * SAME verdict function A describes -- no separate code path. A title with
 * no sport words at all is exactly the "no title evidence, ask the
 * checklist" case this mode exists for; both-named/third-sport rows are
 * REQUIRED to have UNAMBIGUOUS checklist evidence (exactly one candidate
 * checklist-backed) to move at all, same bar as every other row -- an
 * ambiguous title does not lower it.
 *
 * D. GUARD-PARKED (912, from the title pass): unchanged, listed. These rows
 * carry a malformed hobbyiqCardIdBefore or hobbyiqCardId that the write-door
 * guard (guardSoldCompDoc) already refused under the title pass; this mode
 * runs the SAME malformed-id / guard-parked checks (planRow's early
 * refusals, guardSoldCompDoc before every write) and so parks them
 * identically rather than attempting a second, different repair on rows the
 * first pass already proved unsafe to touch mechanically.
 *
 * SCOPE, BUDGET, SHARDING, WRITE SHAPES (patch / relocate / collapse /
 * destination-collision), RECONCILIATION: all IDENTICAL machinery to the
 * default mode, described above -- this mode changes only the VERDICT
 * (title words -> checklist authority) and the rekeyed-since behaviour (B).
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true / APPLY=true to write;
 *      SCOPE required ('all-repaired' or comma setKey|year cells);
 *      MODE='' (default, title-evidence) | 'checklist-evidence' (this mode);
 *      SLOT/SLOTS (sha1(id) shards, opt-in via SHARD=true for slot 0);
 *      CONCURRENCY=8 (read fan-out); RUN_MINUTES=110; LIMIT=0.
 * Requires dist/ (splitIdentityWriteGuard, catalogAuthority.service.js) and
 * scripts/lib (sport-title-evidence, relocate-sold-comp, runner-budget,
 * runner-shard-scope).
 */
"use strict";
const path = require("path");
const crypto = require("node:crypto");
const backend = path.resolve(__dirname, "..");

const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { judgeRestoreVerdict } = require(path.join(__dirname, "lib", "sport-title-evidence.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

// ── MODE. Empty/unset = the original title-evidence pass, BYTE-FOR-BYTE
// unchanged (pinned by test) -- every reader of MODE below treats "" and
// "title-evidence" as the identical default. 'checklist-evidence' is the
// second pass described in the header above. Any other value is refused
// (exit 2) rather than silently falling back to the default: a mode name
// that reaches here misspelled must not run the wrong pass unnoticed.
const RAW_MODE = lower(process.env.MODE);
const MODE_CHECKLIST_EVIDENCE = "checklist-evidence";
const KNOWN_MODES = new Set(["", "title-evidence", MODE_CHECKLIST_EVIDENCE]);
const MODE = RAW_MODE === "title-evidence" ? "" : RAW_MODE;
const IS_CHECKLIST_EVIDENCE = MODE === MODE_CHECKLIST_EVIDENCE;

const STARTED = Date.now();
const CLOCK = budget({ minutes: 110, reserveMs: 30 * 1000, verifyMs: 5 * 60 * 1000, startedAt: STARTED });
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8));
const LIMIT = Number(process.env.LIMIT || 0);

const SHARD_SCOPE = runnerShardScope({ label: "revert-set-sport-repair" });
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SHARD_SCOPE.SLOTS;

// ── THE SCOPE. 'all-repaired' (typed explicitly) or setKey|year cells,
// parsed from hobbyiqCardIdBefore. The runner's inherited defaults are ALL
// refused -- there is no bare 'all' synonym; a whole-source sweep needs its
// own name.
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const ALL_REPAIRED = "all-repaired";
const CELL_RE = /^[a-z][a-z0-9-]*\|\d{4}$/;
const RAW_SCOPE = csv(process.env.SCOPE);
const SCOPE_IS_ALL_REPAIRED = RAW_SCOPE.length === 1 && lower(RAW_SCOPE[0]) === ALL_REPAIRED;
const SCOPE_CELLS = SCOPE_IS_ALL_REPAIRED ? [] : RAW_SCOPE.map(lower).filter((p) => CELL_RE.test(p));
const SCOPE_REJECTED = SCOPE_IS_ALL_REPAIRED ? [] : RAW_SCOPE.filter((p) => !CELL_RE.test(lower(p)));

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

/** The candidate predicate: every row the 08-20 repair touched and this lane
 *  has not yet reversed. Equality/IS_DEFINED filters only, never a
 *  cross-partition COUNT/GROUP BY. sold_comps partitions on /cardId, so this
 *  is necessarily a cross-partition scan -- bounded by maxItemCount and a
 *  continuation token, same as every other census-shaped lane in this repo.
 *
 *  MODE=checklist-evidence ALSO excludes IS_DEFINED(c.setSportReviewedAt) --
 *  see the module header's "IDEMPOTENCY / RE-RUN SAFETY" note: a row this
 *  mode judged KEEP stamps that marker (nothing else changed, so
 *  setSportReversedAt is never set for it) precisely so a later run of this
 *  SAME mode does not re-read the same two catalog rows for a verdict that
 *  cannot have changed. The default/title-evidence mode never reads or
 *  writes setSportReviewedAt and its own predicate is BYTE-FOR-BYTE
 *  unchanged. */
function candidateSpec(isChecklistEvidence) {
  return {
    query: `SELECT * FROM c
            WHERE IS_DEFINED(c.setSportRepairedAt)
              AND NOT IS_DEFINED(c.setSportReversedAt)${isChecklistEvidence ? "\n              AND NOT IS_DEFINED(c.setSportReviewedAt)" : ""}`,
    parameters: [],
  };
}

/** The `setKey|year` cell a row belongs to, read from its OWN
 *  hobbyiqCardIdBefore (hiq:{sport}:{year}:{setKey}:...) -- the address the
 *  repair itself recorded, not a re-derivation. Returns null when the field
 *  is missing or not a well-formed hiq slug (the row is then only reachable
 *  under scope=all-repaired, and is listed under `malformed-before-id` if a
 *  write is attempted on it). */
function cellOf(hobbyiqCardIdBefore) {
  const parts = String(hobbyiqCardIdBefore ?? "").split(":");
  if (parts.length < 4 || parts[0] !== "hiq") return null;
  const year = parts[2];
  const setKey = parts[3];
  if (!/^\d{4}$/.test(year) || !setKey) return null;
  return `${setKey}|${year}`;
}

/**
 * EXACT MIRROR of repair-set-sport.cjs's own `reSportSlug` (read from that
 * file, 2026-09-19, to answer the review's BLOCKER 1 exactly rather than
 * guess): the repair swapped ONLY segment 1 (sport) of the hiq slug,
 * byte-preserving every other segment --
 *
 *   function reSportSlug(slug, toSport) {
 *     const p = String(slug).split(":");
 *     if (p.length < 7 || p[0] !== "hiq") return null;
 *     p[1] = toSport;
 *     return p.join(":");
 *   }
 *
 * and its APPLY loop wrote exactly `{ sportBefore: fromSport,
 * hobbyiqCardIdBefore: from, sport: toSport, hobbyiqCardId: to }` with
 * `to = reSportSlug(from, toSport)` -- NO separate `*After` field and NO
 * ledger records the after-value directly, so the after-value the repair
 * wrote is fully reconstructible from hobbyiqCardIdBefore + the sport it
 * flipped to, and nothing else. This is that reconstruction. */
function reSportSlug(slug, toSport) {
  const p = String(slug ?? "").split(":");
  if (p.length < 7 || p[0] !== "hiq") return null;
  p[1] = toSport;
  return p.join(":");
}

/**
 * Pure per-row decision -- no I/O -- so REPORT and APPLY run the EXACT same
 * logic and a test can assert REPORT's counts equal APPLY's on one fixture.
 *
 * @param {object} doc  the sold_comps row as read
 * @returns one of:
 *   { action: "keep" }
 *   { action: "leave", reason, detail }
 *   { action: "patch", newSport, newHobbyiqCardId, alreadyAtTarget? }
 *   { action: "relocate", newSport, newHobbyiqCardId }
 */
function planRow(doc) {
  const sportBefore = str(doc.sportBefore);
  const hobbyiqCardIdBefore = str(doc.hobbyiqCardIdBefore);
  const currentSport = str(doc.sport);
  const currentHiq = str(doc.hobbyiqCardId);
  const cardId = str(doc.cardId);

  if (!sportBefore || !hobbyiqCardIdBefore) {
    return { action: "leave", reason: "malformed-before-id", detail: "sportBefore or hobbyiqCardIdBefore missing on a row carrying setSportRepairedAt" };
  }

  // ── DEFENSIVE REFUSAL (review HIGH 2 follow-up): hobbyiqCardId itself is
  // missing or empty. This must never silently fall through to reasoning
  // about cardId in its place -- cardId can be a vendor partition key that
  // looks nothing like an hiq slug, and treating it as one would misjudge
  // every later check below.
  if (!currentHiq) {
    return { action: "leave", reason: "malformed-current-id", detail: "hobbyiqCardId is empty or absent on a row carrying setSportRepairedAt" };
  }

  // ── ALREADY AT TARGET: some earlier process (a prior partial run of this
  // very lane, or an unrelated independent fix) already set sport/
  // hobbyiqCardId back to the *Before values, but never stamped
  // setSportReversedAt -- so the row is still selected by candidateSpec().
  // There is nothing left to restore; bring it into the reversed state
  // cleanly (stamp only) rather than re-run judgeRestoreVerdict against a
  // title/sport pairing that no longer describes what actually happened.
  if (currentSport === sportBefore && currentHiq === hobbyiqCardIdBefore) {
    return { action: "patch", newSport: sportBefore, newHobbyiqCardId: hobbyiqCardIdBefore, alreadyAtTarget: true };
  }

  // ── REKEYED-SINCE (review BLOCKER 1, 2026-09-19): does the CURRENT
  // hobbyiqCardId still equal EXACTLY what the 08-20 repair itself would
  // have written? repair-set-sport.cjs's own `reSportSlug` swaps ONLY
  // segment 1 (sport), byte-preserving every other segment -- it never
  // stored a separate after-value, so "what the repair wrote" is fully
  // reconstructible as reSportSlug(hobbyiqCardIdBefore, currentSport).
  //
  // When the current id does NOT equal that reconstruction, a LATER lane
  // (repoint-sales-to-checklist-numbered appending a `:num-N` tail,
  // rekey-catalog-id-to-setkey swapping the setKey segment, an RC-marker
  // repair, a rematch pass, ...) has re-keyed this row WITHIN the wrong
  // sport, adding precision this lane has no way to reproduce on the
  // restored (pre-repair) sport. Restoring hobbyiqCardIdBefore VERBATIM
  // would silently throw that later precision away -- absent beats wrong,
  // so this is left, named, and counted separately from `moved-since`
  // (which is reserved for sport/hobbyiqCardId disagreeing with EACH OTHER,
  // a distinct and stronger signal of external interference).
  //
  // Checked BEFORE judgeRestoreVerdict: a rekeyed-since row is left
  // regardless of what its title says, because the id itself is evidence
  // this lane cannot safely act past.
  const reconstructedAfter = reSportSlug(hobbyiqCardIdBefore, currentSport);
  if (reconstructedAfter === null) {
    return { action: "leave", reason: "malformed-current-id", detail: `hobbyiqCardIdBefore (${hobbyiqCardIdBefore}) is not a well-formed hiq slug the repair's own reSportSlug could have produced` };
  }
  if (currentHiq !== reconstructedAfter) {
    return { action: "leave", reason: "rekeyed-since", detail: `current hobbyiqCardId (${currentHiq}) does not equal reSportSlug(hobbyiqCardIdBefore, sport) = ${reconstructedAfter} -- a later lane re-keyed this row within the wrong sport (a :num-N tail, a setKey swap, an RC-marker or rematch pass) since the 08-20 repair; restoring hobbyiqCardIdBefore verbatim would discard that later precision`, currentHiq, reconstructedAfter, hobbyiqCardIdBefore };
  }
  // NOTE: once currentHiq === reconstructedAfter passes, currentHiq's own
  // sport segment is BY CONSTRUCTION equal to currentSport (reSportSlug sets
  // segment 1 to exactly currentSport) -- so a separate "sport and
  // hobbyiqCardId's sport segment disagree" check can never fire past this
  // point and is not duplicated here. Every way `sport` and `hobbyiqCardId`
  // could disagree with each other is already caught above, either as
  // rekeyed-since (hobbyiqCardId's shape moved) or, when only the bare
  // `sport` field was independently patched to a third value with
  // hobbyiqCardId untouched, ALSO as rekeyed-since (the reconstruction is
  // built FROM the new `sport`, so it changes too and no longer matches the
  // stale hobbyiqCardId).

  const verdict = judgeRestoreVerdict({ title: doc.title, sportBefore, currentSport });
  if (verdict.verdict === "keep") return { action: "keep", reason: verdict.reason, detail: verdict.detail };
  if (verdict.verdict === "leave") return { action: "leave", reason: verdict.reason, detail: verdict.detail };

  // verdict.verdict === "restore" from here. The relocate shape additionally
  // requires cardId to be EXACTLY the current hobbyiqCardId (never merely
  // "looks like an hiq slug") -- same exact-match discipline as the
  // hobbyiqCardId reconstruction above, so a cardId that drifted from
  // hobbyiqCardId in some OTHER way is never silently relocated past.
  const needsRelocate = cardId && cardId === currentHiq;

  return {
    action: needsRelocate ? "relocate" : "patch",
    newSport: sportBefore,
    newHobbyiqCardId: hobbyiqCardIdBefore,
  };
}

/**
 * MODE=checklist-evidence's own candidate ids for one row -- pure, no I/O.
 * `candidateBefore` is built from the CURRENT hobbyiqCardId (never from
 * hobbyiqCardIdBefore) so it reads correctly on a rekeyed-since row too (see
 * module header, section B): whatever a LATER lane added to the current id
 * (a :num-N tail, a cleaned setKey) survives the sport swap intact.
 *
 * Returns null candidates when the current id is not a well-formed hiq slug
 * reSportSlug can operate on -- the caller treats that the same as any other
 * malformed-current-id case.
 */
function checklistEvidenceCandidateIds(doc) {
  const currentHiq = str(doc.hobbyiqCardId);
  const sportBefore = str(doc.sportBefore);
  const candidateCurrent = currentHiq || null;
  const candidateBefore = currentHiq && sportBefore ? reSportSlug(currentHiq, sportBefore) : null;
  return { candidateCurrent, candidateBefore };
}

/**
 * Classify ONE candidate address's catalog row against the SALE it is being
 * judged for -- pure, no I/O (the row itself and the sale's playerName are
 * handed in; the caller owns the point read). See module header: an address
 * being checklist-authority is not, by itself, evidence about THIS sale --
 * Fleer/Bowman/etc. issue independent per-sport checklists that share a
 * (year, setKey, cardNumber, parallel) cell, so the row at the candidate
 * address can be a checklist-authority row for a COMPLETELY DIFFERENT CARD.
 *
 * @param {object|null} catalogRow        the point-read result, or null (404)
 * @param {string} salePlayerName         the SALE's own stored playerName
 * @param {(source: unknown) => string} catalogAuthorityOf
 * @param {(name: unknown) => string} playerIdentityKey
 * @returns {"match"|"different-card"|"no-row"}
 *   match           checklist-authority AND playerIdentityKey agrees with
 *                   the sale's own playerName -- usable evidence.
 *   different-card  checklist-authority but playerIdentityKey DISAGREES (or
 *                   the sale carries no playerName to compare against) --
 *                   real evidence this address names the wrong card, never
 *                   silently treated the same as "nothing here".
 *   no-row          no row at this address, or the row is not
 *                   checklist-authority at all (vendor/derived/unknown).
 */
function checklistMatchOf(catalogRow, salePlayerName, catalogAuthorityOf, playerIdentityKey) {
  if (!catalogRow) return "no-row";
  if (catalogAuthorityOf(catalogRow.source) !== "checklist") return "no-row";
  const saleKey = playerIdentityKey(salePlayerName);
  const rowKey = playerIdentityKey(catalogRow.playerName);
  if (!saleKey || !rowKey) return "different-card"; // cannot confirm -- absent beats wrong, never trust a bare address match
  return saleKey === rowKey ? "match" : "different-card";
}

/**
 * THE R76 CHECKLIST-EVIDENCE VERDICT (module header, section A). Pure: takes
 * the ALREADY-COMPUTED checklistMatchOf classification for each candidate id
 * (strings, not a container or a catalog row) so this function -- like
 * judgeRestoreVerdict -- has no I/O of its own and REPORT/APPLY can share it
 * verbatim.
 *
 * TWO-SPORT ATHLETE BOUND (orchestrator ruling, review MEDIUM, 2026-09-19).
 * `beforeIsMatch && currentMatch === "no-row"` is the RESTORE branch's only
 * source of false positives: `no-row` means "nobody has ingested a checklist
 * for the current sport at this address," which is ABSENCE of counter-
 * evidence, not evidence the current sport is wrong. For a single-sport
 * player that distinction is free -- no rival checklist can exist for a
 * sport they never played. For a genuine two-sport athlete (Bo Jackson,
 * Deion Sanders, ...) it is not: a catalog gap on the current side must not
 * be read as the checklist siding with sportBefore. `isTwoSportAthlete` (the
 * committed gazetteer, keyed by playerIdentityKey so name variants still
 * match) narrows the restore condition for exactly these players to require
 * currentMatch === "different-card" -- a row EXISTS at the current address
 * and names someone else, i.e. POSITIVE counter-evidence, not merely its
 * absence. Absent that stronger evidence, the row is left, named
 * `two-sport-athlete`, for a human. This changes nothing for the ordinary
 * (non-listed) player and nothing for a two-sport athlete whose currentMatch
 * is already "different-card" (a real collision the gazetteer does not need
 * to gate, since the evidence is already strong enough on its own merits).
 *
 * @param {"match"|"different-card"|"no-row"} beforeMatch  checklistMatchOf(candidateBefore's row, ...)
 * @param {"match"|"different-card"|"no-row"} currentMatch checklistMatchOf(candidateCurrent's row, ...)
 * @param {boolean} [saleIsTwoSportAthlete]  isTwoSportAthlete(sale's own playerIdentityKey) -- computed by the caller so this function stays pure and takes no I/O or gazetteer dependency of its own.
 * @returns {{ verdict: "restore"|"keep"|"leave", reason: string, detail: string }}
 */
function judgeChecklistEvidenceVerdict({ beforeMatch, currentMatch, saleIsTwoSportAthlete }) {
  const beforeIsMatch = beforeMatch === "match";
  const currentIsMatch = currentMatch === "match";
  if (beforeIsMatch && !currentIsMatch) {
    if (saleIsTwoSportAthlete && currentMatch !== "different-card") {
      return { verdict: "leave", reason: "two-sport-athlete", detail: `this player is a known two-sport athlete and the current-sport candidate is only "${currentMatch}" (absence of counter-evidence, not a disagreeing checklist row) -- a catalog gap must not be read as the checklist siding with sportBefore for a player who genuinely could have a card in either sport` };
    }
    return { verdict: "restore", reason: "checklist-backs-before", detail: "only the pre-repair sport's candidate id has a checklist-authority card_catalog row naming the SAME player as this sale" };
  }
  if (currentIsMatch && !beforeIsMatch) {
    return { verdict: "keep", reason: "checklist-backs-current", detail: "only the current (post-repair) sport's candidate id has a checklist-authority card_catalog row naming the SAME player as this sale -- the flip was right" };
  }
  if (beforeIsMatch && currentIsMatch) {
    return { verdict: "leave", reason: "both-sports-have-checklist-row", detail: "BOTH candidate ids have a checklist-authority card_catalog row naming the same player as this sale -- cannot disambiguate from the catalog alone" };
  }
  if (beforeMatch === "different-card" || currentMatch === "different-card") {
    return { verdict: "leave", reason: "checklist-row-names-different-card", detail: `a candidate address is checklist-authority but names a DIFFERENT player than this sale (before=${beforeMatch}, current=${currentMatch}) -- the address is a cell collision (a different sport's card sharing year/setKey/cardNumber/parallel), not evidence about this sale` };
  }
  return { verdict: "leave", reason: "no-checklist-row-either", detail: "NEITHER candidate id has a checklist-authority card_catalog row" };
}

/**
 * Pure per-row decision for MODE=checklist-evidence -- exactly the same
 * shape and guard order as planRow (malformed-id / already-at-target
 * checks first, same write-shape decision last), but the verdict comes from
 * `judgeChecklistEvidenceVerdict` (a pre-computed catalog-read result, see
 * checklistEvidenceCandidateIds) instead of judgeRestoreVerdict, and there
 * is NO rekeyed-since refusal: this mode's whole point is restoring exactly
 * those rows (module header, section B), so the restore target is always
 * `candidateBefore` (built from the CURRENT id), never
 * hobbyiqCardIdBefore verbatim.
 *
 * @param {object} doc  the sold_comps row as read
 * @param {{verdict:string,reason:string,detail:string}} checklistVerdict  the
 *        result of judgeChecklistEvidenceVerdict on this row's own candidate
 *        ids (computed by the caller, which owns the async catalog reads)
 * @returns one of:
 *   { action: "keep", reason, detail }
 *   { action: "leave", reason, detail }
 *   { action: "patch"|"relocate", newSport, newHobbyiqCardId, alreadyAtTarget? }
 */
function planRowChecklistEvidence(doc, checklistVerdict) {
  const sportBefore = str(doc.sportBefore);
  const hobbyiqCardIdBefore = str(doc.hobbyiqCardIdBefore);
  const currentSport = str(doc.sport);
  const currentHiq = str(doc.hobbyiqCardId);
  const cardId = str(doc.cardId);

  if (!sportBefore || !hobbyiqCardIdBefore) {
    return { action: "leave", reason: "malformed-before-id", detail: "sportBefore or hobbyiqCardIdBefore missing on a row carrying setSportRepairedAt" };
  }
  if (!currentHiq) {
    return { action: "leave", reason: "malformed-current-id", detail: "hobbyiqCardId is empty or absent on a row carrying setSportRepairedAt" };
  }

  // ── ALREADY AT TARGET: same shape as planRow -- some earlier process (a
  // prior partial run, or an unrelated fix) already restored sport/
  // hobbyiqCardId without stamping setSportReversedAt. Nothing left to
  // decide from the catalog; bring it into the reversed state cleanly.
  if (currentSport === sportBefore && currentHiq === hobbyiqCardIdBefore) {
    return { action: "patch", newSport: sportBefore, newHobbyiqCardId: hobbyiqCardIdBefore, alreadyAtTarget: true };
  }

  const candidateBefore = reSportSlug(currentHiq, sportBefore);
  if (candidateBefore === null) {
    return { action: "leave", reason: "malformed-current-id", detail: `hobbyiqCardId (${currentHiq}) is not a well-formed hiq slug reSportSlug could operate on` };
  }

  if (checklistVerdict.verdict === "keep") return { action: "keep", reason: checklistVerdict.reason, detail: checklistVerdict.detail };
  if (checklistVerdict.verdict === "leave") return { action: "leave", reason: checklistVerdict.reason, detail: checklistVerdict.detail };

  // checklistVerdict.verdict === "restore" from here. Restore target is
  // candidateBefore (built from the CURRENT id -- section B: this carries
  // forward any later precision a rekeyed-since row picked up), never
  // hobbyiqCardIdBefore verbatim. Relocate iff cardId is EXACTLY the
  // current hobbyiqCardId, same exact-match discipline as planRow.
  const needsRelocate = cardId && cardId === currentHiq;
  return {
    action: needsRelocate ? "relocate" : "patch",
    newSport: sportBefore,
    newHobbyiqCardId: candidateBefore,
  };
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  REVERT-SET-SPORT-REPAIR (R76): restore wrongly-flipped sales to their");
  console.log("  pre-08-20 sport and card id");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  if (SCOPE_REJECTED.length) {
    console.error("");
    console.error(`FATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are neither`);
    console.error(`       'all-repaired' nor a setKey|year cell: ${SCOPE_REJECTED.join(", ")}`);
    console.error("       A cell looks like fleer|1988 (setKey|year).");
    process.exit(2);
  }
  if (!SCOPE_IS_ALL_REPAIRED && (!SCOPE_CELLS.length || RAW_SCOPE.some((x) => INHERITED_SCOPES.has(lower(x))))) {
    console.error("");
    console.error("FATAL: SCOPE is REQUIRED. Pass -f scope=all-repaired to sweep every row");
    console.error("       this lane can reach, or a comma list of setKey|year cells, e.g.");
    console.error("       -f scope=fleer|1988,score|1989. The runner's inherited default");
    console.error("       ('', 'refractor', 'all') is refused -- there is no bare 'all' synonym");
    console.error("       for this lane; a whole-source restore needs its own name.");
    process.exit(2);
  }
  if (!KNOWN_MODES.has(RAW_MODE)) {
    console.error("");
    console.error(`FATAL: MODE "${process.env.MODE}" is not recognised. Use '' (default,`);
    console.error("       title-evidence) or 'checklist-evidence' (R76 second pass).");
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { guardSoldCompDoc } = require(path.join(backend, "dist/services/portfolioiq/splitIdentityWriteGuard.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));
  // MODE=checklist-evidence only. catalogAuthorityOf reads the SAME
  // declaration repoint-sales-to-checklist-numbered.cjs's own `isChecklist`
  // uses; playerIdentityKey reads the SAME reduction catalogRowOps.service's
  // survivor rule, sourceCorroboration.ts and player-evidence.cjs already
  // share (module header: an address being checklist-authority is not
  // evidence about THIS sale unless the row names the same player). Neither
  // is re-implemented. Loaded lazily so the default mode's require graph
  // (and its tests) never depend on these dist files existing.
  const catalogAuthorityOf = IS_CHECKLIST_EVIDENCE
    ? require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js")).catalogAuthorityOf
    : null;
  const playerIdentityKey = IS_CHECKLIST_EVIDENCE
    ? require(path.join(backend, "dist/services/catalog/playerIdentityKey.js")).playerIdentityKey
    : null;
  // TWO-SPORT ATHLETE BOUND (review MEDIUM, 2026-09-19) -- see
  // judgeChecklistEvidenceVerdict's own doc and lib/two-sport-athletes.cjs's
  // header for why. A committed .cjs data file, not a dist/ dependency.
  const TWO_SPORT_ATHLETE_KEYS = IS_CHECKLIST_EVIDENCE
    ? require(path.join(__dirname, "lib", "two-sport-athletes.cjs")).buildTwoSportAthleteKeys(playerIdentityKey)
    : null;

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const pool = db.container("sold_comps");
  const cat = IS_CHECKLIST_EVIDENCE ? db.container("card_catalog") : null;

  console.log(`  scope            ${SCOPE_IS_ALL_REPAIRED ? "all-repaired (every row this lane can reach)" : SCOPE_CELLS.join(", ")}`);
  console.log(`  mode             ${IS_CHECKLIST_EVIDENCE ? "checklist-evidence (R76 second pass)" : "title-evidence (default)"}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");
  if (IS_CHECKLIST_EVIDENCE) {
    console.log("  selects sold_comps rows carrying setSportRepairedAt with no");
    console.log("  setSportReversedAt/setSportReviewedAt yet, builds two candidate card_catalog");
    console.log("  ids per row (current sport, and current id with sport swapped to");
    console.log("  sportBefore), and restores the ones where ONLY the before-sport candidate");
    console.log("  has a checklist-authority catalog row -- the checklist itself decides.");
  } else {
    console.log("  selects sold_comps rows carrying setSportRepairedAt with no");
    console.log("  setSportReversedAt yet (paged, continuation token, never a COUNT/GROUP BY),");
    console.log("  judges each by sportEvidence(title) against sportBefore vs the current");
    console.log("  sport, and restores (patch or, when cardId==hobbyiqCardId, relocate) the");
    console.log("  ones whose own title backs the pre-repair sport.");
  }
  console.log("");

  const s = {
    scanned: 0, otherShard: 0, otherCell: 0,
    restoreByPatch: 0, restoreByRelocate: 0, alreadyAtTarget: 0,
    keep: 0, leave: {}, refused: {}, failed: 0,
    collapsedOntoResident: 0,
  };
  const bySetKeyYear = new Map();
  const leaveExamples = {};
  const refuseExamples = {};
  const failures = [];
  const restoreExamples = [];
  const keepExamples = [];
  // MODE=checklist-evidence ONLY (review MEDIUM, 2026-09-19): every restore
  // whose currentMatch was "no-row" -- i.e. restored on ABSENCE of a
  // current-sport checklist row rather than a disagreeing one. Not a defect
  // by itself (an ordinary single-sport player restores correctly this way
  // every time), but it is exactly the shape a missed two-sport athlete
  // would take, so the pilot's own REPORT lists up to 50 of these for a
  // human to eyeball before any wider APPLY.
  const restoreOnNoRowExamples = [];
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const bumpReason = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };
  const pushExample = (map, k, line, cap = 20) => {
    if (!map[k]) map[k] = [];
    if (map[k].length < cap) map[k].push(line);
  };
  let stoppedAtBudget = false;

  /** Point read at the destination this restore would relocate to. Per-sale
   *  address (sale ids are {source}::{externalId} and do not embed cardId,
   *  so the SAME sale id can already be resident at hobbyiqCardIdBefore --
   *  written there by an earlier partial run, or by an entirely unrelated
   *  ingest of the same listing under the correct sport already). */
  async function residentAt(saleId, cardId) {
    try { return (await retry(() => pool.item(saleId, cardId).read())).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
  }

  function isSameSale(resident, incomingAtNewAddress) {
    if (!resident) return false;
    return contentHashOf(resident) === contentHashOf(incomingAtNewAddress);
  }

  // ── MODE=checklist-evidence ONLY. Point read + memoise a card_catalog row
  // by id (partition key IS the id for an hiq: slug -- the same point-read
  // shape repoint-sales-to-checklist-numbered.cjs's catalogTwinAt uses:
  // `cat.item(id, id).read()`). Cached per id, per run: the same candidate
  // id recurs across many sales sharing one identity cell, and this never
  // re-reads it. A malformed (non-hiq, empty) id is never looked up -- the
  // caller only calls this with a value checklistEvidenceCandidateIds/
  // reSportSlug already produced.
  //
  // The cache stores the IN-FLIGHT PROMISE, not just the resolved value:
  // this lane runs a bounded-concurrency batch (CONCURRENCY, default 8) of
  // handleRow calls via Promise.all, so several sales sharing an identity
  // cell can call catalogRowAt(sameId) before the first read resolves. A
  // cache keyed on the resolved value only would race -- every concurrent
  // caller would see a cache miss and issue its OWN read -- exactly the
  // repeat-read this cache exists to prevent. Caching the promise means the
  // second caller awaits the SAME in-flight read rather than starting a new
  // one.
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
  async function handleRow(doc) {
    s.scanned++;
    const cell = cellOf(doc.hobbyiqCardIdBefore);
    if (!SCOPE_IS_ALL_REPAIRED) {
      if (!cell || !SCOPE_CELLS.includes(cell)) { s.otherCell++; return; }
    }
    if (SHARD_SCOPE.SHARDED && shardOf(String(doc.id)) !== SHARD_SCOPE.SLOT) { s.otherShard++; return; }
    if (LIMIT && (s.restoreByPatch + s.restoreByRelocate) >= LIMIT) return;

    let plan;
    if (IS_CHECKLIST_EVIDENCE) {
      // The catalog reads run in BOTH REPORT and APPLY (module header): the
      // only difference between the two modes is whether the write lands.
      const { candidateCurrent, candidateBefore } = checklistEvidenceCandidateIds(doc);
      if (!candidateCurrent) {
        plan = { action: "leave", reason: "malformed-current-id", detail: "hobbyiqCardId is empty or absent on a row carrying setSportRepairedAt" };
      } else if (!candidateBefore) {
        plan = { action: "leave", reason: "malformed-current-id", detail: `hobbyiqCardId (${candidateCurrent}) is not a well-formed hiq slug reSportSlug could operate on` };
      } else {
        // ── REVIEW HIGH (2026-09-19): a persistent (non-404) catalog read
        // failure -- 429/503 exhausting `retry`, a network blip -- must NEVER
        // be silently read as "no-row" (that would manufacture a false
        // verdict from a read that never actually happened) and must NEVER
        // propagate past this row: an uncaught rejection here would escape
        // handleRow, escape the unguarded Promise.all at the page-walk site
        // below, and kill the ENTIRE run on ONE bad id -- no RECONCILE
        // printed, exit 1, relaunch-on-marker never fires because the
        // marker line never gets a chance to print. Caught HERE, at the
        // narrowest point that knows this is a catalog-read failure and not
        // a verdict, exactly the way the write-side try/catch below already
        // isolates one row's write failure from the rest of the batch.
        let currentRow, beforeRow;
        try {
          [currentRow, beforeRow] = await Promise.all([catalogRowAt(candidateCurrent), catalogRowAt(candidateBefore)]);
        } catch (e) {
          s.failed++;
          failures.push(`  FAILED catalog read ${doc.id}@${doc.cardId} (candidateCurrent=${candidateCurrent} candidateBefore=${candidateBefore}): ${String(e?.stack ?? e?.message ?? e)}`);
          return;
        }
        // checklistMatchOf requires the ROW to name the SAME player as this
        // sale, not merely to exist at a checklist-authority address (module
        // header: a shared identity cell can hold a DIFFERENT card on the
        // other sport's checklist).
        const currentMatchForRow = checklistMatchOf(currentRow, doc.playerName, catalogAuthorityOf, playerIdentityKey);
        const checklistVerdict = judgeChecklistEvidenceVerdict({
          beforeMatch: checklistMatchOf(beforeRow, doc.playerName, catalogAuthorityOf, playerIdentityKey),
          currentMatch: currentMatchForRow,
          saleIsTwoSportAthlete: TWO_SPORT_ATHLETE_KEYS.has(playerIdentityKey(doc.playerName)),
        });
        plan = planRowChecklistEvidence(doc, checklistVerdict);
        // review MEDIUM (2026-09-19): stash for the REPORT-artifact pilot
        // list below -- a restore whose currentMatch was "no-row" restored
        // on ABSENCE, not a disagreeing checklist row. planRowChecklistEvidence
        // only ever returns "patch" or "relocate" for a restore verdict
        // (never the literal string "restore") -- both write shapes are
        // covered here. Set only on the plan object this row produced, never
        // leaked across rows.
        if (plan.action === "patch" || plan.action === "relocate") {
          plan.__currentMatchWasNoRow = currentMatchForRow === "no-row";
        }
      }
    } else {
      plan = planRow(doc);
    }

    if (plan.action === "keep") {
      s.keep++;
      if (keepExamples.length < 20) keepExamples.push(`  KEEP ${doc.id}@${doc.cardId} (${doc.sport}) -- ${plan.detail}`);
      // MODE=checklist-evidence ONLY (module header, "IDEMPOTENCY / RE-RUN
      // SAFETY"): stamp so a later checklist-evidence run's own predicate
      // (candidateSpec(true)) skips this row instead of re-reading the same
      // two catalog rows for a verdict that cannot have changed. The
      // default mode stamps nothing on keep, unchanged.
      if (IS_CHECKLIST_EVIDENCE && APPLY) {
        await retry(() => pool.item(doc.id, doc.cardId).patch([
          { op: "set", path: "/setSportReviewedAt", value: new Date().toISOString() },
          { op: "set", path: "/setSportReviewedReason", value: "R76-checklist-evidence" },
        ]));
      }
      return;
    }
    if (plan.action === "leave") {
      bumpReason(s.leave, plan.reason);
      pushExample(leaveExamples, plan.reason, `  ${doc.id}@${doc.cardId}: ${plan.detail}`);
      return;
    }

    // plan.action is "patch" or "relocate" from here.
    const cellKey = cell || "unknown-cell";

    try {
      const keep = {
        ...stripSystem(doc),
        sport: plan.newSport,
        hobbyiqCardId: plan.newHobbyiqCardId,
        setSportReversedAt: new Date().toISOString(),
        setSportReversedReason: IS_CHECKLIST_EVIDENCE ? "R76-checklist-evidence" : "R76",
      };
      if (plan.action === "relocate") keep.cardId = plan.newHobbyiqCardId;

      // ── THE WRITE-DOOR GUARD, before anything is written. A restore that
      // would PARK (a malformed hobbyiqCardIdBefore, most likely) is refused
      // outright -- listed, never written half-guarded.
      const verdict = guardSoldCompDoc(keep, { guardedBy: "revert-set-sport-repair" });
      if (verdict.verdict === "park") {
        bumpReason(s.refused, "guard-parked");
        pushExample(refuseExamples, "guard-parked", `  ${doc.id}@${doc.cardId} -> ${plan.newHobbyiqCardId}: ${verdict.detail}`);
        return;
      }

      if (plan.action === "patch") {
        if (APPLY) {
          await retry(() => pool.item(doc.id, doc.cardId).patch([
            { op: "set", path: "/sport", value: keep.sport },
            { op: "set", path: "/hobbyiqCardId", value: keep.hobbyiqCardId },
            { op: "set", path: "/setSportReversedAt", value: keep.setSportReversedAt },
            { op: "set", path: "/setSportReversedReason", value: keep.setSportReversedReason },
          ]));
        }
        s.restoreByPatch++;
        if (plan.alreadyAtTarget) s.alreadyAtTarget++;
        bump(bySetKeyYear, cellKey);
        if (restoreExamples.length < 24) restoreExamples.push(`  PATCH ${doc.id}@${doc.cardId} sport ${doc.sport}->${keep.sport}  hobbyiqCardId ${doc.hobbyiqCardId}->${keep.hobbyiqCardId}`);
        if (plan.__currentMatchWasNoRow && !plan.alreadyAtTarget && restoreOnNoRowExamples.length < 50) {
          restoreOnNoRowExamples.push(`  PATCH ${doc.id}@${doc.cardId} (playerName: ${doc.playerName ?? "?"}) sport ${doc.sport}->${keep.sport} -- current-sport candidate had NO catalog row at all (absence, not a disagreeing checklist)`);
        }
        return;
      }

      // plan.action === "relocate": cardId === current (wrong) hobbyiqCardId,
      // so restoring the slug restores the partition too.
      const destCardId = plan.newHobbyiqCardId;
      const resident = await residentAt(doc.id, destCardId);
      if (resident) {
        if (isSameSale(resident, { ...keep, cardId: destCardId })) {
          if (APPLY) await retry(() => pool.item(doc.id, doc.cardId).delete());
          s.collapsedOntoResident++;
          bump(bySetKeyYear, cellKey);
          if (restoreExamples.length < 24) restoreExamples.push(`  COLLAPSE ${doc.id}@${doc.cardId} -- same sale already resident at ${destCardId}; wrong-partition copy deleted`);
          if (plan.__currentMatchWasNoRow && restoreOnNoRowExamples.length < 50) {
            restoreOnNoRowExamples.push(`  COLLAPSE ${doc.id}@${doc.cardId} (playerName: ${doc.playerName ?? "?"}) -> ${destCardId} -- current-sport candidate had NO catalog row at all`);
          }
          return;
        }
        bumpReason(s.refused, "destination-collision");
        pushExample(refuseExamples, "destination-collision", `  ${doc.id}@${doc.cardId} -> ${destCardId}: a DIFFERENT sale (by content hash) already resides at the destination; NEITHER moved -- resident price=${resident.price ?? "?"} soldAt=${resident.soldAt ?? "?"} vs incoming price=${doc.price ?? "?"} soldAt=${doc.soldAt ?? "?"}`);
        return;
      }

      const res = await relocateSoldComp(pool, {
        keep, drop: [{ id: doc.id, cardId: doc.cardId }],
        retry, verifyFields: ["cardId", "hobbyiqCardId", "sport"], dryRun: !APPLY,
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
      s.restoreByRelocate++;
      bump(bySetKeyYear, cellKey);
      if (restoreExamples.length < 24) restoreExamples.push(`  RELOCATE ${doc.id}@${doc.cardId} -> ${destCardId}`);
      if (plan.__currentMatchWasNoRow && restoreOnNoRowExamples.length < 50) {
        restoreOnNoRowExamples.push(`  RELOCATE ${doc.id}@${doc.cardId} -> ${destCardId} (playerName: ${doc.playerName ?? "?"}) -- current-sport candidate had NO catalog row at all`);
      }
    } catch (e) {
      s.failed++;
      failures.push(`  FAILED ${plan.action} ${doc.id}@${doc.cardId}: ${String(e?.stack ?? e?.message ?? e)}`);
    }
  }

  // ── bounded-concurrency page walk ------------------------------------------
  // DEFENSE IN DEPTH (review HIGH, 2026-09-19), same shape as the sibling
  // lanes' own batch dispatch (e.g. repair-ch-product-label-parallel.cjs):
  // a `.catch` on EACH row's own promise, not on the Promise.all as a whole
  // -- so one row throwing (an unexpected bug, not just the catalog-read
  // failure already caught inside handleRow above) can never make
  // Promise.all reject and take the rest of the batch, the page walk, and
  // the run's own RECONCILE/relaunch-marker down with it. handleRow already
  // catches every failure it can name (catalog reads, guard/write
  // failures) and increments s.failed itself; this is the backstop for
  // anything it does not, and is expected to be a no-op in the ordinary
  // case.
  await forEachPage(pool, candidateSpec(IS_CHECKLIST_EVIDENCE), async (page) => {
    let i = 0;
    while (i < page.length) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; return false; }
      const batch = page.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((doc) => handleRow(doc).catch((e) => {
        s.failed++;
        failures.push(`  FAILED (unexpected, backstop) ${doc.id}@${doc.cardId}: ${String(e?.stack ?? e?.message ?? e)}`);
      })));
      i += CONCURRENCY;
    }
    return true;
  });

  console.log("");
  console.log(`scanned (setSportRepairedAt, not yet reversed)   ${f(s.scanned)}`);
  if (SHARD_SCOPE.SHARDED) console.log(`  other shard                    ${f(s.otherShard)}`);
  if (!SCOPE_IS_ALL_REPAIRED) console.log(`  other cell (outside scope)     ${f(s.otherCell)}`);
  console.log("");
  console.log(`  ${APPLY ? "RESTORED (patch)" : "WOULD RESTORE (patch)"}      ${f(s.restoreByPatch)}${s.alreadyAtTarget ? `   (${f(s.alreadyAtTarget)} already at target -- reversed-stamp only)` : ""}`);
  console.log(`  ${APPLY ? "RESTORED (relocate)" : "WOULD RESTORE (relocate)"}   ${f(s.restoreByRelocate)}`);
  console.log(`  COLLAPSED onto a resident (same sale, by hash)  ${f(s.collapsedOntoResident)}`);
  console.log(`  KEEP (flip was right)          ${f(s.keep)}`);
  for (const [reason, n] of Object.entries(s.leave)) console.log(`  LEAVE: ${reason.padEnd(24)} ${f(n)}`);
  for (const [reason, n] of Object.entries(s.refused)) console.log(`  REFUSED: ${reason.padEnd(22)} ${f(n)}`);
  console.log(`  failed                          ${f(s.failed)}`);

  if (bySetKeyYear.size) {
    console.log(`\n  by setKey|year (top 25):`);
    for (const [k, n] of [...bySetKeyYear.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      console.log(`    ${String(n).padStart(9)}  ${k}`);
    }
  }
  if (restoreExamples.length) { console.log(`\n  examples:`); for (const e of restoreExamples) console.log(e); }
  if (keepExamples.length) { console.log(`\n  KEEP examples (flip was right, sample):`); for (const e of keepExamples) console.log(e); }
  // review MEDIUM (2026-09-19): the pilot-eyeball list -- every restore in
  // THIS run whose current-sport candidate had NO catalog row at all
  // (restored on absence of counter-evidence, not a disagreeing checklist
  // row). Up to 50, printed regardless of REPORT/APPLY so a REPORT pilot can
  // be reviewed before any wider dispatch.
  if (restoreOnNoRowExamples.length) {
    console.log(`\n  RESTORE examples where current==no-row (up to 50, for pilot review -- ${f(restoreOnNoRowExamples.length)} shown this run):`);
    for (const e of restoreOnNoRowExamples) console.log(e);
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

  // ── LIVE-COUNT NOTE. The scanned total above is bounded by this run's own
  // page walk, never a cross-partition COUNT -- a live count would need one,
  // which this lane refuses to issue. This note exists so a reader does not
  // mistake "scanned" for "the whole live population still repaired."
  console.log("");
  console.log(`  LIVE-COUNT NOTE: 'scanned' above is what THIS run's paged walk read (bounded`);
  console.log(`  by SCOPE/SHARD/LIMIT/budget), never a cross-partition COUNT -- it is not a`);
  console.log(`  census of every setSportRepairedAt row still live in sold_comps.`);

  // ── CF-A-SALE-IS-NEVER-LOST-STYLE RECONCILIATION ---------------------------
  const totalLeave = Object.values(s.leave).reduce((a, b) => a + b, 0);
  const totalRefused = Object.values(s.refused).reduce((a, b) => a + b, 0);
  const written = s.restoreByPatch + s.restoreByRelocate + s.collapsedOntoResident;
  const skipped = s.keep + totalLeave;
  const intended = s.scanned - s.otherShard - s.otherCell;
  const accountedFor = written + skipped + totalRefused + s.failed;
  console.log("");
  console.log(`RECONCILE`);
  console.log(`  intended (in scope, this shard)   ${f(intended)}`);
  console.log(`  = written (restored+collapsed) ${f(written)} + skipped (keep+leave) ${f(skipped)} + refused ${f(totalRefused)} + failed ${f(s.failed)}`);
  if (accountedFor !== intended) {
    console.error(`!! RECONCILE: accounted ${f(accountedFor)} != intended ${f(intended)}. A row is unaccounted for. Exit 4.`);
    process.exitCode = 4;
  } else {
    console.log(`  RECONCILE BALANCES -- every in-scope row is restored, collapsed, kept, left (named), refused (named), or failed (named).`);
  }

  if (APPLY) {
    reportWrites({ job: "revert-set-sport-repair", intended, written, skipped, refused: totalRefused, failed: s.failed });
  }

  console.log("");
  console.log(`  ${APPLY ? "RESTORED" : "WOULD RESTORE"} ${f(written)}   KEEP ${f(s.keep)}   LEAVE ${f(totalLeave)}   REFUSED ${f(totalRefused)}`);
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
  candidateSpec, cellOf, planRow,
  INHERITED_SCOPES, ALL_REPAIRED, CELL_RE,
  reSportSlug, checklistEvidenceCandidateIds, checklistMatchOf, judgeChecklistEvidenceVerdict, planRowChecklistEvidence,
  MODE_CHECKLIST_EVIDENCE, KNOWN_MODES,
};

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); await finishLane(1, { budget: CLOCK }); });
}
