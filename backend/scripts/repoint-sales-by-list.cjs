#!/usr/bin/env node
/**
 * repoint-sales-by-list.cjs -- CF-THE-LIST-IS-THE-SCOPE, for sold_comps
 * re-keys named explicitly in a committed list file (Drew, 2026-09-27
 * widget ruling: "Build repoint-sales-by-list lane").
 *
 * This lane moves sold_comps rows from a listed SOURCE hobbyiqCardId to a
 * listed DESTINATION hobbyiqCardId, and does nothing else -- no retire, no
 * catalog write, no derivation of the destination from a rule. It is
 * ONE-AXIS on purpose: it moves sales. The catalog row the source address
 * left behind (now with zero sales, if it was ever real) is a SEPARATE
 * decision left to relocate-catalog-rows-by-list's own `retire` action,
 * exactly as PR #2454's own finding states it -- a two-step sequence, this
 * lane owns step 1 only.
 *
 * FIRST USE (#2454, 2026-09-27 census). USC143 (Adael Amador, 2025 Topps
 * Chrome Update Series): the sale at
 *   hiq:baseball:2025:topps-chrome-update-series:usc143:raywave-refractor:no-auto
 * moves to
 *   hiq:baseball:2025:topps-chrome-update-series:usc143:ray-wave-refractor:no-auto
 * Both rows carry the identical parallel text "RayWave Refractor" -- the id
 * drift is normalizeParallel mint-time drift, not two different cards.
 *
 * SECOND INTENDED USE (draft PR #2453, unsigned-twin pairs). 3,265
 * (setKey, prefix, year) pairs where a checklist-grade `:no-auto` row is a
 * MINTING ERROR for an auto-only insert -- the sale belongs at the `:auto`
 * id. Each pair is one list entry; the list format below is sized for
 * thousands of entries deliberately.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE GATES, PER ENTRY, AT APPLY TIME -- EACH NAMED AND COUNTED
 * ────────────────────────────────────────────────────────────────────────
 *
 *   1. fromId row AND toId row must both EXIST in card_catalog. A row
 *      without `cardId` lives under Cosmos's own "None" partition key, not
 *      at a partition keyed by its own id -- pkOf (lib/catalog-none-pk.cjs)
 *      is the ONE place that decision is made, so a None-pk row is still
 *      found rather than silently read as absent.
 *   2. toId's card_catalog row must be CHECKLIST-GRADE
 *      (catalogAuthorityOf(row.source) === "checklist") -- never DERIVED or
 *      VENDOR. "present is not checklist-grade": a destination row that
 *      merely exists but was synthesised from our own comps or a vendor's
 *      typing is not a card_catalog row that gets to adjudicate identity.
 *   3. SAME sport/year/setKey/cardNumber between the two ids, unless the
 *      entry says `allowCrossProduct: true` WITH a `crossProductRuling`
 *      string naming the ruling that licenses it. Compared off the
 *      CATALOG ROWS' own fields (never re-derived from the id strings),
 *      because a row's stored identity is the fact this gate exists to
 *      protect.
 *   4. destination id must not equal the source id (a no-op entry is a
 *      list defect, not a silent skip).
 *   5. the source must have at least ONE sale (salesAtId's dual
 *      cross-partition + partition-scoped check) -- zero sales is refused
 *      as "nothing to do" and counted, never silently skipped.
 *   5b. CF-STALE-HOBBYIQCARDID-IS-NOT-RESIDENCY (this PR). GATE 4's own
 *      drain matches `hobbyiqCardId = fromId OR cardId = fromId` --
 *      deliberately wide, so a sale re-pointed but never re-partitioned is
 *      still found. But sold_comps partitions on /cardId: a drained ref
 *      whose freshly-read document's OWN cardId is NOT fromId was never
 *      resident at fromId's partition at all -- only its hobbyiqCardId
 *      still carries the stale value. Moving such a sale would rewrite a
 *      document none of this entry's gates (checklist-grade, product-
 *      address, name agreement) were ever actually run against ITS
 *      resident card. Checked per sale, right after the read, BEFORE gate
 *      6: refused as "not-resident-at-from", counted in its own bucket,
 *      never moved or rewritten. A stray physical duplicate under a
 *      different cardId is NOT this lane's job to clean up either way --
 *      that is dedupe-sold-comp-copies-by-list.cjs's own, narrower,
 *      content-identity-gated delete.
 *   6. for EVERY sale moved, namesAgree(TITLE first, destination row's
 *      player) must pass. "A checklist row proves the ROW, the player name
 *      proves the SALE": the catalog gates above establish that the
 *      DESTINATION is a real, checklist-attested card; namesAgree
 *      establishes that THIS PARTICULAR SALE is that card's sale and not
 *      some other player's listing that happened to share a source
 *      partition. TITLE FIRST (this PR): the sale's stored `playerName`
 *      field can itself be corrupt (a mis-extraction at ingest), while the
 *      TITLE -- the actual listing text -- plainly names the destination
 *      player. The title is read first, through the same
 *      stripTrailingTokens vocabulary as before; playerName is consulted
 *      ONLY when the title is blank (carries no name tokens at all). On a
 *      real conflict the TITLE WINS -- a title naming a different player
 *      refuses the sale even when the (corrupt) playerName would have
 *      agreed. `decidedBy` ("title" or "playerName") is recorded on every
 *      per-sale plan row, pass or refuse, so the evidence states which
 *      field actually decided. A sale whose title/player disagrees is
 *      refused alone -- it does not fail the whole entry, and it does not
 *      retry under a looser rule.
 *
 * Any refusal is named, counted, and never silently merged into another
 * bucket -- CF-NEVER-DISMISS-SMALL-NUMBERS-AS-NOISE.
 *
 * ────────────────────────────────────────────────────────────────────────
 * SCAN / WRITE SHAPE
 * ────────────────────────────────────────────────────────────────────────
 *
 * Never a cross-partition COUNT or GROUP BY. sold_comps ids
 * (`${source}::${externalId}`) are unique only WITHIN a partition, so a
 * move is addressed as (partition, id) throughout: the source scan pages
 * with FeedOptions {maxItemCount:500, maxDegreeOfParallelism:-1},
 * `while (iterator.hasMoreResults())`, and NEVER breaks on an empty page
 * (an empty page mid-drain is not the same as the iterator being done --
 * see lib/sales-at-id.cjs's own header for the reproduced anomaly this
 * guards against). The move itself goes through relocateSoldComp
 * (lib/relocate-sold-comp.cjs) -- the ONE sanctioned mover, create-at-new +
 * verified read-back + delete-old -- and its own documented behaviour
 * governs the FAILED-vs-clean distinction this lane relies on: a THROWN
 * read-back (network error, not "not found") is reported by
 * relocateSoldComp as `duplicatesLeft: []` with `ok: false` and
 * `stage: "verify"` -- this lane treats that as FAILED, never as a clean
 * move, exactly per the caller's own briefing on this file.
 *
 * ────────────────────────────────────────────────────────────────────────
 * REPORT vs APPLY
 * ────────────────────────────────────────────────────────────────────────
 *
 * REPORT (apply=false, the default) computes EXACTLY what APPLY would --
 * every gate, every namesAgree check, every sale enumerated -- and writes
 * nothing (relocateSoldComp is called with `dryRun: true`). A report that
 * skips the derivation is a green light for a write that will not happen
 * (the 2026-09-07 incident this doctrine is named for); this lane never
 * repeats it.
 *
 * ────────────────────────────────────────────────────────────────────────
 * BUDGET + RELAUNCH
 * ────────────────────────────────────────────────────────────────────────
 *
 * Sized like relocate-catalog-rows-by-list.cjs and relocate-pool-rows-by-
 * list.cjs, its direct siblings: a unit here is ONE SALE MOVED (not one
 * list entry -- an entry can carry many sales), and a move costs a create
 * + verified read-back + delete, so the 30s reserve mirrors the catalog
 * lane's own measured-and-multiplied reserve. `budget()`/`finishLane()`
 * (lib/runner-budget.cjs) own the clock, the keepalive and the exit
 * discipline; this lane never re-implements them. The loop is idempotent:
 * a re-run of a finished list finds nothing left at the source id (or a
 * destination already carrying the sale) and skips cleanly, so a relaunch
 * after a budget stop costs one cheap read per settled entry and writes
 * only what is left.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY/APPLY; SCOPE=<list file>
 *      (path relative to backend/; REQUIRED -- this lane has no default
 *      list, matching relocate-catalog-rows-by-list's own convention: a
 *      list-scoped lane with no default is safer than one that silently
 *      substitutes a population nobody named).
 * Requires dist/ (hobbyIqCardId is not used directly, but
 * catalogAuthority.service.js and writeReconciliation.js are).
 */
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const backend = path.resolve(__dirname, "..");
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { salesAtId, drainSalesIdsAtId } = require(path.join(__dirname, "lib", "sales-at-id.cjs"));
const { namesAgree } = require(path.join(__dirname, "lib", "name-agreement.cjs"));
const { withBackoff } = require(path.join(__dirname, "lib", "cosmos-backoff.cjs"));
const { pkOf } = require(path.join(__dirname, "lib", "catalog-none-pk.cjs"));
// checklistParallelNamesFor is a scripts/lib module (reads the checklist
// corpus JSON directly, no dist/ and no Cosmos), same load-without-a-build
// contract as name-agreement.cjs itself -- required at top level, not lazily
// inside main(), for the same reason.
const { checklistParallelNamesFor } = require(path.join(__dirname, "lib", "rematch-finish-vocab.cjs"));
// GATE 6's own "is the title even name-shaped" test (this PR) -- see that
// module's own header for why a bare "title is non-blank" check false-
// refuses real CardHedge/eBay listing titles that carry no player name at
// all ("2025 Topps Chrome Update Baseball #AC-NM Base").
const { titleHasNameTokens } = require(path.join(__dirname, "lib", "title-has-name-tokens.cjs"));
// The dist/ and Cosmos requires live inside main(), as every sibling list
// lane does it: loading this module must not need a built tree, so a test
// can require it and drive the list/gate logic without a compile step.

