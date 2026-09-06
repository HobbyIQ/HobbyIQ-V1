/**
 * CF-WE-DONT-WANT-SELF-DERIVED-WE-WANT-IT-MATCHED-TO-CHECKLISTS
 * (Drew, 2026-09-04) — the persist half.
 *
 * The identity refusal does NOT have a writer of its own. It is a third
 * `NoBasisRefusalReason` on the branch `identity-not-in-catalog` and
 * `pool-migrating` already share, which is what makes it compose with #1781
 * (one retention rule) and #1785 (one stamp) by construction rather than by a
 * parallel implementation remembering to. These pins assert that composition,
 * because a future refusal that forgets it would look correct in isolation:
 *
 *   - retain a prior that fails the cost-basis floor          -> fails
 *   - retain a prior the REFUSED pool itself published        -> fails
 *   - carry the prior pass's rung or valueSource through      -> fails
 *   - drop the withheld meta (the row reads as never written)  -> fails
 *   - leave a stale `estimatedValue` behind the withhold      -> fails
 *
 * Fixtures are Drew's REAL holdings as prod held them on 2026-09-04 (user
 * user-199fcbc9). Both are `ebay-user-purchase` identities: the catalog's only
 * row for each was minted from his own import, so under the ruling neither may
 * carry a published number.
 */
import { describe, it, expect } from "vitest";

import { noBasisRefusalWrite, retentionThroughFloor } from "../src/services/portfolioiq/holdingValuation.js";
import type { Valuation } from "../src/services/compiq/oneValuationPath.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const NOW = "2026-09-04T18:00:00.000Z";
const WITT_SLUG = "hiq:baseball:2022:topps-chrome:221:refractor-image-variation:no-auto";
const JETER_SLUG = "hiq:baseball:1997:bowmans-best:bbp4:atomic-refractor:no-auto";

/** Holding 2b62a93f — 2022 Topps Chrome #221 Refractor Image Variation, Bobby
 *  Witt Jr. Catalog row source `ebay-user-purchase`; live FMV $224.75 on a
 *  $180 basis, priced from THIS identity's own exact pool. */
const WITT = {
  id: "2b62a93f-1e2a-4a0b-9d55-7c2f4c8b1a90",
  playerName: "Bobby Witt Jr.",
  hobbyiqCardId: WITT_SLUG,
  cardNumber: "221",
  parallel: "Refractor Image Variation",
  fairMarketValue: 224.75,
  fmvRung: "exact-pool-weighted-median",
  valueSource: "observed",
  isEstimate: false,
  estimatedValue: 224.75,
  valuationStatus: "observed",
  pricingSourceMeta: { slug: WITT_SLUG, compsUsed: 6, confidence: 0.41 },
  purchasePrice: 180,
  totalCostBasis: 180,
  quantity: 1,
} as unknown as PortfolioHolding;

/** Holding 5979f485 — 1997 Bowman's Best #BBP4 Atomic Refractor, Derek Jeter.
 *  Its prior number came from a SIBLING, not from this identity's own pool. */
const JETER = {
  id: "5979f485-33b1-4f7c-8a21-6d0e5b7c2f14",
  playerName: "Derek Jeter",
  hobbyiqCardId: JETER_SLUG,
  cardNumber: "BBP4",
  parallel: "Atomic Refractor",
  fairMarketValue: 106.5,
  fmvRung: "sibling-estimate",
  valueSource: "estimated",
  pricingSourceMeta: { slug: JETER_SLUG, compsUsed: 4, confidence: 0.33 },
  purchasePrice: 95,
  totalCostBasis: 95,
  quantity: 1,
} as unknown as PortfolioHolding;

function valuation(slug: string, source: string | null, fmv: number | null): Valuation {
  return {
    fairMarketValue: fmv,
    rungLabel: "exact-pool-weighted-median",
    valueSource: "observed",
    compsUsed: 6,
    identity: { slug, pooledAs: slug, requestedId: slug, pooledVia: "hobbyiqCardId", sourceOfRow: source },
  } as unknown as Valuation;
}

const meta = (h: PortfolioHolding) =>
  (h as unknown as { pricingSourceMeta: Record<string, unknown> }).pricingSourceMeta;
const withheldOf = (h: PortfolioHolding) => meta(h).withheld as Record<string, unknown>;

