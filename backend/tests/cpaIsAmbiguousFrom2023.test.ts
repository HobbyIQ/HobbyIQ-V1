/**
 * CF-CPA-IS-AMBIGUOUS-FROM-2023 (measured read-only against card_catalog,
 * 2026-09-05).
 *
 * `CHROME_PREFIX_OVERRIDES` repairs a vendor row whose setName is only
 * "Bowman" by reading its cardNumber prefix. The CPA- rule asserted that the
 * prefix "only ever = Bowman Chrome". That was true when it was written and
 * stopped being true in 2023, when Bowman DRAFT began numbering its chrome
 * prospect autos CPA- as well.
 *
 * Counting CHECKLIST-BACKED catalog rows only -- vendor and sales-attested
 * rows excluded, per CF-COUNT-BY-SOURCE, because a row this very override
 * minted cannot be evidence that the override is right:
 *
 *     year        bowman-chrome   bowman-draft
 *     2016-2022        41,745             0
 *     2023             17,611            57
 *     2024             19,354         6,886
 *     2025             31,064         9,501
 *     2026              9,829             0
 *
 * and in 2025 alone FIFTY distinct CPA- numbers carry BOTH keys. A cardNumber
 * alone is not an identity (project_beckett_initials_card_numbers_collide).
 *
 * The card that exposed it: Gage Wood's 2025 CPA-GW is a Bowman DRAFT card.
 * All 72 checklist-backed 2025 CPA-GW rows are keyed bowman-draft and NONE is
 * bowman-chrome; the only bowman-chrome ones are six sales-attested rows this
 * override minted, and prod reads `hiq:baseball:2025:bowman-chrome:cpa-gw:*`
 * into a 404 against the catalog on every lookup while
 * `hiq:baseball:2025:bowman-draft:cpa-gw:base:auto` is the live identity.
 *
 * ABSENT BEATS WRONG: from 2023 a bare "Bowman" setName no longer tells us
 * which product a CPA- card came from, so the override stands down and the row
 * keeps the honest bare `bowman` key rather than being minted into a pool it
 * may not belong to.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service";

const base = { sport: "baseball", isAuto: true, playerName: "Gage Wood" } as const;
const setKeyOf = (id: string) => id.split(":")[3];

describe("CF-CPA-IS-AMBIGUOUS-FROM-2023", () => {
  it("does NOT mint bowman-chrome for a 2025 bare-Bowman CPA- card", () => {
    const id = computeHobbyIqCardId({
      ...base, year: 2025, setKey: "Bowman", cardNumber: "CPA-GW", parallel: null,
    });
    // The bug: this used to be bowman-chrome, an id that 404s in the catalog.
    expect(setKeyOf(id)).not.toBe("bowman-chrome");
    expect(setKeyOf(id)).toBe("bowman");
  });

  it("still overrides pre-2023, where CPA- really is unambiguous", () => {
    const id = computeHobbyIqCardId({
      ...base, year: 2019, setKey: "Bowman", cardNumber: "CPA-GW", parallel: null,
    });
    expect(setKeyOf(id)).toBe("bowman-chrome");
  });

  it("puts the boundary between 2022 and 2023 -- the first year Draft used CPA-", () => {
    const at = (year: number) => setKeyOf(computeHobbyIqCardId({
      ...base, year, setKey: "Bowman", cardNumber: "CPA-BC", parallel: null,
    }));
    expect(at(2022)).toBe("bowman-chrome");
    expect(at(2023)).toBe("bowman");
  });

  it("refuses on an unknown year rather than assuming the old window", () => {
    // year 0 is "the caller could not parse one". An unknown year is not
    // evidence that we are inside the unambiguous era.
    const id = computeHobbyIqCardId({
      ...base, year: 0, setKey: "Bowman", cardNumber: "CPA-GW", parallel: null,
    });
    expect(setKeyOf(id)).not.toBe("bowman-chrome");
  });

  it("keeps a STATED product verbatim -- the override never had jurisdiction there", () => {
    // These never reached the override: normalizeSetKey answers first. Pinned
    // because the fix must not have moved them.
    const draftChrome = computeHobbyIqCardId({
      ...base, year: 2025, setKey: "Bowman Draft Chrome", cardNumber: "CPA-GW", parallel: "Gold",
    });
    expect(setKeyOf(draftChrome)).toBe("bowman-draft");
    // ...and the parallel is the one the card states. "Gold" is not "Gold Wave".
    expect(draftChrome.split(":")[5]).toBe("gold");

    const chrome = computeHobbyIqCardId({
      ...base, year: 2025, setKey: "Bowman Chrome", cardNumber: "CPA-GW", parallel: null,
    });
    expect(setKeyOf(chrome)).toBe("bowman-chrome");
  });

  it("leaves every OTHER prefix override untouched", () => {
    const bcp = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Bowman", cardNumber: "BCP-150",
      parallel: null, isAuto: false, playerName: "X",
    });
    expect(setKeyOf(bcp)).toBe("bowman-chrome");

    const bdc = computeHobbyIqCardId({
      sport: "baseball", year: 2025, setKey: "Bowman", cardNumber: "BDC-1",
      parallel: null, isAuto: false, playerName: "X",
    });
    expect(setKeyOf(bdc)).toBe("bowman-chrome");
  });
});

/**
 * Mutation checks. A guard that cannot fail is not a guard: each of these
 * asserts that the SOURCE still carries the clause, so deleting it reddens CI
 * rather than silently restoring the collapse.
 */
describe("the year scope is load-bearing", () => {
  const SRC = readFileSync(
    path.resolve(__dirname, "../src/services/portfolioiq/hobbyIqCardId.service.ts"),
    "utf8",
  );

  it("the CPA- rule still declares its maxYear", () => {
    const cpaLine = SRC.split(/\r?\n/).find(
      (l) => l.includes("cardNumberPrefix: /^cpa") && l.includes('fromSetKey: "bowman"'),
    );
    expect(cpaLine, "the bowman+CPA- rule must exist").toBeTruthy();
    expect(cpaLine).toContain("maxYear: 2022");
  });

  it("the override still HONOURS maxYear instead of ignoring the field", () => {
    // Dropping this clause is exactly the mutation that restores the bug.
    expect(SRC).toMatch(
      /if \(typeof rule\.maxYear === "number" && !\(year > 0 && year <= rule\.maxYear\)\) continue;/,
    );
  });
});
