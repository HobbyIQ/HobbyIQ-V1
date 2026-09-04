/**
 * The three engine gaps found in the 2026-09-04 audit of Drew's holdings, each
 * pinned on the shape of the real holding that exposed it.
 *
 * All three are the SAME defect wearing three faces: the engine declined, or
 * should have declined, and the row was left carrying a number that reads as
 * current. #1754 / #1755 established the contract for the one case they
 * reached (`cost-basis-floor`): the prior number is kept, the meta names
 * `method: "withheld"` with a machine-readable reason, and the refused number
 * survives as evidence. These pins extend that contract to the two refusals it
 * did not reach, and remove the dollar gate that let the first one through.
 *
 * ── A. THE FLOOR IS A RATIO, NOT A DOLLAR AMOUNT ──────────────────────────
 *
 *   1997 Metal Universe Chipper Jones #31, RAW, cost basis $29.45.
 *   Published $2.00 — a 93% haircut — UNREFUSED, because the floor read
 *   `costBasis > 50 && ratio < 0.15` and $29.45 is not > $50. The number came
 *   from a weighted median on n=3 that mixed a PSA 9 at $40, the owner's own
 *   $20 raw sale, and three $2-$5 commons.
 *
 *   A 93% haircut is the same evidence failure at $29.45 as at $2,945. The
 *   dollar gate was never a statement about evidence — it was a guess that a
 *   small basis is not worth defending.
 *
 * ── A'. A GRADED SALE NEVER ENTERS THE RAW TIER ───────────────────────────
 *
 *   The $40 PSA 9 in that raw pool is a second, independent defect:
 *   `unifiedPricing.gradeLabel` read `if (!company) return "Raw"`, treating an
 *   ABSENT `gradeCompany` as a positive assertion of rawness. The repo already
 *   knows this population exists — `backfill-grade-from-title.cjs` targets
 *   exactly those three shapes (`NOT IS_DEFINED` / null / ""), and
 *   `gradeParser.ts` records ~7,900 AUTH slabs in the wrong bucket — and the
 *   engine cannot contradict it downstream, because `exactPoolReader` does not
 *   select `c.title`.
 *
 * ── B. A MIGRATING POOL IS NOT A THIN POOL ────────────────────────────────
 *
 *   1987 Topps Traded Tiffany Maddux. Catalog row minted 14:37Z; reprice at
 *   18:56Z with 17 of 350 sales migrated found the PSA 10 tier EMPTY and
 *   published a grade-curve estimate off the PSA 8/9 rows that had arrived:
 *   $240 for a ~$1,500 card. Every step was correct given what the engine
 *   could see, which is why the gate must sit above the branches.
 *
 * ── C. A STALE VALUE IS NOT A PRICE ───────────────────────────────────────
 *
 *   Bellingham Griffey shows $1,850 while the engine, asked for that identity,
 *   returns `identity-not-in-catalog`. The number is from an older pass and
 *   nothing on the row says so.
 *
 *   Note where this is fixed and where it is NOT. `identity-not-in-catalog`
 *   does not withhold at the ENTRY, because CF-LEGACY-SURVIVES-FOR-
 *   UNNAMEABLE-IDENTITIES (pinned in oneValuationPath.contract.test.ts) says a
 *   slug the catalog cannot name but which HAS sales under it is still
 *   legitimately priced by the legacy exact-pool read. Withholding there would
 *   blank real prices computed from real sales. So the withhold lands at the
 *   END of the chain — the confidence-gated retention branch — which is the
 *   first point at which "nothing could price this" is actually known.
 *
 * MUTATION CHECKS are stated per block. Each names the edit that turns the
 * test red, so a future refactor cannot quietly restore the defect.
 */
import { describe, expect, it } from "vitest";

import {
  costBasisFloor,
  noBasisRefusalWrite,
  COST_BASIS_FLOOR_RATIO,
} from "../src/services/portfolioiq/holdingValuation.js";
import {
  assessPoolMigration,
  identityMarkerId,
  scopeMarkerId,
  shouldGateRung,
  POOL_SETTLE_HOURS,
} from "../src/services/compiq/poolMigrationGate.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const NOW = "2026-09-04T18:00:00.000Z";

