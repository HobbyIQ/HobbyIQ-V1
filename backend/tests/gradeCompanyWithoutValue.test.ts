/**
 * CF-GRADE-COMPANY-WITHOUT-VALUE (2026-08-22).
 *
 * A grading company with no grade value is not a graded card — it is a
 * half-filled form, and it priced like a slab while displaying like one.
 *
 * Measured: 3 of 79 holdings stored gradingCompany "PSA" with gradeValue
 * absent. Nick Kurtz #RA-KG carried fairMarketValue $239.64 against $6.85 paid
 * while his own predictedPrice sat at $3.75 — 64x, on a card the engine was
 * believed to price as raw. Confirmed with Drew: these are ungraded.
 *
 * The behaviour is a cascade CLEAR, not a rejection, and the carve-out is the
 * interesting half: a holding with a certNumber IS slabbed and its grade is
 * recoverable via resolveCert, so clearing it would destroy the only field
 * that can recover it.
 *
 * These call the real guard, not a copy of its logic.
 */
import { describe, it, expect } from "vitest";
import { clearGradeCompanyWithoutValue } from "../src/services/portfolioiq/portfolioStore.service.js";

const CTX = { userId: "user-test", holdingId: "h-test" };

/** Apply the real guard to a copy and hand back the result. */
function clear(h: Record<string, unknown>): Record<string, unknown> {
  const out = { ...h };
  clearGradeCompanyWithoutValue(out, CTX);
  return out;
}

describe("grade company without a grade value", () => {
  it("clears the Nick Kurtz shape: PSA with no grade and no cert", () => {
    const out = clear({ playerName: "Nick Kurtz", gradingCompany: "PSA", cardNumber: "RA-KG" });
    expect(out.gradingCompany).toBeUndefined();
    expect(out.gradeValue).toBeUndefined();
    // The rest of the holding must survive — this is a grade clear, not a purge.
    expect(out.playerName).toBe("Nick Kurtz");
    expect(out.cardNumber).toBe("RA-KG");
  });

  it("treats a whitespace-only grade as absent", () => {
    const out = clear({ gradingCompany: "PSA", gradeValue: "   " });
    expect(out.gradingCompany).toBeUndefined();
    expect(out.gradeValue).toBeUndefined();
  });

  it("accepts the legacy gradeCompany spelling too", () => {
    // Both names are live in stored data; guarding only one would leave a hole.
    const out = clear({ gradeCompany: "BGS" });
    expect(out.gradeCompany).toBeUndefined();
  });

  it("LEAVES a properly graded holding alone", () => {
    const graded = { gradingCompany: "PSA", gradeValue: 10 };
    expect(clear(graded)).toEqual(graded);
  });

  it("accepts a grade of 1 — a real low grade is not 'missing'", () => {
    // Guards against a truthiness bug: a low grade must not read as absent.
    expect(clear({ gradingCompany: "PSA", gradeValue: 1 })).toEqual({
      gradingCompany: "PSA",
      gradeValue: 1,
    });
    expect(clear({ gradingCompany: "PSA", gradeValue: "1" })).toEqual({
      gradingCompany: "PSA",
      gradeValue: "1",
    });
  });

  it("LEAVES a slabbed card whose grade is merely missing — cert recovers it", () => {
    // The carve-out. Clearing here would throw away the one field that can
    // recover the grade via resolveCert.
    const slabbed = { gradingCompany: "PSA", certNumber: "12345678" };
    expect(clear(slabbed)).toEqual(slabbed);
  });

  it("does nothing to a raw holding that never had a company", () => {
    const raw = { playerName: "someone", cardNumber: "1" };
    expect(clear(raw)).toEqual(raw);
  });

  it("ignores a blank company string rather than clearing on it", () => {
    const blank = { gradingCompany: "   ", playerName: "someone" };
    expect(clear(blank)).toEqual(blank);
  });
});
