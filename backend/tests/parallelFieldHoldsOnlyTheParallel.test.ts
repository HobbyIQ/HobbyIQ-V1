// CF-A-PARALLEL-FIELD-HOLDS-ONLY-THE-PARALLEL (Drew, 2026-09-05).
//
// A parallel field names a FINISH. When a seller types a listing-title
// fragment into eBay's `Parallel/Variety` box, three other facts ride along —
// a print run, an auto flag, a grade — and every one of them has its own axis
// already. The slug built from the jammed field names a card no checklist
// carries, so the holding prices off a pool of one and `recheck-holding-
// identity MODE=rederive` GATE 2 refuses the re-point.
//
// THE CENSUS THAT SCOPED THIS (read-only, 2026-09-05, all 131 holdings across
// 11 users and 12 portfolio docs): exactly TWO holdings carry a contaminated
// parallel, and they are the same shape and the same user —
//
//   4a82faed / 25bc5079   parallel: "Refractor Auto / 499"
//                         printRun: 499   isAuto: true   cardNumber: CPA-DT
//                         slug: ...:cpa-dt:refractor-auto-499:auto:num-499
//                         twin: ...:cpa-dt:refractor:auto:num-499
//
// The corpus below pins that observed shape first, then the shapes the census
// searched for and did NOT find in holdings but which the same eBay aspect box
// produces routinely — a bare serial, a "1 of 1", a grader token. Pinning the
// unobserved shapes is deliberate: this rule exists because a seller can type
// anything, and a corpus that only covers what happened to be in the database
// today is a corpus that regresses the first time someone imports a listing.
//
// AND IT PINS WHAT MUST NOT MOVE, from a second census over sold_comps
// (16,748,738 rows carrying a parallel). That corpus is what killed the first
// cut's card-number strip: a `#` in this field is a hash, not a card-number
// marker, and 85 rows spell a real parallel with one. It also showed " / " is
// usually a COLOUR separator ("Platinum Toile Cream / Gold Refractor"), so the
// print-run pattern requires digits after the slash and the commonest slash
// parallels are pinned whole.

import { describe, expect, it } from "vitest";
import { normalizeHoldingFields } from "../src/services/portfolioiq/holdingFieldNormalizer.service.js";

const norm = (f: Record<string, unknown>) => normalizeHoldingFields(f as never).fields;

describe("CF-A-PARALLEL-FIELD-HOLDS-ONLY-THE-PARALLEL — the observed holding", () => {
  // The exact stored fields of 4a82faed and 25bc5079, read 2026-09-05.
  const observed = {
    playerName: "Devin Taylor",
    cardYear: 2025,
    setName: "Bowman Chrome",
    product: "Bowman Chrome",
    cardNumber: "CPA-DT",
    parallel: "Refractor Auto / 499",
    printRun: 499,
    isAuto: true,
  };

  it("keeps only the parallel word", () => {
    expect(norm(observed).parallel).toBe("Refractor");
  });

  it("loses NOTHING — the run and the auto flag are still stated", () => {
    const f = norm(observed);
    expect(f.printRun).toBe(499);
    expect(f.isAuto).toBe(true);
  });

  it("reaches the checklist twin's parallel spelling exactly", () => {
    // The destination row is
    //   hiq:baseball:2025:...:cpa-dt:refractor:auto:num-499
    // whose catalog `parallel` is the bare word. Matching that string is what
    // GATE 2 needs in order to stop reading this as a different card.
    expect(norm(observed).parallel).toBe("Refractor");
  });

  it("is idempotent, like every other rule here", () => {
    const once = norm(observed);
    expect(norm(once as never)).toEqual(once);
  });
});

describe("the split fills a blank axis, and only a blank one", () => {
  it("fills a blank printRun from the parallel", () => {
    expect(norm({ parallel: "Refractor Auto / 499" }).printRun).toBe(499);
  });

  it("fills a blank isAuto from the parallel", () => {
    expect(norm({ parallel: "Refractor Auto / 499" }).isAuto).toBe(true);
  });

  it("NEVER flips a stated isAuto:false", () => {
    // The asymmetry the rule is named for. A seller typing "Auto" into the
    // variety box does not outrank a holding that says this copy is unsigned
    // — the auto flag's boundary is the card number, not vendor text
    // (feedback_isauto_boundary_is_cardnumber_not_text).
    const f = norm({ parallel: "Refractor Auto / 499", isAuto: false });
    expect(f.isAuto).toBe(false);
    expect(f.parallel).toBe("Refractor");   // still cleaned
  });

  it("leaves a stated printRun alone even when the parallel disagrees", () => {
    const f = norm({ parallel: "Refractor Auto / 499", printRun: 150 });
    expect(f.printRun).toBe(150);
    expect(f.parallel).toBe("Refractor");
  });

  it("leaves a stated grade alone", () => {
    const f = norm({ parallel: "Refractor PSA 10", grade: 9, gradeCompany: "BGS" });
    expect(f.grade).toBe(9);
    expect(f.gradeCompany).toBe("BGS");
  });
});