/** A. The real row: raw 1997 Metal Universe Chipper Jones #31, $29.45 basis. */
const CHIPPER = {
  id: "chipper-31-raw",
  playerName: "Chipper Jones",
  hobbyiqCardId: "hiq:baseball:1997:metal-universe:31:base:no-auto",
  fairMarketValue: 22,
  purchasePrice: 29.45,
  totalCostBasis: 29.45,
  quantity: 1,
  valueSource: "observed",
  fmvRung: "exact-pool-weighted-median",
  pricingSourceMeta: { slug: "hiq:baseball:1997:metal-universe:31:base:no-auto", compsUsed: 3, confidence: 0.21 },
} as unknown as PortfolioHolding;

/** C. The real row: Bellingham Griffey at $1,850 with no catalog identity. */
const GRIFFEY = {
  id: "griffey-bellingham",
  playerName: "Ken Griffey Jr.",
  hobbyiqCardId: "hiq:baseball:1989:bellingham-bells:1:base:no-auto",
  fairMarketValue: 1850,
  purchasePrice: 900,
  totalCostBasis: 900,
  quantity: 1,
  valueSource: "observed",
  fmvRung: "exact-pool-projection",
  pricingSourceMeta: { slug: "hiq:baseball:1989:bellingham-bells:1:base:no-auto", compsUsed: 4, confidence: 0.33 },
} as unknown as PortfolioHolding;

/** B. The real row: 1987 Topps Traded Tiffany Maddux, PSA 10, minted 14:37Z. */
const MADDUX_SLUG = "hiq:baseball:1987:topps-traded-tiffany:70t:base:no-auto";
const MADDUX_MINTED_AT = "2026-09-04T14:37:00.000Z";
/** The reprice that published $240: 18:56Z, 4h19m after the mint. */
const MADDUX_REPRICE_MS = Date.parse("2026-09-04T18:56:00.000Z");

describe("A. the cost-basis floor gates on the RATIO, at any basis", () => {
  it("the $29.45 Chipper Jones at $2.00 is REFUSED — the defect, in one assertion", () => {
    const floor = costBasisFloor(CHIPPER, 2);
    // MUTATION CHECK: restore `costBasis > 50 &&` to costBasisFloor and this
    // goes red — that predicate is exactly what let $2.00 publish.
    expect(floor.rejects).toBe(true);
    expect(floor.costBasis).toBeCloseTo(29.45, 2);
    expect(floor.proposedTotal).toBeCloseTo(2, 2);
    // 6.79% of basis — a 93% haircut.
    expect(floor.proposedTotal / floor.costBasis).toBeLessThan(COST_BASIS_FLOOR_RATIO);
  });

  it("the ratio is the ONLY gate: the same 6.79% refuses at every basis size", () => {
    for (const basis of [5, 29.45, 50, 51, 500, 5000]) {
      const holding = { ...CHIPPER, purchasePrice: basis, totalCostBasis: basis } as PortfolioHolding;
      expect(costBasisFloor(holding, basis * 0.0679).rejects).toBe(true);
    }
  });

  it("a price at or above 15% of basis still publishes — the floor did not become a haircut ban", () => {
    // 20% of a $29.45 basis: a real drop, not a slug mismatch. Must NOT refuse.
    expect(costBasisFloor(CHIPPER, 29.45 * 0.2).rejects).toBe(false);
    // Exactly at the line is not below it.
    expect(costBasisFloor(CHIPPER, 29.45 * COST_BASIS_FLOOR_RATIO).rejects).toBe(false);
  });

  it("no basis, or a zero proposal, is not a refusal — a ratio needs both terms", () => {
    const noBasis = { ...CHIPPER, purchasePrice: 0, totalCostBasis: 0 } as PortfolioHolding;
    expect(costBasisFloor(noBasis, 2).rejects).toBe(false);
    expect(costBasisFloor(CHIPPER, 0).rejects).toBe(false);
  });

  it("the dollar gate is gone from EVERY lane — five inline copies, one predicate", async () => {
    // The floor was implemented five times: the one-entry lane, the our-pool
    // reprice lane, the our-pool override, the catalog fallback, and the
    // helper itself. Each carried its own `costBasis > 50`, so fixing one
    // would have left the $29.45 Chipper Jones refused on one path and
    // published on another.
    // MUTATION CHECK: reintroduce the dollar gate anywhere and this goes red.
    const fs = await import("node:fs");
    // Comments are stripped first: the doctrine block in holdingValuation.ts
    // QUOTES the old predicate to record what was removed and why, and that
    // history is worth keeping. The pin is about live code.
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const f of [
      "../src/services/portfolioiq/portfolioStore.service.ts",
      "../src/services/portfolioiq/holdingValuation.ts",
    ]) {
      const src = stripComments(fs.readFileSync(new URL(f, import.meta.url), "utf8"));
      expect(src).not.toMatch(/costBasis > 50/);
      expect(src).not.toMatch(/costBasis>50/);
    }
  });

  it("quantity multiplies the proposal, not the basis — a 3-qty lot is judged as a lot", () => {
    const lot = { ...CHIPPER, quantity: 3, totalCostBasis: 88.35 } as PortfolioHolding;
    const floor = costBasisFloor(lot, 2);
    expect(floor.proposedTotal).toBeCloseTo(6, 2);
    expect(floor.rejects).toBe(true);
  });
});

