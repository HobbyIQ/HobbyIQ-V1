#!/usr/bin/env node
/**
 * pricing-invariants.cjs — the PURE core of the pricing invariant auditor.
 *
 * CF-NEVER-AGAIN (Drew, 2026-09-02: "rather than fixing one — how can we
 * ensure this NEVER happens again"). Every pricing defect found the week of
 * 2026-08-27..09-02 was found the same way: Drew looked at a number, said "that
 * is wrong", and an adversarial recompute proved it. This file is that
 * recompute, written down.
 *
 * WHY A SHADOW PRICER. The auditor must be able to disagree with the engine.
 * If it called computeUnifiedPrice it would reproduce the engine's bugs exactly
 * and agree with itself forever — a thermometer built from the patient. So the
 * derivation here is INDEPENDENT: it reads the holding's identity, reads the
 * pool rows, and applies the doctrine ladder from scratch. It reuses only LEAF
 * utilities that are pure vocabulary (isExactPoolRung, parseGradeLabel) — never
 * a valuation path. A disagreement between the two is the finding.
 *
 * Consequently the shadow is deliberately SIMPLER than the engine and will not
 * match it to the cent. That is why invariant (c) uses a wide 25% band: it is
 * hunting for substitution (a different card, a different grade, a different
 * product priced this holding), not for rounding.
 *
 * The six defect shapes this exists to catch, all measured this week:
 *   1. NaN grade -> wrong tier      (#1640) -> RUNG-HONESTY / BASIS-IDENTITY
 *   2. pool-twin cross-product      (#1627) -> BASIS-IDENTITY
 *   3. base autos in refractor pool (#1624) -> BASIS-IDENTITY
 *   4. stale write racing a sale    (#1627) -> DETERMINISM
 *   5. phantom Pristine grades      (#1625) -> BASIS-IDENTITY (grade tier)
 *   6. empty pool priced self-comp  (#1622) -> SUBSTITUTION / RUNG-HONESTY
 *   7. split-identity pool bleed    (#1649) -> IDENTITY-COHERENCE
 *
 * Pure: no Cosmos, no clock beyond an injected `now`. The runner
 * (audit-pricing-invariants.cjs) supplies rows; the tests supply fakes.
 */
"use strict";

const path = require("path");
const backend = path.resolve(__dirname, "..", "..");
// The SPLIT-IDENTITY predicate, shared with the census and the rematch
// classifier so all three exempt exactly the same vendor shapes.
const { classifyIdentity } = require(path.join(__dirname, "split-identity.cjs"));

// LEAF UTILITIES ONLY. isExactPoolRung is the closed rung vocabulary
// (fmvRung.ts) and parseGradeLabel is the grade tokenizer — both pure, neither
// is a valuation path. Loading them from dist keeps ONE definition of the
// vocabulary: an auditor with its own copy of the rung list would silently stop
// auditing a rung the day one was added.
//
// Tests inject the same two functions directly from source (vitest resolves the
// .ts), so the suite never depends on a dist/ build — the builders-never-touch-
// the-canonical-tree rule means a missing dist must not read as a green audit.
function loadLeafUtilities() {
  const { isExactPoolRung } = require(path.join(backend, "dist", "services", "compiq", "fmvRung.js"));
  const { parseGradeLabel } = require(path.join(backend, "dist", "services", "portfolioiq", "gradeParser.js"));
  if (typeof isExactPoolRung !== "function" || typeof parseGradeLabel !== "function") {
    throw new Error("leaf utilities missing from dist/ — run `npm run build` before the audit");
  }
  return { isExactPoolRung, parseGradeLabel };
}

// ── Identity ────────────────────────────────────────────────────────────────

/** hiq:sport:year:setKey:cardNumber:parallel:auto[:num-N] */
function slugParts(slug) {
  const p = String(slug ?? "").split(":");
  if (p.length < 7 || p[0] !== "hiq") return null;
  const numSeg = p.slice(7).find((x) => /^num-\d+$/.test(x));
  return {
    sport: p[1], year: p[2], setKey: p[3], cardNumber: p[4],
    parallel: p[5], auto: p[6],
    printRun: numSeg ? Number(numSeg.slice(4)) : null,
    stem: p.slice(0, 7).join(":"),
  };
}