describe("print-run spellings the eBay variety box produces", () => {
  const cases: Array<[string, string | null, number | null]> = [
    ["Refractor Auto / 499",      "Refractor",      499],
    ["Gold Refractor #/50",       "Gold Refractor",  50],
    ["Blue Refractor 180/499",    "Blue Refractor", 499],   // serial: only the denominator is the run
    ["Gold Refractor 1 of 1",     "Gold Refractor",   1],
    ["Refractor numbered to 25",  "Refractor",       25],
    ["Auto / 499",                null,             499],   // nothing named a finish
  ];
  for (const [input, parallel, printRun] of cases) {
    it(`${JSON.stringify(input)} -> parallel ${JSON.stringify(parallel)}, printRun ${printRun}`, () => {
      const f = norm({ parallel: input });
      expect(f.parallel).toBe(parallel);
      expect(f.printRun).toBe(printRun);
    });
  }
});

describe("a grade comes from a GRADER TOKEN, never from an adjective", () => {
  // #1704: an adjective plus a card number minted PSA N onto 38k stored rows.
  // The token must be a grader AND carry its number.
  it("reads PSA 10 off the parallel when the grade axes are blank", () => {
    const f = norm({ parallel: "Orange Refractor PSA 10" });
    expect(f.parallel).toBe("Orange Refractor");
    expect(f.grade).toBe(10);
    expect(f.gradeCompany).toBe("PSA");
  });

  it("reads a half grade", () => {
    const f = norm({ parallel: "Refractor BGS 9.5" });
    expect(f.grade).toBe(9.5);
    expect(f.gradeCompany).toBe("BGS");
  });

  for (const adjective of ["Orange Refractor Gem Mint", "Refractor Black Label", "Refractor Pristine 10"]) {
    it(`mints NO grade from ${JSON.stringify(adjective)}`, () => {
      const f = norm({ parallel: adjective });
      expect(f.grade ?? null).toBeNull();
      expect(f.gradeCompany ?? null).toBeNull();
    });
  }
});

describe("a `#` is a HASH, not a card-number marker — nothing is stripped", () => {
  // The first cut of this rule removed any #-prefixed token as "noise". The
  // sold_comps census refuted it: of 16,748,738 rows carrying a parallel, 85
  // spell a real parallel with a `#`, and the strip mangled nine of the
  // thirteen sampled shapes. Collectors use `#` for prospect ranks, checklist
  // ranges and jersey numbers. These are the real values, read 2026-09-05.
  const realParallelsWithAHash = [
    "#1 Prospect",
    "#1 Prospect - Yellow Back",
    "#1 Prospect - White Back",
    "Checklist #106-211",
    "Checklist #1-56",
    "Copyright Almost At #264",
    "K. Mcreynolds #105",
    "Jersey #27 in Photo",
    "Set #4",
  ];
  for (const p of realParallelsWithAHash) {
    it(`${JSON.stringify(p)} survives whole`, () => {
      expect(norm({ parallel: p }).parallel).toBe(p);
    });
  }

  it("and a real card number in the field is left there rather than mangled", () => {
    // Absent beats wrong. A card number has no blank axis waiting for it —
    // `cardNumber` is always stated — so a strip would fill nothing and only
    // risk erasing a parallel like "#1 Prospect".
    expect(norm({ parallel: "Refractor #CPA-DT" }).parallel).toBe("Refractor #CPA-DT");
  });
});

