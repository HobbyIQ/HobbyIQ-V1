// CF-VALUATION-REPORT (Drew, 2026-09-02): an exportable valuation report.
//
// A dated, print-perfect page a collector can hand to an insurer, a
// consignor, or their own records: every holding with its canonical FMV,
// the RUNG that produced it, the basis prose, confidence, and the as-of
// timestamp — then totals, a methodology page in the site's own
// speculation/empirical language, and a disclaimer that says what this
// document is and is not.
//
// WHY HTML AND NOT PDF. The backend has no PDF library (checked
// 2026-09-02: no pdfkit / puppeteer / jspdf / pdf-lib anywhere in
// backend/package.json, and `playwright` is a devDependency, so it is not
// present in the App Service runtime). Adding a headless-Chrome
// dependency to ship one document would be a heavy dep for a page the
// browser can already print, so this renders a self-contained,
// print-perfect HTML document: @page margins, page-break control, and
// print colour-adjust so "Save as PDF" from any browser produces the
// artifact. The user gets a PDF; we do not carry a renderer to make one.
//
// WHAT THIS MODULE DOES NOT DO. It does not price anything. Every number
// it prints is read off the holding wire that the portfolio list already
// serves, through the SAME helpers the web dashboard renders (the rung
// vocabulary of fmvRung.ts, the envelope of pricingEnvelope.builder.ts).
// A report that recomputed a value could disagree with the app, and a
// valuation document that disagrees with the app it came from is worse
// than no document. No valuation change: this is a read.
//
// PROVENANCE IS THE POINT. Drew's rule is that speculative and
// own-purchase-anchored values carry their labels IN the report — not in
// a footnote, and not stripped on export because the number looks
// cleaner without them. `classifyProvenance` below assigns every holding
// exactly one class, and the row renderer prints that class's label
// beside the number. A value we cannot substantiate says so on the page.

import type { PortfolioHoldingWire } from "./responseAssembly.js";
import { describeRung, type RungDescription } from "./reportRung.js";

// ─── Provenance classes ─────────────────────────────────────────────────

/**
 * The provenance classes a report row can carry. This mirrors the
 * `PricingHeadline.valueSource` enum (observed | estimated | cost-proxy |
 * unpriced), with `speculative` split out of the estimate class because
 * it is the one Drew named: a value carried on a player index off a cold
 * anchor is an estimate, but it is not the same KIND of claim as a grade-
 * curve fill, and the report must not let the two read alike.
 */
export type ReportProvenanceClass =
  /** An exact-pool rung: real sales of this exact card at this exact tier. */
  | "observed"
  /** A fallback rung: real sales, but of another grade / parallel / card. */
  | "estimated"
  /** `player-index-projection`, or a stale anchor: today's market applied
   *  to an old print. Carries the speculative label. */
  | "speculative"
  /** No market value at all — the number shown is the user's OWN purchase
   *  price standing in for one. Carries the own-purchase label. */
  | "own-purchase"
  /** No number of any kind. */
  | "unpriced";

/** The label printed beside a value of each class. Empty for `observed`:
 *  an observed number is the unmarked case, and labelling it would dilute
 *  the labels that matter. */
export const PROVENANCE_LABEL: Record<ReportProvenanceClass, string> = {
  observed: "",
  estimated: "ESTIMATE",
  speculative: "SPECULATIVE",
  "own-purchase": "OWN PURCHASE — NOT A MARKET VALUE",
  unpriced: "NOT PRICED",
};

/** One-line explanation of each class, printed in the report's legend so
 *  a reader who has never seen the app can read the table. */
export const PROVENANCE_LEGEND: Record<ReportProvenanceClass, string> = {
  observed:
    "Read from sales of this exact card at this exact grade.",
  estimated:
    "Derived from related sales — another grade of this card, a sibling parallel, or the card family — not from this card at this grade.",
  speculative:
    "This card's own market has gone cold. The value carries its last real sale forward on the player's market: today's market applied to an old print, not a recent trade.",
  "own-purchase":
    "No market value could be produced for this card. The figure shown is what YOU paid for it, carried at cost. It is not a market valuation and no comparable sales support it.",
  unpriced:
    "No value could be produced and no cost basis was recorded.",
};

