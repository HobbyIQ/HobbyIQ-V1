// CF-ONE-VALUATION-PATH (D16, 2026-08-30) — source pins: no route consults a
// second engine for the headline.
//
// The contract test proves the four handlers agree on a fixture; this file
// makes the SHAPE that guarantees it fail loudly if it is undone — a route
// that calls canonical-fmv, the CH estimate, hobbyIqFmv or the legacy curve
// build BEFORE (or instead of) the one valuation path, an adapter that grows
// an engine call, or the entry growing a second engine of its own. Every
// defect D14 measured had that shape; a grep is the cheapest guard for it.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, "..", rel), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const ENGINE_CALLS = [
  "computeCanonicalFmv(",
  "computeEstimate(",
  "computeHobbyIqFmv(",
  "buildObservedGradeCurve(",
  "computeUnifiedPrice(",
  "priceHoldingFromOurPool(",
  "compileGradedEstimatesForCard(",
] as const;

/** The body of one Express handler: from its `router.<verb>("<path>"` to the
 *  next `router.` at column 0. */
function handlerBody(src: string, verb: string, routePath: string): string {
  const start = src.indexOf(`router.${verb}("${routePath}"`);
  expect(start, `handler ${verb} ${routePath} not found`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nrouter.", start + 1);
  return stripComments(src.slice(start, next > 0 ? next : undefined));
}

describe("D16 pins — the four routes price through the one valuation path only", () => {
  const compiq = read("src/routes/compiq.routes.ts");
  const canon = read("src/routes/canonicalFmv.routes.ts");

  it("/price-by-id: the slug branch calls valueIdentity and returns before the legacy pipeline; the CH/canonical calls exist only after the legacy cache key", () => {
    const body = handlerBody(compiq, "post", "/price-by-id");
    const entry = body.indexOf("valueIdentity(");
    expect(entry).toBeGreaterThanOrEqual(0);
    const legacyStart = body.indexOf("const cacheKey = normalizeCacheKey(");
    expect(legacyStart).toBeGreaterThan(entry);
    const slugBranch = body.slice(0, legacyStart);
    for (const call of ENGINE_CALLS) expect(slugBranch.includes(call), `${call} before the legacy pipeline`).toBe(false);
    expect(slugBranch).toMatch(/return res\.json\(toPriceByIdResponse\(v\)\)/);
    // The slug -> vendor-id GROUP BY resolver is gone from this handler.
    expect(body.includes('NOT STARTSWITH(c.cardId, "hiq:")')).toBe(false);
  });

  it("/observed-grade-curve/:cardId: valueIdentity answers the slug branch under the slug; the legacy build follows it, for vendor ids only", () => {
    const body = handlerBody(compiq, "get", "/observed-grade-curve/:cardId");
    const entry = body.indexOf("valueIdentity(");
    const legacy = body.indexOf("buildObservedGradeCurve(");
    expect(entry).toBeGreaterThanOrEqual(0);
    expect(legacy).toBeGreaterThan(entry);
    const slugBranch = body.slice(0, legacy);
    for (const call of ENGINE_CALLS) expect(slugBranch.includes(call), `${call} before the legacy build`).toBe(false);
    expect(slugBranch).toMatch(/return res\.json\(body\)/);
    expect(body.includes('NOT STARTSWITH(c.cardId, "hiq:")')).toBe(false);
  });

  it("/hobbyiq-fmv: valueIdentity only — no direct computeHobbyIqFmv", () => {
    const body = handlerBody(canon, "post", "/hobbyiq-fmv");
    expect(body.includes("valueIdentity(")).toBe(true);
    for (const call of ENGINE_CALLS) expect(body.includes(call), call).toBe(false);
  });

  it("/canonical-fmv: the one entry decides BOTH branches — the vendor-id tail is no longer a second engine", () => {
    const body = handlerBody(canon, "post", "/canonical-fmv");
    const entry = body.indexOf("valueIdentity(");
    expect(entry).toBeGreaterThanOrEqual(0);
    // The tail that used to call computeCanonicalFmv for ids the catalog
    // could not name now calls computeCanonicalValuation — the one path's
    // canonical-shaped door, which resolves a vendor id through
    // resolveValuationIdentity's own lookupHobbyIqCardIdForVendorCardId
    // mapping. Same wire shape, one engine.
    // MUTATION: restoring the computeCanonicalFmv tail makes this red.
    const door = body.indexOf("computeCanonicalValuation(");
    expect(door).toBeGreaterThan(entry);
    for (const call of ENGINE_CALLS) expect(body.includes(call), call).toBe(false);
  });

  it("the adapters are pure shapers: no engine is called in oneValuationPathAdapters.ts", () => {
    const src = stripComments(read("src/services/compiq/oneValuationPathAdapters.ts"));
    for (const call of ENGINE_CALLS) expect(src.includes(call), call).toBe(false);
    expect(src.includes("await ")).toBe(false);
  });

  it("the entry runs ONE engine (the exact pool through exactPoolSupremacy) and the gated ladder with the exact pool skipped — nothing else", () => {
    const src = stripComments(read("src/services/compiq/oneValuationPath.service.ts"));
    expect(src.includes("priceHoldingFromExactPool(")).toBe(true);
    expect(src.includes("perTierWindows: true")).toBe(true);
    const ladderAt = src.indexOf("computeHobbyIqFmv(");
    expect(ladderAt).toBeGreaterThanOrEqual(0);
    expect(src.slice(ladderAt, ladderAt + 400)).toContain("skipExactPool: true");
    for (const call of ["computeCanonicalFmv(", "computeEstimate(", "computeUnifiedPrice(", "buildObservedGradeCurve(", "priceHoldingFromOurPool(", "compileGradedEstimatesForCard("]) {
      expect(src.includes(call), call).toBe(false);
    }
  });

  it("the legacy curve's unified overlay prices every tier at its own window — the same policy as the headline", () => {
    const src = stripComments(read("src/services/compiq/observedGradeCurve.service.ts"));
    const overlay = src.indexOf("const hiqOpt: Parameters<typeof computeUnifiedPrice>[1] = {");
    expect(overlay).toBeGreaterThanOrEqual(0);
    expect(src.slice(overlay, overlay + 200)).toContain("perTierWindows: true");
    expect(src.slice(overlay, overlay + 200)).not.toContain("fixedWindowDays");
  });

  it("hobbyIqFmv's exact-pool branch names a method inside its own union", () => {
    const src = stripComments(read("src/services/portfolioiq/hobbyIqFmv.service.ts"));
    expect(src.includes('"unified-market-value" as any')).toBe(false);
    expect(src).toMatch(/method: isExactPoolRung\(u\.rungLabel\) \? "direct-slug" : "grade-cross-raw"/);
  });
});

// ─── D17: every price surface through the one entry ─────────────────────────
//
// The surfaces D16 left on their own calls. Each pin has the same shape as
// the D16 ones: the entry answers first, and no second engine is consulted
// for the headline (or for a tier) on the way.
const D17_ENGINE_CALLS = [
  ...ENGINE_CALLS,
  "computeGradeBreakdownSingleScan(",   // the card-detail ladder's second engine (pre-D17)
] as const;

describe("D17 pins — card-detail, card-panel, the bulk curves and the persist site price through the one valuation path only", () => {
  it("/card-detail: cardDetail.service calls valueIdentity and no engine — the header is the adapter over the valuation, the ladder is its curve", () => {
    const src = stripComments(read("src/services/portfolioiq/cardDetail.service.ts"));
    expect(src.includes("valueIdentity(")).toBe(true);
    expect(src.includes("toHobbyIqFmvResponse(")).toBe(true);
    expect(src.includes("ladderFromValuation(v)")).toBe(true);
    for (const call of D17_ENGINE_CALLS) expect(src.includes(call), call).toBe(false);
    expect(src.includes("getGraderPremium(")).toBe(false);
    // The route hands the body to the service and nothing else prices there.
    const canon = read("src/routes/canonicalFmv.routes.ts");
    const body = handlerBody(canon, "post", "/card-detail");
    expect(body.includes("computeCardDetail(")).toBe(true);
    for (const call of D17_ENGINE_CALLS) expect(body.includes(call), call).toBe(false);
  });

  it("/card-panel/:cardId: valueIdentity answers the slug branch under the slug; the legacy build and the grade-rescue overlay follow it, for vendor ids only", () => {
    const compiq = read("src/routes/compiq.routes.ts");
    const body = handlerBody(compiq, "get", "/card-panel/:cardId");
    const entry = body.indexOf("valueIdentity(");
    const legacy = body.indexOf("buildObservedGradeCurve(");
    const rescue = body.indexOf("overlayGradeRescue(");
    expect(entry).toBeGreaterThanOrEqual(0);
    expect(legacy).toBeGreaterThan(entry);
    expect(rescue).toBeGreaterThan(legacy);
    const slugBranch = body.slice(0, legacy);
    for (const call of D17_ENGINE_CALLS) expect(slugBranch.includes(call), `${call} before the legacy build`).toBe(false);
    expect(slugBranch.includes("overlayGradeRescue(")).toBe(false);
    expect(slugBranch).toMatch(/return res\.json\(body\)/);
    // The slug -> majority vendor-id resolver is gone from this handler.
    expect(body.includes('NOT STARTSWITH(c.cardId, "hiq:")')).toBe(false);
  });

  it("/observed-grade-curves-bulk: valueIdentitiesBulk first (BULK_CONCURRENCY), the legacy batch build after, for ids the catalog cannot name", () => {
    const compiq = read("src/routes/compiq.routes.ts");
    const body = handlerBody(compiq, "post", "/observed-grade-curves-bulk");
    const entry = body.indexOf("valueIdentitiesBulk(");
    const legacy = body.indexOf("buildObservedGradeCurvesBulk(");
    expect(entry).toBeGreaterThanOrEqual(0);
    expect(legacy).toBeGreaterThan(entry);
    expect(body.slice(entry, entry + 120)).toContain("concurrency: BULK_CONCURRENCY");
    for (const call of D17_ENGINE_CALLS) expect(body.includes(call), call).toBe(false);
    // The bulk helper is the entry, many times — not a second engine.
    const svc = stripComments(read("src/services/compiq/oneValuationPath.service.ts"));
    const bulkAt = svc.indexOf("export async function valueIdentitiesBulk(");
    expect(bulkAt).toBeGreaterThanOrEqual(0);
    const bulkBody = svc.slice(bulkAt);
    expect(bulkBody.includes("await valueIdentity(")).toBe(true);
    for (const call of D17_ENGINE_CALLS) expect(bulkBody.includes(call), call).toBe(false);
  });

  it("the persist site: autoPriceHolding, repriceHoldingsForUser and the supremacy gate ask the one entry FIRST; the legacy exact-pool reads follow, gated to identities the catalog cannot name; the tile rung and the majority resolver are gone", () => {
    const src = stripComments(read("src/services/portfolioiq/portfolioStore.service.ts"));
    // The grade-curve tile rung (a legacy curve build per holding) is gone,
    // and so is the slug -> majority vendor-id resolver it used.
    expect(src.includes("buildObservedGradeCurve(")).toBe(false);
    expect(src.includes('NOT STARTSWITH(c.cardId, "hiq:")')).toBe(false);
    expect(src.includes("await computeUnifiedPrice(")).toBe(false);

    const between = (from: string, to: string): string => {
      const a = src.indexOf(from);
      expect(a, from).toBeGreaterThanOrEqual(0);
      const b = src.indexOf(to, a + from.length);
      expect(b, to).toBeGreaterThan(a);
      return src.slice(a, b);
    };
    // autoPriceHolding: from its signature to its legacy computeEstimate call.
    const auto = between("async function autoPriceHolding(", "const estimate = await computeEstimate(");
    const autoEntry = auto.indexOf("valueHoldingThroughOneEntry(");
    const autoLegacy = auto.indexOf("priceHoldingFromExactPool(");
    expect(autoEntry).toBeGreaterThanOrEqual(0);
    expect(autoLegacy).toBeGreaterThan(autoEntry);
    expect(auto.slice(0, autoEntry).includes("priceHoldingFromExactPool(")).toBe(false);
    expect(auto).toMatch(/if \(!entryDecidedExactPool && process\.env\.PORTFOLIO_OBSERVED_GRADE_OVERRIDE_ENABLED === "true" && earlyResolvedId\)/);
    expect(src).toMatch(/if \(!entryDecidedExactPool\s*&& process\.env\.PORTFOLIO_OBSERVED_GRADE_OVERRIDE_ENABLED === "true"\s*&& resolvedIdForPricing\)/);
    // repriceHoldingsForUser: the same shape, both flagged reads gated.
    const reprice = between("export async function repriceHoldingsForUser(", "const estimate = await computeEstimate(");
    const rEntry = reprice.indexOf("valueHoldingThroughOneEntry(");
    const rLegacy = reprice.indexOf("priceHoldingFromExactPool(");
    expect(rEntry).toBeGreaterThanOrEqual(0);
    expect(rLegacy).toBeGreaterThan(rEntry);
    expect(reprice).toMatch(/if \(!bEntryDecided && process\.env\.PORTFOLIO_OBSERVED_GRADE_OVERRIDE_ENABLED === "true" && bEarlyId\)/);
    expect(src).toMatch(/if \(!bEntryDecided && process\.env\.PORTFOLIO_OBSERVED_GRADE_OVERRIDE_ENABLED === "true"\) \{/);
    // The supremacy gate: the entry replaces a blocked estimate; the legacy
    // re-price only when the entry could not resolve the identity.
    const gate = between("async function gateEstimateAgainstExactPool(", "async function autoPriceHolding(");
    const gEntry = gate.indexOf("valueHoldingThroughOneEntry(");
    const gLegacy = gate.indexOf("priceHoldingFromExactPool(");
    expect(gEntry).toBeGreaterThanOrEqual(0);
    expect(gLegacy).toBeGreaterThan(gEntry);
    expect(gate).toMatch(/const entryDecided = entry\.outcome !== "unresolved";\s*[\s\S]*?if \(!entryDecided\) \{/);
  });

  it("holdingValuation.ts is the adapter over the entry: valueIdentity only, no engine, no grader-premium table, and it never writes cross-grade-fallback", () => {
    const src = stripComments(read("src/services/portfolioiq/holdingValuation.ts"));
    expect(src.includes("await valueIdentity(")).toBe(true);
    for (const call of D17_ENGINE_CALLS) expect(src.includes(call), call).toBe(false);
    expect(src.includes("getGraderPremium(")).toBe(false);
    expect(src.includes('"cross-grade-fallback"')).toBe(false);
    // CF-THE-LADDER-IS-THE-VOCABULARY (2026-09-04): the estimate write no
    // longer hardcodes a rung — it persists WHATEVER the ladder returned, as
    // an estimate. The pin's subject is unchanged (an estimate is an
    // estimate, an observed write is an exact-pool rung); what changed is
    // that the rung is now `v.rungLabel` rather than one literal, which is
    // the whole point: a two-rung whitelist here left every other rung the
    // ladder can reach persisting NOTHING.
    expect(src).toMatch(/rung: \{ rung: v\.rungLabel \},[\s\S]*?valueSource: "estimated",[\s\S]*?isEstimate: true,[\s\S]*?valuationStatus: "estimated"/);
    // "Observed" keeps its exact meaning: this identity, this tier, real comps.
    expect(src).toMatch(/const observed = v\.valueSource === "observed" && isExactPoolRung\(v\.rungLabel\);/);
    // The acceptance test asks the VOCABULARY, never a list of rung names.
    expect(src).toMatch(/const pricingRung = isPricingRung\(v\.rungLabel\);/);
    // MUTATION GUARD: the old two-rung whitelist must not come back. Any
    // literal rung name in an acceptance comparison is the defect returning.
    expect(src).not.toMatch(/v\.rungLabel === "grade-curve-estimate"/);
    // Every write that sets fairMarketValue names a rung (the rung-writers
    // rule) — through the C-7 helper's required `rung:` argument.
    const literals = src.split("fairMarketValue: ").length - 1;
    const rungs = src.split("rung: { rung:").length - 1;
    expect(literals).toBe(2);
    expect(rungs).toBe(2);
    // The entry takes the holding's second identity and asks in #1462's order.
    const entry = stripComments(read("src/services/compiq/oneValuationPath.service.ts"));
    expect(entry).toMatch(/cardId: secondId && secondId !== slug \? secondId : null, printRun: identity\.printRun/);
  });

  it("the price-alert evaluator prices the alert's CARD through valueIdentity — a catalog identity (cardId, else the snapshot's slug the catalog holds in exactly one form) — never the text engine", () => {
    const src = stripComments(read("src/jobs/priceAlertEvaluator.job.ts"));
    expect(src.includes("await valueIdentity(")).toBe(true);
    for (const call of D17_ENGINE_CALLS) expect(src.includes(call), call).toBe(false);
    expect(src.includes("compiqEstimate.service")).toBe(false);
    expect(src.includes("CompIQEstimateRequest")).toBe(false);
    // Fill-only, catalog-backed: the derived slug is adopted through
    // catalogSlugIfExists, and only when exactly one form is held.
    expect(src.includes("await catalogSlugIfExists(candidate)")).toBe(true);
    expect(src).toMatch(/if \(held\.length === 1\) \{/);
    expect(src).toMatch(/if \(held\.length > 1\) return \{ kind: "ambiguous-identity"/);
    // The skip is counted, never priced.
    expect(src).toMatch(/skippedNoIdentity/);
    expect(src).toMatch(/skippedAmbiguousIdentity/);
  });
});
