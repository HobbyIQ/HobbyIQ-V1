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
