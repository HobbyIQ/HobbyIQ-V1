/**
 * CF-AN-UMBRELLA-FOLD-NEEDS-THE-TITLE-NOT-THE-COLLAPSED-KEY (2026-09-19).
 *
 * #2290/#2291 taught normalizeSetKey and the fold-umbrella-to-series.cjs
 * relocation lane that "UD Series 2" / "Upper Deck Series 2" name a
 * registered product -- but FRESH sales were still keying bare `upper-deck`,
 * because the vendor field (CardHedge card_set, TCA card_set) wins over the
 * title upstream (persistVendorSalesToPool.service.ts:1140), and R29's
 * "checklist decides the product" resolver (resolveProductByChecklist.ts) is
 * always fed the ALREADY-COLLAPSED setKey as its `productText`, never the
 * title -- so its own candidateProducts() search can never see "series-2"
 * once the vendor field has already thrown it away.
 *
 * `productTextForResolver` is the fix: it hands the resolver the title's own
 * slug instead of the collapsed key, but ONLY for a v1 allow-list (upper-deck
 * only, today -- see its own header for why `topps` / `topps-chrome` /
 * `topps-heritage`, which also have registered `refines` children, are
 * excluded). Everything below is pinned against the REAL resolver and a fake
 * catalog container, the same fixture shape resolveProductByChecklist.test.ts
 * already uses, so these tests exercise the actual two-gate machinery -- not
 * a mock of it.
 */
import { describe, it, expect } from "vitest";
import {
  productTextForResolver,
  resolveProductByChecklist,
  candidateProducts,
  newResolveCache,
} from "../src/services/catalog/resolveProductByChecklist.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

interface Row { year: number; setKey: string; cardNumber: string; playerName: string | null; source: string | null }

/** A card_catalog stand-in, same query shapes resolveProductByChecklist.test.ts uses. */
function fakeContainer(rows: Row[]) {
  return {
    items: {
      query(spec: { query: string; parameters: Array<{ name: string; value: unknown }> }) {
        const p = Object.fromEntries(spec.parameters.map((x) => [x.name, x.value]));
        const byCard = spec.query.includes("c.cardNumber = @n");
        const hits = rows.filter(
          (r) => r.year === p["@y"] && r.setKey === p["@s"] && (!byCard || r.cardNumber === p["@n"]),
        );
        return { fetchAll: async () => ({ resources: hits.map((r) => ({ playerName: r.playerName, source: r.source })) }) };
      },
    },
  } as never;
}
const ctx = (rows: Row[]) => ({ container: fakeContainer(rows), cache: newResolveCache() });

describe("productTextForResolver -- the v1 allow-list", () => {
  it("widens to the title's slug for the allow-listed upper-deck umbrella", () => {
    const t = productTextForResolver("upper-deck", "hockey", "2023-24 Upper Deck Series 2 Young Guns #492", normalizeSetKey);
    expect(t).toBe("2023-24-upper-deck-series-2-young-guns-492");
  });

  it("passes the plain normalized key through UNCHANGED for a non-umbrella key (Bowman Chrome)", () => {
    // Pins byte-identical behaviour: this call site's output for a real,
    // non-umbrella title must be indistinguishable from what
    // canonicalNormalizeSetKey(setKey, sport) alone already returned before
    // this PR -- no widening, no title read, nothing new for the resolver
    // to see that it could not see before.
    const title = "2026 Bowman Chrome Junior Caminero Pulsar Refractor #/399 Rays";
    const before = normalizeSetKey("bowman-chrome", "baseball");
    const after = productTextForResolver("bowman-chrome", "baseball", title, normalizeSetKey);
    expect(after).toBe(before);
    expect(after).toBe("bowman-chrome");
  });

  it("passes non-allow-listed umbrellas through UNCHANGED even though they have registered refines children (topps, topps-chrome, topps-heritage)", () => {
    for (const [key, sport] of [["topps", "baseball"], ["topps-chrome", "baseball"], ["topps-heritage", "baseball"]] as const) {
      const before = normalizeSetKey(key, sport);
      const after = productTextForResolver(key, sport, "2025 Topps Series 2 Baseball #234", normalizeSetKey);
      expect(after, `${key} must not widen`).toBe(before);
    }
  });

  it("leaves a title-less call unchanged even on the allow-list", () => {
    const t = productTextForResolver("upper-deck", "hockey", null, normalizeSetKey);
    expect(t).toBe("upper-deck");
  });

  it("does not widen when the umbrella itself has no registered children (a made-up key)", () => {
    const t = productTextForResolver("topps-stadium-club", "baseball", "2025 Topps Stadium Club #12", normalizeSetKey);
    expect(t).toBe("topps-stadium-club");
  });
});