/** The PRODUCT a slug names: sport:year:setKey. Two identities may only share
 *  a pool when these agree — the #1627 rule, re-derived here rather than
 *  imported so the auditor can catch the guard itself regressing. */
function productIdentityOf(slug) {
  const p = slugParts(slug);
  return p ? `${p.sport}:${p.year}:${p.setKey}` : null;
}

/** The grade tier of a holding or a pool row, as a comparable token.
 *  "raw" when ungraded. NaN/unreadable grade values become "unreadable" —
 *  never silently a number, which is exactly the #1640 defect. */
function gradeTierOf(row, parseGradeLabel) {
  const company = String(row.gradeCompany ?? "").trim().toUpperCase();
  if (!company) {
    // A row with no company may still carry a grade label (vendor titles).
    const parsed = row.gradeLabel && parseGradeLabel ? parseGradeLabel(row.gradeLabel) : null;
    if (parsed) return `${parsed.gradeCompany} ${parsed.gradeValue}`;
    return "raw";
  }
  const raw = row.gradeValue;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return "unreadable";
  return `${company} ${n}`;
}

/** Is this holding graded? A holding with a company but an unreadable value is
 *  graded-but-unreadable: it must NEVER be priced as raw or as another tier. */
function isUnreadableGrade(row) {
  const company = String(row.gradeCompany ?? "").trim();
  if (!company) return false;
  const raw = row.gradeValue;
  if (raw === null || raw === undefined || raw === "") return true;
  const n = typeof raw === "number" ? raw : Number(raw);
  return !Number.isFinite(n);
}

// ── The doctrine ladder, re-derived ─────────────────────────────────────────

/** Sort newest-first by soldAt. */
function newestFirst(rows) {
  return [...rows].sort((a, b) => String(b.soldAt ?? "").localeCompare(String(a.soldAt ?? "")));
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The projected NEXT SALE from a pool's trend — never a median or a mean
 * (feedback_no_medians_project_next_sale). Least-squares over (days, price),
 * evaluated at now. Falls back to the last sale when the fit is degenerate.
 */
function projectNextSale(rows, nowMs) {
  const pts = rows
    .map((r) => ({ t: Date.parse(String(r.soldAt ?? "")), p: Number(r.price) }))
    .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.p) && x.p > 0);
  if (pts.length === 0) return null;
  if (pts.length < 3) {
    const newest = newestFirst(rows).find((r) => Number(r.price) > 0);
    return newest ? Number(newest.price) : null;
  }
  const xs = pts.map((x) => (x.t - nowMs) / 86400000);
  const ys = pts.map((x) => x.p);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  if (den === 0) return median(ys);
  const slope = num / den;
  const intercept = my - slope * mx;
  const projected = intercept; // evaluated at x = 0, i.e. now
  // A projection that walks off a cliff is not a market read; fall back to the
  // pool's own level rather than emitting a negative or absurd number.
  const med = median(ys);
  if (!Number.isFinite(projected) || projected <= 0) return med;
  if (med != null && (projected > med * 4 || projected < med / 4)) return med;
  return projected;
}

/** A self-comp is a sale the user themselves is the counterparty to. Doctrine:
 *  publish it, but LABELED, and never let it stand alone as three-independent
 *  evidence (project_self_comp_publish_labeled). */
function isSelfComp(row, userId) {
  if (row.isSelfComp === true) return true;
  const src = String(row.source ?? "");
  if (/^holding::/.test(String(row.id ?? ""))) return true;
  if (userId && String(row.userId ?? "") === String(userId) && /self|holding|user/i.test(src)) return true;
  return false;
}

const WINDOW_DAYS = 180;
const GRADED_TO_RAW_MIN_ROWS = 3;

/**
 * THE SHADOW DERIVATION. Given a holding and the rows that live under its
 * identities, derive a value and the rung that produced it — independently.
 *
 * Ladder, in order:
 *   1. exact pool     rows matching identity AND grade tier   -> exact-pool-*
 *   2. last sale      the same pool when thin (n < 3)         -> exact-pool-last-sale
 *   3. graded->raw    a raw holding, priced from its OWN graded
 *                     children through the empirical multiplier -> graded-pool-inverse
 *   4. nothing        no basis. An empty pool does NOT get a
 *                     number here — that is the point.
 *
 * Returns { value, rung, comps, poolSize, selfCompCount, notes }.
 */
