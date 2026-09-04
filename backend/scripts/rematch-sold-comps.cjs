#!/usr/bin/env node
/**
 * rematch-sold-comps.cjs -- the GREAT REMATCH. Every sale in sold_comps sits
 * under the identity today's parser and catalog would give it, or it is
 * reported to Drew and left exactly where it is.
 *
 * CF-A-REMATCH-IS-A-DIFF-BEFORE-IT-IS-A-WRITE (Drew, 2026-09-01). This
 * supersedes the one-defect-one-lane era for POOL IDENTITY: instead of a
 * script per defect shape, one census re-derives every row's identity from its
 * OWN title plus its stored raw fields, through parseTitleIdentity +
 * ingestGradeFromTitle + the catalog-first matcher, and diffs the result
 * against the key the row carries. The classifier is scripts/lib/
 * rematch-classify.cjs and is pure; this file is paging, I/O and the banner.
 *
 * TWO MODES, ONE SELECTOR
 *
 *   MODE=census        READ ONLY. Pages the shard, classifies every row
 *                      AGREE / IMPROVE / CONFLICT / UNDERIVABLE with a
 *                      provenance tier, prints the census banner, and writes a
 *                      machine-readable shard census JSON for the artifact
 *                      step (falls back to a parseable CENSUS_JSON line).
 *                      Touches nothing, ever -- there is no write path in this
 *                      mode at all, not even behind APPLY.
 *   MODE=apply-improve Re-reads the shard and applies ONLY IMPROVE-class,
 *                      AUTO-tier rows AND the BASE-EVICTION subclass of
 *                      CONFLICT, through scripts/lib/relocate-sold-comp
 *                      .cjs so contentHash + provenance handling stays in ONE
 *                      place. Only-improve is RE-CHECKED at write time,
 *                      because the pool moves between the census and the
 *                      apply: a row that a concurrent ingest has since made
 *                      more specific is skipped, not overwritten.
 *
 * WHAT NEVER WRITES, EVER
 *
 *   CONFLICT      a different reading, not a more specific one. To Drew --
 *                 EXCEPT the BASE-EVICTION subclass below.
 *   UNDERIVABLE   the title yields nothing that passes the slug guard.
 *   PROTECTED     ebay-user-purchase / ebay-user-sale / ebay-account /
 *                 manual-user-entry, any Drew ruling or hand/D31 relocation
 *                 marker, anything verifiedByUser. Report-only FOREVER, even
 *                 when the row is IMPROVE-shaped OR BASE-EVICTION-shaped.
 *                 Measured 2026-09-01: 160 user-sourced rows, 53 D19
 *                 relocations, 800 verified.
 *
 * THE BASE-EVICTION SUBCLASS (Drew 2026-09-02)
 *
 * One shape inside CONFLICT is not two rival readings of a card: a row filed
 * on a parallel slug (`...:refractor:...`) whose own stored parallel field
 * says Base/blank and whose title names no finish, where a checklist-backed
 * BASE destination exists. Three independent fields agree that the row names
 * no parallel; only the slug disagrees, and a slug is an artifact of whichever
 * writer keyed the row. This script computes the base destination (the derived
 * identity with parallel forced to Base and the print run dropped), verifies
 * it is checklist-backed exactly as IMPROVE's destination is, and hands all
 * three fields to the classifier, which decides. The subclass rides the SAME
 * trust ladder as IMPROVE -- per-shard 500-row audit plus rematch-canary-check
 * before that shard's apply -- and the residual risk (a seller omitting
 * "Refractor" on a genuine parallel) is what the audit is for.
 *
 * THE APPLY IS GATED TWICE, OUTSIDE THIS SCRIPT
 *
 *   1. a 500-row sample audit of THAT shard's IMPROVE bucket comes back clean
 *   2. rematch-canary-check.cjs shows zero regressions on the hand-verified
 *      pools, before and after
 * Neither gate lives in this file -- a script cannot certify itself. The
 * sequence is documented in rematch-canary-check.cjs's header and in the
 * dispatch plan; this script only refuses to write anything but clean classes.
 *
 * THE SHARD AXIS IS MEASURED, NOT ASSUMED
 *
 * GROUP BY cardYear over the live pool, 2026-09-01: 16,336,293 rows in 136
 * year buckets, and FOUR years blow past any even share -- 2024 = 2,711,283,
 * 2025 = 2,629,991, 2023 = 1,457,497, 2026 = 1,268,434, against an even
 * 32-slot share of 510,509. Year alone is not an axis; it is a 6.6x spread.
 *
 * So the axis is composite, in three levels, each used only when the level
 * above is still too big:
 *   1. cardYear           every year that fits inside a share rides whole
 *   2. + sport class      the four heavy years split baseball / football /
 *                         basketball / pokemon / other (2025 baseball alone is
 *                         1,262,342 -- 2.5x a share on its own)
 *   3. + sha1(id) % parts a unit still over a share splits into hash parts,
 *                         which are uniform by construction
 * That yields 158 units packed into 32 slots at min 497,602 / max 532,572 --
 * a 1.07x spread. SHARD_TABLE below IS that packing, encoded, and the banner
 * echoes this slot's units and their measured row counts. A slot's rows are
 * its own; slots never overlap, so 32 dispatches need no coordination.
 *
 * Env: COSMOS_CONNECTION_STRING (required)
 *      MODE=census | apply-improve          (REQUIRED, no default)
 *      SLOT / SLOTS                          which slice (default 0 / 32)
 *      BACKFILL_APPLY=true                   write (apply-improve only)
 *      BACKFILL_CONCURRENCY                  parallel relocates (default 8)
 *      RUN_MINUTES=140                       budget marker under the step's 150
 *      LIMIT                                 cap rows read (0 = the whole slot)
 *      YEARS                                 narrow to these years inside the slot
 *      CENSUS_OUT                            where the shard census JSON lands
 * Requires dist/ (parseTitleIdentity, hobbyIqCardId, slugGuard,
 * persistVendorSalesToPool, writeReconciliation).
 */
