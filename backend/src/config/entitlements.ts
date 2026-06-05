// CF-PAYMENTS-A (2026-06-02): single source of truth for tier capabilities.
//
// The matrix below is the authoritative source for the entire backend +
// /api/entitlements/me. iOS reads the same shape via /me for proactive UI
// gating (greyed-out buttons, "Pro only" badges) — but the backend ALWAYS
// re-checks via requireEntitlement / requireCapacity middleware on every
// gated route. Client-side state is presentation-only.
//
// Phase-A scope: enforce booleans + write-counted caps (holdingsCap,
// priceAlerts). Time-windowed caps (priceChecksPerDay, scansPerMonth)
// are DECLARED here but ENFORCEMENT is deferred to Phase B once the
// usage-counter storage model is approved (see HALT proposal).

import type { SubscriptionPlan } from "../services/authService.js";

export type Plan = SubscriptionPlan;

// Ordered low -> high so we can derive "minimum tier that has feature X".
export const PLAN_RANK: Record<Plan, number> = {
  free: 0,
  collector: 1,
  investor: 2,
  pro_seller: 3,
};

export type GatedFeature =
  | "predictions"
  | "watchlist"
  | "advancedAlerts"
  | "dailyIQBriefs"
  | "trendIQComposite"
  | "ebayIntegration"
  | "marketTrendIndexes"
  | "trendIQLayer3Full"
  | "erpReconciliation";

export type GatedCap =
  | "priceChecksPerDay"
  | "holdingsCap"
  | "scansPerMonth"
  | "priceAlerts";

export type CapValue = number | "unlimited";

export interface PlanEntitlements {
  readonly features: ReadonlySet<GatedFeature>;
  readonly caps: Readonly<Record<GatedCap, CapValue>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per the matrix passed in CF-PAYMENTS-A.
// ─────────────────────────────────────────────────────────────────────────────

const FREE_FEATURES: ReadonlySet<GatedFeature> = new Set([]);

const COLLECTOR_FEATURES: ReadonlySet<GatedFeature> = new Set<GatedFeature>([
  "predictions",
  "watchlist",
]);

const INVESTOR_FEATURES: ReadonlySet<GatedFeature> = new Set<GatedFeature>([
  ...COLLECTOR_FEATURES,
  "advancedAlerts",
  "dailyIQBriefs",
  "trendIQComposite",
  "ebayIntegration",
  "marketTrendIndexes",
]);

const PRO_SELLER_FEATURES: ReadonlySet<GatedFeature> = new Set<GatedFeature>([
  ...INVESTOR_FEATURES,
  "trendIQLayer3Full",
  "erpReconciliation",
]);

export const ENTITLEMENTS: Readonly<Record<Plan, PlanEntitlements>> = {
  free: {
    features: FREE_FEATURES,
    caps: {
      priceChecksPerDay: 5,
      holdingsCap: 25,
      scansPerMonth: 10,
      priceAlerts: 0,
    },
  },
  collector: {
    features: COLLECTOR_FEATURES,
    caps: {
      priceChecksPerDay: "unlimited",
      holdingsCap: 250,
      scansPerMonth: "unlimited",
      priceAlerts: 10,
    },
  },
  investor: {
    features: INVESTOR_FEATURES,
    caps: {
      priceChecksPerDay: "unlimited",
      holdingsCap: "unlimited",
      scansPerMonth: "unlimited",
      priceAlerts: 30,
    },
  },
  pro_seller: {
    features: PRO_SELLER_FEATURES,
    caps: {
      priceChecksPerDay: "unlimited",
      holdingsCap: "unlimited",
      scansPerMonth: "unlimited",
      priceAlerts: "unlimited",
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers used by middleware + /api/entitlements/me.
// ─────────────────────────────────────────────────────────────────────────────

export function hasEntitlement(plan: Plan, feature: GatedFeature): boolean {
  return ENTITLEMENTS[plan].features.has(feature);
}

export function getCap(plan: Plan, cap: GatedCap): CapValue {
  return ENTITLEMENTS[plan].caps[cap];
}

/**
 * Smallest tier that has the given feature. Used by 402 responses so iOS
 * can prompt the user to upgrade to a specific tier.
 */
export function minimumTierFor(feature: GatedFeature): Plan | null {
  const ordered: Plan[] = ["free", "collector", "investor", "pro_seller"];
  for (const plan of ordered) {
    if (ENTITLEMENTS[plan].features.has(feature)) return plan;
  }
  return null;
}

/**
 * Smallest tier whose cap for `cap` is either "unlimited" or strictly
 * greater than `currentCount`. Used by capacity 402 responses.
 */
export function minimumTierForCap(cap: GatedCap, currentCount: number): Plan | null {
  const ordered: Plan[] = ["free", "collector", "investor", "pro_seller"];
  for (const plan of ordered) {
    const limit = ENTITLEMENTS[plan].caps[cap];
    if (limit === "unlimited") return plan;
    if (typeof limit === "number" && currentCount < limit) return plan;
  }
  return null;
}

/**
 * Flatten the entitlement record for the given plan into a wire-friendly
 * object for GET /api/entitlements/me. iOS consumes this directly.
 */
export function resolveEntitlementsFor(plan: Plan): {
  plan: Plan;
  features: GatedFeature[];
  caps: Record<GatedCap, CapValue>;
} {
  const entry = ENTITLEMENTS[plan];
  return {
    plan,
    features: Array.from(entry.features).sort(),
    caps: { ...entry.caps },
  };
}

// CF-OWNER-OVERRIDE (2026-06-05): single authoritative resolver consumed
// by EVERY enforcement site (requireEntitlement / requireCapacity /
// requireRateLimited) AND by /api/entitlements/me. Resolution order:
//
//   1. entitlementOverride (server-side comp, set via seedOwnerAccount)
//   2. plan (Apple-derived; webhooks maintain this)
//   3. "free" (fall-through if both above are missing/invalid)
//
// The override must be a known SubscriptionPlan; an unknown literal
// (e.g. a stale legacy value persisted by hand) falls through to plan
// instead of corrupting the gate. Validation via PLAN_RANK membership.
//
// Anything that gates on the user's effective tier MUST go through this
// helper. If you find yourself reading `user.plan` directly in a gate,
// you've created a bug — comped owners will see the feature in the UI
// but get 402 on the API call.
export function effectivePlanFor(
  user: { plan: Plan; entitlementOverride?: Plan | null | undefined },
): Plan {
  const override = user.entitlementOverride;
  if (override != null && (override as string) in PLAN_RANK) {
    return override;
  }
  return user.plan;
}
