#!/usr/bin/env node
/**
 * repoint-sales-to-sibling-product.cjs -- a stored sale whose card NUMBER does
 * not exist in the product it is filed under, but DOES exist verbatim under a
 * confusable SIBLING product of the same sport+year, follows the number.
 *
 * THE MEASURED DEFECT (census decomposition, 2026-09-20). Many stored
 * sold_comps rows carry a `hobbyiqCardId` whose setKey segment names a
 * product whose strict checklist has no such card number at all, while a
 * SIBLING product of the same (sport, year) lists that exact number:
 *
 *   (a) baseball 2025 `topps` -- ~12% of the cell's unbacked sales carry
 *       Update Series numbers (`US###`) filed under plain `topps`. Those
 *       numbers exist on `topps-update-series`' own checklist and nowhere on
 *       flagship Topps'.
 *   (b) football 2023 `donruss-optic` -- base-Donruss INSERT numbers (`BS-`,
 *       `CIH-`, `SM-`, `SBD-`) filed under Optic. Those numbers exist under
 *       `panini-donruss` (or one of its registered insert keys), never on
 *       Optic's own checklist.
 *
 * The same class recurs across other years and products. In every case the
 * sale's pool is SPLIT away from the pool the card actually trades in, so the
 * FMV projection reads a pool that is missing its own comps.
 *
 * WHY NO EXISTING LANE REACHES IT.
 *
 *   repoint-stored-insert-sales.cjs drives from a REGISTERED INSERT's
 *   checklist and asks whether the TITLE names that insert
 *   (insertSetNamedInTitle). It is the right lane when the title says
 *   "Rookie Pix"; it is the wrong lane here, because a `US200` sale's title
 *   very often says nothing but "2025 Topps" -- the NUMBER, not the title,
 *   is the evidence, and this lane's own gate 1 (the number is absent from
 *   the FROM product entirely) is what makes that evidence admissible.
 *
 *   repoint-sales-to-checklist-numbered.cjs moves a sale along the PRINT RUN
 *   axis (`:num-N`) within ONE product. It never changes the setKey segment.
 *
 * THIS LANE changes exactly ONE axis: the setKey segment of the hiq: slug.
 * cardNumber, parallel and auto stay byte-identical -- the move is
 * `withProductSetKey(slug, toSetKey)` (the SAME helper repoint-stored-insert-
 * sales.cjs already trusts for the identical one-axis edit), never a
 * recompute of the identity.
 *
 * THE SIBLING PAIR LIST IS OPERATOR-RULED, NEVER INFERRED.
 *
 * A "confusable sibling" is a COLLECTOR-TAXONOMY judgement (feedback_ratio_
 * similarity_is_not_identity), and this lane deliberately owns no heuristic
 * for it: the `titles` runner input carries an EXPLICIT `from>to` pair list
 * (`topps>topps-update-series,donruss-optic>panini-donruss`). Empty, a
 * wildcard, or a token with no `>` is REFUSED (exit 2) -- a whole-source
 * write needs its own name (feedback_a_whole_source_retire_needs_its_name),
 * and a lane that GUESSES which products are siblings would mint exactly the
 * cross-product contamination the census is measuring. `parseSiblingPairs`
 * is pure and exported so the parse is unit-tested on its own.
 *
 * THE FOUR GATES. A sale MOVES only when every one of these holds; otherwise
 * it is REFUSED by the exact named reason, counted, and listed:
 *
 *   1. number-exists-in-from-product -- NO strict checklist row exists in the
 *      FROM product at that card number, at ANY parallel. If the FROM product
 *      genuinely lists the number, the sale is where it belongs (or belongs
 *      to a different repair) and this lane does not touch it. The FROM
 *      product's checklist is preloaded ONCE per (cell, from) by id prefix
 *      (`hiq:<sport>:<year>:<from>:`), never per sale.
 *   2. destination-rung-not-on-checklist -- a strict checklist row must exist
 *      in the TO product (or in a REGISTERED INSERT whose productParentOf is
 *      TO) at the SAME number AND at the EXACT (parallel, isAuto) rung the
 *      move would mint. Same discipline -- and the same case-insensitive
 *      parallel compare -- as repoint-stored-insert-sales.cjs's own
 *      destinationRungOnChecklist: never invent a rung.
 *   3. different-player -- THE ROSTER DECIDES. The destination row's
 *      playerName must match the sale's own via `playerIdentityKey`
 *      (multi-player rows split on the D33 separators, ANY listed name
 *      clearing it is enough), AND the sale's TITLE must not contradict the
 *      destination row (`titleContradictsTarget`, below).
 *   4. title-names-from-product -- the title must not NAME the FROM product
 *      in a way the move would contradict. Generic half: `inferSetKeyFromTitle`
 *      + `isRegisteredProduct` + `productAncestry` -- a title whose inferred
 *      product IS the FROM key, or a DESCENDANT of it, names the product this
 *      move is leaving. Pair-specific half: a small, explicit
 *      `PAIR_TITLE_RULES` table (below) may declare literal forbidden
 *      fragments -- `topps>topps-update-series` declares ["series 1",
 *      "series 2"], because an Update Series title rarely says "Update" at
 *      all (the US-number is unambiguous on its own) but a title that says
 *      "Series 2" is naming flagship Topps' OWN sub-identity and contradicts
 *      the move. Defaults to [] for any pair not listed -- never a global
 *      if-topps special case.
 *
 * NO NEW TITLE PARSER. `titleContradictsTarget` here is a thin ORCHESTRATION
 * of the SAME already-shipped primitives, called in the SAME order, as
 * repoint-sales-to-checklist-numbered.cjs's own (that one is a closure inside
 * its `main()` capturing a dozen `require`d deps and is not exported; rather
 * than restructure a 1,893-line sibling lane for an export, this file
 * requires the SAME dist/ modules directly and re-derives only the
 * orchestration). Every reader -- extractCardNumberFromTitle, sameCardNumber,
 * inferSetKeyFromTitle, productAncestry, isRegisteredProduct,
 * statedFinishFromChecklist, parallelTheTitleAllows, playerTheTitleAllows,
 * playerIdentityKey, slugify -- is called read-only. NONE of the six
 * derivation-stamp inputs (scripts/lib/derivation-version.cjs's
 * DERIVATION_INPUTS) is edited by this lane; parseTitleIdentity.service.ts
 * and hobbyIqCardId.service.ts are two of the six and only their EXPORTED
 * functions are CALLED.
 *
 * THE FOUR SHAPES A SALE MAY BE IN (classifySaleForSiblingMove, mirroring
 * repoint-sales-to-checklist-numbered.cjs's classifySaleForRelocation
 * verbatim in spirit, and keeping the #2339 guard it fixes intact):
 *
 *   (1) cardId === hobbyiqCardId === fromSlug        -> RELOCATE both fields
 *   (2) cardId is a raw VENDOR id (not `hiq:`) and
 *       hobbyiqCardId === fromSlug                   -> PATCH hobbyiqCardId
 *   (3) cardId === fromSlug, hobbyiqCardId ABSENT    -> folds into (1)
 *   (4) cardId === fromSlug, hobbyiqCardId ALREADY
 *       the target slug (a half-done prior run)      -> folds into (1),
 *                                                       idempotent
 *
 * EVERYTHING ELSE -- most importantly cardId and hobbyiqCardId BOTH `hiq:`
 * slugs naming two DIFFERENT cards -- REFUSES `split-identity`, from
 * whichever side reaches it, in REPORT and APPLY. #2339: the old shape of
 * this guard (fire only when NEITHER field names the scanned id) let one
 * lane RELOCATE a split row (destroying the fact that its hobbyiqCardId
 * named a different card) while another PATCHED the same document -- a torn
 * write on a row that was never this lane's to arbitrate. The other axis is
 * never overwritten on a split row.
 *
 * TWIN AT THE DESTINATION. A relocate's destination address (sale.id,
 * toSlug) can already hold a document -- sale ids are `{source}::{externalId}`
 * and do NOT embed cardId. Checked BEFORE the upsert, never after (an upsert
 * that already happened cannot be un-overwritten), with the PROVEN-LISTING
 * rule resolve-split-identity-parks.cjs uses: the SAME sale by
 * `contentHashOf` (relocate-sold-comp.cjs's mirror of soldCompsStore's own
 * computeContentHash) COLLAPSES -- the FROM-side copy is deleted and the
 * resident kept. A DIFFERENT resident is never deleted on a guess: the move
 * is LEFT, named `possible-twin-at-destination`, and both documents are
 * listed.
 *
 * NEVER-MOVE MARKERS, checked first, before any checklist or title work --
 * the SAME block, bucketed the same way, as repoint-stored-insert-sales.cjs's
 * planInsertRekey:
 *   verifiedByUser / USER_SEED_SOURCES  -> pinned-or-verified
 *   flaggedWrong / excludedFromFmv      -> flagged-or-excluded
 *   identityUnverified                  -> already-parked
 *
 * CF-A-SALE-IS-NEVER-LOST throughout: every relocate goes through
 * scripts/lib/relocate-sold-comp.cjs (upsert -> verify read-back -> delete,
 * with a CONDITIONAL `ifMatchEtag` delete), `guardSoldCompDoc` runs on every
 * would-be document in BOTH shapes before any write, and the banner's own
 * reconciliation is scanned == moved + patched + collapsed + refused(each
 * named class) + failed + left.
 *
 * REPORT-FIRST. BACKFILL_APPLY=true (not APPLY) gates every write, matching
 * the runner's own env name and every sibling lane. `planSiblingMove` is PURE
 * -- no I/O, no APPLY branch -- so REPORT runs the IDENTICAL decision APPLY
 * runs and prints the real would-move counts; the only APPLY/REPORT branch in
 * this file is at the point of actually writing. The pinned test asserts
 * REPORT's counts equal APPLY's on one fixture, guarding the sibling bug both
 * siblings' headers name (a REPORT that structurally cannot reach a non-zero
 * count because a write-only path decided something a report path never ran).
 *
 * PLAN_OUT (auditability, the mechanism resolve-split-identity-parks.cjs
 * introduced 2026-09-20). The banner's sample lists are capped; when PLAN_OUT
 * names a directory this run writes ONE NDJSON record per IN-SCOPE row to
 * `${PLAN_OUT}/plan-slot-${SLOT}.ndjson`, truncated at open, so a REPORT can
 * be audited row-by-row before the matching APPLY runs. The runner sets it to
 * a FIXED path guarded on script name; an operator never has to know it
 * exists.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true / APPLY=true to write;
 *      SCOPE required (sport:year cells, comma list, no 'all'); SET_KEYS /
 *      BCP_TITLES (the runner's `titles` input) required sibling-pair list
 *      `from>to[,from>to]`; SLOT/SLOTS (sha1(id) shards, opt-in via
 *      SHARD=true for slot 0); CONCURRENCY=8 (capped 32, or
 *      BACKFILL_CONCURRENCY); RUN_MINUTES=110; LIMIT=0 (soft cap);
 *      PLAN_OUT optional NDJSON directory.
 * Requires dist/ (catalogAuthority, productSetKeys, splitIdentityWriteGuard,
 * playerIdentityKey, parseTitleIdentity, hobbyIqCardId, soldCompsStore,
 * resolveProductByChecklist, statedFinishFromChecklist, titleOutranksVendorTag,
 * playerTheTitleAllows, cardCatalog, writeReconciliation).
 */
