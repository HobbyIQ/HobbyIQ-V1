#!/usr/bin/env node
"use strict";
/**
 * acquisition-worklist.cjs — turns UNBACKED sold_comps sales into a RANKED
 * acquisition worklist. Read-only: no Cosmos writes, ever.
 *
 * Prior art (read, reused, not re-derived): C:/tmp/gap2025topps_1430/RESULT.md
 * and C:/tmp/gap2024_2200/RESULT.md + backend/scripts/gap2024-classify.cjs
 * (an uncommitted analysis script in that clone). This file reuses the same
 * three shared libraries that script does:
 *   - scripts/lib/rematch-derive-identity.cjs  (storedIdentity, deriveIdentity)
 *   - scripts/lib/rematch-classify.cjs         (isStrictChecklistSource)
 *   - scripts/lib/name-agreement.cjs           (namesAgree)
 * and the same case-insensitive-cardNumber / per-(year,setKey)-cell in-memory
 * index pattern gap2024-classify.cjs built. All classifyOne / namesAgree /
 * rung-lookup logic below is a straight port of that pattern (adapted from
 * two hardcoded baseball cells to the CLI's --sport/--years/--setkeys args
 * and to a cell list read from a backing-census merge file), not a rewrite.
 *
 * ── WHAT THIS ADDS ON TOP OF gap2024-classify.cjs's TAXONOMY ────────────────
 *
 * The task's taxonomy calls out STALE (derived id already has a checklist
 * row -- rematch's job, EXCLUDED from the worklist) vs STALE-NO-ROW /
 * DERIVED-ONLY / RUNG-MISSING / CARD-MISSING (-> the worklist). This script
 * keeps that split explicit: `classifyOne` returns STALE separately so the
 * two levers (apply a rematch pass vs acquire a missing checklist) are never
 * blended into one number -- see per-cell `staleWithRowCount` in the output.
 *
 * Genuinely-unbacked buckets are then AGGREGATED by destination identity:
 *   (sport, year, destination setKey, insert prefix|'base', parallel, isAuto,
 *    printRun)
 * -> sales count, distinct cardNumbers, example titles, best-guess source URL.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   COSMOS_CONNECTION_STRING="$(...)" node scripts/acquisition-worklist.cjs \
 *     --sport baseball --years 2024,2025,2026 --sample 8000 --out <dir>
 *   ... --setkeys topps,bowman-chrome                 (explicit cells)
 *   ... --cells-from <backing-report-merge.json> --top-cells 12  (census-driven)
 *
 * ── SECRET / RU DISCIPLINE ───────────────────────────────────────────────────
 * COSMOS_CONNECTION_STRING is read from process.env only, never echoed, never
 * written to disk. sold_comps paging uses FeedOptions
 * {maxItemCount:500, maxDegreeOfParallelism:-1} with a while(hasMoreResults())
 * loop (continuationToken-driven — empty pages before the end are expected
 * and handled, never treated as "done"); no COUNT, no GROUP BY, no -1 sample
 * cap. A token-bucket throttle keeps sold_comps reads at <=2,000 RU/s
 * (default cap; override with SOLD_COMPS_RU_CAP) because a census may be
 * running concurrently. card_catalog reads are not throttled — same
 * reasoning gap2024-classify.cjs documents: it is provisioned with its own
 * separate headroom and is not the container under RU pressure.
 */
const fs = require("fs");
const path = require("path");

const { storedIdentity, deriveIdentity } = require(path.join(__dirname, "lib", "rematch-derive-identity.cjs"));
const K = require(path.join(__dirname, "lib", "rematch-classify.cjs"));
const { namesAgree } = require(path.join(__dirname, "lib", "name-agreement.cjs"));

const norm = (s) => String(s ?? "").trim().toLowerCase();
const f = (n) => Number(n || 0).toLocaleString("en-US");
/** A blank/missing parallel and the literal string "Base" are the SAME
 *  absence of a parallel -- a catalog row minted before a `parallel` field
 *  existed and a freshly-derived "Base" both mean "no parallel", and must
 *  compare equal or every unstated-Base catalog row would spuriously read
 *  as a SPELLING twin of itself. Used ONLY for the exact-rung/spelling-twin
 *  comparison, never for the case-insensitive cardNumber index (norm above). */
const normParallel = (s) => {
  const n = norm(s);
  return n === "" || n === "base" ? "base" : n;
};

// ─────────────────────────────────────────────────────────────────────────────
// PURE CLASSIFICATION / AGGREGATION / RANKING / URL-GUESS LOGIC
// (no Cosmos, no fs — this is the part vitest exercises with fakes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a leading insert-set prefix from a cardNumber, e.g. "BP-12" -> "BP",
 * "T90R-3" -> "T90R", "42" -> null (bare numeric = base, no insert prefix).
 * Case-insensitive matcher upstream (indexFor/rungLookup below), but the
 * prefix itself is upper-cased for display/grouping, matching
 * gap2024-classify.cjs's extractInsertPrefix.
 */
function extractInsertPrefix(cardNumber) {
  const m = String(cardNumber || "").match(/^[A-Za-z][A-Za-z0-9]*-/);
  if (m) return m[0].slice(0, -1).toUpperCase();
  return null;
}

/**
 * Build a case-insensitive cardNumber -> rows[] index for one (year,setKey)
 * cell's catalog rows. LOWER(cardNumber) is the key throughout — this is the
 * single seam that makes cardNumber matching case-insensitive; the mutation
 * test in the vitest suite flips this to a case-SENSITIVE compare and
 * expects the "1" / "1a" mixed-case fixture to break, proving the guard is
 * load-bearing rather than accidental.
 */
function indexCatalogCell(rows) {
  const byNumber = new Map();
  for (const r of rows || []) {
    const num = norm(r.cardNumber);
    if (!num) continue;
    if (!byNumber.has(num)) byNumber.set(num, []);
    byNumber.get(num).push(r);
  }
  return byNumber;
}

function isBacked(row) {
  if (!row) return false;
  const named = [row.source, row.sourceSystem, ...(Array.isArray(row.sources) ? row.sources : [])];
  return named.some((s) => K.isStrictChecklistSource(s));
}

/**
 * Rung lookup: (cardNumber [case-insensitive], isAuto, printRun) under
 * setKey, gated by namesAgree against the sale's own playerName before any
 * cross-key or cross-rung claim is trusted. Mirrors gap2024-classify.cjs's
 * rungLookup, generalized off its two hardcoded cells.
 */
function rungLookup(byNumberIndex, cardNumber, isAuto, printRun, playerName) {
  const candidates = byNumberIndex.get(norm(cardNumber)) || [];
  return candidates.map((c) => ({
    row: c,
    autoMatch: (c.isAuto === true) === (isAuto === true),
    prMatch: (c.printRun ?? null) === (printRun ?? null) || (!c.printRun && !printRun),
    agree: namesAgree(playerName || "", c.playerName || ""),
  }));
}