function shadowDerive(holding, poolRows, opts) {
  const { parseGradeLabel } = opts.leaf;
  const nowMs = opts.nowMs;
  const userId = opts.userId ?? null;
  const gradeMultipliers = opts.gradeMultipliers ?? {};
  const notes = [];

  const identities = new Set(
    [holding.hobbyiqCardId, holding.cardId]
      .filter((x) => typeof x === "string" && x.trim())
      .map((x) => x.trim()),
  );

  // CF-A-UNION-IS-ONE-CARD, re-derived. Two identities may only pool together
  // when they name the SAME product. When they disagree the shadow prices from
  // hobbyiqCardId alone — the holding's own checklist identity.
  const idList = [...identities];
  let poolIdentities = idList;
  if (idList.length > 1) {
    const products = new Set(idList.map(productIdentityOf).filter(Boolean));
    if (products.size > 1) {
      const own = typeof holding.hobbyiqCardId === "string" ? holding.hobbyiqCardId.trim() : idList[0];
      poolIdentities = [own];
      notes.push(`union-refused: identities name ${products.size} products (${[...products].join(" vs ")}); priced single-sided from ${own}`);
    }
  }

  const since = new Date(nowMs - WINDOW_DAYS * 86400000).toISOString();
  const inScope = poolRows.filter((r) =>
    poolIdentities.includes(String(r.hobbyiqCardId ?? r.cardId ?? "")) &&
    Number(r.price) > 0 &&
    String(r.soldAt ?? "") >= since);

  const holdingTier = gradeTierOf(holding, parseGradeLabel);

  // An unreadable grade is a MISSING answer, not a licence to answer about a
  // different grade (#1640). The shadow refuses rather than substituting.
  if (holdingTier === "unreadable") {
    notes.push("grade unreadable — refusing to price from any tier");
    return { value: null, rung: "no-basis", comps: [], poolSize: inScope.length, selfCompCount: 0, notes, holdingTier, poolIdentities };
  }

  const exact = inScope.filter((r) => gradeTierOf(r, parseGradeLabel) === holdingTier);
  const selfComps = exact.filter((r) => isSelfComp(r, userId));
  const independent = exact.filter((r) => !isSelfComp(r, userId));

  // Self-comps publish LABELED but never alone constitute the market. When the
  // only evidence is the user's own purchase, the shadow says so.
  if (exact.length > 0 && independent.length === 0) {
    notes.push(`pool is ${exact.length} self-comp(s) only — labeled, not independent evidence`);
    const v = projectNextSale(newestFirst(exact), nowMs);
    return {
      value: v, rung: "self-comp-only", comps: exact, poolSize: inScope.length,
      selfCompCount: selfComps.length, notes, holdingTier, poolIdentities,
    };
  }

  if (independent.length >= 3) {
    const v = projectNextSale(newestFirst(independent), nowMs);
    return {
      value: v, rung: "exact-pool-projection", comps: independent, poolSize: inScope.length,
      selfCompCount: selfComps.length, notes, holdingTier, poolIdentities,
    };
  }

  if (independent.length >= 1) {
    const newest = newestFirst(independent)[0];
    notes.push(`thin pool (n=${independent.length}) — last sale stands`);
    return {
      value: Number(newest.price), rung: "exact-pool-last-sale", comps: independent,
      poolSize: inScope.length, selfCompCount: selfComps.length, notes, holdingTier, poolIdentities,
    };
  }

  // GRADED-TO-RAW RUNG (Drew, 2026-08-31). An empty RAW pool may price from
  // THIS identity's OWN graded children, divided by the empirical multiplier.
  // Same identity only — never another card, never cross-auto.
  if (holdingTier === "raw") {
    const byTier = new Map();
    for (const r of inScope) {
      const t = gradeTierOf(r, parseGradeLabel);
      if (t === "raw" || t === "unreadable") continue;
      if (!byTier.has(t)) byTier.set(t, []);
      byTier.get(t).push(r);
    }
    let best = null;
    for (const [tier, rows] of byTier) {
      const mult = gradeMultipliers[tier];
      if (!Number.isFinite(mult) || mult <= 0) continue;
      if (rows.length < GRADED_TO_RAW_MIN_ROWS) continue;
      if (!best || rows.length > best.rows.length) best = { tier, rows, mult };
    }
    if (best) {
      const gradedValue = projectNextSale(newestFirst(best.rows), nowMs);
      if (gradedValue != null) {
        notes.push(`raw pool empty — priced from own ${best.tier} children (n=${best.rows.length}) / ${best.mult}x`);
        return {
          value: gradedValue / best.mult, rung: "graded-pool-inverse", comps: best.rows,
          poolSize: inScope.length, selfCompCount: 0, notes, holdingTier, poolIdentities,
        };
      }
    }
  }

  notes.push(`no comps in the exact (${holdingTier}) pool within ${WINDOW_DAYS}d`);
  return { value: null, rung: "no-basis", comps: [], poolSize: inScope.length, selfCompCount: selfComps.length, notes, holdingTier, poolIdentities };
}

