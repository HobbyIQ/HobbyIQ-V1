/**
 * CF-THE-CHECKLIST-IS-THE-AUTHORITY, on the merge (2026-09-04).
 *
 * Measured against the SCC-CANARY2 apply. 1979-80 O-Pee-Chee Hockey holds 821
 * catalog rows: 396 from sportscardchecklist-2026-09-04 (ungraded, parallel
 * null, confidence 0.95) and 420 from ingest-auto-seed-graded, of which 414
 * carry the literal word "Base".
 *
 * TWO FINDINGS SHAPE THESE PINS, and the second is why half this file is about
 * what the merge must NOT do.
 *
 * 1. The seeded rows are GRADED CHILDREN -- `...:base:no-auto:psa-8`. They sit
 *    at their own slugs, so the checklist never merged onto them and the "347
 *    CONFLICT" was never a merge the ingest lost. What it IS is a disagreement
 *    between a parent's checklist row and its graded children.
 *
 * 2. The checklist is not uniformly the better name. Over all 39 disagreements
 *    at the same cardNumber:
 *
 *      checklist RIGHT  Rene Robert (not Roberts), Gord Lane, Gary Croteau,
 *                       Dave Hutchison, Bobby Schmautz, Syl Apps Jr.
 *      checklist WORSE  "Emblem Jets" for "Jets Emblem", "Team North Stars"
 *                       for "North Stars Team", "Stanley Cup" for "Canadiens
 *                       Make It", and bare "Checklist" for "Checklist 1-132"
 *                       -- the RANGE that tells three different cards apart in
 *                       prose (they stay distinct rows regardless: playerName
 *                       is not in the slug, verified below).
 *      multi-player     4 leader cards where the checklist's slash-joined list
 *                       is MORE complete than the seed's single name, but is a
 *                       LIST and not a playerName.
 *
 * So "the checklist supersedes on identity fields" is true of AUTHORITY -- a
 * rank question, pinned in catalogAuthorityDerivedNeverChecklist -- and is NOT
 * a licence to blanket-overwrite playerName. 18 of 39 would be regressions.
 * The one identity field the losing branch may still correct is the literal
 * "Base" parallel: that word asserts a finish no checklist states (#1634), and
 * blanking it is provably slug-neutral.
 */
import { describe, it, expect } from "vitest";
import {
  mergeCatalogEntries,
  isLiteralBaseParallel,
  isBlankParallel,
} from "../src/services/portfolioiq/cardCatalog.service.js";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

const NOW = "2026-09-04T08:30:00.000Z";

/** A row as the SCC ingest builds it: blank parallel, 0.95, checklist source. */
const checklistRow = (over: Record<string, unknown> = {}) => ({
  id: "hiq:hockey:1979:o-pee-chee:12:base:no-auto",
  cardId: "hiq:hockey:1979:o-pee-chee:12:base:no-auto",
  sport: "hockey", year: 1979, setKey: "o-pee-chee",
  cardNumber: "12", parallel: null, playerName: "Rene Robert",
  source: "sportscardchecklist-2026-09-04", confidence: 0.95,
  vendorIds: {},
  ...over,
}) as never;

/** A row as ingest-auto-seed left it: literal "Base", 0.85, derived source. */
const seededRow = (over: Record<string, unknown> = {}) => ({
  id: "hiq:hockey:1979:o-pee-chee:12:base:no-auto",
  cardId: "hiq:hockey:1979:o-pee-chee:12:base:no-auto",
  sport: "hockey", year: 1979, setKey: "o-pee-chee",
  cardNumber: "12", parallel: "Base", playerName: "Rene Roberts",
  source: "ingest-auto-seed", confidence: 0.85,
  vendorIds: {}, observedAt: "2026-08-26T00:00:00.000Z",
  ...over,
}) as never;

