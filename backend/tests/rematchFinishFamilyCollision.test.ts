/**
 * CF-A-COLOUR-FAMILY-IS-SEVERAL-CARDS (Drew, 2026-09-03). The census shape for
 * "green refractors and bases are mixed in": rows whose title and whose slug
 * agree the card is green and disagree about WHICH green card.
 *
 * The slugs below are the measured examples from the 2026-09-03 corpus probe,
 * not invented ones.
 */
const path = require("path");
import { describe, it, expect } from "vitest";
const K = require(path.join(process.cwd(), "scripts", "lib", "rematch-classify.cjs"));

const idOf = (over: Record<string, unknown> = {}) => ({
  sport: "baseball", cardYear: 2025, setKey: "bowman-chrome", cardNumber: "7",
  parallel: "Green Wave", isAuto: false, printRun: null, gradeCompany: null, gradeValue: null,
  ...over,
});

describe("FINISH-FAMILY-COLLISION is measured, tagged, and never writable", () => {
  const slug = "hiq:baseball:2025:bowman-chrome:7:green-geometric-refractor:no-auto";

  it("a Green Wave title on a green-geometric-refractor slug is flagged", () => {
    const res = K.classifyRow({
      row: { source: "cardsight", title: "2025 Bowman Chrome Jesus Made Green Wave #7" },
      stored: idOf(), derived: idOf(), storedSlug: slug, checklistBacked: true,
    });
    expect(res.finishFamilyCollision).toBe(true);
    expect(res.finishFamily).toBe("green");
    expect(res.reasons.join(" ")).toContain("subclass:FINISH-FAMILY-COLLISION:green");
    // The evidence quotes BOTH sides -- Drew rules by reading them.
    expect(res.finishFamilyEvidence.titleQuoted).toContain("Green Wave");
    expect(res.finishFamilyEvidence.storedSlugParallel).toBe("green-geometric-refractor");
  });

  it("the flag is raised on an AGREE-shaped row -- the commonest form", () => {
    const res = K.classifyRow({
      row: { source: "cardhedge", title: "2025 Bowman Chrome Jesus Made Green Wave #7" },
      stored: idOf(), derived: idOf(), storedSlug: slug, checklistBacked: true,
    });
    // Fields and derivation agree completely; only the ADDRESS disagrees.
    expect(res.klass).toBe(K.AGREE);
    expect(res.finishFamilyCollision).toBe(true);
    // ...and AGREE is still not writable, exactly as before.
    expect(res.writable).toBe(false);
  });

  it("it NEVER makes a row writable, on any class or tier", () => {
    for (const source of ["cardsight", "cardhedge", "ebay-user-purchase"]) {
      const res = K.classifyRow({
        row: { source, title: "2025 Bowman Chrome Green Wave #7" },
        stored: idOf({ parallel: "" }), derived: idOf(), storedSlug: slug, checklistBacked: true,
      });
      expect(res.finishFamilyCollision).toBe(true);
      // Without the guard this row reaches IMPROVE + writable: filled:parallel
      // is "strictly more specific and checklist-backed", so the fleet would
      // pick a side of the very family question Drew has not ruled on.
      expect(res.writable).toBe(false);
    }
  });

  it("agreement between title and slug is NOT a collision", () => {
    const res = K.classifyRow({
      row: { source: "cardsight", title: "2025 Bowman Chrome Green Geometric Refractor #7" },
      stored: idOf({ parallel: "Green Geometric Refractor" }),
      derived: idOf({ parallel: "Green Geometric Refractor" }),
      storedSlug: slug, checklistBacked: true,
    });
    expect(res.finishFamilyCollision).toBe(false);
  });

  it("a DIFFERENT colour in the title is an ordinary disagreement, not a family collision", () => {
    const res = K.classifyRow({
      row: { source: "cardsight", title: "2025 Bowman Chrome Blue Refractor #7" },
      stored: idOf({ parallel: "Blue Refractor" }), derived: idOf({ parallel: "Blue Refractor" }),
      storedSlug: slug, checklistBacked: true,
    });
    expect(res.finishFamilyCollision).toBe(false);
  });

  it("a base slug is never a family collision (there is no family on it)", () => {
    const res = K.classifyRow({
      row: { source: "cardsight", title: "2025 Bowman Chrome Green Wave #7" },
      stored: idOf(), derived: idOf(),
      storedSlug: "hiq:baseball:2025:bowman-chrome:7:base:no-auto", checklistBacked: true,
    });
    expect(res.finishFamilyCollision).toBe(false);
  });

  it("colourFamilyOf: one colour is a family, none and two are not", () => {
    expect(K.colourFamilyOf("Green Wave")).toBe("green");
    expect(K.colourFamilyOf("green geometric refractor")).toBe("green");
    expect(K.colourFamilyOf("Refractor")).toBeNull();
    // Ambiguous membership is no membership.
    expect(K.colourFamilyOf("Black & White Red Ink")).toBeNull();
  });

  it("BASE-EVICTION still behaves exactly as before beside it", () => {
    // A title naming NO finish, on a refractor slug, with a base destination.
    // NB "Chrome" is deliberately absent from the title: FINISH_TOKENS carries
    // it as a finish word, so a Bowman CHROME title disqualifies itself from
    // the subclass by design (the documented suppression that makes the
    // measured eviction yield a floor). This fixture is the shape that does
    // qualify -- paper Bowman, no product word.
    const res = K.classifyRow({
      row: { source: "cardsight", title: "2024 Bowman Jesus Made 1st Prospect #BCP-100" },
      stored: idOf({ parallel: "", cardNumber: "BCP-100", cardYear: 2024, setKey: "bowman" }),
      derived: idOf({ parallel: "", cardNumber: "BCP-100", cardYear: 2024, setKey: "bowman" }),
      storedSlug: "hiq:baseball:2024:bowman:bcp-100:refractor:no-auto",
      baseDestSlug: "hiq:baseball:2024:bowman:bcp-100:base:no-auto",
      baseDestBacked: true, checklistBacked: true,
    });
    expect(res.subclass).toBe(K.BASE_EVICTION);
    expect(res.writable).toBe(true);
    expect(res.finishFamilyCollision).toBe(false);
  });
});

