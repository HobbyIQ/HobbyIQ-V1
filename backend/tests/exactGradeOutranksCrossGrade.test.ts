// CF-EXACT-GRADE-OUTRANKS-CROSS-GRADE (2026-09-02).
//
// Holding 6fc204f7 — Greg Maddux, 1987 Topps Traded Tiffany #70T, PSA 10 —
// priced at $361.49 via `cross-grade-fallback` while its own pool held two
// genuine PSA 10 sales ($1,900 and $1,850). A cross-grade number is ANOTHER
// grade's pool rescaled by a multiplier; the requested grade's own sale is
// strictly better evidence at any n >= 1 (last-sale doctrine). The fallback
// exists for a tier with NO pool, and must be confined to that case.
//
// These pin `computeUnifiedPrice` — the layer that OWNS the rung choice and
// the only place the string "cross-grade-fallback" is produced. Pinning
// through valueIdentity instead would be vacuous: it reads the tier straight
// off the curve and never enters the fallback block at all.
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

// The engine's own Cosmos seam — the real engine prices the fixture.
vi.mock("../src/services/compiq/exactPoolReader.js", () => ({
  readExactPoolRows: vi.fn(async (input: { windowDays: number; nowMs?: number }) => {
    const now = input.nowMs ?? Date.now();
    const cutoff = now - input.windowDays * 86_400_000;
    return h.rows.filter((r) => Date.parse(String(r.soldAt)) >= cutoff);
  }),
}));
delete process.env.COSMOS_CONNECTION_STRING;

import { computeUnifiedPrice } from "../src/services/compiq/unifiedPricing.service.js";

const MADDUX = "hiq:baseball:1987:topps-traded-tiffany:70t:base:no-auto";
const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const sale = (price: number, d: number, c: string | null, v: number | null) => ({
  cardId: MADDUX, hobbyiqCardId: MADDUX, price, soldAt: daysAgo(d),
  gradeCompany: c, gradeValue: v, source: "cardhedge",
});
// The real 14-row pool's shape: a thin PSA 10 tier beside fatter lower tiers.
const pool = (psa10: Array<{ p: number; d: number }>) => [
  ...psa10.map((s) => sale(s.p, s.d, "PSA", 10)),
  sale(150, 1, "PSA", 9), sale(159, 1, "PSA", 9), sale(160, 4, "PSA", 9),
  sale(63, 5, "PSA", 8), sale(114, 6, "PSA", 8),
  sale(59.77, 1, null, null), sale(40, 8, null, null),
];

beforeEach(() => { h.rows = []; });

describe("the requested grade's own pool outranks a cross-grade fallback", () => {
  it("MADDUX: 2 PSA 10 sales price the PSA 10 request — not the fatter PSA 9 tier", async () => {
    h.rows = pool([{ p: 1900, d: 7 }, { p: 1850, d: 2 }]);
    const u = await computeUnifiedPrice(MADDUX, { grade: { company: "PSA", value: 10 } });
    expect(u.rungLabel).not.toBe("cross-grade-fallback");
    expect(u.fmv).toBeGreaterThan(1500);
    expect(u.fmv).not.toBeCloseTo(361.49, 1);
  });

  it("n=1 is enough: one PSA 10 sale beats the fatter tiers", async () => {
    h.rows = pool([{ p: 1900, d: 7 }]);
    const u = await computeUnifiedPrice(MADDUX, { grade: { company: "PSA", value: 10 } });
    expect(u.rungLabel).not.toBe("cross-grade-fallback");
    expect(u.fmv).toBe(1900);
  });

  // THE MUTATION-SENSITIVE PINS. Each supplies a requested grade that is
  // numerically PSA 10 but whose naive label does not match the pool's
  // "PSA 10" — the exact shapes that demoted a real tier in production.
  // THE MADDUX DEFECT ITSELF. A graded request whose value did not survive
  // parsing rendered "PSA ?" / "PSA NaN", matched no tier, and was answered
  // off the largest OTHER tier — the PSA 9s at ~$136-$159. That is how a PSA
  // 10 holding with two $1,850+ PSA 10 sales came to read $361.49. A grade we
  // cannot read is a MISSING answer, never a different grade's answer.
  it("an unreadable gradeValue REFUSES — it never reprices as another grade", async () => {
    h.rows = pool([{ p: 1900, d: 7 }, { p: 1850, d: 2 }]);
    for (const bad of [Number("nope"), null, undefined]) {
      const u = await computeUnifiedPrice(MADDUX, { grade: { company: "PSA", value: bad as never } });
      expect(u.rungLabel).toBe("no-basis");
      expect(u.fmv).toBeNull();
      // Specifically: NOT the PSA 9 tier's number, under a PSA 10 identity.
      expect(u.fmv).not.toBeCloseTo(135.9, 1);
    }
  });

  it("the fallback STILL fires when the requested tier genuinely has no sale", async () => {
    h.rows = pool([]);   // no PSA 10 anywhere
    const u = await computeUnifiedPrice(MADDUX, { grade: { company: "PSA", value: 10 } });
    expect(u.rungLabel).toBe("cross-grade-fallback");
  });
});
