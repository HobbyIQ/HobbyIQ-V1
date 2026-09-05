/**
 * CF-HOBBYMONITOR-IS-STRICT-ONLY-WHERE-A-SECOND-SOURCE-AGREES (Drew,
 * 2026-09-05, ruling B) -- the pins.
 *
 * THE MEASUREMENT THESE PINS STAND ON (#1795, and this PR's own census):
 *
 *   2,571 of 2,811 hobbymonitor panini-score rows with a twin at the identical
 *       slug name a DIFFERENT PLAYER at that number
 *   343 disagreements against 376 agreements where the player DOES match
 *   32 keys carry two different players at one (number, parallel, isAuto)
 *   1,192,925 hobbymonitor catalog rows, 6.5% corroborated, 111 of 175
 *       (sport, year, setKey) cells with ZERO corroboration
 *
 * Each `it` below names the behaviour it pins. The MUTATION CHECKS at the
 * bottom are the ones that matter most: they state, as executable tests, that
 * dropping the corroboration requirement or routing the question back through
 * the old unconditional allowlist turns a test RED. A guard nobody can break
 * on purpose is a guard nobody knows is load-bearing.
 */
import { describe, it, expect } from "vitest";
import {
  CORROBORATION_REQUIRED_SOURCES,
  corroborationOf,
  identityCellOf,
  isChecklistBackedWithCorroboration,
  isCorroboratingSource,
  normalizeCatalogSource,
  requiresCorroboration,
  type CorroborationRow,
} from "../src/services/catalog/sourceCorroboration.js";
import { catalogAuthorityOf } from "../src/services/catalog/catalogAuthority.service.js";
import { identityBackingOf, isChecklistBackedIdentity } from "../src/services/catalog/identityBacking.js";

/** The real shape, from a live read of card_catalog on 2026-09-05. */
const HM_LONDON: CorroborationRow = {
  id: "hiq:football:2025:panini-score:4:base:no-auto",
  source: "hobbymonitor-2026-09-04",
  playerName: "Drake London",
};
/** The checklistinsider row at the SAME slug on the correct key. Different
 *  player at number 4 -- the #1795 defect, verified against the published
 *  checklist (checklistcenter.com/2025-score-nfl-football-card-checklist). */
const CI_COLEMAN: CorroborationRow = {
  id: "hiq:football:2025:score:4:base:no-auto",
  source: "checklistinsider-2026-08-27",
  playerName: "Keon Coleman",
};

describe("requiresCorroboration -- who is demoted", () => {
  it("demotes hobbymonitor, its dated re-scrapes and its graded twins", () => {
    for (const s of [
      "hobbymonitor",
      "hobbymonitor-2026-09-04",
      "hobbymonitor-scraped-2026-08-18",
      "hobbymonitor-graded",
      "hobbymonitor-2026-09-04-graded",
    ]) expect(requiresCorroboration(s), s).toBe(true);
  });

  it("demotes NOBODY else -- every other checklist source keeps its own word", () => {
    for (const s of [
      "checklistinsider-2026-08-27", "checklistcenter", "beckett-checklist",
      "beckett-scraped-2026-08-30", "bccp", "baseballcardpedia", "sportscardchecklist",
      "tcdb", "tcgdex", "cardboardchecklist", "drew-google-sheet",
    ]) expect(requiresCorroboration(s), s).toBe(false);
  });

  it("is false for the sources corroboration could never rescue anyway", () => {
    // A vendor or derived row is refused by catalogAuthorityOf long before this
    // question is reached. Answering "yes, it needs corroboration" would read as
    // though a second source could promote it, and nothing can.
    for (const s of ["cardhedge", "ingest-auto-seed", "sold-comps-stub", "ebay", "", null, undefined])
      expect(requiresCorroboration(s), String(s)).toBe(false);
  });

  it("the demoted list is a LIST, so the next self-contradicting source lands here", () => {
    expect(CORROBORATION_REQUIRED_SOURCES).toContain("hobbymonitor");
    expect(Object.isFrozen(CORROBORATION_REQUIRED_SOURCES)).toBe(true);
  });
});