/**
 * CF-DO-NOT-CONFLATE-A-KEY-DEFECT-WITH-A-GAP (PR #2439 review, 2026-09-26).
 *
 * The reviewer's finding: rank 1-2 of the first run ("2026 bowman-chrome-
 * mega-box" Base / Mojo Refractor) were never a genuine gap. card_catalog
 * carries 7,647 2026 rows at setKey FIELD `bowman-mega` (R75: from 2026,
 * bare "Bowman Mega Box" — no "chrome" in the title — is its OWN product,
 * distinct from `bowman-chrome-mega-box`; see productSetKeys.ts
 * BOWMAN_MEGA_BOX_SPLIT_FROM_YEAR and hobbyIqCardId.service.ts's
 * resolveSetKeyForSlug, the one call site with both the raw setName text
 * and the year — `deriveIdentity`'s own identity.setKey (built from
 * spellForEra + applySiblingChecklistOverride only) never reaches that
 * correction, so a bare "Bowman Mega Box" title still derives
 * identity.setKey="bowman-chrome-mega-box" even though computeHobbyIqCardId
 * mints the CORRECT slug under `bowman-mega`). Separately, some of those
 * catalog rows' own `id` segment still reads the pre-rename
 * `bowman-chrome-mega-box` even though the `setKey` FIELD says `bowman-mega`
 * — a legacy artifact from before a rename fleet finished — so a caller
 * must match candidate rows by the setKey FIELD (io.getCellIndex's own
 * cache key), never by re-parsing the id.
 *
 * rank 3/5 ("2025 bowmans-best" B25-... Base) is the same shape one level
 * down: the row was pool-derived under `bowman` instead of the sibling
 * `bowmans-best` — a KEY defect the census's own per-cell classification
 * cannot see because it only ever looks inside the ONE cell it started in.
 *
 * So before a sale can be called CARD-MISSING / RUNG-MISSING / STALE-NO-ROW
 * (this file's genuinely-unbacked buckets), THIS function looks for the same
 * card under:
 *   (a) SIBLING SETKEYS — using the repo's own tables/helpers, never a
 *       hand-rolled guess: `io.resolveSetKeyForSlug` (the year+raw-setName
 *       aware corrector R75 lives behind), `io.productAncestry` /
 *       `io.productRefinementsOf` (parent/family/refinement walk), and
 *       `io.siblingSetKeysToAlsoCheck` (the hand-verified override table,
 *       read forward) — PLUS a bounded cross-setKey search by (year,
 *       cardNumber) across every setKey in the sport (`io.crossSetKeyProbe`),
 *       every candidate namesAgree-gated against the sale's own playerName.
 *   (b) OTHER PARALLEL SPELLINGS of the SAME resolved setKey/cardNumber/
 *       isAuto/printRun rung (the SPELLING-TWIN shape from the prior-art
 *       census, generalized to run after the sibling-key search rather than
 *       only within the one cell the sale started in).
 *   (c) THE OTHER isAuto VALUE at the same setKey/cardNumber/printRun.
 *
 * A hit in (a) is KEY-DEFECT(<setKey found under>) — the row belongs to a
 * different, already-backed product; a hit in (b) is SPELLING(<spelling
 * found>); a hit in (c) is ISAUTO-DEFECT. Only when NONE of (a)/(b)/(c) finds
 * a backed row does the sale earn ACQUIRE — a genuine, verified-absent gap.
 *
 * Every candidate at every step is namesAgree-gated, exactly like the
 * within-cell rungLookup above — an unrelated player at the same number in a
 * sibling product is not evidence of anything.
 */
function resolveDefectOrAcquire(sale, cell, identity, cardNumber, io) {
  const playerName = sale.playerName || "";

  // (a) SIBLING SETKEYS, in priority order: the year+setName-aware corrector
  // first (it is the one place R75-shaped splits like Mega Box actually
  // live), then the parent/family/refinement walk, then the hand-verified
  // override table, then a bounded cross-sport probe as the last, widest net.
  const siblingCandidates = [];
  if (io.resolveSetKeyForSlug) {
    const resolved = io.resolveSetKeyForSlug(cell.sport, sale.setName || identity.setNameRaw || identity.setKey, cell.year);
    if (resolved && resolved !== identity.setKey) siblingCandidates.push(resolved);
  }
  if (io.productAncestry) {
    for (const k of io.productAncestry(identity.setKey) || []) {
      if (k && k !== identity.setKey) siblingCandidates.push(k);
    }
  }
  if (io.productRefinementsOf) {
    for (const k of io.productRefinementsOf(identity.setKey) || []) {
      if (k && k !== identity.setKey) siblingCandidates.push(k);
    }
  }
  if (io.siblingSetKeysToAlsoCheck) {
    for (const k of io.siblingSetKeysToAlsoCheck(identity.setKey, cell.year) || []) {
      if (k && k !== identity.setKey) siblingCandidates.push(k);
    }
  }
  const triedSetKeys = new Set([identity.setKey]);
  for (const siblingKey of siblingCandidates) {
    if (triedSetKeys.has(siblingKey)) continue;
    triedSetKeys.add(siblingKey);
    const { byNumber } = io.getCellIndex(cell.year, siblingKey);
    const hits = rungLookup(byNumber, cardNumber, identity.isAuto, identity.printRun, playerName);
    const backedAgreeing = hits.filter((h) => io.isBacked(h.row) && h.agree);
    const exact = backedAgreeing.find((h) => h.autoMatch && h.prMatch);
    if (exact) return { classification: "KEY-DEFECT", foundUnderSetKey: siblingKey, foundRowId: exact.row.id };
    // Same product, different rung within it -- still a key defect (the sale
    // belongs there), not an acquisition; report it as such rather than
    // falling through to a SPELLING search inside the WRONG product.
    if (backedAgreeing.length) return { classification: "KEY-DEFECT", foundUnderSetKey: siblingKey, foundRowId: backedAgreeing[0].row.id };
  }

  // Widest net: bounded cross-setKey-by-(year,cardNumber) search across the
  // whole sport, for a sibling this table doesn't yet name (e.g. a product
  // rename the vocabulary hasn't caught up to). Cheap and bounded -- see
  // io.crossSetKeyProbe's own TOP-N cap in the CLI driver.
  if (io.crossSetKeyProbe) {
    const probeHits = io.crossSetKeyProbe(cell.sport, cell.year, cardNumber) || [];
    for (const row of probeHits) {
      if (triedSetKeys.has(row.setKey)) continue;
      if (!io.isBacked(row)) continue;
      if (!namesAgree(playerName, row.playerName || "")) continue;
      const autoMatch = (row.isAuto === true) === (identity.isAuto === true);
      const prMatch = (row.printRun ?? null) === (identity.printRun ?? null) || (!row.printRun && !identity.printRun);
      if (autoMatch && prMatch) return { classification: "KEY-DEFECT", foundUnderSetKey: row.setKey, foundRowId: row.id };
    }
  }

  // (b) OTHER PARALLEL SPELLINGS of the SAME resolved setKey.
  const { byNumber } = io.getCellIndex(cell.year, identity.setKey);
  const sameKeyHits = rungLookup(byNumber, cardNumber, identity.isAuto, identity.printRun, playerName);
  const sameKeyBackedAgreeing = sameKeyHits.filter((h) => io.isBacked(h.row) && h.agree);
  const spellingTwin = sameKeyBackedAgreeing.find(
    (h) => h.autoMatch && h.prMatch && normParallel(h.row.parallel) !== normParallel(identity.parallel),
  );
  if (spellingTwin) return { classification: "SPELLING", foundSpelling: spellingTwin.row.parallel, foundRowId: spellingTwin.row.id };

  // (c) THE OTHER isAuto VALUE, same setKey/cardNumber/printRun.
  const isAutoFlip = sameKeyHits.find(
    (h) => io.isBacked(h.row) && h.agree && h.prMatch && !h.autoMatch,
  );
  if (isAutoFlip) return { classification: "ISAUTO-DEFECT", foundRowId: isAutoFlip.row.id };

  return { classification: "ACQUIRE" };
}

