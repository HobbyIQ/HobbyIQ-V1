/**
 * CF-GRADING-TIER-CATALOG (2026-07-06, Drew):
 * Server-hosted catalog of grader service tiers + costs. Powers the iOS
 * "Mark as Graded" tier dropdown — user picks a tier, iOS pre-fills
 * `gradingCost` from `pricePerCard`, backend accepts the tier id on
 * /regrade + /regrade-batch to resolve cost server-side and log which
 * tier was actually used.
 *
 * Why server-hosted:
 *   - Prices change (PSA raised prices in Feb 2026, paused Value
 *     tiers in June 2026). Backend deploy > iOS App Store review.
 *   - Backend can validate `gradingTierId` against the list — bad
 *     tier IDs fail early instead of silently persisting.
 *   - Analytics: log tier distribution to understand which grader
 *     services users lean on. Feeds pricing decisions on portfolio
 *     features later.
 *
 * Extensibility:
 *   - Multi-grader supported today (grader field) — populated with
 *     PSA only for MVP because that's Drew's stated priority. Add
 *     BGS / SGC / CGC entries as their pricing gets confirmed.
 *   - `active: false` tiers stay in the catalog (paused ≠ deleted).
 *     A user who has a receipt from a paused tier still needs to
 *     record it accurately.
 *
 * Data sources (as of 2026-07-06):
 *   - https://www.psacard.com/services/tradingcardgrading (blocked
 *     to bot fetches; confirmed via web search)
 *   - PSA's Feb 2026 pricing update announcement
 *   - PSA's Jun 2, 2026 pause announcement (Value tiers)
 *
 * This table is the ONE source of truth. Update it when PSA changes
 * pricing; the API endpoint reads from it directly.
 */

export type GraderId = "PSA" | "BGS" | "SGC" | "CGC";

export interface GradingTier {
  /** Stable ID iOS sends back on submit. Format: `<grader>-<slug>`. */
  id: string;
  grader: GraderId;
  /** Display name shown in the dropdown (e.g. "Regular"). */
  name: string;
  /** Per-card cost in USD. `null` for tiers that quote per-card
   *  (Premium 2+ has variable pricing depending on card value). */
  pricePerCard: number | null;
  /** Max declared value the tier accepts, in USD. `null` = no cap. */
  maxDeclaredValue: number | null;
  /** Estimated turnaround, as a human-readable string
   *  ("40-50 business days", "5 business days", "Same-day"). */
  turnaround: string;
  /** Currently accepting submissions? Paused tiers stay in the list
   *  so users with pre-pause receipts can still log accurately. */
  active: boolean;
  /** Optional caveat rendered under the dropdown option. */
  note?: string;
}

/** Canonical grading tier catalog. Update in place as pricing changes. */
export const GRADING_TIERS: GradingTier[] = [
  // ═══════════════════════════════════════════════════════════════
  // PSA — as of 2026-07-06
  // ═══════════════════════════════════════════════════════════════
  {
    id: "psa-value-bulk",
    grader: "PSA",
    name: "Value Bulk",
    pricePerCard: 24.99,
    maxDeclaredValue: 199,
    turnaround: "45+ business days",
    active: false,
    note: "Paused Jun 2, 2026 — kept for historical entries",
  },
  {
    id: "psa-value",
    grader: "PSA",
    name: "Value",
    pricePerCard: 32.99,
    maxDeclaredValue: 499,
    turnaround: "150+ business days",
    active: false,
    note: "Paused Jun 2, 2026 — kept for historical entries",
  },
  {
    id: "psa-value-plus",
    grader: "PSA",
    name: "Value Plus",
    pricePerCard: 49.99,
    maxDeclaredValue: 999,
    turnaround: "100+ business days",
    active: false,
    note: "Paused Jun 2, 2026 — kept for historical entries",
  },
  {
    id: "psa-value-max",
    grader: "PSA",
    name: "Value Max",
    pricePerCard: 64.99,
    maxDeclaredValue: 1499,
    turnaround: "60+ business days",
    active: false,
    note: "Paused Jun 2, 2026 — kept for historical entries",
  },
  {
    id: "psa-regular",
    grader: "PSA",
    name: "Regular",
    pricePerCard: 79.99,
    maxDeclaredValue: 1499,
    turnaround: "40-50 business days",
    active: true,
  },
  {
    id: "psa-express",
    grader: "PSA",
    name: "Express",
    pricePerCard: 149,
    maxDeclaredValue: 9999,
    turnaround: "~10 business days",
    active: true,
  },
  {
    id: "psa-super-express",
    grader: "PSA",
    name: "Super Express",
    pricePerCard: 349,
    maxDeclaredValue: 24999,
    turnaround: "5 business days",
    active: true,
  },
  {
    id: "psa-walk-through",
    grader: "PSA",
    name: "Walk-Through",
    pricePerCard: 599,
    maxDeclaredValue: 49999,
    turnaround: "Same-day / next-day",
    active: true,
  },
  {
    id: "psa-premium-1",
    grader: "PSA",
    name: "Premium 1",
    pricePerCard: 999,
    maxDeclaredValue: 99999,
    turnaround: "1-3 business days",
    active: true,
  },
  {
    id: "psa-premium-2",
    grader: "PSA",
    name: "Premium 2+",
    pricePerCard: null, // variable — quote per-card
    maxDeclaredValue: null,
    turnaround: "1-3 business days",
    active: true,
    note: "Quote per-card; typically $1,000+ for cards valued $100K+",
  },
];

/** Lookup helper — returns null when the id doesn't match. */
export function getGradingTierById(id: string): GradingTier | null {
  const trimmed = String(id ?? "").trim();
  if (!trimmed) return null;
  return GRADING_TIERS.find((t) => t.id === trimmed) ?? null;
}
