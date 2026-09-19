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
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true / APPLY=true to write;
 *      SCOPE required ('all-repaired' or comma setKey|year cells);
 *      SLOT/SLOTS (sha1(id) shards, opt-in via SHARD=true for slot 0);
 *      CONCURRENCY=8 (read fan-out); RUN_MINUTES=110; LIMIT=0.
 * Requires dist/ (splitIdentityWriteGuard) and scripts/lib (sport-title-
 * evidence, relocate-sold-comp, runner-budget, runner-shard-scope).
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
 *  continuation token, same as every other census-shaped lane in this repo. */
function candidateSpec() {
  return {
    query: `SELECT * FROM c
            WHERE IS_DEFINED(c.setSportRepairedAt)
              AND NOT IS_DEFINED(c.setSportReversedAt)`,
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

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { guardSoldCompDoc } = require(path.join(backend, "dist/services/portfolioiq/splitIdentityWriteGuard.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const pool = db.container("sold_comps");

  console.log(`  scope            ${SCOPE_IS_ALL_REPAIRED ? "all-repaired (every row this lane can reach)" : SCOPE_CELLS.join(", ")}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");
  console.log("  selects sold_comps rows carrying setSportRepairedAt with no");
  console.log("  setSportReversedAt yet (paged, continuation token, never a COUNT/GROUP BY),");
  console.log("  judges each by sportEvidence(title) against sportBefore vs the current");
  console.log("  sport, and restores (patch or, when cardId==hobbyiqCardId, relocate) the");
  console.log("  ones whose own title backs the pre-repair sport.");
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

  async function handleRow(doc) {
    s.scanned++;
    const cell = cellOf(doc.hobbyiqCardIdBefore);
    if (!SCOPE_IS_ALL_REPAIRED) {
      if (!cell || !SCOPE_CELLS.includes(cell)) { s.otherCell++; return; }
    }
    if (SHARD_SCOPE.SHARDED && shardOf(String(doc.id)) !== SHARD_SCOPE.SLOT) { s.otherShard++; return; }
    if (LIMIT && (s.restoreByPatch + s.restoreByRelocate) >= LIMIT) return;

    const plan = planRow(doc);

    if (plan.action === "keep") {
      s.keep++;
      if (keepExamples.length < 20) keepExamples.push(`  KEEP ${doc.id}@${doc.cardId} (${doc.sport}) -- ${plan.detail}`);
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
        setSportReversedReason: "R76",
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
    } catch (e) {
      s.failed++;
      failures.push(`  FAILED ${plan.action} ${doc.id}@${doc.cardId}: ${String(e?.stack ?? e?.message ?? e)}`);
    }
  }

  // ── bounded-concurrency page walk ------------------------------------------
  await forEachPage(pool, candidateSpec(), async (page) => {
    let i = 0;
    while (i < page.length) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; return false; }
      const batch = page.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((doc) => handleRow(doc)));
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
};

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); await finishLane(1, { budget: CLOCK }); });
}