/**
 * Classify one already-known-unbacked sale into exactly one bucket.
 * `io` supplies the only Cosmos-shaped calls this function needs:
 *   io.pointReadById(id) -> row|null           (exact-id point read)
 *   io.getCellIndex(year, setKey) -> {rows, byNumber}  (cached cell load)
 *   io.isBacked(row) -> boolean
 *   io.resolveSetKeyForSlug / io.productAncestry / io.productRefinementsOf /
 *     io.siblingSetKeysToAlsoCheck / io.crossSetKeyProbe  (all OPTIONAL —
 *     see resolveDefectOrAcquire; a caller that omits them just never finds
 *     a defect and everything resolves to ACQUIRE, which is why the mutation
 *     test removes io.siblingSetKeysToAlsoCheck/io.resolveSetKeyForSlug/
 *     io.productAncestry/io.productRefinementsOf and expects a KEY-DEFECT
 *     fixture to flip to ACQUIRE)
 * All are pure lookups over pre-fetched/cached data in real use; the vitest
 * suite passes plain in-memory fakes for all of them.
 *
 * Returns { name, detail, classification } where `name` is one of:
 *   STALE            — derived id differs from stored AND has a checklist row
 *                       (rematch's job; caller EXCLUDES this from the worklist)
 *   STALE-NO-ROW      — derived id differs from stored, no row at all there
 *   BACKED-DERIVED-ONLY — exact rung exists under the derived id; a point-read
 *                       miss only, not a real gap
 *   RUNG-MISSING      — this cardNumber exists in the cell, but not at this
 *                       (isAuto, printRun) rung under any parallel spelling
 *   CARD-MISSING      — no catalog row for that cardNumber under this setKey
 *                       at all (case-insensitive)
 *   NO-NUMBER         — deriveIdentity refused (blank title, guard refusal, …)
 * and `classification` (PR #2439 review) is one of:
 *   STALE             — mirrors name === "STALE"; never worklist-bound
 *   ACQUIRE           — genuinely absent from the catalog under every key,
 *                       spelling and isAuto value this function checked;
 *                       the ONLY classification builders should chase
 *   KEY-DEFECT(<setKey>) — the card exists, backed, under a SIBLING setKey
 *   SPELLING(<parallel>) — the card exists, backed, under a different
 *                       parallel spelling of the SAME setKey/cardNumber
 *   ISAUTO-DEFECT     — the card exists, backed, at the same setKey/
 *                       cardNumber/printRun but the OTHER isAuto value
 * name === "STALE"/"BACKED-DERIVED-ONLY"/"NO-NUMBER" always carry
 * classification "STALE" (or n/a) and are never routed through
 * resolveDefectOrAcquire — only STALE-NO-ROW/RUNG-MISSING/CARD-MISSING are,
 * because those three are exactly the buckets that used to go straight into
 * the worklist without ever checking a sibling key/spelling/isAuto value.
 */
function classifyOne(row, cell, deps, io) {
  const stored = storedIdentity(row, deps);
  let der;
  try {
    der = deriveIdentity(row, deps);
  } catch (e) {
    der = { ok: false, reasons: [`throw:${String(e && e.message).slice(0, 60)}`] };
  }

  if (!der.ok) {
    return { name: "NO-NUMBER", detail: { reasons: der.reasons }, classification: "NO-NUMBER" };
  }

  // CF-THE-SLUG-IS-THE-DESTINATION, NOT identity.setKey (second review round,
  // 2026-09-26).
  //
  // THE DEFECT. `deriveIdentity` (rematch-derive-identity.cjs, prior art,
  // untouched) computes its returned `identity.setKey` from
  // `spellForEra(applySiblingChecklistOverride(...))` only. `der.slug`, a
  // few lines later in that SAME function, is computed by
  // `computeHobbyIqCardId`, which additionally runs `resolveSetKeyForSlug` --
  // the ONE call site with both the raw setName text and the year, which is
  // where R75's "2026+, bare 'Bowman Mega Box' (no 'chrome') -> the DISTINCT
  // `bowman-mega` product" redirect actually lives (productSetKeys.ts
  // BOWMAN_MEGA_BOX_SPLIT_FROM_YEAR). So for a 2026 bare "Bowman Mega Box"
  // title, `identity.setKey` reads `bowman-chrome-mega-box` while
  // `der.slug`'s own setKey segment reads `bowman-mega` -- the SAME function
  // disagreeing with itself, and live sold_comps is already 98.8% on
  // `bowman-mega` for exactly this shape. Building the worklist's
  // destination identity from `identity.setKey` therefore manufactured a
  // "gap" at a product this repo's own resolver already routes correctly.
  //
  // THE FIX. The slug is the thing every OTHER seam (point reads,
  // computeHobbyIqCardId's own callers, the pool itself) treats as the
  // truth, so this function re-derives the destination identity FROM THE
  // SLUG, via the grade/subset-aware `parseHobbyIqCardId` (never a naive
  // `split(":")`, which misaligns cardNumber/parallel/isAuto whenever an
  // optional `sub-` subset segment is present). `identity` is used ONLY as a
  // fallback when the slug fails to parse (should not happen for an `ok`
  // derivation, but absent beats wrong).
  const slugParsed = der.slug && deps.parseHobbyIqCardId ? deps.parseHobbyIqCardId(der.slug) : null;
  const destinationIdentity = slugParsed
    ? {
        sport: slugParsed.sport ?? der.identity.sport,
        cardYear: der.identity.cardYear,
        setKey: slugParsed.setKey,
        cardNumber: slugParsed.cardNumber,
        parallel: slugParsed.parallel,
        isAuto: slugParsed.isAuto,
        printRun: slugParsed.printRun,
      }
    : der.identity;

  const storedSlug = row.hobbyiqCardId || row.cardId || null;
  if (der.slug && storedSlug && der.slug !== storedSlug) {
    const derivedRow = io.pointReadById(der.slug);
    if (isBacked(derivedRow)) {
      return { name: "STALE", detail: { from: storedSlug, to: der.slug }, classification: "STALE" };
    }
    if (!derivedRow) {
      const cardNumber = destinationIdentity.cardNumber || stored.cardNumber || "";
      const resolution = cardNumber ? resolveDefectOrAcquire(row, cell, destinationIdentity, cardNumber, io) : { classification: "ACQUIRE" };
      return {
        name: "STALE-NO-ROW",
        detail: { from: storedSlug, to: der.slug, identity: destinationIdentity, ...resolution },
        classification: resolution.classification,
      };
    }
    // else: derived row exists but isn't strict-backed — fall through and
    // keep classifying against the destination identity, the current truth.
  }

  const cardNumber = destinationIdentity.cardNumber || stored.cardNumber || "";
  if (!cardNumber) return { name: "NO-NUMBER", detail: null, classification: "NO-NUMBER" };

  const setKey = destinationIdentity.setKey || cell.setKey;
  const { byNumber } = io.getCellIndex(cell.year, setKey);
  const hits = rungLookup(byNumber, cardNumber, destinationIdentity.isAuto, destinationIdentity.printRun, row.playerName);

  // PR #2439 review: BACKED-DERIVED-ONLY means the point read simply missed
  // an already-backed row at the EXACT SAME rung -- number, isAuto, printRun,
  // AND parallel spelling. A hit that matches number/auto/printRun but NOT
  // parallel is a DIFFERENT card (a spelling twin), not a missed point read;
  // that case is left to fall through to resolveDefectOrAcquire's SPELLING
  // search below, exactly the "2025 Panini Prizm Silver vs Silver Prizm"
  // shape this review's own reasoning names.
  const backedHits = hits.filter((h) => isBacked(h.row));
  const exactRung = backedHits.find(
    (h) => h.autoMatch && h.prMatch && normParallel(h.row.parallel) === normParallel(destinationIdentity.parallel),
  );
  if (exactRung) {
    return {
      name: "BACKED-DERIVED-ONLY",
      detail: { note: "rung exists but point read missed it", id: exactRung.row.id },
      classification: "STALE",
    };
  }

  const anyNumberPresent = hits.length > 0;
  if (anyNumberPresent) {
    const resolution = resolveDefectOrAcquire(row, cell, destinationIdentity, cardNumber, io);
    return {
      name: "RUNG-MISSING",
      detail: { candidatesAtNumber: hits.length, identity: destinationIdentity, cardNumber, ...resolution },
      classification: resolution.classification,
    };
  }

  const prefix = extractInsertPrefix(cardNumber);
  const resolution = resolveDefectOrAcquire(row, cell, destinationIdentity, cardNumber, io);
  return {
    name: "CARD-MISSING",
    detail: { identity: destinationIdentity, cardNumber, prefix, ...resolution },
    classification: resolution.classification,
  };
}

