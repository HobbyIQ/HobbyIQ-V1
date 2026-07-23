// CF-HOLDING-FIELD-NORMALIZER (Drew, 2026-07-14) — pins every rule in
// the normalizer against the real messy-field patterns observed on
// Drew's 2026-07-14 holdings probe. Each rule has:
//   - A pinning test using an observed real value
//   - An idempotency test (normalize(normalize(x)) === normalize(x))
//   - A no-op test proving already-clean data is left alone

import { describe, expect, it } from "vitest";
import {
  normalizeHoldingFields,
  _getRuleNames,
} from "../src/services/portfolioiq/holdingFieldNormalizer.service.js";

describe("normalizer rule inventory", () => {
  it("has every documented rule wired", () => {
    const names = _getRuleNames();
    expect(names).toContain("setName_strip_year_prefix");
    expect(names).toContain("setName_title_case");
    expect(names).toContain("parallel_strip_subset_prefix");
    expect(names).toContain("playerName_strip_leading_noise");
    expect(names).toContain("cardNumber_uppercase_trim");
  });
});

describe("R1 setName_strip_year_prefix — kills the '2026 2026 Bowman' query doubling", () => {
  it("strips leading year that matches cardYear", () => {
    const r = normalizeHoldingFields({ setName: "2026 Bowman", cardYear: 2026 });
    expect(r.fields.setName).toBe("Bowman");
    expect(r.changes[0].rule).toBe("setName_strip_year_prefix");
  });

  it("strips leading year-range (2025-26 Bowman with cardYear=2025)", () => {
    const r = normalizeHoldingFields({ setName: "2025-26 Bowman", cardYear: 2025 });
    expect(r.fields.setName).toBe("Bowman");
  });

  it("strips leading year-range with full 4-digit second year", () => {
    const r = normalizeHoldingFields({ setName: "2025-2026 Bowman", cardYear: 2025 });
    expect(r.fields.setName).toBe("Bowman");
  });

  it("leaves setName alone when year prefix doesn't match cardYear", () => {
    const r = normalizeHoldingFields({ setName: "2025 Topps", cardYear: 2026 });
    expect(r.fields.setName).toBe("2025 Topps");
    expect(r.changes).toHaveLength(0);
  });

  it("leaves setName alone when no year prefix present", () => {
    const r = normalizeHoldingFields({ setName: "Bowman Chrome", cardYear: 2026 });
    expect(r.fields.setName).toBe("Bowman Chrome");
  });

  it("does NOT strip if it would leave setName empty", () => {
    const r = normalizeHoldingFields({ setName: "2026", cardYear: 2026 });
    expect(r.fields.setName).toBe("2026");
  });

  it("idempotent: second normalize is a no-op", () => {
    const a = normalizeHoldingFields({ setName: "2026 Bowman", cardYear: 2026 });
    const b = normalizeHoldingFields(a.fields);
    expect(b.fields.setName).toBe(a.fields.setName);
    expect(b.changes).toHaveLength(0);
  });
});

describe("R2 setName_title_case — 'bowman baseball' → 'Bowman Baseball'", () => {
  it("title-cases all-lowercase setName", () => {
    const r = normalizeHoldingFields({ setName: "bowman baseball", cardYear: 2026 });
    expect(r.fields.setName).toBe("Bowman Baseball");
  });

  it("leaves mixed-case setName alone (already intentional)", () => {
    const r = normalizeHoldingFields({ setName: "Bowman's Best", cardYear: 2026 });
    expect(r.fields.setName).toBe("Bowman's Best");
  });

  it("composes with year strip: '2026 bowman' → 'Bowman'", () => {
    const r = normalizeHoldingFields({ setName: "2026 bowman", cardYear: 2026 });
    expect(r.fields.setName).toBe("Bowman");
  });
});

describe("R3 parallel_strip_subset_prefix — 'Chrome Refractor' → 'Refractor'", () => {
  it("strips 'Chrome' prefix leaving real parallel", () => {
    const r = normalizeHoldingFields({ parallel: "Chrome Refractor" });
    expect(r.fields.parallel).toBe("Refractor");
  });

  it("strips 'Chrome Prospects' prefix", () => {
    const r = normalizeHoldingFields({ parallel: "Chrome Prospects Refractor" });
    expect(r.fields.parallel).toBe("Refractor");
  });

  it("nulls out parallel when it's ONLY subset noise", () => {
    const r = normalizeHoldingFields({ parallel: "Chrome" });
    expect(r.fields.parallel).toBeNull();
  });

  it("leaves real parallel alone", () => {
    const r = normalizeHoldingFields({ parallel: "Blue Refractor" });
    expect(r.fields.parallel).toBe("Blue Refractor");
    expect(r.changes).toHaveLength(0);
  });

  it("case-insensitive: 'chrome refractor' also handled", () => {
    const r = normalizeHoldingFields({ parallel: "chrome refractor" });
    expect(r.fields.parallel).toBe("refractor");
  });

  it("does NOT strip 'Refractor' by itself (base refractor is a real SKU)", () => {
    const r = normalizeHoldingFields({ parallel: "Refractor" });
    expect(r.fields.parallel).toBe("Refractor");
  });
});

