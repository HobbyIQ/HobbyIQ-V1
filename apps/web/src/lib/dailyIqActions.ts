// CF-DAILYIQ-ACTIONS (Drew, 2026-09-04: "Portfolio Today should be a wide bar
// at the top with relevant data, then market indexes, and maybe something
// around actions below it").
//
// The DECISIONS behind the Today page's action columns, split out of the
// components so the node-only vitest lane can pin them (vitest.config.mts is
// `environment: "node"` — this file is pure: no DOM, no fetch, no React).
//
// EVERY NUMBER HERE COMES OFF A RESPONSE THE PAGE ALREADY FETCHES. There is
// no new backend in this change: the attention rows read `/api/portfolio`'s
// per-holding fields, and the sell signals read the SAME wire's `sellSignal`,
// which #1652 put there and /app/seller already consumes. Nothing is derived
// from a number we would have had to invent.
//
// FOUR RULES THIS MODULE KEEPS:
//
// 1. THE REASON IS SAID IN THE USER'S WORDS, not the engine's. A reader is
//    told "value withheld: cost-basis check", never "cost-proxy floor" or
//    "BASIS-IDENTITY". The internal vocabulary is the input to this mapping,
//    never its output — the words below are what appears on the glass.
//
// 2. ONE ROW SAYS ONE THING. A holding can be unmatched AND unpriced AND
//    under review; it gets ONE row carrying its most actionable reason,
//    because a list that repeats a card three times reads as three problems
//    and buries the other cards that each have one.
//
// 3. AN ABSENT CAPABILITY IS NOT AN EMPTY RESULT. `sellSignal` is optional on
//    the wire by design (see api.ts): until the sell-window backend deploys,
//    /api/portfolio answers 200 with the field simply missing. "No holding
//    carries the field" therefore means NOT LIVE, and "holdings carry it but
//    all say none" means NO SIGNALS TODAY. The two look identical if you only
//    count rows, and they mean different things to a seller — so they are
//    different states here, and the column says the honest one.
//
// 4. NOTHING IS INVENTED TO FILL A COLUMN. No placeholder signals, no
//    synthesised advice. An empty column says it is empty.

import type { PortfolioHolding, PortfolioResponse } from "./api";
import { holdingDisplayValue, valuationStatusOf } from "./api";
import { formatCardTitle } from "./format";
import { withheldOf, withheldShort } from "./withheld";

// ─── Pricing attention ──────────────────────────────────────────────────

/** Why a holding is in the attention column. Ordered by how actionable it
 *  is — see `ATTENTION_RANK`, which is this list's priority. */
export type AttentionKind =
  | "identity-unmatched"
  | "value-withheld"
  | "under-review"
  | "low-confidence";

export interface AttentionRow {
  holdingId: string;
  /** The card, as a person would name it. */
  title: string;
  kind: AttentionKind;
  /** Rule 1: the reason in plain words, ready to render verbatim. */
  reason: string;
  href: string;
}

/**
 * Rule 2's priority. An unmatched identity outranks everything because it is
 * the one the OWNER can fix in a click, and because every other problem
 * downstream of it may simply be its consequence: a holding with no catalog
 * card has no pool to price from, so its withheld value is not a separate
 * finding. Under-review outranks low-confidence for the same reason in
 * miniature — the auditor found a contradiction, which is a stronger claim
 * than a soft confidence label.
 */
const ATTENTION_RANK: Record<AttentionKind, number> = {
  "identity-unmatched": 4,
  "value-withheld": 3,
  "under-review": 2,
  "low-confidence": 1,
};

/**
 * Rule 1's vocabulary. The left side is the machine's word; the right side is
 * the sentence the owner reads. These are the ONLY strings this column shows
 * as a reason, apart from a wire-supplied `pricingLabels[].text`, which is
 * already written for a reader and is shown verbatim rather than paraphrased
 * (the same rule PricingLabelChips and SellSignalChip keep).
 */