// ── The invariants ──────────────────────────────────────────────────────────

const DIVERGENCE_PCT = 0.25;

/** The rungs that DECLARE a transition away from the holding's own exact
 *  (identity, grade) pool. A basis row that crosses grade or identity is only
 *  legitimate when the persisted rung says it did. */
const TRANSITION_RUNGS = new Set([
  "cross-grade-fallback",
  "grade-cross-raw",
  "grade-curve-estimate",
  "graded-pool-inverse",
  "rare-card-anchor",
  "sibling-estimate",
]);

/**
 * (a) BASIS-IDENTITY — every comp the persisted price cites must share the
 * holding's product + parallel + printRun + grade tier, UNLESS the persisted
 * rung declares the transition.
 *
 * This is the invariant that catches #1627 (two products in one pool), #1624
 * (base autos in a refractor pool) and #1625 (a phantom Pristine grade putting
 * raw sales in a PSA 10 pool).
 */
function checkBasisIdentity(holding, basisRows, shadow, leaf) {
  const violations = [];
  const rung = typeof holding.fmvRung === "string" ? holding.fmvRung : null;
  const declaresTransition = rung !== null && TRANSITION_RUNGS.has(rung);
  const holdingProduct = productIdentityOf(holding.hobbyiqCardId ?? holding.cardId);
  const holdingSlug = slugParts(holding.hobbyiqCardId ?? holding.cardId);
  const holdingTier = shadow.holdingTier;

  for (const row of basisRows) {
    const rowId = String(row.hobbyiqCardId ?? row.cardId ?? "");
    const rowProduct = productIdentityOf(rowId);
    const rowSlug = slugParts(rowId);
    const rowTier = gradeTierOf(row, leaf.parseGradeLabel);

    // Product is NEVER excused by a rung: no rung in the vocabulary licenses
    // pricing a 2026 Topps Chrome card off a 2024 Bowman Draft sale.
    if (holdingProduct && rowProduct && holdingProduct !== rowProduct) {
      violations.push({
        kind: "cross-product",
        detail: `comp ${row.id} is ${rowProduct}, holding is ${holdingProduct}`,
        compId: row.id ?? null, price: Number(row.price) || null, soldAt: row.soldAt ?? null,
      });
      continue;
    }
    if (holdingSlug && rowSlug && holdingSlug.parallel !== rowSlug.parallel && !declaresTransition) {
      violations.push({
        kind: "cross-parallel",
        detail: `comp ${row.id} is parallel "${rowSlug.parallel}", holding is "${holdingSlug.parallel}" (rung ${rung ?? "null"} declares no transition)`,
        compId: row.id ?? null, price: Number(row.price) || null, soldAt: row.soldAt ?? null,
      });
      continue;
    }
    if (holdingSlug && rowSlug && holdingSlug.auto !== rowSlug.auto && !declaresTransition) {
      violations.push({
        kind: "cross-auto",
        detail: `comp ${row.id} is "${rowSlug.auto}", holding is "${holdingSlug.auto}"`,
        compId: row.id ?? null, price: Number(row.price) || null, soldAt: row.soldAt ?? null,
      });
      continue;
    }
    const holdingPr = holdingSlug ? holdingSlug.printRun : null;
    const rowPr = rowSlug ? rowSlug.printRun : (typeof row.printRun === "number" ? row.printRun : null);
    if (holdingPr != null && rowPr != null && holdingPr !== rowPr && !declaresTransition) {
      violations.push({
        kind: "cross-printrun",
        detail: `comp ${row.id} is /${rowPr}, holding is /${holdingPr}`,
        compId: row.id ?? null, price: Number(row.price) || null, soldAt: row.soldAt ?? null,
      });
      continue;
    }
    if (holdingTier !== "unreadable" && rowTier !== holdingTier && !declaresTransition) {
      violations.push({
        kind: "cross-grade",
        detail: `comp ${row.id} is tier "${rowTier}", holding is "${holdingTier}" (rung ${rung ?? "null"} declares no transition)`,
        compId: row.id ?? null, price: Number(row.price) || null, soldAt: row.soldAt ?? null,
      });
    }
  }
  return violations;
}

