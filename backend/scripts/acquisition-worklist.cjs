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
 * separate headroom and is not the container under RU pressure. Any
 * exact-id EXISTENCE check goes through `item(id, pk).read()` (a true
 * Cosmos point read, pk=/cardId), never a cross-partition query stopped on
 * the first empty page — see PAGINATION below.
 *
 * ── v2 FIXES (2026-09-27, live-trace evidence in C:/tmp/[name]_trace_[time]/RESULT.md) ─
 *
 * (1) KEY-DEFECT-BY-PLAYER. bc26_mojo_trace: a sale's FROM-product checklist
 *     row at the same cardNumber names a DIFFERENT player than the sale
 *     title (namesAgree false) while a SIBLING key's row at that number
 *     agrees. The old code either invented an ad-hoc parallel slug
 *     ("murakami-variation-mojo-refractor") or silently fell through the
 *     namesAgree gate to ACQUIRE. Now: `checkKeyDefectByPlayer` runs BEFORE
 *     resolveDefectOrAcquire's ordinary sibling search and reports
 *     KEY-DEFECT-BY-PLAYER explicitly whenever this exact shape fires — the
 *     from-key's own row for this number disagrees on player, a sibling's
 *     agrees — never inventing a parallel, never staying ACQUIRE.
 * (2) SPLIT-IDENTITY. prizm_ss/bc26 traces: `sale.hobbyiqCardId !== cardId`
 *     and the hobbyiqCardId side IS checklist-backed is a pool-split, not an
 *     unbacked sale — `lib/split-identity.cjs`'s `classifyIdentity` decides,
 *     reused (not re-derived), and counted in its own class/bucket, never
 *     folded into ACQUIRE or any DEFECT bucket.
 * (3) PAGINATION. idxrepro_2123: a manual `if (resources.length===0) break`
 *     loop undercounts 91% of cross-partition queries (empty intermediate
 *     pages are normal, NOT end-of-results). This file's own loops already
 *     drove entirely off `while(it.hasMoreResults())`, never item-count —
 *     `crossSetKeyProbeAsync` also switched to `.fetchAll()` (bounded TOP-N
 *     query) to make the contract explicit rather than implicit in a
 *     hand-rolled loop. `pointReadExact` below adds a TRUE point read
 *     (`item(id, pk).read()`, pk=/cardId) for exact-id existence checks —
 *     the only correct tool for "does this ONE id exist", never a query.
 * (4) AUTO-ONLY INSERT. prizm_ss_trace: `der.autoByCardNumber` (computed by
 *     deriveIdentity via `isCardNumberAutoSubset`, which already consults
 *     dist's scoped `isScopedAutoOnlyPrefix` table AND the always-auto
 *     cardNumber-prefix regex) was computed and then silently discarded —
 *     classifyOne never read it. A non-auto sale whose cardNumber is
 *     auto-only now reports ISAUTO-DEFECT immediately, without needing a
 *     backed row at the flipped auto value first (the number's own
 *     provenance is the evidence, not a lucky catalog hit).
 * (5) UNREGISTERED-PRODUCT. topps24_trace: "Topps Living[ Set]" sales mis-key
 *     under bare `topps` because `inferSetKeyFromTitle` has no token for it.
 *     `collectUnregisteredProductTokens` scans ACQUIRE-bound titles for a
 *     product-name word with zero setKey resolution and reports the top 20
 *     by sales count in WORKLIST.md — this is where real acquisition gaps
 *     live, per the coordinator's own framing.
 * (6) DERIVED-ONLY. bc26_mojo_trace: the exact id has a row, but its source
 *     is `derived` (catalogAuthorityOf(row.source) !== "checklist"), not a
 *     genuine checklist backing — a real card the parser filled in with a
 *     guess, not proof it is on the books. Reported as DERIVED-ONLY
 *     (acquisition ADOPTS/upgrades it with a real checklist source) rather
 *     than merged into either PRESENT (would hide the gap) or ACQUIRE-no-row
 *     (would ignore that a placeholder already exists).
 */
const fs = require("fs");
const path = require("path");

const { storedIdentity, deriveIdentity } = require(path.join(__dirname, "lib", "rematch-derive-identity.cjs"));
const K = require(path.join(__dirname, "lib", "rematch-classify.cjs"));
const { namesAgree } = require(path.join(__dirname, "lib", "name-agreement.cjs"));
const { classifyIdentity, HIQ_SPLIT } = require(path.join(__dirname, "lib", "split-identity.cjs"));

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
/**
 * Gather the ordered, deduped list of sibling setKey CANDIDATES that
 * resolveDefectOrAcquire's part (a) would probe for this sale/identity —
 * the year+setName-aware corrector, the parent/family/refinement walk, and
 * the hand-verified override table (never the cross-sport probe, which is
 * data-driven and can't be predicted ahead of a Cosmos round trip).
 *
 * Pulled out as its OWN function (PR #2439 review, defect 1, 2026-09-26) so
 * the CLI driver can call it BEFORE classifyOne runs and lazily
 * `await loadCatalogCell(year, siblingKey)` for every candidate — see the
 * driver's warmSiblingCells. Without this, io.getCellIndex(cell.year,
 * siblingKey) (below) only ever hits whatever the main FOR loop already
 * `await loadCatalogCell`'d for a DIFFERENT cell earlier in --setkeys/
 * --cells-from order — e.g. 2026:bowman-chrome processed before
 * 2026:bowman means every bowman-chrome sale's sibling probe of `bowman`
 * saw an EMPTY cache (getCellIndex returning `{rows: [], byNumber: new
 * Map()}` for a cell that simply hadn't been loaded yet, indistinguishable
 * from a cell that was loaded and is genuinely empty) and fell through to
 * ACQUIRE despite the sibling row being live in card_catalog.
 */