describe("MUST NOT TOUCH — the blast radius stays at the shapes above", () => {
  // A rule that reaches past its shape fuses correctly-separated pools, which
  // is the harm the rederive gates exist to prevent. These are real parallels
  // from the catalog; every one must survive the new rule unchanged.
  const untouched = [
    "Gold Refractor", "Blue Refractor", "X-Fractor", "Superfractor",
    "Orange Wave Refractor", "Black & White Shimmer Refractor",
    "Mini-Diamond Refractor", "Sunflower Seed Refractor", "1st Edition",
    "Peanuts", "Sky Blue Refractor", "Green Geometric Refractor",
    // A SLASH IN A PARALLEL IS USUALLY A COLOUR SEPARATOR, NOT A PRINT RUN.
    // These are the most common slash-carrying parallels in sold_comps
    // (2026-09-05): Topps Chrome Platinum names two colours per parallel and
    // joins them with " / ". The print-run pattern requires DIGITS after the
    // slash, which is what keeps these whole — and they are pinned here
    // because they are the population a looser pattern would destroy.
    "Platinum Toile Cream / Gold Refractor",
    "Platinum Toile White / Green Refractor",
    "Platinum Toile Cream / Fuchsia Lava Refractor",
    "Platinum Toile Cream / Rose Gold Refractor",
    "Bush/Mantle",
  ];
  for (const p of untouched) {
    it(`${JSON.stringify(p)} is left exactly as it is`, () => {
      const f = norm({ parallel: p });
      expect(f.parallel).toBe(p);
      expect(f.printRun ?? null).toBeNull();
      expect(f.isAuto ?? null).toBeNull();
    });
  }

  it("does not disturb the rules that run after it", () => {
    // R3 (subset strip), R8 (Ref expansion) and R9 (variation vocabulary) all
    // match on the whole string — running R10 first must leave them the shape
    // they were written for, not a different one.
    expect(norm({ parallel: "Chrome Refractor" }).parallel).toBe("Refractor");
    expect(norm({ parallel: "Gold Ref" }).parallel).toBe("Gold Refractor");
    expect(norm({ parallel: "Photo Variations" }).parallel).toBe("Image Variation");
    expect(norm({ parallel: "Chrome" }).parallel).toBeNull();
  });

  it("lets the later rules reach a shape the print run had been hiding", () => {
    // This is the reason R10 runs FIRST rather than last: R8 anchors on
    // `Ref$`, and a trailing "/ 499" defeats the anchor.
    expect(norm({ parallel: "Gold Ref / 499" }).parallel).toBe("Gold Refractor");
    expect(norm({ parallel: "Gold Ref / 499" }).printRun).toBe(499);
  });
});

describe("MUTATION CHECK — dropping the split brings the defect back", () => {
  // The acceptance number for this fix is not "the tests pass": it is that
  // WITHOUT the rule, the cpa-dt shape is still refused. `skipRules` turns the
  // rule off, which is exactly the state main was in before this commit.
  const observed = {
    playerName: "Devin Taylor", cardYear: 2025, setName: "Bowman Chrome",
    cardNumber: "CPA-DT", parallel: "Refractor Auto / 499",
    printRun: 499, isAuto: true,
  };

  it("without the rule the parallel is still the title fragment", () => {
    const off = normalizeHoldingFields(observed as never, {
      skipRules: new Set(["parallel_split_off_foreign_axes"]),
    }).fields;
    expect(off.parallel).toBe("Refractor Auto / 499");
    expect(off.parallel).not.toBe("Refractor");
  });

  it("without the rule the slug's parallel segment matches no checklist row", () => {
    // slugify() of the un-split field is `refractor-auto-499`; of the split
    // field it is `refractor`. The catalog carries the second and not the
    // first, which is precisely why GATE 2 refused the move.
    const slugSeg = (p: string | null | undefined) =>
      String(p ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const off = normalizeHoldingFields(observed as never, {
      skipRules: new Set(["parallel_split_off_foreign_axes"]),
    }).fields;
    const on = normalizeHoldingFields(observed as never).fields;
    expect(slugSeg(off.parallel)).toBe("refractor-auto-499");
    expect(slugSeg(on.parallel)).toBe("refractor");
  });

  it("without the rule the print run is the only axis carrying 499", () => {
    // And with it, the parallel no longer double-states what printRun says —
    // which is what makes the split LOSSLESS rather than a deletion.
    const on = normalizeHoldingFields(observed as never).fields;
    expect(on.printRun).toBe(499);
    expect(String(on.parallel)).not.toMatch(/499/);
  });
});

describe("every rule still reports itself, and the new one is wired", () => {
  it("names the change it made so the audit trail survives", () => {
    const r = normalizeHoldingFields({ parallel: "Refractor Auto / 499" } as never);
    const mine = r.changes.filter((c) => c.rule === "parallel_split_off_foreign_axes");
    expect(mine.map((c) => c.field).sort()).toEqual(["isAuto", "parallel", "printRun"]);
  });
});
