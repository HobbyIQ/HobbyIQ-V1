/**
 * CF-THE-LEGACY-WIRE-HAS-A-VOCABULARY-TOO (2026-09-05).
 *
 * Two `source` vocabularies are live at once. D16 (#1483) moved
 * `/price-by-id` behind `computeCanonicalValuation`, so its `source` became a
 * RUNG (`fmvRung.ts`). The free-text wires -- `/api/compiq/search` and its
 * `/price` alias -- did not move: they still answer from the legacy CardHedge
 * estimate pipeline and the route reads
 *
 *     const source = (est.source as string | undefined) ?? "live";
 *
 * The Tier 1 harness asserted `source` against a hand-kept list. #1809 taught
 * it to ask `FMV_RUNG_LABELS`, which fixed the rung half -- and it STAYED RED,
 * because the legacy half answered `"projected"` and no list held it.
 *
 * This pins the vocabulary against the code that emits it, so the next value
 * added to the pipeline cannot silently fall out of the contract the way
 * `projected` did.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEGACY_ESTIMATE_SOURCES,
  isLegacyEstimateSource,
} from "../src/services/compiq/legacyEstimateSources";

const BACKEND = path.resolve(__dirname, "..");
const ROUTES = readFileSync(path.join(BACKEND, "src/routes/compiq.routes.ts"), "utf8");
const ESTIMATE = readFileSync(
  path.join(BACKEND, "src/services/compiq/compiqEstimate.service.ts"), "utf8",
);
const HELPERS = readFileSync(path.join(BACKEND, "harness/tier1/_helpers.ts"), "utf8");

describe("the legacy estimate vocabulary names what the pipeline emits", () => {
  it("`projected` is in it — the value that kept Tier 1 red after #1809", () => {
    expect(isLegacyEstimateSource("projected")).toBe(true);
    // and it is really what the route assigns, not a guess about it
    expect(ROUTES).toMatch(/est\.source = "projected"/);
  });

  it("`unresolved` is in it — the route-level poisoned-cache refusal", () => {
    // /price-by-id answers this shape when the cached payload carries a
    // DIFFERENT card_id than the one requested and a cache-bypassing recompute
    // is still mismatched. It is a refusal with no rungLabel / valueSource /
    // fmvReason at all, which is why it is a legacy source and not a rung.
    expect(isLegacyEstimateSource("unresolved")).toBe(true);
    expect(ROUTES).toMatch(/source: "unresolved"/);
    expect(ROUTES).toMatch(/buildUnresolvedRouteResponse/);
  });

  it("every `est.source = \"...\"` the route assigns is a declared source", () => {
    const assigned = [...ROUTES.matchAll(/est\.source\s*=\s*"([a-z0-9_-]+)"/g)].map((m) => m[1]);
    expect(assigned.length).toBeGreaterThan(0);
    for (const s of new Set(assigned)) {
      expect(isLegacyEstimateSource(s), `route assigns undeclared source: ${s}`).toBe(true);
    }
  });

  it("the refusal and fallback names the estimate service returns are declared", () => {
    // The response-level names this pipeline answers with. A per-sale
    // provenance value (`cardhedge`, `sold_comps`) is a DIFFERENT field on a
    // different object and is deliberately not part of this vocabulary.
    for (const s of [
      "no-recent-comps", "catalog-miss", "variant-mismatch", "unsupported_sport",
      "out-of-scope", "sibling-pool", "live",
      "product-family-projection", "parallel-floor-projection",
      "scarcity-prior-floor", "reference-catalog-baseline", "setdoc-baseline",
    ]) {
      expect(ESTIMATE.includes(`source: "${s}"`), `estimate service no longer emits ${s}`).toBe(true);
      expect(isLegacyEstimateSource(s), `${s} is emitted but not declared`).toBe(true);
    }
  });

  it("a per-sale provenance value is NOT a response source", () => {
    // Guards the scope boundary: `cardhedge` is a comp row's own field.
    expect(isLegacyEstimateSource("cardhedge")).toBe(false);
    expect(isLegacyEstimateSource("sold_comps")).toBe(false);
  });

  it("the vocabulary has no duplicates", () => {
    expect(new Set(LEGACY_ESTIMATE_SOURCES).size).toBe(LEGACY_ESTIMATE_SOURCES.length);
  });
});

/**
 * The mutation check. The harness must ASK this vocabulary rather than keep a
 * private copy — the failure mode `fmvRung.ts` already documents and that
 * this file exists because of.
 */
describe("Tier 1 asks the vocabulary rather than copying it", () => {
  it("_helpers.ts spreads LEGACY_ESTIMATE_SOURCES, not its literals", () => {
    expect(HELPERS).toMatch(/import \{ LEGACY_ESTIMATE_SOURCES \}/);
    expect(HELPERS).toMatch(/\.\.\.LEGACY_ESTIMATE_SOURCES,/);
  });

  it("and it still spreads the rung vocabulary — both wires, both lists", () => {
    expect(HELPERS).toMatch(/\.\.\.FMV_RUNG_LABELS,/);
  });
});