export const ATTENTION_REASON: Record<AttentionKind, string> = {
  "identity-unmatched": "identity needs a checklist match",
  // CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05). The GENERIC, used only when the
  // wire sent no reason (an old worker, or a row unpriced for an ordinary
  // reason). This used to read "value withheld: cost-basis check" for EVERY
  // withheld holding, which was not vague but wrong: a no-checklist-match row
  // was told its cost basis blocked the price. The real reason now comes from
  // `withheldShort()` in attentionRowFor; this is the honest fallback that
  // claims no cause it was not given.
  "value-withheld": "value withheld",
  "under-review": "value under review",
  "low-confidence": "no independent sales yet",
};

/**
 * Is this holding's identity unmatched?
 *
 * NOT the inverse of `identityVerified`. That flag means the OWNER explicitly
 * confirmed a candidate (CF-IDENTITY-VERIFIED), and the great majority of a
 * healthy portfolio has never been through that gate while still being
 * perfectly well matched — treating unverified as broken would put all 43 of
 * Drew's cards in a column headed "needs attention", which is the same as
 * having no column. Unmatched means the backend says there is no identity:
 * the store-door guard parked it (`needsReview` + its `reviewReason`), or it
 * carries no canonical slug at all.
 */
export function isIdentityUnmatched(h: PortfolioHolding): boolean {
  if (h.needsReview === true) return true;
  return !h.hobbyiqCardId && !h.cardId;
}

/**
 * Did we decline to show a value?
 *
 * `holdingDisplayValue` is the one ladder every surface uses, and it returns
 * null exactly when the envelope declined or the flats are empty — including
 * the cost-proxy case it deliberately refuses to fall back to. Reusing it
 * here means this column cannot disagree with the number on the row.
 */
export function isValueWithheld(h: PortfolioHolding): boolean {
  return holdingDisplayValue(h) == null;
}

/** The nightly invariant auditor could not reconcile the persisted value. */
export function isUnderReview(h: PortfolioHolding): boolean {
  return h.auditFlag != null;
}

/** A caveat the WRITER stamped, in the wire's closed vocabulary. */
export function lowConfidenceLabel(h: PortfolioHolding) {
  return (h.pricingLabels ?? []).find(
    (l) => l.code === "low-confidence" || l.code === "speculative" || l.code === "self-anchored",
  );
}

/**
 * The one row this holding earns, or null when nothing is wrong with it.
 *
 * Rule 2 in code: every applicable kind is collected, the highest-ranked one
 * wins, and the holding appears once.
 */
export function attentionRowFor(h: PortfolioHolding): AttentionRow | null {
  const kinds: AttentionKind[] = [];
  if (isIdentityUnmatched(h)) kinds.push("identity-unmatched");
  if (isValueWithheld(h)) kinds.push("value-withheld");
  if (isUnderReview(h)) kinds.push("under-review");
  const label = lowConfidenceLabel(h);
  if (label) kinds.push("low-confidence");
  if (kinds.length === 0) return null;

  const kind = kinds.sort((a, b) => ATTENTION_RANK[b] - ATTENTION_RANK[a])[0];

  // A wire-supplied sentence beats our generic one — it was composed for a
  // reader and it quotes this card's own evidence. `reviewReason` is written
  // by the guard that parked the holding; `pricingLabels[].text` by the
  // writer that priced it. Neither is paraphrased.
  let reason = ATTENTION_REASON[kind];
  if (kind === "identity-unmatched" && h.reviewReason) {
    reason = h.reviewReason;
  } else if (kind === "low-confidence" && label?.text) {
    reason = label.text;
  } else if (kind === "value-withheld") {
    // CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05). The engine's own reason, in the
    // owner's words. Absent (an old worker) keeps the generic above — Rule 4:
    // absent is not a reason, and we do not invent one.
    const w = withheldOf(h);
    if (w) reason = `value withheld: ${withheldShort(w.reason)}`;
  }

  return {
    holdingId: h.id,
    title: formatCardTitle(h),
    kind,
    reason,
    href: `/app/portfolio/${encodeURIComponent(h.id)}`,
  };
}

