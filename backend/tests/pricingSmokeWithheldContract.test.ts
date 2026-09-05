/**
 * CF-A-WITHHELD-PRICE-IS-NOT-A-MISSING-ONE (2026-09-05).
 *
 * THE DEFECT. Every run of "Daily 5AM ET Refresh & Deploy" on 2026-09-05
 * failed at "Smoke test pricing tiers", and because the reprice job hung off
 * that job via `needs:`, "Reprice All Holdings (post-refresh)" was SKIPPED on
 * all seven. The nightly all-users reprice did not run, and nothing said so —
 * a skipped job is quiet. The deploy itself landed cleanly every time.
 *
 * WHAT ACTUALLY BROKE, and it was not the engine. Smoke case #2 ("2026 Bowman
 * Chrome Owen Carey Black BCP-69") expected `parallel-floor-projection` or
 * `scarcity-prior-floor`. Both rungs exist ONLY in computeCanonicalFmv. PR
 * #1681 (2026-09-03 20:41Z — the first red run, 33803711695, against the last
 * green 33800603947 at 94aebe31) routed /price through
 * computeCanonicalValuation -> valueIdentity, a genuinely different engine
 * over a different reader whose ladder has no floor rung at all: it ends at
 * `no-exact-pool`.
 *
 * And the identity deserves that refusal. Verified read-only against prod
 * Cosmos: every 2026 BCP-69 "Black" catalog row is checklist-backed, minted
 * 2026-08-27..08-31 (days outside POOL_SETTLE_HOURS=6, so `pool-migrating`
 * cannot fire), and every one of those pools holds ZERO sold_comps rows. An
 * unopened 2026 parallel numbered /10 with no sales is exactly what Drew's
 * ruling withholds: null with a reason IS the product working.
 *
 * So the smoke was asking the wrong question. `mustNotNull` cannot tell a
 * withheld price from a missing one, and the difference is the whole point:
 *
 *   WITHHELD  null WITH a named reason — the engine ran and declined.
 *             A product decision. Must not stop the nightly reprice.
 *   MISSING   null with NO reason — the engine never answered.
 *             An outage. Must stop the nightly reprice.
 *
 * These pins hold that distinction, and each one is mutation-checked in the
 * PR body against the pre-fix behaviour.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const smoke = require_("../scripts/smoke-test-pricing-tiers.cjs") as {
  CASES: Array<{ tier: string; query: string; expect: string; accept?: string }>;
  judgeResults: (
    results: Array<{ case: { tier: string; expect: string; accept?: string }; result: unknown }>,
    cases: Array<{ accept?: string }>,
  ) => {
    violations: string[];
    unreasonedNulls: string[];
    engineOk: boolean;
    smokeOk: boolean;
    withheldCount: number;
    nullCount: number;
    pinnedWithheldCount: number;
  };
  withheldReasonOf: (price: unknown) => string | null;
};

const { CASES, judgeResults, withheldReasonOf } = smoke;

/** A priced result in the shape extractSummary produces. */
function priced(fmv: number, tier = "live") {
  return { pricingTier: tier, fairMarketValue: fmv, withheldReason: null };
}
/** A refusal: null FMV carrying a closed-vocabulary reason. */
function withheld(reason: string, tier = "no-basis") {
  return { pricingTier: tier, fairMarketValue: null, withheldReason: reason };
}
/** The outage shape: null FMV and nothing says why. */
function unreasoned(tier = "live") {
  return { pricingTier: tier, fairMarketValue: null, withheldReason: null };
}

const VALUE_CASE = { tier: "v", expect: "a number", accept: "value" };
const WITHHELD_CASE = { tier: "w", expect: "a refusal", accept: "withheld" };