function resolveSiblingSetKeyCandidates(sale, cell, identity, io) {
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
  const seen = new Set([identity.setKey]);
  const deduped = [];
  for (const k of siblingCandidates) {
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(k);
  }
  return deduped;
}

/**
 * (1) KEY-DEFECT-BY-PLAYER (bc26_mojo_trace, C:/tmp/bc26_mojo_trace_1530/
 * RESULT.md, 2026-09-27). The bowman-chrome "murakami-variation-mojo-
 * refractor" shape: bowman-chrome #9's OWN checklist row names Cody
 * Bellinger, not the sale's Munetaka Murakami -- rungLookup's namesAgree
 * gate correctly refuses that pairing (`agree: false`), so it is never
 * mistaken for a same-product BACKED-DERIVED-ONLY/RUNG-MISSING rung. But
 * the OLD code then fell straight through the same-key checks (none of
 * which can fire without namesAgree) into the sibling search and the
 * cross-probe with NO SIGNAL that a from-key mismatch was ever seen -- and
 * when the parser had already minted an ad-hoc parallel segment for the
 * title ("murakami-variation-mojo-refractor") to keep the wrong-product
 * number from colliding with Bellinger's real row, that ad-hoc slug never
 * matched anything and the sale landed on ACQUIRE, laundering a real
 * cross-product misfile as a fresh checklist gap.
 *
 * THE CHECK: does the FROM-key (identity.setKey, the product this sale is
 * currently filed under) have a checklist-authority row at this exact
 * cardNumber whose player DISAGREES with the sale (namesAgree false) --
 * and does some OTHER, already-known-sibling setKey have a checklist row
 * at the SAME cardNumber whose player AGREES? That pairing is the proof:
 * the number is real and taken by someone else in THIS product, and the
 * sale's own card lives one product over. Reported as its own
 * classification (never invents a parallel, never silently falls to
 * ACQUIRE) so the repoint lane can redirect it directly, exactly like
 * ordinary KEY-DEFECT but flagged with WHY the same-key rung didn't match.
 *
 * Deliberately narrow: only fires when the from-key mismatch AND the
 * sibling agreement are BOTH true. A from-key row that simply doesn't
 * exist (no mismatch to explain) is left to the ordinary CARD-MISSING /
 * sibling-search path; a sibling row that also disagrees never qualifies
 * either -- see the namesAgree gate at the end of the sibling-loop filter
 * two lines below.
 */
function checkKeyDefectByPlayer(sale, cell, identity, cardNumber, io) {
  const playerName = sale.playerName || "";
  const { byNumber: fromByNumber } = io.getCellIndex(cell.year, identity.setKey);
  const fromHits = rungLookup(fromByNumber, cardNumber, identity.isAuto, identity.printRun, playerName);
  const fromKeyBackedDisagreeing = fromHits.filter((h) => io.isBacked(h.row) && !h.agree);
  if (!fromKeyBackedDisagreeing.length) return null;

  const siblingCandidates = resolveSiblingSetKeyCandidates(sale, cell, identity, io);
  for (const siblingKey of siblingCandidates) {
    if (siblingKey === identity.setKey) continue;
    const { byNumber } = io.getCellIndex(cell.year, siblingKey);
    const hits = rungLookup(byNumber, cardNumber, identity.isAuto, identity.printRun, playerName);
    const agreeing = hits.find((h) => io.isBacked(h.row) && h.agree);
    if (agreeing) {
      return {
        classification: "KEY-DEFECT-BY-PLAYER",
        foundUnderSetKey: siblingKey,
        foundRowId: agreeing.row.id,
        fromKeyWrongPlayer: fromKeyBackedDisagreeing[0].row.playerName || null,
      };
    }
  }
  return null;
}

