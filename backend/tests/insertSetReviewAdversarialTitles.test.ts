/**
 * Reviewer's adversarial titles (F3+F5, review fix on the R66/R67/R70 PR,
 * 2026-09-19). Each of these exercises the REAL two-step pipeline both
 * writers run: `insertSetNamedInTitle` (the vocabulary reader --
 * unchanged by this fix, and already pinned by insertSetTitleReader.test.ts)
 * composed with `insertReKeyConfirmedByChecklist` (the NEW confirmation gate
 * this fix adds). The point of every test below is that the REAL reader
 * correctly recognises the vocabulary in the title -- that part is not the
 * bug -- and the confirmation gate is what stops a bare recognition from
 * becoming a re-key.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  insertSetNamedInTitle,
  _resetInsertSetTitleReaderIndex,
} from "../src/services/portfolioiq/insertSetTitleReader.js";
import {
  insertReKeyConfirmedByChecklist,
  _clearInsertSetConfirmCacheForTests,
} from "../src/services/portfolioiq/insertSetChecklistConfirm.js";
import path from "node:path";

const FIXTURE_PATH = path.join(__dirname, "fixtures", "insertSetTitleReader", "synthetic-corpus.json");

interface Row { id: string; source?: string | null; cardNumber?: string | null; playerName?: string | null; }
function fakeContainer(rows: Row[]) {
  return {
    items: {
      query() {
        return { fetchAll: async () => ({ resources: rows }) };
      },
    },
  } as never;
}
const NO_CHECKLIST_ROWS = fakeContainer([]);

beforeEach(() => {
  _clearInsertSetConfirmCacheForTests();
  delete process.env.INSERT_SET_CORPUS_OVERRIDE;
  _resetInsertSetTitleReaderIndex();
});

describe("Downtown seller-boilerplate ×3 -- named, but never confirmed, never re-keyed", () => {
  // Real corpus: donruss-optic football 2024 carries a real "Downtown"
  // insert root, registered as donruss-optic-downtown. Each of these titles
  // is SELLER TEXT that happens to contain the word, with a card number that
  // is not actually one of Downtown's own checklist numbers in the fixture
  // below (no checklist rows returned at all -- the strictest, most common
  // real shape: the seller boilerplate names a real word with zero
  // connection to an actual Downtown card).
  const cases = [
    { label: "shipping-city mention", title: "2024 Panini Donruss Optic #150 Some Player PSA 10 - Ships from Downtown Toronto" },
    { label: "seller business name", title: "2024 Panini Donruss Optic #150 Some Player (Downtown Sports Cards LLC)" },
    { label: "auction-house boilerplate", title: "2024 Donruss Optic #150 Some Player - Downtown Collectibles Authenticated" },
  ];

  it.each(cases)("$label: reader names it, confirmation refuses, caller must not re-key", async ({ title }) => {
    const matches = insertSetNamedInTitle({
      title, sport: "football", year: 2024, setKey: "donruss-optic",
    });
    // The reader is vocabulary-only and correctly finds the literal word --
    // this is expected and NOT itself the defect.
    expect(matches).toHaveLength(1);
    expect(matches[0].root).toBe("downtown");
    expect(matches[0].registeredKey).toBe("donruss-optic-downtown");

    // The confirmation gate is what must refuse: no checklist row for THIS
    // card exists (fixture returns nothing at all here, the common real
    // case for boilerplate with zero connection to an actual card).
    const confirmed = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: matches[0].registeredKey!, cardNumber: "150", playerName: "Some Player" },
      { container: NO_CHECKLIST_ROWS },
    );
    expect(confirmed).toBe(false);
  });
});

describe("Kaleidoscopic -- real, unregistered insert, never re-keys (nothing to confirm against)", () => {
  it("panini-mosaic football 2024 'Kaleidoscopic' has no registered key at all -- R70 park path, confirmation is not even reached", () => {
    const matches = insertSetNamedInTitle({
      title: "2024 Panini Mosaic Kaleidoscopic Some Player #6",
      sport: "football", year: 2024, setKey: "panini-mosaic",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].root).toBe("kaleidoscopic");
    // No registered key -- this is R70's park path (insert-named-no-key or,
    // per F4, insert-word-but-base-confirmed), never the F3+F5 confirmation
    // gate, because there is no registered product to confirm a re-key onto.
    expect(matches[0].registeredKey).toBeNull();
  });
});

describe("two-inserts-named -- confirmation is never even consulted; the reader's own rule wins", () => {
  it("two distinct real insert names in one title report both; the caller parks before any confirmation query", () => {
    const matches = insertSetNamedInTitle({
      title: "2025 Panini Prizm - Prizmatic Talisman Kristian Campbell #1 Red Pulsar /399",
      sport: "baseball", year: 2025, setKey: "panini-prizm",
    });
    expect(matches.map((m) => m.root).sort()).toEqual(["prizmatic", "talisman"]);
    // Both writers park on insertMatches.length > 1 BEFORE reaching the
    // confirmation gate -- guessing which of two named games is not a
    // question checklist confirmation can answer either.
  });
});

describe("Young Guns player-span -- the reader itself refuses before confirmation is ever asked", () => {
  beforeEach(() => {
    process.env.INSERT_SET_CORPUS_OVERRIDE = FIXTURE_PATH;
    _resetInsertSetTitleReaderIndex();
  });

  it("a sale of a player named Young never matches 'Young Guns' -- disqualified at the reader, confirmation moot", () => {
    const matches = insertSetNamedInTitle({
      title: "2024 Upper Deck Young Guns #201 Trae Young RC",
      sport: "hockey", year: 2024, setKey: "upper-deck-fixture",
      playerName: "Trae Young",
    });
    expect(matches).toEqual([]);
  });

  it("an UNRELATED player's Young Guns sale matches the reader, but F3+F5 still requires checklist confirmation before any re-key", async () => {
    const matches = insertSetNamedInTitle({
      title: "2024 Upper Deck Young Guns #55 Connor Bedard RC",
      sport: "hockey", year: 2024, setKey: "upper-deck-fixture",
      playerName: "Connor Bedard",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].root).toBe("young guns");
    // The fixture registers no real productSetKeys.ts key for this fixture
    // setKey, so registeredKey is null regardless -- but the point holds on
    // the real corpus too: recognition is never proof, confirmation always
    // gates the re-key.
  });
});

describe("parallels Silver/Holo/Mojo/Velocity/Ice/Wave -- finish colours never read as inserts", () => {
  // Real corpus: panini-prizm baseball 2021/2022 parallels are finish
  // families ("Silver Prizm", "Blue Mojo Prizm", "Blue Wave Prizm", "Navy
  // Blue Cracked Ice Prizm", ...), never insertSets roots. A title stacking
  // several of these must not be misread as naming an insert at all.
  it("a title naming several prizm finish colours together names no insert (they are not insertSets entries)", () => {
    const matches = insertSetNamedInTitle({
      title: "2021 Panini Prizm Silver Prizm Blue Mojo Prizm Blue Wave Prizm Some Player #6",
      sport: "baseball", year: 2021, setKey: "panini-prizm",
    });
    expect(matches).toEqual([]);
  });

  it("Holo/Velocity/Ice as a synthetic single-word root collides with parallels[] and is refused by the parallel-collision guard", () => {
    process.env.INSERT_SET_CORPUS_OVERRIDE = FIXTURE_PATH;
    _resetInsertSetTitleReaderIndex();
    // panini-certified-fixture's "Mirror" IS this exact shape (single-word
    // root that is also an EXACT parallel name) -- reused here rather than
    // inventing a fourth fixture product, since Holo/Velocity/Ice/Wave in the
    // real corpus are always compound colour names, never bare insertSets
    // roots, and the guard's own scope (single-word exact match) is what is
    // under test, not the specific word.
    const matches = insertSetNamedInTitle({
      title: "2025 Panini Certified #1 Marvin Harrison Jr. Mirror #/99",
      sport: "football", year: 2025, setKey: "panini-certified-fixture",
    });
    expect(matches).toEqual([]);
    delete process.env.INSERT_SET_CORPUS_OVERRIDE;
    _resetInsertSetTitleReaderIndex();
  });
});