/** The task's worklist-bound bucket set — everything else (STALE, NO-NUMBER,
 *  BACKED-DERIVED-ONLY) is reported but excluded from the acquisition rows. */
const WORKLIST_BUCKETS = new Set(["STALE-NO-ROW", "RUNG-MISSING", "CARD-MISSING"]);

/** Of the worklist-bound buckets, only classification ACQUIRE should ever
 *  reach a builder's ranked worklist — KEY-DEFECT/SPELLING/ISAUTO-DEFECT are
 *  routing/spelling/flag defects the rematch/repoint lanes fix, not a gap. */
const ACQUIRE_CLASSIFICATION = "ACQUIRE";

/**
 * Aggregation key for one worklist-bound classification: destination
 * identity as (sport, year, destination setKey, insert prefix|'base',
 * parallel, isAuto, printRun, classification). `classification` is included
 * so an ACQUIRE bucket and a KEY-DEFECT/SPELLING/ISAUTO-DEFECT bucket at the
 * SAME destination identity are never merged into one row — PR #2439's
 * review is exactly that a defect and a gap must never be blended. Stable
 * stringify so Map lookups are exact.
 */
function aggregationKey(sport, year, setKey, prefix, parallel, isAuto, printRun, classification) {
  return [
    String(sport || "").toLowerCase(),
    Number(year),
    String(setKey || "").toLowerCase(),
    prefix ? String(prefix).toUpperCase() : "base",
    String(parallel || "Base"),
    isAuto === true ? "auto" : "non-auto",
    printRun == null ? "" : String(printRun),
    String(classification || "ACQUIRE"),
  ].join("|");
}

/**
 * Fold a bucketed classification result into the running aggregate map.
 * `agg` is a Map<key, {sport,year,setKey,prefix,parallel,isAuto,printRun,
 * classification,classificationDetail,salesCount,cardNumbers:Set,
 * exampleTitles:[]}>. Mutates and returns `agg`.
 */
function foldIntoAggregate(agg, sport, year, sale, classification) {
  if (!WORKLIST_BUCKETS.has(classification.name)) return agg;
  const identity = (classification.detail && classification.detail.identity) || {};
  const setKey = identity.setKey || null;
  const cardNumber = classification.detail && classification.detail.cardNumber;
  const prefix = (classification.detail && classification.detail.prefix) || extractInsertPrefix(cardNumber) || null;
  const parallel = identity.parallel || "Base";
  const isAuto = identity.isAuto === true;
  const printRun = identity.printRun ?? null;
  const cls = classification.classification || ACQUIRE_CLASSIFICATION;
  // Human-readable qualifier for KEY-DEFECT(<setKey>) / SPELLING(<spelling>);
  // ISAUTO-DEFECT / ACQUIRE / STALE carry none.
  const classificationDetail = cls === "KEY-DEFECT"
    ? (classification.detail && classification.detail.foundUnderSetKey) || null
    : cls === "SPELLING"
      ? (classification.detail && classification.detail.foundSpelling) || null
      : null;

  const key = aggregationKey(sport, year, setKey, prefix, parallel, isAuto, printRun, cls);
  if (!agg.has(key)) {
    agg.set(key, {
      sport, year, setKey, prefix: prefix ? String(prefix).toUpperCase() : "base",
      parallel, isAuto, printRun,
      classification: cls,
      classificationDetail,
      salesCount: 0,
      cardNumbers: new Set(),
      exampleTitles: [],
      buckets: {},
    });
  }
  const entry = agg.get(key);
  entry.salesCount += 1;
  if (cardNumber) entry.cardNumbers.add(String(cardNumber));
  if (entry.exampleTitles.length < 5 && sale && sale.title) entry.exampleTitles.push(sale.title);
  entry.buckets[classification.name] = (entry.buckets[classification.name] || 0) + 1;
  return agg;
}

/**
 * Rank aggregate entries by salesCount descending, attach cumulative share.
 * Ties broken by distinct-cardNumber count, then setKey/prefix for
 * determinism (never insertion order).
 */
function rankAggregate(agg) {
  const rows = [...agg.values()].map((e) => ({
    ...e,
    distinctCardNumbers: e.cardNumbers.size,
  }));
  rows.sort((a, b) => {
    if (b.salesCount !== a.salesCount) return b.salesCount - a.salesCount;
    if (b.distinctCardNumbers !== a.distinctCardNumbers) return b.distinctCardNumbers - a.distinctCardNumbers;
    const as = `${a.setKey}|${a.prefix}`;
    const bs = `${b.setKey}|${b.prefix}`;
    return as < bs ? -1 : as > bs ? 1 : 0;
  });
  const total = rows.reduce((s, r) => s + r.salesCount, 0);
  let running = 0;
  for (const r of rows) {
    running += r.salesCount;
    r.cumulativeShare = total > 0 ? running / total : 0;
    r.share = total > 0 ? r.salesCount / total : 0;
  }
  return rows;
}

/**
 * Best-guess source URLs for a destination identity. Every URL returned is
 * a GUESS from a naming pattern, never independently fetched/verified by
 * this script — callers must say so wherever they render these.
 *   - checklistinsider: https://www.checklistinsider.com/<year>-<product-words>-<sport>-checklist
 *   - baseballcardpedia (baseball only): index.php/<Year>_<Product>
 *   - cardboardconnection: https://www.cardboardconnection.com/<year>-<product-words>-<sport>-cards
 */
