// D20 — the rung -> human-words mapper, pinned.
//
// Two things are pinned here: (1) the mapping's doctrine — every
// exact-pool rung is OBSERVED, every other named rung is an ESTIMATE,
// `no-basis` is UNPRICED, and an unknown or missing label is never hidden;
// (2) the vocabulary itself — the web's closed list equals the backend's
// (fmvRung.ts + the two ladder unions it folds in), read from source so a
// rung added on one side without the other is a red test, not a silent
// "unknown rung" in production.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeRung,
  holdingProvenance,
  isExactPoolRung,
  isKnownRung,
  EXACT_POOL_RUNGS,
  FALLBACK_RUNGS,
  NO_BASIS_RUNG,
} from "./rung";

describe("describeRung", () => {
  it("every exact-pool rung is observed and says it read this card's sales", () => {
    for (const label of EXACT_POOL_RUNGS) {
      const d = describeRung(label, { compsUsed: 5 });
      expect(d.kind, label).toBe("observed");
      expect(d.label).toBe(label);
      expect(d.text, label).toMatch(/this card/);
      expect(isExactPoolRung(label)).toBe(true);
    }
  });

  it("every fallback rung is an estimate and its words begin with 'estimate'", () => {
    for (const label of FALLBACK_RUNGS) {
      const d = describeRung(label, { compsUsed: 5 });
      expect(d.kind, label).toBe("estimate");
      expect(d.text, label).toMatch(/^estimate /);
      expect(d.label).toBe(label);
      expect(isExactPoolRung(label)).toBe(false);
    }
  });

  it("names the specific fallbacks the audit called out", () => {
    expect(describeRung("sibling-parallel").text).toBe("estimate from sibling parallels");
    expect(describeRung("grade-curve-estimate").text).toBe("estimate from the grade curve");
    expect(describeRung("cross-grade-fallback").text).toBe("estimate from another grade of this card");
  });

  it("decorates the exact-pool phrases with the pool size, singular and plural", () => {
    expect(describeRung("exact-pool-projection", { compsUsed: 5 }).text).toBe("projected from 5 sales of this card");
    expect(describeRung("exact-pool-weighted-median", { compsUsed: 1 }).text).toBe("from 1 sale of this card (thin pool)");
    // no count -> no number invented
    expect(describeRung("exact-pool-projection").text).toBe("projected from sales of this card");
    expect(describeRung("exact-pool-projection", { compsUsed: 0 }).text).toBe("projected from sales of this card");
  });

  it("no-basis is unpriced", () => {
    const d = describeRung(NO_BASIS_RUNG);
    expect(d.kind).toBe("unpriced");
    expect(d.text).toBe("no price basis");
  });

  it("a missing label is 'rung not reported', never observed", () => {
    for (const missing of [null, undefined, ""]) {
      const d = describeRung(missing);
      expect(d.kind).toBe("unknown");
      expect(d.text).toBe("rung not reported");
      expect(d.label).toBeNull();
    }
    expect(isExactPoolRung(null)).toBe(false);
    expect(isExactPoolRung(undefined)).toBe(false);
  });

  it("an unknown label is shown verbatim as an unknown rung — never hidden, never observed", () => {
    const d = describeRung("direct-comp");
    expect(d.kind).toBe("unknown");
    expect(d.text).toBe('unknown rung "direct-comp"');
    expect(d.label).toBe("direct-comp");
    expect(isKnownRung("direct-comp")).toBe(false);
    // A label that merely LOOKS exact-pool is treated as one by prefix (the
    // backend's rule) but is still not in the closed vocabulary.
    expect(isExactPoolRung("exact-pool-something-new")).toBe(true);
    expect(isKnownRung("exact-pool-something-new")).toBe(false);
  });
});