describe("R4 playerName_strip_leading_noise — 'Refractors Eric Hartman' → 'Eric Hartman'", () => {
  it("strips leading 'Refractors' (plural, observed leak)", () => {
    const r = normalizeHoldingFields({ playerName: "Refractors Eric Hartman" });
    expect(r.fields.playerName).toBe("Eric Hartman");
  });

  it("strips leading 'Sapphire' (2026-07-14 audit: 'Sapphire Owen Carey' for BSPA-OC)", () => {
    const r = normalizeHoldingFields({ playerName: "Sapphire Owen Carey" });
    expect(r.fields.playerName).toBe("Owen Carey");
  });

  it("strips leading 'Bowman' (brand-leak case)", () => {
    const r = normalizeHoldingFields({ playerName: "Bowman Eric Hartman" });
    expect(r.fields.playerName).toBe("Eric Hartman");
  });

  it("R3 does NOT strip 'Sapphire' from a parallel field (Sapphire Refractor is a real SKU)", () => {
    // Cross-check: the noise vocab was split so R3 (parallel) doesn't
    // reach the R4-only words. Sapphire Refractor stays intact.
    const r = normalizeHoldingFields({ parallel: "Sapphire Refractor" });
    expect(r.fields.parallel).toBe("Sapphire Refractor");
  });

  it("strips leading 'Chrome Prospects' words", () => {
    const r = normalizeHoldingFields({ playerName: "Chrome Prospects Eric Hartman" });
    expect(r.fields.playerName).toBe("Eric Hartman");
  });

  it("leaves clean player name alone", () => {
    const r = normalizeHoldingFields({ playerName: "Eric Hartman" });
    expect(r.fields.playerName).toBe("Eric Hartman");
    expect(r.changes).toHaveLength(0);
  });

  it("does NOT strip if it would leave name empty (safety)", () => {
    const r = normalizeHoldingFields({ playerName: "Refractors" });
    expect(r.fields.playerName).toBe("Refractors");
  });

  it("does NOT strip mid-name (only leading tokens)", () => {
    const r = normalizeHoldingFields({ playerName: "Eric Chrome Hartman" });
    expect(r.fields.playerName).toBe("Eric Chrome Hartman");
  });
});

describe("R5 cardNumber_uppercase_trim — 'cpa-eha' → 'CPA-EHA'", () => {
  it("uppercases lowercase card number", () => {
    const r = normalizeHoldingFields({ cardNumber: "cpa-eha" });
    expect(r.fields.cardNumber).toBe("CPA-EHA");
  });

  it("trims whitespace", () => {
    const r = normalizeHoldingFields({ cardNumber: "  BCP-102  " });
    expect(r.fields.cardNumber).toBe("BCP-102");
  });

  it("leaves already-clean number alone", () => {
    const r = normalizeHoldingFields({ cardNumber: "CPA-EHA" });
    expect(r.fields.cardNumber).toBe("CPA-EHA");
    expect(r.changes).toHaveLength(0);
  });
});

describe("full pipeline — a realistic messy holding gets fully cleaned", () => {
  it("2026 2026 bowman 'refractors eric hartman' chrome refractor #cpa-eha", () => {
    // Real observed Hartman holding shape (see 2026-07-14 probe).
    const r = normalizeHoldingFields({
      playerName: "Refractors Eric Hartman",
      cardYear: 2026,
      setName: "2026 bowman",
      parallel: "Chrome Refractor",
      cardNumber: "cpa-eha",
      isAuto: true,
    });
    expect(r.fields.playerName).toBe("Eric Hartman");
    expect(r.fields.setName).toBe("Bowman");
    expect(r.fields.parallel).toBe("Refractor");
    expect(r.fields.cardNumber).toBe("CPA-EHA");
    expect(r.fields.cardYear).toBe(2026);
    // 4 changes: year strip, title case, parallel strip, player strip, number
    expect(r.changes.length).toBeGreaterThanOrEqual(4);
  });

  it("clean input → zero changes (idempotent baseline)", () => {
    const clean = {
      playerName: "Eric Hartman",
      cardYear: 2026,
      setName: "Bowman Chrome",
      parallel: "Blue Refractor",
      cardNumber: "CPA-EHA",
      isAuto: true,
    };
    const r = normalizeHoldingFields(clean);
    expect(r.changes).toHaveLength(0);
    expect(r.fields).toEqual(clean);
  });
});

describe("R6 setName_fallback_from_product — 'product' fills empty setName (issue #718)", () => {
  it("undefined setName + product='Bowman Draft Chrome Prospect Autographs' → setName copied", () => {
    const r = normalizeHoldingFields({
      playerName: "Tim Piasentin",
      cardYear: 2025,
      setName: undefined,
      product: "Bowman Draft Chrome Prospect Autographs",
      parallel: "Gum Ball",
      cardNumber: "CPA-TP",
      isAuto: true,
    });
    expect(r.fields.setName).toBe("Bowman Draft Chrome Prospect Autographs");
  });

  it("empty-string setName + product filled → product wins", () => {
    const r = normalizeHoldingFields({
      setName: "",
      product: "Topps",
    });
    expect(r.fields.setName).toBe("Topps");
  });

  it("both filled → setName unchanged", () => {
    const r = normalizeHoldingFields({
      setName: "Bowman Chrome",
      product: "Bowman",
      cardYear: 2026,
    });
    expect(r.fields.setName).toBe("Bowman Chrome");
  });

  it("both empty → nothing changes", () => {
    const r = normalizeHoldingFields({});
    expect(r.fields.setName).toBeUndefined();
    expect(r.changes.filter((c) => c.rule === "setName_fallback_from_product")).toHaveLength(0);
  });
});

