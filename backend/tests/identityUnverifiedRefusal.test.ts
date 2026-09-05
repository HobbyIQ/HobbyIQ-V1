/**
 * CF-WE-DONT-WANT-SELF-DERIVED-WE-WANT-IT-MATCHED-TO-CHECKLISTS
 * (Drew, 2026-09-04) — the persist half.
 *
 * Fixtures are Drew's REAL holdings as prod held them on 2026-09-04 (user
 * user-199fcbc9). All three are `ebay-user-purchase` or `user-verified`
 * identities: the catalog's only row for each was minted from his own import,
 * so under the ruling none of them may carry a published number.
 *
 * Mutation pins. Each fails against the obvious wrong version:
 *
 *   - keep the prior value instead of clearing it            -> fails
 *   - publish the refused number                             -> fails
 *   - drop the withheld meta (the row reads as never written) -> fails
 *   - reuse `cost-basis-floor` as the reason                 -> fails
 *   - claim "estimated" for a row carrying no number         -> fails
 *   - collapse the backing so the queue cannot tell why      -> fails
 */
import { describe, it, expect } from "vitest";

import { identityUnverifiedRefusalWrite } from "../src/services/portfolioiq/holdingValuation.js";
import type { Valuation } from "../src/services/compiq/oneValuationPath.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const NOW = "2026-09-04T18:00:00.000Z";

/** Holding 2b62a93f — 2022 Topps Chrome #221 Refractor Image Variation,
 *  Bobby Witt Jr. Catalog row source `ebay-user-purchase`; live FMV $224.75. */
const WITT = {
  id: "2b62a93f-1e2a-4a0b-9d55-7c2f4c8b1a90",
  playerName: "Bobby Witt Jr.",
  hobbyiqCardId: "hiq:baseball:2022:topps-chrome:221:refractor-image-variation:no-auto",
  cardNumber: "221",
  parallel: "Refractor Image Variation",
  fairMarketValue: 224.75,
  fmvRung: "exact-pool-weighted-median",
  valueSource: "observed",
  pricingSourceMeta: { slug: "hiq:baseball:2022:topps-chrome:221:refractor-image-variation:no-auto", compsUsed: 6, confidence: 0.41 },
  purchasePrice: 180,
  totalCostBasis: 180,
  quantity: 1,
} as unknown as PortfolioHolding;

/** Holding 5979f485 — 1997 Bowman's Best #BBP4 Atomic Refractor, Derek Jeter.
 *  Catalog row source `ebay-user-purchase`; live FMV $106.50. */
const JETER = {
  id: "5979f485-33b1-4f7c-8a21-6d0e5b7c2f14",
  playerName: "Derek Jeter",
  hobbyiqCardId: "hiq:baseball:1997:bowmans-best:bbp4:atomic-refractor:no-auto",
  cardNumber: "BBP4",
  parallel: "Atomic Refractor",
  fairMarketValue: 106.5,
  fmvRung: "exact-pool-weighted-median",
  valueSource: "observed",
  pricingSourceMeta: { slug: "hiq:baseball:1997:bowmans-best:bbp4:atomic-refractor:no-auto", compsUsed: 4, confidence: 0.33 },
  purchasePrice: 95,
  totalCostBasis: 95,
  quantity: 1,
} as unknown as PortfolioHolding;

function valuation(slug: string | null, source: string | null, fmv: number | null, rung: string): Valuation {
  return {
    fairMarketValue: fmv,
    rungLabel: rung,
    valueSource: "observed",
    compsUsed: 6,
    identity: { slug, pooledAs: slug, requestedId: slug ?? "", pooledVia: "hobbyiqCardId", sourceOfRow: source },
  } as unknown as Valuation;
}

const WITT_V = valuation(
  "hiq:baseball:2022:topps-chrome:221:refractor-image-variation:no-auto",
  "ebay-user-purchase",
  224.75,
  "exact-pool-weighted-median",
);
const JETER_V = valuation(
  "hiq:baseball:1997:bowmans-best:bbp4:atomic-refractor:no-auto",
  "ebay-user-purchase",
  106.5,
  "exact-pool-weighted-median",
);