describe("normalizeCatalogSource -- a re-scrape stays classified", () => {
  it("strips the ingest verb, the date stamp and the graded suffixes", () => {
    expect(normalizeCatalogSource("hobbymonitor-2026-09-04")).toBe("hobbymonitor");
    expect(normalizeCatalogSource("hobbymonitor-scraped-2026-08-18")).toBe("hobbymonitor");
    expect(normalizeCatalogSource("checklistinsider-2026-08-27-graded-graded")).toBe("checklistinsider");
    expect(normalizeCatalogSource("beckett-scraped")).toBe("beckett");
  });
  it("is empty for the source that says nothing", () => {
    for (const s of ["", "  ", "undefined", "null", null, undefined])
      expect(normalizeCatalogSource(s), String(s)).toBe("");
  });
});

describe("identityCellOf -- the axis two sources can actually be compared on", () => {
  it("reads sport, year, setKey, number, parallel and auto off the SLUG", () => {
    expect(identityCellOf(HM_LONDON)).toBe("football|2025|panini-score|4|base|no-auto");
  });

  it("DROPS the trailing print-run segment -- one card stated two ways is one card", () => {
    // CF: a source that states a print run and one that does not are describing
    // the same card. Keeping `num-25` would make them look like two cards and
    // REFUSE a corroboration that exists.
    const withRun = { id: "hiq:football:2024:panini-prizm:8:base:no-auto:num-25", source: "checklistinsider" };
    const without = { id: "hiq:football:2024:panini-prizm:8:base:no-auto", source: "beckett" };
    expect(identityCellOf(withRun)).toBe(identityCellOf(without));
  });

  it("falls back to the FIELDS when there is no hiq slug, preferring cardYear over year", () => {
    // #1769: 2.07M rows were invisible to the rematch because it filtered on
    // `year` while the rows carried `cardYear`. Both are read; cardYear wins.
    expect(identityCellOf({
      source: "hobbymonitor", sport: "Football", cardYear: 2025, year: 1999,
      setKey: "Panini-Score", cardNumber: "4", parallelSlug: "", isAuto: false,
    })).toBe("football|2025|panini-score|4|base|no-auto");
  });

  it("is null when neither the slug nor the fields name a cell", () => {
    expect(identityCellOf({ source: "hobbymonitor" })).toBeNull();
    expect(identityCellOf(null)).toBeNull();
  });
});

describe("isCorroboratingSource -- who may be the SECOND source", () => {
  it("accepts an ordinary strict checklist row", () => {
    expect(isCorroboratingSource(CI_COLEMAN)).toBe(true);
    expect(isCorroboratingSource({ source: "bccp", playerName: null })).toBe(true);
  });

  it("REFUSES a second hobbymonitor row -- one source twice is not two sources", () => {
    expect(isCorroboratingSource({ id: "hiq:football:2025:score:4:base:no-auto", source: "hobbymonitor-2026-09-04" })).toBe(false);
  });

  it("REFUSES a graded child -- a row minted from its parent cannot confirm it", () => {
    expect(isCorroboratingSource({ ...CI_COLEMAN, gradeTier: "psa-10" })).toBe(false);
  });

  it("REFUSES a vendor or derived row", () => {
    for (const s of ["cardhedge", "ingest-auto-seed", "sold-comps-stub-2026-08-12", "ebay-browse"])
      expect(isCorroboratingSource({ source: s }), s).toBe(false);
  });
});