function guessSourceUrls(sport, year, setKey) {
  const words = String(setKey || "").split("-").filter(Boolean);
  const productWords = words.join("-");
  const productTitleCase = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("_");
  const sportLower = String(sport || "").toLowerCase();

  const urls = [];
  if (productWords) {
    urls.push({
      source: "checklistinsider",
      url: `https://www.checklistinsider.com/${year}-${productWords}-${sportLower}-checklist`,
      guess: true,
    });
    urls.push({
      source: "cardboardconnection",
      url: `https://www.cardboardconnection.com/${year}-${productWords}-${sportLower}-cards`,
      guess: true,
    });
  }
  if (sportLower === "baseball" && productTitleCase) {
    urls.push({
      source: "baseballcardpedia",
      url: `https://www.baseballcardpedia.com/index.php/${year}_${productTitleCase}`,
      guess: true,
    });
  }
  return urls;
}

/** Per-cell summary: sampled fraction, bucket shares, the STALE-with-row
 *  count (the rematch lever) reported SEPARATELY from the acquisition lever,
 *  and — PR #2439 review — the acquisition lever's OWN breakdown into
 *  ACQUIRE vs KEY-DEFECT vs SPELLING vs ISAUTO-DEFECT, so a cell dominated by
 *  routing/spelling defects never reads as an acquisition-heavy cell. */
function summarizeCell(cellStats) {
  const { scanned, sampled, unbacked, buckets, staleWithRowCount, totalPopulationHint, classificationCounts } = cellStats;
  const sampledFraction = totalPopulationHint > 0 ? sampled / totalPopulationHint : (scanned > 0 ? sampled / scanned : 0);
  const bucketShares = {};
  const bucketTotal = Object.values(buckets || {}).reduce((s, n) => s + n, 0);
  for (const [name, count] of Object.entries(buckets || {})) {
    bucketShares[name] = bucketTotal > 0 ? count / bucketTotal : 0;
  }
  const acquisitionCount = Object.entries(buckets || {})
    .filter(([name]) => WORKLIST_BUCKETS.has(name))
    .reduce((s, [, n]) => s + n, 0);
  const cc = classificationCounts || {};
  const acquireOnly = cc.ACQUIRE || 0;
  const classificationShares = {};
  const classificationTotal = Object.values(cc).reduce((s, n) => s + n, 0);
  for (const [name, count] of Object.entries(cc)) {
    classificationShares[name] = classificationTotal > 0 ? count / classificationTotal : 0;
  }
  return {
    scanned, sampled, unbacked,
    sampledFraction,
    buckets: buckets || {},
    bucketShares,
    staleWithRowCount: staleWithRowCount || 0,
    acquisitionCount,
    classificationCounts: cc,
    classificationShares,
    rematchVsAcquisitionSplit: {
      rematch: staleWithRowCount || 0,
      acquisition: acquisitionCount,
    },
    acquisitionVsDefectSplit: {
      acquire: acquireOnly,
      keyDefect: cc["KEY-DEFECT"] || 0,
      spelling: cc.SPELLING || 0,
      isAutoDefect: cc["ISAUTO-DEFECT"] || 0,
    },
  };
}

module.exports = {
  extractInsertPrefix,
  indexCatalogCell,
  isBacked,
  rungLookup,
  resolveDefectOrAcquire,
  classifyOne,
  WORKLIST_BUCKETS,
  ACQUIRE_CLASSIFICATION,
  aggregationKey,
  foldIntoAggregate,
  rankAggregate,
  rankWithinClassification,
  guessSourceUrls,
  summarizeCell,
  writeOutputs,
};