describe("holdingProvenance", () => {
  it("reads the envelope's ladderRung first", () => {
    const p = holdingProvenance({
      fmvRung: "sibling-estimate",
      pricing: {
        method: { ladderRung: "exact-pool-projection", compsUsed: 7 },
        provenance: { pricingSource: "our-pool", pricingSourceMeta: { method: "cross-setkey", compsUsed: 2 } },
      },
    });
    expect(p.kind).toBe("observed");
    expect(p.label).toBe("exact-pool-projection");
    expect(p.compsUsed).toBe(7);
    expect(p.source).toBe("our-pool");
    expect(p.text).toBe("projected from 7 sales of this card");
  });

  it("falls to pricingSourceMeta.method — the unified writer's stamp the envelope builder does not lift", () => {
    const p = holdingProvenance({
      pricing: {
        method: { ladderRung: null, compsUsed: null, kind: "unknown" },
        provenance: { pricingSource: "unified-pricing", pricingSourceMeta: { method: "exact-pool-leading-edge", compsUsed: 4 } },
      },
    });
    expect(p.kind).toBe("observed");
    expect(p.label).toBe("exact-pool-leading-edge");
    expect(p.compsUsed).toBe(4);
    expect(p.source).toBe("unified-pricing");
  });

  it("falls to the flat fmvRung when the envelope carries no rung", () => {
    const p = holdingProvenance({ fmvRung: "grade-curve-estimate", pricing: null });
    expect(p.kind).toBe("estimate");
    expect(p.text).toBe("estimate from the grade curve");
  });

  it("a legacy-engine number with no rung says so — it is not dressed as observed", () => {
    const p = holdingProvenance({
      pricing: { headline: { valueSource: "observed" }, method: { ladderRung: null }, provenance: { pricingSource: "legacy-engine" } },
    });
    expect(p.kind).toBe("unknown");
    expect(p.text).toBe("legacy engine, rung not reported");
    expect(p.label).toBeNull();
  });

  it("a holding with nothing at all is 'rung not reported'", () => {
    const p = holdingProvenance({});
    expect(p.kind).toBe("unknown");
    expect(p.text).toBe("rung not reported");
    expect(p.source).toBeNull();
    expect(p.compsUsed).toBeNull();
  });
});

describe("the vocabulary equals the backend's closed list", () => {
  const backendSrc = path.resolve(__dirname, "../../../../backend/src/services");

  /** The string literals of `export type <Name> = | "a" | "b" ...;` */
  function unionLiterals(file: string, typeName: string): string[] {
    const text = readFileSync(path.join(backendSrc, file), "utf8");
    const start = text.indexOf(`export type ${typeName} =`);
    expect(start, `${typeName} in ${file}`).toBeGreaterThan(-1);
    // Strip comments FIRST (a doc comment may contain ";" or a quoted
    // example), then the union runs to its terminating ";".
    const code = text.slice(start).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const block = code.slice(0, code.indexOf(";"));
    return Array.from(block.matchAll(/"([a-z0-9-]+)"/g), (m) => m[1]);
  }

  it("every rung the backend can name is one the web can describe, and nothing more", () => {
    const exact = unionLiterals("compiq/fmvRung.ts", "ExactPoolRungLabel");
    const fmvRung = unionLiterals("compiq/fmvRung.ts", "FmvRungLabel");
    const canonical = unionLiterals("compiq/canonicalFmv.service.ts", "CanonicalFmvMethod");
    const hobbyIq = unionLiterals("portfolioiq/hobbyIqFmv.service.ts", "HobbyIqFmvMethod");
    // FmvRungLabel = ExactPoolRungLabel | the three named fallbacks |
    // Exclude<CanonicalFmvMethod, "direct-comp"> | Exclude<HobbyIqFmvMethod, "direct-slug">
    const backend = new Set<string>([
      ...exact,
      ...fmvRung.filter((l) => l !== "direct-comp" && l !== "direct-slug"),
      ...canonical.filter((l) => l !== "direct-comp"),
      ...hobbyIq.filter((l) => l !== "direct-slug"),
    ]);
    const web = new Set<string>([...EXACT_POOL_RUNGS, ...FALLBACK_RUNGS, NO_BASIS_RUNG]);
    expect(new Set(exact)).toEqual(new Set(EXACT_POOL_RUNGS));
    expect([...backend].filter((l) => !web.has(l)), "backend rungs the web cannot describe").toEqual([]);
    expect([...web].filter((l) => !backend.has(l)), "web rungs the backend never names").toEqual([]);
    for (const label of web) expect(isKnownRung(label), label).toBe(true);
  });
});
