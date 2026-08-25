import { describe, it, expect } from "vitest";
import { unparsedVariantReason, wouldFlattenAVariant } from "../src/services/catalog/attestationGuard";

// Every title below is verbatim from a row the unnumbered attest pass actually
// created on 2026-08-24. They are the evidence the guard exists for.
describe("attestation guard holds back sales whose title names a variant", () => {
  it("catches a parallel with no colour word (shipped detector cannot)", () => {
    expect(unparsedVariantReason({ title: "2015-16 Panini Excalibur Devin Booker #11 Crusade Camo RC" })).toBe("parallel word");
    expect(unparsedVariantReason({ title: "2023-24 Panini Recon Cade Cunningham Future Legends Holo Detroit Pistons - Raw 10" })).toBe("parallel word");
  });

  it("catches a colour + parallel word via the shipped detector", () => {
    // No colour word here at all -- "Downtown" and "Prizm" carry it, which is
    // exactly the gap the shipped detector leaves.
    expect(unparsedVariantReason({ title: "JUSTIN HERBERT PSA 10 2020 PANINI DONRUSS OPTIC ROOKIE DOWNTOWN PRIZM SSP RC" }))
      .toBe("parallel word");
  });

  it("catches a dropped autograph", () => {
    // This one shipped as :base:no-auto with printRun null -- both dropped.
    expect(wouldFlattenAVariant({ title: "2023 Panini Black Tank Bigsby Rookie Auto /50 No 125 (AU, RC) - Raw 10" })).toBe(true);
    // Orange parallel AND an auto AND a 21/25 print run: three reasons to hold,
    // so assert that it IS held rather than pinning which reason wins.
    expect(wouldFlattenAVariant({ title: "ONEIL CRUZ 2024 FANATICS EMANATE UNDER WRAPS 8X10 ORANGE AUTO AUTOGRAPH 21/25 - Raw 10" })).toBe(true);
    expect(unparsedVariantReason({ title: "2024 Bowman Some Guy Rookie Auto RC" })).toBe("auto in title");
  });

  it("catches a dropped print run", () => {
    expect(unparsedVariantReason({ title: "2024 Topps Chrome Some Player 21/25 Rookie" })).toBe("print run in title");
  });

  it("does not fire once the parser HAS carried the variant", () => {
    expect(unparsedVariantReason({
      title: "2024 Panini Photogenic Progressions Derrick Henry Blue Foil /99 Titans Ravens - Raw 10",
      parsedParallel: "Blue Foil", parsedPrintRun: 99,
    })).toBeNull();
    expect(unparsedVariantReason({
      title: "2023 Panini Black Tank Bigsby Rookie Auto /50 No 125 (AU, RC) - Raw 10",
      setName: "2023 Panini Black", parsedParallel: "Base", parsedIsAuto: true, parsedPrintRun: 50,
    })).toBeNull();
  });

  it("does not read a colour in the PRODUCT name as a parallel", () => {
    // Without setName subtraction this fires on "Panini Black" + "Auto" and
    // holds back a row the parser got completely right.
    expect(unparsedVariantReason({
      title: "2023 Panini Black Tank Bigsby Rookie No 125 (RC) - Raw 10",
      setName: "2023 Panini Black",
    })).toBeNull();
  });

  it("lets a genuinely plain vintage card through", () => {
    // The population this pass was built for: 1950s sets with no card numbers.
    expect(unparsedVariantReason({ title: "1955 Red Man Tobacco #22 Hank Bauer Sports Trading Card  - Raw 10" })).toBeNull();
    expect(unparsedVariantReason({ title: "1952 Berk Ross Larry Doby Cleveland Indians" })).toBeNull();
    expect(unparsedVariantReason({ title: "2001 SP Legendary Cuts Baseball #60 Roberto Clemente Pittsburgh Pirates" })).toBeNull();
  });
});