describe("the full two-gate resolve, through the real resolver, for upper-deck", () => {
  it("umbrella + one series word + catalog holds the number -> the child", async () => {
    const rows: Row[] = [
      { year: 2024, setKey: "upper-deck-series-2", cardNumber: "492", playerName: "Macklin Celebrini", source: "checklistinsider-2026-09" },
    ];
    const productText = productTextForResolver("upper-deck", "hockey", "2023-24 Upper Deck Series 2 Young Guns #492", normalizeSetKey);
    const r = await resolveProductByChecklist(
      { productText, year: 2024, cardNumber: "492", player: "Macklin Celebrini", sport: "hockey", parsedSetKey: "upper-deck" },
      ctx(rows),
    );
    expect(r.setKey).toBe("upper-deck-series-2");
    expect(r.verdict).toBe("resolved");
    expect(r.candidates).toContain("upper-deck");
  });

  it("umbrella + one series word + catalog does NOT hold the number -> stays on the umbrella", async () => {
    // Same title, but the checklist has no row for this number under the
    // child -- an ACQUISITION signal, never a guess (CF-ABSENT-BEATS-WRONG).
    const rows: Row[] = []; // no catalog row anywhere
    const productText = productTextForResolver("upper-deck", "hockey", "2023-24 Upper Deck Series 2 Young Guns #492", normalizeSetKey);
    const r = await resolveProductByChecklist(
      { productText, year: 2024, cardNumber: "492", player: "Macklin Celebrini", sport: "hockey", parsedSetKey: "upper-deck" },
      ctx(rows),
    );
    expect(r.setKey).toBeNull();
    expect(r.verdict === "unknown" || r.verdict === "no-checklist").toBe(true);
  });

  it("umbrella + two series words named -> stays on the umbrella (ambiguous)", async () => {
    // "Upper Deck" repeated before each series number, so candidateProducts's
    // contiguous-run test finds BOTH `upper-deck-series-1` and
    // `upper-deck-series-2` as candidates (a single "Series 1 & Series 2"
    // combo title slugifies to one run `...-series-1-series-2-...`, which
    // only the FIRST number sits adjacent to "upper-deck" in -- a genuine,
    // different-shaped case from a title that plainly repeats the maker word
    // for each product it names, which is the shape this test pins).
    const rows: Row[] = [
      { year: 2024, setKey: "upper-deck-series-1", cardNumber: "199", playerName: "Someone", source: "checklistinsider-2026-09" },
      { year: 2024, setKey: "upper-deck-series-2", cardNumber: "199", playerName: "Someone Else", source: "checklistinsider-2026-09" },
    ];
    const title = "Upper Deck Series 1 and Upper Deck Series 2 Lot #199";
    const productText = productTextForResolver("upper-deck", "hockey", title, normalizeSetKey);
    expect(candidateProducts(productText, 2024)).toEqual(
      expect.arrayContaining(["upper-deck-series-1", "upper-deck-series-2"]),
    );
    const r = await resolveProductByChecklist(
      { productText, year: 2024, cardNumber: "199", player: null, sport: "hockey", parsedSetKey: "upper-deck" },
      ctx(rows),
    );
    // Series 1 and Series 2 both matched as candidates, both hold rows for
    // DIFFERENT players, and no player was stated to break the tie -- the
    // resolver's own ordinary "tie the words cannot break" refusal, unchanged
    // by this PR.
    expect(r.setKey).toBeNull();
  });

  it("a non-umbrella key's resolver input is unchanged -- pinned with a real Bowman Chrome title", async () => {
    const rows: Row[] = [
      { year: 2026, setKey: "bowman-chrome", cardNumber: "CPA-EHA", playerName: "Eric Hartman", source: "checklist" },
    ];
    const title = "2026 Bowman Chrome Junior Caminero Pulsar Refractor #/399 Rays";
    const productText = productTextForResolver("bowman-chrome", "baseball", title, normalizeSetKey);
    expect(productText).toBe("bowman-chrome");
    const r = await resolveProductByChecklist(
      { productText, year: 2026, cardNumber: "CPA-EHA", player: "Eric Hartman", sport: "baseball", parsedSetKey: "bowman-chrome" },
      ctx(rows),
    );
    expect(r.setKey).toBe("bowman-chrome");
    // `bowman` is a genuine candidate too -- candidateProducts always includes
    // a hit's registered parent chain (the flagship is a real rival the
    // checklist must be allowed to rule out) -- this PR does not change that.
    // The point being pinned is that productText itself did not widen.
    expect(r.candidates).toEqual(expect.arrayContaining(["bowman-chrome"]));
    expect(r.holders).toEqual(["bowman-chrome"]);
  });

  it("baseball upper-deck (no children registered for that sport/year in the catalog) is unchanged -- gate 2 refuses", async () => {
    // Upper Deck baseball has NO series-1/2/extended-series checklist rows --
    // the products are hockey-only. Even though productRefinementsOf has no
    // sport axis (so productText still widens to the title's slug), gate 2
    // (checklistHolds) finds nothing under the child key for a baseball year,
    // so the umbrella is never moved. This is the real protection, not a
    // sport pre-filter -- the table has no sport field to filter on.
    const rows: Row[] = [
      { year: 1989, setKey: "upper-deck", cardNumber: "1", playerName: "Ken Griffey Jr.", source: "baseballcardpedia" },
    ];
    const productText = productTextForResolver("upper-deck", "baseball", "1989 Upper Deck Baseball #1 Ken Griffey Jr.", normalizeSetKey);
    const r = await resolveProductByChecklist(
      { productText, year: 1989, cardNumber: "1", player: "Ken Griffey Jr.", sport: "baseball", parsedSetKey: "upper-deck" },
      ctx(rows),
    );
    // No series word in a plain baseball title in the first place, so the
    // only candidate is the umbrella itself, and the umbrella's own row holds
    // the card -- resolved to itself, never moved.
    expect(r.setKey).toBe("upper-deck");
  });

  it("Pokemon is untouched -- productTextForResolver never widens a pokemon setKey", () => {
    const t = productTextForResolver("sv8a", "pokemon", "Scarlet & Violet Terastal Festival #050", normalizeSetKey);
    expect(t).toBe(normalizeSetKey("sv8a", "pokemon"));
  });
});