/**
 * (e) IDENTITY-COHERENCE — no row reached by this holding's pool read may
 * contradict ITSELF.
 *
 * CF-A-SPLIT-ROW-POLLUTES-TWO-POOLS (Drew, 2026-09-02: "we need to go back and
 * check ALL this way"). Every other invariant here compares a comp against the
 * HOLDING. This one compares a comp against itself, and it catches a defect
 * none of the others can see.
 *
 * A sold_comps row carries two identity fields, and exactPoolReader.ts matches
 * on EITHER of them:
 *
 *     WHERE (c.cardId = @cid OR c.hobbyiqCardId = @hiq ...)
 *
 * So a row whose `cardId` and `hobbyiqCardId` name DIFFERENT cards is read into
 * BOTH pools, and prices two cards off one sale. BASIS-IDENTITY cannot catch
 * it: that check reads `row.hobbyiqCardId ?? row.cardId`, so it sees ONE of the
 * two identities -- whichever it picks agrees with the holding, because that is
 * the field the query matched on. The row looks like a perfectly legitimate
 * member of the pool it was asked for, every single time it is asked. The
 * contradiction is only visible by reading BOTH fields off the same row.
 *
 * THE VENDOR EXEMPTION IS LOAD-BEARING (#1650). A vendor ingest partitions its
 * rows under the vendor's product id and carries our slug beside it, so the two
 * fields disagree BY CONSTRUCTION on 13.5M CardHedge rows. Flagging those would
 * make this invariant fire on almost every holding in the portfolio and the
 * real damage would never be found. lib/split-identity.cjs owns the predicate
 * so the census, the rematch classifier and this auditor all exempt exactly the
 * same shapes -- and the mutation check proves that dropping it turns the
 * control shape red.
 *
 * The violation QUOTES THE ROW, because the repair needs both addresses: the
 * pool the row sits in and the pool its slug names are both wrong by one row.
 */
function checkIdentityCoherence(holding, poolRows) {
  const violations = [];
  for (const row of poolRows) {
    const c = classifyIdentity(row);
    if (!c.split) continue;
    violations.push({
      kind: `split-identity/${c.klass}`,
      detail: `comp ${row.id ?? "(no id)"} contradicts itself: cardId="${c.cardId || "(empty)"}" vs hobbyiqCardId="${c.hobbyiqCardId || "(empty)"}"`
        + `${c.segments?.length ? ` (differs on ${c.segments.join(",")})` : ""}`
        + ` — the pool reader ORs both fields, so this sale is priced into both cards`,
      compId: row.id ?? null,
      price: Number(row.price) || null,
      soldAt: row.soldAt ?? null,
      cardId: c.cardId || null,
      hobbyiqCardId: c.hobbyiqCardId || null,
      segments: c.segments ?? [],
    });
  }
  return violations;
}

/**
 * (b) RUNG HONESTY — a persisted exact-pool rung must be backed by an exact
 * pool the shadow can actually find. An "exact-pool-*" label over zero exact
 * comps is the #1640 shape: the engine believed it read a tier that does not
 * exist.
 */
