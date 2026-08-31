import { describe, it, expect } from "vitest";
import {
  parseListingIdentity,
  isMultiCardLot,
} from "../src/services/portfolioiq/parseTitleIdentity.service.js";

/**
 * CF-REFRACTORS-IS-HOW-TOPPS-PRINTS-IT + CF-BARE-X-FRACTOR (Drew, 2026-08-31).
 *
 * Two live defects, both measured on 2024 chrome-family sold_comps (395,474
 * rows scanned; 1,853 refractor-titled rows sitting in :base: pools against
 * only 44 the other way — the mixing is 42:1 one-directional):
 *
 *   A. The bare-refractor fallback tested /\brefractor\b/i. The trailing \b
 *      fails on the PLURAL "Refractors" — which is how Topps names the
 *      parallel on its own checklist and how sellers title it. 235 rows.
 *
 *   B. X-Fractor matched ONLY with a colour in front of it. Nothing caught a
 *      bare one, in any of its three spellings. 867 rows — the single largest
 *      cause.
 *
 * Both are WIDENING rules, so the fixtures below spend most of their weight on
 * what must NOT change: the colour ladder must keep beating the bare fallback,
 * SuperFractor must keep beating bare X-Fractor, AUTO_NEGATIVE_RE must still
 * gate the plural branch, and a LOT must not become a refractor at all.
 */