/**
 * The attention list, most actionable first and capped.
 *
 * The cap is a display concern, not a measurement: `attentionCount` below
 * counts ALL of them, so the chip in the bar never under-reports because a
 * column only had room for five.
 */
export function attentionRows(
  items: PortfolioHolding[] | null | undefined,
  limit = 5,
): AttentionRow[] {
  const rows: AttentionRow[] = [];
  for (const h of items ?? []) {
    const row = attentionRowFor(h);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => ATTENTION_RANK[b.kind] - ATTENTION_RANK[a.kind]);
  return rows.slice(0, limit);
}

/** How many holdings need attention — ALL of them, not the displayed slice. */
export function attentionCount(items: PortfolioHolding[] | null | undefined): number {
  let n = 0;
  for (const h of items ?? []) if (attentionRowFor(h)) n += 1;
  return n;
}

// ─── Sell signals ───────────────────────────────────────────────────────

/** Rule 3's three states. `not-live` is the capability-absent one. */
export type SellSignalsState = "not-live" | "none-today" | "signals";

export interface SellSignalRow {
  holdingId: string;
  title: string;
  signal: "watch" | "sell-window" | "hold";
  horizon: "none" | "days-7-14" | "days-14-30";
  /** Shown verbatim: it is the evidence, and it quotes its own numbers. */
  basis: string;
  href: string;
}

/**
 * Rule 3. Feature-detect on the DATA, exactly as /app/seller does: the field
 * is optional on the wire, so "no holding carries it" is the honest signal
 * that the capability is not deployed, and it must not be reported as "no
 * sell signals today".
 */
export function sellSignalsState(items: PortfolioHolding[] | null | undefined): SellSignalsState {
  const list = items ?? [];
  if (!list.some((h) => h.sellSignal != null)) return "not-live";
  if (!list.some((h) => h.sellSignal && h.sellSignal.signal !== "none")) return "none-today";
  return "signals";
}

/** Fire before watch, and within a signal the wider divergence first — the
 *  same ranking /app/seller uses, so the two surfaces agree on what is most
 *  urgent rather than each inventing an order. */
export function sellRank(h: PortfolioHolding): number {
  const s = h.sellSignal;
  if (!s) return -1;
  const base = s.signal === "sell-window" ? 1000 : s.signal === "watch" ? 500 : 0;
  return base + Math.abs(s.measures?.divergencePct ?? 0);
}

export function sellSignalRows(
  items: PortfolioHolding[] | null | undefined,
  limit = 4,
): SellSignalRow[] {
  return (items ?? [])
    .filter((h) => h.sellSignal && h.sellSignal.signal !== "none")
    .sort((a, b) => sellRank(b) - sellRank(a))
    .slice(0, limit)
    .map((h) => ({
      holdingId: h.id,
      title: formatCardTitle(h),
      signal: h.sellSignal!.signal as "watch" | "sell-window" | "hold",
      horizon: h.sellSignal!.horizon,
      basis: h.sellSignal!.basis,
      href: `/app/portfolio/${encodeURIComponent(h.id)}`,
    }));
}

// ─── The bar's numbers ──────────────────────────────────────────────────

