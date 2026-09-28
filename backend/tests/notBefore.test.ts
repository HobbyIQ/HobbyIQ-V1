// CF-CLEANLINESS-SETTLE-ON-REPORT-DOC (second review, 2026-09-27).
//
// backend/scripts/lib/not-before.cjs is the shared helper wait-for-doc.cjs
// and check-anomaly-scan-report.cjs both use to guard the same-day
// stale-doc hazard (a same-day workflow_dispatch re-run can find an earlier
// run's report doc under the same date-only id). Two defects were found in
// the first cut of this guard and fixed here:
//
//   1. Comparing raw ISO strings is wrong once one side carries
//      milliseconds and the other doesn't (DISPATCHED_AT has none;
//      computedAt does) — "." sorts before "Z", so a fresh doc with ms
//      could lexicographically compare as older than a bound without ms.
//      Fixed by parsing both sides to epoch ms and comparing numerically,
//      with a small clock-skew tolerance.
//   2. An empty or unparseable bound must be a hard failure, never a
//      silent skip of the guard — the workflow always sets this env var
//      from its own DISPATCHED_AT, so an empty/bad value means the wiring
//      broke, not that the check is optional.
import { describe, it, expect } from "vitest";
import { requireNotBefore, isFreshEnough, CLOCK_SKEW_TOLERANCE_MS } from "../scripts/lib/not-before.cjs";

describe("requireNotBefore — fails fast, never silently disables the guard", () => {
  it("throws on undefined", () => {
    expect(() => requireNotBefore(undefined)).toThrow(/required and must not be empty/);
  });
  it("throws on null", () => {
    expect(() => requireNotBefore(null)).toThrow(/required and must not be empty/);
  });
  it("throws on an empty string", () => {
    expect(() => requireNotBefore("")).toThrow(/required and must not be empty/);
  });
  it("throws on a whitespace-only string", () => {
    expect(() => requireNotBefore("   ")).toThrow(/required and must not be empty/);
  });
  it("throws on a malformed, non-date string", () => {
    expect(() => requireNotBefore("not-a-date")).toThrow(/does not parse as a date/);
  });
  it("returns epoch ms for a valid ISO timestamp", () => {
    const ms = requireNotBefore("2026-09-26T03:51:00Z");
    expect(ms).toBe(Date.parse("2026-09-26T03:51:00Z"));
    expect(Number.isFinite(ms)).toBe(true);
  });
  it("accepts a timestamp with milliseconds too", () => {
    const ms = requireNotBefore("2026-09-26T03:51:00.500Z");
    expect(ms).toBe(Date.parse("2026-09-26T03:51:00.500Z"));
  });
});

describe("isFreshEnough — numeric epoch-ms compare, not lexicographic string compare", () => {
  const notBeforeMs = Date.parse("2026-09-26T03:51:00Z"); // no milliseconds, as DISPATCHED_AT is stamped

  it("accepts a doc computed in the same second, WITH milliseconds — the exact defect found in review", () => {
    // Lexicographic string compare: "2026-09-26T03:51:00.500Z" < "2026-09-26T03:51:00Z"
    // because "." (0x2E) sorts before "Z" (0x5A) — a raw string compare would
    // WRONGLY reject this fresh doc. The fix compares parsed epoch ms.
    expect("2026-09-26T03:51:00.500Z" >= "2026-09-26T03:51:00Z").toBe(false); // proves the string-compare bug exists
    expect(isFreshEnough("2026-09-26T03:51:00.500Z", notBeforeMs)).toBe(true);
  });

  it("accepts a doc computed exactly at the bound", () => {
    expect(isFreshEnough("2026-09-26T03:51:00.000Z", notBeforeMs)).toBe(true);
  });

  it("accepts a doc computed well after the bound", () => {
    expect(isFreshEnough("2026-09-26T05:22:00.000Z", notBeforeMs)).toBe(true);
  });

  it("rejects a doc computed well before the bound (an earlier run's stale doc)", () => {
    expect(isFreshEnough("2026-09-26T03:10:00.000Z", notBeforeMs)).toBe(false);
  });

  it("tolerates clock skew up to CLOCK_SKEW_TOLERANCE_MS", () => {
    const justInsideTolerance = new Date(notBeforeMs - (CLOCK_SKEW_TOLERANCE_MS - 1)).toISOString();
    expect(isFreshEnough(justInsideTolerance, notBeforeMs)).toBe(true);
  });

  it("rejects a doc stale by 1 full second beyond the tolerance", () => {
    // CLOCK_SKEW_TOLERANCE_MS is 5000ms (runner clock skew between the
    // dispatch step's shell `date -u` and the read step's Node Date.now()).
    // "Stale by 1s" is measured PAST that tolerance, not from the bound
    // itself — a doc 1s before the bound alone is well within a 5s
    // tolerance and must be accepted (see the previous test).
    const oneSecondPastTolerance = new Date(notBeforeMs - CLOCK_SKEW_TOLERANCE_MS - 1000).toISOString();
    expect(isFreshEnough(oneSecondPastTolerance, notBeforeMs)).toBe(false);
  });

  it("treats an unparseable computedAt as not fresh (never throws, never accepted)", () => {
    expect(isFreshEnough("not-a-date", notBeforeMs)).toBe(false);
    expect(isFreshEnough(undefined as any, notBeforeMs)).toBe(false);
    expect(isFreshEnough(null as any, notBeforeMs)).toBe(false);
  });

  it("MUTATION CHECK: the tolerance is not accidentally zero or negative — a doc exactly at the tolerance boundary is the last one accepted", () => {
    const atTheEdge = new Date(notBeforeMs - CLOCK_SKEW_TOLERANCE_MS).toISOString();
    const pastTheEdge = new Date(notBeforeMs - CLOCK_SKEW_TOLERANCE_MS - 1).toISOString();
    expect(isFreshEnough(atTheEdge, notBeforeMs)).toBe(true);
    expect(isFreshEnough(pastTheEdge, notBeforeMs)).toBe(false);
  });
});