describe("corroborationOf -- THE ONE READ", () => {
  it("an UNCORROBORATED hobbymonitor row is NOT backed, and says why", () => {
    const r = corroborationOf(HM_LONDON, []);
    expect(r.verdict).toBe("no-second-source");
    expect(r.checklistBacked).toBe(false);
  });

  it("a CORROBORATED hobbymonitor row IS backed, and names who corroborated it", () => {
    // The same cell, a second strict source, the same player.
    const agreeing: CorroborationRow = {
      id: "hiq:football:2025:panini-score:4:base:no-auto",
      source: "checklistinsider-2026-08-27",
      playerName: "Drake London",
    };
    const r = corroborationOf(HM_LONDON, [agreeing]);
    expect(r.verdict).toBe("corroborated");
    expect(r.checklistBacked).toBe(true);
    expect(r.corroboratedBy).toBe("checklistinsider");
  });

  it("THE #1795 SHAPE: a second source at the cell naming a DIFFERENT player refuses", () => {
    // The rival must be at the SAME cell for the disagreement to be about this
    // card, so it is read at panini-score's own slug.
    const rivalAtCell: CorroborationRow = {
      id: "hiq:football:2025:panini-score:4:base:no-auto",
      source: "checklistinsider-2026-08-27",
      playerName: "Keon Coleman",
    };
    const r = corroborationOf(HM_LONDON, [rivalAtCell]);
    expect(r.verdict).toBe("player-disagrees");
    expect(r.checklistBacked).toBe(false);
  });

  it("a PLAYERLESS rival still corroborates -- bccp carries no name on most rows", () => {
    // Measured: 117 of 117 sampled football/2024/panini-prizm base bccp rows
    // have playerName null. Requiring a match against a row with no name would
    // refuse the corroboration a real second transcription is offering.
    const bccp: CorroborationRow = {
      id: "hiq:football:2025:panini-score:4:base:no-auto",
      source: "bccp", playerName: null,
    };
    expect(corroborationOf(HM_LONDON, [bccp]).verdict).toBe("corroborated");
  });

  it("a rival at ANOTHER cell corroborates nothing", () => {
    const otherNumber: CorroborationRow = {
      id: "hiq:football:2025:panini-score:17:base:no-auto",
      source: "checklistinsider", playerName: "Drake London",
    };
    expect(corroborationOf(HM_LONDON, [otherNumber]).verdict).toBe("no-second-source");
  });

  it("a NON-demoted source is `not-required` and never consults a rival", () => {
    const r = corroborationOf(CI_COLEMAN, []);
    expect(r.verdict).toBe("not-required");
    expect(r.checklistBacked).toBe(true);
  });

  it("no rivals passed at all is the CONSERVATIVE read, not an assumption of backing", () => {
    expect(isChecklistBackedWithCorroboration(HM_LONDON, null)).toBe(false);
    expect(isChecklistBackedWithCorroboration(HM_LONDON, undefined)).toBe(false);
  });
});

describe("identityBackingOf -- the consumer, sharing the one predicate", () => {
  it("an uncorroborated hobbymonitor row alone at a slug is UNBACKED, not backed", () => {
    expect(identityBackingOf(HM_LONDON.id, [HM_LONDON])).toBe("unbacked");
  });

  it("...and `unbacked`, not `self-derived-only` -- it names DIFFERENT work", () => {
    // self-derived-only means fix a matcher. unbacked means acquire a checklist.
    // An uncorroborated hobbymonitor row is the second kind, and the verdicts
    // are kept distinct precisely so a reader is sent to the right queue.
    expect(identityBackingOf(HM_LONDON.id, [HM_LONDON])).not.toBe("self-derived-only");
  });

  it("a corroborated one is checklist-backed", () => {
    const agreeing: CorroborationRow = { ...HM_LONDON, source: "beckett-checklist" };
    expect(identityBackingOf(HM_LONDON.id, [HM_LONDON, agreeing])).toBe("checklist-backed");
  });

  it("an ordinary checklist row at the slug backs it with no corroboration needed", () => {
    expect(identityBackingOf(CI_COLEMAN.id, [CI_COLEMAN])).toBe("checklist-backed");
  });

  it("the other four verdicts are untouched by the demotion", () => {
    expect(identityBackingOf("", [])).toBe("no-slug");
    expect(identityBackingOf("hiq:x", [])).toBe("no-catalog-row");
    expect(identityBackingOf("hiq:x", [{ source: "ingest-auto-seed" }])).toBe("self-derived-only");
    expect(identityBackingOf("hiq:x", [{ source: "cardhedge" }])).toBe("unbacked");
  });
});