/** Days past which an anchor sale is too old to read as current. Mirrors
 *  the web's STALE_COMP_DAYS (apps/web/src/lib/rung.ts) — the same line
 *  the dashboard's speculation chip uses, so the report and the app agree
 *  about which values are cold. */
export const STALE_COMP_DAYS = 45;

/** The rung whose provenance IS speculation (fmvRung.ts). */
const SPECULATIVE_RUNG = "player-index-projection";

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The rung label a holding's price carries, read the way the web reads
 *  it: the envelope first, then the flat `fmvRung`. Nothing is inferred
 *  from prose. */
export function rungLabelOf(h: PortfolioHoldingWire): string | null {
  const p = (h as { pricing?: {
    method?: { ladderRung?: string | null } | null;
    provenance?: { pricingSourceMeta?: { method?: string | null } | null } | null;
  } | null }).pricing ?? null;
  return (
    p?.method?.ladderRung
    ?? p?.provenance?.pricingSourceMeta?.method
    ?? (h as { fmvRung?: string | null }).fmvRung
    ?? null
  );
}

/** Pool size behind the number, for the rung phrase. */
export function compsUsedOf(h: PortfolioHoldingWire): number | null {
  const p = (h as { pricing?: {
    method?: { compsUsed?: number | null } | null;
    provenance?: { pricingSourceMeta?: { compsUsed?: number | null } | null } | null;
  } | null }).pricing ?? null;
  return finiteOrNull(p?.method?.compsUsed ?? p?.provenance?.pricingSourceMeta?.compsUsed ?? null);
}

const DAY_MS = 86_400_000;

/**
 * Age in days of the newest direct sale behind this number, when known.
 *
 * The portfolio wire does not carry price-by-id's `daysSinceNewestComp`
 * (that field is on the card-detail response, not on a holding), so the
 * age is derived from the envelope's `provenance.lastSaleSurface.date` —
 * the single trusted last-sale surface on a persisted holding. A holding
 * whose writer recorded no last sale returns null, and a null age never
 * marks a row stale: a value we cannot date is not told it is old.
 */
export function compAgeDaysOf(h: PortfolioHoldingWire, now: number = Date.now()): number | null {
  const direct = finiteOrNull((h as { daysSinceNewestComp?: number | null }).daysSinceNewestComp ?? null);
  if (direct !== null) return direct;

  const date = (h as { pricing?: {
    provenance?: { lastSaleSurface?: { date?: string | null } | null } | null;
  } | null }).pricing?.provenance?.lastSaleSurface?.date ?? null;
  if (typeof date !== "string" || !date.trim()) return null;
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return null;
  const days = (now - t) / DAY_MS;
  return days >= 0 ? Math.round(days) : null;
}

/**
 * The class of a holding's value, and the per-unit number that class
 * describes.
 *
 * Order matters and is deliberate:
 *   1. An observed FMV is observed — unless its pool has gone cold, in
 *      which case it is speculative. A stale exact-pool read is exactly
 *      the case Drew described ("the last comps from 2 months ago aren't
 *      a fair price"), and it is invisible in the rung alone.
 *   2. The speculative rung is speculative whatever else is true.
 *   3. Any other fallback rung is an estimate.
 *   4. A headline standing on the purchase price is own-purchase.
 *   5. Otherwise unpriced.
 */