function checkRungHonesty(holding, shadow, leaf) {
  const rung = typeof holding.fmvRung === "string" && holding.fmvRung ? holding.fmvRung : null;
  const violations = [];

  // CF-A-MISSING-KEY-IS-A-FINDING (C-7, 2026-09-03). This check used to
  // `return []` the moment a holding had no rung — so the 53 holdings that
  // carried a stored value and NO `fmvRung` key at all were not merely
  // unflagged, they were the one shape the auditor could never see. A detector
  // whose blind spot is "the writer never labelled it" cannot find an
  // unlabelled writer.
  //
  // The three states are now distinguished, and only the middle one is silent:
  //   - a value with NO rung key       -> a legacy writer wrote it (RED)
  //   - a value with fmvRung === null  -> a lane that HONESTLY names no rung
  //                                       (the resolver fallback, the ladder);
  //                                       null is a statement, not an absence
  //   - a value with a rung string     -> checked against the shadow below
  //
  // Absence of `valueSource` is folded into the same finding rather than its
  // own: the two keys are written together by every non-legacy writer, so one
  // missing key and both missing keys have the same cause and the same fix.
  const hasValue = typeof holding.fairMarketValue === "number" && holding.fairMarketValue > 0;
  const rungKeyAbsent = !("fmvRung" in holding);
  const valueSourceAbsent = !("valueSource" in holding)
    || holding.valueSource === null
    || holding.valueSource === undefined;
  if (hasValue && (rungKeyAbsent || valueSourceAbsent)) {
    const missing = [
      rungKeyAbsent ? "fmvRung" : null,
      valueSourceAbsent ? "valueSource" : null,
    ].filter(Boolean);
    violations.push({
      kind: "value-carries-no-rung",
      detail: `holding stores fairMarketValue=${holding.fairMarketValue} but carries no ${missing.join(" and no ")} key — written by a legacy writer that never named its rung, so no rung gate can classify it (source=${holding.source ?? "(none)"}, cardStatus=${holding.cardStatus ?? "(none)"})`,
      rung: null,
      shadowRung: shadow.rung,
    });
  }

  if (rung === null) return violations;
  if (!leaf.isExactPoolRung(rung)) return violations;

  const independentComps = shadow.rung === "self-comp-only" ? 0 : shadow.comps.length;
  if (independentComps === 0) {
    violations.push({
      kind: "rung-claims-empty-pool",
      detail: `persisted fmvRung="${rung}" claims the exact (${shadow.holdingTier}) pool, but the shadow finds ${independentComps} independent comps there (pool under these identities: ${shadow.poolSize} rows)`,
      rung,
      shadowRung: shadow.rung,
    });
  }
  if (shadow.rung === "self-comp-only") {
    violations.push({
      kind: "rung-over-self-comps",
      detail: `persisted fmvRung="${rung}" reads as market evidence, but every comp in the exact pool is a self-comp (${shadow.selfCompCount})`,
      rung,
      shadowRung: shadow.rung,
    });
  }
  return violations;
}

/**
 * (c) SUBSTITUTION — the persisted value against the shadow value. A gap wider
 * than 25% means the engine and an independent read of the same pool disagree
 * about what this card is worth, which in every case this week meant the
 * engine had priced a DIFFERENT card. Never auto-corrected: evidence only.
 */
function checkSubstitution(holding, shadow) {
  const persisted = persistedValueOf(holding);
  if (persisted == null || shadow.value == null) return [];
  if (!(persisted > 0) || !(shadow.value > 0)) return [];
  const ratio = persisted > shadow.value ? persisted / shadow.value : shadow.value / persisted;
  const deltaPct = Math.abs(persisted - shadow.value) / shadow.value;
  if (deltaPct <= DIVERGENCE_PCT) return [];
  return [{
    kind: "value-divergence",
    detail: `persisted $${persisted.toFixed(2)} vs shadow $${shadow.value.toFixed(2)} (${(deltaPct * 100).toFixed(1)}% off, ${ratio.toFixed(2)}x) via shadow rung ${shadow.rung} over ${shadow.comps.length} comps`,
    persisted, shadow: shadow.value, deltaPct, ratio,
  }];
}