/**
 * CF-A-GOLD-SHIMMER-IS-NOT-A-GOLD (Drew, 2026-09-05).
 *
 * The predicate reads the row's `hiq:` ADDRESS. Every caller passes
 * `storedSlug: row.cardId`, and on a CardHedge row that is the vendor's bubble
 * id -- so the whole vendor-keyed population (59% of a 5,000-row 2015+ sample,
 * measured read-only on the live pool 2026-09-05) was invisible to this
 * census. The fixtures below are the LIVE row that prompted the ruling, field
 * for field, plus the mutation checks that pin the widening's edges.
 */
describe("a vendor-keyed row is still addressed -- by hobbyiqCardId", () => {
  // The live row: sold_comps id
  // cardhedge::ch-comp::1778541264103x262828165280045280::2026-06-17T21:06:00.000Z::10250
  const german = {
    source: "cardhedge",
    title: "2026 Bowman Marconi German 1st Auto CPA-MG Gold Shimmer /50 - Raw",
    cardId: "1778541264103x262828165280045280",
    hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:cpa-mg:gold-refractor:auto:num-50",
  };
  const germanId = (over: Record<string, unknown> = {}) => idOf({
    cardYear: 2026, setKey: "bowman-chrome", cardNumber: "CPA-MG",
    parallel: "Gold", isAuto: true, printRun: 50, ...over,
  });

  it("the Gold Shimmer sale on the Gold Refractor pool is FLAGGED", () => {
    const res = K.classifyRow({
      row: german, stored: germanId(),
      derived: germanId({ parallel: "Gold Shimmer Refractor" }),
      storedSlug: german.cardId, checklistBacked: true,
    });
    expect(res.finishFamilyCollision).toBe(true);
    expect(res.finishFamily).toBe("gold");
    expect(res.finishFamilyEvidence.titleFamilyWords).toContain("shimmer");
    expect(res.finishFamilyEvidence.storedSlugParallel).toBe("gold-refractor");
    // The report says WHICH field carried the address.
    expect(res.finishFamilyEvidence.addressField).toBe("hobbyiqCardId");
    expect(res.finishFamilyEvidence.addressSlug).toBe(german.hobbyiqCardId);
  });

  it("MUTATION: without the hobbyiqCardId fallback the row is invisible", () => {
    // Exactly the same row with its `hiq:` address removed -- the state the
    // predicate saw before this fix, and the reason the census reported zero.
    const res = K.classifyRow({
      row: { ...german, hobbyiqCardId: undefined }, stored: germanId(),
      derived: germanId({ parallel: "Gold Shimmer Refractor" }),
      storedSlug: german.cardId, checklistBacked: true,
    });
    expect(res.finishFamilyCollision).toBe(false);
    expect(res.finishFamily).toBeNull();
  });

  it("and it is STILL never writable -- the widening is report-only", () => {
    for (const source of ["cardhedge", "tca-ebay", "cardsight", "ebay-user-purchase"]) {
      const res = K.classifyRow({
        row: { ...german, source }, stored: germanId(),
        derived: germanId({ parallel: "Gold Shimmer Refractor" }),
        storedSlug: german.cardId, checklistBacked: true,
      });
      expect(res.finishFamilyCollision).toBe(true);
      expect(res.writable).toBe(false);
    }
  });

  it("an hiq-keyed cardId still wins -- the fallback never overrides it", () => {
    // cardId IS a slug and names green-geometric-refractor; hobbyiqCardId says
    // something else entirely. The explicit key must be the one reported, or a
    // row whose two addresses disagree would be quoted against the wrong pool.
    const res = K.classifyRow({
      row: {
        source: "cardhedge", title: "2025 Bowman Chrome Jesus Made Green Wave #7",
        cardId: "hiq:baseball:2025:bowman-chrome:7:green-geometric-refractor:no-auto",
        hobbyiqCardId: "hiq:baseball:2025:bowman-chrome:7:blue-refractor:no-auto",
      },
      stored: idOf(), derived: idOf(),
      storedSlug: "hiq:baseball:2025:bowman-chrome:7:green-geometric-refractor:no-auto",
      checklistBacked: true,
    });
    expect(res.finishFamilyCollision).toBe(true);
    expect(res.finishFamilyEvidence.addressField).toBe("cardId");
    expect(res.finishFamilyEvidence.storedSlugParallel).toBe("green-geometric-refractor");
  });

  it("a vendor-keyed row with NO hiq address anywhere stays silent", () => {
    const res = K.classifyRow({
      row: {
        source: "cardhedge", title: "2026 Bowman Marconi German Gold Shimmer /50 - Raw",
        cardId: "1778541264103x262828165280045280", hobbyiqCardId: "1778541264103x262828165280045280",
      },
      stored: germanId(), derived: germanId({ parallel: "Gold Shimmer Refractor" }),
      storedSlug: "1778541264103x262828165280045280", checklistBacked: true,
    });
    expect(res.finishFamilyCollision).toBe(false);
  });

  it("agreement is still not a collision, on the vendor-keyed path too", () => {
    // The German row's OTHER twin (id cardhedge::ch-daily::...::10250): its
    // title and its address both say Gold Shimmer Refractor, word for word.
    // Nothing is added and nothing is dropped, so there is nothing to report --
    // the widening must not turn agreement into a finding.
    const res = K.classifyRow({
      row: {
        source: "cardhedge",
        title: "2026 Bowman Baseball #CPA-MG Gold Shimmer Refractor",
        cardId: "1778541264103x262828165280045280",
        hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:cpa-mg:gold-shimmer-refractor:auto:num-50",
      },
      stored: germanId({ parallel: "Gold Shimmer Refractor" }),
      derived: germanId({ parallel: "Gold Shimmer Refractor" }),
      storedSlug: "1778541264103x262828165280045280", checklistBacked: true,
    });
    expect(res.finishFamilyCollision).toBe(false);
  });

  it("the collision test stays BIDIRECTIONAL on the vendor-keyed path", () => {
    // The $76 sibling. Its address says `gold-shimmer-refractor` and its title
    // -- "Topps Bowman Chrome Gold Shimmer ..." -- never says "refractor". The
    // slug DROPS a word the title lacks, which is the documented second leg of
    // `titleAddsOrDrops`, and it is reported for the same reason the adding
    // direction is. Pinned so the widening is known to carry BOTH legs onto
    // the newly-visible population rather than only the one that motivated it.
    const res = K.classifyRow({
      row: {
        source: "cardhedge",
        title: "2026 Topps Bowman Chrome Gold Shimmer #CPA-MG Marconi German 1st Auto 30/50 DN43 - Raw",
        cardId: "1778541264103x262828165280045280",
        hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:cpa-mg:gold-shimmer-refractor:auto:num-50",
      },
      stored: germanId({ parallel: "Gold Shimmer Refractor" }),
      derived: germanId({ parallel: "Gold Shimmer Refractor" }),
      storedSlug: "1778541264103x262828165280045280", checklistBacked: true,
    });
    expect(res.finishFamilyCollision).toBe(true);
    expect(res.finishFamilyEvidence.addressField).toBe("hobbyiqCardId");
    expect(res.writable).toBe(false);
  });
});
