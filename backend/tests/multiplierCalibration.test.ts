// CF-CAT-ENGINE (2026-06-21) — engine unit tests.
//
// Covers: saleClassifier title parsing, paired-ratio computation (strict
// + relaxed), n-gating provenance assignment, Ref-relative derivation,
// worksheet generation + TS rendering. Uses synthetic fixtures — no
// Cardsight HTTP, no live multiplier-table mutation.
//
// The engine's I/O surface (Cardsight fetcher) is covered by integration
// when the worksheet is generated; here we lock the pure computation.

import { describe, it, expect } from "vitest";
import {
  classifySale,
  isBaseAutoTitle,
} from "../src/curation/multiplierCalibration/saleClassifier.js";
import {
  bucketCardSales,
  pairedRatiosStrict,
  pairedRatiosRelaxed,
  median,
  percentile,
  type PerCardSales,
} from "../src/curation/multiplierCalibration/pairedRatio.js";
import {
  analyzeAllTiers,
  analyzeTier,
  computeTierPremium,
  assignProvenance,
  discoverTierKeys,
  deriveRefRelativeFromBase,
  MIN_EMPIRICAL_N,
} from "../src/curation/multiplierCalibration/densityAnalyzer.js";
import {
  buildWorksheet,
  renderWorksheetAsTs,
} from "../src/curation/multiplierCalibration/worksheetGenerator.js";

// ─── saleClassifier ─────────────────────────────────────────────────────

describe("CF-CAT-ENGINE — saleClassifier", () => {
  it("classifies Blue X-Fractor /150 auto (hyphen spelling)", () => {
    const c = classifySale("2026 Bowman Chrome Adrian Gil #CPA-AG Blue X-Fractor Auto /150 RC");
    expect(c.family).toBe("X-Fractor");
    expect(c.printRun).toBe(150);
    expect(c.parallelName).toBe("Blue X-Fractor");
    expect(c.tierKey).toBe("Blue X-Fractor /150");
    expect(c.isAutograph).toBe(true);
    expect(c.isBaseAuto).toBe(false);
  });

  it("classifies Blue Xfractor /150 (smoosh — CF-X3-clean regex catches it)", () => {
    const c = classifySale("2026 Bowman Andrew Tess 1st Bowman Blue Xfractor Auto /150 #CPA-AT");
    expect(c.family).toBe("X-Fractor");
    expect(c.printRun).toBe(150);
    expect(c.parallelName).toBe("Blue X-Fractor");
  });

  it("classifies Refractor /499", () => {
    const c = classifySale("2026 Bowman Chrome Charlie Condon #CPA-CC Refractor Auto /499");
    expect(c.family).toBe("Refractor");
    expect(c.printRun).toBe(499);
    expect(c.parallelName).toBe("Refractor");
  });

  it("classifies Blue Refractor /150 distinct from Blue X-Fractor /150", () => {
    const c = classifySale("2026 Bowman Billy Carlson #CPA-BC Blue Refractor Auto /150");
    expect(c.family).toBe("Refractor");
    expect(c.parallelName).toBe("Blue Refractor");
    expect(c.tierKey).toBe("Blue Refractor /150");
  });

  it("classifies HTA Choice Refractor /150 with finish detector", () => {
    const c = classifySale("Hector Ramos 2026 Bowman Chrome #CPA-HR HTA Choice Refractor 1st RC Auto /150");
    expect(c.tierKey).toBe("Hta Refractor /150");
    expect(c.family).toBe("Refractor");
  });

  it("classifies a base auto correctly (no color, no parallel, no print run)", () => {
    const c = classifySale("2026 Bowman Eric Hartman Chrome Auto 1st Prospect #CPA-EHA Braves");
    expect(c.isBaseAuto).toBe(true);
    expect(c.tierKey).toBe("base-auto");
    expect(c.printRun).toBeNull();
  });

  it("rejects non-autograph titles (no auto/autograph/CPA token anywhere)", () => {
    const c = classifySale("2026 Bowman Card No Tokens Mentioned");
    expect(c.isAutograph).toBe(false);
  });

  it("isBaseAutoTitle agrees with classifySale.isBaseAuto", () => {
    const cases = [
      { title: "2026 Bowman Eric Hartman Chrome Auto 1st Prospect #CPA-EHA", expected: true },
      { title: "2026 Bowman Chrome Blue X-Fractor Auto /150 #CPA-AG", expected: false },
      { title: "2026 Bowman Chrome Refractor Auto /499", expected: false },
      { title: "Card with nothing", expected: false },
    ];
    for (const { title, expected } of cases) {
      expect(isBaseAutoTitle(title)).toBe(expected);
      expect(classifySale(title).isBaseAuto).toBe(expected);
    }
  });

  it("1/1 print-run detection in a regular colored parallel", () => {
    const c = classifySale("2026 Bowman Chrome Player Red Refractor Auto 1/1 CPA-X");
    expect(c.printRun).toBe(1);
    expect(c.family).toBe("Refractor");
  });
});