describe("the smoke test knows a withheld price from a missing one", () => {
  it("a withheld price with a reason does NOT clear engine_ok — the reprice still runs", () => {
    const j = judgeResults(
      [
        { case: VALUE_CASE, result: priced(10) },
        { case: WITHHELD_CASE, result: withheld("no-exact-pool") },
      ],
      [VALUE_CASE, WITHHELD_CASE],
    );
    expect(j.smokeOk).toBe(true);
    expect(j.engineOk).toBe(true);
    expect(j.withheldCount).toBe(1);
    expect(j.unreasonedNulls).toEqual([]);
  });

  it("an UNREASONED null clears engine_ok — this is the shape that stops the reprice", () => {
    const j = judgeResults(
      [
        { case: VALUE_CASE, result: priced(10) },
        { case: WITHHELD_CASE, result: unreasoned() },
      ],
      [VALUE_CASE, WITHHELD_CASE],
    );
    expect(j.engineOk).toBe(false);
    expect(j.smokeOk).toBe(false);
    expect(j.unreasonedNulls).toHaveLength(1);
    expect(j.unreasonedNulls[0]).toContain("UNREASONED NULL");
  });

  it("an unreasoned null is an outage even on a case that ACCEPTS a withhold", () => {
    // The invariant is checked before the case's own expectation: "null with
    // no reason" is never acceptable, however permissive the fixture.
    const j = judgeResults(
      [{ case: WITHHELD_CASE, result: unreasoned() }],
      [WITHHELD_CASE],
    );
    expect(j.engineOk).toBe(false);
  });

  it("a stale expectation fails the smoke but leaves engine_ok TRUE — the 2026-09-05 case", () => {
    // Exactly what happened: a case demanding a value got a legitimate,
    // reasoned refusal. Red, so a human re-rules it — but the engine is
    // answering, so the nightly reprice must NOT be cancelled.
    const j = judgeResults(
      [
        { case: VALUE_CASE, result: withheld("no-exact-pool") },
        { case: WITHHELD_CASE, result: withheld("no-exact-pool") },
      ],
      [VALUE_CASE, WITHHELD_CASE],
    );
    expect(j.smokeOk).toBe(false);
    expect(j.engineOk).toBe(true);
    expect(j.violations[0]).toContain("WITHHELD where a value was required");
  });

  it("an HTTP failure clears engine_ok — a case that never answered is an outage", () => {
    const j = judgeResults(
      [{ case: VALUE_CASE, result: null }, { case: WITHHELD_CASE, result: withheld("no-exact-pool") }],
      [VALUE_CASE, WITHHELD_CASE],
    );
    expect(j.engineOk).toBe(false);
    expect(j.violations.some((v) => v.startsWith("HTTP fail"))).toBe(true);
  });

  it("a case pinned as withheld that suddenly PRICES is flagged for re-ruling", () => {
    // The fixture must not silently pass when the engine starts answering a
    // card it used to refuse — that is a real change and someone must rule it.
    const j = judgeResults(
      [{ case: WITHHELD_CASE, result: priced(42) }],
      [WITHHELD_CASE],
    );
    expect(j.smokeOk).toBe(false);
    expect(j.engineOk).toBe(true);
    expect(j.violations[0]).toContain("re-rule this case");
  });
});

describe("the withheld reason is read from the wire, not inferred from prose", () => {
  it("reads canonicalFmvWithheld.reason — the key /price now emits on a refusal", () => {
    expect(withheldReasonOf({ canonicalFmvWithheld: { reason: "no-exact-pool" } }))
      .toBe("no-exact-pool");
  });

  it("reads fmvReason on the canonical / hobbyiq-fmv wire shapes", () => {
    expect(withheldReasonOf({ fmvReason: "pool-migrating" })).toBe("pool-migrating");
  });

  it("treats the engine's own no-data states as stated reasons", () => {
    expect(withheldReasonOf({ source: "no-recent-comps" })).toBe("no-recent-comps");
    expect(withheldReasonOf({ source: "catalog-miss" })).toBe("catalog-miss");
  });

  it("a bare null wearing a tier and a mechanism is UNREASONED", () => {
    // This is precisely case #2's live response shape before the fix: tier
    // "live", mechanism "trend-adjusted-last-sale", FMV null, no reason.
    expect(
      withheldReasonOf({
        pricingTier: "live",
        predictedPriceAttribution: { mechanism: "trend-adjusted-last-sale" },
        marketValue: null,
      }),
    ).toBeNull();
  });
});

describe("the fixture set covers the withheld contract", () => {
  it("at least one case deliberately pins a withheld price", () => {
    // CF-WITHHELD-SHAPE-COVERAGE: without this, a regression that made every
    // refusal unreasoned would sail through green.
    const pinned = CASES.filter((c) => c.accept === "withheld");
    expect(pinned.length).toBeGreaterThanOrEqual(1);
  });

  it("a fixture set with NO withheld case is itself a violation", () => {
    const onlyValues = [VALUE_CASE];
    const j = judgeResults([{ case: VALUE_CASE, result: priced(10) }], onlyValues);
    expect(j.smokeOk).toBe(false);
    expect(j.violations.some((v) => v.startsWith("FIXTURE GAP"))).toBe(true);
  });

  it("every case declares what it accepts, from the closed vocabulary", () => {
    for (const c of CASES) {
      expect(["value", "withheld", "either"]).toContain(c.accept ?? "value");
    }
  });

  it("case #2 is the Owen Carey withhold, ruled by its zero-sale checklist pool", () => {
    const c = CASES[1];
    expect(c.query).toBe("2026 Bowman Chrome Owen Carey Black BCP-69");
    expect(c.accept).toBe("withheld");
  });
});
