/**
 * CF-A-CARDNUMBER-PREFIX-IS-SUFFICIENT-NEVER-NECESSARY (Drew, 2026-09-04).
 *
 * The standing rule `isAuto boundary is cardNumber, not text` says an
 * auto-subset card-number prefix (CPA-, BCPA-, RA-) PROVES a card is signed.
 * That stays true and these pins hold it. What Drew's 2011 Topps Chrome
 * Freddie Freeman auto shows is that the prefix was also being treated as
 * NECESSARY, and it is not:
 *
 *     2011 Topps Chrome #173 Freddie Freeman         base rookie
 *     2011 Topps Chrome #173 Freddie Freeman AUTO    Autographed Rookies
 *
 * One number, two cards. `isCardNumberAutoSubset` requires a letter prefix,
 * so it is STRUCTURALLY BLIND to every shared-number autograph -- the exact
 * cases `inferIsAuto` documents as traps "needing slab OCR". They do not need
 * OCR: the product's own checklist lists the signed row at #173.
 *
 * The authority is the CHECKLIST (`every ingest uses the one checklist
 * format`), which is why the resolver is INJECTED -- a title parse does no
 * I/O, and a rule that cannot reach the network cannot guess.
 */
import { describe, expect, it } from "vitest";
import {
  buildChecklistAutoIndex,
  checklistSaysAuto,
  foldChecklistCardNumber,
  type ChecklistAutoResolver,
} from "../src/services/catalog/checklistAutoLookup";
import { inferIsAuto, isCardNumberAutoSubset } from "../src/services/portfolioiq/parseTitleIdentity.service";

/** The 2011 Topps Chrome checklist, as the bcp scraper now emits it: the
 *  Autographed Rookies subset carries the BASE card numbers. */
const index2011 = buildChecklistAutoIndex(
  { sport: "baseball", year: 2011, setKey: "topps-chrome" },
  [
    { cardNumber: "173", isAuto: false },   // the base rookie
    { cardNumber: "173", isAuto: true },    // the Autographed Rookie
    { cardNumber: "170", isAuto: true },    // Hosmer
    { cardNumber: "1", isAuto: false },     // Posey, base only
  ],
);

const resolve: ChecklistAutoResolver = (key) =>
  key.sport === "baseball" && key.year === 2011 && key.setKey === "topps-chrome"
    ? index2011
    : null;

describe("the checklist answers for a shared card number", () => {
  it("marks #173 auto when the checklist lists a signed row and the title corroborates", () => {
    expect(checklistSaysAuto({
      sport: "baseball", year: 2011, setKey: "topps-chrome",
      cardNumber: "173", corroborated: true, resolve,
    })).toBe(true);
  });

  it("does NOT mark a number the checklist lists only as base", () => {
    // Posey #1 is a base card on this checklist. Corroboration cannot
    // manufacture an auto row that the checklist does not have.
    expect(checklistSaysAuto({
      sport: "baseball", year: 2011, setKey: "topps-chrome",
      cardNumber: "1", corroborated: true, resolve,
    })).toBe(false);
  });

  /**
   * The pool-safety gate. Most #173 sales ARE the base rookie -- the checklist
   * makes the auto POSSIBLE, the title's auto words say THIS sale is the
   * signed one. Without this, one checklist row would re-tag a whole base pool.
   */
  it("refuses without corroboration, even where the checklist has the auto row", () => {
    expect(checklistSaysAuto({
      sport: "baseball", year: 2011, setKey: "topps-chrome",
      cardNumber: "173", corroborated: false, resolve,
    })).toBe(false);
  });

  it("is silent for a product with no checklist loaded", () => {
    expect(checklistSaysAuto({
      sport: "baseball", year: 2012, setKey: "topps-chrome",
      cardNumber: "173", corroborated: true, resolve,
    })).toBe(false);
  });

  it("treats a throwing resolver as an ABSENT checklist, never an auto", () => {
    expect(checklistSaysAuto({
      sport: "baseball", year: 2011, setKey: "topps-chrome",
      cardNumber: "173", corroborated: true,
      resolve: () => { throw new Error("cosmos down"); },
    })).toBe(false);
  });

  it("compares card numbers hyphen- and case-insensitively", () => {
    // Matches sameCardNumber's treatment (CPA-BR is CPABR), so this rule and
    // identity can never disagree about which card a number names.
    expect(foldChecklistCardNumber("#CPA-BR")).toBe(foldChecklistCardNumber("cpabr"));
  });

  it("builds an index only from rows the SOURCE calls signed", () => {
    // `blank means unknown, never Base` -- and never auto either.
    const idx = buildChecklistAutoIndex(
      { sport: "baseball", year: 2011, setKey: "x" },
      [{ cardNumber: "5" }, { cardNumber: "6", isAuto: null }, { cardNumber: "7", isAuto: true }],
    );
    expect([...idx.autoCardNumbers]).toEqual(["7"]);
  });
});

describe("inferIsAuto keeps the prefix rule and gains the checklist", () => {
  it("still reads a prefixed number as an auto with no checklist at all", () => {
    // The standing rule, untouched: sufficient, on its own, forever.
    expect(isCardNumberAutoSubset("CPA-BR")).toBe(true);
    expect(inferIsAuto({ sport: "baseball", cardNumber: "CPA-BR" })).toBe(true);
  });

  it("reads the shared-number auto that the prefix rule cannot see", () => {
    // The card that started this. No prefix, no auto-set name -- every
    // pre-existing signal says "not an auto", and only the checklist knows.
    expect(isCardNumberAutoSubset("173")).toBe(false);
    expect(inferIsAuto({
      sport: "baseball", cardNumber: "173", year: 2011, setKey: "topps-chrome",
      checklistAuto: resolve, autoCorroboration: true,
    })).toBe(true);
  });

  it("leaves the base rookie alone when nothing corroborates", () => {
    expect(inferIsAuto({
      sport: "baseball", cardNumber: "173", year: 2011, setKey: "topps-chrome",
      checklistAuto: resolve, autoCorroboration: false,
    })).toBe(false);
  });

  it("changes nothing when no resolver is wired", () => {
    // The whole feature is additive: absent a checklist, today's behaviour.
    expect(inferIsAuto({ sport: "baseball", cardNumber: "173", year: 2011, setKey: "topps-chrome" }))
      .toBe(false);
  });
});