// ─── pairedRatio helpers ────────────────────────────────────────────────

describe("CF-CAT-ENGINE — median + percentile + bucketCardSales", () => {
  it("median: odd and even-length arrays", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("percentile: interpolates at p25 / p75", () => {
    // For [1, 2, 3, 4, 5]: p25 = 2, p75 = 4.
    expect(percentile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5], 0.75)).toBe(4);
    expect(percentile([], 0.5)).toBeNull();
  });

  it("bucketCardSales buckets a synthetic card by tier", () => {
    const card: PerCardSales = {
      cardId: "card-test",
      playerName: "Test Player",
      sales: [
        // 2 base autos
        { price: 80, title: "2026 Bowman Test Player Auto Base CPA-TP" },
        { price: 90, title: "2026 Bowman Test Player Auto Base CPA-TP" },
        // 2 BXF /150
        { price: 60, title: "2026 Bowman Test Player Blue X-Fractor Auto /150 CPA-TP" },
        { price: 65, title: "2026 Bowman Test Player Blue X-Fractor Auto /150 CPA-TP" },
        // 1 Ref /499
        { price: 40, title: "2026 Bowman Test Player Refractor Auto /499 CPA-TP" },
        // Non-autograph noise (filtered out by classifier — no auto token at all)
        { price: 5, title: "2026 Bowman Test Player Nothing Here" },
      ],
    };
    const b = bucketCardSales(card);
    expect(b.baseAutos).toHaveLength(2);
    expect(b.ref499).toHaveLength(1);
    expect(b.tiers.get("Blue X-Fractor /150")).toHaveLength(2);
  });
});

// ─── paired-ratio computation ───────────────────────────────────────────

