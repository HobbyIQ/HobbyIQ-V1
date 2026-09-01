import { describe, it, expect } from "vitest";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service.js";

/**
 * CF-A-PREFIXED-NUMBER-OUTRANKS-A-BARE-ONE (Drew, 2026-08-31).
 *
 * `String.match` with a non-global regex returns the FIRST match in string
 * order, and sellers write a LISTING-POSITION prefix first. The 2026-08-31
 * setKey-misfile diagnosis found two rows where that read the wrong number:
 *
 *   "#1 2024 Topps Chrome Update X-Fractor #USC88 Paul Skenes RC PSA 10"
 *
 * parsed to cardNumber "1". The damage is worse than a wrong field, because
 * the SLUG was minted from the same wrong parse: slug and parse AGREE, so no
 * cardNumber-mismatch check catches it, and a Chrome Update Skenes sale is
 * filed against flagship card #1 — a different player's comp pool.
 *
 * The rule is about SHAPE, not position: a product-coded number (USC88,
 * PDC-171, CPA-EW) is unambiguous, a bare small integer is exactly what a
 * listing index looks like too. The adversarial half of this file is the
 * load-bearing half — genuine "#1" cards are everywhere (Ohtani 2024 Topps
 * Chrome #1 above all), and a rule that skipped them would trade two wrong
 * rows for thousands.
 */
describe("a prefixed card number outranks a bare one", () => {
  it("reads the real card number past a listing-position prefix (the Skenes row)", () => {
    const p = parseListingIdentity(
      "#1 2024 Topps Chrome Update X-Fractor #USC88 Paul Skenes RC Rookie PSA 10",
    );
    expect(p.cardNumber).toBe("USC88");
  });

  it("does the same for a hyphenated product code", () => {
    expect(
      parseListingIdentity("#5 2024 Topps Pro Debut #PDC-171 Refractor").cardNumber,
    ).toBe("PDC-171");
    expect(
      parseListingIdentity("#12 2025 Bowman Draft #CPA-EW Eli Willits Yellow Auto").cardNumber,
    ).toBe("CPA-EW");
  });

  // THE ADVERSARIAL HALF. A genuine #1 card must not break.
  it("keeps a genuine bare #1 when that is the only number stated", () => {
    for (const t of [
      "2024 Topps Chrome Shohei Ohtani #1 X-Fractor",
      "2024 Topps Series 1 Shohei Ohtani #1 RC",
      "2024 Topps Chrome #1 Shohei Ohtani Refractor PSA 10",
      "2024 Topps Chrome Update #1 Shohei Ohtani",
    ]) {
      expect(parseListingIdentity(t).cardNumber, t).toBe("1");
    }
  });

  it("keeps the bare number when a listing prefix is the ONLY number", () => {
    // Nothing prefixed to promote, so the long-standing reading stands.
    expect(
      parseListingIdentity("#1 2024 Topps Series 1 Shohei Ohtani RC PSA 10").cardNumber,
    ).toBe("1");
  });

  it("leaves a prefixed-only title exactly as it always parsed", () => {
    expect(
      parseListingIdentity("2024 Topps Chrome Update #USC88 Paul Skenes RC").cardNumber,
    ).toBe("USC88");
    expect(
      parseListingIdentity("2025 Bowman Chrome #BCP-102 Refractor").cardNumber,
    ).toBe("BCP-102");
  });

  it("refuses to pick when the title names several different prefixed numbers", () => {
    // Two cards named is a lot, not one card numbered twice. Falling back to
    // the first-match reading keeps this in the lot lane rather than
    // confidently filing it against one of the two.
    const p = parseListingIdentity("#1 2024 Topps Chrome #USC88 Skenes #USC90 Judge Lot");
    expect(p.cardNumber).toBe("1");
  });

  it("does not disturb a bare-number lot title", () => {
    expect(
      parseListingIdentity("2024 Topps #1 Ohtani #2 Judge Lot of 2").cardNumber,
    ).toBe("1");
  });
});
