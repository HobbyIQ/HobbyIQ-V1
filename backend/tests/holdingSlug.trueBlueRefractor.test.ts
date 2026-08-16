// CF-BARE-COLOR-TITLE-REFRACTOR-UPGRADE (Drew, 2026-07-28). Pins the
// title-aware upgrade for user-typed holdings that carry a bare color
// parallel ("Blue") but whose title signals a Refractor variant.
// Hartshorn root cause: parallel="Blue" + title="…Bowman Chrome
// Refractor…True" was slugging to :blue:auto while every CH/CS ingest
// of the same physical card slugs to :blue-refractor:auto.

// SETKEYS RECONCILED TO THE CATALOG, 2026-08-16 (Drew: "it shuld fold into
// Draft since it is draft" ... "they should match to the CATALOG").
//
// The rule is now simple: a slug's setKey must be a key the CATALOG actually
// uses, because a slug nothing in the catalog shares is a card that matches
// nothing. Row counts taken 2026-08-16:
//
//     bowman-draft-chrome   23,899      bowman-chrome-draft      480
//     bowman-draft         336,404      bowman-draft-paper        18
//     bowman             1,252,848      bowman-paper           1,785
//
// So Draft Chrome keeps its Draft identity under bowman-draft-chrome (not the
// bowman-chrome it used to collapse into, and not the bowman-chrome-draft this
// file previously asked for — that variant was itself a fragment the
// normaliser had been minting). BDA- paper Draft autos go to bowman-draft
// rather than the 18-row bowman-draft-paper.

import { describe, expect, it } from "vitest";
import { deriveHoldingSlug } from "../src/services/portfolioiq/holdingSlug.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const HARTSHORN_BASE = {
  id: "test-hartshorn",
  playerName: "Josiah Hartshorn",
  cardYear: 2025,
  product: "Bowman Draft Chrome Baseball",
  setName: "Bowman Draft Chrome Baseball",
  cardNumber: "CPA-JHA",
  isAuto: true,
} as unknown as PortfolioHolding;

describe("deriveHoldingSlug — bare color + title Refractor upgrade", () => {
  it("bare 'Blue' + title 'Refractor' → :blue-refractor:auto (Hartshorn case)", () => {
    const holding = {
      ...HARTSHORN_BASE,
      parallel: "Blue",
      cardTitle: "2025 Bowman Chrome Refractor Draft Josiah Hartshorn True",
    } as unknown as PortfolioHolding;
    const slug = deriveHoldingSlug(holding);
    expect(slug).toBe("hiq:baseball:2025:bowman-draft-chrome:cpa-jha:blue-refractor:auto");
  });

  it("bare 'Blue' + title with 'True Blue' → :blue-refractor:auto", () => {
    const holding = {
      ...HARTSHORN_BASE,
      parallel: "Blue",
      cardTitle: "2025 Bowman Draft True Blue Josiah Hartshorn Auto",
    } as unknown as PortfolioHolding;
    const slug = deriveHoldingSlug(holding);
    expect(slug).toBe("hiq:baseball:2025:bowman-draft-chrome:cpa-jha:blue-refractor:auto");
  });

  it("bare 'Blue' + title WITHOUT refractor/true signal → :blue:auto (no upgrade)", () => {
    // We don't want to universally upgrade "Blue" to Blue Refractor —
    // only when the title tells us to. This case is a genuine "Blue"
    // parallel with no refractor signal, so slug stays :blue:.
    const holding = {
      ...HARTSHORN_BASE,
      parallel: "Blue",
      cardTitle: "2025 Bowman Draft Josiah Hartshorn Blue Ice",
    } as unknown as PortfolioHolding;
    const slug = deriveHoldingSlug(holding);
    expect(slug).toBe("hiq:baseball:2025:bowman-draft-chrome:cpa-jha:blue:auto");
  });

  it("existing 'Blue Refractor' parallel is unaffected", () => {
    const holding = {
      ...HARTSHORN_BASE,
      parallel: "Blue Refractor",
      cardTitle: "2025 Bowman Draft Chrome Refractor Josiah Hartshorn",
    } as unknown as PortfolioHolding;
    const slug = deriveHoldingSlug(holding);
    expect(slug).toBe("hiq:baseball:2025:bowman-draft-chrome:cpa-jha:blue-refractor:auto");
  });

  it("non-color parallel (Base) + Refractor in title → not upgraded", () => {
    // Base is not a color — the upgrade heuristic shouldn't touch it,
    // even though the title contains "Refractor" (which would just
    // mean this holding is a base card described in a common way).
    const holding = {
      ...HARTSHORN_BASE,
      parallel: "Base",
      cardTitle: "2025 Bowman Draft Chrome Base Auto Refractor family",
    } as unknown as PortfolioHolding;
    const slug = deriveHoldingSlug(holding);
    expect(slug).toBe("hiq:baseball:2025:bowman-draft-chrome:cpa-jha:base:auto");
  });

  it("null title → no upgrade (parallel stays bare)", () => {
    const holding = {
      ...HARTSHORN_BASE,
      parallel: "Blue",
      cardTitle: null,
    } as unknown as PortfolioHolding;
    const slug = deriveHoldingSlug(holding);
    expect(slug).toBe("hiq:baseball:2025:bowman-draft-chrome:cpa-jha:blue:auto");
  });
});