export function classifyProvenance(
  h: PortfolioHoldingWire,
  now: number = Date.now(),
): {
  klass: ReportProvenanceClass;
  perUnit: number | null;
} {
  const pricing = (h as { pricing?: {
    headline?: { value?: number | null; valueSource?: string | null } | null;
    observed?: { fairMarketValue?: number | null } | null;
  } | null }).pricing ?? null;

  const observedFmv = finiteOrNull(
    pricing?.observed?.fairMarketValue ?? (h as { fairMarketValue?: number | null }).fairMarketValue ?? null,
  );
  const headlineValue = finiteOrNull(pricing?.headline?.value ?? null);
  const headlineSource = pricing?.headline?.valueSource ?? null;
  const rung = rungLabelOf(h);
  const ageDays = compAgeDaysOf(h, now);
  const isCold = ageDays !== null && ageDays > STALE_COMP_DAYS;

  // 2 first as a guard: the speculative rung is speculative even if a
  // number also sits in the observed slot.
  if (rung === SPECULATIVE_RUNG) {
    return { klass: "speculative", perUnit: headlineValue ?? observedFmv };
  }

  if (observedFmv !== null && observedFmv > 0) {
    const exactPool = typeof rung === "string" && rung.startsWith("exact-pool-");
    if (exactPool && isCold) return { klass: "speculative", perUnit: observedFmv };
    if (exactPool) return { klass: "observed", perUnit: observedFmv };
    // A number in the observed slot whose rung is a fallback (or unnamed)
    // is not an observed read. Unknown labels never assume the best case.
    return { klass: "estimated", perUnit: observedFmv };
  }

  const estimated = finiteOrNull((h as { estimatedValue?: number | null }).estimatedValue ?? null);
  if (estimated !== null && estimated > 0) {
    return { klass: isCold ? "speculative" : "estimated", perUnit: estimated };
  }

  if (headlineSource === "cost-proxy" && headlineValue !== null && headlineValue > 0) {
    return { klass: "own-purchase", perUnit: headlineValue };
  }

  // The envelope may be absent on a legacy holding; fall back to the same
  // rule the envelope applies — a purchase price standing in for a value.
  const purchase = finiteOrNull((h as { purchasePrice?: number | null }).purchasePrice ?? null);
  if (headlineValue === null && purchase !== null && purchase > 0) {
    return { klass: "own-purchase", perUnit: purchase };
  }

  return { klass: "unpriced", perUnit: null };
}

// ─── Rows ────────────────────────────────────────────────────────────────