describe("plural Refractors and bare X-Fractor", () => {
  const par = (t: string) => (parseListingIdentity(t) as { parallel?: string }).parallel;

  // ── A. the plural, from the measurement's own examples ──────────────────
  describe("A: the plural is the same parallel as the singular", () => {
    it("reads the prod sale that exposed it", () => {
      // cardsight::79b565278c8a76ce145e188f — stored on
      // hiq:baseball:2024:bowman-chrome:80:base:no-auto, $10.50
      expect(par("2024 Bowman Chrome Refractors #80 Aaron Judge 167/499 YANKEES"))
        .toBe("Refractor");
    });

    it("singular and plural land on the SAME canonical parallel", () => {
      // One card, one row, one pool. A plural that returned "Refractors" would
      // slug as a second card and split the pool in two — the whole point of
      // this fix is that it does not.
      expect(par("2024 Bowman Chrome Jackson Chourio Refractor #BCP-21")).toBe("Refractor");
      expect(par("2024 Bowman Chrome Jackson Chourio Refractors #BCP-21")).toBe("Refractor");
    });

    it("plural works without an auto, as the singular already did", () => {
      expect(par("2017 Topps Chrome Aaron Judge #169 Refractors RC PSA 10")).toBe("Refractor");
    });

    it("still honours AUTO_NEGATIVE_RE on the plural branch", () => {
      // The gate was never about the plural; widening must not drop it.
      expect(par("2024 Bowman Chrome Refractors #80 Aaron Judge Auto Relic")).not.toBe("Refractor");
      expect(par("2024 Bowman Chrome Refractors #80 Aaron Judge Auto Patch")).not.toBe("Refractor");
    });
  });

  // ── the colour ladder must keep winning ─────────────────────────────────
  describe("colour-refractor forms still beat the bare fallback", () => {
    it("Orange Refractors stays Orange Refractor, never plain", () => {
      // The real risk of widening: a plural colour form falling through to the
      // now-wider bare rule and losing its colour. A dropped colour is not a
      // smaller answer, it is a different card.
      expect(par("2024 Bowman Chrome Prospects #CPA-TB Orange Refractors")).toBe("Orange Refractor");
      expect(par("2024 Bowman Chrome Prospects #CPA-TB Orange Refractor")).toBe("Orange Refractor");
    });

    it("the whole colour ladder survives in the plural", () => {
      for (const c of ["Gold", "Red", "Purple", "Green", "Yellow", "Aqua", "Blue"]) {
        expect(par(`2024 Topps Chrome #150 ${c} Refractors /99`)).toBe(`${c} Refractor`);
      }
    });

    it("pattern refractors survive in the plural", () => {
      expect(par("2024 Bowman Chrome - Yordan Alvarez #48 Mojo Refractors")).toBe("Mojo Refractor");
      expect(par("2024 Bowman Chrome Eric Hartman Wave Refractors /350")).toBe("Wave Refractor");
      expect(par("2024 Bowman Chrome Speckle Refractors #BCP-9")).toBe("Speckle Refractor");
    });

    it("SuperFractor is untouched by either widening", () => {
      expect(par("2024 Bowman Chrome Superfractor 1/1 #BCP-21")).toBe("SuperFractor");
    });
  });

  // ── B. bare X-Fractor, all three spellings ──────────────────────────────
  describe("B: bare X-Fractor names itself", () => {
    it("reads the prod sale that exposed it", () => {
      // cardsight::2972bdf9717a81f164993fb2 — stored on
      // hiq:baseball:2024:topps-chrome:1:base:no-auto, $107.50
      expect(par("Shohei Ohtani #1 X-Fractor LA Dodgers | 2024 Topps Chrome"))
        .toBe("X-Fractor");
    });

    it("reads the $40 sale that was pooling against a $7.49 base", () => {
      expect(par("Topps 2024 Chrome Update Paul Skenes Rookie X fractor #USC88"))
        .toBe("X-Fractor");
    });

    it("all three spellings collapse to one canonical parallel", () => {
      // Same physical card; three seller spellings. If these disagreed they
      // would be three pools for one card.
      expect(par("2024 Topps Chrome #1 X-Fractor")).toBe("X-Fractor");
      expect(par("2024 Topps Chrome #1 X Fractor")).toBe("X-Fractor");
      expect(par("2024 Topps Chrome #1 Xfractor")).toBe("X-Fractor");
    });

    it("a colour still beats the bare rule", () => {
      // Placement is the whole guard: the colour rule runs first.
      expect(par("2024 Topps Chrome #1 Blue X-Fractor /150")).toBe("Blue X-Fractor");
      expect(par("2024 Topps Chrome #1 Gold Xfractor /50")).toBe("Gold X-Fractor");
      // The SPACED spelling with a colour. Found by this fixture: the colour
      // rule matched only "X-Fractor"/"Xfractor", so "Orange X Fractor" lost
      // its colour. Before the bare rule existed that loss fell through to
      // Base and read as the same bug; with a bare rule it would have become a
      // confidently WRONG answer — a /25 Orange filed in the plain X-Fractor
      // pool. Widening one rule made an old gap in its neighbour load-bearing.
      expect(par("2024 Topps Chrome #1 Orange X Fractor /25")).toBe("Orange X-Fractor");
    });

    it("does not fire on the tail of another word", () => {
      // The \b before x is load-bearing.
      expect(par("2024 Bowman Chrome Packfractor /89")).toBe("Packfractor");
      expect(par("2024 Topps Chrome Logofractor Future Stars Auto /99")).toBe("Logofractor");
    });
  });

  // ── the expensive direction: lots ───────────────────────────────────────
  describe("a lot is not a card", () => {
    it("refuses the measurement's own lot shapes", () => {
      // 211 rows the measurement triaged out rather than repair. A lot price
      // read as a refractor moves several cards' money into one card's pool.
      expect(par("2024 Bowman Chrome Lot Of 6 Refractors")).toBe("Base");
      expect(par("40x 2024 Topps Chrome Refractors")).toBe("Base");
      expect(par("(12 Cards) 2024 Bowman Chrome Refractors")).toBe("Base");
    });

    it("refuses the adversarial lot idioms", () => {
      for (const t of [
        "2024 Topps Chrome Refractor Lot",
        "2024 Bowman Chrome Refractors Bundle",
        "2024 Topps Chrome Refractors and 5 more",
        "2024 Topps Chrome Refractors Complete Set",
        "2024 Bowman Chrome 25 x Refractors",
      ]) {
        expect(par(t), t).toBe("Base");
      }
    });

    // ROUND 2 NARROWED THESE OUT, deliberately. Each was in the list above and
    // each is ordinary single-card text, not a lot:
    //
    //   "++"          a grading condition ("NM+++"), measured as a false
    //                 positive on a real 2023 pull
    //   "You Pick" /  store boilerplate on a listing that still ships ONE card
    //   "Pick Your Card"
    //
    // A guard that writes Base over a stated finish is wrong in the other
    // direction, so these must now READ.
    it("does not refuse condition and store boilerplate", () => {
      for (const t of [
        "2024 Bowman Chrome Refractors ++",
        "2024 Topps Chrome Refractors You Pick",
        "2024 Topps Chrome Refractors - Pick Your Card",
      ]) {
        expect(par(t), t).toBe("Refractor");
      }
    });

    it("the singular is refused in a lot too, not only the plural", () => {
      // The guard is on the branch, not on the plural — a lot of one-named
      // refractor is still several cards.
      expect(par("Lot Of 6 2024 Bowman Chrome Refractor")).toBe("Base");
    });

    it("does NOT refuse an ordinary single card that merely contains a digit", () => {
      // The lot detector must not eat the population it is guarding. These are
      // the shapes that share characters with a lot marker and are not lots.
      expect(par("2024 Bowman Chrome Refractors #80 Aaron Judge 167/499")).toBe("Refractor");
      expect(par("2024 Topps Chrome Refractors #150 /99 PSA 10")).toBe("Refractor");
      expect(par("2024 Bowman Chrome 1st Bowman Refractors #BCP-21")).toBe("Refractor");
    });
  });

  // ── the shared detector ─────────────────────────────────────────────────
  describe("isMultiCardLot is the one detector both lanes use", () => {
    it("fires on quantity markers", () => {
      for (const t of [
        "Lot Of 6 Refractors",
        "40x Refractors",
        "(12 Cards) Refractors",
        "Refractor Lot",
        "Refractors Bundle",
        "Refractors and 5 more",
        "Complete Set Refractors",
      ]) {
        expect(isMultiCardLot(t), t).toBe(true);
      }
    });

    // Round 2: these left the lexicon. "++" is a grading condition and "You
    // Pick" is store boilerplate on a single-card listing — see the round-2
    // regression suite for the measured false positives.
    it("does not fire on condition or store boilerplate", () => {
      for (const t of ["Refractors ++", "You Pick Refractors"]) {
        expect(isMultiCardLot(t), t).toBe(false);
      }
    });

    it("does not fire on an ordinary single-card title", () => {
      for (const t of [
        "2024 Bowman Chrome Refractors #80 Aaron Judge 167/499 YANKEES",
        "Shohei Ohtani #1 X-Fractor LA Dodgers | 2024 Topps Chrome",
        "2024 Bowman Chrome Prospects #CPA-TB Orange Refractor",
      ]) {
        expect(isMultiCardLot(t), t).toBe(false);
      }
    });

    it("a card number before an X-Fractor is not a quantity", () => {
      // The measurement's triage regex used a bare \b\d+\s*x\b and DID fire on
      // these — so its 211 lot count swept in some single X-Fractor cards. The
      // lookahead is what separates a multiplier from a card number, and
      // without it this guard would refuse the population it protects.
      expect(isMultiCardLot("Shohei Ohtani #1 X-Fractor LA Dodgers | 2024 Topps Chrome")).toBe(false);
      expect(isMultiCardLot("2024 Topps Chrome #1 X Fractor")).toBe(false);
      expect(isMultiCardLot("2024 Topps Chrome #1 Blue X-Fractor /150")).toBe(false);
      // ...while a real multiplier still reads as one, spaced or not.
      expect(isMultiCardLot("40x 2024 Topps Chrome Refractors")).toBe(true);
      expect(isMultiCardLot("2024 Bowman Chrome 25 x Refractors")).toBe(true);
    });

    it("those X-Fractor singles still parse to their parallel", () => {
      // The end-to-end consequence of the line above: the guard does not eat
      // the repair's own population.
      expect(par("Shohei Ohtani #1 X-Fractor LA Dodgers | 2024 Topps Chrome")).toBe("X-Fractor");
      expect(par("2024 Topps Chrome #1 Blue X-Fractor /150")).toBe("Blue X-Fractor");
    });

    it("is null-safe", () => {
      expect(isMultiCardLot(null)).toBe(false);
      expect(isMultiCardLot(undefined)).toBe(false);
      expect(isMultiCardLot("")).toBe(false);
    });
  });

  // ── a set NAME containing "Refractors" still names the parallel ─────────
  describe("Refractors as part of a set name still names the parallel", () => {
    it("the measurement's example parses, it is not held back", () => {
      // "2024 Bowman Chrome Refractors #80 Aaron Judge 167/499" — here
      // "Refractors" reads as the Topps checklist's own name for the parallel
      // subset. Per the measurement triage this is a legitimate single card
      // and IS repairable; it must not be refused as a false lot.
      const r = parseListingIdentity(
        "2024 Bowman Chrome Refractors #80 Aaron Judge 167/499 YANKEES",
      ) as { parallel?: string; cardNumber?: string; printRun?: number };
      expect(r.parallel).toBe("Refractor");
      expect(r.cardNumber).toBe("80");
      expect(r.printRun).toBe(499);
    });
  });
});
