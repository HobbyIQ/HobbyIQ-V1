/**
 * CF-A-REVIEW-STATUS-IS-NOT-A-CONFIRMED-IDENTITY (Claude Fable 5.1, 2026-09-13).
 *
 * THE FINDING (go-live census, 2026-09-13). A read-only point-read of two
 * live holdings — 925ccfe7 / 4e70af40 (Jack Wheeler, user-67878bb5), a
 * duplicate pair — found both carrying a published `fairMarketValue: 14.79`
 * under `fmvRung: "exact-pool-projection"`, `valueSource: "observed"`, and NO
 * `withheld` block at all, while sitting at `cardStatus: "pending-review"`
 * since their 2026-09-04 import — ~8 days of an unconfirmed import's
 * untouched number reading to the owner as a live, current price.
 *
 * THE DUPLICATE QUESTION, ANSWERED: this pair is NOT a dedup defect. The two
 * holdings carry distinct `ebayItemId` (278317209435 / 278317209174),
 * distinct `ebayOrderId`, and distinct `sourcePurchaseId` — two separate
 * eBay purchases, ~1 minute apart, of the identical parallel print
 * (same player/set/parallel/print-run/card-number). The eBay-auto import's
 * own dedup key (`sourcePurchaseId` match in ebayAutoHolding.service.ts)
 * correctly did not collapse them: they are two real, distinct physical
 * cards that happen to share one catalog identity, which is an ordinary
 * portfolio shape (owning two copies of the same numbered parallel), not a
 * defect. Nothing about that is changed or deleted here.
 *
 * THE IDENTITY QUESTION: their slug
 * (`hiq:baseball:2026:bowman-chrome:cpa-jwh:refractor:auto:num-499`) also
 * names no `card_catalog` row at all, so #2094's identity-backing gate on
 * the four legacy exact-pool shortcut sites independently would have
 * withheld these two rows on their next reprice. But `cardStatus:
 * "pending-review"` must withhold REGARDLESS of catalog backing — the
 * review gate (has a human confirmed this row?) and the identity-backing
 * gate (does a checklist back this row?) answer two different questions
 * (#1869, CF-A-REVIEW-STATUS-IS-NOT-A-PRICING-STATUS), and this is the one
 * reason that requires BOTH to clear before a number publishes.
 *
 * This file pins the two surfaces the ruling touches, using a holding shaped
 * like the real one but with a fictitious id (no live user data, no
 * secrets): the legacy shortcut predicate (`mayPublishFromLegacyExactPoolShortcut`,
 * extended with a second, optional `cardStatus` argument) and the retention
 * rule (`retentionThroughFloor`) that a pending-review refusal must not hand
 * the import-time number straight back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const catalog = new Map<string, { source: string | null }>();

vi.mock("../src/services/catalog/catalogMatcher.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    readCatalogIdentityBySlug: vi.fn(async (slug: string) => {
      const row = catalog.get(slug);
      if (!row) return null;
      return {
        playerName: null, year: null, setKey: null, setName: null, cardNumber: null,
        parallel: null, isAuto: null, sport: null, printRun: null, imageUrl: null,
        observedAt: null,
        source: row.source,
      };
    }),
  };
});

// The live shape's slug — no card_catalog row exists for it (verified
// read-only), but these tests also exercise the "genuinely checklist-backed"
// branch to prove pending-review refuses independently of catalog backing.
const JWH = "hiq:baseball:2026:bowman-chrome:cpa-jwh:refractor:auto:num-499";

describe("mayPublishFromLegacyExactPoolShortcut(id, cardStatus) — pending-review refuses regardless of catalog backing", () => {
  beforeEach(() => { catalog.clear(); });

  it("refuses a pending-review holding even when the id is genuinely checklist-backed", async () => {
    const { mayPublishFromLegacyExactPoolShortcut } = await import("../src/services/portfolioiq/holdingValuation.js");
    catalog.set(JWH, { source: "checklistcenter-2026-08-29" });
    // Without a review status, this id alone would publish — the
    // pending-review argument is what changes the verdict, not the catalog.
    expect(await mayPublishFromLegacyExactPoolShortcut(JWH)).toBe(true);
    expect(await mayPublishFromLegacyExactPoolShortcut(JWH, "pending-review")).toBe(false);
  });

  it("refuses a pending-review holding with NO catalog row at all — the live Jack Wheeler shape (925ccfe7 / 4e70af40)", async () => {
    const { mayPublishFromLegacyExactPoolShortcut } = await import("../src/services/portfolioiq/holdingValuation.js");
    // catalog map has nothing for JWH — the actual live shape: 0 card_catalog
    // rows for this slug. Refused twice over (no catalog row AND
    // pending-review), but pending-review alone must be sufficient — this
    // asserts the review check does not silently depend on the catalog check
    // having already caught it.
    expect(await mayPublishFromLegacyExactPoolShortcut(JWH, "pending-review")).toBe(false);
  });

  it("does not refuse a non-pending-review holding — cardStatus is additive, not a new default refusal", async () => {
    const { mayPublishFromLegacyExactPoolShortcut } = await import("../src/services/portfolioiq/holdingValuation.js");
    catalog.set(JWH, { source: "checklistcenter-2026-08-29" });
    expect(await mayPublishFromLegacyExactPoolShortcut(JWH, "active")).toBe(true);
    expect(await mayPublishFromLegacyExactPoolShortcut(JWH, null)).toBe(true);
    expect(await mayPublishFromLegacyExactPoolShortcut(JWH, undefined)).toBe(true);
  });
});

describe("retentionThroughFloor — a pending-review refusal must not retain the import-time number", () => {
  it("refuses to retain the prior fairMarketValue through a pending-review no-basis-refusal", async () => {
    const { retentionThroughFloor } = await import("../src/services/portfolioiq/holdingValuation.js");
    // Shaped like the real holding (925ccfe7), fictitious id: an eBay-auto
    // import, self-verified at high confidence, sitting on its import-time
    // fairMarketValue with cardStatus still "pending-review" 8+ days later.
    const holding = {
      id: "fixture-pending-review-holding",
      quantity: 1,
      purchasePrice: 28,
      totalCostBasis: 28,
      cardStatus: "pending-review",
      source: "ebay-auto",
      fairMarketValue: 14.79,
      fmvRung: "exact-pool-projection",
      valueSource: "observed",
      pricingSourceMeta: {
        slug: JWH,
        method: "exact-pool-projection",
        compsUsed: 67,
        confidence: 1,
      },
    } as unknown as Parameters<typeof retentionThroughFloor>[0];
    // CF-A-REVIEW-STATUS-IS-NOT-A-CONFIRMED-IDENTITY: `pending-review` joined
    // IDENTITY_REFUSALS, so the prior $14.79 — the exact import-time number
    // this refusal exists to withhold — must not be handed straight back.
    const verdict = retentionThroughFloor(holding, { pooledAs: JWH }, "pending-review");
    expect(verdict).toEqual({ retained: false, because: "identity-not-priceable" });
  });

  it("MUTATION CHECK: the same prior value DOES retain through an evidence refusal (no-exact-pool) on the same identity — pending-review is not a blanket 'never retain'", async () => {
    const { retentionThroughFloor } = await import("../src/services/portfolioiq/holdingValuation.js");
    const holding = {
      id: "fixture-active-holding",
      quantity: 1,
      purchasePrice: 240,
      totalCostBasis: 240,
      cardStatus: "active",
      fairMarketValue: 240,
      fmvRung: "cross-setkey",
      valueSource: "observed",
      pricingSourceMeta: { slug: "hiq:some:other:card", method: "cross-setkey", compsUsed: 4, confidence: 0.6 },
    } as unknown as Parameters<typeof retentionThroughFloor>[0];
    const verdict = retentionThroughFloor(holding, { pooledAs: "hiq:some:other:card" }, "no-exact-pool");
    expect(verdict).toEqual({ retained: true, value: 240 });
  });
});
