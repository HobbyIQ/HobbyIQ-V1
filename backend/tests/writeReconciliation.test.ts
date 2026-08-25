import { describe, expect, it, afterEach } from "vitest";
import { reconcileWrites } from "../src/services/ops/writeReconciliation";

afterEach(() => { process.exitCode = 0; });

describe("a green run is not a data flow", () => {
  it("catches the exact normaliser run that went unnoticed for a day", () => {
    // Verbatim from the 2026-08-24 run: reported DONE on all 16 slots, exit 0.
    const r = reconcileWrites({
      job: "normalize-catalog-format",
      intended: 13012857,
      written: 3931610,
      failed: 0,          // it counted them "failed" internally but declared none
    });
    expect(r.ok).toBe(false);
    expect(r.unaccounted).toBe(9081247);
    expect(process.exitCode).toBe(4);
    expect(r.message).toContain("WORK VANISHED");
  });

  it("passes the same job once the throttles are retried", () => {
    // The 2026-08-25 re-run: 1,110,012 retried, 257 genuinely unwritten.
    const r = reconcileWrites({
      job: "normalize-catalog-format",
      intended: 3105202,
      written: 3104945,
      failed: 257,
    });
    expect(r.ok).toBe(true);
    expect(r.unaccounted).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  it("counts deliberately skipped rows as accounted for, not as loss", () => {
    // The repair holds rows on purpose (guard) and blocks others (no
    // destination). Declared work is not vanished work.
    const r = reconcileWrites({
      job: "repair-refractor-mislabel",
      intended: 632755,
      written: 155770,
      skipped: 401306 + 65531 + 10144,
      failed: 4,
    });
    expect(r.ok).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("does not fail a run for a handful of terminal errors", () => {
    const r = reconcileWrites({ job: "x", intended: 100000, written: 99700, failed: 0 });
    expect(r.ok).toBe(true);          // 0.3%, under the 0.5% default
    expect(r.unaccounted).toBe(300);
  });

  it("fails as soon as the shortfall is real", () => {
    const r = reconcileWrites({ job: "x", intended: 100000, written: 98000, failed: 0 });
    expect(r.ok).toBe(false);         // 2%
    expect(process.exitCode).toBe(4);
  });

  it("is safe on a job that intended nothing", () => {
    const r = reconcileWrites({ job: "x", intended: 0, written: 0 });
    expect(r.ok).toBe(true);
    expect(r.shortfallPct).toBe(0);
  });
});
