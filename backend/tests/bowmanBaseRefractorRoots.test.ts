/**
 * CF-BASES-ARE-MIXED-IN-WITH-REFRACTORS (Drew, 2026-09-03: "Green refractors
 * and bases are mixed in. This is a systematic issue. Bases are mixed in with
 * refractors in ALL of Bowman").
 *
 * Prior fixes were per-card lists. This pins the ROOTS: every writer that could
 * mint a finish the card's own title never named, plus the reader that let an
 * adjudicated-wrong row back into a live pool.
 *
 * Each root gets the same shape of pin: the OLD behaviour (a base title
 * minting a refractor) is asserted GONE, and the behaviour the fix must not
 * break is asserted intact beside it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parallelTheTitleAllows } from "../src/services/portfolioiq/titleOutranksVendorTag.js";
import { mapChRowToSoldComp } from "../src/services/portfolioiq/chRowToSoldComp.js";

// ── ROOT 1: chRowToSoldComp -- the CardHedge product variant ───────────────
//
// The mapper stamped `row.variant` (CardHedge's PRODUCT variant) onto every
// SALE of that product. The live damage: 50 base autos, titles naming no
// finish, written onto ...:cpa-vf:black-white-red-ink-refractor:auto at a
// $10.10 median while the one genuine Red Ink sale was $270.
describe("ROOT 1: a CH product variant never mints a finish the title lacks", () => {
  const chRow = (over: Record<string, unknown> = {}) => ({
    card_id: "ch-123",
    group: "baseball",
    player: "Victor Figueroa",
    price: 11.5,
    sale_date: "2026-08-30T00:00:00Z",
    year: 2026,
    card_set: "Bowman Chrome",
    price_history_id: "ph-1",
    description: "2026 Bowman Victor Figueroa Chrome Auto Autograph 1st Prospect #CPA-VF Orioles - Raw",
    ...over,
  }) as never;

  it("the real CPA-VF title + the Red Ink variant no longer writes Red Ink", () => {
    const res = mapChRowToSoldComp(chRow({ variant: "Black & White Red Ink" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // OLD: parallel === "Black & White Red Ink" -- the 50-row poisoning.
    expect(res.input.parallel).toBe("Base");
    expect(res.vendorParallelOverruled).toBe("Black & White Red Ink");
  });

  it("a bare 'Refractor' variant on a silent title is refused too", () => {
    const res = mapChRowToSoldComp(chRow({ variant: "Refractor" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input.parallel).toBe("Base");
  });

  it("a variant the TITLE corroborates is still adopted", () => {
    const res = mapChRowToSoldComp(chRow({
      variant: "Gold Refractor",
      description: "2026 Bowman Chrome Victor Figueroa Gold Refractor Auto #CPA-VF /50",
    }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input.parallel).toBe("Gold Refractor");
    expect(res.vendorParallelOverruled).toBeNull();
  });

  it("a genuine Base product stays Base, and nothing else about the row moves", () => {
    const res = mapChRowToSoldComp(chRow({ variant: "Base" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input.parallel).toBe("Base");
    expect(res.input.source).toBe("cardhedge");
    expect(res.input.sourceExternalId).toBe("ch-daily::ph-1");
    expect(res.input.price).toBe(11.5);
  });
});

// ── ROOT 4: the green family is four cards, not one ───────────────────────
//
// The `refines()` suffix rule adopted ANY vendor tag ending in the title's
// word, so a bare "Green" title inherited "Green Wave" / "Green Shimmer" /
// "Green Mojo Refractor". Measured 2026-09-03: 122 Bowman slugs carry rows
// whose titles name green, green-refractor and green-wave at once.
describe("ROOT 4: green, green refractor, green shimmer and green wave stay distinct", () => {
  it("a bare colour is NOT promoted into another finish family", () => {
    expect(parallelTheTitleAllows("Green", "Green Wave"))
      .toEqual({ parallel: "Green", vendorTagOverruled: "Green Wave" });
    expect(parallelTheTitleAllows("Green", "Green Shimmer"))
      .toEqual({ parallel: "Green", vendorTagOverruled: "Green Shimmer" });
    expect(parallelTheTitleAllows("Green", "Green Mojo Refractor"))
      .toEqual({ parallel: "Green", vendorTagOverruled: "Green Mojo Refractor" });
    // The same rule for every colour, not a green special case.
    expect(parallelTheTitleAllows("Blue", "Blue Shimmer").parallel).toBe("Blue");
  });

  it("the ONE ruled promotion -- '{Colour}' to '{Colour} Refractor' -- survives", () => {
    // "True {Color}" = "{Color} Refractor" (market-language normalization).
    expect(parallelTheTitleAllows("Green", "Green Refractor"))
      .toEqual({ parallel: "Green Refractor", vendorTagOverruled: null });
    expect(parallelTheTitleAllows("Gold", "Gold Refractor").parallel).toBe("Gold Refractor");
  });

  it("a title that already names a finish is untouched by the narrowing", () => {
    // The pinned refinement cases from titleOutranksVendorTag.test.ts.
    expect(parallelTheTitleAllows("Refractor", "Blue").parallel).toBe("Blue");
    expect(parallelTheTitleAllows("Refractor", "Gold Refractor").parallel).toBe("Gold Refractor");
    expect(parallelTheTitleAllows("Green Refractor", "Green Wave").parallel).toBe("Green Refractor");
    // The Red Ink fuller-spelling rule.
    expect(parallelTheTitleAllows("Black White Red", "Black & White Red Ink").parallel)
      .toBe("Black & White Red Ink");
  });
});

// ── READER (POOL-1): an adjudicated row stays out of the pool ─────────────
describe("POOL-1: readExactPoolRows excludes flaggedWrong and excludedFromFmv", () => {
  const captured: { query?: string } = {};
  beforeEach(() => { captured.query = undefined; vi.resetModules(); });

  async function loadReader() {
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() {
          return {
            container: () => ({
              items: {
                query: (spec: { query: string }) => {
                  captured.query = spec.query;
                  return { fetchAll: async () => ({ resources: [] }) };
                },
              },
            }),
          };
        }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=k==;";
    return await import("../src/services/compiq/exactPoolReader.js");
  }

  it("both predicates are in the WHERE clause", async () => {
    const { readExactPoolRows } = await loadReader();
    await readExactPoolRows({ cardId: "hiq:baseball:2026:bowman:1:base:no-auto", hobbyiqCardId: null, windowDays: 90 });
    expect(captured.query).toBeDefined();
    // MUTATION: delete either predicate from exactPoolReader.ts and these fail.
    expect(captured.query).toContain("c.flaggedWrong != true");
    expect(captured.query).toContain("c.excludedFromFmv != true");
    // The undefined-tolerant disjunct is what keeps ordinary rows in.
    expect(captured.query).toContain("NOT IS_DEFINED(c.flaggedWrong)");
    expect(captured.query).toContain("NOT IS_DEFINED(c.excludedFromFmv)");
  });

  it("the identity union and the anomaly filter are unchanged", async () => {
    const { readExactPoolRows } = await loadReader();
    await readExactPoolRows({ cardId: "cid-1", hobbyiqCardId: "hiq:baseball:2026:bowman:1:base:no-auto", windowDays: 90 });
    expect(captured.query).toContain("c.cardId = @cid");
    expect(captured.query).toContain("c.hobbyiqCardId = @hiq");
    expect(captured.query).toContain("c.priceAnomaly != true");
  });
});