function resolveDefectOrAcquire(sale, cell, identity, cardNumber, io) {
  const playerName = sale.playerName || "";

  // (1) KEY-DEFECT-BY-PLAYER runs FIRST, before the ordinary namesAgree-gated
  // sibling search below (which would simply find nothing and fall through
  // to ACQUIRE for this exact shape) -- see the function's own header.
  const byPlayer = checkKeyDefectByPlayer(sale, cell, identity, cardNumber, io);
  if (byPlayer) return byPlayer;

  // (a) SIBLING SETKEYS, in priority order: the year+setName-aware corrector
  // first (it is the one place R75-shaped splits like Mega Box actually
  // live), then the parent/family/refinement walk, then the hand-verified
  // override table, then a bounded cross-sport probe as the last, widest net.
  const siblingCandidates = resolveSiblingSetKeyCandidates(sale, cell, identity, io);
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

  // CF-ANY-RUNG-AT-THE-SAME-CARDNUMBER-IS-STILL-A-DEFECT (PR #2439 review,
  // defect 2, 2026-09-26: "2024/topps-holiday/Base 587 sales, RC- numbers").
  //
  // (b) and (c) above only fire when auto/printRun match on at least one of
  // the two axes (prMatch for SPELLING, prMatch+!autoMatch for ISAUTO-DEFECT)
  // -- they never cover a row that differs on BOTH isAuto and printRun AT
  // ONCE. Live proof: every RC-/EG-/HE-/TSA-/MLBO-/SDC-/HRC-/ARC- cardNumber
  // under topps-holiday is checklist-backed as a "Holiday Relics ... Memorabilia
  // Patch" row (isAuto=false, but serial-numbered, i.e. printRun set) while
  // the SALE is bucketed generic "Base" (isAuto=false, printRun=null read off
  // the sale, since the sale doc never carries the relic's actual serial
  // number) -- prMatch is false, autoMatch happens to be true, so neither (b)
  // nor (c) matches, and the sale fell through to ACQUIRE despite the exact
  // cardNumber being checklist-backed one segment over.
  //
  // RULE (task): ACQUIRE requires ZERO checklist-grade rows for this
  // cardNumber under this setKey across EVERY parallel/insert segment -- not
  // just the ones that happen to share this sale's auto/printRun reading. So
  // ANY namesAgree-gated backed hit at this cardNumber under the resolved
  // setKey, regardless of auto/printRun/parallel, means the card is already
  // on the books somewhere in this product; it is a bucketing defect
  // (mislabelled parallel/insert segment -- SPELLING) for the builder to
  // rename/reroute, never a fresh acquisition. This check is intentionally
  // the widest of the three same-setKey checks and runs last, after the
  // exact-rung SPELLING/ISAUTO-DEFECT reads above have had first claim on the
  // more specific label.
  //
  // This same widened check is also what should catch the "ad-hoc derived
  // parallel" class the coordinator flagged (2026-09-26): a sale whose
  // destination `parallel` reads as a slug fragment parseHobbyIqCardId
  // invented from title text ("image-variation", "image-variation-ssp",
  // "ssp-refractor", "short-print(s)") rather than a real checklist parallel
  // name -- e.g. 2022 topps-chrome #221 is NOT an "Image Variation", it is
  // whatever parallel the checklist actually names that row. Once (a) sibling
  // cells are correctly warmed (defect 1) and (b) this any-rung check runs,
  // any such sale whose cardNumber IS checklist-backed under its real
  // parallel resolves to SPELLING here rather than a fresh ACQUIRE -- no
  // separate ad-hoc-slug allowlist needed; it is subsumed by "any backed
  // rung at this cardNumber, any parallel, is a defect, not a gap."
  const anyRungBackedAgreeing = sameKeyBackedAgreeing[0];
  if (anyRungBackedAgreeing) {
    return {
      classification: "SPELLING",
      foundSpelling: anyRungBackedAgreeing.row.parallel,
      foundRowId: anyRungBackedAgreeing.row.id,
    };
  }

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
/**
 * (2) SPLIT-IDENTITY (prizm_ss_trace / bc26_mojo_trace, 2026-09-27). A sale
 * whose stored `cardId` and `hobbyiqCardId` name DIFFERENT hiq: slugs, where
 * the hobbyiqCardId side IS checklist-backed, is not an unbacked sale at
 * all -- it is `lib/split-identity.cjs`'s HIQ_SPLIT shape: the row is read
 * into TWO cards' pools (exactPoolReader.ts matches on either field), and
 * the fix is a pool-split repair, never a checklist acquisition. Reusing
 * `classifyIdentity` (not re-deriving the predicate) keeps this worklist's
 * reading identical to the census/rematch/invariant-auditor's own verdict
 * on the SAME row. Checked FIRST, before deriveIdentity even runs, because
 * the split is a property of the row's OWN two stored fields -- it needs no
 * title re-parse to detect, and a re-derivation could otherwise mask it by
 * quietly landing on yet a third slug.
 */
function checkSplitIdentity(row, io) {
  const c = classifyIdentity(row);
  if (c.klass !== HIQ_SPLIT) return null;
  const hiqRow = io.pointReadById ? io.pointReadById(row.hobbyiqCardId) : null;
  if (!isBacked(hiqRow)) return null; // damage exists, but not "the true card is backed" -- let ordinary classification proceed
  return {
    classification: "SPLIT-IDENTITY",
    cardId: c.cardId,
    hobbyiqCardId: c.hobbyiqCardId,
    segments: c.segments,
    foundRowId: hiqRow.id,
  };
}

function classifyOne(row, cell, deps, io) {
  const split = checkSplitIdentity(row, io);
  if (split) {
    return { name: "SPLIT-IDENTITY", detail: split, classification: "SPLIT-IDENTITY" };
  }

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

  // (4) AUTO-ONLY INSERT. `der.autoByCardNumber` is computed by
  // deriveIdentity (via deps.isCardNumberAutoSubset, which already consults
  // dist's SCOPED_AUTO_ONLY_PREFIXES table -- e.g. 2025 panini-prizm's
  // "SS-" Sensational Signatures rows -- AND the always-auto cardNumber
  // regex), but the field was silently discarded here before this fix. A
  // sale whose OWN cardNumber is auto-only by that provenance, yet is
  // stored/derived as non-auto, is a mislabel the number itself proves --
  // no backed row at the flipped auto value is required first (unlike the
  // ordinary (c) ISAUTO-DEFECT check in resolveDefectOrAcquire, which needs
  // a catalog hit to confirm). Checked right after der.ok so it fires
  // before the STALE/slug-redirect branch below ever runs.
  if (der.autoByCardNumber === true && der.identity.isAuto !== true) {
    return {
      name: "ISAUTO-DEFECT-AUTO-ONLY-INSERT",
      detail: { identity: der.identity, cardNumber: der.identity.cardNumber, reason: "cardNumber prefix is auto-only" },
      classification: "ISAUTO-DEFECT",
    };
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

  // (6) DERIVED-ONLY (bc26_mojo_trace, C:/tmp/bc26_mojo_trace_1530/RESULT.md,
  // 2026-09-27). A row can exist at the EXACT rung (same cardNumber/auto/
  // printRun/parallel) and still not be `isBacked` -- `isBacked` requires a
  // STRICT checklist source, and a row minted by `ingest-auto-seed` or any
  // other non-checklist writer is a real card the parser filled in with a
  // guess, not proof it is on the books. The OLD code had no way to tell
  // "a placeholder row is here" from "nothing is here at all" -- both fell
  // through to the SAME sibling/spelling/isAuto search and, on that
  // search's own failure, both landed on plain ACQUIRE, discarding the
  // fact that SOME row (however weakly sourced) already occupies this
  // exact address. `io.catalogAuthorityOf` (dist's catalogAuthority.service,
  // the SAME function every other authority-rank decision in this repo
  // uses) draws the checklist/derived/vendor/unknown line; "derived" here
  // means acquisition ADOPTS/upgrades this row with a real checklist
  // source, rather than treating it as either present (hides the gap) or
  // absent (ignores the placeholder). OPTIONAL: a caller without
  // `io.catalogAuthorityOf` wired just never reaches this branch (the same
  // hits array falls through to RUNG-MISSING/ACQUIRE exactly as before).
  const exactRungAnySource = hits.find(
    (h) => h.autoMatch && h.prMatch && normParallel(h.row.parallel) === normParallel(destinationIdentity.parallel),
  );
  if (exactRungAnySource && io.catalogAuthorityOf) {
    const authority = io.catalogAuthorityOf(exactRungAnySource.row.source);
    if (authority !== "checklist") {
      return {
        name: "DERIVED-ONLY",
        detail: { identity: destinationIdentity, cardNumber, id: exactRungAnySource.row.id, authority },
        classification: "DERIVED-ONLY",
      };
    }
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
 *  BACKED-DERIVED-ONLY) is reported but excluded from the acquisition rows.
 *  ISAUTO-DEFECT-AUTO-ONLY-INSERT (v2 defect 4) carries a destination
 *  identity exactly like RUNG-MISSING/CARD-MISSING, so it aggregates the
 *  same way. SPLIT-IDENTITY (v2 defect 2) is intentionally NOT in this set —
 *  it is a per-ROW pool-split finding, not a destination-identity bucket,
 *  and is counted separately by foldIntoAggregate below. */
const WORKLIST_BUCKETS = new Set(["STALE-NO-ROW", "RUNG-MISSING", "CARD-MISSING", "ISAUTO-DEFECT-AUTO-ONLY-INSERT", "DERIVED-ONLY"]);

/** Of the worklist-bound buckets, only classification ACQUIRE should ever
 *  reach a builder's ranked worklist — KEY-DEFECT/SPELLING/ISAUTO-DEFECT/
 *  KEY-DEFECT-BY-PLAYER/DERIVED-ONLY are routing/spelling/flag/upgrade
 *  defects the rematch/repoint/adoption lanes fix, not a gap. */
const ACQUIRE_CLASSIFICATION = "ACQUIRE";

/** SPLIT-IDENTITY findings (v2 defect 2) counted separately from every
 *  destination-identity bucket — see foldIntoAggregate's own branch and
 *  WORKLIST_BUCKETS' header comment for why. */
const SPLIT_IDENTITY_CLASSIFICATION = "SPLIT-IDENTITY";

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
  // SPLIT-IDENTITY (v2 defect 2): a per-ROW pool-split finding, not a
  // destination-identity bucket -- counted into its OWN dedicated key
  // (sport|year|SPLIT-IDENTITY) rather than aggregationKey's normal
  // (setKey, prefix, parallel, isAuto, printRun) shape, which this
  // classification's detail object never carries (it names cardId/
  // hobbyiqCardId/segments, not a destination rung). Kept in the SAME `agg`
  // map (not a separate structure) so rankAggregate/rankWithinClassification
  // need no new code path -- it just ranks alongside everything else under
  // its own classification group.
  if (classification.name === "SPLIT-IDENTITY") {
    const key = `split-identity|${String(sport || "").toLowerCase()}|${Number(year)}`;
    if (!agg.has(key)) {
      agg.set(key, {
        sport, year, setKey: null, prefix: "base", parallel: "Base", isAuto: false, printRun: null,
        classification: SPLIT_IDENTITY_CLASSIFICATION,
        classificationDetail: null,
        salesCount: 0,
        cardNumbers: new Set(),
        exampleTitles: [],
        buckets: {},
      });
    }
    const entry = agg.get(key);
    entry.salesCount += 1;
    if (entry.exampleTitles.length < 5 && sale && sale.title) entry.exampleTitles.push(sale.title);
    entry.buckets["SPLIT-IDENTITY"] = (entry.buckets["SPLIT-IDENTITY"] || 0) + 1;
    return agg;
  }

  if (!WORKLIST_BUCKETS.has(classification.name)) return agg;
  const identity = (classification.detail && classification.detail.identity) || {};
  const setKey = identity.setKey || null;
  // CF-CARDNUMBER-CAN-NEST-UNDER-IDENTITY (bb25 tracer, C:/tmp/bb25_trace_1530/
  // RESULT.md, 2026-09-26): classifyOne's STALE-NO-ROW branch (~line 362) sets
  // detail.identity.cardNumber but never a top-level detail.cardNumber, while
  // the RUNG-MISSING/CARD-MISSING branches set BOTH. Reading detail.cardNumber
  // alone silently reads `undefined` for every STALE-NO-ROW-sourced row, which
  // breaks extractInsertPrefix (falls back to the "base" bucket even for a
  // real "RC-GH"/"B25-..." prefixed number) AND distinctCardNumbers (stays 0
  // forever). Fall back to the nested identity.cardNumber so both derived
  // fields are correct regardless of which classifyOne branch produced this
  // detail object.
  const cardNumber = (classification.detail && classification.detail.cardNumber) ?? identity.cardNumber;
  const prefix = (classification.detail && classification.detail.prefix) || extractInsertPrefix(cardNumber) || null;
  const parallel = identity.parallel || "Base";
  const isAuto = identity.isAuto === true;
  const printRun = identity.printRun ?? null;
  const cls = classification.classification || ACQUIRE_CLASSIFICATION;
  // Human-readable qualifier for KEY-DEFECT(<setKey>) / SPELLING(<spelling>) /
  // KEY-DEFECT-BY-PLAYER(<setKey> + wrong-player name) / DERIVED-ONLY
  // (<authority>); ISAUTO-DEFECT / ACQUIRE / STALE carry none.
  const classificationDetail = cls === "KEY-DEFECT"
    ? (classification.detail && classification.detail.foundUnderSetKey) || null
    : cls === "SPELLING"
      ? (classification.detail && classification.detail.foundSpelling) || null
      : cls === "KEY-DEFECT-BY-PLAYER"
        ? (classification.detail
            ? `${classification.detail.foundUnderSetKey || "?"} (from-key row: ${classification.detail.fromKeyWrongPlayer || "?"})`
            : null)
        : cls === "DERIVED-ONLY"
          ? (classification.detail && classification.detail.authority) || null
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

/**
 * (5) UNREGISTERED-PRODUCT (topps24_trace, C:/tmp/topps24_trace_1530/
 * RESULT.md, 2026-09-27): "titles containing a product word with no setKey
 * -- e.g. 'Living' before #2444 -- report the top 20 tokens with sales
 * counts. This is where real acquisition gaps live." Pure, testable: a
 * caller supplies the ACQUIRE-bound sales this run already classified plus
 * the destination setKey each one landed on, and this function finds every
 * title WORD from a closed, product-name-shaped candidate list that is
 * PRESENT in the title but ABSENT from the destination setKey's own words
 * -- i.e. the parser filed the sale under a setKey whose name never
 * mentions this word, so whatever product the word names never got its own
 * key. "Living Set" is the exact motivating case: `inferSetKeyFromTitle`
 * resolves it to bare `topps`, but "living"/"set" appear nowhere in
 * "topps"'s own word set.
 *
 * The candidate word list is intentionally NOT "any word in the title" --
 * common words (Baseball, Card, PSA, grade numbers, player names) would
 * drown a real signal in noise. It is the closed set of product-shaped
 * words this program has actual evidence for (extended by any caller via
 * `extraTokens`), mirroring name-agreement.cjs's own closed-vocabulary
 * discipline rather than a generic NLP heuristic.
 */
const PRODUCT_TOKEN_CANDIDATES = [
  "living", "living set", "heritage", "archives", "stadium club", "gallery",
  "gypsy queen", "allen & ginter", "big league", "fire", "opening day",
  "chrome update", "chrome black", "chrome sapphire", "finest", "museum",
  "definitive", "diamond kings", "national treasures", "flawless", "immaculate",
  "obsidian", "select", "spectra", "mosaic", "donruss", "contenders",
  "chronicles", "phoenix", "absolute", "playbook", "leaf",
];

function collectUnregisteredProductTokens(acquireSales, extraTokens = []) {
  const candidates = [...PRODUCT_TOKEN_CANDIDATES, ...extraTokens].map((t) => t.toLowerCase());
  const byToken = new Map(); // token -> { salesCount, exampleTitle }
  for (const sale of acquireSales || []) {
    const title = String(sale.title || "");
    const titleLower = title.toLowerCase();
    const setKeyWords = new Set(String(sale.setKey || "").toLowerCase().split(/[-\s]+/).filter(Boolean));
    for (const token of candidates) {
      const tokenWords = token.split(/\s+/).filter(Boolean);
      // The token itself must appear as a substring/phrase in the title...
      if (!titleLower.includes(token)) continue;
      // ...AND none of the token's own words appear in the destination
      // setKey's own words -- if even one does, the product already has a
      // key that names this word (e.g. "chrome" in "topps-chrome"), so it
      // is registered, not a gap.
      if (tokenWords.some((w) => setKeyWords.has(w))) continue;
      if (!byToken.has(token)) byToken.set(token, { salesCount: 0, exampleTitle: title });
      const entry = byToken.get(token);
      entry.salesCount += 1;
    }
  }
  return [...byToken.entries()]
    .map(([token, v]) => ({ token, salesCount: v.salesCount, exampleTitle: v.exampleTitle }))
    .sort((a, b) => b.salesCount - a.salesCount);
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
  resolveSiblingSetKeyCandidates,
  checkKeyDefectByPlayer,
  checkSplitIdentity,
  resolveDefectOrAcquire,
  classifyOne,
  WORKLIST_BUCKETS,
  ACQUIRE_CLASSIFICATION,
  SPLIT_IDENTITY_CLASSIFICATION,
  aggregationKey,
  foldIntoAggregate,
  rankAggregate,
  rankWithinClassification,
  guessSourceUrls,
  collectUnregisteredProductTokens,
  PRODUCT_TOKEN_CANDIDATES,
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
  // BUG FIX (2026-09-26, found while regenerating the worklist for this PR):
  // "".split(",") is `[""]`, not `[]`, and Number("") is 0 -- which passes
  // Number.isFinite -- so an OMITTED --years flag silently produced YEARS =
  // [0] instead of []. resolveCells then treats a non-empty years array as a
  // real filter (`if (years.length) rows = rows.filter(...)`) and filters
  // every --cells-from row down to year===0, i.e. NOTHING, even though no
  // --years filter was ever asked for. Trim blanks BEFORE the Number() map so
  // an absent/empty --years flag produces [], matching --setkeys' own
  // (already-correct) `.filter(Boolean)` discipline.
  const YEARS = String(val("--years", "")).split(",").map((s) => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
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
  // v2 defect 6 (DERIVED-ONLY): the SAME authority classifier every other
  // checklist/derived/vendor/unknown decision in this repo uses, never a
  // re-guessed rule -- see classifyOne's own DERIVED-ONLY branch.
  const catAuth = d(["catalog", "catalogAuthority.service.js"]);

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

  // v2 defect 3 (PAGINATION, C:/tmp/idxrepro_2123/support-package/
  // SUPPORT-PACKAGE.md): the confirmed root cause elsewhere in this repo was
  // a manual `if (resources.length === 0) break` loop mistaking an empty
  // INTERMEDIATE page of a cross-partition query for end-of-results (Cosmos
  // routinely returns several empty pages before a data-bearing one; only
  // `hasMoreResults() === false` means done). This script's own cell loads
  // already drive off `while (it.hasMoreResults())` (never item-count), and
  // `pointReadById` above is an in-memory CACHE lookup, not a live query, so
  // neither had this bug. `pointReadExact` is the CORRECT tool this repo's
  // fixed investigation names for "does this ONE id exist": a true Cosmos
  // point read (`item(id, pk).read()`, pk=/cardId, cost ~1 RU, no fan-out,
  // no pagination loop of any kind to get wrong) rather than a query. Used
  // as a live-verification fallback when the in-memory cache has not (yet)
  // loaded this id's cell -- e.g. a cross-sport/cross-cell id the driver
  // never warmed -- so an absent cache entry is never silently read as
  // "does not exist" when a single point read would answer for certain.
  async function pointReadExact(id) {
    if (!id || !String(id).startsWith("hiq:")) return null;
    try {
      const { resource } = await retry(() => cat.item(id, id).read());
      return resource || null;
    } catch (e) {
      // 404 is a real, expected "does not exist" answer, not a failure to
      // retry away -- @azure/cosmos throws with e.code === 404 for a miss.
      if (e && (e.code === 404 || e.statusCode === 404)) return null;
      throw e;
    }
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
    pointReadExact,
    getCellIndex,
    isBacked,
    resolveSetKeyForSlug: resolveSetKeyForSlugDep,
    siblingSetKeysToAlsoCheck: siblingSetKeysToAlsoCheckDep,
    productAncestry: productAncestryDep,
    productRefinementsOf: productRefinementsOfDep,
    crossSetKeyProbe: crossSetKeyProbeSync,
    // v2 defect 6 (DERIVED-ONLY): the same checklist/derived/vendor/unknown
    // classifier every other authority decision in this repo uses.
    catalogAuthorityOf: catAuth.catalogAuthorityOf,
  };

  // PR #2439 review, defect 1 (2026-09-26): getCellIndex only ever reads the
  // cache — it has NO fallback to loadCatalogCell, so a sibling cell that the
  // main FOR loop below hasn't reached YET in --setkeys/--cells-from order
  // (e.g. 2026:bowman-chrome is processed before 2026:bowman) reads back an
  // empty Map indistinguishable from "loaded and genuinely empty", and every
  // sibling probe against it silently misses. classifyOne/resolveDefectOrAcquire
  // stay synchronous (see their own header comments), so this cannot be fixed
  // by making getCellIndex itself async -- instead, mirroring the cross-probe
  // pre-resolve-then-hand-down shape already used above, `warmSiblingCells`
  // derives the destination identity the SAME way classifyOne does (der.slug
  // via parseHobbyIqCardId, falling back to der.identity) and `await
  // loadCatalogCell`s every sibling-candidate setKey resolveDefectOrAcquire
  // could touch for THIS row -- lazily, memoized by loadCatalogCell's own
  // cellRowCache, so a setKey is never loaded twice regardless of how many
  // rows/cells reference it as a sibling.
  async function warmSiblingCells(row, cell) {
    let der;
    try {
      der = deriveIdentity(row, deps);
    } catch {
      return;
    }
    if (!der || !der.ok) return;
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
    // Always warm the destination's OWN cell too -- (b)/(c) in
    // resolveDefectOrAcquire read io.getCellIndex(cell.year, identity.setKey),
    // which is the destination setKey, not necessarily cell.setKey (the cell
    // this row was SAMPLED from) whenever der.slug redirects it.
    await loadCatalogCell(cell.year, destinationIdentity.setKey || cell.setKey);
    const siblingCandidates = resolveSiblingSetKeyCandidates(row, cell, destinationIdentity, io);
    for (const siblingKey of siblingCandidates) {
      await loadCatalogCell(cell.year, siblingKey);
    }
  }

  const perCellSummaries = {};
  const aggregate = new Map();
  const acquireSalesForTokenScan = []; // v2 defect 5: {title, setKey}[] for collectUnregisteredProductTokens

  for (const cell of cells) {
    console.log(`\n=== ${cell.sport} ${cell.year} ${cell.setKey} ===`);
    await loadCatalogCell(cell.year, cell.setKey);

    // PR #2439 review, defect 4 (2026-09-26): CardHedge-sourced sold_comps
    // rows do not reliably carry top-level c.sport/c.cardYear -- see
    // soldCompsStore.service.ts's own CF-SOLD-COMPS-SPORT comment ("320
    // cardhedge rows turned up with no sport"; sport?: string|null,
    // cardYear?: number|null are both optional on the writer's own SoldComp
    // type, populated by inferSportFromContext() at write time, NOT
    // guaranteed for every row). A predicate that ANDs c.sport=@sp AND
    // c.cardYear=@yr silently returns ZERO rows for a CardHedge doc missing
    // either field, even when thousands of that cell's sales exist -- the
    // cell reads as fully-backed-or-absent instead of sampling its real
    // population. Widen to an OR against the repo-wide convention for
    // scoping a cell by identity (STARTSWITH(c.hobbyiqCardId,...) /
    // STARTSWITH(c.cardId,...) against the 'hiq:<sport>:<year>:<setKey>:'
    // prefix -- the same prefix every other script in backend/scripts uses
    // to scope a container read, see e.g. hobbyIqFmv.service.ts's own
    // STARTSWITH(c.hobbyiqCardId, @stem)) so a row already resolved into
    // this cell's canonical id is caught even when c.sport/c.cardYear/
    // c.setName are absent or don't match. Rows keyed on setName ALONE
    // (never inferred a hiq: id yet) are still caught by the original
    // predicate; rows with NEITHER a matching setName NOR a resolved id in
    // this cell are, correctly, not part of this cell's population.
    const idPrefix = `hiq:${String(cell.sport).toLowerCase()}:${cell.year}:${String(cell.setKey).toLowerCase()}:`;
    const query = {
      query:
        "SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.setName, c.sport, c.cardYear, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.playerName, c.gradeCompany, c.gradeValue, c.source, c.sourceSystem, c.flaggedWrong, c.excludedFromFmv FROM c WHERE " +
        "(c.sport=@sp AND c.cardYear=@yr AND c.setName=@sk) " +
        "OR STARTSWITH(LOWER(c.hobbyiqCardId), @idp) OR STARTSWITH(LOWER(c.cardId), @idp)",
      parameters: [
        { name: "@sp", value: cell.sport }, { name: "@yr", value: cell.year }, { name: "@sk", value: cell.setKey },
        { name: "@idp", value: idPrefix },
      ],
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
        // PR #2439 review, defect 1: lazily load this row's destination cell
        // AND every sibling cell its defect search could touch, BEFORE the
        // (synchronous) classifyOne call below reads them via io.getCellIndex
        // -- see warmSiblingCells' own header comment for why getCellIndex
        // itself cannot do this (it has no async fallback and classifyOne
        // must stay sync).
        await warmSiblingCells(row, cell);
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
        // v2 defect 5 (UNREGISTERED-PRODUCT): collect every ACQUIRE-bound
        // sale's title + destination setKey for collectUnregisteredProductTokens
        // below -- see that function's own header for why this is scoped to
        // ACQUIRE only (a KEY-DEFECT/SPELLING/etc. sale already has a home,
        // it is not evidence of an unregistered product).
        if (cls === "ACQUIRE" && row.title) {
          const dest = (classification.detail && classification.detail.identity) || {};
          acquireSalesForTokenScan.push({ title: row.title, setKey: dest.setKey || cell.setKey });
        }
      }
      console.log(`  page ${pageNum} (RU ${Math.round(page.requestCharge || 0)}): sampled=${f(sampled)} unbacked=${f(cellStats.unbacked)}`);
    }

    perCellSummaries[`${cell.sport}|${cell.year}|${cell.setKey}`] = summarizeCell(cellStats);
  }

  const ranked = rankAggregate(aggregate).map((r) => ({ ...r, sourceUrls: guessSourceUrls(r.sport, r.year, r.setKey) }));
  const unregisteredTokens = collectUnregisteredProductTokens(acquireSalesForTokenScan);

  writeOutputs(OUT_DIR, ranked, perCellSummaries, { sport: SPORT, cells, sample: SAMPLE, unregisteredTokens });
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
  const derivedOnlyRows = withRanks.filter((r) => r.classification === "DERIVED-ONLY");
  const defectRows = withRanks.filter((r) => r.classification !== ACQUIRE_CLASSIFICATION);

  // Class totals (v2: "class totals incl. the new classes" -- every
  // classification this run produced, by sales count, computed straight off
  // `withRanks` so it can never drift from what the CSV/tables above show.
  const classTotals = new Map();
  for (const r of withRanks) {
    classTotals.set(r.classification, (classTotals.get(r.classification) || 0) + r.salesCount);
  }

  // WORKLIST.md
  const md = [];
  md.push(`# Acquisition worklist — ${meta.sport}, ${meta.cells.map((c) => `${c.year}:${c.setKey}`).join(", ")}`);
  md.push("");
  md.push(`Read-only. Generated ${new Date().toISOString()}. Sample cap: ${meta.sample}/cell.`);
  md.push("");
  md.push("Every source URL below is a GUESS from a naming pattern (checklistinsider `/<year>-<product>-<sport>-checklist`, baseballcardpedia `index.php/<Year>_<Product>`, cardboardconnection `/<year>-<product>-<sport>-cards`) — **verify before acting**, none of these were fetched by this script.");
  md.push("");
  md.push("**Builders: only chase the ACQUIRE table below.** KEY-DEFECT / KEY-DEFECT-BY-PLAYER / SPELLING / ISAUTO-DEFECT / SPLIT-IDENTITY rows are cards that already exist in the catalog under a sibling key, a different parallel spelling, the other auto flag, or a split pool — those are a rematch/repoint job, not an acquisition. DERIVED-ONLY rows already have a row at the exact address but it is not checklist-backed — acquisition ADOPTS/upgrades those, distinct from a genuine no-row gap (v2 fixes, 2026-09-27).");
  md.push("");
  const MD_TOP_N = Number(process.env.WORKLIST_MD_TOP_N || 200);

  md.push("## Class totals (sales, every classification this run produced)");
  md.push("");
  md.push("| Classification | Sales |");
  md.push("|---|---|");
  for (const [cls, sales] of [...classTotals.entries()].sort((a, b) => b[1] - a[1])) {
    md.push(`| ${cls} | ${f(sales)} |`);
  }
  md.push("");

  md.push(`## Top 5 ACQUIRE rows`);
  md.push("");
  md.push("| Rank | Destination | Sales | Example title |");
  md.push("|---|---|---|---|");
  acquireRows.slice(0, 5).forEach((r) => {
    const dest = `${r.sport}/${r.year}/${r.setKey}/${r.prefix}/${r.parallel}/${r.isAuto ? "auto" : "non-auto"}/${r.printRun ?? "-"}`;
    md.push(`| ${r.rankWithinClassification} | ${dest} | ${f(r.salesCount)} | ${mdEscape(r.exampleTitles[0] || "")} |`);
  });
  md.push("");

  md.push(`## Top 5 DERIVED-ONLY rows (row exists at the exact address, but not checklist-backed — acquisition ADOPTS these)`);
  md.push("");
  md.push("| Rank | Destination | Sales | Found authority | Example title |");
  md.push("|---|---|---|---|---|");
  derivedOnlyRows.slice(0, 5).forEach((r) => {
    const dest = `${r.sport}/${r.year}/${r.setKey}/${r.prefix}/${r.parallel}/${r.isAuto ? "auto" : "non-auto"}/${r.printRun ?? "-"}`;
    md.push(`| ${r.rankWithinClassification} | ${dest} | ${f(r.salesCount)} | ${mdEscape(r.classificationDetail || "-")} | ${mdEscape(r.exampleTitles[0] || "")} |`);
  });
  if (!derivedOnlyRows.length) md.push("| - | (none found this run) | - | - | - |");
  md.push("");

  if (meta.unregisteredTokens && meta.unregisteredTokens.length) {
    md.push(`## Top 20 UNREGISTERED-PRODUCT tokens (title carries a product word with NO setKey resolution — v2 defect 5; this is where real acquisition gaps live)`);
    md.push("");
    md.push("| Rank | Token | Sales | Example title |");
    md.push("|---|---|---|---|");
    meta.unregisteredTokens.slice(0, 20).forEach((t, i) => {
      md.push(`| ${i + 1} | ${mdEscape(t.token)} | ${f(t.salesCount)} | ${mdEscape(t.exampleTitle || "")} |`);
    });
    md.push("");
  }

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
  const order = {
    ACQUIRE: 0,
    "DERIVED-ONLY": 1,
    "KEY-DEFECT": 2,
    "KEY-DEFECT-BY-PLAYER": 3,
    SPELLING: 4,
    "ISAUTO-DEFECT": 5,
    "SPLIT-IDENTITY": 6,
  };
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
