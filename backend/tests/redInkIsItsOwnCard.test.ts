/**
 * CF-RED-INK-IS-ITS-OWN-CARD (Drew ruling 2026-08-30, recorded in
 * backend/docs/reference/card-lingo-glossary.md).
 *
 * In Bowman prospect autographs "Red Ink" is the SSP variant OF the Black &
 * White Shimmer auto parallel — a DISTINCT card, not a nickname for the
 * shimmer. NEITHER appears in the hobbymonitor ladder for 2026 Bowman, so no
 * row is minted for them here (no synthetic parallels); this pins the
 * VOCABULARY, so that when a real one is observed — a sale or a holding — it
 * slugs to its own identity instead of collapsing onto a neighbour.
 *
 * Measured before the fix (2026-08-30), all three wrong:
 *   "Black and White Shimmer Refractor"  -> Black Refractor
 *   "Black & White Red Ink"              -> Black Refractor
 *   "Red Ink"                            -> Red Refractor   (an ordinary /5 rung)
 * Only the exact "&"-spelled Shimmer resolved, because the old rule's
 * `black.{0,3}white` window fits " & " but not " and ".
 */
import { describe, it, expect } from "vitest";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service";

const parallelOf = (title: string): string => (parseListingIdentity(title) as any).parallel;
const slugOf = (title: string): string =>
  computeHobbyIqCardId({
    sport: "baseball", year: 2026, setKey: "bowman-chrome",
    cardNumber: "CPA-JG", parallel: parallelOf(title), isAuto: true,
  } as any);

describe("Red Ink and Black & White Shimmer are two different cards", () => {
  it("reads the shimmer however the seller spells the conjunction", () => {
    for (const t of [
      "2026 Bowman Chrome Justin Gonzales Black & White Shimmer Auto CPA-JG",
      "2026 Bowman Chrome Justin Gonzales Black and White Shimmer Refractor Autograph",
      "2026 Bowman Chrome Justin Gonzales B&W Shimmer Auto CPA-JG",
    ]) {
      expect(parallelOf(t)).toBe("Black & White Shimmer Refractor");
    }
  });

  it("reads Red Ink as its own card, with or without the B&W prefix", () => {
    for (const t of [
      "2026 Bowman Chrome Justin Gonzales Black & White Red Ink Auto CPA-JG",
      "2026 Bowman Chrome Justin Gonzales Black and White Red Ink Auto",
      "2026 Bowman Chrome Jack Wheeler Red Ink Autograph CPA-JWH",
      "2026 Bowman Chrome B&W Red Ink Auto CPA-BG",
    ]) {
      expect(parallelOf(t)).toBe("Black & White Red Ink");
    }
  });

  it("never collapses Red Ink into the shimmer, nor either into base", () => {
    const ink = "2026 Bowman Chrome Justin Gonzales Black & White Red Ink Auto CPA-JG";
    const shimmer = "2026 Bowman Chrome Justin Gonzales Black & White Shimmer Auto CPA-JG";
    expect(parallelOf(ink)).not.toBe(parallelOf(shimmer));
    for (const t of [ink, shimmer]) {
      expect(parallelOf(t).toLowerCase()).not.toBe("base");
      expect(parallelOf(t)).toBeTruthy();
    }
  });

  it("does not swallow an ordinary Red rung, nor Gold Ink", () => {
    expect(parallelOf("2026 Bowman Chrome Red Refractor Auto CPA-JG")).toBe("Red Refractor");
    expect(parallelOf("2026 Bowman Chrome Justin Gonzales Gold Ink Auto CPA-JG")).toBe("Gold Ink");
  });

  it("gives each its own slug — the spellings parallelLadders.ts already holds", () => {
    expect(slugOf("2026 Bowman Chrome Justin Gonzales Black & White Red Ink Auto CPA-JG"))
      .toBe("hiq:baseball:2026:bowman-chrome:cpa-jg:black-white-red-ink:auto");
    expect(slugOf("2026 Bowman Chrome Justin Gonzales Black & White Shimmer Auto CPA-JG"))
      .toBe("hiq:baseball:2026:bowman-chrome:cpa-jg:black-white-shimmer-refractor:auto");
  });
});