describe("A'. a graded sale never enters the raw tier", () => {
  // The tier classifier is module-private, so the pin reads it through the
  // exported constant and the source itself — the predicate is one line and
  // its shape is the whole contract.
  it("the raw predicate requires BOTH fields absent, never company alone", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/services/compiq/unifiedPricing.service.ts", import.meta.url), "utf8"));
    // MUTATION CHECK: restore `if (!company) return "Raw";` as the whole
    // branch and this goes red.
    expect(src).not.toMatch(/if \(!company\) return "Raw";/);
    expect(src).toContain("UNKNOWN_GRADER_TIER");
  });

  it("a row carrying a grade VALUE with no company is not Raw", async () => {
    const { UNKNOWN_GRADER_TIER } = await import("../src/services/compiq/unifiedPricing.service.js");
    const { rowTierLabel } = await import("../src/services/compiq/playerIndex.service.js");
    // The $40 PSA 9 whose gradeCompany never populated at ingest.
    expect(rowTierLabel({ gradeCompany: null, gradeValue: 9 })).toBe(UNKNOWN_GRADER_TIER);
    expect(rowTierLabel({ gradeCompany: "", gradeValue: 9 })).toBe(UNKNOWN_GRADER_TIER);
    // It matches no requested tier, so it prices nothing.
    expect(rowTierLabel({ gradeCompany: null, gradeValue: 9 })).not.toBe("Raw");
    expect(rowTierLabel({ gradeCompany: null, gradeValue: 9 })).not.toBe("PSA 9");
  });

  it("a genuinely raw row — both fields absent — is still Raw", () => {
    // The regression this guard must not cause: the raw pool still exists.
    return import("../src/services/compiq/playerIndex.service.js").then(({ rowTierLabel }) => {
      expect(rowTierLabel({ gradeCompany: null, gradeValue: null })).toBe("Raw");
      expect(rowTierLabel({ gradeCompany: "", gradeValue: null })).toBe("Raw");
    });
  });

  it("an absent grade value is absence, not zero — the raw pool survives the guard", () => {
    // `Number(null)` and `Number("")` are both 0, which is FINITE. Parsing
    // before checking absence would render a raw row's null as the token "0",
    // classify it GRADED, and evict every genuinely raw sale from the raw
    // tier — a total pricing outage rather than a leak.
    // MUTATION CHECK: remove the absence check from gradeValueToken (or from
    // rowTierLabel) and the "still Raw" cases above go red.
    return import("../src/services/compiq/playerIndex.service.js").then(({ rowTierLabel }) => {
      expect(rowTierLabel({ gradeCompany: null, gradeValue: null })).toBe("Raw");
      expect(rowTierLabel({ gradeCompany: null, gradeValue: undefined as unknown as null })).toBe("Raw");
      expect(rowTierLabel({ gradeCompany: null, gradeValue: "" as unknown as null })).toBe("Raw");
    });
  });

  it("a fully graded row is unaffected", () => {
    return import("../src/services/compiq/playerIndex.service.js").then(({ rowTierLabel }) => {
      expect(rowTierLabel({ gradeCompany: "psa", gradeValue: 10 })).toBe("PSA 10");
      expect(rowTierLabel({ gradeCompany: "PSA", gradeValue: 9 })).toBe("PSA 9");
    });
  });
});