/**
 * (d) DETERMINISM — the same comps must produce the same number. When the
 * provenance fingerprint is unchanged since the last audit but the value moved,
 * something non-deterministic (a stale write racing a sale, a window flap)
 * decided this price. #1627's 10.4x cron alternation is this shape.
 */
function checkDeterminism(holding, basisRows, previous) {
  if (!previous) return [];
  const nowFp = provenanceFingerprint(basisRows);
  const persisted = persistedValueOf(holding);
  if (previous.fingerprint == null || nowFp == null) return [];
  if (previous.fingerprint !== nowFp) return [];
  if (previous.value == null || persisted == null) return [];
  if (Math.abs(previous.value - persisted) < 0.005) return [];
  return [{
    kind: "nondeterministic-value",
    detail: `provenance unchanged (fingerprint ${nowFp}) since ${previous.at ?? "last audit"} but value moved $${previous.value.toFixed(2)} -> $${persisted.toFixed(2)}`,
    previous: previous.value, current: persisted, fingerprint: nowFp,
  }];
}

/** A stable fingerprint of the comps a price cites — sorted ids, so ordering
 *  never registers as a change. Null when there is nothing to fingerprint. */
function provenanceFingerprint(basisRows) {
  const ids = basisRows.map((r) => String(r.id ?? "")).filter(Boolean).sort();
  if (!ids.length) return null;
  let h = 5381;
  const s = ids.join("|");
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${ids.length}:${h.toString(16)}`;
}

/** The number the holding actually shows: observed FMV, else the estimate. */
function persistedValueOf(h) {
  const fmv = h.fairMarketValue;
  if (typeof fmv === "number" && Number.isFinite(fmv) && fmv > 0) return fmv;
  const est = h.estimatedValue;
  if (typeof est === "number" && Number.isFinite(est) && est > 0) return est;
  return null;
}

/**
 * Audit ONE holding against its pool. Returns the finding record.
 *
 * `basisRows` are the comps the PERSISTED price cites (from provenance);
 * `poolRows` are every row under the holding's identities, for the shadow.
 */
function auditHolding(holding, { basisRows = [], poolRows = [], previous = null, nowMs, userId, gradeMultipliers, leaf }) {
  const shadow = shadowDerive(holding, poolRows, { nowMs, userId, gradeMultipliers, leaf });
  const findings = [];
  const push = (invariant, list) => {
    for (const v of list) findings.push({ invariant, ...v });
  };
  push("BASIS-IDENTITY", checkBasisIdentity(holding, basisRows, shadow, leaf));
  push("RUNG-HONESTY", checkRungHonesty(holding, shadow, leaf));
  push("SUBSTITUTION", checkSubstitution(holding, shadow));
  push("DETERMINISM", checkDeterminism(holding, basisRows, previous));
  // Reads poolRows, not basisRows: the question is what the pool READ reached,
  // which is every row the OR-query returned, whether or not the persisted
  // price ended up citing it. A split row that was read and then filtered out
  // by a window or an anomaly flag is still a split row in that pool.
  push("IDENTITY-COHERENCE", checkIdentityCoherence(holding, poolRows));
  return {
    holdingId: holding.id ?? null,
    userId: userId ?? null,
    slug: holding.hobbyiqCardId ?? holding.cardId ?? null,
    persisted: persistedValueOf(holding),
    persistedRung: holding.fmvRung ?? null,
    shadowValue: shadow.value,
    shadowRung: shadow.rung,
    shadowComps: shadow.comps.length,
    poolSize: shadow.poolSize,
    notes: shadow.notes,
    fingerprint: provenanceFingerprint(basisRows),
    findings,
  };
}

module.exports = {
  loadLeafUtilities,
  slugParts,
  productIdentityOf,
  gradeTierOf,
  isUnreadableGrade,
  projectNextSale,
  isSelfComp,
  shadowDerive,
  checkBasisIdentity,
  checkRungHonesty,
  checkSubstitution,
  checkDeterminism,
  checkIdentityCoherence,
  provenanceFingerprint,
  persistedValueOf,
  auditHolding,
  DIVERGENCE_PCT,
  WINDOW_DAYS,
  TRANSITION_RUNGS,
};