"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));
const K = require(path.join(__dirname, "lib", "rematch-classify.cjs"));

const MODE = String(process.env.MODE || "").trim();
const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true"; // the runner exports BACKFILL_APPLY, not APPLY
const SLOT = Number(process.env.SLOT || 0), SLOTS = Number(process.env.SLOTS || 32);
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 140);
const LIMIT = Number(process.env.LIMIT || 0);
const YEARS = String(process.env.YEARS || "").split(",").map((s) => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
const CENSUS_OUT = String(process.env.CENSUS_OUT || "/tmp/rematch-census").trim();
/**
 * THE AUDIT SAMPLE IS 500 ROWS, SPREAD ACROSS DISTINCT CARDS (audit finding 7).
 *
 * This was 30, so the "500-row sample audit" the trust ladder is defined
 * around was arithmetically impossible -- and the 30 that were kept were the
 * first 30 in COSMOS PAGE ORDER, which is partition order, which is card
 * order. Slot 27's sample was 23 of 30 lines from one single card. A sample
 * that is one card is not a sample of a shard.
 *
 * 500, and one reservoir PER cardId rather than one for the whole class, so
 * the lines the auditor reads span the shard's cards instead of its first
 * partition. `sampleLine` below implements it.
 */
const SAMPLE_CAP = Number(process.env.SAMPLE_CAP || 500);
/** At most this many lines from any ONE card, so no single pool can crowd the
 *  sample the way slot 27's did. 500 / 4 still leaves room for 125 cards. */
const SAMPLE_PER_CARD_CAP = Math.max(1, Number(process.env.SAMPLE_PER_CARD_CAP || 4));

const f = (n) => Number(n ?? 0).toLocaleString();
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };
const hashPartOf = (id, parts) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % parts;

// ── the measured shard table ───────────────────────────────────────────────
// Built by GROUP BY over the live pool 2026-09-01 and packed longest-first
// into 32 bins. `rows` is the MEASURED count for that unit at capture time --
// it is the banner's expectation, never a gate (ingest legitimately adds rows).
// A unit is { year, sportClass, hashPart, hashParts, rows }: sportClass null
// means the whole year, hashPart null means the whole unit.
const SPORT_CLASSES = ["baseball", "football", "basketball", "pokemon"];
const SHARD_TABLE = require(path.join(__dirname, "..", "data", "rematch-shard-table.json"));

/** The units this slot owns. */
function unitsForSlot(slot, table = SHARD_TABLE) {
  const row = (table.slots ?? []).find((s) => Number(s.slot) === Number(slot));
  return row ? row.units : [];
}

/** A Cosmos predicate + params for one unit. `sportClass: "other"` is every
 *  sport OUTSIDE the four named classes, which is why it is a NOT IN. */
function unitPredicate(unit, i) {
  const params = [];
  const parts = [];
  // `absent` and `null` are TWO populations, not one: 49 rows carry no
  // cardYear field and 4,017 carry an explicit null (measured 2026-09-01).
  // They need two different predicates, and folding them together made two
  // slots claim the same rows -- a slice that is not a slice.
  if (unit.yearKind === "absent") parts.push("NOT IS_DEFINED(c.cardYear)");
  else if (unit.yearKind === "null") parts.push("IS_NULL(c.cardYear)");
  else { parts.push(`c.cardYear = @y${i}`); params.push({ name: `@y${i}`, value: Number(unit.year) }); }
  if (unit.sportClass) {
    if (unit.sportClass === "other") {
      const names = SPORT_CLASSES.map((s, j) => { params.push({ name: `@sc${i}_${j}`, value: s }); return `@sc${i}_${j}`; });
      parts.push(`(NOT IS_DEFINED(c.sport) OR NOT (c.sport IN (${names.join(", ")})))`);
    } else { parts.push(`c.sport = @s${i}`); params.push({ name: `@s${i}`, value: unit.sportClass }); }
  }
  return { where: `(${parts.join(" AND ")})`, params };
}

/** The whole slot as ONE query, plus the in-code hash filter the third axis
 *  needs (a hash cannot be expressed in SQL, so it is applied on read -- the
 *  unit is already small enough that this costs a fraction of a share). */
function slotQuery(units, years = YEARS) {
  // A YEARS filter names real years, so it never selects the absent/null
  // units -- those are reached only by running the slot unscoped.
  const scoped = years.length ? units.filter((u) => u.yearKind === "value" && years.includes(Number(u.year))) : units;
  if (!scoped.length) return null;
  const wheres = [], params = [];
  scoped.forEach((u, i) => { const p = unitPredicate(u, i); wheres.push(p.where); params.push(...p.params); });
  return { query: `SELECT * FROM c WHERE ${wheres.join(" OR ")}`, parameters: params, units: scoped };
}

/** Does this row belong to this slot's hash part? Units without a hash part
 *  take every row that matched their year/sport predicate. */
function rowInSlot(row, units) {
  for (const u of units) {
    // `Number(null) === 0` and the pool really does hold a `cardYear: 0` unit
    // (2 rows), so a null-year row would silently match it. Null and undefined
    // are rejected BEFORE the numeric compare or the axis stops being disjoint.
    const yearOk = u.yearKind === "absent" ? row.cardYear === undefined
      : u.yearKind === "null" ? row.cardYear === null
      : row.cardYear !== null && row.cardYear !== undefined && Number(row.cardYear) === Number(u.year);
    if (!yearOk) continue;
    if (u.sportClass) {
      const sport = String(row.sport ?? "").toLowerCase();
      const named = SPORT_CLASSES.includes(sport);
      if (u.sportClass === "other" ? named : sport !== u.sportClass) continue;
    }
    if (u.hashParts && u.hashParts > 1 && hashPartOf(row.id, u.hashParts) !== u.hashPart) continue;
    return true;
  }
  return false;
}