describe("a checklist supersedes a synthesised row on the same identity", () => {
  it("the Rene Robert fixture: the checklist wins and the misspelling goes", () => {
    const { merged, winnerIsIncoming } = mergeCatalogEntries(checklistRow(), seededRow(), NOW);
    expect(winnerIsIncoming).toBe(true);
    expect(merged.playerName).toBe("Rene Robert");
    expect(merged.source).toBe("sportscardchecklist-2026-09-04");
    expect(merged.parallel).toBeNull();
  });

  it("wins over derived-from-base-* too -- the tie that used to keep the row", () => {
    // Before the classifier fix this incumbent ranked 3, tying the checklist,
    // and a tie keeps the INCUMBENT. That regression, pinned.
    const incumbent = seededRow({
      source: "derived-from-base-checklist-2026-08-23",
      playerName: "Rene Roberts",
      confidence: 0.95,
    });
    const { merged, winnerIsIncoming } = mergeCatalogEntries(checklistRow(), incumbent, NOW);
    expect(winnerIsIncoming).toBe(true);
    expect(merged.playerName).toBe("Rene Robert");
  });

  it("wins over sales-attested, which used to rank below the seeds", () => {
    const incumbent = seededRow({ source: "sales-attested-2026-08", playerName: "Rene Roberts" });
    expect(mergeCatalogEntries(checklistRow(), incumbent, NOW).winnerIsIncoming).toBe(true);
  });

  it("the reverse is refused: a synthesised row never corrects a checklist", () => {
    // "Only improve" is directional. This is the half that must never flip.
    const { merged, winnerIsIncoming } = mergeCatalogEntries(
      seededRow({ playerName: "Rene Roberts" }),
      checklistRow({ playerName: "Rene Robert" }) as never,
      NOW,
    );
    expect(winnerIsIncoming).toBe(false);
    expect(merged.playerName).toBe("Rene Robert");
    expect(merged.source).toBe("sportscardchecklist-2026-09-04");
  });
});

describe("the literal Base a losing checklist may still correct (#1634)", () => {
  it("blanks the invented word and keeps the previous value under parallelBefore", () => {
    // The incumbent is a checklist too, so the incoming row LOSES the tie --
    // and this is still the one field it may put right.
    const incumbent = seededRow({ source: "beckett-scraped-2026-08-19", confidence: 0.99, parallel: "Base" });
    const { merged, winnerIsIncoming } = mergeCatalogEntries(checklistRow(), incumbent, NOW);
    expect(winnerIsIncoming).toBe(false);
    expect(merged.parallel).toBeNull();
    expect((merged as unknown as Record<string, unknown>).parallelBefore).toBe("Base");
  });

  it("a REAL parallel name on the losing branch is never touched", () => {
    const incumbent = seededRow({ source: "beckett-scraped-2026-08-19", confidence: 0.99, parallel: "Silver Prizm" });
    const { merged } = mergeCatalogEntries(checklistRow(), incumbent, NOW);
    expect(merged.parallel).toBe("Silver Prizm");
    expect((merged as unknown as Record<string, unknown>).parallelBefore).toBeUndefined();
  });

  it("a checklist that NAMES a rung cannot erase one -- the incoming must be blank", () => {
    const incoming = checklistRow({ parallel: "O-Pee-Chee Gold" });
    const incumbent = seededRow({ source: "beckett-scraped-2026-08-19", confidence: 0.99, parallel: "Base" });
    const { merged } = mergeCatalogEntries(incoming, incumbent, NOW);
    expect(merged.parallel).toBe("Base");
  });

  it("a non-checklist incoming row may not blank it either", () => {
    const incoming = checklistRow({ source: "ingest-auto-seed", confidence: 0.99, parallel: null });
    const incumbent = seededRow({ source: "beckett-scraped-2026-08-19", confidence: 0.995, parallel: "Base" });
    const { merged } = mergeCatalogEntries(incoming, incumbent, NOW);
    expect(merged.parallel).toBe("Base");
  });

  it("the predicates are the ones the stored-row repair uses", () => {
    for (const v of ["Base", "base", " Base ", "BASE"]) expect(isLiteralBaseParallel(v)).toBe(true);
    for (const v of ["Silver Prizm", "Base Refractor", "", null]) expect(isLiteralBaseParallel(v)).toBe(false);
    for (const v of ["", "   ", null, undefined]) expect(isBlankParallel(v)).toBe(true);
    for (const v of ["Base", "Gold"]) expect(isBlankParallel(v)).toBe(false);
  });

  it("blanking cannot move the row -- every spelling is the same slug", () => {
    // What makes the write safe: no pool split, no FMV move.
    const slug = (parallel: string | null) => computeHobbyIqCardId({
      sport: "hockey", year: 1979, setKey: "o-pee-chee", cardNumber: "12",
      parallel: parallel as never, isAuto: false, printRun: null, playerName: "Rene Robert",
    });
    const blank = slug("");
    for (const v of ["Base", " Base ", null]) expect(slug(v as never)).toBe(blank);
    expect(slug("O-Pee-Chee Gold")).not.toBe(blank);
  });
});