describe("CF-CAT-ENGINE — pairedRatiosStrict / pairedRatiosRelaxed", () => {
  function syntheticCard(opts: {
    cardId: string;
    player: string;
    baseAutos?: number[];
    bxf150?: number[];
    ref499?: number[];
  }): PerCardSales {
    const sales: Array<{ price: number; title: string }> = [];
    for (const p of opts.baseAutos ?? []) {
      sales.push({ price: p, title: `2026 Bowman ${opts.player} Auto Base CPA-X` });
    }
    for (const p of opts.bxf150 ?? []) {
      sales.push({ price: p, title: `2026 Bowman ${opts.player} Blue X-Fractor Auto /150 CPA-X` });
    }
    for (const p of opts.ref499 ?? []) {
      sales.push({ price: p, title: `2026 Bowman ${opts.player} Refractor Auto /499 CPA-X` });
    }
    return { cardId: opts.cardId, playerName: opts.player, sales };
  }

  it("strict requires ≥2 of BOTH numerator and denominator", () => {
    const a = syntheticCard({ cardId: "a", player: "Alpha", baseAutos: [80, 90], bxf150: [60, 65] });
    const b = syntheticCard({ cardId: "b", player: "Beta",  baseAutos: [50],     bxf150: [40, 45] });   // only 1 base
    const c = syntheticCard({ cardId: "c", player: "Gamma", baseAutos: [30, 35], bxf150: [25] });        // only 1 bxf
    const buckets = [a, b, c].map(bucketCardSales);
    const strict = pairedRatiosStrict(buckets, "Blue X-Fractor /150", "base-auto");
    expect(strict).toHaveLength(1);
    expect(strict[0]!.playerName).toBe("Alpha");
    expect(strict[0]!.ratio).toBeCloseTo(62.5 / 85, 3);
  });

  it("relaxed requires ≥1 of each — includes the strict cases plus singletons", () => {
    const a = syntheticCard({ cardId: "a", player: "Alpha", baseAutos: [80, 90], bxf150: [60, 65] });
    const b = syntheticCard({ cardId: "b", player: "Beta",  baseAutos: [50],     bxf150: [40] });
    const c = syntheticCard({ cardId: "c", player: "Gamma", baseAutos: [30],     bxf150: [] });  // 0 bxf
    const buckets = [a, b, c].map(bucketCardSales);
    const relaxed = pairedRatiosRelaxed(buckets, "Blue X-Fractor /150", "base-auto");
    expect(relaxed.map((r) => r.playerName).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("Ref/499 basis works alongside base-auto basis (independent computation)", () => {
    const a = syntheticCard({ cardId: "a", player: "Alpha", ref499: [80, 90], bxf150: [60, 65] });
    const buckets = [a].map(bucketCardSales);
    const baseStrict = pairedRatiosStrict(buckets, "Blue X-Fractor /150", "base-auto");
    const refStrict = pairedRatiosStrict(buckets, "Blue X-Fractor /150", "ref-499");
    expect(baseStrict).toHaveLength(0); // no base autos
    expect(refStrict).toHaveLength(1);
    expect(refStrict[0]!.ratio).toBeCloseTo(62.5 / 85, 3);
  });

  it("sorts results ascending by ratio (audit ergonomics)", () => {
    const cards = [
      syntheticCard({ cardId: "a", player: "Alpha", baseAutos: [100, 110], bxf150: [300, 320] }), // 3.0×
      syntheticCard({ cardId: "b", player: "Beta",  baseAutos: [80, 90],   bxf150: [120, 130] }), // 1.5×
      syntheticCard({ cardId: "c", player: "Gamma", baseAutos: [50, 60],   bxf150: [125, 135] }), // 2.4×
    ];
    const buckets = cards.map(bucketCardSales);
    const strict = pairedRatiosStrict(buckets, "Blue X-Fractor /150", "base-auto");
    const ratios = strict.map((r) => r.ratio);
    expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
  });
});

// ─── n-gating + provenance ──────────────────────────────────────────────

describe("CF-CAT-ENGINE — assignProvenance (the n_strict ≥ 5 gate)", () => {
  it(`n_strict = ${MIN_EMPIRICAL_N - 1} → sibling_provisional`, () => {
    const v = assignProvenance(MIN_EMPIRICAL_N - 1);
    expect(v.provenance).toBe("sibling_provisional");
    expect(v.reason).toContain(`below ≥${MIN_EMPIRICAL_N}`);
  });

  it(`n_strict = ${MIN_EMPIRICAL_N} → empirical`, () => {
    const v = assignProvenance(MIN_EMPIRICAL_N);
    expect(v.provenance).toBe("empirical");
    expect(v.reason).toContain(`clears the ≥${MIN_EMPIRICAL_N}`);
  });

  it("n_strict = 0 → sibling_provisional (anti-regression for empty tiers)", () => {
    expect(assignProvenance(0).provenance).toBe("sibling_provisional");
  });

  it("n_strict = 100 → empirical (high-end check)", () => {
    expect(assignProvenance(100).provenance).toBe("empirical");
  });
});

// ─── Ref-relative derivation ────────────────────────────────────────────

describe("CF-CAT-ENGINE — deriveRefRelativeFromBase", () => {
  it("returns base / refOverBase when refOverBase is positive", () => {
    expect(deriveRefRelativeFromBase(3.06, 1.54)).toBeCloseTo(1.987, 3);
  });

  it("returns null when refOverBase is null", () => {
    expect(deriveRefRelativeFromBase(3.06, null)).toBeNull();
  });

  it("returns null when refOverBase is zero or negative (guard)", () => {
    expect(deriveRefRelativeFromBase(3.06, 0)).toBeNull();
    expect(deriveRefRelativeFromBase(3.06, -1)).toBeNull();
  });
});

// ─── density + analysis ─────────────────────────────────────────────────

describe("CF-CAT-ENGINE — analyzeTier + analyzeAllTiers + discoverTierKeys", () => {
  function makeCards(): PerCardSales[] {
    return [
      // 5 cards w/ both base autos AND bxf150 (≥2/≥2) → strict n=5 → empirical
      ...Array.from({ length: 5 }, (_, i) => ({
        cardId: `card-${i}`,
        playerName: `Player ${i}`,
        sales: [
          { price: 80 + i, title: `Auto Base CPA-${i}` },
          { price: 90 + i, title: `Auto Base CPA-${i}` },
          { price: 160 + i, title: `Blue X-Fractor Auto /150 CPA-${i}` },
          { price: 170 + i, title: `Blue X-Fractor Auto /150 CPA-${i}` },
        ],
      })),
    ];
  }

  it("analyzeTier counts total sales + distinct cards + paired n's correctly", () => {
    const buckets = makeCards().map(bucketCardSales);
    const d = analyzeTier(buckets, "Blue X-Fractor /150");
    expect(d.totalSales).toBe(10);
    expect(d.distinctCards).toBe(5);
    expect(d.baseAuto.strictN).toBe(5);
    expect(d.baseAuto.relaxedN).toBe(5);
  });

  it("analyzeAllTiers produces empirical provenance when n_strict ≥ 5", () => {
    const buckets = makeCards().map(bucketCardSales);
    const results = analyzeAllTiers(buckets, ["Blue X-Fractor /150"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.provenance.provenance).toBe("empirical");
    expect(results[0]!.firmNow).toBe(true);
    expect(results[0]!.baseRelative.nStrict).toBe(5);
    expect(results[0]!.baseRelative.centerpoint).not.toBeNull();
    expect(results[0]!.baseRelative.range).not.toBeNull();
  });

  it("analyzeAllTiers produces sibling_provisional when n_strict < 5", () => {
    // 2 cards strict only
    const cards = makeCards().slice(0, 2);
    const buckets = cards.map(bucketCardSales);
    const results = analyzeAllTiers(buckets, ["Blue X-Fractor /150"]);
    expect(results[0]!.provenance.provenance).toBe("sibling_provisional");
    expect(results[0]!.firmNow).toBe(false);
  });

  it("computeTierPremium centerpoint = strict-paired median when strict n ≥ 2", () => {
    const buckets = makeCards().map(bucketCardSales);
    const pc = computeTierPremium(buckets, "Blue X-Fractor /150", "base-auto");
    expect(pc.centerpoint).not.toBeNull();
    expect(pc.centerpoint!).toBeGreaterThan(1);
    expect(pc.range).not.toBeNull();
  });

  it("discoverTierKeys finds every tier with at least one sale", () => {
    const cards = makeCards();
    // Add a Refractor /99 to one card
    cards[0]!.sales.push({ price: 100, title: "Green Refractor Auto /99 CPA-0" });
    const buckets = cards.map(bucketCardSales);
    const keys = discoverTierKeys(buckets);
    expect(keys).toContain("Blue X-Fractor /150");
    expect(keys).toContain("Green Refractor /99");
  });
});

// ─── worksheet generator ────────────────────────────────────────────────

describe("CF-CAT-ENGINE — buildWorksheet + renderWorksheetAsTs", () => {
  function buildAnalyses() {
    const buckets = Array.from({ length: 5 }, (_, i) => ({
      cardId: `card-${i}`,
      playerName: `Player ${i}`,
      sales: [
        { price: 80 + i, title: `Auto Base CPA-${i}` },
        { price: 90 + i, title: `Auto Base CPA-${i}` },
        { price: 160 + i, title: `Blue X-Fractor Auto /150 CPA-${i}` },
        { price: 170 + i, title: `Blue X-Fractor Auto /150 CPA-${i}` },
      ],
    })).map(bucketCardSales);
    return analyzeAllTiers(buckets, ["Blue X-Fractor /150"]);
  }

  it("emits a worksheet with a firm-now proposal when n_strict ≥ 5", () => {
    const ws = buildWorksheet(
      { scopeLabel: "test", generatedAt: "2026-06-21T00:00:00Z", cardsProbed: 5, cardsErrored: 0 },
      buildAnalyses(),
    );
    expect(ws.meta.minEmpiricalN).toBe(MIN_EMPIRICAL_N);
    expect(ws.proposals).toHaveLength(1);
    const p = ws.proposals[0]!;
    expect(p.firmNow).toBe(true);
    expect(p.proposed).not.toBeNull();
    expect(p.proposed!.provenance).toBe("empirical");
    expect(p.proposed!.basis).toBe("base_auto_paired");
    expect(p.proposed!.calibratedAt).toBe("2026-06-21T00:00:00Z");
    expect(p.proposed!.n).toBeGreaterThanOrEqual(MIN_EMPIRICAL_N);
  });

  it("rendered TS includes the DO-NOT-IMPORT banner + per-proposal BaseRelativePremium literal", () => {
    const ws = buildWorksheet(
      { scopeLabel: "test", generatedAt: "2026-06-21T00:00:00Z", cardsProbed: 5, cardsErrored: 0 },
      buildAnalyses(),
    );
    const ts = renderWorksheetAsTs(ws);
    expect(ts).toContain("DO NOT IMPORT");
    expect(ts).toContain("DO NOT AUTO-APPLY");
    expect(ts).toContain("baseRelativePremium: {");
    expect(ts).toContain(`basis: "base_auto_paired"`);
    expect(ts).toContain(`provenance: "empirical"`);
    expect(ts).toContain("Blue X-Fractor /150");
  });

  it("sibling_provisional rows render in the PROVISIONAL section, not FIRM-NOW", () => {
    const buckets = [
      // n=2 only — below the gate
      {
        cardId: "a", playerName: "Alpha",
        sales: [
          { price: 80, title: "Auto Base CPA-A" },
          { price: 90, title: "Auto Base CPA-A" },
          { price: 160, title: "Blue X-Fractor Auto /150 CPA-A" },
          { price: 170, title: "Blue X-Fractor Auto /150 CPA-A" },
        ],
      },
      {
        cardId: "b", playerName: "Beta",
        sales: [
          { price: 50, title: "Auto Base CPA-B" },
          { price: 55, title: "Auto Base CPA-B" },
          { price: 100, title: "Blue X-Fractor Auto /150 CPA-B" },
          { price: 110, title: "Blue X-Fractor Auto /150 CPA-B" },
        ],
      },
    ].map(bucketCardSales);
    const analyses = analyzeAllTiers(buckets, ["Blue X-Fractor /150"]);
    const ws = buildWorksheet(
      { scopeLabel: "test", generatedAt: "2026-06-21T00:00:00Z", cardsProbed: 2, cardsErrored: 0 },
      analyses,
    );
    const ts = renderWorksheetAsTs(ws);
    expect(ts).toContain("PROVISIONAL");
    expect(ts).toContain(`provenance: "sibling_provisional"`);
    expect(ws.proposals[0]!.firmNow).toBe(false);
  });

  it("tiers with no paired data at all render in the NO PAIRED DATA section", () => {
    // A card whose only sale is the tier — no base autos to pair against
    const buckets = [{
      cardId: "a", playerName: "Alpha",
      sales: [{ price: 100, title: "Blue X-Fractor Auto /150 CPA-A" }],
    }].map(bucketCardSales);
    const analyses = analyzeAllTiers(buckets, ["Blue X-Fractor /150"]);
    const ws = buildWorksheet(
      { scopeLabel: "test", generatedAt: "2026-06-21T00:00:00Z", cardsProbed: 1, cardsErrored: 0 },
      analyses,
    );
    const ts = renderWorksheetAsTs(ws);
    expect(ts).toContain("NO PAIRED DATA");
  });
});

// ─── schema migration regression ────────────────────────────────────────

describe("CF-CAT-ENGINE — schema migration on BowmanFamilyEntry", () => {
  it("existing rows (no baseRelativePremium) load and behave unchanged", async () => {
    const mod = await import("../src/services/compiq/chromeDraftMultipliers.js");
    // Sample existing row: 2022 Bowman Chrome CPA Refractor /499 (the unit anchor).
    const hit = mod.lookupBowmanFamilyEntry({
      product: "Bowman Chrome",
      subset: "Chrome Prospect Autographs",
      parallelName: "Refractor",
      year: 2022,
    });
    expect(hit).not.toBeNull();
    expect(hit!.baselineMultiplier).toBe(1.55);
    // The new field is optional → undefined on rows that haven't been
    // calibrated yet. Build B treats undefined as "no calibration".
    expect(hit!.baseRelativePremium).toBeUndefined();
  });

  it("BaseRelativePremium type structure compiles correctly when populated", async () => {
    const mod = await import("../src/services/compiq/chromeDraftMultipliers.js");
    type Entry = ReturnType<typeof mod.lookupBowmanFamilyEntry>;
    // The shape should be assignable from a literal of the structure the
    // engine produces.
    const literal: NonNullable<NonNullable<Entry>["baseRelativePremium"]> = {
      value: 3.06,
      range: [1.08, 2.03],
      n: 9,
      basis: "base_auto_paired",
      provenance: "empirical",
      calibratedAt: "2026-06-21T00:00:00Z",
    };
    expect(literal.basis).toBe("base_auto_paired");
    expect(literal.range).toHaveLength(2);
  });
});