// ─────────────────────────────────────────────────────────────────────────────
// CLI DRIVER — only runs when invoked directly, never on require() (so the
// vitest suite can `require()` this file for the pure functions above without
// pulling in @azure/cosmos or touching Cosmos at all).
// ─────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const val = (flag, d) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
  };
  const SPORT = val("--sport", "baseball");
  const YEARS = String(val("--years", "")).split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
  const SETKEYS = String(val("--setkeys", "")).split(",").map((s) => s.trim()).filter(Boolean);
  const CELLS_FROM = val("--cells-from", null);
  const TOP_CELLS = Number(val("--top-cells", "0"));
  const SAMPLE = Number(val("--sample", "8000"));
  const OUT_DIR = val("--out", path.join(process.cwd(), "acquisition-worklist-out"));
  const RU_CAP = Number(process.env.SOLD_COMPS_RU_CAP || 2000);

  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Run via:");
    console.error(`  COSMOS_CONNECTION_STRING="$(az webapp config appsettings list --name HobbyIQ3 --resource-group rg-hobbyiq-dev --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" node scripts/acquisition-worklist.cjs ...`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const cells = resolveCells({ sport: SPORT, years: YEARS, setkeys: SETKEYS, cellsFrom: CELLS_FROM, topCells: TOP_CELLS });
  if (!cells.length) {
    console.error("FATAL: no cells resolved from --setkeys/--years or --cells-from. Nothing to do.");
    process.exit(1);
  }
  console.log(`Resolved ${cells.length} cell(s):`);
  for (const c of cells) console.log(`  ${c.sport}|${c.year}|${c.setKey}`);

  const { CosmosClient } = require("@azure/cosmos");
  const backend = path.resolve(__dirname, "..");
  const d = (p) => require(path.join(backend, "dist", "services", ...p));
  const pti = d(["portfolioiq", "parseTitleIdentity.service.js"]);
  const hic = d(["portfolioiq", "hobbyIqCardId.service.js"]);
  const psk = d(["catalog", "productSetKeys.js"]);
  const guard = d(["portfolioiq", "slugGuard.service.js"]);
  const pvs = d(["portfolioiq", "persistVendorSalesToPool.service.js"]);
  const slugRe = d(["portfolioiq", "slugRederivation.service.js"]);

  const deps = {
    parseListingIdentity: pti.parseListingIdentity,
    checklistSpellingFor: undefined,
    noteSpellingAdopted: undefined,
    isCardNumberAutoSubset: pti.isCardNumberAutoSubset,
    scopedMarketLanguageAlias: pti.scopedMarketLanguageAlias,
    inferSetKeyFromTitle: pti.inferSetKeyFromTitle,
    titleStatesSoccerCompetition: pti.titleStatesSoccerCompetition,
    inferSportFromTitle: pti.inferSportFromTitle,
    ingestGradeFromTitle: pvs.ingestGradeFromTitle,
    isMultiCardLot: pti.isMultiCardLot,
    normalizeSetKey: hic.normalizeSetKey,
    computeHobbyIqCardId: hic.computeHobbyIqCardId,
    applySiblingChecklistOverride: hic.applySiblingChecklistOverride,
    spellForEra: psk.spellForEra,
    guardSlugInputs: guard.guardSlugInputs,
    normalizeSportStrict: guard.normalizeSportStrict,
    extractYearFromTitle: slugRe.extractYearFromTitle,
    // Second review round (2026-09-26): classifyOne re-derives the
    // destination identity from der.slug (via parseHobbyIqCardId, the same
    // grade/subset-aware slug parser production reads slugs with) rather
    // than trusting identity.setKey, which never runs resolveSetKeyForSlug's
    // R75-shaped redirects. See classifyOne's own header comment.
    parseHobbyIqCardId: hic.parseHobbyIqCardId,
  };

  // PR #2439 review: the repo's own sibling-key tables/helpers, injected into
  // `io` (not `deps` — these are consulted by resolveDefectOrAcquire, a
  // classifyOne POST-step, never by deriveIdentity itself) so a defect like
  // "R75's bare-Mega-Box-from-2026 goes to bowman-mega, not bowman-chrome-
  // mega-box" is caught by the SAME year+setName-aware corrector production
  // uses, not a re-guessed rule that could drift from it.
  const resolveSetKeyForSlugDep = hic.resolveSetKeyForSlug;
  const siblingSetKeysToAlsoCheckDep = hic.siblingSetKeysToAlsoCheck;
  const productAncestryDep = psk.productAncestry;
  const productRefinementsOfDep = psk.productRefinementsOf;

  const client = new CosmosClient({
    connectionString: process.env.COSMOS_CONNECTION_STRING,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  });
  const db = client.database("hobbyiq");
  const pool = db.container("sold_comps");
  const cat = db.container("card_catalog");

  // Token-bucket RU throttle for sold_comps ONLY (<=RU_CAP per second); a
  // census may be concurrently running against the same container.
  let ruWindowStart = Date.now();
  let ruInWindow = 0;
  async function chargeSoldCompsRu(charge) {
    ruInWindow += Number(charge) || 0;
    const elapsed = Date.now() - ruWindowStart;
    if (elapsed >= 1000) { ruWindowStart = Date.now(); ruInWindow = 0; return; }
    if (ruInWindow > RU_CAP) {
      const waitMs = 1000 - elapsed;
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      ruWindowStart = Date.now();
      ruInWindow = 0;
    }
  }

  const cellRowCache = new Map(); // "year|setKey" -> rows[]
  const cellIndexCache = new Map(); // "year|setKey" -> byNumber Map
  const idIndexCache = new Map(); // "year|setKey" -> Map(id -> row)

  async function loadCatalogCell(year, setKey) {
    const key = `${year}|${setKey}`;
    if (cellRowCache.has(key)) return cellRowCache.get(key);
    const rows = [];
    try {
      const it = cat.items.query(
        {
          query: "SELECT c.id, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.playerName, c.source, c.sourceSystem, c.sources FROM c WHERE c.year=@y AND c.setKey=@s",
          parameters: [{ name: "@y", value: Number(year) }, { name: "@s", value: setKey }],
        },
        { maxItemCount: 500, maxDegreeOfParallelism: -1 },
      );
      // while(hasMoreResults()) — empty pages before the end are expected.
      while (it.hasMoreResults()) {
        const page = await retry(() => it.fetchNext());
        for (const r of page.resources || []) rows.push(r);
      }
      console.log(`  loaded catalog cell ${key}: ${f(rows.length)} rows`);
    } catch (e) {
      console.error(`  catalog cell load FAILED ${key}: ${String(e && e.message).slice(0, 150)}`);
    }
    cellRowCache.set(key, rows);
    const byId = new Map();
    for (const r of rows) byId.set(r.id, r);
    idIndexCache.set(key, byId);
    const { indexCatalogCell } = module.exports;
    cellIndexCache.set(key, indexCatalogCell(rows));
    return rows;
  }

  function getCellIndex(year, setKey) {
    const key = `${year}|${setKey}`;
    return { rows: cellRowCache.get(key) || [], byNumber: cellIndexCache.get(key) || new Map() };
  }
  function pointReadById(id) {
    if (!id || !String(id).startsWith("hiq:")) return null;
    const parts = String(id).split(":");
    if (parts.length < 4) return null;
    const year = Number(parts[2]);
    const setKey = parts[3];
    const key = `${year}|${setKey}`;
    const byId = idIndexCache.get(key);
    return byId ? (byId.get(id) || null) : null;
  }

  // PR #2439 review, part (a)'s widest net: a bounded cross-setKey search by
  // (sport, year, cardNumber) across EVERY setKey in the sport — not just the
  // cell's own known siblings — for a product rename the vocabulary tables
  // haven't caught up to yet. card_catalog partitions on /cardId, so this is
  // a cross-partition fan-out; kept cheap and safe with a TOP cap (never -1,
  // never unbounded) plus an in-memory memo per (sport,year,cardNumber) so
  // the same probe is never issued twice. card_catalog is NOT RU-throttled
  // here, matching gap2024-classify.cjs's own documented reasoning: it has
  // its own separate provisioned headroom and is not the container under RU
  // pressure (sold_comps is, via chargeSoldCompsRu above).
  const CROSS_SETKEY_PROBE_TOP = Number(process.env.CROSS_SETKEY_PROBE_TOP || 25);
  const crossProbeCache = new Map(); // "sport|year|cardNumber" -> rows[]
  async function crossSetKeyProbeAsync(sport, year, cardNumber) {
    const key = `${sport}|${year}|${norm(cardNumber)}`;
    if (crossProbeCache.has(key)) return crossProbeCache.get(key);
    let rows = [];
    try {
      const { resources } = await retry(() => cat.items.query(
        {
          query: `SELECT TOP ${CROSS_SETKEY_PROBE_TOP} c.id, c.setKey, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.playerName, c.source, c.sourceSystem, c.sources FROM c WHERE c.sport=@sp AND c.year=@y AND LOWER(c.cardNumber)=LOWER(@n)`,
          parameters: [{ name: "@sp", value: sport }, { name: "@y", value: Number(year) }, { name: "@n", value: String(cardNumber) }],
        },
        { maxItemCount: CROSS_SETKEY_PROBE_TOP },
      ).fetchAll());
      rows = resources || [];
    } catch { rows = []; }
    crossProbeCache.set(key, rows);
    return rows;
  }
  // classifyOne/resolveDefectOrAcquire are synchronous (six census/rematch
  // call sites already depend on that shape via deriveIdentity — see its own
  // header). The cross-setKey probe is I/O, so it is PRE-FETCHED per sale
  // just before classifyOne runs (see the per-row loop below) and handed in
  // as a plain synchronous lookup here, the same pre-resolve-then-hand-down
  // shape deriveIdentity's own R29 product-resolution map uses.
  let pendingCrossProbeResults = [];
  function crossSetKeyProbeSync() {
    return pendingCrossProbeResults;
  }

  const io = {
    pointReadById,
    getCellIndex,
    isBacked,
    resolveSetKeyForSlug: resolveSetKeyForSlugDep,
    siblingSetKeysToAlsoCheck: siblingSetKeysToAlsoCheckDep,
    productAncestry: productAncestryDep,
    productRefinementsOf: productRefinementsOfDep,
    crossSetKeyProbe: crossSetKeyProbeSync,
  };

  const perCellSummaries = {};
  const aggregate = new Map();

  for (const cell of cells) {
    console.log(`\n=== ${cell.sport} ${cell.year} ${cell.setKey} ===`);
    await loadCatalogCell(cell.year, cell.setKey);

    const query = {
      query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.setName, c.sport, c.cardYear, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.playerName, c.gradeCompany, c.gradeValue, c.source, c.sourceSystem, c.flaggedWrong, c.excludedFromFmv FROM c WHERE c.sport=@sp AND c.cardYear=@yr AND c.setName=@sk",
      parameters: [{ name: "@sp", value: cell.sport }, { name: "@yr", value: cell.year }, { name: "@sk", value: cell.setKey }],
    };
    const it = pool.items.query(query, { maxItemCount: 500, maxDegreeOfParallelism: -1 });

    const cellStats = { scanned: 0, sampled: 0, unbacked: 0, staleWithRowCount: 0, buckets: {}, totalPopulationHint: 0, classificationCounts: {} };
    let sampled = 0;
    let pageNum = 0;

    // while(hasMoreResults()) — never a fixed page count, never -1 as a cap.
    while (it.hasMoreResults() && sampled < SAMPLE) {
      pageNum++;
      const page = await retry(() => it.fetchNext());
      await chargeSoldCompsRu(page.requestCharge || 0);
      const rows = page.resources || [];
      cellStats.totalPopulationHint += rows.length;

      for (const row of rows) {
        cellStats.scanned++;
        if (sampled >= SAMPLE) break;
        if (row.flaggedWrong === true || row.excludedFromFmv === true) continue;

        const storedSlug = row.hobbyiqCardId || row.cardId || null;
        const storedRow = pointReadById(storedSlug);
        if (isBacked(storedRow)) continue; // already backed; not part of the unbacked population

        sampled++;
        cellStats.sampled++;
        cellStats.unbacked++;

        // Warm the cross-setKey probe cache with the row's OWN raw
        // cardNumber before classifying -- covers the overwhelming majority
        // of rows, where the derived cardNumber matches the stored one.
        // classifyOne/resolveDefectOrAcquire stay synchronous throughout
        // (matching deriveIdentity's own six-call-site sync contract); this
        // is the pre-resolve-then-hand-down shape, not an inline await.
        if (row.cardNumber) {
          pendingCrossProbeResults = await crossSetKeyProbeAsync(cell.sport, cell.year, row.cardNumber);
        } else {
          pendingCrossProbeResults = [];
        }
        let classification = classifyOne(row, cell, deps, io);
        // If deriveIdentity's cardNumber differs from the stored one (a title
        // correction) AND this row still needs the cross probe (it reached a
        // worklist-bound bucket that isn't already ACQUIRE), re-warm with the
        // DERIVED cardNumber and re-classify once -- cheap (memoized) and
        // correct rather than silently probing the wrong number.
        const derivedCardNumber = classification.detail && classification.detail.cardNumber;
        if (
          WORKLIST_BUCKETS.has(classification.name)
          && derivedCardNumber
          && norm(derivedCardNumber) !== norm(row.cardNumber || "")
        ) {
          pendingCrossProbeResults = await crossSetKeyProbeAsync(cell.sport, cell.year, derivedCardNumber);
          classification = classifyOne(row, cell, deps, io);
        }

        cellStats.buckets[classification.name] = (cellStats.buckets[classification.name] || 0) + 1;
        if (classification.name === "STALE") {
          cellStats.staleWithRowCount++;
          continue; // rematch's lever, never the worklist's
        }
        cellStats.classificationCounts = cellStats.classificationCounts || {};
        const cls = classification.classification || "ACQUIRE";
        cellStats.classificationCounts[cls] = (cellStats.classificationCounts[cls] || 0) + 1;
        foldIntoAggregate(aggregate, cell.sport, cell.year, row, classification);
      }
      console.log(`  page ${pageNum} (RU ${Math.round(page.requestCharge || 0)}): sampled=${f(sampled)} unbacked=${f(cellStats.unbacked)}`);
    }

    perCellSummaries[`${cell.sport}|${cell.year}|${cell.setKey}`] = summarizeCell(cellStats);
  }

  const ranked = rankAggregate(aggregate).map((r) => ({ ...r, sourceUrls: guessSourceUrls(r.sport, r.year, r.setKey) }));

  writeOutputs(OUT_DIR, ranked, perCellSummaries, { sport: SPORT, cells, sample: SAMPLE });
  console.log(`\nWrote worklist.csv + WORKLIST.md to ${OUT_DIR}`);
}