// ── MUTATION CHECKS ─────────────────────────────────────────────────────────
//
// Each of these states a way the guard could be removed and asserts that doing
// so changes an answer above. They fail loudly if the guard is ever softened
// into a no-op -- which is the failure mode a boolean predicate has: it keeps
// returning `true` and nothing looks broken.

describe("MUTATION: dropping the corroboration requirement turns a test red", () => {
  it("the old unconditional rule would have called the London row BACKED", () => {
    // THE MUTANT: `catalogAuthorityOf(source) === "checklist"`, which is exactly
    // what isChecklistBackedIdentity still answers for the STRING question --
    // and it says yes, because a hobbymonitor row IS a transcription. If the
    // corroborated read ever agreed with it on an uncorroborated row, the
    // demotion would be gone and this assertion is what would catch it.
    expect(isChecklistBackedIdentity(HM_LONDON.source)).toBe(true);
    expect(isChecklistBackedWithCorroboration(HM_LONDON, [])).toBe(false);
    expect(isChecklistBackedWithCorroboration(HM_LONDON, []))
      .not.toBe(isChecklistBackedIdentity(HM_LONDON.source));
  });

  it("a mutant that ignored `rivals` could not tell the two panini-score cases apart", () => {
    // The whole demotion is that the SAME ROW answers differently depending on
    // what is beside it. A predicate that ignored its second argument would
    // return one answer for both, and these two must differ.
    const agreeing: CorroborationRow = { ...HM_LONDON, source: "checklistinsider" };
    expect(isChecklistBackedWithCorroboration(HM_LONDON, [agreeing])).toBe(true);
    expect(isChecklistBackedWithCorroboration(HM_LONDON, [])).toBe(false);
  });

  it("a mutant that accepted ANY rival would accept hobbymonitor corroborating itself", () => {
    const itself: CorroborationRow = { ...HM_LONDON, id: HM_LONDON.id, source: "hobbymonitor-2026-09-04" };
    expect(isChecklistBackedWithCorroboration(HM_LONDON, [itself])).toBe(false);
  });

  it("a mutant that dropped the player check would accept the Coleman-at-4 row", () => {
    const rivalAtCell: CorroborationRow = {
      id: HM_LONDON.id, source: "checklistinsider-2026-08-27", playerName: "Keon Coleman",
    };
    expect(corroborationOf(HM_LONDON, [rivalAtCell]).checklistBacked).toBe(false);
  });
});

describe("MUTATION: routing identityBacking through the old allowlist turns it red", () => {
  it("identityBackingOf must NOT be reachable by the source string alone", () => {
    // THE MUTANT: `identityBackingOf` reverting to
    // `rows.some(r => isChecklistBackedIdentity(r.source))`. That expression is
    // computed here explicitly and asserted to DISAGREE with the real function
    // on the demoted row, so a revert cannot pass silently.
    const rows = [HM_LONDON];
    const mutantSaysBacked = rows.some((r) => isChecklistBackedIdentity(r.source));
    expect(mutantSaysBacked).toBe(true);
    expect(identityBackingOf(HM_LONDON.id, rows)).toBe("unbacked");
  });

  it("catalogAuthorityOf KEEPS hobbymonitor as `checklist` -- the demotion is not a reclassification", () => {
    // Deliberate, and load-bearing: a hobbymonitor row is still re-keyable, still
    // outranks a derived stub in chooseSurvivor, and still counts as evidence
    // that a card exists. Narrowing this regex instead of adding the corroborated
    // question is the "right guard, wrong scope" bug -- it would move ~45 call
    // sites for the benefit of four, and it once discarded baseballcardpedia's
    // 918,828 rows. If someone edits the regex, this goes red first.
    expect(catalogAuthorityOf("hobbymonitor-2026-09-04")).toBe("checklist");
    expect(catalogAuthorityOf("hobbymonitor")).toBe("checklist");
  });
});