describe("B. a migrating pool is withheld, never priced off what arrived first", () => {
  it("the Maddux reprice at 18:56Z on a 14:37Z row is MIGRATING", () => {
    const v = assessPoolMigration({
      observedAt: MADDUX_MINTED_AT,
      marker: null,
      nowMs: MADDUX_REPRICE_MS,
    });
    // MUTATION CHECK: flip the in-window branch to `migrating: false` and this
    // goes red — that inference is exactly what published $240.
    expect(v.migrating).toBe(true);
    expect(v.because).toBe("within-settle-window");
    expect(v.ageHours).toBeCloseTo(4.317, 2);
  });

  it("a settle marker RELEASES the same row — the rematch's own signal wins", () => {
    const v = assessPoolMigration({
      observedAt: MADDUX_MINTED_AT,
      marker: { settledAt: "2026-09-04T18:00:00.000Z" },
      nowMs: MADDUX_REPRICE_MS,
    });
    expect(v.migrating).toBe(false);
    expect(v.because).toBe("settled-marker");
  });

  it("outside the settle window the row prices normally — the gate is bounded", () => {
    // Without this bound an absent marker would withhold every price on every
    // un-migrated identity forever, a worse outage than the one being fixed.
    const v = assessPoolMigration({
      observedAt: MADDUX_MINTED_AT,
      marker: null,
      nowMs: Date.parse(MADDUX_MINTED_AT) + (POOL_SETTLE_HOURS + 0.1) * 3_600_000,
    });
    expect(v.migrating).toBe(false);
    expect(v.because).toBe("outside-settle-window");
  });

  it("a row with no mint timestamp is presumed settled — the historical catalog is not gated", () => {
    const v = assessPoolMigration({ observedAt: null, marker: null, nowMs: MADDUX_REPRICE_MS });
    expect(v.migrating).toBe(false);
    expect(v.because).toBe("no-mint-timestamp");
  });

  it("absence of a marker inside the window is NOT settlement — the gate fails closed", () => {
    // The canary's precedent (rematch-canary-check.cjs:389): absent evidence
    // means assume touched. A marker can only ever release a price early.
    const v = assessPoolMigration({
      observedAt: MADDUX_MINTED_AT,
      marker: { settledAt: null },
      nowMs: MADDUX_REPRICE_MS,
    });
    expect(v.migrating).toBe(true);
  });

  it("clock skew is not a fresh mint: a future timestamp is age zero, still gated", () => {
    const v = assessPoolMigration({
      observedAt: "2026-09-04T19:00:00.000Z",
      marker: null,
      nowMs: MADDUX_REPRICE_MS,
    });
    expect(v.ageHours).toBe(0);
    expect(v.migrating).toBe(true);
  });

  it("the gated rungs are the ones that read the SHAPE of the pool", () => {
    // The exact rung and the graded-to-raw curve: the $240 came from the
    // latter reading an empty PSA 10 tier as evidence of absence.
    expect(shouldGateRung("exact-pool-projection")).toBe(true);
    expect(shouldGateRung("exact-pool-weighted-median")).toBe(true);
    expect(shouldGateRung("grade-curve-estimate")).toBe(true);
    expect(shouldGateRung("graded-pool-inverse")).toBe(true);
    expect(shouldGateRung("cross-grade-fallback")).toBe(true);
    // A rung that reads OTHER identities is not corrupted by this pool's
    // migration — though the doctrine still publishes no number for a
    // migrating identity.
    expect(shouldGateRung("player-index-projection")).toBe(false);
    expect(shouldGateRung("family-baseline")).toBe(false);
    expect(shouldGateRung(null)).toBe(false);
  });

  it("the settle signal is keyed both ways the rematch can report", () => {
    // Per-identity: what `ledgerNote` already accumulates per slug.
    expect(identityMarkerId(MADDUX_SLUG)).toBe(`identity::${MADDUX_SLUG}`);
    // Per-(year, setKey): the bulk case. setKey is NOT a shard axis, so this
    // marker is written only when every covering slice has completed.
    expect(scopeMarkerId(1987, "topps-traded-tiffany")).toBe("scope::1987::topps-traded-tiffany");
    expect(scopeMarkerId(null, null)).toBe("scope::?::?");
  });
});

