/**
 * CF-A-WITHHELD-PRICE-IS-NOT-A-MISSING-ONE, at the rescue (Fable, 2026-09-15).
 *
 * THE INCIDENT. Staging-slot deploy 34989816447 refused the swap on smoke
 * case 4 — "2026 Bowman Chrome Owen Carey Black BCP-69", a 2026 /10 parallel
 * whose pool holds zero sold_comps, so the correct answer is a refusal. It
 * came back after 25,321 ms as:
 *
 *     tier:       no-basis
 *     mechanism:  none
 *     verdict:    "Withheld — the pricing engine ran out of time on this card.
 *                  No price was computed."
 *     FMV:        $875
 *
 * A response that contradicts itself in two fields. The price is not from a
 * partial walk, a cache, or a holding's resolvedMarketValue — it is written
 * AFTER the route has already decided to withhold:
 *
 *   compiq.routes.ts:3177  const result = await withPriceDeadline(...)
 *                          -> priceDeadlineWithheld(): fmv null, reason set
 *   compiq.routes.ts:4518  await overlayResolverRescue(result, {...})  // mutates
 *   compiq.routes.ts:4532  res.json(result)
 *
 * and `overlayResolverRescue` guarded on ONE question:
 *
 *     const hasFmv = fairMarketValueLive > 0 || marketValue > 0;
 *     if (hasFmv) return response;          // the only guard
 *
 * A withheld verdict answers "no price" for exactly the same reason a CH
 * catalog-miss does, so the rescue could not tell "the engine declined" from
 * "the engine found nothing" — and it writes the price without ever reading
 * the verdict, which is why the verdict survived intact beside a number that
 * contradicts it.
 *
 * This predates the request deadline. Any withheld path reaching res.json on
 * this route has always been rescuable; #2170 only made it common enough to be
 * caught by a smoke case.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mocked at `resolveCard`, the resolver's own seam — NOT at
 * `tryResolverFallback`, which lives in the same module as the function under
 * test and so cannot be replaced from outside it. Counting resolveCard calls
 * also proves the decline happens BEFORE any lookup, not after one.
 */
const resolveCard = vi.fn();
vi.mock("../src/services/compiq/catalogResolver.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, resolveCard };
});

const { overlayResolverRescue } = await import("../src/services/compiq/resolverFallbackHelper.js");

/** The withheld shape the route emits, as the smoke would receive it. */
function withheldResponse(reason = "ladder-timeout") {
  return {
    success: true,
    source: reason,
    pricingTier: "no-basis",
    fairMarketValue: null,
    marketValue: null,
    fairMarketValueLive: null,
    predictedPrice: null,
    fmvMechanism: null,
    confidence: 0,
    pricingConfidence: 0,
    compsUsed: 0,
    canonicalFmvWithheld: { reason, method: "no-basis", basis: "No price was computed." },
    fmvReason: reason,
    verdict: "Withheld — the pricing engine ran out of time on this card. No price was computed.",
  } as Record<string, unknown>;
}

/** A CH catalog-miss: no price AND no reason. This is what the rescue is for. */
function catalogMissResponse() {
  return {
    success: true,
    source: "catalog-miss",
    pricingTier: "catalog-miss",
    fairMarketValue: null,
    marketValue: null,
    fairMarketValueLive: null,
    verdict: "We couldn't find this card in our catalog.",
  } as Record<string, unknown>;
}

const QUERY = { playerName: "Owen Carey", cardYear: 2026, setName: "Bowman Chrome", cardNumber: "BCP-69" };

beforeEach(() => {
  vi.clearAllMocks();
  // The $875 the slot smoke actually saw, shaped as a resolver winner.
  resolveCard.mockResolvedValue({
    winner: { vendor: "resolver", fairMarketValue: 875, compCount: 3, comps: [] },
  });
});

describe("a withheld verdict is never rescued into a price", () => {
  it("leaves the smoke's case-4 response refused, with no FMV", async () => {
    const res = withheldResponse();

    await overlayResolverRescue(res, QUERY);

    // MUTATION CHECK: before the fix these were 875 — the exact
    // self-contradicting response that refused the swap.
    expect(res.fairMarketValue).toBeNull();
    expect(res.marketValue).toBeNull();
    expect(res.fairMarketValueLive).toBeNull();
  });

  it("does not call the resolver at all for a withheld response", async () => {
    await overlayResolverRescue(withheldResponse(), QUERY);

    // Declining early also stops a needless outbound lookup on a card the
    // engine has already refused to price.
    expect(resolveCard).not.toHaveBeenCalled();
  });

  it("leaves the refusal's OTHER fields alone — no half-overwritten response", async () => {
    const res = withheldResponse();

    await overlayResolverRescue(res, QUERY);

    expect(res.pricingTier).toBe("no-basis");
    expect(res.fmvMechanism).toBeNull();
    expect(res.pricingConfidence).toBe(0);
    // `approximate` marks a synthesised number. A refusal has no number to
    // qualify, so claiming approximation would be its own small lie.
    expect(res.approximate).toBeUndefined();
    expect(String(res.verdict)).toMatch(/^Withheld/);
  });

  it("declines on ANY stated reason, not just ladder-timeout", async () => {
    // The closed vocabulary from oneValuationPath.ValuationReason. Every one
    // of these means "the engine ran and declined".
    for (const reason of [
      "no-exact-pool", "no-exact-pool-at-tier", "pool-migrating",
      "identity-not-in-catalog", "no-catalog-identity", "catalog-lookup-timeout",
    ]) {
      const res = withheldResponse(reason);
      await overlayResolverRescue(res, QUERY);
      expect(res.marketValue, `rescued a response withheld for ${reason}`).toBeNull();
    }
  });

  it("reads the reason from canonicalFmvWithheld too, not only fmvReason", async () => {
    const res = withheldResponse();
    delete res.fmvReason;                       // older shape: only the block

    await overlayResolverRescue(res, QUERY);

    expect(res.marketValue).toBeNull();
  });
});

describe("the rescue still does its job", () => {
  it("rescues a CH catalog-miss, which has no stated reason", async () => {
    const res = catalogMissResponse();

    await overlayResolverRescue(res, QUERY);

    // MUTATION CHECK: this is what the rescue exists for. A fix that declined
    // everything would be trivially "safe" and would silently retire the
    // CH-gap rescue — so this pin is as load-bearing as the ones above.
    expect(res.marketValue).toBe(875);
    expect(res.fairMarketValueLive).toBe(875);
    expect(res.approximate).toBe(true);
  });

  it("still skips a response that already has a real price", async () => {
    const res = { ...catalogMissResponse(), marketValue: 42, fairMarketValueLive: 42 };

    await overlayResolverRescue(res, QUERY);

    expect(res.marketValue).toBe(42);
    expect(resolveCard).not.toHaveBeenCalled();
  });

  it("an empty-string reason is not a reason", async () => {
    const res = { ...catalogMissResponse(), fmvReason: "   " };

    await overlayResolverRescue(res, QUERY);

    // Whitespace must not become an accidental opt-out of the rescue.
    expect(res.marketValue).toBe(875);
  });
});
