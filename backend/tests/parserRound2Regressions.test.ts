import { describe, it, expect } from "vitest";
import {
  parseListingIdentity,
  isMultiCardLot,
} from "../src/services/portfolioiq/parseTitleIdentity.service.js";

/**
 * ROUND-2 REGRESSIONS (Drew, 2026-08-31).
 *
 * Round 1 widened two rules and added a lot guard. Executing the parser against
 * origin/main over 33 adversarial titles — rather than trusting the vitest
 * suite, which had no fixture for any of these shapes — found that the widening
 * shipped four NET-NEW wrong answers and left its own headline defect half
 * fixed. Every case below is one of those, pinned so the fix cannot rot.
 *
 * The lesson the file exists to hold: a suite that is green on both sides of a
 * change measures the shapes it covers and says NOTHING about the rest. Each
 * regression here was invisible to 500 passing tests.
 */
describe("round-2 parser regressions", () => {
  const par = (t: string) => (parseListingIdentity(t) as { parallel?: string }).parallel;

  // ── 1. the colour X-Fractor rule lost its plural ────────────────────────
  //
  // Round 1 ADDED a trailing \b to this rule, so the plural failed it and fell
  // into the newly widened /\brefractors?\b/ fallback: a /25 Orange X-Fractor
  // filed into the plain Orange Refractor pool. Strictly worse than the
  // behaviour it replaced, and the exact harm the commit said it prevented.
  describe("1: the colour ladder survives the plural", () => {
    it("Orange X-Fractors keeps its colour AND its X", () => {
      expect(par("2024 Topps Chrome Orange X-Fractors /25")).toBe("Orange X-Fractor");
    });

    it("holds across every spelling and colour", () => {
      expect(par("2024 Topps Chrome Orange X-Fractor /25")).toBe("Orange X-Fractor");
      expect(par("2024 Topps Chrome Orange X Fractor /25")).toBe("Orange X-Fractor");
      expect(par("2024 Topps Chrome Gold X-Fractors #12")).toBe("Gold X-Fractor");
      expect(par("2024 Topps Chrome Blue X-Fractors /150")).toBe("Blue X-Fractor");
    });

    it("a colour X-Fractor NEVER degrades to a plain Refractor", () => {
      // The specific failure: the fallback answering for a rule that should
      // have matched. A colour in the answer or nothing — never "Refractor".
      for (const t of [
        "2024 Topps Chrome Orange X-Fractors /25",
        "2024 Topps Chrome Gold X-Fractors #12",
        "2024 Topps Chrome Blue X-Fractors /150",
      ]) {
        expect(par(t)).not.toBe("Refractor");
        expect(par(t)).not.toBe("Orange Refractor");
      }
    });
  });

  // ── 2. the bare rule needed the same plural ────────────────────────────
  //
  // Round 1's central thesis is that the plural is how Topps prints it. It
  // applied that to Refractor and not to the X-Fractor rule it wrote in the
  // SAME commit, so all three plural spellings still returned Base.
  describe("2: the bare X-Fractor rule reads its own plural", () => {
    it("all three plural spellings stop returning Base", () => {
      expect(par("2024 Topps Chrome X-Fractors #12")).toBe("X-Fractor");
      expect(par("2024 Topps Chrome X Fractors #12")).toBe("X-Fractor");
      expect(par("2024 Topps Chrome Xfractors #12")).toBe("X-Fractor");
    });

    it("singular still reads, and SuperFractor still outranks it", () => {
      expect(par("2024 Topps Chrome X-Fractor #12")).toBe("X-Fractor");
      expect(par("2024 Topps Chrome Superfractor 1/1")).not.toBe("X-Fractor");
    });
  });

  // ── 3. the fallback must be LAST, or it eats a whole sport ──────────────
  //
  // The basketball block sits below the baseball rules by design ("These rules
  // run AFTER the baseball checks above"). Widening the fallback to the plural
  // while it sat ABOVE that block intercepted every plural basketball title
  // before its own vocabulary was reached.
  describe("3: basketball keeps its own vocabulary", () => {
    it("Prizm stays Prizm on the plural", () => {
      expect(par("2024 Panini Prizm Silver Refractors #12 Victor Wembanyama"))
        .toBe("Silver Prizm");
      expect(par("2024 Panini Prizm Silver Refractor #12 Victor Wembanyama"))
        .toBe("Silver Prizm");
    });

    it("Optic stays Optic on the plural", () => {
      expect(par("2023 Panini Donruss Optic Holo Refractors #10")).toBe("Holo Optic");
    });

    it("a colour Prizm beats the fallback", () => {
      expect(par("2024 Panini Prizm Blue Refractors #5 Chet Holmgren"))
        .not.toBe("Refractor");
    });

    it("Cracked Ice still outranks a bare Refractor", () => {
      expect(par("2024 Prizm Dak Prescott Green Cracked Ice Hype Prizm Refractor SP #1"))
        .toBe("Cracked Ice");
    });

    // The baseball colour ladder must be untouched by the move. The fallback
    // only ever answered when every rule above it declined, and moving it
    // further down cannot change that.
    it("the baseball colour ladder is unchanged by the move", () => {
      expect(par("2024 Bowman Chrome Orange Refractors /25")).toBe("Orange Refractor");
      expect(par("2024 Bowman Chrome Gold Refractors /50")).toBe("Gold Refractor");
      expect(par("2024 Bowman Chrome Sepia Refractors")).toBe("Sepia Refractor");
    });
  });

  // ── 4. the lot guard must not eat single cards ─────────────────────────
  //
  // Round 1's lexicon was bare words. Each fired on ordinary seller
  // boilerplate, writing Base over a finish the title plainly states — wrong
  // in the other direction, and not the conservative choice it was called.
  describe("4: the lot guard fires on lots, not on boilerplate", () => {
    it("a SURNAME is not a lot", () => {
      expect(isMultiCardLot("2024 Bowman Chrome Refractor Dylan Lot RC")).toBe(false);
      expect(par("2024 Bowman Chrome Refractor Dylan Lot RC")).toBe("Refractor");
    });

    it("cross-sell boilerplate is not a lot", () => {
      expect(par("2024 Bowman Chrome Refractor Elly De La Cruz MORE ROOKIES AVAILABLE"))
        .toBe("Refractor");
      expect(par("2024 Bowman Chrome Refractors #80 Aaron Judge - see more in my store"))
        .toBe("Refractor");
    });

    it("store boilerplate is not a lot", () => {
      expect(par("2024 Bowman Chrome Refractor #12 Pick Your Card")).toBe("Refractor");
    });

    it("SHIPPING SUPPLIES are not a lot — the count is packaging", () => {
      expect(isMultiCardLot("2024 Bowman Chrome Refractor 10x Card Saver")).toBe(false);
      expect(par("2024 Bowman Chrome Refractor 10x Card Saver")).toBe("Refractor");
      expect(par("2024 Topps Chrome Refractor #50 in Toploader")).toBe("Refractor");
    });

    it("a set-break SINGLE is one card", () => {
      expect(par("2024 Bowman Chrome Refractor Complete Set Break Single")).toBe("Refractor");
    });

    it("a print run and a draft pick are not counts of cards", () => {
      // Both measured as false positives of the round-1 lexicon on a real pull.
      expect(isMultiCardLot(
        "2024 Finest - Yordan Alvarez - Future So Bright Refractor Auto Gold /50 - NM+++ - Raw",
      )).toBe(false);
      expect(isMultiCardLot(
        "2024 Bowman Chrome 1st Jac Caglianone Refractor BDC-8 KC 1st Round Draft Pick - Raw 10",
      )).toBe(false);
    });

    it("the card number of an X-Fractor is not a quantity", () => {
      // "#1 X-Fractor" — a $107.50 SINGLE, and one of the headline examples of
      // the bug this whole branch exists to fix. The guard must not eat it.
      expect(isMultiCardLot("Shohei Ohtani #1 X-Fractor LA Dodgers | 2024 Topps Chrome"))
        .toBe(false);
      expect(par("Shohei Ohtani #1 X-Fractor LA Dodgers | 2024 Topps Chrome"))
        .toBe("X-Fractor");
    });

    // ...and the other direction: a genuine lot is still DETECTED. Narrowing a
    // guard is only safe if the population it exists for still trips it. Every
    // title below was measured on a real 2024/2023 sold_comps pull.
    it("GENUINE lots are still detected", () => {
      for (const t of [
        "2024 Bowman Chrome Lot Of 6 Refractors",
        "40x 2024 Topps Chrome Refractors",
        "(12 Cards) 2024 Bowman Chrome Refractors",
        "25 x 2024 Topps Chrome Refractors",
        "(20) 2024 Bowman AI Chrome Refractor Insert George Lombard Jr. #19 Rookie RC Lot",
        "2024 Topps Chrome Refractor Jackson Chourio Rookie Debut Bowman Insert Lot 19 RC",
        "2024 Bowman Draft #BDC-72 Braylon Payne Chrome Refractor + Base (3 Cards) - Raw 10",
        "2024 Bowman Mojo Refractor RC CEDDANNE RAFAELA #84 - Boston Red Sox (4x LOT)",
        "2023 Topps Chrome Miguel Vargas XFractor Rookie RC 2-Card Lot #161 White Sox",
      ]) {
        expect(isMultiCardLot(t), t).toBe(true);
      }
    });

    // ── ROUND 3 ──────────────────────────────────────────────────────────
    //
    // The "N more <card noun>" idiom bound the PRINT RUN's digits. \b matches
    // between "/" and "499", so "…#12 Judge /499 MORE ROOKIES AVAILABLE" —
    // cross-sell boilerplate on ONE numbered card — matched "499 MORE ROOKIES"
    // and was filed as a lot, which the bare-refractor guard then wrote to
    // Base. Round 2 pinned the un-numbered spelling of this exact boilerplate
    // ("MORE ROOKIES AVAILABLE", no count in front); the numbered one was the
    // shape no fixture covered, which is the same lesson this file opens with.
    //
    // The sibling rule never had the defect: "and|+|plus" anchors the count to
    // a conjunction, and a print run is not preceded by one.
    it("a PRINT RUN is not the count in 'N more cards'", () => {
      const t = "2024 Topps Chrome Refractor #12 Judge /499 MORE ROOKIES AVAILABLE";
      expect(isMultiCardLot(t), t).toBe(false);
      expect(par(t)).toBe("Refractor");
    });

    it("...and the genuine closing idiom is still a lot", () => {
      // The other direction of the same narrowing: no slash, so nothing about
      // this changes. A guard narrowed until its own population escapes is
      // not a fix.
      const t = "2024 Bowman Chrome Refractor Elly De La Cruz and 5 more cards";
      expect(isMultiCardLot(t), t).toBe(true);
      expect(par(t)).toBe("Base");
    });

    it("a BARE-refractor lot yields no finish", () => {
      // The guard sits on the bare fallback, so these reach it and are refused.
      for (const t of [
        "2024 Bowman Chrome Lot Of 6 Refractors",
        "40x 2024 Topps Chrome Refractors",
        "(12 Cards) 2024 Bowman Chrome Refractors",
        "25 x 2024 Topps Chrome Refractors",
        "(20) 2024 Bowman AI Chrome Refractor Insert George Lombard Jr. #19 Rookie RC Lot",
      ]) {
        expect(par(t), t).toBe("Base");
      }
    });

    it("a lot naming a COLOUR still reads it — pre-existing, and unchanged", () => {
      // Verified against origin/main: "…(4x LOT)" is "Mojo Refractor" there too.
      // The guard is deliberately on the bare fallback only, so a colour/pattern
      // rule above still answers. Widening the guard to outrank those rules is a
      // separate decision about lot pricing, not part of this fix — pinned here
      // so a future change to it is a CHOICE rather than an accident.
      expect(par("2024 Bowman Mojo Refractor RC CEDDANNE RAFAELA #84 - Boston Red Sox (4x LOT)"))
        .toBe("Mojo Refractor");
      expect(par("2024 Bowman Chrome Lot Of 6 Orange Refractors")).toBe("Orange Refractor");
    });
  });

  // ── 5. the sapphire gate belongs in the PARSER ─────────────────────────
  //
  // Bowman Chrome Sapphire is a DIFFERENT PRODUCT from Bowman Chrome. The
  // repair script guards this with namesAnotherProduct(); the parser is what
  // every future ingest runs, so it needs the same refusal. Blank means
  // unknown, and unknown leaves the row where it is.
  describe("5: sapphire never leaks a plain Refractor", () => {
    it("a sapphire title whose only finish word is Refractors stays unknown", () => {
      expect(par("2026 Bowman Chrome Sapphire Owen Carey Refractors /99")).toBe("Base");
      expect(par("2026 Bowman Chrome Sapphire Owen Carey Refractor /99")).toBe("Base");
    });

    it("a sapphire title that names a COLOUR still reads its Sapphire parallel", () => {
      // The gate is on the bare fallback only — it must not flatten the
      // sapphire colour ladder above it.
      expect(par("2026 Bowman Chrome Sapphire Owen Carey Green /99")).toBe("Green Sapphire");
      expect(par("2026 Bowman Chrome Sapphire Owen Carey Blue /150")).toBe("Blue Sapphire");
    });
  });

  // ── the wins round 1 earned, kept ──────────────────────────────────────
  describe("round-1 wins are preserved", () => {
    it("the Judge 167/499 plural still reads", () => {
      expect(par("2024 Bowman Chrome Refractors #80 Aaron Judge 167/499 YANKEES"))
        .toBe("Refractor");
      expect(par("2024 Bowman Chrome Refractors Chourio /499")).toBe("Refractor");
    });

    it("the Ohtani and Skenes X-Fractors still read", () => {
      expect(par("Shohei Ohtani #1 X-Fractor LA Dodgers | 2024 Topps Chrome"))
        .toBe("X-Fractor");
      expect(par("Topps 2024 Chrome Update Paul Skenes Rookie X fractor #USC88"))
        .toBe("X-Fractor");
    });
  });
});