describe("C. a withheld price keeps the prior value and LABELS it", () => {
  it("the $1,850 Griffey is kept, and the row says why it did not move", () => {
    const { holding, prose } = noBasisRefusalWrite(GRIFFEY, "identity-not-in-catalog", null, NOW);
    const meta = holding.pricingSourceMeta as Record<string, unknown>;
    // The number the refusal said nothing against is KEPT.
    expect(holding.fairMarketValue).toBe(1850);
    // THE defect: the row read as a current price with nothing marking it as
    // un-refreshed. `withheld` is the auditor's handle and it is present on
    // EVERY refusal, whether or not a prior rung is carried alongside it
    // (writeHoldingValuation keeps the kept number's own rung in `method` —
    // pinned by costBasisFloorRefusalNamesItself.test.ts — because that rung
    // still describes the number the row carries).
    // MUTATION CHECK: drop the `withheld` block and this goes red.
    expect(meta.withheld).toBeDefined();
    expect((meta.withheld as Record<string, unknown>).reason).toBe("identity-not-in-catalog");
    // Nothing was computed, so no number is borrowed as "proposed".
    expect((meta.withheld as Record<string, unknown>).proposed).toBeNull();
    // The kept value is LABELLED on the row, not only in a log that rolls.
    expect((holding as unknown as Record<string, unknown>).fmvRetainedReason).toBe(prose);
    expect((holding as unknown as Record<string, unknown>).fmvRetainedAt).toBe(NOW);
    expect(prose).toContain("no price was published");
  });

  it("a migrating identity withholds under its own reason, prior retained", () => {
    const migrating = { ...GRIFFEY, id: "maddux-psa10", fairMarketValue: 1500 } as PortfolioHolding;
    const { holding, prose } = noBasisRefusalWrite(migrating, "pool-migrating", null, NOW);
    const meta = holding.pricingSourceMeta as Record<string, unknown>;
    expect(holding.fairMarketValue).toBe(1500);
    expect(meta.withheld).toBeDefined();
    expect((meta.withheld as Record<string, unknown>).reason).toBe("pool-migrating");
    // NEVER a fallback number — a fallback is exactly what produced the $240.
    expect((meta.withheld as Record<string, unknown>).proposed).toBeNull();
    expect(prose).toContain("re-keyed");
  });

  it("a refusal never upgrades the claim, and never borrows a rung it did not price", () => {
    const { holding } = noBasisRefusalWrite(GRIFFEY, "identity-not-in-catalog", null, NOW);
    // The kept number's OWN rung still describes it.
    expect(holding.fmvRung).toBe("exact-pool-projection");
    // A refusal verifies nothing, so valueSource cannot become "observed"
    // from something weaker.
    const wasEstimated = { ...GRIFFEY, valueSource: "estimated" } as PortfolioHolding;
    expect(noBasisRefusalWrite(wasEstimated, "pool-migrating", null, NOW).holding.valueSource).toBe("estimated");
    const wasNeither = { ...GRIFFEY, valueSource: undefined } as unknown as PortfolioHolding;
    expect(noBasisRefusalWrite(wasNeither, "pool-migrating", null, NOW).holding.valueSource).toBe("estimated");
  });

  it("a row with no prior rung says so, rather than leaving a bare null", () => {
    const noRung = { ...GRIFFEY, fmvRung: null } as unknown as PortfolioHolding;
    const { holding, prose } = noBasisRefusalWrite(noRung, "identity-not-in-catalog", null, NOW);
    expect(holding.fmvRung).toBeNull();
    expect((holding as unknown as Record<string, unknown>).fmvRungAbsentReason).toBe(prose);
  });

  it("no confidence is invented: the prior pass's, or an explicit null", () => {
    const kept = noBasisRefusalWrite(GRIFFEY, "pool-migrating", null, NOW).holding
      .pricingSourceMeta as Record<string, unknown>;
    expect(kept.confidence).toBe(0.33);
    const noConf = { ...GRIFFEY, pricingSourceMeta: { slug: "x" } } as unknown as PortfolioHolding;
    const meta = noBasisRefusalWrite(noConf, "pool-migrating", null, NOW).holding
      .pricingSourceMeta as Record<string, unknown>;
    expect(meta.confidence).toBeUndefined();
    expect(meta.withheld).toBeDefined();
  });

  it("a row with NO prior rung names 'withheld' as its method — never `unlabelled-carry`", () => {
    // The one shape where `method` itself is the refusal: with no prior rung
    // to carry, a row that fell through this branch used to land on
    // `unlabelled-carry` — #1674's "invisible to the auditor" shape.
    const noRung = { ...GRIFFEY, fmvRung: null } as unknown as PortfolioHolding;
    const meta = noBasisRefusalWrite(noRung, "identity-not-in-catalog", null, NOW).holding
      .pricingSourceMeta as Record<string, unknown>;
    expect(meta.method).toBe("withheld");
    expect(meta.method).not.toBe("unlabelled-carry");
  });

  it("a holding with no prior value withholds without inventing one", () => {
    const never = { ...GRIFFEY, fairMarketValue: null, fmvRung: null } as unknown as PortfolioHolding;
    const { holding } = noBasisRefusalWrite(never, "identity-not-in-catalog", null, NOW);
    expect(holding.fairMarketValue).toBeNull();
    expect((holding.pricingSourceMeta as Record<string, unknown>).method).toBe("withheld");
  });
});