/** Resolve the cell list either from an explicit sport/years/setkeys triple,
 *  or from a backing-census merge file's `allSportsUnbackedCells.rows`
 *  (ranked by `unbacked` count, top `topCells` for the given sport/years). */
function resolveCells({ sport, years, setkeys, cellsFrom, topCells }) {
  if (cellsFrom) {
    const j = JSON.parse(fs.readFileSync(cellsFrom, "utf8"));
    const block = j.allSportsUnbackedCells;
    if (!block || !Array.isArray(block.rows)) {
      throw new Error(`${cellsFrom} has no allSportsUnbackedCells.rows`);
    }
    const idx = Object.fromEntries(block.columns.map((c, i) => [c, i]));
    let rows = block.rows.filter((r) => r[idx.sport] === sport);
    if (years.length) rows = rows.filter((r) => years.includes(Number(r[idx.year])));
    rows.sort((a, b) => b[idx.unbacked] - a[idx.unbacked]);
    if (topCells > 0) rows = rows.slice(0, topCells);
    return rows.map((r) => ({ sport: r[idx.sport], year: Number(r[idx.year]), setKey: r[idx.setKey], unbackedHint: r[idx.unbacked] }));
  }
  const cells = [];
  for (const year of years) {
    for (const setKey of setkeys) cells.push({ sport, year, setKey });
  }
  return cells;
}