describe("what the merge must NOT do -- the regressions it would ship", () => {
  /** Real disagreements, read out of the catalog 2026-09-04. */
  const WORSE_ON_THE_CHECKLIST: Array<[string, string, string]> = [
    ["81", "Jets Emblem", "Emblem Jets"],
    ["82", "Oilers Emblem", "Emblem Oilers"],
    ["251", "North Stars Team", "Team North Stars"],
    ["83", "Canadiens Make It", "Stanley Cup"],
    ["131", "Checklist 1-132", "Checklist"],
    ["237", "Checklist 133-264", "Checklist"],
    ["346", "Checklist 265-396", "Checklist"],
  ];

  const MULTI_PLAYER_LEADER_CARDS: Array<[string, string, string]> = [
    ["1", "Mike Bossy", "Mike Bossy/Marcel Dionne/Guy Lafleur"],
    ["2", "Bryan Trottier", "Bryan Trottier/Guy Lafleur/Marcel Dionne/Bob MacMillan"],
    ["5", "Mike Bossy", "Mike Bossy/Marcel Dionne/Lanny McDonald/Paul Gardner"],
    ["7", "Game Winning Goals Leaders", "Guy Lafleur/Mike Bossy/Bryan Trottier/Jean Pronovost/Ted Bulley"],
  ];

  it("a LOSING checklist row does not rewrite playerName -- not even a better one", () => {
    // The losing branch corrects the literal "Base" and nothing else. Widening
    // it to playerName is what would ship the regressions listed below.
    const incumbent = seededRow({ source: "beckett-scraped-2026-08-19", confidence: 0.99, playerName: "Checklist 1-132" });
    const incoming = checklistRow({ playerName: "Checklist" });
    const { merged, winnerIsIncoming } = mergeCatalogEntries(incoming, incumbent, NOW);
    expect(winnerIsIncoming).toBe(false);
    expect(merged.playerName).toBe("Checklist 1-132");
  });

  it.each(WORSE_ON_THE_CHECKLIST)(
    "card %s: the checklist's %s is not automatically better than %s",
    (_num, stored, fromChecklist) => {
      // Recorded so "the checklist is the authority on playerName" cannot be
      // asserted without meeting these. Evidence, not merge assertions.
      expect(stored).not.toBe(fromChecklist);
    },
  );

  it("a multi-player leader card is a LIST, and a list is not a playerName", () => {
    for (const [, , joined] of MULTI_PLAYER_LEADER_CARDS) {
      expect(joined.includes("/")).toBe(true);
      expect(joined.split("/").length).toBeGreaterThan(1);
    }
  });

  it("playerName is not in the slug, so none of this splits a pool", () => {
    // Why these disagreements are a DISPLAY defect and not a pricing one --
    // and why no repair here is urgent.
    const slug = (playerName: string) => computeHobbyIqCardId({
      sport: "hockey", year: 1979, setKey: "o-pee-chee", cardNumber: "131",
      parallel: "Base", isAuto: false, printRun: null, playerName,
    });
    expect(slug("Checklist 1-132")).toBe(slug("Checklist"));
    expect(slug("Rene Roberts")).toBe(slug("Rene Robert"));
  });
});