describe("R7 parallel_strip_garbled_subset_prefix — legacy 'Chr Prospect Auto-X' → 'X' (issue #718)", () => {
  it("'Chr Prospect Auto-Gold Ref' → 'Gold Ref' (then R8 expands to Gold Refractor)", () => {
    const r = normalizeHoldingFields({
      playerName: "Gage Wood",
      parallel: "Chr Prospect Auto-Gold Ref",
    });
    expect(r.fields.parallel).toBe("Gold Refractor");
  });

  it("'Chrome Prospect Auto-Gold Ref' (unabbreviated) → 'Gold Refractor'", () => {
    const r = normalizeHoldingFields({
      parallel: "Chrome Prospect Auto-Gold Ref",
    });
    expect(r.fields.parallel).toBe("Gold Refractor");
  });

  it("'Prspct Au-Mini Diamond Ref' → 'Mini Diamond Refractor'", () => {
    const r = normalizeHoldingFields({
      playerName: "Leo De Vries",
      parallel: "Prspct Au-Mini Diamond Ref",
    });
    expect(r.fields.parallel).toBe("Mini Diamond Refractor");
  });

  it("'Chr Prospect Auto-Gum Ball' → 'Gum Ball' (no Ref suffix)", () => {
    const r = normalizeHoldingFields({
      playerName: "Tim Piasentin",
      parallel: "Chr Prospect Auto-Gum Ball",
    });
    expect(r.fields.parallel).toBe("Gum Ball");
  });

  it("clean parallel 'Gold Refractor' → unchanged (idempotent)", () => {
    const r = normalizeHoldingFields({ parallel: "Gold Refractor" });
    expect(r.fields.parallel).toBe("Gold Refractor");
    expect(r.changes.filter((c) => c.rule === "parallel_strip_garbled_subset_prefix")).toHaveLength(0);
  });

  it("does NOT strip 'Gold Ref' alone (no garbled prefix present)", () => {
    // 'Gold Ref' by itself should just get R8 (Ref → Refractor).
    const r = normalizeHoldingFields({ parallel: "Gold Ref" });
    expect(r.fields.parallel).toBe("Gold Refractor");
    expect(r.changes.filter((c) => c.rule === "parallel_strip_garbled_subset_prefix")).toHaveLength(0);
    expect(r.changes.filter((c) => c.rule === "parallel_expand_ref_suffix")).toHaveLength(1);
  });

  it("does NOT strip 'Chrome-Image Variation' (single-token prefix is a REAL variant)", () => {
    // Regression: R7 originally used `{0,}` on the repeat, which matched
    // "Chrome" alone and mis-stripped "Chrome-Image Variation" to
    // "Image Variation". Real observed variant (Kade Anderson 2025
    // Bowman Draft). {1,} requires ≥2 tokens.
    const r = normalizeHoldingFields({ parallel: "Chrome-Image Variation" });
    expect(r.fields.parallel).toBe("Chrome-Image Variation");
    expect(r.changes.filter((c) => c.rule === "parallel_strip_garbled_subset_prefix")).toHaveLength(0);
  });
});

describe("R8 parallel_expand_ref_suffix — 'Ref' → 'Refractor'", () => {
  it("'Gold Ref' → 'Gold Refractor'", () => {
    const r = normalizeHoldingFields({ parallel: "Gold Ref" });
    expect(r.fields.parallel).toBe("Gold Refractor");
  });

  it("'Blue Ref' → 'Blue Refractor'", () => {
    const r = normalizeHoldingFields({ parallel: "Blue Ref" });
    expect(r.fields.parallel).toBe("Blue Refractor");
  });

  it("'Gold Refractor' → unchanged (already expanded)", () => {
    const r = normalizeHoldingFields({ parallel: "Gold Refractor" });
    expect(r.fields.parallel).toBe("Gold Refractor");
  });

  it("does NOT expand mid-string 'Reference' (word-boundary only, suffix only)", () => {
    const r = normalizeHoldingFields({ parallel: "Something Reference Card" });
    expect(r.fields.parallel).toBe("Something Reference Card");
  });
});

describe("skipRules option — lets tests / edge cases suppress individual rules", () => {
  it("skipping year_prefix keeps '2026 Bowman' as-is", () => {
    const r = normalizeHoldingFields(
      { setName: "2026 Bowman", cardYear: 2026 },
      { skipRules: new Set(["setName_strip_year_prefix"]) },
    );
    expect(r.fields.setName).toBe("2026 Bowman");
  });
});
