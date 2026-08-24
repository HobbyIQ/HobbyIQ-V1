/**
 * CF-THE-SLUG-IS-A-PRICING-INPUT-TOO (2026-08-23).
 *
 * Drew: "this consistently drops the price... unless I refresh, the price is
 * wrong."
 *
 * estimateInputChanged decides whether a PATCH triggers a reprice, by diffing
 * buildEstimateRequestFromHolding — the LEGACY engine's input, which carries
 * cardId but NOT hobbyiqCardId. priceHoldingFromOurPool prices from the SLUG.
 * So the our-pool path read a field the change-detector could not see.
 *
 *   2024 Bowman Draft Theo Gillen #CPA-TG Blue Refractor /150, $700 paid.
 *   Identity corrected to the Blue Refractor slug; stored FMV stayed 17.80 and
 *   the page read -97.5%. Asked directly, the engine returns 729 for that exact
 *   slug (rare-card-anchor, "Last sold $729 on 2026-08-20"). It was right the
 *   whole time. Nothing asked it again.
 *
 * This matters more after CF-ONE-PIN-GATE-EVERYWHERE: a rebind below 0.9 moves
 * hobbyiqCardId alone, so without this the whole sub-0.9 path skips repricing.
 */
import { describe, expect, it } from "vitest";
import { estimateInputChanged } from "../src/services/portfolioiq/portfolioStore.service.js";

const base = (over: Record<string, unknown> = {}) => ({
  id: "afd40fed",
  playerName: "Theo Gillen",
  cardYear: 2024,
  product: "Bowman Draft",
  setName: "Bowman Draft",
  parallel: "Blue Refractor",
  isAuto: true,
  cardId: "hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150",
  hobbyiqCardId: "hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150",
  ...over,
}) as any;

describe("a slug change must trigger a reprice", () => {
  it("detects a hobbyiqCardId change even when nothing else moves", () => {
    // The exact sub-0.9 rebind shape: only the slug moves.
    const before = base({ hobbyiqCardId: "hiq:baseball:2024:bowman-draft:cpa-tg:refractor:auto" });
    expect(estimateInputChanged(before, base())).toBe(true);
  });

  it("detects it when cardId is absent entirely — the our-pool-only path", () => {
    const before = base({ cardId: undefined, hobbyiqCardId: "hiq:baseball:2024:bowman-draft:cpa-tg:base:auto" });
    const after = base({ cardId: undefined });
    expect(estimateInputChanged(before, after)).toBe(true);
  });

  it("still detects the changes it always did", () => {
    expect(estimateInputChanged(base(), base({ parallel: "Gold" }))).toBe(true);
    expect(estimateInputChanged(base(), base({ gradeCompany: "PSA", gradeValue: 10 }))).toBe(true);
    expect(estimateInputChanged(base(), base({ cardId: "hiq:baseball:2024:bowman-draft:cpa-tg:gold:auto" }))).toBe(true);
  });
});

describe("it must not reprice on edits the engine cannot see", () => {
  it("is FALSE when only a non-pricing field changes", () => {
    // CF-PHOTO-PATCH-LATENCY exists because repricing on every patch is slow.
    // Widening the trigger must not undo that.
    expect(estimateInputChanged(base(), base({ notes: "bought at the show" }))).toBe(false);
    expect(estimateInputChanged(base(), base({ photos: ["a.jpg"] }))).toBe(false);
    // NOT purchasePrice — it IS a pricing input, and has been since before this
    // change: buildEstimateRequestFromHolding carries it so the
    // cardhedge-last-sale signal helper can see what the user paid. Asserting
    // otherwise here would have pinned a falsehood about the engine.
    expect(estimateInputChanged(base(), base({ purchasePrice: 700 }))).toBe(true);
  });

  it("is FALSE for an identical holding", () => {
    expect(estimateInputChanged(base(), base())).toBe(false);
  });

  it("treats whitespace-only slug differences as no change", () => {
    expect(estimateInputChanged(base(), base({ hobbyiqCardId: "  hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150  " }))).toBe(false);
  });

  it("fails OPEN when there is no previous holding", () => {
    expect(estimateInputChanged(undefined, base())).toBe(true);
  });
});
