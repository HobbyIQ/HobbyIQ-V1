// CF-DIGEST-IS-FOR-MARKET-MOVES (Drew, 2026-08-28). The divergence digest
// exists to surface MARKET moves. A divergence whose price came from a
// fallback rung is an engine bug report — telemetry, never an email. The
// Hartman case is the regression: engine $339 vs cost $2,325, priced by a
// dilutive sibling rung — that must be suppressed; the same divergence priced
// by the exact pool must still fire.
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordCostBasisDivergenceIfNoteworthy,
  drainDivergenceAlerts,
} from "../src/services/compiq/boundedProjectionAlerts.service.js";

const base = {
  userId: "user-test",
  holdingId: "h1",
  cardTitle: "Hartman Gold Refractor Auto PSA 9",
  slug: "hiq:baseball:2024:bowman-chrome:cpa-eha:gold-refractor:auto",
  costBasis: 2325,
  fmv: 339,
  fmvMethod: null as string | null,
  fmvBasisNote: null as string | null,
  fmvCompCount: null as number | null,
};

beforeEach(() => { drainDivergenceAlerts(); });

describe("CF-DIGEST-IS-FOR-MARKET-MOVES", () => {
  it("HARTMAN: a fallback-rung price never reaches the digest", () => {
    const fired = recordCostBasisDivergenceIfNoteworthy({
      ...base,
      fmvMethod: "sibling-parallel",
      fmvBasisNote: "composed anchor via brand-family proxy",
    });
    expect(fired).toBe(false);
    expect(drainDivergenceAlerts()).toHaveLength(0);
  });

  it("a unified exact-pool price DOES fire on a real market move", () => {
    const fired = recordCostBasisDivergenceIfNoteworthy({
      ...base,
      fmvMethod: "unified-market-value",
      fmvBasisNote: "unified: window=180d ...",
    });
    expect(fired).toBe(true);
    expect(drainDivergenceAlerts()).toHaveLength(1);
  });

  it("an exact-pool-supremacy tier price also fires", () => {
    const fired = recordCostBasisDivergenceIfNoteworthy({
      ...base,
      fmvMethod: "graded-projection",
      fmvBasisNote: "exact-pool supremacy: 130 comps on this exact card+grade; superseded [legacy]",
    });
    expect(fired).toBe(true);
    expect(drainDivergenceAlerts()).toHaveLength(1);
  });

  it("CF-THE-DIGEST-WAS-SILENT: the REAL holding shape — no method field, only the unified basis note — still fires", () => {
    // pricingMeta.method had no writer anywhere in src, so every production
    // holding arrived here with fmvMethod === null and the digest suppressed
    // everything for a day. The unified engine's basis note IS the exact pool.
    const fired = recordCostBasisDivergenceIfNoteworthy({
      ...base,
      fmvMethod: null,
      fmvBasisNote: "unified: window=180d median=$300 marketValue=$339 predicted=$330 trend=down -2.1%/wk conf=0.71",
    });
    expect(fired).toBe(true);
    expect(drainDivergenceAlerts()).toHaveLength(1);
  });
  // CF-RUNG-LABEL (D4 PR 1, 2026-08-29). The holding now carries the rung that
  // priced it, written by the engine. When the label is present it is the
  // whole gate: prose is not consulted.
  it("CF-RUNG-LABEL: an exact-pool label fires with no method and no basis note at all", () => {
    const fired = recordCostBasisDivergenceIfNoteworthy({
      ...base,
      fmvRung: "exact-pool-projection",
    });
    expect(fired).toBe(true);
    expect(drainDivergenceAlerts()[0]?.fmvRung).toBe("exact-pool-projection");
  });

  it("CF-RUNG-LABEL: a labelled fallback rung is suppressed even when the prose says 'unified:'", () => {
    // The requested grade had no pool entry; unified rescaled another grade's
    // pool (cross-grade-fallback). Its basis note still starts "unified:" and
    // its pricingSource is still "unified-pricing" — the #1400 gate admits it.
    // The label says it is not the exact pool, and the label wins.
    const fired = recordCostBasisDivergenceIfNoteworthy({
      ...base,
      fmvMethod: "unified-market-value",
      fmvBasisNote: "unified: window=180d median=$300 marketValue=$339 predicted=$330 trend=down -2.1%/wk conf=0.71",
      fmvRung: "cross-grade-fallback",
    });
    expect(fired).toBe(false);
    expect(drainDivergenceAlerts()).toHaveLength(0);
  });

  it("CF-RUNG-LABEL: every exact-pool aggregation fires; every named fallback rung does not", () => {
    for (const rung of ["exact-pool-leading-edge", "exact-pool-weighted-median", "exact-pool-last-sale", "exact-pool-trajectory"]) {
      drainDivergenceAlerts();
      expect(recordCostBasisDivergenceIfNoteworthy({ ...base, fmvRung: rung }), rung).toBe(true);
    }
    for (const rung of ["sibling-parallel", "grade-curve-estimate", "grade-cross-raw", "family-baseline", "no-basis"]) {
      drainDivergenceAlerts();
      expect(recordCostBasisDivergenceIfNoteworthy({ ...base, fmvRung: rung }), rung).toBe(false);
    }
  });

  it("CF-RUNG-LABEL: an empty label is no label — the pre-label evidence still decides", () => {
    const fired = recordCostBasisDivergenceIfNoteworthy({
      ...base,
      fmvRung: "",
      fmvBasisNote: "unified: window=180d ...",
    });
    expect(fired).toBe(true);
  });

  it("thresholds still gate first: small deltas never fire regardless of method", () => {
    const fired = recordCostBasisDivergenceIfNoteworthy({
      ...base,
      costBasis: 100, fmv: 90,   // -10%, $10 — under both thresholds
      fmvMethod: "unified-market-value",
    });
    expect(fired).toBe(false);
  });
});