export interface BarStats {
  totalValue: number;
  /** Today's move in dollars, or NULL when the wire carries no previous close.
   *  Null and zero are different facts — see `barStats`. */
  dayChange: number | null;
  /** The same move in PERCENT POINTS (1.23 = +1.23%), converted from the
   *  fraction the wire carries so it can go straight into `formatPct`, which
   *  every other percentage on this page already uses. */
  dayChangePct: number | null;
  /** Non-null whenever `dayChange` is: how many holdings actually had a prior
   *  point, out of how many are in the portfolio. */
  dayChangeCoverage: { holdingsWithPrior: number; holdingsTotal: number } | null;
  costBasis: number;
  unrealisedPL: number;
  unrealisedPLPct: number;
  cardCount: number;
  verifiedCount: number;
  attentionCount: number;
  /** CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05). How many holdings carry a
   *  published value, and how many the engine refused to price.
   *
   *  These do NOT necessarily sum to `cardCount`: a row can be unpriced
   *  without a refusal (an old worker sent no reason). Three states, counted
   *  as three, because "priced + withheld = all" is a claim the data does not
   *  support and the bar must not imply. */
  pricedCount: number;
  withheldCount: number;
}

/**
 * Everything the bar shows, from one response.
 *
 * CF-PORTFOLIO-DAY-CHANGE (Drew, 2026-09-04). The day change is now on the
 * wire: /api/portfolio computes a previous close from each holding's persisted
 * price trail at the most recent UTC midnight. It is READ, not derived here —
 * a second copy of the arithmetic in the browser is exactly how the bar and
 * the API drift into disagreeing about the same day.
 *
 * `dayChange` stays NULL — never zero — in two cases, and they are the same
 * case as far as the reader is concerned: the server found no prior point for
 * any holding, or the worker predates this field and sent nothing. Zero is a
 * measured flat day and prints as "$0"; null means we have no yesterday and
 * prints as an em dash. Printing $0 for "we do not know" would be inventing a
 * measurement, which is the invariant this repo keeps everywhere else.
 *
 * THE PERCENT IS CONVERTED HERE. The wire carries a fraction (0.0123); every
 * percentage on this page goes through `formatPct`, which wants percent
 * points. One conversion, at the boundary, rather than a `* 100` sprinkled
 * through the JSX.
 */
export function barStats(data: PortfolioResponse): BarStats {
  const s = data.summary;
  const items = data.items ?? [];
  const dayChange = typeof s.dayChangeValue === "number" ? s.dayChangeValue : null;
  return {
    totalValue: s.totalValue,
    dayChange,
    // Guarded on `dayChange` too: a percentage without a dollar move is half a
    // measurement, and the bar shows the pair or neither.
    dayChangePct:
      dayChange !== null && typeof s.dayChangePct === "number" ? s.dayChangePct * 100 : null,
    dayChangeCoverage: dayChange !== null ? (s.dayChangeCoverage ?? null) : null,
    costBasis: s.totalCost,
    unrealisedPL: s.totalGainLoss,
    unrealisedPLPct: s.totalGainLossPct,
    cardCount: s.cardCount,
    verifiedCount: items.filter((h) => h.identityVerified === true).length,
    attentionCount: attentionCount(items),
    // Priced is measured with the SAME ladder the rows render from, so the
    // bar's count and the list cannot disagree about which cards have a value.
    pricedCount: items.filter((h) => holdingDisplayValue(h) != null).length,
    withheldCount: items.filter((h) => withheldOf(h) != null).length,
  };
}

/** Top movers for the bar's inline strip: biggest absolute $ move first. */
export function topMovers(
  items: PortfolioHolding[] | null | undefined,
  limit = 3,
): { holdingId: string; label: string; change: number }[] {
  return (items ?? [])
    .filter((h) => h.totalProfitLoss != null)
    .sort((a, b) => Math.abs(b.totalProfitLoss ?? 0) - Math.abs(a.totalProfitLoss ?? 0))
    .slice(0, limit)
    .map((h) => ({
      holdingId: h.id,
      label: h.playerName ?? h.cardTitle ?? "Untitled",
      change: h.totalProfitLoss ?? 0,
    }));
}

/** Re-exported so the bar and the columns cannot drift on what "priced"
 *  means — one ladder, one answer. */
export { holdingDisplayValue, valuationStatusOf };