"use strict";
const path = require("path");
const fs = require("node:fs");
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
// CONCURRENCY capped at 32, the same ceiling both sibling lanes use -- the
// runner's measured fan-out width for this container's autoscale, so a
// fat-fingered dispatch value cannot fan this lane out past it.
const CONCURRENCY = Math.min(32, Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8)));
const LIMIT = Number(process.env.LIMIT || 0);

const SHARD_SCOPE = runnerShardScope({ label: "repoint-sales-to-sibling-product" });
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SHARD_SCOPE.SLOTS;

// ── THE SCOPE. sport:year cells, and an inherited default is REFUSED ────────
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const CELL_RE = /^[a-z][a-z0-9-]*:\d{4}$/;
const SCOPE_CELLS = RAW_SCOPE.map(lower).filter((p) => CELL_RE.test(p));
const SCOPE_REJECTED = RAW_SCOPE.filter((p) => !CELL_RE.test(lower(p)));

// ── PLAN_OUT: a fixed directory the runner sets, guarded on script name.
const PLAN_OUT = str(process.env.PLAN_OUT);

const WILDCARDS = new Set(["", "all", "*"]);

/**
 * PAIR-SPECIFIC FORBIDDEN TITLE FRAGMENTS, keyed `${from}>${to}`.
 *
 * Gate 4's generic half (inferSetKeyFromTitle + productAncestry) catches a
 * title that names the FROM product or a descendant of it. It CANNOT catch
 * the `topps > topps-update-series` shape, because "2025 Topps Update Series
 * #US200" infers as a product that is not the FROM key at all -- and a plain
 * "2025 Topps" title (the common case for an Update sale) infers exactly the
 * FROM key while being perfectly compatible with the move, since Update
 * Series IS a Topps release and an Update sale's title usually says nothing
 * more. So for that pair the discriminator is textual and narrow: a title
 * that says "Series 1" or "Series 2" is naming flagship Topps' OWN
 * sub-identity, which the move to Update Series contradicts.
 *
 * Declared as a TABLE, not an if-branch, so a new pair states its own rule
 * beside the others and every pair not listed defaults to [] -- no global
 * special case, nothing hidden in the control flow. Fragments are matched
 * case-insensitively as literal substrings of the sale's own title.
 */
const PAIR_TITLE_RULES = Object.freeze({
  "topps>topps-update-series": Object.freeze({ fromNameFragmentsForbidden: Object.freeze(["series 1", "series 2"]) }),
});

/** The forbidden-fragment list for a pair -- [] for any pair not declared. */
function forbiddenFragmentsFor(from, to) {
  return PAIR_TITLE_RULES[`${from}>${to}`]?.fromNameFragmentsForbidden ?? [];
}

/**
 * Parse the operator's sibling-pair list off the runner's `titles` input.
 *
 * PURE -- reads no process.env of its own, exactly as
 * resolve-split-identity-parks.cjs's `parseTitlesInput` is pure, and for the
 * same reason: it is called ONCE at module scope (so importing this file for
 * its pure helpers pays no Cosmos-shaped cost) but the `error` case is
 * VALIDATED inside main(), never at module load -- a module-load
 * process.exit(2) would break every pure-function unit test that merely
 * requires this file with an unrelated TITLES/SET_KEYS in its environment.
 *
 * Format: `from>to[,from>to...]`. Whitespace around either half is trimmed
 * (`topps > topps-update-series` parses). A token with no `>`, an empty half,
 * a `from` equal to its `to`, or a wildcard ('', 'all', '*') on either side
 * is a NAMED error -- never silently dropped, because a dropped pair is a
 * dispatch that quietly scans nothing.
 *
 * @returns {{pairs: Array<{from:string,to:string}>, error?: string}}
 *          `pairs` is [] whenever `error` is set.
 */
function parseSiblingPairs(raw) {
  const tokens = csv(raw);
  if (!tokens.length) {
    return { pairs: [], error: "no sibling pairs given -- pass titles=fromSetKey>toSetKey (comma-separate for several, e.g. topps>topps-update-series,donruss-optic>panini-donruss)" };
  }
  const pairs = [];
  const seen = new Set();
  for (const token of tokens) {
    if (WILDCARDS.has(lower(token))) {
      return { pairs: [], error: `titles carries the wildcard "${token}" -- this lane moves sold_comps rows onto another product, so "every setKey" is a whole-source write that needs its own name; pass explicit from>to pairs` };
    }
    if (!token.includes(">")) {
      return { pairs: [], error: `titles carries "${token}", which is not a sibling PAIR -- every token must be fromSetKey>toSetKey (literal '>'), e.g. topps>topps-update-series` };
    }
    const halves = token.split(">");
    if (halves.length !== 2) {
      return { pairs: [], error: `titles carries "${token}" with ${halves.length - 1} '>' separators -- a pair has exactly one, as fromSetKey>toSetKey` };
    }
    const from = lower(halves[0]);
    const to = lower(halves[1]);
    if (!from || !to) {
      return { pairs: [], error: `titles carries "${token}" with an empty half -- both sides of the '>' must name a setKey` };
    }
    if (WILDCARDS.has(from) || WILDCARDS.has(to)) {
      return { pairs: [], error: `titles carries the wildcard "${token}" -- neither half of a pair may be '', 'all' or '*'` };
    }
    if (from === to) {
      return { pairs: [], error: `titles carries "${token}" whose halves are the same setKey -- a move from a product to itself is not a move` };
    }
    const key = `${from}>${to}`;
    if (seen.has(key)) continue; // a repeated pair is harmless, not an error
    seen.add(key);
    pairs.push({ from, to });
  }
  return { pairs };
}

const PAIRS_PARSE = parseSiblingPairs(process.env.SET_KEYS || process.env.BCP_TITLES);
const SIBLING_PAIRS = PAIRS_PARSE.pairs ?? [];

// Jittered backoff, same widening both sibling lanes carry: under bounded
// parallelism several workers can be throttled at once, and a fixed sleep
// lets every one of them wake on the same tick and re-hammer the container.
let THROTTLE_COUNT = 0;
const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(msg) || a >= tries) throw e;
      THROTTLE_COUNT++;
      await new Promise((r) => setTimeout(r, Math.random() * wait));
      wait = Math.min(wait * 2, 15000);
    }
  }
};

