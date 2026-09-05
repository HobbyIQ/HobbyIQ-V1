/**
 * CF-A-SECOND-SOURCE-THAT-DISAGREES-IS-THE-ONLY-DISQUALIFIER (Drew,
 * 2026-09-05, the NARROWED ruling) -- the pins.
 *
 * THE MEASUREMENT THESE PINS STAND ON (#1795, and this PR's own census):
 *
 *   2,571 of 2,811 hobbymonitor panini-score rows with a twin at the identical
 *       slug name a DIFFERENT PLAYER at that number
 *   343 disagreements against 376 agreements where the player DOES match
 *   32 keys carry two different players at one (number, parallel, isAuto)
 *
 *   1,192,925 hobbymonitor catalog rows
 *      77,441   6.5%  corroborated
 *      22,027   1.8%  CONTRADICTED -- the only rows that lose the gate
 *   1,093,457  91.7%  no second source at all -- BACKED, and labelled
 *
 * THE NARROWING IS ITSELF PINNED. The first draft of this ruling refused every
 * uncorroborated row, which would have withheld 1,133,530. Drew narrowed it
 * after seeing that number, because 1.09M of them are uncorroborated for a
 * reason that is not evidence about the row: nobody else has transcribed that
 * product. So there is a mutation check asserting that a REVERT to the
 * wholesale rule turns a test red, alongside the ones asserting that dropping
 * the contradiction check does.
 *
 * Each `it` below names the behaviour it pins. The MUTATION CHECKS at the
 * bottom are the ones that matter most: a guard nobody can break on purpose is
 * a guard nobody knows is load-bearing.
 */
import { describe, it, expect } from "vitest";
import {
  CORROBORATION_REQUIRED_SOURCES,
  corroborationOf,
  identityCellOf,
  isChecklistBackedWithCorroboration,
  isCorroboratingSource,
  isSingleSourceIdentity,
  normalizeCatalogSource,
  requiresCorroboration,
  type CorroborationRow,
} from "../src/services/catalog/sourceCorroboration.js";
import { catalogAuthorityOf } from "../src/services/catalog/catalogAuthority.service.js";
import { identityBackingOf, isChecklistBackedIdentity, isSingleSourceBacking } from "../src/services/catalog/identityBacking.js";

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
/** The same disagreement stated AT hobbymonitor's own cell, which is what a
 *  corroboration read compares against: same (sport, year, setKey, number,
 *  parallel, auto), a different player. */