// ── GATE 6's own vocabulary: the destination product's checklist parallel
//    names, turned into a namesAgree() stripTrailingTokens list ────────────
//
// CF-A-PARALLEL-WORD-IS-NOT-A-PLAYER-NAME (USC143, run 36346769892). Gate 6
// refused `sale "Adael Amador Teal" vs destination "Adael Amador RC"` --
// same player, two name-SHAPE artefacts: the destination's checklist
// playerName carries a trailing "RC" (closed by name-agreement.cjs's own
// rule (b), extended this PR), and the SALE's own player string carries the
// parallel colour word "Teal" that its extraction left in. `namesAgree`
// itself stays product-blind on purpose (see its header, "no hardcoded
// colours") -- so THIS caller builds the strip list from the DESTINATION
// product's own checklist vocabulary and passes it through
// `opts.stripTrailingTokens`.
//
// Built once per (year, setKey) and cached -- an entry-level list can repeat
// the same destination across many sales, and the corpus read + colour scan
// is wasted work to repeat per sale.
const _stripVocabCache = new Map();

/** "<Colour> Refractor" / "<Colour> Prizm" -- the colour word alone is also
 *  strippable, so "Teal" folds even though the sale never wrote "Refractor".
 *  Matched against the CHECKLIST's own listed names, never a fixed colour
 *  list of our own -- a word only earns strip eligibility by being the FIRST
 *  word of one of THIS product's own "<Colour> <Family>" rungs. */
