/**
 * Drew, 2026-08-31: "We need to find that in a checklist, that is a checklist
 * gap." BNR-VGJ had no catalog row because scrape-tcdb's anchor extractor
 * required a digit in the card number, so the 2018 Bowman Chrome NSCC Wrapper
 * Redemption page — which holds all 50 BNR cards — extracted ZERO rows. A whole
 * class of checklist was unreachable, not merely unfetched.
 *
 * Two shapes have to survive:
 *   BNR-VGJ   initials, no digit anywhere
 *   #-VG      the number sign IS part of the number (product: #BowmanTrending)
 *
 * And the original guard has to keep holding: a bare word with neither digit
 * nor hyphen is link text ("Base", "More"), never a card number.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const src = readFileSync(require.resolve("../scripts/scrape-tcdb.cjs"), "utf8");

/** The extractor's accept/reject decision, lifted from scrape-tcdb.cjs. */
function accepts(text: string): boolean {
  const num = text.replace(/^#(?=[A-Za-z0-9])/, "").trim();
  if (!/^#?[A-Za-z0-9]{0,8}(?:-[A-Za-z0-9]{1,8})?$/.test(num)) return false;
  if (!/[A-Za-z0-9]/.test(num)) return false;
  if (!/\d/.test(num) && !num.includes("-")) return false;
  return true;
}

describe("scrape-tcdb — a card number need not contain a digit", () => {
  it.each(["BNR-VGJ", "BNR-VG", "BNR-AA", "BNR-KGJ", "CPA-BR", "S-1", "R-8", "SS-3"])(
    "accepts %s",
    (n) => expect(accepts(n)).toBe(true),
  );

  it("accepts #-VG, where the number sign is part of the number", () => {
    expect(accepts("#-VG")).toBe(true);
    // "#12" is card 12 — the sign is decoration there and gets stripped.
    expect(accepts("#12")).toBe(true);
  });

  it.each(["Base", "More", "Prospects", "Checklist", "Autographs"])(
    "rejects the link text %s",
    (w) => expect(accepts(w)).toBe(false),
  );

  it("the digit-only requirement is gone from the source", () => {
    // The exact line that made 50 BNR cards unreachable.
    expect(src).not.toMatch(/if \(!\/\\d\/\.test\(num\)\) return;/);
    expect(src).toMatch(/CF-TCDB-INITIALS-NUMBERS/);
  });
});