function writeOutputs(outDir, ranked, perCellSummaries, meta) {
  // worklist.csv — EVERY row (ACQUIRE and defect alike), so nothing is lost,
  // but `classification` is its own column and each destination identity's
  // rank/share/cumulativeShare is computed WITHIN its own classification
  // (see rankWithinClassification below) — PR #2439 review: an ACQUIRE row
  // and a KEY-DEFECT row must never share one ranking, or a builder chasing
  // "the top of the worklist" would chase defects the rematch/repoint lanes
  // already own.
  const withRanks = rankWithinClassification(ranked);
  const csvHeader = ["classification", "rankWithinClassification", "sport", "year", "setKey", "prefix", "parallel", "isAuto", "printRun", "salesCount", "shareOfClassification", "cumulativeShareOfClassification", "distinctCardNumbers", "exampleTitle", "classificationDetail", "checklistinsiderUrl(GUESS)", "baseballcardpediaUrl(GUESS)", "cardboardconnectionUrl(GUESS)"];
  const csvLines = [csvHeader.join(",")];
  withRanks.forEach((r) => {
    const urlFor = (source) => (r.sourceUrls.find((u) => u.source === source) || {}).url || "";
    csvLines.push([
      r.classification, r.rankWithinClassification, r.sport, r.year, r.setKey, r.prefix, csvEscape(r.parallel), r.isAuto, r.printRun ?? "",
      r.salesCount, (r.shareOfClassification * 100).toFixed(2) + "%", (r.cumulativeShareOfClassification * 100).toFixed(2) + "%",
      r.distinctCardNumbers, csvEscape((r.exampleTitles[0] || "")), csvEscape(r.classificationDetail || ""),
      urlFor("checklistinsider"), urlFor("baseballcardpedia"), urlFor("cardboardconnection"),
    ].join(","));
  });
  fs.writeFileSync(path.join(outDir, "worklist.csv"), csvLines.join("\n") + "\n");

  const acquireRows = withRanks.filter((r) => r.classification === ACQUIRE_CLASSIFICATION);
  const defectRows = withRanks.filter((r) => r.classification !== ACQUIRE_CLASSIFICATION);

  // WORKLIST.md
  const md = [];
  md.push(`# Acquisition worklist — ${meta.sport}, ${meta.cells.map((c) => `${c.year}:${c.setKey}`).join(", ")}`);
  md.push("");
  md.push(`Read-only. Generated ${new Date().toISOString()}. Sample cap: ${meta.sample}/cell.`);
  md.push("");
  md.push("Every source URL below is a GUESS from a naming pattern (checklistinsider `/<year>-<product>-<sport>-checklist`, baseballcardpedia `index.php/<Year>_<Product>`, cardboardconnection `/<year>-<product>-<sport>-cards`) — **verify before acting**, none of these were fetched by this script.");
  md.push("");
  md.push("**Builders: only chase the ACQUIRE table below.** KEY-DEFECT / SPELLING / ISAUTO-DEFECT rows are cards that already exist in the catalog under a sibling key, a different parallel spelling, or the other auto flag — those are a rematch/repoint job, not an acquisition (PR #2439 review).");
  md.push("");
  const MD_TOP_N = Number(process.env.WORKLIST_MD_TOP_N || 200);

  const shownAcquire = acquireRows.slice(0, MD_TOP_N);
  md.push(`## ACQUIRE — ranked worklist (top ${f(shownAcquire.length)} of ${f(acquireRows.length)} genuinely-absent destination buckets, by sales count, cumulative share within ACQUIRE)`);
  md.push("");
  if (acquireRows.length > shownAcquire.length) {
    md.push(`Full ACQUIRE list is in \`worklist.csv\` (filter \`classification=ACQUIRE\`) next to this file.`);
    md.push("");
  }
  md.push("| Rank | Destination (sport/year/setKey/prefix/parallel/auto/printRun) | Sales | Share | Cumulative | Distinct #s | Example title | Guess URLs |");
  md.push("|---|---|---|---|---|---|---|---|");
  shownAcquire.forEach((r) => {
    const dest = `${r.sport}/${r.year}/${r.setKey}/${r.prefix}/${r.parallel}/${r.isAuto ? "auto" : "non-auto"}/${r.printRun ?? "-"}`;
    const urls = r.sourceUrls.map((u) => `[${u.source}](${u.url})`).join(", ");
    md.push(`| ${r.rankWithinClassification} | ${dest} | ${f(r.salesCount)} | ${(r.shareOfClassification * 100).toFixed(1)}% | ${(r.cumulativeShareOfClassification * 100).toFixed(1)}% | ${r.distinctCardNumbers} | ${mdEscape(r.exampleTitles[0] || "")} | ${urls} |`);
  });
  md.push("");

  const shownDefect = defectRows.slice(0, MD_TOP_N);
  md.push(`## Defect rows — NOT acquisition targets (top ${f(shownDefect.length)} of ${f(defectRows.length)}, ranked separately, by sales count within their own classification)`);
  md.push("");
  md.push("These sales already have a backed catalog row; they are misfiled (KEY-DEFECT: belongs under a sibling setKey), mis-spelled (SPELLING: same card, different parallel spelling) or mis-flagged (ISAUTO-DEFECT: same card, wrong auto flag). Fix lane: rematch/repoint, never a checklist acquisition.");
  md.push("");
  md.push("| Classification | Rank | Destination (sport/year/setKey/prefix/parallel/auto/printRun) | Sales | Found under | Example title |");
  md.push("|---|---|---|---|---|---|");
  shownDefect.forEach((r) => {
    const dest = `${r.sport}/${r.year}/${r.setKey}/${r.prefix}/${r.parallel}/${r.isAuto ? "auto" : "non-auto"}/${r.printRun ?? "-"}`;
    md.push(`| ${r.classification} | ${r.rankWithinClassification} | ${dest} | ${f(r.salesCount)} | ${mdEscape(r.classificationDetail || "-")} | ${mdEscape(r.exampleTitles[0] || "")} |`);
  });
  md.push("");

  md.push("## Per-cell summary (sample fraction, bucket shares, the two separated levers, and the ACQUIRE/KEY-DEFECT/SPELLING/ISAUTO-DEFECT split)");
  md.push("");
  md.push("| Cell | Sampled | Unbacked | Sample fraction | STALE-with-row (rematch lever) | ACQUIRE | KEY-DEFECT | SPELLING | ISAUTO-DEFECT |");
  md.push("|---|---|---|---|---|---|---|---|---|");
  for (const [cellKey, s] of Object.entries(perCellSummaries)) {
    const split = s.acquisitionVsDefectSplit || { acquire: 0, keyDefect: 0, spelling: 0, isAutoDefect: 0 };
    md.push(`| ${cellKey} | ${f(s.sampled)} | ${f(s.unbacked)} | ${(s.sampledFraction * 100).toFixed(2)}% | ${f(s.staleWithRowCount)} | ${f(split.acquire)} | ${f(split.keyDefect)} | ${f(split.spelling)} | ${f(split.isAutoDefect)} |`);
  }
  md.push("");
  fs.writeFileSync(path.join(outDir, "WORKLIST.md"), md.join("\n"));

  fs.writeFileSync(path.join(outDir, "per-cell-summary.json"), JSON.stringify(perCellSummaries, null, 2));
}

/**
 * Re-rank (and recompute share/cumulativeShare) SEPARATELY within each
 * `classification` value, so ACQUIRE's cumulative share reaches 100% over
 * ACQUIRE rows alone, never diluted by (or diluting) defect rows. Input rows
 * come from `rankAggregate`, already sorted globally; this re-sorts and
 * re-shares per classification group while preserving that same tie-break.
 */
function rankWithinClassification(ranked) {
  const groups = new Map(); // classification -> rows[]
  for (const r of ranked) {
    const cls = r.classification || ACQUIRE_CLASSIFICATION;
    if (!groups.has(cls)) groups.set(cls, []);
    groups.get(cls).push(r);
  }
  const out = [];
  for (const [cls, rows] of groups) {
    const total = rows.reduce((s, r) => s + r.salesCount, 0);
    let running = 0;
    rows.forEach((r, i) => {
      running += r.salesCount;
      out.push({
        ...r,
        classification: cls,
        rankWithinClassification: i + 1,
        shareOfClassification: total > 0 ? r.salesCount / total : 0,
        cumulativeShareOfClassification: total > 0 ? running / total : 0,
      });
    });
  }
  // Stable overall ordering: ACQUIRE first, then by rank within its group,
  // then the defect classifications in a fixed order.
  const order = { ACQUIRE: 0, "KEY-DEFECT": 1, SPELLING: 2, "ISAUTO-DEFECT": 3 };
  out.sort((a, b) => {
    const ao = order[a.classification] ?? 9;
    const bo = order[b.classification] ?? 9;
    if (ao !== bo) return ao - bo;
    return a.rankWithinClassification - b.rankWithinClassification;
  });
  return out;
}

function csvEscape(s) {
  const str = String(s ?? "");
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}
function mdEscape(s) {
  return String(s ?? "").replace(/\|/g, "\\|");
}

async function retry(fn, tries = 6) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const backoff = Math.min(30000, 500 * Math.pow(2, i));
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}
