import { describe, it, expect } from "vitest";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service.js";

/**
 * CF-STANDALONE-PREFIXED-CARDNUMBER (Drew, 2026-08-24).
 *
 * The card number was stated plainly and never read:
 *
 *   "2025 Topps Stars of MLB SMLB-10 Shohei Ohtani ..."      -> cardNumber null
 *   "2025 Bowman Draft CPA-EW Eli Willits Yellow Refractor"  -> cardNumber null
 *
 * DEFAULT_CARD_NUMBER_RE requires a literal '#'; the standalone fallback only
 * accepted bare digits before a grader word. A prefixed number with no hash
 * matched neither.
 *
 * It mattered because canonicalize's fuzzy step requires a cardNumber, so every
 * such sale failed to match — 800 of 800 in the first resolver probe came back
 * not-found for exactly this reason.
 */
describe("a prefixed card number without a # is still a card number", () => {
  const num = (t: string) => (parseListingIdentity(t) as { cardNumber?: string | null }).cardNumber;

  it("reads SMLB-10 with no hash", () => {
    expect(num("2025 Topps Stars of MLB SMLB-10 Shohei Ohtani Los Angeles Dodgers")).toBe("SMLB-10");
  });

  it("reads CPA-EW with no hash", () => {
    expect(num("2025 Bowman Draft CPA-EW Eli Willits Yellow Refractor Auto 75")).toBe("CPA-EW");
  });

  it("still prefers the hashed form when present", () => {
    expect(num("2025 Bowman Draft Chrome MAX WILLIAMS 1/50 1st Auto Gold Ref. #CPA-MWI PSA 9")).toBe("CPA-MWI");
  });

  it("does not mistake grade or descriptor compounds for card numbers", () => {
    // These appear in the same position and are the ones that actually occur.
    for (const t of [
      "1986 Fleer Michael Jordan ALL-STAR PSA 8",
      "1952 Topps Mickey Mantle SET-BREAK VG-EX",
      "2024 Topps Chrome ON-CARD Auto",
      "1955 Bowman GEM-MT 10",
      "2023 Panini Prizm DIE-CUT Insert",
    ]) {
      const n = num(t);
      expect(n === null || /\d/.test(String(n)), `${t} -> ${n}`).toBe(true);
    }
  });

  it("leaves bare-digit titles to the existing rule", () => {
    expect(num("2023 PANINI SELECT GOLD GLITTER JALEN BRUNSON 194 PSA 10")).toBe("194");
  });
});