export interface ReportRow {
  holdingId: string;
  /** "2026 Bowman Chrome CPA-EHA Eric Hartman — Blue Refractor /150". */
  identity: string;
  /** "PSA 10" / "Raw". */
  tier: string;
  quantity: number;
  klass: ReportProvenanceClass;
  /** The class's label ("" for observed). */
  label: string;
  /** Per-unit value of the class named. null when unpriced. */
  perUnit: number | null;
  /** perUnit x quantity. null when unpriced. */
  lineTotal: number | null;
  /** The rung in human words, plus the raw label. */
  rung: RungDescription;
  /** The engine's basis prose, when the holding carries one. */
  basis: string | null;
  /** 0..1, when the engine reported one. */
  confidence: number | null;
  /** ISO — when this holding's value was last computed. */
  asOf: string | null;
  /** Age of the newest comp, when known. */
  compAgeDays: number | null;
  costBasis: number | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The card's identity as one line. Built from the holding's own fields —
 *  the report never re-resolves an identity. */
export function identityLine(h: PortfolioHoldingWire): string {
  const year = typeof h.cardYear === "number" && h.cardYear > 0 ? String(h.cardYear) : "";
  const product = str(h.product) || str(h.setName);
  const number = str(h.cardNumber);
  const player = str(h.playerName);
  const head = [year, product, number ? `#${number}` : "", player]
    .filter(Boolean)
    .join(" ")
    .trim();
  const base = head || str(h.cardTitle) || "(unidentified card)";

  const suffix: string[] = [];
  const parallel = str(h.parallel);
  if (parallel && parallel.toLowerCase() !== "base") suffix.push(parallel);
  const variation = str(h.variation);
  if (variation) suffix.push(variation);
  if (h.isAuto === true) suffix.push("Auto");
  const serial = str(h.serialNumber);
  if (serial) suffix.push(`/${serial.replace(/^\/+/, "")}`);

  return suffix.length ? `${base} — ${suffix.join(" ")}` : base;
}

/** "PSA 10", or "Raw" when no grading company is recorded. */
export function tierLabel(h: PortfolioHoldingWire): string {
  const company = str(h.gradeCompany);
  if (!company) return "Raw";
  const value = h.gradeValue;
  return typeof value === "number" && Number.isFinite(value)
    ? `${company.toUpperCase()} ${value}`
    : company.toUpperCase();
}

/**
 * The PRICING confidence behind this row's dollar figure — how
 * well-evidenced the value is, which is what the methodology section
 * promises this column means.
 *
 * CF-REPORT-CONFIDENCE-IS-PRICING (2026-09-03). This is deliberately NOT
 * the holding's match/identity confidence. Those answer different
 * questions: "we are certain WHICH card this is" and "the dollar figure is
 * well-evidenced" can and do diverge — a perfectly identified card with a
 * thin, cold comp pool is match 1.0 and pricing 0.37, and a report that
 * printed 100% beside that number would be claiming evidence it does not
 * have, on the document a reader may hand to an insurer.
 *
 * Read order mirrors rungLabelOf/compsUsedOf: the structured pricing meta
 * the price-writer stamped, then the envelope's confidence. Both now carry
 * the pricing quantity. Null when no path reported one — the row renders
 * "—", and the legend says why.
 */
function confidenceOf(h: PortfolioHoldingWire): number | null {
  const p = (h as { pricing?: {
    confidence?: { pricing?: number | null } | null;
    provenance?: { pricingSourceMeta?: { confidence?: number | null } | null } | null;
  } | null }).pricing ?? null;
  return finiteOrNull(
    p?.provenance?.pricingSourceMeta?.confidence ?? p?.confidence?.pricing ?? null,
  );
}

function basisOf(h: PortfolioHoldingWire): string | null {
  const b = str((h as { estimateBasis?: string | null }).estimateBasis ?? "");
  return b || null;
}

function asOfOf(h: PortfolioHoldingWire): string | null {
  const raw = (h as { lastUpdated?: string | number | null }).lastUpdated ?? null;
  if (typeof raw === "number" && Number.isFinite(raw)) return new Date(raw).toISOString();
  const s = str(raw);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function buildReportRow(h: PortfolioHoldingWire, now: number = Date.now()): ReportRow {
  const { klass, perUnit } = classifyProvenance(h, now);
  const qtyRaw = finiteOrNull(h.quantity ?? null);
  const quantity = qtyRaw !== null && qtyRaw > 0 ? Math.floor(qtyRaw) : 1;
  const compsUsed = compsUsedOf(h);
  return {
    holdingId: str(h.id),
    identity: identityLine(h),
    tier: tierLabel(h),
    quantity,
    klass,
    label: PROVENANCE_LABEL[klass],
    perUnit: perUnit !== null ? round2(perUnit) : null,
    lineTotal: perUnit !== null ? round2(perUnit * quantity) : null,
    rung: describeRung(rungLabelOf(h), { compsUsed }),
    basis: basisOf(h),
    confidence: confidenceOf(h),
    asOf: asOfOf(h),
    compAgeDays: compAgeDaysOf(h, now),
    costBasis: finiteOrNull(h.totalCostBasis ?? null),
  };
}

// ─── Totals ──────────────────────────────────────────────────────────────

/**
 * Totals, SPLIT BY PROVENANCE CLASS.
 *
 * A single grand total that silently folds a speculative number and an
 * own-purchase carry-at-cost in beside observed market reads would be the
 * dishonest version of this document — it would let a reader treat every
 * dollar as equally evidenced. So the report states the observed subtotal
 * first, each softer class beside it, and only then the sum of everything
 * priced, with the own-purchase amount named separately because it is not
 * a market value at all.
 *
 * `grandTotal` is the arithmetic sum of every priced line, including the
 * own-purchase ones — it is what the collection is carried at, and the
 * breakdown above it says how much of that is market-evidenced.
 */
export interface ReportTotals {
  byClass: Record<ReportProvenanceClass, { count: number; total: number }>;
  /** Lines with a value of any class. */
  pricedCount: number;
  /** Lines with no value at all. */
  unpricedCount: number;
  /** Every holding row. */
  holdingCount: number;
  /** Sum of quantity across every row. */
  cardCount: number;
  /** observed only — the market-evidenced part of the collection. */
  observedTotal: number;
  /** observed + estimated + speculative: every market-derived value. */
  marketDerivedTotal: number;
  /** Every priced line, own-purchase carries included. */
  grandTotal: number;
  /** Sum of recorded cost basis across rows that have one. */
  costBasisTotal: number;
  /** grandTotal - costBasisTotal, when any cost basis was recorded. */
  unrealizedGainLoss: number | null;
}

const CLASSES: ReportProvenanceClass[] = [
  "observed", "estimated", "speculative", "own-purchase", "unpriced",
];

export function computeTotals(rows: ReadonlyArray<ReportRow>): ReportTotals {
  const byClass = {} as ReportTotals["byClass"];
  for (const k of CLASSES) byClass[k] = { count: 0, total: 0 };

  let cardCount = 0;
  let costBasisTotal = 0;
  let anyCostBasis = false;

  for (const r of rows) {
    const bucket = byClass[r.klass];
    bucket.count += 1;
    if (r.lineTotal !== null) bucket.total = round2(bucket.total + r.lineTotal);
    cardCount += r.quantity;
    if (r.costBasis !== null) {
      costBasisTotal = round2(costBasisTotal + r.costBasis);
      anyCostBasis = true;
    }
  }

  const observedTotal = byClass.observed.total;
  const marketDerivedTotal = round2(
    byClass.observed.total + byClass.estimated.total + byClass.speculative.total,
  );
  const grandTotal = round2(marketDerivedTotal + byClass["own-purchase"].total);
  const unpricedCount = byClass.unpriced.count;

  return {
    byClass,
    pricedCount: rows.length - unpricedCount,
    unpricedCount,
    holdingCount: rows.length,
    cardCount,
    observedTotal,
    marketDerivedTotal,
    grandTotal,
    costBasisTotal,
    unrealizedGainLoss: anyCostBasis ? round2(grandTotal - costBasisTotal) : null,
  };
}

// ─── The report ──────────────────────────────────────────────────────────

export interface ValuationReport {
  rows: ReportRow[];
  totals: ReportTotals;
  /** When the report was generated. */
  generatedAt: string;
  /** The oldest per-holding as-of in the report — the honest "these
   *  numbers are current as of" line, because a report is only as fresh
   *  as its stalest row. null when no row carried a timestamp. */
  oldestAsOf: string | null;
  /** The newest per-holding as-of. */
  newestAsOf: string | null;
}

export function buildValuationReport(
  holdings: ReadonlyArray<PortfolioHoldingWire>,
  now: Date = new Date(),
): ValuationReport {
  const nowMs = now.getTime();
  const rows = holdings.map((h) => buildReportRow(h, nowMs));
  // Sort by line total descending — the report leads with what matters
  // most to the reader's number. Unpriced rows sort last.
  rows.sort((a, b) => (b.lineTotal ?? -1) - (a.lineTotal ?? -1));

  const stamps = rows
    .map((r) => r.asOf)
    .filter((s): s is string => typeof s === "string")
    .map((s) => Date.parse(s))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  return {
    rows,
    totals: computeTotals(rows),
    generatedAt: now.toISOString(),
    oldestAsOf: stamps.length ? new Date(stamps[0]).toISOString() : null,
    newestAsOf: stamps.length ? new Date(stamps[stamps.length - 1]).toISOString() : null,
  };
}
