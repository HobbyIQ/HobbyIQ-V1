/**
 * CF-GRADED-IDENTITY-REQUIRES-VALUE (2026-08-22) — unit tests on the builder.
 *
 * What this file locks: a grading company with NO numeric grade value must not
 * reach the engine as a half-formed graded identity. Either both halves go, or
 * neither does.
 *
 * Why it matters — the engine wire trace, measured against prod Cosmos:
 *   Holding 92d07730 (Nick Kurtz, 2026 Topps Chrome #P-3) stored
 *   `gradingCompany: "PSA"` with `gradeValue` absent, and rendered $3,724.61
 *   against a $6.85 cost.
 *
 *   The two halves are read by DIFFERENT guards inside computeEstimate:
 *     - the comp-pool grade FILTER requires `gradeValue !== undefined`, so it
 *       did NOT fire — the anchor pool stayed raw and produced a correct $3.75.
 *     - `gradeCompany` alone still rode into the CF-CANONICAL-FMV-OVERRIDE
 *       block, where rungs 1-2 could not match a PSA grade and the ladder fell
 *       through to `neighbor-parallel` — a product-family projection that
 *       returned $3,724.31 at confidence 0.21 and overwrote the correct value.
 *
 *   Verified directly against prod Cosmos: with the orphan company dropped,
 *   computeCanonicalFmv moves from neighbor-parallel $3,724.31 @0.21 to
 *   direct-comp $3.0975 @0.90 for the same card.
 *
 *   Population at time of writing: 3 of 79 live holdings.
 */
import { describe, it, expect } from "vitest";
import { buildEstimateRequestFromHolding } from "../src/services/portfolioiq/portfolioStore.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

function holdingWith(fields: Partial<PortfolioHolding>): PortfolioHolding {
  return {
    id: "test-holding",
    playerName: "Nick Kurtz",
    cardYear: 2026,
    product: "2026 Topps Chrome",
    parallel: "Base",
    isAuto: false,
    ...fields,
  } as PortfolioHolding;
}

describe("CF-GRADED-IDENTITY-REQUIRES-VALUE: builder grade mapping", () => {
  it("drops the grading company when no grade value is stored (the Kurtz shape)", () => {
    const req = buildEstimateRequestFromHolding(
      holdingWith({ gradingCompany: "PSA" } as Partial<PortfolioHolding>),
    );
    expect(req.gradeCompany).toBeUndefined();
    expect(req.gradeValue).toBeUndefined();
  });

  it("drops the grading company when gradeValue is explicitly null", () => {
    const req = buildEstimateRequestFromHolding(
      holdingWith({ gradingCompany: "PSA", gradeValue: null } as unknown as Partial<PortfolioHolding>),
    );
    expect(req.gradeCompany).toBeUndefined();
    expect(req.gradeValue).toBeUndefined();
  });

  it("drops the grading company when gradeValue is a non-numeric string", () => {
    const req = buildEstimateRequestFromHolding(
      holdingWith({ gradingCompany: "PSA", gradeValue: "ungraded" } as unknown as Partial<PortfolioHolding>),
    );
    expect(req.gradeCompany).toBeUndefined();
    expect(req.gradeValue).toBeUndefined();
  });

  it("PRESERVES a well-formed graded identity", () => {
    const req = buildEstimateRequestFromHolding(
      holdingWith({ gradingCompany: "PSA", gradeValue: 10 } as unknown as Partial<PortfolioHolding>),
    );
    expect(req.gradeCompany).toBe("PSA");
    expect(req.gradeValue).toBe(10);
  });

  it("PRESERVES a well-formed identity supplied via the gradeCompany alias", () => {
    const req = buildEstimateRequestFromHolding(
      holdingWith({ gradeCompany: "BGS", gradeValue: 9.5 } as unknown as Partial<PortfolioHolding>),
    );
    expect(req.gradeCompany).toBe("BGS");
    expect(req.gradeValue).toBe(9.5);
  });

  it("leaves a genuinely raw holding untouched", () => {
    const req = buildEstimateRequestFromHolding(holdingWith({}));
    expect(req.gradeCompany).toBeUndefined();
    expect(req.gradeValue).toBeUndefined();
  });

  it("does not disturb the rest of the engine input", () => {
    const req = buildEstimateRequestFromHolding(
      holdingWith({
        cardId: "1784782359263x992151372775175800",
        gradingCompany: "PSA",
      } as unknown as Partial<PortfolioHolding>),
    );
    expect(req.playerName).toBe("Nick Kurtz");
    expect(req.cardYear).toBe(2026);
    expect(req.parallel).toBe("Base");
    expect(req.cardId).toBe("1784782359263x992151372775175800");
    expect(req.pinnedAuthoritative).toBe(true);
  });
});