describe("a holding on a self-derived identity publishes NO number", () => {
  it("names method 'withheld' with reason 'no-checklist-match' — visible to the auditor", () => {
    const { holding } = noBasisRefusalWrite(WITT, "no-checklist-match", valuation(WITT_SLUG, "ebay-user-purchase", 224.75), NOW);
    // A row with no meta is INVISIBLE to every rung gate and to the invariant
    // auditor — the defect #1674 found. Dropping the meta fails here.
    expect(meta(holding)).toBeTruthy();
    expect(meta(holding).method).toBe("withheld");
    expect(withheldOf(holding).reason).toBe("no-checklist-match");
    // NOT the floor's reason: the two send a reader to different work.
    expect(withheldOf(holding).reason).not.toBe("cost-basis-floor");
  });

  it("2b62a93f (Witt) drops its prior BECAUSE the refused identity's own pool published it", () => {
    // CF-ONE-RETENTION-RULE (#1781). The prior $224.75 was an exact-pool read
    // of the very identity this refusal faults, so it is the same evidence one
    // pass older rather than an independent claim. It goes.
    const v = valuation(WITT_SLUG, "ebay-user-purchase", 224.75);
    // Rule 2 on its own terms: asked with no refusal reason, the verdict is
    // still the refused pool's own prior publish.
    expect(retentionThroughFloor(WITT, { pooledAs: WITT_SLUG }))
      .toEqual({ retained: false, because: "prior-is-the-refused-pool" });
    const { holding } = noBasisRefusalWrite(WITT, "no-checklist-match", v, NOW);
    expect(holding.fairMarketValue).toBeNull();
    expect(withheldOf(holding).retained).toBeNull();
    // REVISED 2026-09-06 (rule 3). Through an IDENTITY refusal the reported
    // reason is now `identity-not-priceable`: it is asked first, because when
    // the identity is refused there is no card for the number to be the price
    // of and the pool's provenance is beside the point. The row's fate —
    // nothing retained — is unchanged, which is what this test is about.
    expect(withheldOf(holding).retentionRefused).toBe("identity-not-priceable");
    // And the estimate slot is cleared with it — `computeDisplayValue` reads
    // `estimatedValue` BEFORE falling through to cost basis, so a stale
    // estimate left standing just moves the same undefended number one field
    // over and defeats the withhold.
    expect((holding as unknown as Record<string, unknown>).estimatedValue).toBeNull();
    expect((holding as unknown as Record<string, unknown>).isEstimate).toBe(false);
  });

  it("5979f485 (Jeter) drops its prior too — an unbacked identity retains NOTHING", () => {
    // REVERSED 2026-09-06 (rule 3, "absent beats wrong" — Drew). This test
    // previously asserted the opposite: that a sibling estimate stands
    // through an identity refusal because it "reached other cards' sales, so
    // the identity refusal says nothing about it".
    //
    // That reasoning answers the wrong question. Rules 1 and 2 ask whether
    // the NUMBER is sound — against a basis, against a pool. An identity
    // refusal is not a claim about the number at all: it says there is no
    // card here that a price can be the price OF. A sibling estimate for a
    // card no checklist confirms is a number about nothing, and the fact that
    // it came from an independent body of evidence makes it no more
    // attachable to an identity we cannot name.
    //
    // This holding is not hypothetical. The 2026-09-06 read-only census found
    // 5979f485 live on `1997:bowmans-best:bbp4:atomic-refractor` at $133.125
    // beside a `no-checklist-match` withhold — and its twin 437f010d on the
    // SAME unbacked slug at $65. One card, two retained prices, neither of
    // them a claim the catalog can stand behind. Ten such rows in 131.
    //
    // MUTATION: delete rule 3 from `retentionThroughFloor` and this goes red.
    const v = valuation(JETER_SLUG, "ebay-user-purchase", 106.5);
    const { holding } = noBasisRefusalWrite(JETER, "no-checklist-match", v, NOW);
    expect(holding.fairMarketValue).toBeNull();
    expect(withheldOf(holding).retained).toBeNull();
    expect(withheldOf(holding).retentionRefused).toBe("identity-not-priceable");
    // The number is not destroyed — it is REPORTED, never published. A
    // withhold does not destroy evidence.
    expect(withheldOf(holding).reason).toBe("no-checklist-match");
    // No rung is claimed for a number that no longer stands.
    expect(withheldOf(holding).retainedRung).toBeNull();
    // And the estimate slot goes with it, so the same undefended number
    // cannot reappear one field over.
    expect((holding as unknown as Record<string, unknown>).estimatedValue).toBeNull();
  });

  it("an EVIDENCE refusal still keeps an independent prior — rule 3 is not a blanket erase", () => {
    // The doctrine the Jeter test used to carry, restated where it is true.
    // `no-exact-pool` names a real, checklist-backed card whose evidence is
    // thin; #1781's retention is exactly right there and rule 3 must not
    // touch it.
    //
    // MUTATION: widen IDENTITY_REFUSALS to the whole NoBasisRefusalReason
    // union and this goes red — silently deleting live prices off good cards.
    const v = valuation(JETER_SLUG, "beckett", 106.5);
    const { holding } = noBasisRefusalWrite(JETER, "no-exact-pool", v, NOW);
    expect(holding.fairMarketValue).toBe(106.5);
    expect(withheldOf(holding).retained).toBe(106.5);
    expect(withheldOf(holding).retentionRefused).toBeNull();
    // The rung it WAS priced under survives as evidence, never as a live claim.
    expect(withheldOf(holding).retainedRung).toBe("sibling-estimate");
  });

  it("rewrites the stamp — a withhold never carries the prior pass's rung or valueSource", () => {
    // CF-A-HOLDING-CARRIES-ONE-STAMP (#1785). Carrying is what let a row read
    // as an observed exact-pool price and a refusal simultaneously.
    const { holding } = noBasisRefusalWrite(WITT, "no-checklist-match", valuation(WITT_SLUG, "ebay-user-purchase", 224.75), NOW);
    expect(holding.fmvRung).toBeNull();
    expect((holding as unknown as Record<string, unknown>).valueSource).toBe("estimated");
    expect((holding as unknown as Record<string, unknown>).valueSource).not.toBe("observed");
    expect(String((holding as unknown as Record<string, unknown>).fmvRungAbsentReason)).toContain("checklist");
  });

  it("says WHY in prose a person can act on, and names the acquisition as the remedy", () => {
    const { prose, summary } = noBasisRefusalWrite(WITT, "no-checklist-match", valuation(WITT_SLUG, "ebay-user-purchase", 224.75), NOW);
    expect(prose).toContain("checklist");
    // The remedy, not just the refusal: a reader told only "no price" goes
    // looking at the pool, which is not where the problem is.
    expect(prose).toMatch(/acquired/);
    expect(summary).toContain("not checklist-backed");
  });

  it("asserts NO confidence of its own and never invents one", () => {
    const { holding } = noBasisRefusalWrite(WITT, "no-checklist-match", valuation(WITT_SLUG, "ebay-user-purchase", 224.75), NOW);
    // The prior pass's 0.41 describes a number this row no longer publishes,
    // but it is the prior META's value and the branch carries meta forward —
    // what must NOT happen is a confidence invented for the refusal itself.
    const c = meta(holding).confidence;
    expect(c === null || c === 0.41).toBe(true);
  });

  it("the reason is distinct from the other two on the same branch", () => {
    // The reason is what tells a reader which work unblocks the row: acquire a
    // checklist, wait for a re-key, or fix a matcher. Collapsing them fails.
    const v = valuation(WITT_SLUG, "ebay-user-purchase", 224.75);
    const mine = noBasisRefusalWrite(WITT, "no-checklist-match", v, NOW);
    const notInCatalog = noBasisRefusalWrite(WITT, "identity-not-in-catalog", v, NOW);
    const migrating = noBasisRefusalWrite(WITT, "pool-migrating", v, NOW);
    expect(mine.prose).not.toBe(notInCatalog.prose);
    expect(mine.prose).not.toBe(migrating.prose);
    expect(notInCatalog.prose).toContain("holds no identity");
    expect(migrating.prose).toContain("re-keyed");
    expect(withheldOf(mine.holding).reason).toBe("no-checklist-match");
    expect(withheldOf(notInCatalog.holding).reason).toBe("identity-not-in-catalog");
    expect(withheldOf(migrating.holding).reason).toBe("pool-migrating");
  });
});
