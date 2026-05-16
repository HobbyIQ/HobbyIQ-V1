import { describe, it, expect } from "vitest";
import {
  classifyRegime,
  type RegimeResult,
} from "../src/services/compiq/regimeClassifier";
import { __testing__ } from "../src/routes/compiq.routes";

// Phase 1 deploy follow-up — verify the route helper forces
// regime=insufficient_data for non-live source paths (neighbor-synthesis,
// no-recent-comps, unsupported_sport, variant-mismatch), preserves diagnostics
// with a skipped_classification note, and passes through for source=live.

const { regimeFieldsFromEstimate } = __testing__;

const DAY = 86_400_000;
const NOW = Date.now();
function daysAgo(n: number): string {
  return new Date(NOW - n * DAY).toISOString();
}

// Build a 12-comp clearly-volatile pool (alternating $50 / $150) so the bare
// classifier would emit something OTHER than insufficient_data — gives us a
// real signal to confirm the override kicks in.
function volatilePool(): Array<{ price: number; date: string }> {
  return Array.from({ length: 12 }, (_, i) => ({
    price: i % 2 === 0 ? 50 : 150,
    date: daysAgo(i * 5 + 1),
  }));
}

function withEmbedded(source: string): Record<string, unknown> {
  const comps = volatilePool();
  const embedded: RegimeResult = classifyRegime(comps);
  // Sanity: confirm the pool we hand the helper would NOT classify as
  // insufficient_data on its own — otherwise the override test is vacuous.
  expect(embedded.regime).not.toBe("insufficient_data");
  return {
    source,
    regimeClassification: embedded,
    recentComps: comps,
  };
}

describe("regimeFieldsFromEstimate — non-live source override", () => {
  const nonLiveSources = [
    "neighbor-synthesis",
    "no-recent-comps",
    "unsupported_sport",
    "variant-mismatch",
  ];

  for (const source of nonLiveSources) {
    it(`forces insufficient_data + low when source=${source}`, () => {
      const est = withEmbedded(source);
      const out = regimeFieldsFromEstimate(est);
      expect(out.regime).toBe("insufficient_data");
      expect(out.regimeConfidence).toBe("low");
      expect(out.regimeDiagnostics.classificationReason).toContain(
        "skipped_classification",
      );
      expect(out.regimeDiagnostics.classificationReason).toContain(
        `source=${source}`,
      );
    });

    it(`preserves numeric diagnostics on source=${source}`, () => {
      const est = withEmbedded(source);
      const embedded = est.regimeClassification as RegimeResult;
      const out = regimeFieldsFromEstimate(est);
      expect(out.regimeDiagnostics.compsUsedForClassification).toBe(
        embedded.diagnostics.compsUsedForClassification,
      );
      expect(out.regimeDiagnostics.windowDays).toBe(
        embedded.diagnostics.windowDays,
      );
      // numeric fields preserved (slope/r2/cov from the underlying pool)
      expect(out.regimeDiagnostics.slopePctPerMonth).toBe(
        embedded.diagnostics.slopePctPerMonth,
      );
      expect(out.regimeDiagnostics.coefficientOfVariation).toBe(
        embedded.diagnostics.coefficientOfVariation,
      );
    });
  }
});

describe("regimeFieldsFromEstimate — source=live passthrough", () => {
  it("passes classifier result through unchanged when source=live with valid comps", () => {
    const est = withEmbedded("live");
    const embedded = est.regimeClassification as RegimeResult;
    const out = regimeFieldsFromEstimate(est);
    expect(out.regime).toBe(embedded.regime);
    expect(out.regimeConfidence).toBe(embedded.confidence);
    expect(out.regimeDiagnostics).toEqual(embedded.diagnostics);
    // explicitly: did NOT acquire the skipped_classification marker
    expect(out.regimeDiagnostics.classificationReason).not.toContain(
      "skipped_classification",
    );
  });

  it("passes classifier insufficient_data through when source=live but comp pool is thin", () => {
    const thinComps = [
      { price: 100, date: daysAgo(3) },
      { price: 101, date: daysAgo(10) },
      { price: 99, date: daysAgo(25) },
    ];
    const embedded = classifyRegime(thinComps);
    expect(embedded.regime).toBe("insufficient_data"); // sanity
    const est: Record<string, unknown> = {
      source: "live",
      regimeClassification: embedded,
      recentComps: thinComps,
    };
    const out = regimeFieldsFromEstimate(est);
    expect(out.regime).toBe("insufficient_data");
    expect(out.regimeConfidence).toBe("low");
    // came from the classifier itself, NOT the override
    expect(out.regimeDiagnostics.classificationReason).not.toContain(
      "skipped_classification",
    );
  });
});

describe("regimeFieldsFromEstimate — unknown / missing source", () => {
  it("treats missing source as passthrough (does not override)", () => {
    const est = withEmbedded("live");
    delete (est as { source?: unknown }).source;
    const embedded = est.regimeClassification as RegimeResult;
    const out = regimeFieldsFromEstimate(est);
    expect(out.regime).toBe(embedded.regime);
    expect(out.regimeConfidence).toBe(embedded.confidence);
  });

  it("treats an unrecognized source string as passthrough", () => {
    const est = withEmbedded("some-other-source");
    const embedded = est.regimeClassification as RegimeResult;
    const out = regimeFieldsFromEstimate(est);
    expect(out.regime).toBe(embedded.regime);
    expect(out.regimeConfidence).toBe(embedded.confidence);
  });
});