async function forEachPage(container, spec, onPage, pageSize = 500) {
  let token;
  do {
    const page = await retry(() => container.items
      // maxItemCount is an EXPLICIT page size, never -1: -1 asks Cosmos to
      // decide and, on a container this size, never converges.
      // maxDegreeOfParallelism -1 is a DIFFERENT knob -- unbounded fan-out
      // for ONE query's own internal cross-partition reads -- and is what
      // makes a prefix scan finish.
      .query(spec, { maxItemCount: pageSize, maxDegreeOfParallelism: -1, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

/** p50/p95 over elapsed-ms samples; 0 (never NaN) for an empty list. */
function percentile(msValues, p) {
  if (!msValues.length) return 0;
  const sorted = [...msValues].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * The checklist preload for ONE (sport, year, setKey): every non-graded
 * catalog row whose id starts `hiq:<sport>:<year>:<setKey>:`. STARTSWITH on
 * the id is index-served; equality on sport/year is added so a row whose id
 * prefix matches but whose own cell disagrees is never folded in. NEVER a
 * cross-partition COUNT or GROUP BY.
 */
function checklistSpec(sport, year, setKey) {
  return {
    query: `SELECT c.id, c.source, c.sport, c.year, c.cardYear, c.setKey, c.cardNumber,
                   c.parallel, c.parallelSlug, c.isAuto, c.playerName
            FROM c
            WHERE STARTSWITH(c.id, @prefix)
              AND c.sport = @sport AND (c.year = @year OR c.cardYear = @year)
              AND NOT IS_DEFINED(c.gradeTier)`,
    parameters: [
      { name: "@prefix", value: `hiq:${sport}:${year}:${setKey}:` },
      { name: "@sport", value: sport },
      { name: "@year", value: year },
    ],
  };
}

/** The sales under ONE FROM product cell, addressed by hobbyiqCardId prefix --
 *  the same bounded indexed scan repoint-stored-insert-sales.cjs uses for its
 *  own base-product sweep. */
function salesSpec(sport, year, fromSetKey) {
  return {
    query: "SELECT * FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)",
    parameters: [{ name: "@p", value: `hiq:${sport}:${year}:${fromSetKey}:` }],
  };
}

const normNumber = (n) => String(n ?? "").trim().toLowerCase();
/** Human-form, mixed-case checklist parallel spellings -- compared
 *  case-insensitively, the same discipline the catalog's own LOWER(c.parallel)
 *  convention uses (feedback_catalog_parallel_field_is_human_form_mixed_case). */
const normParallelForRung = (p) => String(p ?? "").trim().toLowerCase().replace(/\s+/g, " ") || "base";

/**
 * LOCAL leading-zero fold over `cardNumberVariants`'s own (unchanged) output
 * -- the SAME fold insertSetChecklistConfirm.ts and repoint-stored-insert-
 * sales.cjs both apply, for the SAME reason: hobbyIqCardId.service.ts is a
 * declared derivation-stamp input, so a lane may only ever WIDEN a comparison
 * over its existing output, never edit the shared helper. "US005" gains
 * "US5"/"US-5"; a bare "005" gains "5". Never strips a run to nothing.
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

/** Multi-player catalog rows are ONE string listing every name ("Eddie
 *  Murray / Cal Ripken Jr.") -- the D33 shape insertSetChecklistConfirm.ts's
 *  own catalogRowPlayerKeys reads. Split on the documented separators. */
function catalogRowPlayerKeys(playerIdentityKeyFn, playerName) {
  const raw = String(playerName ?? "");
  const keys = new Set();
  for (const part of raw.split(/\s*[/&]\s*/)) {
    const k = playerIdentityKeyFn(part);
    if (k) keys.add(k);
  }
  return keys;
}

/** THE ROSTER DECIDES: the sale's player must be one of the names the
 *  destination catalog row lists. ANY listed name clearing it is enough --
 *  the sale depicts one player, so agreeing with one listed name is
 *  agreeing with the row. */
function playerMatchesRow(playerIdentityKeyFn, salePlayer, rowPlayer) {
  const saleKey = playerIdentityKeyFn(salePlayer ?? "");
  if (!saleKey) return false;
  return catalogRowPlayerKeys(playerIdentityKeyFn, rowPlayer).has(saleKey);
}

/**
 * GATE 1. Does the FROM product's own strict checklist list this card number
 * at ANY parallel? `fromNumbers` is the preloaded set of every normalised
 * number variant appearing on a CHECKLIST-AUTHORITY row of the FROM product
 * in this cell. A hit means the sale is filed where its number genuinely
 * lives, and this lane leaves it alone.
 */
function numberExistsInFromProduct(deps, fromNumbers, saleCardNumber) {
  const num = normNumber(saleCardNumber);
  if (!num) return false;
  if (fromNumbers.has(num)) return true;
  return withLeadingZeroFold(deps.cardNumberVariants(saleCardNumber)).some((v) => fromNumbers.has(v.toLowerCase()));
}

/**
 * GATE 2. Every strict checklist row in the TO product (or in a registered
 * insert whose parent is TO) matching this card number -- the candidate
 * destination rows, before the rung and roster checks narrow them.
 */
function destinationRowsForNumber(deps, toRows, saleCardNumber) {
  const num = normNumber(saleCardNumber);
  if (!num) return [];
  const variants = new Set(withLeadingZeroFold(deps.cardNumberVariants(saleCardNumber)).map((v) => v.toLowerCase()));
  return toRows.filter((r) => {
    const rNum = normNumber(r.cardNumber);
    return rNum === num || variants.has(rNum);
  });
}

/**
 * GATE 2 (the rung half). Of the number-matching destination rows, which
 * attest the EXACT (parallel, isAuto) rung this move would mint? The move
 * keeps those segments byte-identical, so a number that matches while the
 * rung does not is a destination this lane must NOT invent -- the same
 * finding-5 discipline repoint-stored-insert-sales.cjs's own
 * destinationRungOnChecklist enforces, with the same case-insensitive
 * parallel compare and boolean isAuto compare.
 */
function rowsAtDestinationRung(candidateRows, saleParallel, saleIsAuto) {
  const wantParallel = normParallelForRung(saleParallel);
  const wantAuto = saleIsAuto === true;
  return candidateRows.filter((r) => {
    if (normParallelForRung(r.parallelSlug ?? r.parallel) !== wantParallel) return false;
    return (r.isAuto === true) === wantAuto;
  });
}

const USER_SEED_SOURCES = new Set(["ebay-user-purchase", "ebay-user-sale", "manual-user-entry", "user-verified"]);

/**
 * The shape enumeration -- mirroring repoint-sales-to-checklist-numbered.cjs's
 * `classifySaleForRelocation` verbatim in spirit, renamed for this lane's own
 * axis, and keeping the #2339 guard it fixes INTACT.
 *
 * #2339, restated for this lane: a split-identity refusal that fires only
 * when NEITHER field names the scanned slug misses the exact shape a
 * concurrent dispatch turns into a torn write -- a sale with cardId naming
 * pair A's FROM slug and hobbyiqCardId naming pair B's FROM slug. Pair A's
 * scan would RELOCATE it (stamping hobbyiqCardId = toA, destroying the fact
 * that hobbyiqCardId used to name a DIFFERENT card) while pair B's scan
 * PATCHES the same document (stamping hobbyiqCardId = toB). Whichever write
 * lands last wins; the other is a lost update on a document that was never
 * this lane's to arbitrate. So the shapes this lane may touch are ENUMERATED,
 * never inferred from "one field happens to match":
 *
 *   (1) cardId === hobbyiqCardId === fromSlug           -> relocate
 *   (2) cardId not `hiq:` and hobbyiqCardId === fromSlug -> patch
 *   (3) cardId === fromSlug, hobbyiqCardId absent        -> folds into (1)
 *   (4) cardId === fromSlug, hobbyiqCardId === toSlug    -> folds into (1),
 *       a half-done prior run finished idempotently
 *
 * Everything else refuses `split-identity`, from whichever side reaches it,
 * with no shared state needed between two scans to agree on the refusal --
 * which is what makes running pairs concurrently safe: both compute the SAME
 * refuse verdict on the SAME snapshot, so there is no write to race on.
 *
 * `null` shape fields are for a human reading a refusal detail, never
 * branched on.
 */
function classifySaleForSiblingMove(sale, ctx) {
  const { fromSlug, toSlug } = ctx;
  const cardId = String(sale.cardId ?? "");
  const hobbyiqCardIdRaw = sale.hobbyiqCardId;
  const present = hobbyiqCardIdRaw !== null && hobbyiqCardIdRaw !== undefined && String(hobbyiqCardIdRaw) !== "";
  const hobbyiqCardId = present ? String(hobbyiqCardIdRaw) : cardId; // absent falls back to cardId -- shape (3)

  // (1)/(3)/(4): cardId IS the fromSlug, and hobbyiqCardId is either the SAME
  // fromSlug, absent (folded by the fallback above), or ALREADY the toSlug
  // this exact move would write. Every one agrees on the pair {fromSlug,
  // toSlug} -- never a split, because there is exactly one other card in play.
  if (cardId === fromSlug && (hobbyiqCardId === fromSlug || hobbyiqCardId === toSlug)) {
    return { ok: true, action: "relocate", shape: hobbyiqCardId === toSlug ? "half-done-relocate" : "both-fields", cardId, hobbyiqCardId };
  }

  // (2): a raw VENDOR partition with hobbyiqCardId naming the fromSlug. Only
  // the hobbyiqCardId moves; cardId is untouched, so nothing about the
  // vendor address is destroyed.
  if (!cardId.startsWith("hiq:") && hobbyiqCardId === fromSlug) {
    return { ok: true, action: "patch", shape: "vendor-cardId", cardId, hobbyiqCardId };
  }

  // Everything else. Most importantly: both fields `hiq:` slugs naming two
  // DIFFERENT cards, where one of them happens to be a fromSlug this run is
  // scanning. Never arbitrated here, never half-written.
  return { ok: false, action: "refuse", shape: "split-identity", cardId, hobbyiqCardId };
}

/**
 * THE PURE PER-SALE DECISION -- no I/O, no APPLY branch -- so REPORT and
 * APPLY run the IDENTICAL logic (the sibling bug both siblings' headers name:
 * a structural REPORT zero because a write-only code path decided something a
 * report-only path never ran).
 *
 * `ctx` carries everything the decision needs, all computed by the caller
 * ONCE per sale or preloaded once per cell:
 *   fromSlug, toSlug          the two addresses this move runs between
 *   from, to                  the two setKeys (for refusal details + the
 *                             pair-specific title rule lookup)
 *   fromNumbers               Set of every normalised number variant on the
 *                             FROM product's strict checklist (gate 1)
 *   toRows                    the TO product's (+ its registered inserts')
 *                             strict checklist rows (gate 2)
 *   titleContradiction        titleContradictsTarget's own verdict against
 *                             the chosen destination row (gate 3), or null
 *                             when no destination row was reached
 *   titleNamesFromProduct     gate 4's verdict: { names: boolean, detail }
 *
 * @returns {{action:"relocate"|"patch"|"refuse", reason?:string, detail?:string,
 *            newCardId?:string, newHiq?:string, targetRow?:object}}
 */
function planSiblingMove(deps, sale, ctx) {
  // ── NEVER-MOVE MARKERS, first, before any checklist or title work ───────
  if (sale.verifiedByUser === true) {
    return { action: "refuse", reason: "pinned-or-verified", detail: "verifiedByUser=true -- a real user attested this exact sale to this exact card" };
  }
  if (USER_SEED_SOURCES.has(String(sale.source ?? ""))) {
    return { action: "refuse", reason: "pinned-or-verified", detail: `source=${sale.source} -- a user-owned transaction already reconciled through the catalog at write time (CF-A-USER-SALE-IS-ALWAYS-RECONCILED)` };
  }
  if (sale.identityUnverified === true) {
    return { action: "refuse", reason: "already-parked", detail: "identityUnverified=true -- already parked; unparking is a different lane's job" };
  }
  if (sale.flaggedWrong === true) {
    return { action: "refuse", reason: "flagged-or-excluded", detail: "flaggedWrong=true -- a user already told the engine this comp is wrong; re-addressing it compounds that, it does not resolve it" };
  }
  if (sale.excludedFromFmv === true) {
    return { action: "refuse", reason: "flagged-or-excluded", detail: "excludedFromFmv=true -- already excluded from pricing; moving it does not restore trust" };
  }

  // ── THE SHAPE. Split identity refuses before any evidence is weighed --
  // a row whose two fields name two different cards is not this lane's to
  // arbitrate, whatever its number says.
  const classified = classifySaleForSiblingMove(sale, ctx);
  if (!classified.ok) {
    return {
      action: "refuse", reason: "split-identity",
      detail: `cardId=${classified.cardId} hobbyiqCardId=${classified.hobbyiqCardId} -- these do not agree on being exactly {${ctx.fromSlug}, ${ctx.toSlug}}; pre-existing split, not this lane's to fix`,
    };
  }

  // ── GATE 1. The FROM product HAS the number -> untouched.
  if (numberExistsInFromProduct(deps, ctx.fromNumbers, sale.cardNumber)) {
    return {
      action: "refuse", reason: "number-exists-in-from-product",
      detail: `#${sale.cardNumber ?? ""} IS on ${ctx.from}'s own strict checklist (some parallel) -- the sale is filed where its number lives; this lane moves only numbers ${ctx.from} does not list at all`,
    };
  }

  // ── GATE 2. The TO product must list the number AND attest the exact rung.
  const numberRows = destinationRowsForNumber(deps, ctx.toRows, sale.cardNumber);
  if (!numberRows.length) {
    return {
      action: "refuse", reason: "destination-rung-not-on-checklist",
      detail: `#${sale.cardNumber ?? ""} appears on neither ${ctx.from}'s nor ${ctx.to}'s strict checklist (nor any registered insert of ${ctx.to}) -- there is no destination to move to`,
    };
  }
  const rungRows = rowsAtDestinationRung(numberRows, sale.parallel, sale.isAuto);
  if (!rungRows.length) {
    return {
      action: "refuse", reason: "destination-rung-not-on-checklist",
      detail: `${ctx.to} #${sale.cardNumber ?? ""} exists, but no checklist row attests the (parallel="${sale.parallel ?? "base"}", auto=${sale.isAuto === true}) rung this move would mint -- never invent a rung`,
      rungKey: `${ctx.to}|${normParallelForRung(sale.parallel)}|${sale.isAuto === true ? "auto" : "no-auto"}`,
    };
  }

  // ── GATE 3. THE ROSTER DECIDES. Of the rows at the right number and rung,
  // one must list this sale's player.
  const rosterRows = rungRows.filter((r) => playerMatchesRow(deps.playerIdentityKey, sale.playerName, r.playerName));
  if (!rosterRows.length) {
    return {
      action: "refuse", reason: "different-player",
      detail: `${ctx.to} #${sale.cardNumber ?? ""} at this rung lists ${rungRows.map((r) => `"${r.playerName ?? ""}"`).join(", ")}, the sale says "${sale.playerName ?? ""}" -- the roster decides, and it says this is a different card`,
    };
  }
  const targetRow = rosterRows[0];

  // Gate 3's second half: the title must not contradict the destination row
  // the roster just chose (card number, product, parallel or player).
  if (ctx.titleContradiction && ctx.titleContradiction.contradicts) {
    return {
      action: "refuse", reason: "different-player",
      detail: `${ctx.titleContradiction.detail} -- the title contradicts the destination row (rule: ${ctx.titleContradiction.rule}); never laundered onto a checklist-backed address`,
      targetRow,
    };
  }

  // ── GATE 4. The title must not NAME the FROM product in a way this move
  // contradicts.
  if (ctx.titleNamesFromProduct && ctx.titleNamesFromProduct.names) {
    return { action: "refuse", reason: "title-names-from-product", detail: ctx.titleNamesFromProduct.detail, targetRow };
  }

  // ── MOVE. ONE axis: the setKey segment. parallel/auto/num stay as-is.
  const hiq = String(sale.hobbyiqCardId ?? sale.cardId ?? "");
  const newHiq = deps.withProductSetKey(hiq, ctx.to);
  if (classified.action === "relocate") {
    const newCardId = deps.withProductSetKey(String(sale.cardId ?? ""), ctx.to);
    return { action: "relocate", newCardId, newHiq: newCardId, targetRow };
  }
  return { action: "patch", newHiq, targetRow };
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  REPOINT: a sale whose card NUMBER lives under a confusable SIBLING product");
  console.log("  follows the number -- one axis (setKey), operator-ruled pairs only");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  if (SCOPE_REJECTED.length) {
    console.error("");
    console.error(`FATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are not cells: ${SCOPE_REJECTED.join(", ")}`);
    console.error("       A cell looks like baseball:2025 (sport:year).");
    process.exit(2);
  }
  if (!SCOPE_CELLS.length || RAW_SCOPE.some((x) => INHERITED_SCOPES.has(lower(x)))) {
    console.error("");
    console.error("FATAL: SCOPE is REQUIRED and names the cells to scan, as sport:year.");
    console.error("       There is no 'all' for this lane. Dispatch with -f scope=baseball:2025");
    console.error("       (comma-separate for several cells).");
    process.exit(2);
  }
  if (PAIRS_PARSE.error || !SIBLING_PAIRS.length) {
    console.error("");
    console.error("FATAL: the `titles` input (SET_KEYS/BCP_TITLES) is REQUIRED and carries this");
    console.error("       lane's SIBLING PAIR LIST -- fromSetKey>toSetKey, comma-separated.");
    console.error(`       ${PAIRS_PARSE.error ?? "no usable pairs parsed"}`);
    console.error("       A sibling is an OPERATOR RULING, never inferred: dispatch with");
    console.error("       -f titles=topps>topps-update-series  (or donruss-optic>panini-donruss).");
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const { productParentOf, productAncestry } = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
  const { withProductSetKey, guardSoldCompDoc } = require(path.join(backend, "dist/services/portfolioiq/splitIdentityWriteGuard.js"));
  const { playerIdentityKey } = require(path.join(backend, "dist/services/catalog/playerIdentityKey.js"));
  const { cardNumberVariants, sameCardNumber, slugify, foldCardNumber } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { relocateSoldComp, stripSystem, contentHashOf, is412 } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));

  // TITLE MACHINERY -- every one of these is an ALREADY-SHIPPED reader, called
  // read-only, in the SAME order repoint-sales-to-checklist-numbered.cjs's own
  // titleContradictsTarget calls them. No new title parser is written here;
  // only the ORCHESTRATION is re-derived, because that lane's copy is a
  // closure inside its main() capturing these same deps and is not exported.
  const { extractCardNumberFromTitle } = require(path.join(backend, "dist/services/portfolioiq/soldCompsStore.service.js"));
  const { inferSetKeyFromTitle } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
  const { isRegisteredProduct } = require(path.join(backend, "dist/services/catalog/resolveProductByChecklist.js"));
  const { statedFinishFromChecklist } = require(path.join(backend, "dist/services/portfolioiq/statedFinishFromChecklist.js"));
  const { parallelTheTitleAllows } = require(path.join(backend, "dist/services/portfolioiq/titleOutranksVendorTag.js"));
  const { playerTheTitleAllows, playerNameKey } = require(path.join(backend, "dist/services/portfolioiq/playerTheTitleAllows.js"));
  const { cleanPlayerName } = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));

  /**
   * guessPlayerFromTitle (persistVendorSalesToPool.service.ts) is not
   * exported; this mirrors its EXACT pattern -- lazy require of the same
   * compiled parser, same `.playerName?.trim()` read, same fail-to-null --
   * plus the `confidence > 0` floor repoint-sales-to-checklist-numbered.cjs's
   * own local copy adds, for the reason measured there: parseCardQuery
   * returns `{ playerName: "Plain", confidence: 0 }` for an unparseable
   * single word, and a veto that turns a garbage title into a false
   * contradiction is worse than one that says "no evidence".
   */
  function guessPlayerFromTitleLocal(title) {
    try {
      const { parseCardQuery } = require(path.join(backend, "dist/services/compiq/cardQueryParser.js"));
      const parsed = parseCardQuery(String(title || ""));
      if (!parsed || !(Number(parsed.confidence) > 0)) return null;
      const player = parsed.playerName;
      return typeof player === "string" && player.trim().length > 0 ? player.trim() : null;
    } catch { return null; }
  }

  // THE strict-checklist predicate. `catalogAuthorityOf(source) === "checklist"`
  // is the repo-standard test both sibling lanes use; there is no function
  // literally named isStrictChecklistSource.
  const isChecklist = (source) => catalogAuthorityOf(source) === "checklist";

  // ── the boundary-prefix exemption, byte-identical in behaviour to
  // repoint-sales-to-checklist-numbered.cjs's own: "the shorter code, plus a
  // literal hyphen, is a PREFIX of the longer one" is the SAME ladder at a
  // coarser grain ("#90ASC" on a "#90ASC-3" target), not a different card.
  function normalizeKeepHyphens(raw) {
    return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "");
  }
  function isHyphenSuffixOf(shorter, longer) {
    return Boolean(shorter) && longer.length > shorter.length && longer.startsWith(`${shorter}-`);
  }
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
   * Does the sale's own title contradict the DESTINATION row the roster
   * chose? Rules run in a fixed order (card-number, parallel, player) and
   * the FIRST one that fires wins.
   *
   * NOTE the deliberate difference from the numbered lane's copy: rule (b),
   * the PRODUCT rule, is NOT run here. That lane moves within ONE product,
   * so "the title infers a different product" is always a contradiction.
   * This lane's whole purpose is a move BETWEEN two products, so a title
   * inferring the FROM product is the expected input, not evidence against
   * the move -- the product question is answered instead by gate 4
   * (`titleNamesFromProduct`), which is directional and pair-aware. Running
   * the numbered lane's symmetric product rule here would refuse every single
   * candidate this lane exists to move.
   *
   * Returns `{ contradicts: false }` or `{ contradicts: true, rule, detail }`
   * with `rule` one of "card-number" | "parallel" | "player". Never throws:
   * every reader called fails open to null/false on its own.
   */
  function titleContradictsTarget(sale, target) {
    const title = String(sale.title ?? "");
    if (!title.trim()) return { contradicts: false };

    // (a) CARD NUMBER -- extractCardNumberFromTitle + sameCardNumber, the same
    // case/hyphen-insensitive comparison the confirm module uses, widened by
    // the boundary-prefix exemption above.
    const titleCardNumber = extractCardNumberFromTitle(title);
    if (
      titleCardNumber && target.cardNumber
      && !sameCardNumber(titleCardNumber, target.cardNumber)
      && !cardNumberIsUnderSpecified(titleCardNumber, target.cardNumber, title)
    ) {
      return { contradicts: true, rule: "card-number", detail: `title states #${titleCardNumber}, destination row is #${target.cardNumber}` };
    }

    // (c) PARALLEL/FINISH -- statedFinishFromChecklist scoped to the
    // DESTINATION's own setKey/year, then parallelTheTitleAllows to judge
    // agreement vs contradiction. `vendorTagOverruled` (non-null) is exactly
    // "the title's finish contradicts the row's own tag"; a refinement either
    // way returns null. Silence never reaches the call at all.
    const titleFinish = statedFinishFromChecklist(title, { setKey: target.setKey ?? null, year: target.year ?? target.cardYear ?? null });
    if (titleFinish) {
      const finishDecision = parallelTheTitleAllows(titleFinish, String(target.parallelSlug ?? target.parallel ?? "Base"));
      if (finishDecision.vendorTagOverruled) {
        return { contradicts: true, rule: "parallel", detail: `title states finish "${titleFinish}", destination row is "${target.parallelSlug ?? target.parallel ?? "Base"}"` };
      }
    }

    // (player) -- playerTheTitleAllows, the production ingest-time gate, fed
    // by the same title reader guessPlayerFromTitle uses, with the SAME
    // subset exemption the numbered lane carries (a stored checklist marker
    // like "RC"/"FS", or an extra trailing token the loose title parse
    // grabbed, is neither side being wrong about WHO is on the card).
    const titlePlayer = guessPlayerFromTitleLocal(title);
    if (titlePlayer && target.playerName) {
      const targetNames = String(target.playerName).split(/\s*(?:\/|&|\band\b)\s*/i).map((n) => n.trim()).filter(Boolean);
      const namesToCheck = targetNames.length ? targetNames : [String(target.playerName)];
      const titleKey = playerIdentityKey(titlePlayer);
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
      const isSubsetMatch = namesToCheck.some((name) => {
        const nameKey = playerIdentityKey(name);
        if (!nameKey || !titleKey) return false;
        if (nameKey === titleKey) return true;
        const nameTokens = tokensOf(name);
        const titleTokens = tokensOf(titlePlayer);
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

  /**
   * GATE 4. Does the title NAME the FROM product in a way that contradicts
   * the move? Two halves, both explicit:
   *
   *   (i) GENERIC, directional, over the R29 registry: `inferSetKeyFromTitle`
   *       + `isRegisteredProduct` + `productAncestry`. A title whose inferred
   *       product IS the FROM key, or is a DESCENDANT of it (a MORE specific
   *       product under FROM -- e.g. an "Optic Rated Rookie" title on an
   *       Optic->Donruss move), names the product this move is leaving and
   *       contradicts it. The directional reading is the same one
   *       repoint-sales-to-checklist-numbered.cjs's rule (b) already
   *       implements. An inferred key that is an ANCESTOR of FROM (a lazy
   *       "Panini" title) is silence, never a contradiction -- and an
   *       inferred key that is the TO product, or under it, obviously agrees
   *       with the move.
   *
   *  (ii) PAIR-SPECIFIC literal fragments from PAIR_TITLE_RULES (see that
   *       table's own comment for why topps>topps-update-series needs one and
   *       why it is a table rather than an if-branch).
   */
  function titleNamesFromProduct(sale, from, to) {
    const title = String(sale.title ?? "");
    if (!title.trim()) return { names: false };

    for (const fragment of forbiddenFragmentsFor(from, to)) {
      if (title.toLowerCase().includes(String(fragment).toLowerCase())) {
        return {
          names: true,
          detail: `title says "${fragment}" -- that names ${from}'s OWN sub-identity, which a move to ${to} contradicts (pair rule ${from}>${to})`,
        };
      }
    }

    const inferred = inferSetKeyFromTitle(title, sale.cardNumber ?? undefined);
    const titleSetKey = inferred && inferred !== "Unknown" ? slugify(inferred) : "";
    if (!titleSetKey) return { names: false };
    // A key is usable evidence when the R29 registry either registers it
    // outright OR resolves it through the ancestry chain. Measured: a real
    // Optic title infers "Panini Optic" -> `panini-optic`, which
    // isRegisteredProduct says FALSE while productAncestry resolves it to
    // ["panini-optic", "donruss-optic", "panini"] -- i.e. the registry DOES
    // know the key, as an alias of the registered `donruss-optic`. Gating on
    // isRegisteredProduct alone therefore discarded the single most important
    // piece of evidence for the donruss-optic>panini-donruss pair. Both
    // readings are consulted; a key neither recognises is silence.
    const titleAncestry = productAncestry(titleSetKey);
    if (!isRegisteredProduct(titleSetKey) && titleAncestry.length <= 1) return { names: false };

    // Agrees with the move outright: the title already names the destination,
    // or a product registered UNDER it.
    if (titleSetKey === to || titleAncestry.includes(to)) return { names: false };

    // ── DIRECTION, and the one case that makes this rule subtle.
    //
    // When TO is registered UNDER FROM (productAncestry("topps-update-series")
    // is ["topps-update-series", "topps"] -- measured), a title that infers
    // bare FROM is an ANCESTOR of the destination: it UNDER-SPECIFIES the
    // address rather than contradicting it. That is the COMMON and expected
    // shape this whole lane exists for -- "2025 Topps Shohei Ohtani #US200"
    // is exactly what an Update Series sale's title looks like, because a
    // seller writes the flagship brand and the US-number carries the rest.
    // Refusing it would refuse every candidate the pilot cell contains.
    // This is the SAME directional reading repoint-sales-to-checklist-
    // numbered.cjs's rule (b) uses (an ancestor-of-target title is silence,
    // a descendant-of-target title is a contradiction), applied with the
    // DESTINATION as the target.
    //
    // The discriminator for that pair is therefore textual and narrow, and it
    // has already run above: PAIR_TITLE_RULES["topps>topps-update-series"]
    // refuses a title that says "Series 1"/"Series 2", which names flagship
    // Topps' OWN sub-identity and genuinely contradicts a move to Update.
    //
    // When TO is NOT under FROM (donruss-optic > panini-donruss: Optic's
    // ancestry is ["donruss-optic", "panini"], which does not contain
    // panini-donruss), a title inferring FROM -- or a product registered
    // under FROM -- names the product this move LEAVES, with no
    // under-specification reading available. That refuses.
    const toIsUnderFrom = productAncestry(to).includes(from);
    const titleNamesFromOrBelow = titleSetKey === from || titleAncestry.includes(from);
    if (titleNamesFromOrBelow && !toIsUnderFrom) {
      return {
        names: true,
        detail: titleSetKey === from
          ? `title infers product "${inferred}" (${titleSetKey}), which IS the FROM product ${from} this move leaves, and ${to} is not registered under ${from} -- there is no under-specification reading`
          : `title infers product "${inferred}" (${titleSetKey}), a registered DESCENDANT of the FROM product ${from} -- it names ${from} specifically, contradicting the move to ${to}`,
      };
    }
    // TO is under FROM and the title names FROM or something under it: a
    // DESCENDANT of FROM that is not also an ancestor of TO still names a
    // rival specialization ("Topps Chrome" on a topps>topps-update-series
    // move), which the move contradicts.
    if (toIsUnderFrom && titleSetKey !== from && titleNamesFromOrBelow && !productAncestry(to).includes(titleSetKey)) {
      return {
        names: true,
        detail: `title infers product "${inferred}" (${titleSetKey}), a registered specialization of ${from} that is NOT on ${to}'s own ancestry -- it names a rival product, contradicting the move`,
      };
    }
    return { names: false };
  }

  const deps = { cardNumberVariants, playerIdentityKey, withProductSetKey };

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  console.log(`  scope (${SCOPE_CELLS.length} cell${SCOPE_CELLS.length === 1 ? "" : "s"})    ${SCOPE_CELLS.join(", ")}`);
  console.log(`  sibling pairs    ${SIBLING_PAIRS.map((p) => `${p.from}>${p.to}`).join(", ")}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");
  console.log("  a sale MOVES only when: (1) the FROM product's strict checklist does NOT list");
  console.log("  its number at any parallel, (2) the TO product (or a registered insert of it)");
  console.log("  DOES, at the exact (number, parallel, auto) rung, (3) the destination row's");
  console.log("  roster names the sale's player and the title does not contradict the row, and");
  console.log("  (4) the title does not name the FROM product. One axis moves: the setKey.");
  console.log("");

  const s = {
    catalogRowsScanned: 0, fromChecklistRows: 0, toChecklistRows: 0,
    cellsScanned: 0, otherShard: 0,
    salesScanned: 0, salesOutOfShape: 0,
    salesMoved: 0, salesPatched: 0, collapsedOntoResident: 0,
    refusedNumberExistsInFrom: 0, refusedDestinationRung: 0, refusedDifferentPlayer: 0,
    refusedTitleNamesFromProduct: 0, refusedSplitIdentity: 0, refusedPossibleTwin: 0,
    refusedPinnedOrVerified: 0, refusedFlaggedOrExcluded: 0, refusedAlreadyParked: 0,
    refusedGuardParked: 0, refusedEtagChanged: 0,
    salesFailed: 0, notReached: 0, throttled: 0,
    salesQueries: 0, ruCharge: 0,
  };
  const REFUSAL_KEYS = Object.freeze([
    "number-exists-in-from-product", "destination-rung-not-on-checklist", "different-player",
    "title-names-from-product", "split-identity", "possible-twin-at-destination",
    "pinned-or-verified", "flagged-or-excluded", "already-parked",
    "guard-parked", "stale-since-plan",
  ]);
  const refusals = Object.fromEntries(REFUSAL_KEYS.map((k) => [k, []]));
  const COUNTER_FOR_REASON = Object.freeze({
    "number-exists-in-from-product": "refusedNumberExistsInFrom",
    "destination-rung-not-on-checklist": "refusedDestinationRung",
    "different-player": "refusedDifferentPlayer",
    "title-names-from-product": "refusedTitleNamesFromProduct",
    "split-identity": "refusedSplitIdentity",
    "possible-twin-at-destination": "refusedPossibleTwin",
    "pinned-or-verified": "refusedPinnedOrVerified",
    "flagged-or-excluded": "refusedFlaggedOrExcluded",
    "already-parked": "refusedAlreadyParked",
    "guard-parked": "refusedGuardParked",
    "stale-since-plan": "refusedEtagChanged",
  });
  const examples = [];
  const collapsedExamples = [];
  const failures = [];
  const byPair = new Map();
  // ROLLUP_DELIM: the codepoint U+0000, never found in a slug or a setKey, so
  // a composite rollup key can be split back apart unambiguously -- the same
  // delimiter resolve-split-identity-parks.cjs's own rollup uses. Built with
  // String.fromCharCode rather than written as a literal escape, because a
  // LITERAL NUL byte in source is the corruption class this repo's byte-scan
  // discipline (0x00/0x08) exists to catch, and a legitimate one would make
  // that scan unusable on this file.
  const ROLLUP_DELIM = String.fromCharCode(0);
  const fromToPairs = new Map(); // `fromId${ROLLUP_DELIM}toId` -> count, for the top-30 rollup
  const salesQueryMs = [];
  let stoppedAtBudget = false;

  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  /** Count a refusal ONCE, into its named bucket and its named counter. There
   *  is no "other" bucket: an unnamed reason would be invisible in the
   *  reconciliation, so it fails loudly instead. */
  function noteRefusal(reason, line) {
    const counter = COUNTER_FOR_REASON[reason];
    if (!counter) throw new Error(`repoint-sales-to-sibling-product: unnamed refusal reason "${reason}" -- every refusal must be a declared class`);
    s[counter]++;
    refusals[reason].push(line);
  }

  // ── PLAN_OUT: one NDJSON record per in-scope row, truncated at open. A
  // synchronous append -- this lane's concurrency is bounded, so a per-row
  // appendFileSync is never a bottleneck next to a Cosmos round trip, and
  // synchronous means no record is lost to an unflushed buffer if the process
  // is stopped at its budget boundary.
  let planFd = null;
  if (PLAN_OUT) {
    try {
      fs.mkdirSync(PLAN_OUT, { recursive: true });
      const planPath = path.join(PLAN_OUT, `plan-slot-${SHARD_SCOPE.SLOT}.ndjson`);
      planFd = fs.openSync(planPath, "w");
      console.log(`  plan file         ${planPath}`);
    } catch (e) {
      console.log(`\n::warning::could not open PLAN_OUT (${PLAN_OUT}): ${e?.message}`);
      planFd = null;
    }
  }
  let planRowsWritten = 0;
  function emitPlanRow(doc, action, reason, extra = {}) {
    planRowsWritten++;
    if (!planFd) return;
    const record = {
      action, reason: reason ?? null,
      id: doc?.id ?? null, source: doc?.source ?? null, title: doc?.title ?? null,
      price: doc?.price ?? null, soldAt: doc?.soldAt ?? null,
      cardId: doc?.cardId ?? null, hobbyiqCardId: doc?.hobbyiqCardId ?? null,
      cardNumber: doc?.cardNumber ?? null, playerName: doc?.playerName ?? null,
      parallel: doc?.parallel ?? null, isAuto: doc?.isAuto ?? null,
      fromSetKey: extra.from ?? null, toSetKey: extra.to ?? null,
      toId: extra.toId ?? null,
      destinationRowId: extra.destinationRowId ?? null,
      destinationRowPlayer: extra.destinationRowPlayer ?? null,
      destinationRowSource: extra.destinationRowSource ?? null,
      twinId: extra.twinId ?? null, twinSource: extra.twinSource ?? null,
    };
    try { fs.appendFileSync(planFd, JSON.stringify(record) + "\n"); }
    catch (e) { console.log(`\n::warning::PLAN_OUT write failed for ${doc?.id}: ${e?.message}`); }
  }

  /** A document already resident at an address? Point read; 404 is null. */
  async function residentAt(saleId, cardId) {
    try { return (await retry(() => pool.item(saleId, cardId).read())).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
  }

  /**
   * Same sale, or a different one occupying the same address? Decided the way
   * the rest of the pool decides it: `contentHashOf` (relocate-sold-comp.cjs's
   * mirror of soldCompsStore.computeContentHash -- the repo's ONE cross-source
   * dedup key), comparing the RESIDENT's hash against the hash the incoming
   * sale WOULD carry once moved. Not a new notion of sameness.
   */
  function isSameSale(resident, incomingAtNewAddress) {
    if (!resident) return false;
    return contentHashOf(resident) === contentHashOf(incomingAtNewAddress);
  }

  /** Page a catalog checklist scan into strict rows only, with an in-loop
   *  deadline check so a pathological cell cannot run past the budget. */
  async function loadChecklistRows(sport, year, setKey) {
    const rows = [];
    await forEachPage(cat, checklistSpec(sport, year, setKey), async (page) => {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; return false; }
      for (const r of page) {
        s.catalogRowsScanned++;
        if (!isChecklist(r.source)) continue;
        rows.push(r);
      }
      return true;
    });
    return rows;
  }

  /**
   * Every strict checklist row that can serve as a DESTINATION for the TO
   * product: TO's own rows, plus the rows of every REGISTERED INSERT whose
   * `productParentOf` is TO. The insert keys are discovered from the cell's
   * OWN catalog rows (the setKey field of a row whose parent is TO), never
   * guessed -- so an insert nobody has a checklist for contributes nothing
   * and is silently absent rather than invented.
   */
  async function loadDestinationRows(sport, year, to, insertKeysInCell) {
    const rows = await loadChecklistRows(sport, year, to);
    for (const insertKey of insertKeysInCell) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
      const insertRows = await loadChecklistRows(sport, year, insertKey);
      for (const r of insertRows) rows.push(r);
    }
    return rows;
  }

  /**
   * Which REGISTERED INSERT keys in this (sport, year) cell have `to` as
   * their product parent? Read off the catalog rows already in hand for the
   * FROM/TO scan is not possible (an insert's rows live under its OWN id
   * prefix), so this asks the registry directly over the cell's distinct
   * setKeys -- bounded by one indexed DISTINCT-free scan of the TO product's
   * own sibling keys is not available either, so the registry is asked about
   * the setKeys the SALES themselves and the operator's pair name, plus the
   * registry's own children when it exposes them. In practice the registry is
   * the authority: `productParentOf(k) === to`.
   */
  function insertKeysWithParent(candidateKeys, to) {
    const out = [];
    for (const k of candidateKeys) {
      if (!k || k === to) continue;
      try { if (productParentOf(k) === to) out.push(k); } catch { /* unregistered key: not an insert of TO */ }
    }
    return out;
  }

  /**
   * ONE (cell, pair) unit: preload both checklists, page the FROM product's
   * sales, decide each purely, then write.
   *
   * IDEMPOTENT BY CONSTRUCTION: a moved sale's hobbyiqCardId no longer starts
   * with the FROM prefix, so a relaunch after a budget stop simply does not
   * see it again, whichever worker would have claimed it.
   */
  async function processPair(sport, year, pair) {
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; s.notReached++; return; }
    const { from, to } = pair;
    const pairLabel = `${from}>${to}`;

    const fromRows = await loadChecklistRows(sport, year, from);
    s.fromChecklistRows += fromRows.length;
    const fromNumbers = new Set();
    for (const r of fromRows) {
      if (!r.cardNumber) continue;
      for (const v of withLeadingZeroFold(cardNumberVariants(r.cardNumber))) fromNumbers.add(v.toLowerCase());
      fromNumbers.add(normNumber(r.cardNumber));
    }

    // The registered inserts of TO that this dispatch can reach. Candidate
    // keys come from the registry's view of the pair's own two keys plus the
    // TO product's rows' own setKey values -- an insert whose rows are filed
    // under their own key shows up there.
    const toOwnRows = await loadChecklistRows(sport, year, to);
    const candidateInsertKeys = new Set();
    for (const r of toOwnRows) {
      const k = lower(r.setKey ?? "");
      if (k && k !== to) candidateInsertKeys.add(k);
    }
    const insertKeys = insertKeysWithParent([...candidateInsertKeys], to);
    const toRows = toOwnRows.slice();
    for (const insertKey of insertKeys) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
      for (const r of await loadChecklistRows(sport, year, insertKey)) toRows.push(r);
    }
    s.toChecklistRows += toRows.length;

    console.log(`  [${sport}:${year}] ${pairLabel}: ${f(fromRows.length)} strict FROM rows (${f(fromNumbers.size)} number variants), ${f(toRows.length)} strict TO rows${insertKeys.length ? ` (incl. ${insertKeys.length} registered insert key(s) of ${to})` : ""}`);

    if (!toRows.length) {
      console.log(`  ::warning::${pairLabel} in ${sport}:${year} has NO strict checklist rows at the destination -- every sale here can only refuse destination-rung-not-on-checklist. Check the TO key.`);
    }

    const queryStarted = Date.now();
    const sales = [];
    await forEachPage(pool, salesSpec(sport, year, from), async (page) => {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; return false; }
      for (const row of page) sales.push(row);
      return true;
    });
    s.salesQueries++;
    salesQueryMs.push(Date.now() - queryStarted);

    const ctxBase = { from, to, fromNumbers, toRows };

    for (const sale of sales) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; s.notReached++; continue; }
      if (LIMIT && (s.salesMoved + s.salesPatched) >= LIMIT) { s.notReached++; continue; }
      if (SHARD_SCOPE.SHARDED && shardOf(String(sale.id)) !== SHARD_SCOPE.SLOT) { s.otherShard++; continue; }

      const fromSlug = String(sale.hobbyiqCardId ?? sale.cardId ?? "");
      // The setKey segment must equal `from` EXACTLY (a STARTSWITH prefix
      // match on `hiq:sport:year:from:` already guarantees it, but a slug
      // whose fourth segment merely begins with `from` would slip through a
      // looser reading, so it is re-checked here on the parsed segment).
      const seg = fromSlug.split(":");
      if (seg.length < 4 || seg[0] !== "hiq" || seg[1] !== sport || Number(seg[2]) !== year || seg[3] !== from) {
        s.salesOutOfShape++;
        continue;
      }
      s.salesScanned++;
      const toSlug = withProductSetKey(fromSlug, to);

      // Both title computations run ONCE per sale, at the call site, so the
      // decision function stays pure and I/O-free and REPORT/APPLY run the
      // identical decision. The contradiction check needs a destination row,
      // which only the decision knows -- so it runs in two steps: decide with
      // a null contradiction first to learn the row, then re-decide with the
      // real verdict. Both calls are pure; nothing is written in between.
      const namesFrom = titleNamesFromProduct(sale, from, to);
      const firstPass = planSiblingMove(deps, sale, { ...ctxBase, fromSlug, toSlug, titleContradiction: null, titleNamesFromProduct: namesFrom });
      const contradiction = firstPass.targetRow ? titleContradictsTarget(sale, firstPass.targetRow) : null;
      const plan = contradiction
        ? planSiblingMove(deps, sale, { ...ctxBase, fromSlug, toSlug, titleContradiction: contradiction, titleNamesFromProduct: namesFrom })
        : firstPass;

      if (plan.action === "refuse") {
        noteRefusal(plan.reason, `  ${sale.id}@${sale.cardId} (${fromSlug}): ${plan.detail}`);
        emitPlanRow(sale, "refused", plan.reason, { from, to, toId: toSlug, destinationRowId: plan.targetRow?.id ?? null, destinationRowPlayer: plan.targetRow?.playerName ?? null, destinationRowSource: plan.targetRow?.source ?? null });
        continue;
      }

      try {
        if (plan.action === "relocate") {
          const keep = {
            ...stripSystem(sale),
            cardId: plan.newCardId, hobbyiqCardId: plan.newHiq,
            reslugedFrom: fromSlug,
            reslugedReason: `card number lives under the sibling product ${to}, not ${from} (repoint-sales-to-sibling-product)`,
            reslugedAt: new Date().toISOString(),
          };
          keep.contentHash = contentHashOf(keep);

          // TWIN AT THE DESTINATION, checked BEFORE the upsert: relocateSoldComp's
          // upsert is a blind write at (sale.id, newCardId) and replaces whatever
          // is there. An upsert that already happened cannot be un-overwritten.
          const resident = await residentAt(sale.id, plan.newCardId);
          if (resident) {
            if (isSameSale(resident, keep)) {
              // PROVEN same sale by content hash -> COLLAPSE: delete the
              // FROM-side copy, keep the resident. Nothing about the kept
              // document changes.
              if (APPLY) await retry(() => pool.item(sale.id, sale.cardId).delete());
              s.collapsedOntoResident++;
              if (collapsedExamples.length < 20) collapsedExamples.push(`  COLLAPSE ${sale.id}@${sale.cardId} -- same sale already resident at ${plan.newCardId}; from-side copy deleted`);
              emitPlanRow(sale, "collapse", "same-sale-at-destination", { from, to, toId: plan.newCardId, twinId: resident.id, twinSource: resident.source ?? null });
              continue;
            }
            // A DIFFERENT resident, with no stronger proof. Never deleted on
            // a guess -- LEAVE both, list both.
            noteRefusal("possible-twin-at-destination", `  ${sale.id}@${sale.cardId} -> ${plan.newCardId}: a DIFFERENT sale (by content hash) already resides at the destination; NEITHER moved -- resident source=${resident.source ?? "?"} price=${resident.price ?? "?"} soldAt=${resident.soldAt ?? "?"} vs incoming price=${sale.price ?? "?"} soldAt=${sale.soldAt ?? "?"}`);
            emitPlanRow(sale, "refused", "possible-twin-at-destination", { from, to, toId: plan.newCardId, twinId: resident.id, twinSource: resident.source ?? null });
            continue;
          }

          // LAST-LINE DEFENCE: `sale` is the planning read's snapshot. One
          // extra point read, compared by `_etag`, so a document that changed
          // (or vanished) since the plan is refused rather than written over
          // with a decision made on data that no longer describes it. Runs in
          // BOTH modes -- REPORT reads the same live container APPLY would.
          let fresh = null;
          try { fresh = await residentAt(sale.id, sale.cardId); }
          catch (e) { s.salesFailed++; failures.push(`  FAILED relocate ${sale.id}@${sale.cardId} -> ${plan.newCardId}: could not re-read before write: ${String(e?.message ?? e)}`); emitPlanRow(sale, "failed", "re-read-failed", { from, to, toId: plan.newCardId }); continue; }
          if (!fresh || String(fresh._etag ?? "") !== String(sale._etag ?? "")) {
            const why = fresh
              ? `_etag changed since the planning read (${sale._etag ?? "?"} -> ${fresh._etag ?? "?"})`
              : `gone from ${sale.cardId} since the planning read (already moved or deleted by something else)`;
            noteRefusal("stale-since-plan", `  ${sale.id}@${sale.cardId} -> ${plan.newCardId}: ${why} -- refused, not relocated on stale data`);
            emitPlanRow(sale, "refused", "stale-since-plan", { from, to, toId: plan.newCardId });
            continue;
          }

          // guardSoldCompDoc on the WOULD-BE document, in REPORT as in APPLY
          // -- the same write-door predicate recordSoldComp itself runs.
          // (relocateSoldComp runs it again internally; running it here means
          // a REPORT reports the same refusal an APPLY would hit.)
          const verdict = guardSoldCompDoc({ ...keep }, { guardedBy: "repoint-sales-to-sibling-product" });
          if (verdict.verdict === "park" && verdict.reason === "malformed-key") {
            noteRefusal("guard-parked", `  ${sale.id}@${sale.cardId} -> ${plan.newCardId}: ${verdict.detail ?? verdict.reason}`);
            emitPlanRow(sale, "refused", "guard-parked", { from, to, toId: plan.newCardId });
            continue;
          }

          const res = await relocateSoldComp(pool, {
            keep,
            drop: [{ id: sale.id, cardId: sale.cardId, ifMatchEtag: fresh._etag }],
            retry, verifyFields: ["cardId", "hobbyiqCardId"], dryRun: !APPLY,
          });
          if (res.guard?.verdict === "park" && res.stage === "guard") {
            noteRefusal("guard-parked", `  ${sale.id}@${sale.cardId}: ${res.error ?? res.guard.reason}`);
            emitPlanRow(sale, "refused", "guard-parked", { from, to, toId: plan.newCardId });
            continue;
          }
          if (res.staleSincePlan?.length) {
            noteRefusal("stale-since-plan", `  ${sale.id}@${sale.cardId} -> ${plan.newCardId}: delete refused (412) -- source changed between the last-line re-read and the delete itself; the keeper is already at ${plan.newCardId}, the from-side copy is left for a later pass`);
            emitPlanRow(sale, "refused", "stale-since-plan", { from, to, toId: plan.newCardId });
            continue;
          }
          if (!res.ok && res.stage !== "dry-run") {
            s.salesFailed++;
            failures.push(`  FAILED relocate ${sale.id}@${sale.cardId} -> ${plan.newCardId}: ${res.error ?? "unknown"}`);
            emitPlanRow(sale, "failed", res.error ?? "unknown", { from, to, toId: plan.newCardId });
            continue;
          }
          s.salesMoved++;
          bump(byPair, pairLabel);
          bump(fromToPairs, `${fromSlug}${ROLLUP_DELIM}${plan.newCardId}`);
          if (examples.length < 24) examples.push(`  RELOCATE ${sale.id}@${sale.cardId} -> ${plan.newCardId}`);
          emitPlanRow(sale, "relocate", null, { from, to, toId: plan.newCardId, destinationRowId: plan.targetRow?.id ?? null, destinationRowPlayer: plan.targetRow?.playerName ?? null, destinationRowSource: plan.targetRow?.source ?? null });
          continue;
        }

        // ── PATCH shape: the row lives at a vendor partition; only
        // hobbyiqCardId moves, cardId is untouched.
        let fresh = null;
        try { fresh = await residentAt(sale.id, sale.cardId); }
        catch (e) { s.salesFailed++; failures.push(`  FAILED patch ${sale.id}@${sale.cardId}: could not re-read before write: ${String(e?.message ?? e)}`); emitPlanRow(sale, "failed", "re-read-failed", { from, to, toId: plan.newHiq }); continue; }
        if (!fresh || String(fresh._etag ?? "") !== String(sale._etag ?? "")) {
          const why = fresh
            ? `_etag changed since the planning read (${sale._etag ?? "?"} -> ${fresh._etag ?? "?"})`
            : `gone from ${sale.cardId} since the planning read (already moved or deleted by something else)`;
          noteRefusal("stale-since-plan", `  ${sale.id}@${sale.cardId} (hobbyiqCardId=${fromSlug}): ${why} -- refused, not patched on stale data`);
          emitPlanRow(sale, "refused", "stale-since-plan", { from, to, toId: plan.newHiq });
          continue;
        }

        const wouldBe = { ...stripSystem(sale), hobbyiqCardId: plan.newHiq };
        const verdict = guardSoldCompDoc(wouldBe, { guardedBy: "repoint-sales-to-sibling-product" });
        if (verdict.verdict === "park" && verdict.reason === "malformed-key") {
          noteRefusal("guard-parked", `  ${sale.id}@${sale.cardId}: ${verdict.detail ?? verdict.reason}`);
          emitPlanRow(sale, "refused", "guard-parked", { from, to, toId: plan.newHiq });
          continue;
        }

        if (APPLY) {
          try {
            await retry(() => pool.item(sale.id, sale.cardId).patch([
              { op: "set", path: "/hobbyiqCardId", value: plan.newHiq },
              { op: "set", path: "/reslugedFrom", value: fromSlug },
              { op: "set", path: "/reslugedReason", value: `card number lives under the sibling product ${to}, not ${from} (repoint-sales-to-sibling-product)` },
              { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
            ], { accessCondition: { type: "IfMatch", condition: fresh._etag } }));
          } catch (e) {
            if (is412(e)) {
              noteRefusal("stale-since-plan", `  ${sale.id}@${sale.cardId} (hobbyiqCardId=${fromSlug}): patch refused (412) -- source changed between the last-line re-read and the patch itself`);
              emitPlanRow(sale, "refused", "stale-since-plan", { from, to, toId: plan.newHiq });
              continue;
            }
            throw e;
          }
        }
        s.salesPatched++;
        bump(byPair, pairLabel);
        bump(fromToPairs, `${fromSlug}${ROLLUP_DELIM}${plan.newHiq}`);
        if (examples.length < 24) examples.push(`  PATCH ${sale.id}@${sale.cardId} hobbyiqCardId ${fromSlug} -> ${plan.newHiq}`);
        emitPlanRow(sale, "patch", null, { from, to, toId: plan.newHiq, destinationRowId: plan.targetRow?.id ?? null, destinationRowPlayer: plan.targetRow?.playerName ?? null, destinationRowSource: plan.targetRow?.source ?? null });
      } catch (e) {
        s.salesFailed++;
        failures.push(`  FAILED ${plan.action} ${sale.id}@${sale.cardId}: ${String(e?.stack ?? e?.message ?? e)}`);
        emitPlanRow(sale, "failed", String(e?.message ?? e), { from, to });
      }
    }
  }

  /** Shared-cursor worker pool -- the same idiom rematch-sold-comps.cjs and
   *  both sibling lanes use. Each worker CLAIMS its index before doing
   *  anything, so every unit is claimed exactly once. */
  async function runPool(units, worker) {
    let idx = 0;
    const run = async () => { while (idx < units.length) { const my = idx++; await worker(units[my]); } };
    const lanes = Math.min(CONCURRENCY, Math.max(units.length, 1));
    await Promise.all(Array.from({ length: lanes }, run));
  }

  const units = [];
  for (const cell of SCOPE_CELLS) {
    const [sport, yearStr] = cell.split(":");
    for (const pair of SIBLING_PAIRS) units.push({ sport, year: Number(yearStr), pair });
  }
  s.cellsScanned = SCOPE_CELLS.length;
  await runPool(units, async (u) => { await processPair(u.sport, u.year, u.pair); });

  console.log("");
  console.log(`catalog checklist rows scanned      ${f(s.catalogRowsScanned)}`);
  console.log(`  strict FROM-product rows loaded   ${f(s.fromChecklistRows)}`);
  console.log(`  strict TO-product rows loaded     ${f(s.toChecklistRows)}   <- incl. registered inserts whose parent is TO`);
  console.log("");
  console.log(`sales scanned (in shape, in scope)  ${f(s.salesScanned)}${SHARD_SCOPE.SHARDED ? `  (${f(s.otherShard)} in other shards)` : ""}`);
  console.log(`  rows whose slug did not parse to this cell+setKey  ${f(s.salesOutOfShape)}   <- never counted as scanned`);
  console.log(`  ${APPLY ? "RELOCATED" : "WOULD RELOCATE"}     ${f(s.salesMoved)}   <- cardId AND hobbyiqCardId move (shape 1/3/4)`);
  console.log(`  ${APPLY ? "PATCHED" : "WOULD PATCH"}       ${f(s.salesPatched)}   <- hobbyiqCardId only, vendor cardId untouched (shape 2)`);
  console.log(`  COLLAPSED onto a resident (same sale, by hash)  ${f(s.collapsedOntoResident)}`);
  console.log("");
  console.log(`  REFUSED: number-exists-in-from-product   ${f(s.refusedNumberExistsInFrom)}   <- the FROM product's checklist DOES list this number; not this lane's row`);
  console.log(`  REFUSED: destination-rung-not-on-checklist ${f(s.refusedDestinationRung)}   <- the TO product never attests this (number, parallel, auto) rung; never invent a rung`);
  console.log(`  REFUSED: different-player                ${f(s.refusedDifferentPlayer)}   <- the destination roster names somebody else, or the title contradicts the row`);
  console.log(`  REFUSED: title-names-from-product        ${f(s.refusedTitleNamesFromProduct)}   <- the title names the FROM product (or its own sub-identity), contradicting the move`);
  console.log(`  REFUSED: split-identity                  ${f(s.refusedSplitIdentity)}   <- cardId and hobbyiqCardId already name two different cards; not this lane's to arbitrate (#2339)`);
  console.log(`  REFUSED: possible-twin-at-destination    ${f(s.refusedPossibleTwin)}   <- a DIFFERENT sale already resides at the destination; neither moved, nothing deleted on a guess`);
  console.log(`  REFUSED: pinned-or-verified              ${f(s.refusedPinnedOrVerified)}   <- verifiedByUser / a user-seed source`);
  console.log(`  REFUSED: flagged-or-excluded             ${f(s.refusedFlaggedOrExcluded)}   <- flaggedWrong / excludedFromFmv`);
  console.log(`  REFUSED: already-parked                  ${f(s.refusedAlreadyParked)}   <- identityUnverified=true; unparking is a different lane`);
  console.log(`  REFUSED: guard-parked (malformed key)    ${f(s.refusedGuardParked)}`);
  console.log(`  REFUSED: stale-since-plan                ${f(s.refusedEtagChanged)}   <- source doc changed or vanished between plan and write`);
  console.log(`  failed                                  ${f(s.salesFailed)}`);
  console.log(`  not reached (budget / LIMIT)            ${f(s.notReached)}`);

  console.log("");
  console.log(`  sales queries issued (one per cell+pair)  ${f(s.salesQueries)}`);
  console.log(`    p50 ${percentile(salesQueryMs, 50)}ms   p95 ${percentile(salesQueryMs, 95)}ms`);
  s.throttled = THROTTLE_COUNT;
  console.log(`  throttled (429/503/timeout retries across all workers)  ${f(s.throttled)}   <- concurrency ${CONCURRENCY}`);
  console.log(`  RU charge (total, as reported by the SDK)  ${s.ruCharge.toFixed(2)}`);

  // Every sample list is sorted before printing, so REPORT and APPLY (and two
  // runs at different CONCURRENCY values) print the SAME lines in the SAME
  // order for the same fixture -- only counts and the set of lines are
  // meaningful, never arrival order.
  const sorted = (arr) => [...arr].sort();
  if (byPair.size) {
    console.log(`\n  by sibling pair:`);
    for (const [k, n] of [...byPair.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) console.log(`    ${String(n).padStart(9)}  ${k}`);
  }
  if (fromToPairs.size) {
    console.log(`\n  top ${Math.min(30, fromToPairs.size)} (from id -> to id) pairs by count:`);
    const top = [...fromToPairs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30);
    for (const [k, n] of top) {
      const [fromId, toId] = k.split(ROLLUP_DELIM);
      console.log(`    ${String(n).padStart(9)}  ${fromId} -> ${toId}`);
    }
  }
  if (examples.length) { console.log(`\n  examples:`); for (const e of sorted(examples)) console.log(e); }
  if (collapsedExamples.length) { console.log(`\n  COLLAPSED onto a resident (sample, ${f(s.collapsedOntoResident)} total):`); for (const e of sorted(collapsedExamples)) console.log(e); }

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

  if (planFd) {
    console.log("");
    console.log(`  plan rows written  ${f(planRowsWritten)}  (one NDJSON record per in-scope row)`);
    console.log(`  plan covers THIS run only -- a relaunched slot's full plan = every run in its chain (each relaunch uploads its OWN run-id-scoped artifact)`);
    try { fs.closeSync(planFd); } catch { /* best effort */ }
  } else if (PLAN_OUT) {
    console.log(`\n  ::warning::PLAN_OUT was set but no plan file was opened -- see the warning above.`);
  }

  // ── CF-A-SALE-IS-NEVER-LOST reconciliation --------------------------------
  // Every sale this run SCANNED is moved, patched, collapsed, refused by one
  // NAMED class, failed, or left with a reason accounted above. `collapsed`
  // counts with `written`: the from-side copy is RESOLVED (deleted once the
  // resident is proven the same sale), even though the resident itself was
  // not created by this run.
  const written = s.salesMoved + s.salesPatched + s.collapsedOntoResident;
  const refused = s.refusedNumberExistsInFrom + s.refusedDestinationRung + s.refusedDifferentPlayer
    + s.refusedTitleNamesFromProduct + s.refusedSplitIdentity + s.refusedPossibleTwin
    + s.refusedPinnedOrVerified + s.refusedFlaggedOrExcluded + s.refusedAlreadyParked
    + s.refusedGuardParked + s.refusedEtagChanged;
  const left = s.salesScanned - written - refused - s.salesFailed;
  console.log("");
  console.log(`CF-A-SALE-IS-NEVER-LOST`);
  console.log(`  sales scanned              ${f(s.salesScanned)}`);
  console.log(`  ${APPLY ? "=" : "would be ="} moved ${f(s.salesMoved)} + patched ${f(s.salesPatched)} + collapsed ${f(s.collapsedOntoResident)} + refused ${f(refused)} + failed ${f(s.salesFailed)} + left ${f(left)}`);
  const accountedFor = written + refused + s.salesFailed + left;
  if (accountedFor !== s.salesScanned) {
    console.error(`!! CF-A-SALE-IS-NEVER-LOST: accounted ${f(accountedFor)} != scanned ${f(s.salesScanned)}. A sale is unaccounted for. Exit 4.`);
    process.exitCode = 4;
  } else {
    console.log(`  matched -- every scanned sale is moved, patched, collapsed, refused (named), failed (named), or left with a reason accounted above.`);
  }

  if (APPLY) {
    reportWrites({
      job: "repoint-sales-to-sibling-product",
      intended: s.salesScanned,
      written,
      skipped: left,
      refused,
      failed: s.salesFailed,
    });
  }

  console.log("");
  console.log(`  ${APPLY ? "RELOCATED" : "WOULD RELOCATE"} ${f(s.salesMoved)}   ${APPLY ? "PATCHED" : "WOULD PATCH"} ${f(s.salesPatched)}`);
  if (stoppedAtBudget || CLOCK.outOfClock()) {
    console.log(`  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the slot has more to do`);
  }
  if (!APPLY) console.log(`\nREPORT ONLY -- nothing was written. Re-run with BACKFILL_APPLY=true to apply.`);

  if (s.salesFailed) {
    console.error(`::error::${f(s.salesFailed)} sale(s) failed -- see FAILURES above.`);
    process.exitCode = 4;
  }
}

module.exports = {
  parseSiblingPairs, planSiblingMove, classifySaleForSiblingMove,
  numberExistsInFromProduct, destinationRowsForNumber, rowsAtDestinationRung,
  withLeadingZeroFold, catalogRowPlayerKeys, playerMatchesRow,
  forbiddenFragmentsFor, PAIR_TITLE_RULES,
  USER_SEED_SOURCES, INHERITED_SCOPES, CELL_RE, WILDCARDS,
  checklistSpec, salesSpec,
};

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); await finishLane(1, { budget: CLOCK }); });
}