const CONTRADICTS_AT_CELL: CorroborationRow = {
  id: HM_LONDON.id,
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
  it("THE NARROWING: an UNCORROBORATED row is BACKED and LABELLED, not refused", () => {
    // Drew narrowed the ruling on 2026-09-05 after the blast radius was
    // measured: 1,093,457 of 1,192,925 hobbymonitor rows have NO second source,
    // which is a fact about our acquisition backlog and not about the row.
    // Refusing them would take 1.09M real cards out of pricing.
    const r = corroborationOf(HM_LONDON, []);
    expect(r.verdict).toBe("no-second-source");
    expect(r.checklistBacked).toBe(true);
    expect(r.singleSource).toBe(true);
  });

  it("`singleSource` and `checklistBacked:false` are NEVER both set", () => {
    // They are opposite instructions to a reader — show the number with a
    // caveat, vs. show no number. A result carrying both would be incoherent.
    const contradicted: CorroborationRow = {
      id: HM_LONDON.id, source: "checklistinsider-2026-08-27", playerName: "Keon Coleman",
    };
    for (const rivals of [[], [contradicted], [{ ...HM_LONDON, source: "beckett-checklist" }]]) {
      const r = corroborationOf(HM_LONDON, rivals);
      if (!r.checklistBacked) expect(r.singleSource, JSON.stringify(r)).toBe(false);
    }
    // ...and the contradicted case really is the one that is not backed, so
    // the loop above is not passing vacuously.
    expect(corroborationOf(HM_LONDON, [contradicted]).checklistBacked).toBe(false);
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

  it("no rivals passed reads as `nothing contradicts this` -- backed, and labelled", () => {
    // Under the narrowed rule the absence of a check is not a contradiction.
    // Treating it as one would refuse every row on every path that does not
    // hold a product scan -- which is most of them.
    for (const rivals of [null, undefined]) {
      expect(isChecklistBackedWithCorroboration(HM_LONDON, rivals)).toBe(true);
      expect(isSingleSourceIdentity(HM_LONDON, rivals)).toBe(true);
    }
  });
});

describe("identityBackingOf -- the consumer, sharing the one predicate", () => {
  it("an uncorroborated hobbymonitor row alone at a slug is BACKED and single-source", () => {
    // The narrowed ruling, at the consumer that gates pricing.
    expect(identityBackingOf(HM_LONDON.id, [HM_LONDON])).toBe("checklist-backed");
    expect(isSingleSourceBacking(HM_LONDON.id, [HM_LONDON])).toBe(true);
  });

  it("A CONTRADICTION DISQUALIFIES THE ROW, NOT THE CARD", () => {
    // This distinction is the whole reason the two questions have two names,
    // and getting it backwards is a real hazard: when checklistinsider is
    // sitting right there naming Keon Coleman at #4, the CARD is
    // checklist-backed — by checklistinsider — and it prices normally. What
    // the contradiction disqualifies is the hobbymonitor ROW's word about it.
    //
    // So `identityBackingOf` (a question about the identity, over all its
    // rows) says BACKED, while `corroborationOf` (a question about one row)
    // refuses the hobbymonitor row. Both are right, and a reader who conflated
    // them would either withhold a well-evidenced card or trust a contradicted
    // transcription.
    const rows = [HM_LONDON, CONTRADICTS_AT_CELL];
    expect(identityBackingOf(HM_LONDON.id, rows)).toBe("checklist-backed");
    expect(corroborationOf(HM_LONDON, rows).checklistBacked).toBe(false);
    // ...and no caveat, because a real second transcription is present.
    expect(isSingleSourceBacking(HM_LONDON.id, rows)).toBe(false);
  });

  it("...and it is `unbacked`, never `self-derived-only` -- DIFFERENT work", () => {
    // self-derived-only means fix a matcher. A contradicted transcription means
    // settle which of two sources is right. The verdicts are kept distinct so a
    // reader is sent to the right queue; neither is the other.
    expect(identityBackingOf(HM_LONDON.id, [HM_LONDON, CONTRADICTS_AT_CELL]))
      .not.toBe("self-derived-only");
  });

  it("a CORROBORATED row is backed and NOT labelled -- the caveat would be untrue", () => {
    const agreeing: CorroborationRow = { ...HM_LONDON, source: "beckett-checklist" };
    expect(identityBackingOf(HM_LONDON.id, [HM_LONDON, agreeing])).toBe("checklist-backed");
    expect(isSingleSourceBacking(HM_LONDON.id, [HM_LONDON, agreeing])).toBe(false);
  });

  it("an ordinary checklist row anywhere at the slug clears the label", () => {
    // One real second transcription is enough; saying "single-source" beside it
    // would be saying something false.
    expect(isSingleSourceBacking(CI_COLEMAN.id, [CI_COLEMAN])).toBe(false);
    expect(isSingleSourceBacking(HM_LONDON.id, [HM_LONDON, { source: "checklistcenter" }])).toBe(false);
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

describe("MUTATION: the contradiction rule", () => {
  /** The #1795 row: checklistinsider names Keon Coleman at panini-score #4. */
  const CONTRADICTS: CorroborationRow = {
    id: HM_LONDON.id, source: "checklistinsider-2026-08-27", playerName: "Keon Coleman",
  };

  it("a mutant that dropped the player check would accept the Coleman-at-4 row", () => {
    // The single most important assertion in the file: this IS the #1795
    // defect, and accepting it is what published a wrong card's price.
    expect(corroborationOf(HM_LONDON, [CONTRADICTS]).checklistBacked).toBe(false);
    expect(corroborationOf(HM_LONDON, [CONTRADICTS]).verdict).toBe("player-disagrees");
  });

  it("a mutant that ignored `rivals` could not tell the two panini-score cases apart", () => {
    // The whole rule is that the SAME ROW answers differently depending on what
    // is beside it. A predicate ignoring its second argument returns one answer
    // for both, and these two must differ.
    expect(isChecklistBackedWithCorroboration(HM_LONDON, [CONTRADICTS])).toBe(false);
    expect(isChecklistBackedWithCorroboration(HM_LONDON, [])).toBe(true);
  });

  it("a mutant that let hobbymonitor corroborate ITSELF would clear the label", () => {
    // A second hobbymonitor row at the cell is one source twice. It must
    // neither corroborate (clearing the caveat) nor contradict.
    const itself: CorroborationRow = { ...HM_LONDON, source: "hobbymonitor-2026-09-04" };
    const r = corroborationOf(HM_LONDON, [itself]);
    expect(r.verdict).toBe("no-second-source");
    expect(r.singleSource).toBe(true);
  });

  it("REVERTING TO THE WHOLESALE RULE turns this red -- no-second-source is BACKED", () => {
    // THE MUTANT: the first draft of this ruling, which refused every
    // uncorroborated row. It would have withheld 1,133,530 rows, 1,093,457 of
    // them for having no rival at all. Drew narrowed it after seeing that
    // number, so the narrowing itself is pinned rather than left as prose.
    expect(corroborationOf(HM_LONDON, []).checklistBacked).toBe(true);
    expect(identityBackingOf(HM_LONDON.id, [HM_LONDON])).toBe("checklist-backed");
  });

  it("...and a mutant that dropped the LABEL would price it with no caveat", () => {
    // The other half of the narrowing: it prices *and it says so*. Losing the
    // label silently is the failure that looks like success.
    expect(corroborationOf(HM_LONDON, []).singleSource).toBe(true);
    expect(isSingleSourceBacking(HM_LONDON.id, [HM_LONDON])).toBe(true);
  });
});

describe("MUTATION: routing identityBacking through the old allowlist turns it red", () => {
  it("the string predicate must still DIVERGE from the row-aware one", () => {
    // THE MUTANT: reverting the corroboration read to
    // `catalogAuthorityOf(source) === "checklist"` -- the string question,
    // which is what `isChecklistBackedIdentity` still answers and which says
    // YES for hobbymonitor, because a hobbymonitor row IS a transcription.
    //
    // Under the NARROWED rule the two agree on an uncontradicted row (both
    // back it), so the pin has to be stated where they must still differ: the
    // contradicted row. If this ever passes trivially the demotion is gone.
    expect(isChecklistBackedIdentity(HM_LONDON.source)).toBe(true);
    expect(corroborationOf(HM_LONDON, [CONTRADICTS_AT_CELL]).checklistBacked).toBe(false);
  });

  it("identityBackingOf must not lose the CONTRADICTED row's refusal", () => {
    // A demoted row that a rival contradicts cannot be the thing that carries
    // an identity. Here the ONLY rows are the hobbymonitor one and its
    // contradiction-at-cell, and the contradiction lives at the same slug, so
    // `identityBackingOf` reaches "checklist-backed" via checklistinsider and
    // NOT via hobbymonitor. The pin is that the hobbymonitor row itself is
    // refused -- the identity survives on the OTHER source's evidence.
    const rows = [HM_LONDON, CONTRADICTS_AT_CELL];
    expect(rows.some((r) => requiresCorroboration(r.source) && corroborationOf(r, rows).checklistBacked)).toBe(false);
    expect(identityBackingOf(HM_LONDON.id, rows)).toBe("checklist-backed");
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