// ── derivation: the row's own title + stored fields, through today's parser ──

/** The identity the row CARRIES today, read from its own stored fields. */
function storedIdentity(row, deps) {
  return {
    sport: row.sport ?? null,
    cardYear: row.cardYear ?? null,
    setKey: row.setName ? deps.normalizeSetKey(String(row.setName)) : "",
    cardNumber: row.cardNumber ?? null,
    parallel: row.parallel ?? null,
    isAuto: row.isAuto === true,
    printRun: row.printRun ?? null,
    gradeCompany: row.gradeCompany ?? null,
    gradeValue: row.gradeValue ?? null,
  };
}

/**
 * The identity today's parser + matcher produce for this row. Returns
 * { ok, identity, slug, reasons }.
 *
 * The title is the evidence; the stored raw fields fill only what the title
 * does not say. A blank title cannot be re-derived -- absent beats wrong.
 * The slug guard is the same one the live writers use, so a derivation this
 * function accepts is one the pool would accept from an ingest today.
 */
function deriveIdentity(row, deps) {
  const title = String(row.title ?? "").trim();
  if (!title) return { ok: false, reasons: ["no-title"] };

  const parsed = deps.parseListingIdentity(title, undefined, {
    vertical: row.sport ?? null,
    hobbyiqCardId: row.hobbyiqCardId ?? row.cardId ?? null,
  });
  // Grade lives in the fields AND the child slug. ingestGradeFromTitle is the
  // one reader the write path uses; a title stating no grade yields RAW, which
  // is an answer -- but it must never demote a row that STORES a grade, so the
  // stored grade wins when the title is silent.
  const g = deps.ingestGradeFromTitle(title);
  const gradeCompany = g.gradeCompany ?? row.gradeCompany ?? null;
  const gradeValue = g.gradeValue ?? (g.gradeCompany ? null : row.gradeValue ?? null);

  const sportRaw = deps.inferSportFromTitle(title, "");
  const sport = deps.normalizeSportStrict(sportRaw) ?? deps.normalizeSportStrict(row.sport);
  const cardYear = deps.extractYearFromTitle(title) ?? (row.cardYear ?? null);
  const cardNumber = parsed.cardNumber ?? row.cardNumber ?? "";
  const setKeyRaw = deps.inferSetKeyFromTitle(title, cardNumber) || row.setName || "";
  const setKey = deps.normalizeSetKey(setKeyRaw);

  // CF-BOWMAN-DEFAULT-NOT-EVIDENCE + CF-UNKNOWN-IS-ALSO-A-GUESS: the parser's
  // fallbacks are guesses, not readings, and a guess that passes the guard is
  // a confident wrong slug -- exactly what this census exists to find, not to
  // create. Both stay UNDERIVABLE for a later pass with a better vocabulary.
  if (setKey.startsWith("bowman") && !/bowman/i.test(title)) return { ok: false, reasons: ["setkey-bowman-default-unsupported"] };
  if (setKey === "unknown" || setKey === "") return { ok: false, reasons: ["setkey-unknown-unsupported"] };

  const guard = deps.guardSlugInputs({ sport, year: cardYear, normalizedSetKey: setKey, cardNumber, playerName: row.playerName ?? null });
  if (!guard.ok) return { ok: false, reasons: guard.reasons.map((r) => `guard:${r}`) };

  const isAuto = parsed.isAuto || row.isAuto === true;
  // THE ONE THING THAT LEGITIMATELY MAKES A ROW AN AUTO.
  //
  // parseListingIdentity ORs a title-word reader with the cardNumber reader
  // and returns one flag, so by the time it lands here the evidence is gone.
  // The census reported 33,283 rows flipped no-auto -> auto, 100% of them on
  // the title word alone -- a cut signature mounted with a base card reads
  // "PSA AUTHENTIC AUTO" and is still a base card. Carry the cardNumber
  // verdict out separately so the classifier can tell the two apart.
  const autoByCardNumber = deps.isCardNumberAutoSubset ? !!deps.isCardNumberAutoSubset(cardNumber) : false;
  const parallel = parsed.parallel || row.parallel || "Base";
  const printRun = parsed.printRun ?? row.printRun ?? null;
  const identity = { sport: guard.sport, cardYear, setKey, setNameRaw: setKeyRaw, cardNumber, parallel, isAuto, printRun, gradeCompany, gradeValue };
  const slug = deps.computeHobbyIqCardId({
    sport: guard.sport, year: cardYear, setKey: setKeyRaw, cardNumber, parallel, isAuto, printRun,
    playerName: row.playerName ?? null, gradeCompany, gradeValue,
  });

  // The BASE destination for this same card: the identity as derived, with the
  // parallel forced to Base and the print run dropped. A parallel's print run
  // belongs to the parallel -- a base card that is not serial-numbered must not
  // carry `/499` to its base slug, or the eviction lands on a slug that names a
  // numbered base card the checklist may never list. Everything else (set,
  // number, auto flag, grade) is the row's own and travels unchanged.
  const baseSlug = deps.computeHobbyIqCardId({
    sport: guard.sport, year: cardYear, setKey: setKeyRaw, cardNumber, parallel: "Base", isAuto,
    printRun: null, playerName: row.playerName ?? null, gradeCompany, gradeValue,
  });
  const baseIdentity = { ...identity, parallel: "Base", printRun: null };
  return { ok: true, identity, slug, baseSlug, baseIdentity, autoByCardNumber, reasons: [] };
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  if (MODE !== "census" && MODE !== "apply-improve") {
    console.error(`FATAL: MODE is required and has no default -- 'census' (read only) or 'apply-improve'. Got ${JSON.stringify(MODE)}.`);
    process.exit(2);
  }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!Number.isFinite(SLOT) || !Number.isFinite(SLOTS) || SLOT < 0 || SLOT >= SLOTS) {
    console.error(`FATAL: SLOT must be 0..${SLOTS - 1}; got SLOT=${SLOT} SLOTS=${SLOTS}`); process.exit(2);
  }
  if (SLOTS !== SHARD_TABLE.slots.length) {
    console.error(`FATAL: SLOTS=${SLOTS} but the measured shard table has ${SHARD_TABLE.slots.length} slots. The table IS the axis -- re-measure before changing it.`);
    process.exit(2);
  }
  const units = unitsForSlot(SLOT);
  if (!units.length) { console.error(`FATAL: slot ${SLOT} owns no units in the measured table.`); process.exit(2); }
  const q = slotQuery(units);
  if (!q) { console.log(`slot ${SLOT} has no units matching YEARS=${YEARS.join(",")} -- nothing to do.`); return; }

  const backend = path.resolve(__dirname, "..");
  const d = (p) => require(path.join(backend, "dist", "services", ...p));
  const pti = d(["portfolioiq", "parseTitleIdentity.service.js"]);
  const hic = d(["portfolioiq", "hobbyIqCardId.service.js"]);
  const guard = d(["portfolioiq", "slugGuard.service.js"]);
  const pvs = d(["portfolioiq", "persistVendorSalesToPool.service.js"]);
  const slugRe = d(["portfolioiq", "slugRederivation.service.js"]);
  const { reportWrites } = d(["ops", "writeReconciliation.js"]);
  const deps = {
    parseListingIdentity: pti.parseListingIdentity,
    // isAuto's boundary is the CARD NUMBER, never title text
    // (CF-ISAUTO-BOUNDARY-IS-CARDNUMBER). The classifier needs this verdict
    // separately from parseListingIdentity's OR'd `isAuto`, because that OR
    // is exactly what the D7 guard has to be able to see through.
    isCardNumberAutoSubset: pti.isCardNumberAutoSubset,
    inferSetKeyFromTitle: pti.inferSetKeyFromTitle,
    inferSportFromTitle: pti.inferSportFromTitle,
    ingestGradeFromTitle: pvs.ingestGradeFromTitle,
    normalizeSetKey: hic.normalizeSetKey,
    computeHobbyIqCardId: hic.computeHobbyIqCardId,
    guardSlugInputs: guard.guardSlugInputs,
    normalizeSportStrict: guard.normalizeSportStrict,
    extractYearFromTitle: slugRe.extractYearFromTitle,
  };

  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const pool = db.container("sold_comps"), cat = db.container("card_catalog");

  const expected = units.reduce((a, u) => a + Number(u.rows ?? 0), 0);
  console.log(`rematch-sold-comps  MODE=${MODE}  ${MODE === "census" ? "READ ONLY" : APPLY ? "APPLY" : "REPORT ONLY"}  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m  limit ${LIMIT || "none"}`);
  console.log(`  shard axis: (cardYear, sportClass, sha1(id) % parts) -- measured ${SHARD_TABLE.measuredAt}, ${f(SHARD_TABLE.totalRows)} rows in ${SHARD_TABLE.slots.length} slots, spread ${SHARD_TABLE.spread}`);
  console.log(`  this slot owns ${q.units.length} unit(s), ${f(expected)} rows measured at capture:`);
  for (const u of q.units) console.log(`    ${String(u.key).padEnd(28)} ${f(u.rows).padStart(11)}`);
  if (YEARS.length) console.log(`  YEARS filter: ${YEARS.join(",")}`);

  // ── checklist backing, cached per slug ────────────────────────────────────
  // A match proves nothing unless checklist-backed. The catalog row's SOURCE
  // is the evidence: a checklist ingest, never a vendor row.
  const CHECKLIST_SOURCE_RE = /checklist|beckett|tcdb|insider|bcp|baseballcardpedia|tcgdex/i;
  const backedCache = new Map();
  const checklistBacked = async (slug) => {
    if (!slug) return false;
    if (backedCache.has(slug)) return backedCache.get(slug);
    let backed = false;
    try {
      const { resource } = await retry(() => cat.item(slug, slug).read());
      if (resource) {
        const src = String(resource.source ?? resource.sourceSystem ?? "");
        const sources = Array.isArray(resource.sources) ? resource.sources.join(",") : "";
        backed = CHECKLIST_SOURCE_RE.test(src) || CHECKLIST_SOURCE_RE.test(sources) || resource.checklistBacked === true;
      }
    } catch (e) { if (e?.code !== 404 && e?.statusCode !== 404) throw e; }
    backedCache.set(slug, backed);
    return backed;
  };

  // ── page the shard ────────────────────────────────────────────────────────
  const counts = { [K.AGREE]: 0, [K.IMPROVE]: 0, [K.CONFLICT]: 0, [K.UNDERIVABLE]: 0 };
  const byTier = new Map(), defects = new Map(), reasons = new Map(), samples = new Map(), subclasses = new Map();
  // SPLIT-IDENTITY tallies, kept beside the class counts rather than inside
  // them: a row is split OR NOT independently of which class it landed in.
  const splitByClass = new Map(), splitSegments = new Map(), splitSamples = [];
  let splitTotal = 0;
  const stats = { seen: 0, otherSlot: 0, intended: 0, written: 0, skipped: 0, failed: 0, duplicatesLeft: 0, alreadyGone: 0, notReached: 0 };
  const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

  /**
   * THE SAMPLE IS A RESERVOIR PER cardId, NOT THE FIRST N ROWS (finding 7).
   *
   * Cosmos returns a shard in partition order, so "the first 30" was "the
   * first two or three cards" -- slot 27's sample was 23 of 30 lines from a
   * single card, and an auditor reading it learned about one pool. A per-card
   * reservoir spends the 500 lines across distinct cardIds instead: each card
   * contributes at most SAMPLE_PER_CARD_CAP lines, and once a class is full,
   * a NEW card still displaces a line from the most over-represented card
   * seen so far. So a shard with 500+ distinct cards yields ~500 distinct
   * cards, and one with few cards degrades to an even spread over what exists.
   *
   * `sampleCards` tracks, per class, how many lines each cardId holds.
   */
  const sampleCards = new Map();   // klass -> Map(cardId -> line count)
  const sample = (klass, cardId, line) => {
    if (!samples.has(klass)) { samples.set(klass, []); sampleCards.set(klass, new Map()); }
    const arr = samples.get(klass);
    const perCard = sampleCards.get(klass);
    const key = String(cardId ?? "");
    const mine = perCard.get(key) ?? 0;
    if (mine >= SAMPLE_PER_CARD_CAP) return;          // this card has had its share
    if (arr.length < SAMPLE_CAP) {
      arr.push({ cardId: key, line });
      perCard.set(key, mine + 1);
      return;
    }
    // Full. A card not yet represented displaces a line from whichever card
    // holds the most -- that is what keeps the tail of the shard reachable
    // instead of the sample being decided by the first page.
    if (mine > 0) return;
    let worstCard = null, worstN = 1;
    for (const [c, n] of perCard) if (n > worstN) { worstCard = c; worstN = n; }
    if (!worstCard) return;                            // already one line per card
    const idx = arr.findIndex((e) => e.cardId === worstCard);
    if (idx < 0) return;
    arr[idx] = { cardId: key, line };
    perCard.set(worstCard, worstN - 1);
    perCard.set(key, 1);
  };
  /** The census JSON and the banner both want plain lines. */
  const sampleLines = (klass) => (samples.get(klass) ?? []).map((e) => e.line);
  /** How many DISTINCT cards a class's sample actually spans -- the number
   *  that says whether finding 7 is fixed, printed in the banner and carried
   *  in the census JSON so the audit gate can assert on it. */
  const sampleCardCount = (klass) => (sampleCards.get(klass) ?? new Map()).size;

  const it = pool.items.query(q, { maxItemCount: 500 });
  const improvable = [];
  let stopReason = null;
  page: while (it.hasMoreResults()) {
    if (budgetLeft() < 90000) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget`; break; }
    const { resources } = await retry(() => it.fetchNext());
    for (const row of resources ?? []) {
      if (!rowInSlot(row, q.units)) { stats.otherSlot++; continue; }
      if (LIMIT && stats.seen >= LIMIT) { stopReason = stopReason ?? `stopped at the LIMIT of ${f(LIMIT)} rows`; break page; }
      stats.seen++;
      const stored = storedIdentity(row, deps);
      const der = deriveIdentity(row, deps);
      const backed = der.ok ? await checklistBacked(der.slug) : false;
      // The base destination is only ever LOOKED UP for a row that could
      // possibly be an eviction -- its slug must already name a parallel.
      // Without this, every one of the shard's rows costs a second catalog
      // read for a question that was answered by its own slug.
      const beCandidate = der.ok && K.slugNamesParallel(row.cardId);
      const baseBacked = beCandidate ? await checklistBacked(der.baseSlug) : false;
      const res = K.classifyRow({
        row, stored, derived: der.ok ? der.identity : null, checklistBacked: backed, derivationReasons: der.reasons,
        storedSlug: row.cardId, baseDestSlug: der.baseSlug ?? null, baseDestBacked: baseBacked,
        autoByCardNumber: der.autoByCardNumber === true,
      });
      counts[res.klass]++;
      // THE SPLIT-IDENTITY SIGNAL, tallied ACROSS classes (Drew 2026-09-02).
      // The row's own two identity fields disagree, which the exact pool
      // reader turns into one sale priced into two cards. It is orthogonal to
      // the derivation class -- most split rows classify AGREE -- so it is
      // counted per class as well as in total, or the AGREE-shaped majority
      // would never appear in this banner at all.
      if (res.splitIdentity) {
        splitTotal++;
        bump(splitByClass, `${res.klass}/${res.splitClass}`);
        for (const seg of res.splitSegments ?? []) bump(splitSegments, seg);
        if ((splitSamples.length) < SAMPLE_CAP) {
          splitSamples.push(`${row.id}  [${res.klass}/${res.tier}]  ${row.cardId}  ||  ${row.hobbyiqCardId}${res.splitSegments?.length ? `  [${res.splitSegments.join(",")}]` : ""}`);
        }
      }
      if (res.subclass) bump(subclasses, `${res.klass}/${res.subclass}/${res.tier}`);
      bump(byTier, `${res.klass}/${res.tier}`);
      for (const a of K.defectAxes(res)) bump(defects, `${res.klass}  ${a}`);
      for (const r of res.reasons) bump(reasons, `${res.klass}  ${r}`);
      const sampleKey = res.subclass ? `${res.klass}/${res.subclass}` : res.klass;
      // The reservoir decides admission itself (per-card caps and displacement),
      // so it is called for EVERY row rather than only while the class is short
      // -- a length check here is what made the sample the first page.
      sample(sampleKey, row.cardId, `${row.id}  [${res.tier}]  "${String(row.title ?? "").slice(0, 68)}"  ${K.renderIdentity(stored)}  ->  ${K.renderIdentity(res.subclass === K.BASE_EVICTION ? der.baseIdentity : der.ok ? der.identity : null)}`);
      if (MODE === "apply-improve" && res.writable) {
        if (res.klass === K.IMPROVE) improvable.push({ kind: K.IMPROVE, row, stored, slug: der.slug, identity: der.identity });
        else if (res.subclass === K.BASE_EVICTION) improvable.push({ kind: K.BASE_EVICTION, row, stored, slug: der.baseSlug, identity: der.baseIdentity });
      }
    }
  }

  // ── census banner ─────────────────────────────────────────────────────────
  const total = stats.seen;
  const pct = (n) => total ? `${((n / total) * 100).toFixed(2)}%` : "-";
  console.log(`\nCENSUS  slot ${SLOT}/${SLOTS}  rows classified ${f(total)}${stats.otherSlot ? `  (${f(stats.otherSlot)} matched the query's year/sport predicate but belong to other slots' hash parts)` : ""}`);
  for (const klass of [K.AGREE, K.IMPROVE, K.CONFLICT, K.UNDERIVABLE]) {
    const prot = byTier.get(`${klass}/${K.PROTECTED}`) ?? 0, auto = byTier.get(`${klass}/${K.AUTO}`) ?? 0;
    console.log(`  ${klass.padEnd(12)} ${f(counts[klass]).padStart(11)}  ${pct(counts[klass]).padStart(7)}   AUTO ${f(auto).padStart(10)}  PROTECTED ${f(prot).padStart(6)}`);
    // The subclass is a NARROWING of the class above it, so it is printed
    // indented under its parent and its count is INCLUDED in the parent's --
    // it is not a fifth row of the census and must not read as one.
    for (const [k, n] of [...subclasses].filter(([k]) => k.startsWith(`${klass}/`)).sort()) {
      const [, sub, tier] = k.split("/");
      console.log(`    of which ${sub.padEnd(16)} ${f(n).padStart(9)}  ${tier}${tier === K.AUTO ? "  <- writable under audit" : "  <- report only"}`);
    }
  }
  const beAuto = subclasses.get(`${K.CONFLICT}/${K.BASE_EVICTION}/${K.AUTO}`) ?? 0;
  const beProt = subclasses.get(`${K.CONFLICT}/${K.BASE_EVICTION}/${K.PROTECTED}`) ?? 0;
  if (beAuto || beProt) {
    console.log(`\n  BASE-EVICTION  ${f(beAuto + beProt)} rows: on a parallel slug, own parallel field blank/Base, title names no finish,`);
    console.log(`                 checklist-backed base destination exists. ${f(beAuto)} AUTO (writable under audit), ${f(beProt)} PROTECTED (never).`);
  }
  // SPLIT-IDENTITY: reported as its own block, not as a class. A split row
  // has already been counted under whichever derivation class it landed in;
  // this says how many of those rows ALSO contradict themselves.
  if (splitTotal) {
    console.log(`\n  SPLIT-IDENTITY  ${f(splitTotal)} rows (${pct(splitTotal)}) carry two identity fields naming DIFFERENT cards.`);
    console.log(`                  The exact pool reader ORs cardId and hobbyiqCardId, so each is priced into TWO pools.`);
    console.log(`                  Vendor-partition rows (cardId = a vendor product id) are exempt and NOT counted here (#1650).`);
    console.log(`                  by derivation class: ${[...splitByClass].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${f(n)}`).join(" | ")}`);
    if (splitSegments.size) console.log(`                  differing segments: ${[...splitSegments].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${f(n)}`).join(" | ")}`);
    for (const line of splitSamples) console.log(`      ${line}`);
    console.log(`                  The apply path lands BOTH fields, so an audited apply repairs the split with the re-key.`);
  }
  console.log(`\n  top defect axes per class:`);
  for (const klass of [K.IMPROVE, K.CONFLICT]) {
    const rows = [...defects].filter(([k]) => k.startsWith(`${klass}  `)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`    ${klass}: ${rows.map(([k, n]) => `${k.split("  ")[1]} ${f(n)}`).join(" | ") || "-"}`);
  }
  console.log(`  top reasons:`);
  for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`    ${f(n).padStart(10)}  ${k}`);
  console.log(`\n  provenance: ${[...byTier].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${f(n)}`).join(" | ")}`);
  console.log(`  PROTECTED + CONFLICT + UNDERIVABLE are REPORT ONLY FOREVER -- they go to Drew, never to a fleet.`);
  for (const klass of [K.IMPROVE, `${K.CONFLICT}/${K.BASE_EVICTION}`, K.CONFLICT, K.UNDERIVABLE, K.AGREE]) {
    const s = sampleLines(klass);
    if (!s.length) continue;
    const of = klass.includes("/") ? f(beAuto + beProt) : f(counts[klass]);
    // The DISTINCT-CARD count is the number that says the sample is a sample.
    // Slot 27's old 30 lines spanned 3 cards; an auditor has to be able to see
    // that from the banner without re-deriving it.
    console.log(`\n  ${klass} evidence (${s.length} of ${of}, spanning ${f(sampleCardCount(klass))} distinct cards; cap ${f(SAMPLE_CAP)} @ ${SAMPLE_PER_CARD_CAP}/card):`);
    for (const line of s) console.log(`    ${line}`);
  }

  const census = {
    job: "rematch-sold-comps", mode: MODE, slot: SLOT, slots: SLOTS,
    axis: "(cardYear, sportClass, sha1(id) % parts)", measuredAt: SHARD_TABLE.measuredAt,
    units: q.units, expectedRows: expected, classified: total, otherSlot: stats.otherSlot,
    counts, byTier: Object.fromEntries(byTier), defects: Object.fromEntries(defects),
    // Subclass counts are INCLUDED in `counts` -- BASE-EVICTION is a narrowing
    // of CONFLICT, so an auditor summing both would double-count.
    subclasses: Object.fromEntries(subclasses),
    reasons: Object.fromEntries(reasons),
    // THE SAMPLE THE AUDIT GATE READS. 500 lines per class, spread across
    // distinct cardIds by a per-card reservoir (finding 7) -- `sampleSpread`
    // carries the distinct-card count per class so the gate can assert the
    // sample is a sample rather than one pool repeated.
    samples: Object.fromEntries([...samples.keys()].map((k) => [k, sampleLines(k)])),
    sampleSpread: Object.fromEntries([...samples.keys()].map((k) => [k, { lines: sampleLines(k).length, distinctCards: sampleCardCount(k) }])),
    sampleCap: SAMPLE_CAP, samplePerCardCap: SAMPLE_PER_CARD_CAP,
    // The vocabulary this census was classified under. A census quoted in an
    // audit has to name the vocabulary that produced it, or a re-run under a
    // different corpus is indistinguishable from the same measurement.
    finishVocabulary: K.VOCAB.vocabularyStats(),
    // Orthogonal to `counts` -- a split row is ALSO counted in its derivation
    // class, so these must never be summed with the four class totals.
    splitIdentity: {
      total: splitTotal,
      byClass: Object.fromEntries(splitByClass),
      segments: Object.fromEntries(splitSegments),
      samples: splitSamples,
    },
    stoppedAtBudget: !!stopReason, generatedAt: new Date().toISOString(),
  };
  const outFile = path.join(CENSUS_OUT.endsWith(".json") ? path.dirname(CENSUS_OUT) : CENSUS_OUT, `census-slot-${SLOT}.json`);
  let wroteFile = false;
  try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(census, null, 1)); wroteFile = true; console.log(`\n  shard census JSON -> ${outFile}`); }
  catch (e) { console.log(`\n  (could not write ${outFile}: ${String(e?.message ?? e)})`); }
  if (!wroteFile) console.log(`CENSUS_JSON ${JSON.stringify(census)}`);

  // ── census stops here. There is no write path in this mode. ───────────────
  if (MODE === "census") {
    console.log(`\nREAD ONLY -- the census writes nothing to the pool.`);
    if (stopReason) console.log(`\n${stopReason}`);
    return;
  }

  // ── apply-improve ─────────────────────────────────────────────────────────
  const nImprove = improvable.filter((c) => c.kind === K.IMPROVE).length;
  const nEvict = improvable.filter((c) => c.kind === K.BASE_EVICTION).length;
  console.log(`\nAPPLY-IMPROVE  ${APPLY ? "APPLYING" : "REPORT ONLY -- nothing written"}  candidates ${f(improvable.length)} (IMPROVE ${f(nImprove)} + BASE-EVICTION ${f(nEvict)})  concurrency ${CONCURRENCY}`);
  console.log(`  every candidate is re-checked at write time: the pool moves between the census and this pass,`);
  console.log(`  and a candidate that re-checks as the OTHER kind is skipped, not written on the old verdict.`);
  stats.intended = improvable.length;
  const applied = [];
  let idx = 0;
  const worker = async () => {
    while (idx < improvable.length) {
      const my = idx++;
      if (budgetLeft() < 90000) { stopReason = stopReason ?? `stopped at the ${RUN_MINUTES}-minute budget`; stats.notReached += improvable.length - my; return; }
      const cand = improvable[my];
      // RE-READ: the row may have been re-keyed, enriched or deleted since the
      // census page. The class is decided again on what is there NOW.
      let fresh = null;
      try { fresh = (await retry(() => pool.item(cand.row.id, cand.row.cardId).read())).resource ?? null; }
      catch (e) { if (e?.code !== 404 && e?.statusCode !== 404) { stats.failed++; continue; } }
      if (!fresh) { stats.skipped++; bump(reasons, "apply  row-gone-since-census"); continue; }
      const stored = storedIdentity(fresh, deps);
      const der = deriveIdentity(fresh, deps);
      const backed = der.ok ? await checklistBacked(der.slug) : false;
      const beCand = der.ok && K.slugNamesParallel(fresh.cardId);
      const baseBacked = beCand ? await checklistBacked(der.baseSlug) : false;
      const res = K.classifyRow({
        row: fresh, stored, derived: der.ok ? der.identity : null, checklistBacked: backed, derivationReasons: der.reasons,
        storedSlug: fresh.cardId, baseDestSlug: der.baseSlug ?? null, baseDestBacked: baseBacked,
        autoByCardNumber: der.autoByCardNumber === true,
      });
      // The class is decided again on what is there NOW, and it must come back
      // as the SAME kind the census queued. A row the census saw as an eviction
      // that now reads IMPROVE (or the reverse) is a row the pool changed under
      // us -- it is skipped, not written on the strength of the old verdict.
      const nowKind = res.klass === K.IMPROVE ? K.IMPROVE : res.subclass === K.BASE_EVICTION ? K.BASE_EVICTION : null;
      if (!res.writable || nowKind !== cand.kind) {
        stats.skipped++;
        bump(reasons, `apply  no-longer-writable:${res.klass}${res.subclass ? `/${res.subclass}` : ""}/${res.tier}`);
        continue;
      }
      const target = cand.kind === K.BASE_EVICTION ? der.baseSlug : der.slug;
      const identity = cand.kind === K.BASE_EVICTION ? der.baseIdentity : der.identity;
      if (target === fresh.cardId) { stats.skipped++; bump(reasons, "apply  already-at-target"); continue; }

      const keep = stripSystem(fresh);
      keep.cardId = target;
      keep.hobbyiqCardId = target;
      keep.setName = identity.setNameRaw || keep.setName;
      keep.cardNumber = identity.cardNumber || keep.cardNumber;
      keep.parallel = identity.parallel;
      keep.isAuto = identity.isAuto;
      if (cand.kind === K.BASE_EVICTION) {
        // A STORED PRINT RUN IS NEVER DELETED (audit finding 2). This used to
        // be `delete keep.printRun` -- an eviction destroyed a stored field on
        // its way past, and the audit's sample carried a /1 (Immaculate
        // Pujols) and Carroll /499 among the rows it would have erased.
        //
        // The classifier now VETOES the eviction outright when the row stores
        // a print run (storedPrintRunNamesALimitedParallel), so reaching this
        // branch with one set means the classifier and the writer disagree.
        // Refuse rather than write: a fleet never resolves that by guessing,
        // and the row is reported instead.
        if (keep.printRun !== null && keep.printRun !== undefined && keep.printRun !== "") {
          stats.skipped++;
          bump(reasons, `apply  refused:eviction-would-delete-stored-printrun:/${keep.printRun}`);
          continue;
        }
      } else if (identity.printRun !== null && identity.printRun !== undefined) {
        keep.printRun = identity.printRun;
      }
      keep.sport = identity.sport;
      keep.cardYear = identity.cardYear;
      // A row that changes partition must carry the hash of its NEW cardId or
      // the store's pre-write dedup can never see it.
      keep.contentHash = contentHashOf(keep);
      keep.rekeyedFrom = [{ id: fresh.id, cardId: fresh.cardId, hobbyiqCardId: fresh.hobbyiqCardId ?? null, title: fresh.title ?? null }];
      keep.rekeyedAt = new Date().toISOString();
      if (cand.kind === K.BASE_EVICTION) {
        // The three evidence fields travel WITH the row, quoted. A reason that
        // only names the subclass is not auditable after the fact -- Drew must
        // be able to read, from the row alone, exactly what was seen.
        const e = res.evidence ?? {};
        keep.rekeyedReason = `GREAT REMATCH (2026-09-02): CONFLICT/BASE-EVICTION -- slug parallel "${e.storedSlugParallel}" unsupported: stored parallel field ${JSON.stringify(e.storedParallelField)}, title "${e.titleQuoted}" names no finish, checklist-backed base destination ${e.baseDestSlug}`;
        keep.baseEvictionEvidence = e;
      } else {
        keep.rekeyedReason = `GREAT REMATCH (2026-09-01): IMPROVE, checklist-backed, filled ${res.axes.filled.join(",")}`;
      }

      const r = await relocateSoldComp(pool, { keep, drop: [{ id: fresh.id, cardId: fresh.cardId }], retry, verifyFields: ["cardId", "hobbyiqCardId", "rekeyedAt"], dryRun: !APPLY });
      const why = cand.kind === K.BASE_EVICTION ? `BASE-EVICTION (slug said "${res.evidence?.storedSlugParallel}", row and title say nothing)` : `IMPROVE filled ${res.axes.filled.join(",")}`;
      if (!APPLY) { stats.written++; bump(reasons, `apply  would-write:${cand.kind}`); if (applied.length < 20) applied.push(`  WOULD RE-KEY ${fresh.id}  ${fresh.cardId}  ->  ${target}   ${why}`); continue; }
      if (!r.ok && r.stage !== "done") { stats.failed++; console.log(`  FAILED at ${r.stage} ${fresh.id}: ${String(r.error).slice(0, 110)}`); continue; }
      if (r.duplicatesLeft.length) { stats.failed++; stats.duplicatesLeft += r.duplicatesLeft.length; for (const dd of r.duplicatesLeft) console.log(`  DUPLICATE LEFT ${dd.id}@${dd.cardId}: ${String(dd.error).slice(0, 80)}`); continue; }
      stats.written++; stats.alreadyGone += r.alreadyGone.length;
      bump(reasons, `apply  wrote:${cand.kind}`);
      if (applied.length < 20) applied.push(`  RE-KEYED ${fresh.id}  ${fresh.cardId}  ->  ${target}   ${why}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(improvable.length, 1)) }, worker));

  if (applied.length) { console.log("  examples:"); for (const a of applied) console.log(a); }
  console.log(`\n  ${APPLY ? "re-keyed" : "would re-key"}   ${f(stats.written)}`);
  console.log(`  skipped        ${f(stats.skipped)}   <- re-checked at write time and no longer writable`);
  console.log(`  failed         ${f(stats.failed)}${stats.duplicatesLeft ? `   (${f(stats.duplicatesLeft)} duplicates left in the pool -- reported, never a lost sale)` : ""}`);
  console.log(`  not reached    ${f(stats.notReached)}`);
  for (const [k, n] of [...reasons].filter(([k]) => k.startsWith("apply  ")).sort((a, b) => b[1] - a[1])) console.log(`    ${f(n).padStart(8)}  ${k.slice(7)}`);
  console.log(`\n  intended ${f(stats.intended)} = written ${f(stats.written)} + skipped ${f(stats.skipped)} + failed ${f(stats.failed)} + not reached ${f(stats.notReached)}`);
  const recon = stats.written + stats.skipped + stats.failed + stats.notReached;
  if (recon !== stats.intended) { console.error(`!! reconciliation drift: ${recon} accounted vs ${stats.intended} intended (${recon - stats.intended}). Exit 4.`); process.exitCode = 4; }
  if (APPLY) reportWrites({ job: "rematch-sold-comps", intended: stats.intended, written: stats.written, skipped: stats.skipped, failed: stats.failed });
  if (stopReason) console.log(`\n${stopReason}`);
}

module.exports = { unitsForSlot, unitPredicate, slotQuery, rowInSlot, storedIdentity, deriveIdentity, hashPartOf, SPORT_CLASSES, SHARD_TABLE };

if (require.main === module) main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