describe("a holding on a self-derived identity publishes NO number", () => {
  it("2b62a93f (Witt image variation) clears its value rather than keeping it", () => {
    const { holding } = identityUnverifiedRefusalWrite(WITT, WITT_V, "self-derived-only", NOW);
    // ABSENT BEATS WRONG. Unlike the cost-basis floor — which keeps the prior
    // number because it made no claim about it — this refusal says the whole
    // IDENTITY is unpriceable, and the prior number came from that same
    // identity. Keeping $224.75 here fails.
    expect(holding.fairMarketValue).toBeNull();
    expect((holding as Record<string, unknown>).valueSource).toBe("unavailable");
  });

  it("names method 'withheld' with reason 'no-checklist-match' — visible to the auditor", () => {
    const { holding } = identityUnverifiedRefusalWrite(WITT, WITT_V, "self-derived-only", NOW);
    const meta = (holding as unknown as { pricingSourceMeta: Record<string, unknown> }).pricingSourceMeta;
    // A row with no meta is INVISIBLE to every rung gate and to the invariant
    // auditor — the exact defect #1674 found. Dropping the meta fails here.
    expect(meta).toBeTruthy();
    expect(meta.method).toBe("withheld");
    const w = meta.withheld as Record<string, unknown>;
    expect(w.reason).toBe("no-checklist-match");
    // NOT the floor's reason: the two send a reader to different work.
    expect(w.reason).not.toBe("cost-basis-floor");
  });

  it("keeps the refused number AND the prior value as evidence", () => {
    const { holding } = identityUnverifiedRefusalWrite(JETER, JETER_V, "self-derived-only", NOW);
    const w = (holding as unknown as { pricingSourceMeta: { withheld: Record<string, unknown> } })
      .pricingSourceMeta.withheld;
    // A withhold does not destroy evidence: the row is restorable verbatim
    // once the checklist is acquired.
    expect(w.proposed).toBe(106.5);
    expect(w.priorValue).toBe(106.5);
    expect(w.blockingId).toBe("ebay-user-purchase");
    expect(w.backing).toBe("self-derived-only");
  });

  it("asserts NO confidence — a refusal measured nothing", () => {
    const { holding } = identityUnverifiedRefusalWrite(WITT, WITT_V, "self-derived-only", NOW);
    const meta = (holding as unknown as { pricingSourceMeta: Record<string, unknown> }).pricingSourceMeta;
    // Carrying the prior 0.41 forward would state a confidence in a number
    // this row no longer publishes.
    expect(meta.confidence).toBeNull();
  });

  it("flags the row for the acquisition queue", () => {
    const { holding } = identityUnverifiedRefusalWrite(WITT, WITT_V, "self-derived-only", NOW);
    const h = holding as unknown as Record<string, unknown>;
    expect(h.identityUnverified).toBe(true);
    expect(h.identityUnverifiedAt).toBe(NOW);
    expect(String(h.identityUnverifiedReason)).toContain("self-derived-only");
  });

  it("says WHY in prose a person can act on, naming the source", () => {
    const { prose } = identityUnverifiedRefusalWrite(WITT, WITT_V, "self-derived-only", NOW);
    expect(prose).toContain("ebay-user-purchase");
    expect(prose).toContain("checklist");
    // The refused number is reported, not hidden.
    expect(prose).toContain("224.75");
  });

  it("distinguishes the four refusal backings in its prose", () => {
    // The reason is what tells a reader which work unblocks the row —
    // acquire a checklist, or fix a matcher. Collapsing these fails.
    const noRow = identityUnverifiedRefusalWrite(
      WITT,
      valuation(WITT_V.identity.slug, null, 224.75, "exact-pool-weighted-median"),
      "no-catalog-row",
      NOW,
    );
    expect(noRow.prose).toContain("catalog holds no row");
    const noSlug = identityUnverifiedRefusalWrite(WITT, WITT_V, "no-slug", NOW);
    expect(noSlug.prose).toContain("no canonical identity");
    const unbacked = identityUnverifiedRefusalWrite(
      WITT,
      valuation(WITT_V.identity.slug, "cardhedge", 224.75, "exact-pool-weighted-median"),
      "unbacked",
      NOW,
    );
    expect(unbacked.prose).toContain("not a checklist transcription");
    expect(unbacked.summary).toContain("unbacked");
  });
});