const COLOUR_PREFIX_FAMILY_RE = /^([a-z][a-z'-]*)\s+(refractor|prizm)s?$/i;

/** Bare family words, for this product family, that a sale's extraction can
 *  leave dangling even with no colour in front of them ("Adael Amador
 *  Refractor"). Not a colour list -- these are the finish/format WORDS
 *  themselves, always strippable once the destination is checklist-grade
 *  (gate 2 already proved that), the same three the brief names. */
const BARE_FAMILY_WORDS = ["Refractor", "Prizm", "Parallel"];

/**
 * The `stripTrailingTokens` list for GATE 6's `namesAgree` call against this
 * destination row, plus a `{ size, setKey }` detail for the one-per-entry
 * banner line. Returns `{ tokens: [], size: 0, setKey }` when the product has
 * no checklist parallel vocabulary (corpus miss, or a setKey/year the corpus
 * does not cover) -- namesAgree with an empty list behaves exactly as it did
 * before this PR, so a corpus miss never widens or narrows GATE 6 on its own.
 */
function stripVocabularyForDestination(toRow) {
  const year = toRow?.year ?? toRow?.cardYear ?? null;
  const setKey = String(toRow?.setKey ?? "").trim();
  const cacheKey = `${year}|${setKey.toLowerCase()}`;
  if (_stripVocabCache.has(cacheKey)) return _stripVocabCache.get(cacheKey);

  const names = setKey ? checklistParallelNamesFor(year, setKey) : null;
  const tokens = new Set();
  if (names) {
    for (const name of names) {
      const trimmed = String(name ?? "").trim();
      if (!trimmed) continue;
      // The whole listed name ("Teal Refractor") strips as one phrase...
      tokens.add(trimmed);
      // ...and, when it is a "<Colour> Refractor"/"<Colour> Prizm" rung, the
      // colour word ALONE also strips -- this is what lets "Teal" fold when
      // the sale's own extraction dropped "Refractor" but kept the colour.
      const m = trimmed.match(COLOUR_PREFIX_FAMILY_RE);
      if (m) tokens.add(m[1]);
    }
  }
  for (const w of BARE_FAMILY_WORDS) tokens.add(w);

  const result = { tokens: [...tokens], size: names ? names.size : 0, setKey };
  _stripVocabCache.set(cacheKey, result);
  return result;
}

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const f = (n) => Number(n ?? 0).toLocaleString("en-US");

// CF-A-WHOLE-SCOPE-WRITE-REFUSES-WITHOUT-ITS-SCOPE (D-06, R3), matching
// relocate-catalog-rows-by-list.cjs exactly: `scope` is shared with every
// other lane on this runner and carries THEIR vocabulary. There is no
// default list -- an absent or non-.json scope is FATAL, never read as
// "everything" or as some other lane's population.
const RAW_SCOPE = String(process.env.SCOPE || "").trim();
const SCOPE_ERROR = (() => {
  if (!RAW_SCOPE) {
    return "FATAL: SCOPE is empty. This lane moves sold_comps rows and has no default list — "
      + "name the committed .json list to run (e.g. SCOPE=data/sales-repoints/<file>.json).";
  }
  if (!RAW_SCOPE.endsWith(".json")) {
    return `FATAL: SCOPE="${RAW_SCOPE}" does not name a list file. This lane's scope is a `
      + "committed .json list of (fromId, toId) pairs — never a predicate, a product key, or "
      + "another lane's vocabulary.";
  }
  return null;
})();
const SCOPE = RAW_SCOPE;

/**
 * An entry names a fromId/toId pair, and nothing about it is inferred.
 * Returns { ok, ...fields } where a falsy `ok` carries the refusal text.
 */
function classifyEntry(e) {
  const fromId = String(e?.fromId ?? "").trim();
  const toId = String(e?.toId ?? "").trim();
  const player = String(e?.player ?? "").trim();
  const cardNumber = String(e?.cardNumber ?? "").trim();
  const reason = String(e?.reason ?? "").trim();
  if (!fromId) return { ok: false, why: "entry has no fromId" };
  if (!fromId.startsWith("hiq:")) return { ok: false, why: `fromId is not a hiq slug: ${fromId.slice(0, 60)}` };
  if (!toId) return { ok: false, why: `entry has no toId: ${fromId.slice(0, 60)}` };
  if (!toId.startsWith("hiq:")) return { ok: false, why: `toId is not a hiq slug: ${toId.slice(0, 60)}` };
  if (toId === fromId) return { ok: false, why: `toId equals fromId: ${fromId.slice(0, 60)}` };
  if (!reason) return { ok: false, why: `entry has no reason: ${fromId.slice(0, 60)}` };
  const allowCrossProduct = e?.allowCrossProduct === true;
  const crossProductRuling = String(e?.crossProductRuling ?? "").trim();
  if (allowCrossProduct && !crossProductRuling) {
    return { ok: false, why: `allowCrossProduct:true needs a crossProductRuling string: ${fromId.slice(0, 60)}` };
  }
  return {
    ok: true, fromId, toId, player, cardNumber, reason,
    allowCrossProduct, crossProductRuling,
    expectedSales: Number.isFinite(Number(e?.expectedSales)) ? Number(e.expectedSales) : null,
  };
}

/**
 * Do these two catalog rows name the SAME product address -- sport, year,
 * setKey and cardNumber, all four, off the ROWS' OWN stored fields, never
 * re-derived from the id strings? A mismatch is refused unless the entry
 * carries `allowCrossProduct: true` with a ruling.
 *
 * Returns `{ ok: true }` or `{ ok: false, why, differing }`.
 */
function sameProductAddress(fromRow, toRow) {
  const FIELDS = ["sport", "year", "setKey", "cardNumber"];
  const norm = (v) => (v === null || v === undefined ? "" : String(v).trim().toLowerCase());
  const differing = FIELDS.filter((k) => norm(fromRow?.[k]) !== norm(toRow?.[k]));
  if (differing.length === 0) return { ok: true, differing: [] };
  return {
    ok: false,
    why: `fromId and toId catalog rows disagree on ${differing.join(", ")}`,
    differing,
  };
}

async function main() {
  if (SCOPE_ERROR) { console.error(SCOPE_ERROR); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));

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
  console.log(`for lane                ${doc.forLane ?? "(unlabelled)"}`);
  console.log(`entries in scope        ${f(entries.length)}`);
  if (doc.finding) console.log(`  finding: ${String(doc.finding).slice(0, 200)}`);

  // The client is NAMED rather than chained away, so finishLane() can
  // dispose it -- an undisposed SDK keeps keep-alive sockets open, which is
  // exactly what held four APPLY shards to the ceiling in #1809.
  const client = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  });
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  const retry = (fn) => withBackoff(fn, { label: "repoint-sales-by-list" });

  const catalogRowAt = async (id) => {
    // A row without cardId lives at Cosmos's own None partition key, so the
    // point read must use pkOf's decision, never a bare (id, id) guess.
    try { return (await retry(() => cat.item(id, id).read())).resource ?? null; }
    catch (err) {
      if (err?.code !== 404 && err?.statusCode !== 404) throw err;
    }
    // The (id, id) guess 404'd. Try the None-pk address before calling the
    // row absent -- pkOf(row) needs the row itself only to decide WHICH
    // partition a WRITE would use; for a READ where we do not yet have the
    // row, a row with no cardId is exactly the row a bare (id, id) read
    // cannot find, so retry once at the None sentinel.
    try {
      const nonePk = pkOf({});
      return (await retry(() => cat.item(id, nonePk).read())).resource ?? null;
    } catch (err) {
      if (err?.code === 404 || err?.statusCode === 404) return null;
      throw err;
    }
  };

  // ── THE CLOCK. A unit is ONE SALE MOVED; the reserve is sized like the
  // catalog list lane's own (16x its slowest measured entry), since a move
  // here is the same shape (create + verified read-back + delete).
  const CLOCK = budget({ minutes: 110, reserveMs: 30 * 1000, verifyMs: 60 * 1000 });
  console.log(`  ${CLOCK.describe()}`);
  console.log("");

  let movedSales = 0;
  let refusedNoFromRow = 0, refusedNoToRow = 0, refusedNotChecklistGrade = 0;
  let refusedProductMismatch = 0, refusedSameId = 0, refusedZeroSales = 0;
  let refusedExpectedSalesMismatch = 0;
  let refusedNameDisagreement = 0;
  // CF-STALE-HOBBYIQCARDID-IS-NOT-RESIDENCY (this PR). drainSalesIdsAtId's
  // own dual predicate is `hobbyiqCardId = fromId OR cardId = fromId` --
  // deliberately wide, because a sale re-pointed (hobbyiqCardId rewritten)
  // but never re-partitioned still needs to be found. But sold_comps
  // partitions on /cardId: a ref whose OWN cardId is some OTHER address (the
  // sale's real, current partition) and whose hobbyiqCardId merely still
  // carries the STALE value `fromId` was never resident at fromId's
  // partition at all -- it only LOOKS like a fromId candidate because a
  // prior lane already moved (or repointed) it and left hobbyiqCardId
  // behind. Moving such a sale to toId would silently rewrite a document
  // this entry's own gates (checklist-grade, product-address, name
  // agreement) were never actually run against ITS resident card -- the
  // sale's true address was already something else. Checked once per sale,
  // right after the read succeeds and BEFORE the name gate (GATE 6): a sale
  // is refused here, counted in its own bucket, and NEVER moved or rewritten
  // -- this is a residency fact, not a name-agreement judgment call.
  let refusedNotResidentAtFrom = 0;
  // A sale whose destination guardSoldCompDoc refuses as a malformed key --
  // consulted by relocateSoldComp BEFORE its own dryRun short-circuit, so
  // this fires identically in REPORT and APPLY (see the per-sale move block).
  let refusedGuard = 0;
  let failedSales = 0;
  // A sale ref the drain (GATE 4) counted, but whose own point read then
  // found nothing -- a 404 or a null resource, gone since drainSalesIdsAtId
  // ran. A BENIGN concurrent mutation (another lane, or this one's own
  // idempotent re-run, moved or deleted it in between), never a failure --
  // but it still consumed one unit of `intendedSalesTotal`, so it must have
  // its own bucket or the strict sale-side reconcile below reports a false
  // RECONCILE MISMATCH on every ordinary race against a live container.
  let goneSinceRead = 0;
  // An entry-level Cosmos read threw before any sale was ever enumerated
  // (the catalog reads in GATE 1, or the sales lookup in GATE 4) -- its own
  // ENTRY-side bucket, never folded into `failedSales` (a per-SALE outcome
  // whose denominator is `intendedSalesTotal`, a total this entry never
  // contributed to).
  let entryLevelFailed = 0;
  let entriesFailedToClassify = 0;
  // Sales an entry's OWN per-sale loop could not reach because the budget
  // ran out mid-entry -- see the loop's own comment. Folded into the
  // sale-level side of the reconcile, never into `notReached` (which is
  // whole ENTRIES the outer loop never started at all).
  let notReachedSales = 0;
  // Running total of sales EVERY entry that passed all five entry-level
  // gates actually enumerated (salesRows.length, added once per entry, right
  // before that entry's per-sale loop starts) -- the sale-side denominator
  // the reconcile checks `saleLevelOutcomes` against. An entry refused at
  // any entry-level gate (no-from-row, no-to-row, not-checklist-grade,
  // product-mismatch, same-id, zero-sales, expected-sales-mismatch) never
  // adds anything here, because it never enumerated a single sale -- it is
  // its own unit on the ENTRY side of the reconcile instead (see
  // `entryLevelRefusals` below).
  let intendedSalesTotal = 0;

  let stoppedAt = null;
  let considered = 0;

  const PLAN_OUT = String(process.env.PLAN_OUT || "").trim();
  let planFd = null;
  if (PLAN_OUT) {
    try {
      fs.mkdirSync(PLAN_OUT, { recursive: true });
      const planPath = path.join(PLAN_OUT, "repoint-sales-by-list-plan.ndjson");
      planFd = fs.openSync(planPath, "w");
      console.log(`  plan file         ${planPath}`);
    } catch (e) {
      console.log(`\n::warning::could not open PLAN_OUT (${PLAN_OUT}): ${e?.message}`);
      planFd = null;
    }
  }
  function emitPlanRow(record) {
    if (!planFd) return;
    try { fs.appendFileSync(planFd, JSON.stringify(record) + "\n"); }
    catch (e) { console.log(`\n::warning::PLAN_OUT write failed: ${e?.message}`); }
  }

  for (const e of entries) {
    if (CLOCK.outOfClock()) { stoppedAt = considered; break; }
    considered++;
    const c = classifyEntry(e);
    if (!c.ok) {
      entriesFailedToClassify++;
      console.error(`  MALFORMED — ${c.why}`);
      continue;
    }
    const { fromId, toId, player, cardNumber, reason, allowCrossProduct, crossProductRuling, expectedSales } = c;

    console.log(`\n  ENTRY  ${fromId.slice(0, 66)}`);
    console.log(`      -> ${toId.slice(0, 66)}`);
    console.log(`      player: ${player || "(unnamed)"}  cardNumber: ${cardNumber || "(unnamed)"}`);
    console.log(`      reason: ${reason.slice(0, 120)}`);

    // ── GATE: toId equals fromId ────────────────────────────────────────
    // classifyEntry already refuses this at parse time; kept here as a
    // belt-and-suspenders count in case a future caller drives the gates
    // directly with a hand-built entry object.
    if (toId === fromId) {
      refusedSameId++;
      console.error("      REFUSED (same-id): destination equals source");
      continue;
    }

    // ── GATE 1: both catalog rows must exist ────────────────────────────
    let fromRow, toRow;
    try {
      [fromRow, toRow] = await Promise.all([catalogRowAt(fromId), catalogRowAt(toId)]);
    } catch (err) {
      // An ENTRY-level failure -- no sale was ever enumerated, so this is
      // tallied on the entry side of the reconcile (entryLevelFailed), never
      // folded into `failedSales` (which counts per-SALE outcomes only, and
      // whose denominator is `intendedSalesTotal` -- a total this entry
      // never contributed to).
      entryLevelFailed++;
      console.error(`      FAILED: catalog read threw — ${String(err?.message ?? err).slice(0, 100)}`);
      continue;
    }
    if (!fromRow) {
      refusedNoFromRow++;
      console.error("      REFUSED (no-from-row): fromId has no card_catalog row");
      continue;
    }
    if (!toRow) {
      refusedNoToRow++;
      console.error("      REFUSED (no-to-row): toId has no card_catalog row");
      continue;
    }

    // ── GATE 2: destination must be checklist-grade ─────────────────────
    const toAuthority = catalogAuthorityOf(toRow.source);
    if (toAuthority !== "checklist") {
      refusedNotChecklistGrade++;
      console.error(`      REFUSED (not-checklist-grade): toId's row authority is "${toAuthority}", not checklist — present is not checklist-grade`);
      continue;
    }

    // ── GATE 3: same product address unless the entry rules otherwise ──
    const productCheck = sameProductAddress(fromRow, toRow);
    if (!productCheck.ok && !allowCrossProduct) {
      refusedProductMismatch++;
      console.error(`      REFUSED (product-mismatch): ${productCheck.why}`);
      continue;
    }
    if (!productCheck.ok && allowCrossProduct) {
      console.log(`      cross-product allowed: ${crossProductRuling.slice(0, 120)}`);
    }

    // ── GATE 4: the source must have at least one sale ──────────────────
    let salesRows;
    try {
      const drained = await drainSalesIdsAtId(pool, fromId, { retry });
      salesRows = drained.rows;
    } catch (err) {
      // Same reasoning as GATE 1's own catch: no sale was enumerated yet, so
      // this is an entry-level failure, not a per-sale one.
      entryLevelFailed++;
      console.error(`      FAILED: sales lookup threw — ${String(err?.message ?? err).slice(0, 100)}`);
      continue;
    }
    if (salesRows.length === 0) {
      refusedZeroSales++;
      console.error("      REFUSED (zero-sales): fromId has no sold_comps rows — nothing to do");
      continue;
    }

    console.log(`      sales at fromId: ${f(salesRows.length)}`);

    // ── GATE 5: expectedSales, when the list author gave one, must match ──
    // the DUAL count exactly. A list is a reviewed census (#2454's own list
    // states "canonicalSales: 1, staleSales: 1" per entry); a live count
    // that disagrees means the census is stale — more (or fewer) sales have
    // landed at fromId since the list was written than the reviewer saw —
    // and moving blind against a changed population is exactly the kind of
    // silent widening this lane exists to refuse. `expectedSales` is
    // OPTIONAL: an entry that omits it (as thousands of #2453-shaped
    // entries reasonably might) skips this gate entirely.
    if (expectedSales !== null && salesRows.length !== expectedSales) {
      refusedExpectedSalesMismatch++;
      console.error(`      REFUSED (expected-sales-mismatch): list says expectedSales=${f(expectedSales)}, live dual count is ${f(salesRows.length)}`);
      continue;
    }

    // This entry has cleared every entry-level gate and is about to
    // enumerate its sales -- exactly the point `intendedSalesTotal` counts
    // from, so a gate-5 refusal just above never adds its (uninspected)
    // sales to the sale-side denominator.
    intendedSalesTotal += salesRows.length;

    // GATE 6's own vocabulary for THIS entry's destination, built/cached once
    // per (year, setKey) and logged ONCE per entry (not once per sale) --
    // the banner names the vocabulary size and setKey so a REPORT/APPLY log
    // states exactly what namesAgree was allowed to strip.
    const strip = stripVocabularyForDestination(toRow);
    console.log(`      namesAgree vocabulary: ${f(strip.size)} checklist parallel name(s) for setKey="${strip.setKey}" (+ bare Refractor/Prizm/Parallel)`);

    // ── PER-SALE: read the full document, gate on namesAgree, then move ──
    //
    // A budget stop HERE, mid-entry, must not double-count. This entry was
    // already considered (the outer loop's `considered++` already ran, its
    // gates already passed, and zero or more of its sales already produced
    // a real moved/refused/failed outcome above) -- it is NOT "not reached",
    // and `stoppedAt` (which governs the OUTER loop's own reconcile, i.e.
    // whole entries never started) is never touched here. The sales this
    // entry could not get to are counted in `notReachedSales`, a SEPARATE
    // per-sale tally folded into the sale-level side of the reconcile, so an
    // entry straddling the boundary contributes exactly once to each of its
    // own sales -- moved/refused/failed for the ones processed, not-reached
    // for the remainder -- rather than the whole entry being re-counted as
    // not-reached on top of the outcomes it already produced.
    for (const ref of salesRows) {
      if (CLOCK.outOfClock()) {
        notReachedSales += salesRows.length - salesRows.indexOf(ref);
        break;
      }
      let sale = null;
      try {
        sale = (await retry(() => pool.item(ref.id, ref.cardId ?? fromId).read())).resource ?? null;
      } catch (err) {
        if (err?.code === 404 || err?.statusCode === 404) {
          // Gone since the drain -- a benign concurrent mutation (another
          // lane moved or deleted it between drainSalesIdsAtId's read and
          // this one), never a failure. Counted here, not silently dropped:
          // `intendedSalesTotal` already added this ref to the sale-side
          // denominator the instant the entry passed GATE 5, so a read that
          // finds nothing MUST still land in exactly one bucket or the
          // strict sale-side reconcile below reports a false mismatch on
          // every ordinary concurrent-write race.
          goneSinceRead++;
          console.log(`      gone since read: ${ref.id} — no longer at this address, not a failure`);
          continue;
        }
        failedSales++;
        console.error(`      FAILED: sale read threw for ${ref.id} — ${String(err?.message ?? err).slice(0, 90)}`);
        continue;
      }
      if (!sale) {
        // Same reasoning as the 404 branch: the point read resolved with no
        // resource (some Cosmos SDK paths return `{ resource: undefined }`
        // rather than throwing 404) -- gone since the drain, not a failure.
        goneSinceRead++;
        console.log(`      gone since read: ${ref.id} — no longer at this address, not a failure`);
        continue;
      }

      // CF-STALE-HOBBYIQCARDID-IS-NOT-RESIDENCY. The ref that got this sale
      // into `salesRows` may have matched on hobbyiqCardId alone (a prior
      // repoint left it stale) while the sale's OWN cardId -- its real,
      // current partition -- is a DIFFERENT address entirely. That sale was
      // never resident at fromId; refuse it as its own outcome and never
      // move or rewrite it. Checked against the freshly-read document's own
      // cardId (not `ref.cardId`, which is only the drain's own snapshot) so
      // this reads the live value, not a stale one the drain itself cached.
      if (String(sale.cardId ?? "") !== fromId) {
        refusedNotResidentAtFrom++;
        console.error(`      REFUSED (not-resident-at-from) ${sale.id}: live cardId "${String(sale.cardId ?? "").slice(0, 80)}" != fromId "${fromId.slice(0, 80)}" -- hobbyiqCardId is stale, not residency`);
        emitPlanRow({ action: "refused", reason: "not-resident-at-from", fromId, toId, saleId: sale.id, liveCardId: sale.cardId ?? null });
        continue;
      }

      // ── GATE 6, TITLE-FIRST (this PR). "A checklist row proves the ROW,
      // the player name proves the SALE" -- but a sale's STORED playerName
      // field can itself be corrupt (mis-extracted at ingest) while its
      // TITLE, the actual listing text, plainly names the destination
      // player. The title is read FIRST, through the identical
      // stripTrailingTokens vocabulary GATE 6 already builds for the
      // destination; playerName is consulted ONLY when the title carries NO
      // NAME TOKENS AT ALL -- never merely when the title simply disagrees.
      // "No name tokens" is NOT "the title is blank": lib/title-has-name-
      // tokens.cjs strips the destination's own setKey/sport/cardNumber
      // vocabulary (plus year/grade/card-number-token shapes) before
      // counting, because a large share of real sold_comps titles are
      // CardHedge/eBay listing text with no player name in them at all
      // ("2025 Topps Chrome Update Baseball #AC-NM Base") -- a bare
      // non-blank check would have refused those on their own CORRECT
      // playerName, the opposite of what title-first is for. On a real
      // conflict (title carries a genuine name, and it is NOT the
      // destination's) the TITLE WINS and the sale is refused, even though
      // a playerName-only check would have passed it -- a corrupt stored
      // field must never outrank the evidence a human listed the card
      // under. `decidedBy` records which field actually produced the
      // verdict, in both the pass and the refuse path.
      const titleSource = String(sale.title ?? "").trim();
      const playerNameSource = String(sale.playerName ?? "").trim();
      const destName = String(toRow.playerName ?? "").trim();
      const titleContext = { setKey: toRow.setKey, sport: toRow.sport, cardNumber: cardNumber || toRow.cardNumber };
      const titleIsNameShaped = titleHasNameTokens(titleSource, strip.tokens, titleContext);
      const decidedBy = titleIsNameShaped ? "title" : "playerName";
      const saleName = titleIsNameShaped ? titleSource : playerNameSource;
      if (!namesAgree(saleName, destName, { stripTrailingTokens: strip.tokens })) {
        refusedNameDisagreement++;
        console.error(`      REFUSED (name-disagreement) ${sale.id}: sale "${saleName.slice(0, 60)}" (decidedBy=${decidedBy}) vs destination "${destName.slice(0, 60)}"`);
        emitPlanRow({ action: "refused", reason: "name-disagreement", fromId, toId, saleId: sale.id, saleName, destName, decidedBy });
        continue;
      }

      // ONE DERIVATION FOR BOTH MODES (matching relocate-catalog-rows-by-
      // list.cjs's own moveCatalogRow call and repoint-sales-isauto-flip.cjs's
      // own performMove): REPORT must not count a success it never computed.
      // relocateSoldComp is called EXACTLY once, with `dryRun: !APPLY`, so
      // splitIdentityWriteGuard/guardSoldCompDoc — which relocateSoldComp
      // consults BEFORE its own dryRun short-circuit — runs in REPORT too.
      // A destination that fails that guard (a malformed key) is therefore
      // REFUSED in both modes, with the same count, rather than REPORT
      // silently skipping a check APPLY would have hit.
      // CF-CH-CARD-SET-ALREADY-HAS-THE-YEAR, the move-side half: relocateSoldComp
      // itself heals a pre-2026-08-24 (commit 0000f60) doubled-year title
      // before it upserts `keep` (lib/relocate-sold-comp.cjs, review follow-up
      // to PR #2474: centralized there instead of per-caller so every mover
      // inherits it, not just this one).
      const keep = stripSystem(sale);
      keep.cardId = toId;
      keep.hobbyiqCardId = toId;
      keep.contentHash = contentHashOf(keep);
      try {
        // CF-CROSS-PARTITION-VERIFY-IS-PER-ENTRY-NOT-PER-SALE (run
        // 36353646453, reviewed while fixing it). relocateSoldComp's own
        // OPTIONAL verifyNoDuplicatesAcrossPartitions checks the pool
        // immediately after ITS OWN delete -- and this loop can process
        // several physical documents that share one `id` (the exact
        // incident shape) one at a time, in sequence. Passing the option
        // HERE, per sale, made the first sale's own move see the SECOND
        // sale's not-yet-processed twin and report it as a false
        // `duplicatesLeft`, even though the very next loop iteration was
        // about to resolve it. This lane's own dual-count reconcile
        // (GATE 5's expectedSales, and the drain fix in lib/sales-at-id.cjs
        // this same PR ships) is the correct place for that check: it
        // already reads the TRUE physical count via drainSalesIdsAtId
        // BEFORE any sale in this entry moves, so every physical document
        // sharing this id is enumerated and processed in this same loop --
        // never silently left for a per-call verify to (wrongly) flag mid-
        // entry. relocateSoldComp's own opt-in stays available for a caller
        // whose loop shape is one physical document per relocate call.
        const res = await relocateSoldComp(pool, {
          keep, drop: [{ id: sale.id, cardId: sale.cardId ?? fromId }], retry,
          verifyFields: ["cardId", "hobbyiqCardId", "price", "soldAt", "contentHash"],
          dryRun: !APPLY,
        });
        if (res.stage === "guard") {
          refusedGuard++;
          console.error(`      REFUSED (guard): ${String(res.error ?? "").slice(0, 100)}`);
          emitPlanRow({ action: "refused", reason: "guard", fromId, toId, saleId: sale.id, error: String(res.error ?? "") });
        } else if (res.ok) {
          movedSales++;
          emitPlanRow({ action: APPLY ? "moved" : "would-move", reason: "repoint-sales-by-list", fromId, toId, saleId: sale.id, before: sale.cardId, after: toId, decidedBy });
        } else {
          failedSales++;
          console.error(`      FAILED at ${res.stage}: ${String(res.error ?? "").slice(0, 100)}`);
          if (res.duplicatesLeft?.length) {
            console.error(`      DUPLICATE LEFT IN POOL: ${res.duplicatesLeft.length} — the create+verify landed, the delete did not; the sale is now resident at BOTH addresses`);
          }
          emitPlanRow({ action: "failed", reason: res.stage ?? "unknown", fromId, toId, saleId: sale.id, error: String(res.error ?? "") });
        }
      } catch (err) {
        // A THROWN read-back (a network error, never "not found") is FAILED,
        // never clean -- relocateSoldComp's own catch path can otherwise
        // report duplicatesLeft:[] on a throw, which reads as "nothing left
        // behind" when in fact the verify never ran to completion. Treated
        // here exactly as briefed: a throw is FAILED, not a clean move.
        failedSales++;
        console.error(`      FAILED: relocateSoldComp threw — ${String(err?.message ?? err).slice(0, 100)}`);
        emitPlanRow({ action: "failed", reason: "relocate-threw", fromId, toId, saleId: sale.id, error: String(err?.message ?? err) });
      }
    }
  }

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  entries in scope             ${f(entries.length)}`);
  console.log(`  entries considered           ${f(considered)}${stoppedAt === null ? "   <- the whole list" : ""}`);
  console.log(`  entries malformed            ${f(entriesFailedToClassify)}`);
  console.log(`  ${APPLY ? "MOVED" : "WOULD MOVE"} (sales)              ${f(movedSales)}`);
  console.log(`  REFUSED: no-from-row          ${f(refusedNoFromRow)}`);
  console.log(`  REFUSED: no-to-row            ${f(refusedNoToRow)}`);
  console.log(`  REFUSED: not-checklist-grade  ${f(refusedNotChecklistGrade)}`);
  console.log(`  REFUSED: product-mismatch     ${f(refusedProductMismatch)}`);
  console.log(`  REFUSED: same-id              ${f(refusedSameId)}`);
  console.log(`  REFUSED: zero-sales           ${f(refusedZeroSales)}`);
  console.log(`  REFUSED: expected-sales-mismatch ${f(refusedExpectedSalesMismatch)}`);
  console.log(`  REFUSED: name-disagreement    ${f(refusedNameDisagreement)}`);
  console.log(`  REFUSED: not-resident-at-from ${f(refusedNotResidentAtFrom)}`);
  console.log(`  REFUSED: guard (malformed key) ${f(refusedGuard)}`);
  console.log(`  failed (per-sale)             ${f(failedSales)}`);
  console.log(`  failed (entry-level read)     ${f(entryLevelFailed)}`);
  console.log(`  gone since read (benign)      ${f(goneSinceRead)}`);

  // `notReached` is whole ENTRIES the outer loop never STARTED at all --
  // `stoppedAt` is set only at the top of the outer loop, never adjusted for
  // an entry whose per-sale loop ran out of budget partway through (that
  // entry was considered, its gates ran, and it already produced its own
  // moved/refused/failed sale outcomes above -- see the per-sale loop's own
  // comment). `notReachedSales` is the SEPARATE per-sale tally for exactly
  // that straddling case, so a straddled entry's own unprocessed sales are
  // never double-counted against both an entry-level "not reached" AND
  // their own sale-level outcome.
  const notReached = stoppedAt === null ? 0 : entries.length - stoppedAt - entriesFailedToClassify;
  console.log(`  not reached (budget, entries) ${f(notReached)}   <- the relaunch settles these`);
  console.log(`  not reached (budget, sales)   ${f(notReachedSales)}   <- unprocessed sales of an entry the budget stopped mid-way`);

  // RECONCILE. `intended` is defined per SALE the same way the sibling
  // repoint lanes define their `candidates`: every sale this run actually
  // classified (moved, refused for a reason attached to the SALE, or
  // failed), plus every unprocessed sale of an entry the budget stopped
  // mid-way (`notReachedSales`), plus every entry-level refusal that never
  // got to enumerate a sale (no-from-row, no-to-row, not-checklist-grade,
  // product-mismatch, same-id, zero-sales), plus malformed entries, plus
  // whole entries the budget never started (`notReached`). Two different
  // units (sales vs entries) sit in one formula because a per-entry refusal
  // never produces a sale-level outcome at all -- it is its own unit,
  // exactly once, the same way relocate-catalog-rows-by-list's own
  // `park`/`verify` are their own reconciled unit alongside per-row retires.
  //
  // TWO SEPARATE IDENTITIES, ONE PER UNIT -- an entry can carry MANY sales
  // (the whole point of this lane's list format, sized for thousands), so a
  // single formula comparing entry-shaped counts against `entries.length`
  // would be dimensionally wrong the moment any entry has more than one
  // sale: `saleLevelOutcomes` legitimately EXCEEDS 1 per entry, while
  // `entries.length` counts the entry itself exactly once. Each identity is
  // reconciled against its OWN denominator instead:
  //
  //   ENTRY side:  every entry is exactly one of { gated-through-to-its-
  //                sales, entry-level-refused, malformed, not-reached }.
  //   SALE side:   every sale an entry-level-gated-through entry actually
  //                enumerated (`intendedSalesTotal`, accumulated the instant
  //                gate 5 passes) is exactly one of { moved, refused
  //                (name-disagreement / guard), failed, not-reached-mid-
  //                entry }.
  const entryLevelRefusals = refusedNoFromRow + refusedNoToRow + refusedNotChecklistGrade
    + refusedProductMismatch + refusedSameId + refusedZeroSales + refusedExpectedSalesMismatch;
  // Entries that passed every entry-level gate and enumerated their sales --
  // the ENTRY-side count matching `intendedSalesTotal`'s sale-side total.
  const entriesGatedThrough = considered - entryLevelRefusals - entryLevelFailed - entriesFailedToClassify;
  const entryAccounted = entryLevelRefusals + entryLevelFailed + entriesGatedThrough + entriesFailedToClassify + notReached;
  const intendedEntries = entries.length;

  // `goneSinceRead` is a THIRD sale-side outcome, alongside refused/failed:
  // the ref was drained (counted in intendedSalesTotal), but its own point
  // read found nothing -- a benign concurrent mutation, never a failure. It
  // must sit in this formula or the strict sale-side identity reports a
  // false RECONCILE MISMATCH on any ordinary race against a live container.
  const saleLevelOutcomes = movedSales + refusedNameDisagreement + refusedNotResidentAtFrom + refusedGuard + failedSales
    + goneSinceRead + notReachedSales;
  const saleAccounted = saleLevelOutcomes;
  const intendedSales = intendedSalesTotal;

  console.log(`\n  reconciled (entries): intended ${f(intendedEntries)} = gated-through ${f(entriesGatedThrough)} `
    + `+ entry-refusals ${f(entryLevelRefusals)} + entry-failed ${f(entryLevelFailed)} + malformed ${f(entriesFailedToClassify)} + not-reached ${f(notReached)}`);
  console.log(`  reconciled (sales):   intended ${f(intendedSales)} = moved/would-move ${f(movedSales)} `
    + `+ refused ${f(refusedNameDisagreement + refusedNotResidentAtFrom + refusedGuard)} + failed ${f(failedSales)} + gone-since-read ${f(goneSinceRead)} + not-reached ${f(notReachedSales)}`);
  if (entryAccounted !== intendedEntries || saleAccounted !== intendedSales) {
    console.error("  !! RECONCILE MISMATCH -- an entry or a sale was neither gated, moved, refused, failed, malformed nor deferred");
    process.exitCode = 4;
  }

  if (APPLY) {
    // ONE FLAT UNIT SET for reportWrites, built from the two reconciled
    // identities above rather than re-mixing entries and sales: `intended`
    // is every unit ever considered a candidate for a write -- every
    // enumerated sale (`intendedSales`) PLUS every entry that was skipped,
    // failed or not-reached before it ever got to enumerate one (each of
    // those entries is a unit that produced NO sale-side outcome at all, so
    // it is added here exactly once, never folded into a sale count it
    // never contributed to).
    //
    // `skipped` ("we could not use this row") carries every entry-level
    // GATE refusal (no-from-row, no-to-row, not-checklist-grade, product-
    // mismatch, same-id, zero-sales, expected-sales-mismatch), malformed
    // entries, and whole entries the budget never started -- none of these
    // are the guard/namesAgree DECISIONS `refused` exists for.
    // `refused` ("we understood this row and declined to write it") is the
    // sale-level namesAgree, not-resident-at-from and splitIdentityWriteGuard
    // refusals only.
    // `failed` is genuine errors on either side of the entry/sale split.
    reportWrites({
      job: "repoint-sales-by-list",
      intended: intendedSales + entryLevelRefusals + entryLevelFailed + entriesFailedToClassify + notReached,
      written: movedSales,
      skipped: entryLevelRefusals + entriesFailedToClassify + notReached + notReachedSales + goneSinceRead,
      refused: refusedNameDisagreement + refusedNotResidentAtFrom + refusedGuard,
      failed: failedSales + entryLevelFailed,
    });
  }

  if (!APPLY) console.log("\nREPORT ONLY — nothing was written. Re-run with BACKFILL_APPLY=true to apply.");

  // -- THE MARKER THE RELAUNCH GREPS -----------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). Written as a source literal, not
  // assembled from variables, exactly matching every sibling list lane.
  //
  // `notReachedSales > 0` is ALSO a budget stop, even when `stoppedAt` is
  // still null: that happens when the very LAST entry in the list is the one
  // whose per-sale loop straddled the boundary -- the outer loop's own
  // top-of-loop check (which sets `stoppedAt`) never runs again because there
  // is no next entry to reach it. Without this the banner would print
  // "finished within budget" over a run that in fact left sales unprocessed.
  if (stoppedAt !== null || notReachedSales > 0) {
    console.log(`\n  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `stopped at ${f(stoppedAt ?? considered)} of ${f(intendedEntries)}; the relaunch continues from here`);
    console.log("  the list is IDEMPOTENT: a finished move re-reads as zero sales left at fromId,"
      + " so the continuation re-derives cheaply and writes only what is left.");
  } else {
    console.log(`\n  finished within budget (considered=${f(considered)}) — done, no re-dispatch.`);
  }

  return { client, budget: CLOCK };
}

module.exports = { classifyEntry, sameProductAddress, APPLY, SCOPE_ERROR };

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx))
    .catch(async (e) => {
      console.error("FATAL:", e?.stack || e?.message);
      await finishLane(3, {});
    });
}
